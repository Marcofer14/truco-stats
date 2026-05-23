"""/api/admin/* — endpoints protegidos por x-admin-password.

Las aprobaciones de pendientes corren dentro de una transaccion ACID.
"""
import re
from datetime import datetime, timezone
from typing import Optional

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request

from db.client import get_db, get_mongo_client
from db.serialize import to_jsonable
from services.auth import admin_auth
from services.slots import USERNAME_RE
from services.transactions import aprobar_pendiente_atomico

router = APIRouter(dependencies=[Depends(admin_auth)])

OID_RE = re.compile(r"^[a-f\d]{24}$", re.IGNORECASE)


def _validar_oid(s: str) -> ObjectId:
    if not OID_RE.match(s):
        raise HTTPException(status_code=400, detail=f"ID invalido: {s}")
    return ObjectId(s)


# ── PENDIENTES ───────────────────────────────────────────────────────────────
@router.get("/api/admin/pendientes")
def listar_pendientes():
    db = get_db()
    data = list(
        db.pendientes
        .find({"estado": "pendiente"})
        .sort("fechaEnvio", -1)
    )

    # Recolectar todos los IDs (no NEW:) referenciados para devolver un nombreMap
    all_slots: set[str] = set()
    for p in data:
        if p.get("tipo") == "torneo":
            for eq in (p.get("torneo") or {}).get("equipos", []):
                all_slots.update(s for s in eq if s and not s.startswith("NEW:"))
            all_slots.update(s for s in ((p.get("torneo") or {}).get("ganador") or []) if s and not s.startswith("NEW:"))
            for partido in p.get("partidos") or []:
                all_slots.update(s for s in partido.get("equipoA", []) if s and not s.startswith("NEW:"))
                all_slots.update(s for s in partido.get("equipoB", []) if s and not s.startswith("NEW:"))
        else:
            for k in ("equipoA", "equipoB", "equipoGanador"):
                all_slots.update(s for s in (p.get(k) or []) if s and not s.startswith("NEW:"))

    ids = [ObjectId(s) for s in all_slots if OID_RE.match(s)]
    jugadores = list(db.jugadores.find({"_id": {"$in": ids}})) if ids else []
    nombre_map = {
        str(j["_id"]): {"username": j.get("username"), "nombreCompleto": j.get("nombreCompleto")}
        for j in jugadores
    }

    return to_jsonable({"pendientes": data, "nombreMap": nombre_map})


@router.post("/api/admin/aprobar/{pendiente_id}")
def aprobar(pendiente_id: str):
    pid = _validar_oid(pendiente_id)
    try:
        aprobar_pendiente_atomico(pid, get_mongo_client(), get_db())
        return {"ok": True, "mensaje": "Aprobado y publicado."}
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error en transaccion: {e}")


@router.post("/api/admin/rechazar/{pendiente_id}")
def rechazar(pendiente_id: str):
    db = get_db()
    pid = _validar_oid(pendiente_id)
    db.pendientes.update_one(
        {"_id": pid},
        {"$set": {"estado": "rechazado", "fechaResolucion": datetime.now(timezone.utc)}},
    )
    return {"ok": True}


@router.delete("/api/admin/pendientes/procesados")
def limpiar_procesados():
    db = get_db()
    r = db.pendientes.delete_many({"estado": {"$in": ["aprobado", "rechazado"]}})
    return {"ok": True, "borrados": r.deleted_count}


# ── JUGADORES ────────────────────────────────────────────────────────────────
@router.get("/api/admin/jugadores")
def listar_jugadores():
    db = get_db()
    data = list(db.jugadores.find({}).sort("usernameLower", 1))
    return to_jsonable(data)


@router.patch("/api/admin/jugadores/{jugador_id}")
async def editar_jugador(jugador_id: str, req: Request):
    db = get_db()
    jid = _validar_oid(jugador_id)
    body = await req.json()

    update: dict = {}
    username: Optional[str] = body.get("username")
    nombre_completo: Optional[str] = body.get("nombreCompleto")
    activo: Optional[bool] = body.get("activo")

    if username is not None:
        if not USERNAME_RE.match(username):
            raise HTTPException(
                status_code=400,
                detail=f'Username invalido: "{username}". 3-20 chars alfanumericos o "_"',
            )
        choque = db.jugadores.find_one({
            "usernameLower": username.lower(),
            "_id": {"$ne": jid},
        })
        if choque:
            raise HTTPException(status_code=409, detail=f'Username "{username}" ya lo usa otro jugador.')
        update["username"] = username
        update["usernameLower"] = username.lower()

    if nombre_completo is not None:
        nc = nombre_completo.strip()
        if not (2 <= len(nc) <= 60):
            raise HTTPException(status_code=400, detail="Nombre completo: 2-60 caracteres.")
        update["nombreCompleto"] = nc

    if activo is not None:
        update["activo"] = bool(activo)

    if not update:
        raise HTTPException(status_code=400, detail="Nada para actualizar.")

    r = db.jugadores.update_one({"_id": jid}, {"$set": update})
    if r.matched_count == 0:
        raise HTTPException(status_code=404, detail="Jugador no encontrado.")
    return {"ok": True}
