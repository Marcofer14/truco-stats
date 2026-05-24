"""/api/stats/* — endpoints publicos de estadisticas.

Cada endpoint replica un pipeline del backend Node original.
La logica es la misma; cambia solo el lenguaje + driver.
"""
import re
from datetime import datetime
from typing import Optional

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query

from db.client import get_db
from db.serialize import to_jsonable
from services.cache import (
    feed_get,
    feed_push,
    lb_get_all,
    stats_cache_get,
    stats_cache_set,
)

router = APIRouter()


# ── FILTRO DE MODALIDAD ──────────────────────────────────────────────────────
# Derivamos la modalidad del tamano de equipoA (1=individual, 2=2v2, 3=3v3)
SIZE_MAP = {"individual": 1, "2v2": 2, "3v3": 3}


def modalidad_filter(modalidad: Optional[str]) -> Optional[dict]:
    if not modalidad or modalidad not in SIZE_MAP:
        return None
    return {"$expr": {"$eq": [{"$size": "$equipoA"}, SIZE_MAP[modalidad]]}}


def _prepend_filter(pipeline: list, modalidad: Optional[str]) -> list:
    filt = modalidad_filter(modalidad)
    if filt is None:
        return pipeline
    return [{"$match": filt}, *pipeline]


# ── /api/stats/elo ───────────────────────────────────────────────────────────
@router.get("/api/stats/elo")
def stats_elo():
    """Ranking global por ELO actual.

    Estrategia: leemos el orden desde Redis Sorted Set `lb:elo` cuando esta
    disponible (write-through al aprobar); fallback a Mongo si Redis no
    responde o el set esta vacio. nombreCompleto SIEMPRE viene de Mongo
    (Redis solo guarda username + elo).
    """
    try:
        db = get_db()
        lb = lb_get_all()
        if lb:
            # Redis nos da el orden; resolvemos nombreCompleto desde Mongo
            usernames = [u for u, _ in lb]
            jugadores_docs = list(db.jugadores.find(
                {"username": {"$in": usernames}},
                {"username": 1, "nombreCompleto": 1, "eloActual": 1},
            ))
            by_username = {j["username"]: j for j in jugadores_docs}
            result = []
            for username, elo in lb:
                j = by_username.get(username)
                if j:
                    result.append(j)
            return to_jsonable(result)

        # Fallback: Mongo directo
        cursor = (
            db.jugadores
            .find({}, {"username": 1, "nombreCompleto": 1, "eloActual": 1})
            .sort("eloActual", -1)
        )
        return to_jsonable(list(cursor))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── /api/stats/winrate ───────────────────────────────────────────────────────
@router.get("/api/stats/winrate")
def stats_winrate(modalidad: Optional[str] = None):
    cached = stats_cache_get("winrate", modalidad)
    if cached is not None:
        return cached
    try:
        db = get_db()
        pipeline = _prepend_filter([
            {"$addFields": {"todos": {"$setUnion": ["$equipoA", "$equipoB"]}}},
            {"$unwind": "$todos"},
            {"$addFields": {"gano": {"$in": ["$todos", "$equipoGanador"]}}},
            {"$group": {
                "_id": "$todos",
                "partidos": {"$sum": 1},
                "victorias": {"$sum": {"$cond": ["$gano", 1, 0]}},
            }},
            {"$addFields": {
                "derrotas": {"$subtract": ["$partidos", "$victorias"]},
                "winRate": {"$round": [
                    {"$multiply": [{"$divide": ["$victorias", "$partidos"]}, 100]}, 1
                ]},
            }},
            {"$lookup": {"from": "jugadores", "localField": "_id", "foreignField": "_id", "as": "j"}},
            {"$unwind": "$j"},
            {"$project": {
                "username": "$j.username",
                "nombreCompleto": "$j.nombreCompleto",
                "partidos": 1, "victorias": 1, "derrotas": 1, "winRate": 1,
            }},
            {"$sort": {"winRate": -1}},
        ], modalidad)
        result = to_jsonable(list(db.partidos.aggregate(pipeline)))
        stats_cache_set("winrate", modalidad, result)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── /api/stats/parejas ───────────────────────────────────────────────────────
@router.get("/api/stats/parejas")
def stats_parejas(modalidad: Optional[str] = None):
    cached = stats_cache_get("parejas", modalidad)
    if cached is not None:
        return cached
    try:
        db = get_db()
        pipeline = _prepend_filter([
            # Crear entradas (jugadores, gano) para equipoA y equipoB
            {"$project": {
                "equipos": [
                    {"jugadores": "$equipoA", "gano": {"$eq": ["$equipoA", "$equipoGanador"]}},
                    {"jugadores": "$equipoB", "gano": {"$eq": ["$equipoB", "$equipoGanador"]}},
                ]
            }},
            {"$unwind": "$equipos"},
            # Solo equipos de exactamente 2 jugadores (parejas)
            {"$match": {
                "equipos.jugadores.1": {"$exists": True},
                "equipos.jugadores.2": {"$exists": False},
            }},
            {"$addFields": {
                "pareja": {"$cond": [
                    {"$lt": [
                        {"$arrayElemAt": ["$equipos.jugadores", 0]},
                        {"$arrayElemAt": ["$equipos.jugadores", 1]},
                    ]},
                    "$equipos.jugadores",
                    [
                        {"$arrayElemAt": ["$equipos.jugadores", 1]},
                        {"$arrayElemAt": ["$equipos.jugadores", 0]},
                    ],
                ]},
                "gano": "$equipos.gano",
            }},
            {"$group": {
                "_id": "$pareja",
                "partidos": {"$sum": 1},
                "victorias": {"$sum": {"$cond": ["$gano", 1, 0]}},
            }},
            {"$addFields": {
                "winRate": {"$round": [
                    {"$multiply": [{"$divide": ["$victorias", "$partidos"]}, 100]}, 1
                ]},
            }},
            {"$lookup": {"from": "jugadores", "localField": "_id", "foreignField": "_id", "as": "jugadores"}},
            {"$addFields": {
                "usernames": {"$map": {"input": "$jugadores", "as": "j", "in": "$$j.username"}},
                "nombresCompletos": {"$map": {"input": "$jugadores", "as": "j", "in": "$$j.nombreCompleto"}},
            }},
            {"$project": {"jugadores": 0}},
            {"$sort": {"winRate": -1, "partidos": -1}},
            {"$limit": 10},
        ], modalidad)
        result = to_jsonable(list(db.partidos.aggregate(pipeline)))
        stats_cache_set("parejas", modalidad, result)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── /api/stats/torneos ───────────────────────────────────────────────────────
@router.get("/api/stats/torneos")
def stats_torneos():
    cached = stats_cache_get("torneos", None)
    if cached is not None:
        return cached
    try:
        db = get_db()
        pipeline = [
            {"$sort": {"fecha": -1}},
            {"$limit": 10},
            {"$lookup": {
                "from": "jugadores",
                "localField": "equipoGanador",
                "foreignField": "_id",
                "as": "ganadorInfo",
            }},
            {"$addFields": {
                "ganadorUsernames": {"$map": {"input": "$ganadorInfo", "as": "j", "in": "$$j.username"}},
                "ganadorNombresCompletos": {"$map": {"input": "$ganadorInfo", "as": "j", "in": "$$j.nombreCompleto"}},
            }},
            {"$project": {
                "nombre": 1, "fecha": 1, "formato": 1, "modalidad": 1,
                "ganadorUsernames": 1, "ganadorNombresCompletos": 1,
                "equipoGanador": 1,
            }},
        ]
        result = to_jsonable(list(db.torneos.aggregate(pipeline)))
        stats_cache_set("torneos", None, result)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── /api/stats/finales ───────────────────────────────────────────────────────
@router.get("/api/stats/finales")
def stats_finales(modalidad: Optional[str] = None):
    cached = stats_cache_get("finales", modalidad)
    if cached is not None:
        return cached
    try:
        db = get_db()
        pipeline = _prepend_filter([
            {"$match": {"ronda": {"$in": ["semifinal", "final"]}}},
            {"$addFields": {"todos": {"$setUnion": ["$equipoA", "$equipoB"]}}},
            {"$unwind": "$todos"},
            {"$addFields": {"gano": {"$in": ["$todos", "$equipoGanador"]}}},
            {"$group": {
                "_id": "$todos",
                "finalesJugadas": {"$sum": 1},
                "finalesGanadas": {"$sum": {"$cond": ["$gano", 1, 0]}},
            }},
            {"$addFields": {
                "winRate": {"$round": [
                    {"$multiply": [{"$divide": ["$finalesGanadas", "$finalesJugadas"]}, 100]}, 1
                ]},
            }},
            {"$lookup": {"from": "jugadores", "localField": "_id", "foreignField": "_id", "as": "j"}},
            {"$unwind": "$j"},
            {"$project": {
                "username": "$j.username",
                "nombreCompleto": "$j.nombreCompleto",
                "finalesJugadas": 1, "finalesGanadas": 1, "winRate": 1,
            }},
            {"$sort": {"winRate": -1}},
        ], modalidad)
        result = to_jsonable(list(db.partidos.aggregate(pipeline)))
        stats_cache_set("finales", modalidad, result)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── /api/stats/peor-enemigo ──────────────────────────────────────────────────
@router.get("/api/stats/peor-enemigo")
def stats_peor_enemigo(modalidad: Optional[str] = None):
    """Pares (A, B) donde A le gana a B >75% en >=2 enfrentamientos."""
    cached = stats_cache_get("peor-enemigo", modalidad)
    if cached is not None:
        return cached
    try:
        db = get_db()
        pipeline = _prepend_filter([
            # Determinar equipo perdedor
            {"$addFields": {
                "loserTeam": {"$cond": [
                    {"$eq": [{"$size": {"$setDifference": ["$equipoGanador", "$equipoA"]}}, 0]},
                    "$equipoB",
                    "$equipoA",
                ]},
            }},
            # Pares (ganador, perdedor) en ambas direcciones
            {"$project": {
                "winPairs": {"$reduce": {
                    "input": "$equipoGanador",
                    "initialValue": [],
                    "in": {"$concatArrays": [
                        "$$value",
                        {"$map": {"input": "$loserTeam", "as": "loser", "in": {
                            "a": "$$this", "b": "$$loser", "aGano": True,
                        }}},
                    ]},
                }},
                "losePairs": {"$reduce": {
                    "input": "$loserTeam",
                    "initialValue": [],
                    "in": {"$concatArrays": [
                        "$$value",
                        {"$map": {"input": "$equipoGanador", "as": "winner", "in": {
                            "a": "$$this", "b": "$$winner", "aGano": False,
                        }}},
                    ]},
                }},
            }},
            {"$project": {"allPairs": {"$concatArrays": ["$winPairs", "$losePairs"]}}},
            {"$unwind": "$allPairs"},
            {"$group": {
                "_id": {"a": "$allPairs.a", "b": "$allPairs.b"},
                "partidos": {"$sum": 1},
                "victorias": {"$sum": {"$cond": ["$allPairs.aGano", 1, 0]}},
            }},
            {"$match": {"partidos": {"$gte": 2}}},
            {"$addFields": {
                "winRate": {"$round": [
                    {"$multiply": [{"$divide": ["$victorias", "$partidos"]}, 100]}, 1
                ]},
            }},
            {"$match": {"winRate": {"$gt": 75}}},
            {"$lookup": {"from": "jugadores", "localField": "_id.a", "foreignField": "_id", "as": "cazador"}},
            {"$lookup": {"from": "jugadores", "localField": "_id.b", "foreignField": "_id", "as": "victima"}},
            {"$unwind": "$cazador"},
            {"$unwind": "$victima"},
            {"$project": {
                "_id": 0,
                "cazadorId": "$cazador._id",
                "cazadorUsername": "$cazador.username",
                "cazadorNombreCompleto": "$cazador.nombreCompleto",
                "victimaId": "$victima._id",
                "victimaUsername": "$victima.username",
                "victimaNombreCompleto": "$victima.nombreCompleto",
                "partidos": 1, "victorias": 1, "winRate": 1,
            }},
            {"$sort": {"winRate": -1, "partidos": -1}},
            {"$limit": 30},
        ], modalidad)
        result = to_jsonable(list(db.partidos.aggregate(pipeline)))
        stats_cache_set("peor-enemigo", modalidad, result)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── /api/stats/partidos ──────────────────────────────────────────────────────
@router.get("/api/stats/partidos")
def stats_partidos(modalidad: Optional[str] = None):
    cached = stats_cache_get("partidos", modalidad)
    if cached is not None:
        return cached
    try:
        db = get_db()
        pipeline = _prepend_filter([
            {"$sort": {"fecha": -1}},
            {"$limit": 20},
            {"$lookup": {"from": "jugadores", "localField": "equipoA", "foreignField": "_id", "as": "equipoAInfo"}},
            {"$lookup": {"from": "jugadores", "localField": "equipoB", "foreignField": "_id", "as": "equipoBInfo"}},
            {"$lookup": {"from": "jugadores", "localField": "equipoGanador", "foreignField": "_id", "as": "ganadorInfo"}},
            {"$lookup": {"from": "torneos", "localField": "torneoId", "foreignField": "_id", "as": "torneoInfo"}},
            {"$addFields": {
                "equipoAUsernames": {"$map": {"input": "$equipoAInfo", "as": "j", "in": "$$j.username"}},
                "equipoBUsernames": {"$map": {"input": "$equipoBInfo", "as": "j", "in": "$$j.username"}},
                "ganadorUsernames": {"$map": {"input": "$ganadorInfo", "as": "j", "in": "$$j.username"}},
                "equipoANombresCompletos": {"$map": {"input": "$equipoAInfo", "as": "j", "in": "$$j.nombreCompleto"}},
                "equipoBNombresCompletos": {"$map": {"input": "$equipoBInfo", "as": "j", "in": "$$j.nombreCompleto"}},
                "ganadorNombresCompletos": {"$map": {"input": "$ganadorInfo", "as": "j", "in": "$$j.nombreCompleto"}},
                "torneoNombre": {"$arrayElemAt": ["$torneoInfo.nombre", 0]},
            }},
            {"$project": {
                "fecha": 1, "tipoPartido": 1, "ronda": 1, "torneoId": 1, "torneoNombre": 1,
                "equipoAUsernames": 1, "equipoBUsernames": 1, "ganadorUsernames": 1,
                "equipoANombresCompletos": 1, "equipoBNombresCompletos": 1, "ganadorNombresCompletos": 1,
                "eloSnapshot": 1,
            }},
        ], modalidad)
        result = to_jsonable(list(db.partidos.aggregate(pipeline)))
        stats_cache_set("partidos", modalidad, result)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── /api/stats/rachas ────────────────────────────────────────────────────────
@router.get("/api/stats/rachas")
def stats_rachas(modalidad: Optional[str] = None):
    """Racha actual (W/L), maxima de ganadas y de perdidas por jugador."""
    cached = stats_cache_get("rachas", modalidad)
    if cached is not None:
        return cached
    try:
        db = get_db()
        filt = modalidad_filter(modalidad) or {}
        partidos = list(db.partidos.find(filt).sort("fecha", 1))

        por_jugador: dict[str, list[dict]] = {}
        for p in partidos:
            ganadores = {str(_id) for _id in p["equipoGanador"]}
            todos = [*p["equipoA"], *p["equipoB"]]
            for jid in todos:
                key = str(jid)
                por_jugador.setdefault(key, []).append({
                    "fecha": p["fecha"],
                    "gano": key in ganadores,
                })

        ids = [ObjectId(s) for s in por_jugador.keys()]
        jugadores_docs = list(db.jugadores.find(
            {"_id": {"$in": ids}},
            {"username": 1, "nombreCompleto": 1, "eloActual": 1},
        ))
        j_map = {str(j["_id"]): j for j in jugadores_docs}

        result = []
        for jid, evs in por_jugador.items():
            evs.sort(key=lambda e: e["fecha"])
            ultimo = evs[-1]

            actual_len = 0
            for e in reversed(evs):
                if e["gano"] == ultimo["gano"]:
                    actual_len += 1
                else:
                    break

            max_win = max_lose = cur_win = cur_lose = 0
            for e in evs:
                if e["gano"]:
                    cur_win += 1
                    cur_lose = 0
                    if cur_win > max_win:
                        max_win = cur_win
                else:
                    cur_lose += 1
                    cur_win = 0
                    if cur_lose > max_lose:
                        max_lose = cur_lose

            j = j_map.get(jid)
            if not j:
                continue
            result.append({
                "jugadorId": jid,
                "username": j.get("username"),
                "nombreCompleto": j.get("nombreCompleto"),
                "eloActual": j.get("eloActual"),
                "actualLen": actual_len,
                "actualGano": ultimo["gano"],
                "maxWin": max_win,
                "maxLose": max_lose,
                "totalPartidos": len(evs),
            })

        # Orden: rachas ganadoras primero (largas arriba), luego perdedoras (cortas arriba)
        result.sort(key=lambda r: (
            0 if r["actualGano"] else 1,
            -r["actualLen"] if r["actualGano"] else r["actualLen"],
        ))
        ser = to_jsonable(result)
        stats_cache_set("rachas", modalidad, ser)
        return ser
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── /api/stats/h2h ───────────────────────────────────────────────────────────
@router.get("/api/stats/h2h")
def stats_h2h(a: str = Query(...), b: str = Query(...)):
    """Historial detallado entre dos jugadores en equipos opuestos."""
    OID_RE = re.compile(r"^[a-f\d]{24}$", re.IGNORECASE)
    if not OID_RE.match(a) or not OID_RE.match(b):
        raise HTTPException(status_code=400, detail="IDs invalidos")
    if a == b:
        raise HTTPException(status_code=400, detail="a y b deben ser distintos")

    try:
        db = get_db()
        id_a = ObjectId(a)
        id_b = ObjectId(b)

        pipeline = [
            {"$match": {
                "$or": [
                    {"equipoA": id_a, "equipoB": id_b},
                    {"equipoA": id_b, "equipoB": id_a},
                ],
            }},
            {"$sort": {"fecha": -1}},
            {"$lookup": {"from": "jugadores", "localField": "equipoA", "foreignField": "_id", "as": "eqAInfo"}},
            {"$lookup": {"from": "jugadores", "localField": "equipoB", "foreignField": "_id", "as": "eqBInfo"}},
            {"$lookup": {"from": "torneos", "localField": "torneoId", "foreignField": "_id", "as": "torneoInfo"}},
            {"$addFields": {
                "equipoAUsernames": {"$map": {"input": "$eqAInfo", "as": "j", "in": "$$j.username"}},
                "equipoBUsernames": {"$map": {"input": "$eqBInfo", "as": "j", "in": "$$j.username"}},
                "torneoNombre": {"$arrayElemAt": ["$torneoInfo.nombre", 0]},
                "aGano": {"$in": [id_a, "$equipoGanador"]},
            }},
            {"$project": {
                "fecha": 1, "ronda": 1, "tipoPartido": 1, "torneoNombre": 1,
                "equipoAUsernames": 1, "equipoBUsernames": 1, "aGano": 1,
                "eloSnapshot": 1,
            }},
        ]
        partidos = list(db.partidos.aggregate(pipeline))

        a_wins = sum(1 for p in partidos if p.get("aGano"))
        b_wins = len(partidos) - a_wins

        proj = {"username": 1, "nombreCompleto": 1, "eloActual": 1}
        jug_a = db.jugadores.find_one({"_id": id_a}, proj) or {}
        jug_b = db.jugadores.find_one({"_id": id_b}, proj) or {}

        return to_jsonable({
            "a": {"id": a, **jug_a, "wins": a_wins},
            "b": {"id": b, **jug_b, "wins": b_wins},
            "total": len(partidos),
            "partidos": partidos,
        })
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
