"""Seed script: limpia y puebla la DB con data de prueba representativa.

Uso:
    python seed.py            # pide confirmacion antes de drop
    python seed.py --force    # drop sin preguntar (CI / evaluador)

Que crea:
    - 12 jugadores con sus nombres reales
    - 1 torneo "Liga Demo" con 4 equipos (modalidad 2v2, formato liga)
      jugando 6 partidos round-robin con elo_historial poblado
    - 4 partidos sueltos para diversificar la data
    - 1 pendiente sin aprobar (demuestra el flujo admin)

Despues de correr, /api/stats/* devuelve datos significativos para todas
las queries (ranking, winrate, parejas, peor enemigo, rachas, h2h).
"""
import sys
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from dotenv import load_dotenv

from db.client import close_all, connect_mongo
from db.indexes import ensure_indexes
from services.transactions import procesar_partido_suelto, procesar_torneo

load_dotenv()

COLLECTIONS = ["jugadores", "partidos", "torneos", "elo_historial", "pendientes"]

# Datos canonicos
JUGADORES = [
    ("marco",     "Marco Fernandez"),
    ("oruga",     "Joaquin Rasines Alcaraz"),
    ("guido",     "Guido Presta"),
    ("tobi",      "Tobias Vilapreno"),
    ("nano",      "Manuel Camblong"),
    ("manamaxul", "Manuel Medan"),
    ("tinchi",    "Martin Busch"),
    ("brinzo",    "Juani Brinzo"),
    ("beto",      "Beto"),
    ("marc",      "Marc Doman"),
    ("samuel",    "Mathias Samuel"),
    ("john",      "Juan Cocaña"),
]


def confirmar(force: bool) -> bool:
    if force:
        return True
    print("ATENCION: esto va a BORRAR todo el contenido de truco_db.")
    return input("Confirmar? (escribi 'si'): ").strip().lower() == "si"


def insertar_jugadores(db) -> dict[str, ObjectId]:
    ahora = datetime.now(timezone.utc)
    docs = []
    id_por_username: dict[str, ObjectId] = {}
    for username, nombre_completo in JUGADORES:
        _id = ObjectId()
        id_por_username[username] = _id
        docs.append({
            "_id": _id,
            "username": username,
            "usernameLower": username.lower(),
            "nombreCompleto": nombre_completo,
            "eloActual": 1200,
            "activo": True,
            "fechaRegistro": ahora,
            "creadoPor": "seed",
            "origen": {"tipo": "seed", "pendienteId": None, "fechaAprobacion": ahora},
        })
    db.jugadores.insert_many(docs)
    return id_por_username


def insertar_torneo(db, ids: dict[str, ObjectId]) -> None:
    """Liga 2v2 con 4 equipos. Round-robin: 6 partidos."""
    equipos = [
        (ids["marco"],     ids["oruga"]),
        (ids["guido"],     ids["tobi"]),
        (ids["nano"],      ids["manamaxul"]),
        (ids["tinchi"],    ids["brinzo"]),
    ]
    # Cronograma: (eq_a_idx, eq_b_idx, ganador_idx, ronda)
    cronograma = [
        (0, 1, 0, "jornada_1"),  # marco/oruga vs guido/tobi → ganan marco/oruga
        (2, 3, 3, "jornada_1"),  # nano/maxul vs tinchi/brinzo → ganan tinchi/brinzo
        (0, 2, 0, "jornada_2"),  # marco/oruga vs nano/maxul → ganan marco/oruga
        (1, 3, 1, "jornada_2"),  # guido/tobi vs tinchi/brinzo → ganan guido/tobi
        (0, 3, 3, "semifinal"),  # marco/oruga vs tinchi/brinzo → ganan tinchi/brinzo
        (0, 1, 0, "final"),      # final marco/oruga vs guido/tobi → ganan marco/oruga (CAMPEON)
    ]

    pendiente_doc = {
        "_id": ObjectId(),
        "tipo": "torneo",
        "enviadoPor": "seed",
        "estado": "pendiente",
        "fechaEnvio": datetime.now(timezone.utc),
        "torneo": {
            "nombre": "Liga Demo",
            "fecha": (datetime.now(timezone.utc) - timedelta(days=20)).isoformat(),
            "formato": "liga",
            "modalidad": "2v2",
            "equipos": [[str(a), str(b)] for a, b in equipos],
            "ganador": [str(equipos[0][0]), str(equipos[0][1])],  # marco/oruga campeon
        },
        "partidos": [
            {
                "equipoA": [str(equipos[a][0]), str(equipos[a][1])],
                "equipoB": [str(equipos[b][0]), str(equipos[b][1])],
                "equipoGanador": [str(equipos[g][0]), str(equipos[g][1])],
                "ronda": ronda,
            }
            for (a, b, g, ronda) in cronograma
        ],
    }
    procesar_torneo(pendiente_doc, db, session=None)


def insertar_partidos_sueltos(db, ids: dict[str, ObjectId]) -> None:
    """4 partidos sueltos para sumar variedad."""
    fecha_base = datetime.now(timezone.utc) - timedelta(days=10)
    casos = [
        # (eqA usernames, eqB usernames, ganador (A o B), dias_atras)
        (["beto", "marc"],   ["samuel", "john"], "A", 9),
        (["marco", "tobi"],  ["guido", "nano"],  "B", 7),
        (["oruga", "tinchi"], ["beto", "marc"],  "B", 5),
        (["samuel", "john"], ["marco", "tobi"],  "A", 3),
    ]
    for eq_a, eq_b, ganador, dias in casos:
        fecha = (fecha_base + timedelta(days=10 - dias)).isoformat()
        slots_a = [str(ids[u]) for u in eq_a]
        slots_b = [str(ids[u]) for u in eq_b]
        pendiente_doc = {
            "_id": ObjectId(),
            "tipo": "partido_suelto",
            "enviadoPor": "seed",
            "fecha": fecha,
            "modalidad": "2v2",
            "equipoA": slots_a,
            "equipoB": slots_b,
            "equipoGanador": slots_a if ganador == "A" else slots_b,
            "estado": "pendiente",
            "fechaEnvio": datetime.now(timezone.utc),
        }
        procesar_partido_suelto(pendiente_doc, db, session=None)


def insertar_pendiente_demo(db, ids: dict[str, ObjectId]) -> None:
    """Un pendiente sin aprobar para demostrar el flujo admin."""
    db.pendientes.insert_one({
        "tipo": "partido_suelto",
        "enviadoPor": "guille",
        "fecha": datetime.now(timezone.utc).date().isoformat(),
        "modalidad": "2v2",
        "equipoA": [str(ids["marco"]), str(ids["beto"])],
        "equipoB": [str(ids["nano"]), str(ids["samuel"])],
        "equipoGanador": [str(ids["marco"]), str(ids["beto"])],
        "estado": "pendiente",
        "fechaEnvio": datetime.now(timezone.utc),
    })


def main():
    force = "--force" in sys.argv

    db = connect_mongo()
    try:
        # Drop existing
        if not confirmar(force):
            print("Abortado.")
            return
        for c in COLLECTIONS:
            db[c].drop()
        print(f"[seed] Drop OK ({len(COLLECTIONS)} colecciones)")

        # Indexes
        ensure_indexes(db)

        # Insert jugadores
        ids = insertar_jugadores(db)
        print(f"[seed] {len(ids)} jugadores")

        # Torneo
        insertar_torneo(db, ids)
        print("[seed] 1 torneo (Liga Demo, 6 partidos)")

        # Partidos sueltos
        insertar_partidos_sueltos(db, ids)
        print("[seed] 4 partidos sueltos")

        # Pendiente demo
        insertar_pendiente_demo(db, ids)
        print("[seed] 1 pendiente sin aprobar")

        # Resumen
        print("\n=== Estado final ===")
        for c in COLLECTIONS:
            print(f"  {c.ljust(20)} {db[c].estimated_document_count()} docs")

        print("\n[seed] OK. Probalo con: uvicorn server:app --reload")
    finally:
        close_all()


if __name__ == "__main__":
    main()
