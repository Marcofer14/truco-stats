"""Calculo de ELO para partidos.

Replica la logica del server.js original.
"""

K_NORMAL = 32      # K-factor estandar
K_FINAL = 48       # K-factor para semifinales y finales
K_VET = 16         # K-factor para jugadores veteranos (>= UMBRAL_VET partidos)
UMBRAL_VET = 30    # Umbral de partidos para considerar veterano
RONDAS_FIN = {"semifinal", "final"}
ELO_INICIAL = 1200


def elo_esperado(elo_a: float, elo_b: float) -> float:
    """Probabilidad esperada de que A le gane a B segun la formula ELO."""
    return 1 / (1 + pow(10, (elo_b - elo_a) / 400))


def k_factor(ronda: str, partidos_jugados: int) -> int:
    """Devuelve el K-factor aplicable segun la ronda y la experiencia."""
    if ronda in RONDAS_FIN:
        return K_FINAL
    if partidos_jugados >= UMBRAL_VET:
        return K_VET
    return K_NORMAL
