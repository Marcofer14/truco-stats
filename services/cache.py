"""Capa de cache y materialized views en Redis.

Tres estructuras (Fase 4 del TP, supera el minimo de 2):

  Sorted Set  lb:elo
    Leaderboard. Score = eloActual, member = username.
    Write-through: cada aprobacion sincroniza la collection jugadores -> Redis.
    Read directo en /api/stats/elo cuando esta disponible.
    Sin TTL (siempre consistente con Mongo).

  Hash        cache:stats:{endpoint}
    Cache de respuestas de stats agregados. Field = modalidad (all|2v2|3v3|individual).
    TTL 60s sobre la KEY completa (la primera escritura setea el EXPIRE).
    Invalidacion: DEL en cada admin write (aprobar/rechazar/editar).

  List        feed:partidos
    Feed circular de los ultimos 20 partidos aprobados. LPUSH + LTRIM 0 19.
    No tiene TTL (cap implicito de LTRIM). Materialized view.

Si REDIS_URL no esta seteado, todas las funciones son no-ops y la app
sigue funcionando 100% sobre Mongo (graceful degradation).
"""
import json
from typing import Any, Iterable, Optional

from db.client import get_redis
from db.serialize import to_jsonable

# Keys / constantes
LB_KEY = "lb:elo"
FEED_KEY = "feed:partidos"
FEED_MAX = 20
STATS_KEY_PREFIX = "cache:stats:"
STATS_TTL = 60  # segundos


# ── SORTED SET: leaderboard ──────────────────────────────────────────────────
def lb_get_all() -> Optional[list[tuple[str, float]]]:
    """Devuelve [(username, elo)] ordenado de mayor a menor, o None si no hay Redis."""
    r = get_redis()
    if not r:
        return None
    try:
        # ZREVRANGE devuelve [(member, score), ...] cuando withscores=True
        return r.zrevrange(LB_KEY, 0, -1, withscores=True)
    except Exception as e:
        print(f"[cache] lb_get_all fallo: {e}")
        return None


def lb_rebuild(db) -> int:
    """Reconstruye el leaderboard desde Mongo. Devuelve cantidad de jugadores."""
    r = get_redis()
    if not r:
        return 0
    try:
        jugadores = list(db.jugadores.find({}, {"username": 1, "eloActual": 1}))
        if not jugadores:
            r.delete(LB_KEY)
            return 0
        pipe = r.pipeline()
        pipe.delete(LB_KEY)
        mapping = {j["username"]: j["eloActual"] for j in jugadores if j.get("username")}
        if mapping:
            pipe.zadd(LB_KEY, mapping)
        pipe.execute()
        return len(mapping)
    except Exception as e:
        print(f"[cache] lb_rebuild fallo: {e}")
        return 0


# ── HASH: cache de stats por modalidad ───────────────────────────────────────
def _stats_key(endpoint: str) -> str:
    return f"{STATS_KEY_PREFIX}{endpoint}"


def stats_cache_get(endpoint: str, modalidad: Optional[str]) -> Optional[Any]:
    """Lee el cache para {endpoint, modalidad}. Devuelve None si miss/error."""
    r = get_redis()
    if not r:
        return None
    field = modalidad or "all"
    try:
        raw = r.hget(_stats_key(endpoint), field)
        if raw is None:
            return None
        return json.loads(raw)
    except Exception as e:
        print(f"[cache] stats_cache_get({endpoint},{modalidad}) fallo: {e}")
        return None


def stats_cache_set(endpoint: str, modalidad: Optional[str], data: Any) -> None:
    """Setea el cache y aplica TTL al KEY (los demas fields del Hash heredan el EXPIRE)."""
    r = get_redis()
    if not r:
        return
    field = modalidad or "all"
    try:
        key = _stats_key(endpoint)
        # Serializamos pasando por to_jsonable para asegurar tipos basicos
        r.hset(key, field, json.dumps(to_jsonable(data)))
        r.expire(key, STATS_TTL)
    except Exception as e:
        print(f"[cache] stats_cache_set({endpoint},{modalidad}) fallo: {e}")


def stats_cache_invalidate() -> int:
    """Borra todas las keys cache:stats:*. Devuelve cantidad borrada."""
    r = get_redis()
    if not r:
        return 0
    try:
        keys = list(r.scan_iter(match=f"{STATS_KEY_PREFIX}*", count=100))
        if not keys:
            return 0
        return r.delete(*keys)
    except Exception as e:
        print(f"[cache] stats_cache_invalidate fallo: {e}")
        return 0


# ── LIST: feed de partidos recientes ─────────────────────────────────────────
def feed_push(partido_summary: dict) -> None:
    """LPUSH + LTRIM 0 (FEED_MAX-1) para mantener tamano acotado."""
    r = get_redis()
    if not r:
        return
    try:
        r.lpush(FEED_KEY, json.dumps(to_jsonable(partido_summary)))
        r.ltrim(FEED_KEY, 0, FEED_MAX - 1)
    except Exception as e:
        print(f"[cache] feed_push fallo: {e}")


def feed_get(n: int = FEED_MAX) -> Optional[list[dict]]:
    r = get_redis()
    if not r:
        return None
    try:
        raw_list = r.lrange(FEED_KEY, 0, n - 1)
        return [json.loads(x) for x in raw_list]
    except Exception as e:
        print(f"[cache] feed_get fallo: {e}")
        return None


def feed_rebuild(db) -> int:
    """Reconstruye el feed desde Mongo con los ultimos FEED_MAX partidos."""
    r = get_redis()
    if not r:
        return 0
    try:
        partidos = list(
            db.partidos
            .find({}, {"_id": 1, "fecha": 1, "tipoPartido": 1, "ronda": 1, "equipoGanador": 1})
            .sort("fecha", -1)
            .limit(FEED_MAX)
        )
        pipe = r.pipeline()
        pipe.delete(FEED_KEY)
        for p in partidos:
            pipe.lpush(FEED_KEY, json.dumps(to_jsonable(p)))
        pipe.ltrim(FEED_KEY, 0, FEED_MAX - 1)
        pipe.execute()
        return len(partidos)
    except Exception as e:
        print(f"[cache] feed_rebuild fallo: {e}")
        return 0


# ── HELPER: invalidacion completa post-admin ─────────────────────────────────
def invalidate_all_after_write(db) -> None:
    """Llamar despues de toda escritura que altere stats: aprobar/rechazar/editar.

    - Borra el cache de aggregations.
    - Reconstruye el leaderboard (Sorted Set).
    - Reconstruye el feed (List).
    """
    stats_cache_invalidate()
    lb_rebuild(db)
    feed_rebuild(db)
