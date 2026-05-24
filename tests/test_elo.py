"""Tests para services/elo.py — funciones puras de calculo de ELO."""
import pytest

from services.elo import (
    ELO_INICIAL,
    K_FINAL,
    K_NORMAL,
    K_VET,
    UMBRAL_VET,
    elo_esperado,
    k_factor,
)


class TestEloEsperado:
    def test_jugadores_iguales_da_50_porciento(self):
        assert elo_esperado(1200, 1200) == 0.5

    def test_jugador_a_mucho_mejor_da_alta_prob(self):
        assert elo_esperado(1600, 1200) > 0.9

    def test_jugador_a_mucho_peor_da_baja_prob(self):
        assert elo_esperado(1000, 1400) < 0.1

    def test_simetria(self):
        # Si A le gana B con prob p, B le gana a A con prob 1-p
        p_a = elo_esperado(1350, 1250)
        p_b = elo_esperado(1250, 1350)
        assert pytest.approx(p_a + p_b, rel=1e-9) == 1.0

    def test_diferencia_400_da_aprox_90_10(self):
        # Por definicion del sistema ELO: 400 puntos = 10x mas chance
        prob = elo_esperado(1400, 1000)
        assert pytest.approx(prob, rel=1e-9) == 10 / 11


class TestKFactor:
    def test_ronda_final_usa_k_final(self):
        assert k_factor("final", 5) == K_FINAL

    def test_ronda_semifinal_usa_k_final(self):
        assert k_factor("semifinal", 5) == K_FINAL

    def test_jugador_veterano_usa_k_vet(self):
        # Jugador con muchos partidos jugados, en ronda normal
        assert k_factor("jornada_1", UMBRAL_VET) == K_VET
        assert k_factor("jornada_1", UMBRAL_VET + 100) == K_VET

    def test_jugador_no_veterano_en_ronda_normal_usa_k_normal(self):
        assert k_factor("jornada_1", 0) == K_NORMAL
        assert k_factor("partido_suelto", UMBRAL_VET - 1) == K_NORMAL

    def test_final_overridea_veterania(self):
        # Aun siendo veterano, en una final se usa K_FINAL (no K_VET)
        assert k_factor("final", UMBRAL_VET + 50) == K_FINAL


class TestConstantes:
    def test_elo_inicial_es_1200(self):
        assert ELO_INICIAL == 1200

    def test_k_final_mayor_que_k_normal(self):
        assert K_FINAL > K_NORMAL

    def test_k_vet_menor_que_k_normal(self):
        # Los veteranos tienen menos volatilidad en su ELO
        assert K_VET < K_NORMAL
