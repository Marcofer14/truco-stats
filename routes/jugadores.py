"""GET /api/jugadores — listado publico de jugadores."""
from fastapi import APIRouter, HTTPException

from db.client import get_db
from db.serialize import to_jsonable

router = APIRouter()


@router.get("/api/jugadores")
def listar_jugadores():
    try:
        db = get_db()
        cursor = (
            db.jugadores
            .find({}, {"username": 1, "nombreCompleto": 1, "eloActual": 1})
            .sort("username", 1)
        )
        return to_jsonable(list(cursor))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
