"""Serializacion de documentos Mongo a JSON.

PyMongo devuelve ObjectId y datetime, que FastAPI no sabe serializar por default.
Convertimos a string / ISO 8601 para mantener el mismo shape JSON que el backend
Node.js anterior — el frontend no necesita cambios.
"""
from datetime import datetime
from typing import Any

from bson import ObjectId


def to_jsonable(value: Any) -> Any:
    """Convierte recursivamente ObjectIds y datetimes a tipos JSON-serializables."""
    if isinstance(value, ObjectId):
        return str(value)
    if isinstance(value, datetime):
        # Match Node.js JSON date format: ISO 8601 with milliseconds + Z
        return value.isoformat(timespec="milliseconds") + "Z" if value.tzinfo is None else value.isoformat(timespec="milliseconds")
    if isinstance(value, dict):
        return {k: to_jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [to_jsonable(v) for v in value]
    if isinstance(value, tuple):
        return [to_jsonable(v) for v in value]
    return value
