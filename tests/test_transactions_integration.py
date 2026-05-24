"""Tests de integracion de la transaccion ACID contra Atlas.

REQUIERE MONGO_URI seteado en env. Crea una DB temporal `truco_db_test`,
corre el test, y dropea la DB al final.

Skipea si MONGO_URI no esta presente — lo cual es lo que pasa en GitHub Actions
CI (no le damos credenciales). Para correrlo local:

    pytest tests/test_transactions_integration.py -v

Que prueba este archivo (la pieza mas critica del TP):

  Cuando una transaccion falla a la mitad, NADA queda persistido. Forzamos
  una excepcion artificialmente en `_actualizar_elos` (uno de los pasos
  finales) via monkeypatch, y verificamos que:

    - No se inserto ningun partido
    - No se inserto ningun elo_historial
    - El eloActual de los jugadores quedo intacto
    - El pendiente sigue en estado "pendiente" (no se marco aprobado)

Esto es la demostracion definitiva de que `session.with_transaction()` esta
haciendo rollback como debe.
"""
import os
from datetime import datetime, timezone

import pytest
from bson import ObjectId
from pymongo import MongoClient

MONGO_URI = os.environ.get("MONGO_URI")

pytestmark = pytest.mark.skipif(
    not MONGO_URI,
    reason="Integration tests requieren MONGO_URI seteado",
)

TEST_DB_NAME = "truco_db_test_rollback"
COLLECTIONS = ["jugadores", "partidos", "torneos", "elo_historial", "pendientes"]


@pytest.fixture
def test_db():
    """DB temporal en Atlas. Se borra al final del test."""
    client = MongoClient(MONGO_URI, tls=True, serverSelectionTimeoutMS=15000)
    db = client[TEST_DB_NAME]
    # Pre-crear colecciones (transacciones no permiten implicit create)
    existentes = set(db.list_collection_names())
    for c in COLLECTIONS:
        if c not in existentes:
            db.create_collection(c)
    # Limpiar
    for c in COLLECTIONS:
        db[c].delete_many({})
    yield db, client
    client.drop_database(TEST_DB_NAME)
    client.close()


def _seed_minimo(db):
    """Inserta 2 jugadores y devuelve sus _id."""
    ahora = datetime.now(timezone.utc)
    j1_id = ObjectId()
    j2_id = ObjectId()
    db.jugadores.insert_many([
        {
            "_id": j1_id, "username": "alpha", "usernameLower": "alpha",
            "nombreCompleto": "Alpha Test", "eloActual": 1200,
            "activo": True, "fechaRegistro": ahora,
        },
        {
            "_id": j2_id, "username": "beta", "usernameLower": "beta",
            "nombreCompleto": "Beta Test", "eloActual": 1200,
            "activo": True, "fechaRegistro": ahora,
        },
    ])
    return j1_id, j2_id


def _crear_pendiente(db, j1_id, j2_id):
    pendiente_id = ObjectId()
    db.pendientes.insert_one({
        "_id": pendiente_id,
        "tipo": "partido_suelto",
        "enviadoPor": "test",
        "fecha": datetime.now(timezone.utc).isoformat(),
        "modalidad": "individual",
        "equipoA": [str(j1_id)],
        "equipoB": [str(j2_id)],
        "equipoGanador": [str(j1_id)],
        "estado": "pendiente",
        "fechaEnvio": datetime.now(timezone.utc),
    })
    return pendiente_id


def test_aprobacion_exitosa_persiste_todo(test_db):
    """Smoke positivo: cuando la transaccion NO falla, todo queda OK."""
    db, client = test_db
    j1_id, j2_id = _seed_minimo(db)
    pendiente_id = _crear_pendiente(db, j1_id, j2_id)

    from services.transactions import aprobar_pendiente_atomico
    aprobar_pendiente_atomico(pendiente_id, client, db)

    # 1 partido insertado
    assert db.partidos.count_documents({}) == 1
    # 2 elo_historial (1 por jugador)
    assert db.elo_historial.count_documents({}) == 2
    # ELOs cambiaron: j1 gano, debe estar > 1200; j2 perdio, debe estar < 1200
    j1_despues = db.jugadores.find_one({"_id": j1_id})
    j2_despues = db.jugadores.find_one({"_id": j2_id})
    assert j1_despues["eloActual"] > 1200
    assert j2_despues["eloActual"] < 1200
    # El delta debe ser simetrico (zero-sum ELO)
    assert (j1_despues["eloActual"] - 1200) == (1200 - j2_despues["eloActual"])
    # Pendiente marcado como aprobado
    p = db.pendientes.find_one({"_id": pendiente_id})
    assert p["estado"] == "aprobado"
    assert "fechaResolucion" in p


def test_rollback_no_deja_data_parcial_cuando_falla_mitad_transaccion(test_db, monkeypatch):
    """LA prueba clave: forzamos excepcion despues del insert de partido.

    Verificamos que el `with_transaction` revierte TODOS los writes incluyendo
    los que ya habian completado dentro de la session.
    """
    db, client = test_db
    j1_id, j2_id = _seed_minimo(db)
    pendiente_id = _crear_pendiente(db, j1_id, j2_id)

    # Monkey-patch: hacer que _actualizar_elos (paso final) tire excepcion.
    # Para ese momento ya se insertaron el partido y los elo_historial dentro
    # de la transaccion. El rollback debe deshacerlos.
    from services import transactions

    def explota(*args, **kwargs):
        raise RuntimeError("Falla simulada para test de rollback")

    monkeypatch.setattr(transactions, "_actualizar_elos", explota)

    # Snapshot estado pre-transaccion
    partidos_antes = db.partidos.count_documents({})
    historial_antes = db.elo_historial.count_documents({})
    elos_antes = {
        str(j["_id"]): j["eloActual"]
        for j in db.jugadores.find({}, {"eloActual": 1})
    }

    # La excepcion debe propagar
    with pytest.raises(Exception, match="Falla simulada"):
        transactions.aprobar_pendiente_atomico(pendiente_id, client, db)

    # === VERIFICACIONES DE ROLLBACK ===
    # 1. No se inserto ningun partido nuevo
    assert db.partidos.count_documents({}) == partidos_antes, (
        "ROLLBACK FAIL: quedo un partido a pesar de la excepcion"
    )
    # 2. No se inserto ningun elo_historial
    assert db.elo_historial.count_documents({}) == historial_antes, (
        "ROLLBACK FAIL: quedaron entries de elo_historial"
    )
    # 3. Los ELOs de los jugadores siguen siendo los originales
    elos_despues = {
        str(j["_id"]): j["eloActual"]
        for j in db.jugadores.find({}, {"eloActual": 1})
    }
    assert elos_antes == elos_despues, (
        f"ROLLBACK FAIL: ELOs cambiaron. Antes: {elos_antes}, Despues: {elos_despues}"
    )
    # 4. El pendiente sigue en estado "pendiente" (no se marco aprobado)
    p = db.pendientes.find_one({"_id": pendiente_id})
    assert p["estado"] == "pendiente", (
        f"ROLLBACK FAIL: el pendiente quedo en estado {p['estado']}"
    )
    assert "fechaResolucion" not in p, (
        "ROLLBACK FAIL: se marco fechaResolucion sin haber commiteado"
    )


def test_pendiente_inexistente_da_lookuperror(test_db):
    db, client = test_db
    from services.transactions import aprobar_pendiente_atomico

    with pytest.raises(LookupError):
        aprobar_pendiente_atomico(ObjectId(), client, db)


def test_pendiente_ya_procesado_no_se_re_procesa(test_db):
    """Si alguien intenta aprobar un pendiente ya aprobado, falla con ValueError."""
    db, client = test_db
    j1_id, j2_id = _seed_minimo(db)
    pendiente_id = _crear_pendiente(db, j1_id, j2_id)

    # Marcamos como aprobado manualmente
    db.pendientes.update_one(
        {"_id": pendiente_id},
        {"$set": {"estado": "aprobado"}},
    )

    from services.transactions import aprobar_pendiente_atomico
    with pytest.raises(ValueError, match="ya fue procesado"):
        aprobar_pendiente_atomico(pendiente_id, client, db)
