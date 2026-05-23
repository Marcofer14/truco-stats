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


def ensure_indexes(db: Database) -> list[str]:
    """Crea (idempotente) todos los indices y devuelve la lista de nombres."""
    creados = []

    # jugadores
    creados.append(db.jugadores.create_index(
        [("usernameLower", ASCENDING)],
        unique=True, name="uniq_usernameLower",
    ))

    # partidos
    creados.append(db.partidos.create_index(
        [("equipoA", ASCENDING), ("fecha", DESCENDING)],
        name="esr_equipoA_fecha",
    ))
    creados.append(db.partidos.create_index(
        [("equipoB", ASCENDING), ("fecha", DESCENDING)],
        name="esr_equipoB_fecha",
    ))
    creados.append(db.partidos.create_index(
        [("tipoPartido", ASCENDING), ("fecha", DESCENDING)],
        name="esr_tipoPartido_fecha",
    ))
    creados.append(db.partidos.create_index(
        [("torneoId", ASCENDING), ("fecha", ASCENDING)],
        name="esr_torneoId_fecha",
    ))
    creados.append(db.partidos.create_index(
        [("fecha", DESCENDING)],
        name="sort_fecha",
    ))

    # elo_historial
    creados.append(db.elo_historial.create_index(
        [("jugadorId", ASCENDING), ("fecha", DESCENDING)],
        name="esr_jugadorId_fecha",
    ))

    # pendientes
    creados.append(db.pendientes.create_index(
        [("estado", ASCENDING), ("fechaEnvio", DESCENDING)],
        name="esr_estado_fechaEnvio",
    ))

    # torneos
    creados.append(db.torneos.create_index(
        [("fecha", DESCENDING)],
        name="sort_fecha",
    ))

    print(f"[indexes] OK ({len(creados)} indices): {', '.join(creados)}")
    return creados
