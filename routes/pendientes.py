"""POST /api/pendientes — recibir torneos/partidos pendientes de aprobacion."""
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request

from db.client import get_db
from services.slots import validar_slots_para_pendiente

router = APIRouter()


@router.post("/api/pendientes")
async def crear_pendiente(req: Request):
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(status_code=400, detail="JSON invalido")

    tipo = body.get("tipo")
    enviado_por = body.get("enviadoPor")
    if not tipo or not enviado_por:
        raise HTTPException(status_code=400, detail="Faltan: tipo y enviadoPor")

    db = get_db()
    ahora = datetime.now(timezone.utc)

    if tipo == "torneo":
        torneo = body.get("torneo")
        partidos = body.get("partidos") or []
        if not torneo or not partidos:
            raise HTTPException(status_code=400, detail="Faltan torneo o partidos")

        todos_slots = [
            *(s for eq in (torneo.get("equipos") or []) for s in eq),
            *(torneo.get("ganador") or []),
            *(s for p in partidos for s in [*p.get("equipoA", []), *p.get("equipoB", []), *(p.get("equipoGanador") or [])]),
        ]
        try:
            validar_slots_para_pendiente(todos_slots)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        db.pendientes.insert_one({
            "tipo": tipo,
            "torneo": torneo,
            "partidos": partidos,
            "enviadoPor": enviado_por,
            "estado": "pendiente",
            "fechaEnvio": ahora,
        })

    elif tipo == "partido_suelto":
        fecha = body.get("fecha")
        modalidad = body.get("modalidad")
        equipo_a = body.get("equipoA") or []
        equipo_b = body.get("equipoB") or []
        equipo_ganador = body.get("equipoGanador") or []
        if not (fecha and modalidad and equipo_a and equipo_b and equipo_ganador):
            raise HTTPException(
                status_code=400,
                detail="Partido incompleto: faltan fecha, modalidad, equipoA, equipoB o equipoGanador",
            )

        try:
            validar_slots_para_pendiente([*equipo_a, *equipo_b, *equipo_ganador])
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

        db.pendientes.insert_one({
            "tipo": tipo,
            "enviadoPor": enviado_por,
            "fecha": fecha,
            "modalidad": modalidad,
            "equipoA": equipo_a,
            "equipoB": equipo_b,
            "equipoGanador": equipo_ganador,
            "estado": "pendiente",
            "fechaEnvio": ahora,
        })
    else:
        raise HTTPException(status_code=400, detail=f"Tipo desconocido: {tipo}")

    return {"ok": True, "mensaje": "Enviado. Marco lo revisara."}
