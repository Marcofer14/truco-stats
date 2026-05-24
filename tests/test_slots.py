"""Tests para services/slots.py — parser y validacion (funciones puras)."""
import pytest

from services.slots import (
    parsear_slot_nuevo,
    validar_nombre_completo,
    validar_slots_para_pendiente,
    validar_username,
)


class TestValidarUsername:
    def test_username_valido_pasa(self):
        validar_username("marco_fer")
        validar_username("abc")
        validar_username("MARCO123")

    def test_username_muy_corto_falla(self):
        with pytest.raises(ValueError):
            validar_username("ab")

    def test_username_muy_largo_falla(self):
        with pytest.raises(ValueError):
            validar_username("a" * 21)

    def test_username_con_caracteres_invalidos_falla(self):
        with pytest.raises(ValueError):
            validar_username("marco-fer")  # guion no permitido
        with pytest.raises(ValueError):
            validar_username("marco fer")  # espacio no permitido
        with pytest.raises(ValueError):
            validar_username("marco@fer")  # @ no permitido

    def test_username_vacio_falla(self):
        with pytest.raises(ValueError):
            validar_username("")

    def test_username_no_string_falla(self):
        with pytest.raises(ValueError):
            validar_username(None)  # type: ignore


class TestValidarNombreCompleto:
    def test_nombre_valido_pasa(self):
        validar_nombre_completo("Marco")
        validar_nombre_completo("Marco Fernandez")
        validar_nombre_completo("Juan Cocaña Apellido Largo Tres")

    def test_nombre_muy_corto_falla(self):
        with pytest.raises(ValueError):
            validar_nombre_completo("M")
        with pytest.raises(ValueError):
            validar_nombre_completo("")

    def test_nombre_muy_largo_falla(self):
        with pytest.raises(ValueError):
            validar_nombre_completo("A" * 61)

    def test_nombre_solo_espacios_falla(self):
        with pytest.raises(ValueError):
            validar_nombre_completo("   ")


class TestParsearSlotNuevo:
    def test_formato_completo(self):
        slot = parsear_slot_nuevo("NEW:marco|Marco Fernandez")
        assert slot.username == "marco"
        assert slot.nombre_completo == "Marco Fernandez"

    def test_formato_legacy_sin_pipe(self):
        # Backwards compat: NEW:nombre se interpreta como username = nombreCompleto
        slot = parsear_slot_nuevo("NEW:Beto")
        assert slot.username == "Beto"
        assert slot.nombre_completo == "Beto"

    def test_username_invalido_falla(self):
        with pytest.raises(ValueError):
            parsear_slot_nuevo("NEW:ab|Marco")  # username muy corto

    def test_nombre_invalido_falla(self):
        with pytest.raises(ValueError):
            parsear_slot_nuevo("NEW:marco|M")  # nombre muy corto

    def test_trim_de_espacios(self):
        slot = parsear_slot_nuevo("NEW:  marco  |  Marco Fernandez  ")
        assert slot.username == "marco"
        assert slot.nombre_completo == "Marco Fernandez"


class TestValidarSlotsParaPendiente:
    def test_solo_objectids_validos(self):
        validar_slots_para_pendiente([
            "69c9be35d03d02acca1f6cdf",
            "69cd762ade7295850ffb9e29",
        ])

    def test_mix_de_existentes_y_nuevos(self):
        validar_slots_para_pendiente([
            "69c9be35d03d02acca1f6cdf",
            "NEW:lauti|Lautaro Castares",
        ])

    def test_objectid_invalido_falla(self):
        with pytest.raises(ValueError):
            validar_slots_para_pendiente(["not_an_oid"])

    def test_new_invalido_falla(self):
        with pytest.raises(ValueError):
            validar_slots_para_pendiente(["NEW:ab|Marco"])  # username muy corto

    def test_objectid_caracteres_no_hex_falla(self):
        with pytest.raises(ValueError):
            validar_slots_para_pendiente(["69c9be35d03d02acca1f6cdZ"])  # Z no es hex

    def test_objectid_longitud_incorrecta_falla(self):
        with pytest.raises(ValueError):
            validar_slots_para_pendiente(["69c9be35d03d02acca1f6cd"])  # 23 chars en vez de 24
