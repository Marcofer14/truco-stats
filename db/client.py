"""Conexiones a MongoDB Atlas y Redis.

Singletons inicializados en el lifespan de FastAPI.
"""
import os
import time
from typing import Optional

from pymongo import MongoClient
from pymongo.database import Database

try:
    import redis as redis_lib
    Redis = redis_lib.Redis
except ImportError:  # pragma: no cover
    redis_lib = None
    Redis = None  # type: ignore


DB_NAME = "truco_db"

_mongo_client: Optional[MongoClient] = None
_db: Optional[Database] = None
_redis_client: Optional["Redis"] = None  # type: ignore


def connect_mongo() -> Database:
    """Conecta a Mongo Atlas con reintentos. Devuelve la Database.

    Usado en el lifespan al startup.
    """
    global _mongo_client, _db
    if _db is not None:
        return _db

    uri = os.environ.get("MONGO_URI")
    if not uri:
        raise RuntimeError("MONGO_URI no definido. Agregalo en Render > Environment.")

    last_err = None
    for intento in range(1, 11):
        try:
            _mongo_client = MongoClient(uri, tls=True, serverSelectionTimeoutMS=10000)
            _mongo_client.admin.command("ping")
            _db = _mongo_client[DB_NAME]
            print(f"[mongo] Conectado a Atlas (truco_db) en intento {intento}")
            return _db
        except Exception as e:
            last_err = e
            print(f"[mongo] Intento {intento}/10 fallido: {e}")
            time.sleep(2)

    raise RuntimeError(f"No pude conectar a Mongo: {last_err}")


def connect_redis() -> Optional["Redis"]:
    """Conecta a Redis si REDIS_URL esta definido. Fallback graceful si no.

    El sistema funciona sin Redis (en modo "Mongo solamente") y se acelera
    automaticamente cuando esta disponible.
    """
    global _redis_client
    if _redis_client is not None:
        return _redis_client

    url = os.environ.get("REDIS_URL")
    if not url:
        print("[redis] REDIS_URL no definido, corriendo sin cache")
        return None

    if redis_lib is None:
        print("[redis] paquete redis no instalado, corriendo sin cache")
        return None

    try:
        client = redis_lib.from_url(url, decode_responses=True, socket_timeout=2)
        client.ping()
        _redis_client = client
        print("[redis] Conectado")
        return _redis_client
    except Exception as e:
        print(f"[redis] No pude conectar ({e}), corriendo sin cache")
        return None


def get_db() -> Database:
    """Devuelve la Database. Falla si no se llamo connect_mongo() antes."""
    if _db is None:
        raise RuntimeError("MongoDB no esta conectado. Llama connect_mongo() en lifespan.")
    return _db


def get_mongo_client() -> MongoClient:
    """Devuelve el MongoClient (necesario para start_session/with_transaction)."""
    if _mongo_client is None:
        raise RuntimeError("MongoDB no esta conectado. Llama connect_mongo() en lifespan.")
    return _mongo_client


def get_redis() -> Optional["Redis"]:
    """Devuelve el cliente Redis si esta disponible, None si no."""
    return _redis_client


def close_all() -> None:
    """Cierra conexiones. Usado en shutdown."""
    global _mongo_client, _db, _redis_client
    if _mongo_client is not None:
        _mongo_client.close()
        _mongo_client = None
        _db = None
    if _redis_client is not None:
        try:
            _redis_client.close()
        except Exception:
            pass
        _redis_client = None
