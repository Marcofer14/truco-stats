"""Indices compuestos siguiendo la regla ESR (Equality, Sort, Range).

Se invoca en el lifespan al startup. Idempotente: Mongo no falla si el indice
ya existe con el mismo spec.

Justificacion por indice:

- jugadores { usernameLower: 1 } UNIQUE
    Equality lookup + restriccion de unicidad case-insensitive. Critico al
    crear un slot NEW: para evitar duplicados.

- partidos { equipoA: 1, fecha: -1 }
    Query critica: "ultimos partidos de un jugador". Equality sobre array
    (multikey), Sort por fecha descendente. Sin Range.

- partidos { equipoB: 1, fecha: -1 }
    Igual que el anterior pero para el otro equipo. Mongo no agarra
    automaticamente $or sobre arrays distintos sin estos dos indices.

- partidos { tipoPartido: 1, fecha: -1 }
    Para /api/stats/finales: Equality en tipoPartido (semifinal/final),
    Sort por fecha desc.

- partidos { torneoId: 1, fecha: 1 }
    Para listar partidos de un torneo en orden cronologico.

- partidos { fecha: -1 }
    Para /api/stats/partidos (ultimos 20) y filtros temporales generales.

- elo_historial { jugadorId: 1, fecha: -1 }
    Para reconstruir la evolucion del ELO de un jugador. Equality + Sort.

- pendientes { estado: 1, fechaEnvio: -1 }
    Admin filtra por estado=pendiente y ordena por mas recientes.

- torneos { fecha: -1 }
    Listado de ultimos torneos.
"""
from pymongo import ASCENDING, DESCENDING
from pymongo.database import Database
from pymongo.errors import OperationFailure


# Codigos de error de Mongo que indican "ya existe un indice equivalente":
# 85 = IndexOptionsConflict (mismo spec, distinto nombre/opts)
# 86 = IndexKeySpecsConflict (mismo nombre, distinto spec)
_DUP_INDEX_CODES = (85, 86)


def _safe_create(coll, keys, **opts) -> str | None:
    """Crea un indice. Si ya existe uno equivalente (con otro nombre), no falla."""
    try:
        return coll.create_index(keys, **opts)
    except OperationFailure as e:
        if e.code in _DUP_INDEX_CODES:
            print(f"[indexes] {coll.name} {keys}: equivalente ya existe (code {e.code}), skip")
            return None
        raise


def ensure_indexes(db: Database) -> list[str]:
    """Crea (idempotente, tolerante a conflictos de nombre) todos los indices."""
    creados: list[str] = []

    def add(name_or_none):
        if name_or_none:
            creados.append(name_or_none)

    # jugadores
    add(_safe_create(db.jugadores, [("usernameLower", ASCENDING)],
                     unique=True, name="uniq_usernameLower"))

    # partidos
    add(_safe_create(db.partidos, [("equipoA", ASCENDING), ("fecha", DESCENDING)],
                     name="esr_equipoA_fecha"))
    add(_safe_create(db.partidos, [("equipoB", ASCENDING), ("fecha", DESCENDING)],
                     name="esr_equipoB_fecha"))
    add(_safe_create(db.partidos, [("tipoPartido", ASCENDING), ("fecha", DESCENDING)],
                     name="esr_tipoPartido_fecha"))
    add(_safe_create(db.partidos, [("torneoId", ASCENDING), ("fecha", ASCENDING)],
                     name="esr_torneoId_fecha"))
    add(_safe_create(db.partidos, [("fecha", DESCENDING)], name="sort_fecha"))

    # elo_historial
    add(_safe_create(db.elo_historial, [("jugadorId", ASCENDING), ("fecha", DESCENDING)],
                     name="esr_jugadorId_fecha"))

    # pendientes
    add(_safe_create(db.pendientes, [("estado", ASCENDING), ("fechaEnvio", DESCENDING)],
                     name="esr_estado_fechaEnvio"))

    # torneos
    add(_safe_create(db.torneos, [("fecha", DESCENDING)], name="sort_fecha"))

    print(f"[indexes] OK ({len(creados)} indices nuevos): {', '.join(creados) or '(ninguno, ya estaban)'}")
    return creados
