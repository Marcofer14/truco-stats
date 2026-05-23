"""Procesamiento atomico de pendientes aprobados.

Estos son los UNICOS dos flujos del sistema que tocan multiples colecciones
en una sola operacion logica:

  procesar_partido_suelto:
    - inserta 1 doc en `partidos`
    - inserta N docs en `elo_historial` (uno por jugador)
    - actualiza N docs en `jugadores` (ELO actual)

  procesar_torneo:
    - inserta 1 doc en `torneos`
    - inserta M docs en `partidos`
    - inserta M*N docs en `elo_historial`
    - actualiza N docs en `jugadores`

Sin transaccion, si el proceso falla a la mitad queda data corrupta (ej:
ELO actualizado pero sin partido registrado). Por eso TODAS las escrituras
van dentro de `session.with_transaction()`, que las hace atomicas a nivel
replica set: o se aplica todo, o no se aplica nada.
"""
from datetime import datetime, timezone

from bson import ObjectId

from services.elo import elo_esperado, k_factor
from services.slots import resolver_slots


def _to_datetime(value) -> datetime:
    """Acepta string ISO, datetime, o None y devuelve datetime UTC."""
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    return datetime.now(timezone.utc)


def _obtener_elos_y_jugados(db, ids, session=None):
    """Devuelve (elo_map, jugados) para los _id pasados.

    elo_map[str(id)] -> ELO actual.
    jugados[str(id)] -> cantidad de partidos jugados hasta ahora.
    """
    jugadores = list(db.jugadores.find({"_id": {"$in": ids}}, session=session))
    elo_map = {}
    jugados = {}
    for j in jugadores:
        s = str(j["_id"])
        elo_map[s] = j["eloActual"]
        jugados[s] = db.partidos.count_documents(
            {"$or": [{"equipoA": j["_id"]}, {"equipoB": j["_id"]}]},
            session=session,
        )
    return elo_map, jugados


def _calcular_historial(ids, exp, res, ronda, elo_map, jugados, partido_id, fecha, torneo_id=None):
    """Computa una entrada de elo_historial por jugador y muta elo_map / jugados in-place."""
    historial = []
    for _id in ids:
        s = str(_id)
        k = k_factor(ronda, jugados[s])
        nu = round(elo_map[s] + k * (res - exp))
        entry = {
            "jugadorId": _id,
            "eloAnterior": elo_map[s],
            "eloNuevo": nu,
            "delta": nu - elo_map[s],
            "partidoId": partido_id,
            "fecha": fecha,
            "ronda": ronda,
        }
        if torneo_id is not None:
            entry["torneoId"] = torneo_id
        historial.append(entry)
        elo_map[s] = nu
        jugados[s] += 1
    return historial


def _actualizar_elos(db, elo_map, session=None):
    for s, elo in elo_map.items():
        db.jugadores.update_one(
            {"_id": ObjectId(s)},
            {"$set": {"eloActual": elo}},
            session=session,
        )


# ── PARTIDO SUELTO ───────────────────────────────────────────────────────────
def procesar_partido_suelto(pendiente, db, session=None) -> ObjectId:
    """Inserta partido + elo_historial + actualiza ELO. Atomico si hay session."""
    slots_a = pendiente["equipoA"]
    slots_b = pendiente["equipoB"]
    slots_ganador = pendiente["equipoGanador"]
    fecha = _to_datetime(pendiente.get("fecha"))

    ctx = {
        "enviadoPor": pendiente.get("enviadoPor"),
        "pendienteId": pendiente["_id"],
        "tipo": "partido_suelto",
    }
    id_map = resolver_slots([*slots_a, *slots_b], db, ctx=ctx, session=session)

    eq_a = [id_map[s] for s in slots_a]
    eq_b = [id_map[s] for s in slots_b]
    eq_ganador = [id_map[s] for s in slots_ganador]

    elo_map, jugados = _obtener_elos_y_jugados(db, [*eq_a, *eq_b], session=session)

    avg_a = sum(elo_map[str(i)] for i in eq_a) / len(eq_a)
    avg_b = sum(elo_map[str(i)] for i in eq_b) / len(eq_b)
    exp_a = elo_esperado(avg_a, avg_b)

    set_eq_a = {str(i) for i in eq_a}
    gano_a = all(str(i) in set_eq_a for i in eq_ganador)
    res_a = 1.0 if gano_a else 0.0

    partido_id = ObjectId()
    db.partidos.insert_one({
        "_id": partido_id,
        "fecha": fecha,
        "tipoPartido": "partido_suelto",
        "ronda": "partido_suelto",
        "equipoA": eq_a,
        "equipoB": eq_b,
        "equipoGanador": eq_ganador,
        "eloSnapshot": {"promedioA": round(avg_a), "promedioB": round(avg_b)},
    }, session=session)

    historial = [
        *_calcular_historial(eq_a, exp_a, res_a, "partido_suelto", elo_map, jugados, partido_id, fecha),
        *_calcular_historial(eq_b, 1 - exp_a, 1 - res_a, "partido_suelto", elo_map, jugados, partido_id, fecha),
    ]
    if historial:
        db.elo_historial.insert_many(historial, session=session)

    _actualizar_elos(db, elo_map, session=session)
    return partido_id


# ── TORNEO ───────────────────────────────────────────────────────────────────
def procesar_torneo(pendiente, db, session=None) -> ObjectId:
    """Inserta torneo + N partidos + N*M elo_historial + actualiza ELO. Atomico."""
    torneo = pendiente["torneo"]
    partidos_in = pendiente["partidos"]

    todos_slots = list({
        s for s in [
            *(p for eq in torneo.get("equipos", []) for p in eq),
            *(torneo.get("ganador") or []),
            *(p_slot for p in partidos_in for p_slot in [*p["equipoA"], *p["equipoB"], *(p.get("equipoGanador") or [])]),
        ] if s
    })

    ctx = {
        "enviadoPor": pendiente.get("enviadoPor"),
        "pendienteId": pendiente["_id"],
        "tipo": "torneo",
    }
    id_map = resolver_slots(todos_slots, db, ctx=ctx, session=session)
    todos_ids = list(id_map.values())

    elo_map, jugados = _obtener_elos_y_jugados(db, todos_ids, session=session)

    torneo_id = ObjectId()
    db.torneos.insert_one({
        "_id": torneo_id,
        "nombre": torneo["nombre"],
        "fecha": _to_datetime(torneo.get("fecha")),
        "formato": torneo.get("formato"),
        "modalidad": torneo.get("modalidad"),
        "estado": "finalizado",
        "equipos": [[id_map[s] for s in eq] for eq in torneo.get("equipos", [])],
        "equipoGanador": [id_map[s] for s in (torneo.get("ganador") or [])],
    }, session=session)

    for p in partidos_in:
        eq_a = [id_map[s] for s in p["equipoA"]]
        eq_b = [id_map[s] for s in p["equipoB"]]
        eq_ganador = [id_map[s] for s in (p.get("equipoGanador") or [])]

        avg_a = sum(elo_map[str(i)] for i in eq_a) / len(eq_a)
        avg_b = sum(elo_map[str(i)] for i in eq_b) / len(eq_b)
        exp_a = elo_esperado(avg_a, avg_b)

        set_eq_a = {str(i) for i in eq_a}
        gano_a = all(str(i) in set_eq_a for i in eq_ganador)
        res_a = 1.0 if gano_a else 0.0

        ronda = p["ronda"]
        tipo_partido = "final" if ronda == "final" else "torneo"
        fecha = _to_datetime(torneo.get("fecha"))

        partido_id = ObjectId()
        db.partidos.insert_one({
            "_id": partido_id,
            "torneoId": torneo_id,
            "fecha": fecha,
            "tipoPartido": tipo_partido,
            "ronda": ronda,
            "equipoA": eq_a,
            "equipoB": eq_b,
            "equipoGanador": eq_ganador,
            "eloSnapshot": {"promedioA": round(avg_a), "promedioB": round(avg_b)},
        }, session=session)

        historial = [
            *_calcular_historial(eq_a, exp_a, res_a, ronda, elo_map, jugados, partido_id, fecha, torneo_id),
            *_calcular_historial(eq_b, 1 - exp_a, 1 - res_a, ronda, elo_map, jugados, partido_id, fecha, torneo_id),
        ]
        if historial:
            db.elo_historial.insert_many(historial, session=session)

    _actualizar_elos(db, elo_map, session=session)
    return torneo_id


# ── WRAPPER CON TRANSACCION ──────────────────────────────────────────────────
def aprobar_pendiente_atomico(pendiente_id: ObjectId, client, db) -> None:
    """Ejecuta el procesamiento dentro de una transaccion ACID.

    Si cualquier paso falla, Mongo hace rollback y la DB queda intacta.
    """
    pendiente = db.pendientes.find_one({"_id": pendiente_id})
    if not pendiente:
        raise LookupError("Pendiente no encontrado")
    if pendiente.get("estado") != "pendiente":
        raise ValueError(f"El pendiente ya fue procesado (estado={pendiente.get('estado')})")

    with client.start_session() as session:
        def _txn(s):
            if pendiente["tipo"] == "partido_suelto":
                procesar_partido_suelto(pendiente, db, session=s)
            else:
                procesar_torneo(pendiente, db, session=s)
            db.pendientes.update_one(
                {"_id": pendiente_id},
                {"$set": {
                    "estado": "aprobado",
                    "fechaResolucion": datetime.now(timezone.utc),
                }},
                session=s,
            )
        session.with_transaction(_txn)
