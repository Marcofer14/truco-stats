"""Validacion y parseo de slots de jugadores.

Un slot puede ser:
- ObjectId de 24 hex chars (jugador existente)
- "NEW:username|nombreCompleto" (jugador nuevo)
- "NEW:nombre" (formato legacy, sin nombreCompleto)
"""
import re
from typing import Iterable, NamedTuple

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_]{3,20}$")
OBJECTID_RE = re.compile(r"^[a-f\d]{24}$", re.IGNORECASE)


class SlotNuevo(NamedTuple):
    username: str
    nombre_completo: str


def validar_username(u: str) -> None:
    if not isinstance(u, str) or not USERNAME_RE.match(u):
        raise ValueError(f'Username invalido: "{u}". Debe ser 3-20 caracteres alfanumericos o "_".')


def validar_nombre_completo(n: str) -> None:
    if not isinstance(n, str) or not (2 <= len(n.strip()) <= 60):
        raise ValueError(f'Nombre completo invalido: "{n}". Debe tener entre 2 y 60 caracteres.')


def parsear_slot_nuevo(slot: str) -> SlotNuevo:
    """Parsea un slot `NEW:...` y devuelve (username, nombre_completo) validados."""
    payload = slot[4:]
    if "|" in payload:
        username, nombre_completo = (s.strip() for s in payload.split("|", 1))
    else:
        username = nombre_completo = payload.strip()
    validar_username(username)
    validar_nombre_completo(nombre_completo)
    return SlotNuevo(username=username, nombre_completo=nombre_completo)


def validar_slots_para_pendiente(slots: Iterable[str]) -> None:
    """Valida formato de cada slot. Lanza ValueError ante el primer error."""
    for slot in slots:
        if not isinstance(slot, str):
            raise ValueError("Slot invalido (no es string).")
        if slot.startswith("NEW:"):
            parsear_slot_nuevo(slot)
        elif not OBJECTID_RE.match(slot):
            raise ValueError(f'Slot "{slot}" no es ObjectId valido.')
