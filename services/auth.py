"""Autenticacion admin via header `x-admin-password`."""
import os

from fastapi import Header, HTTPException


def admin_auth(x_admin_password: str = Header(default="")) -> None:
    """FastAPI dependency. Lanza 401 si la pass no matchea ADMIN_PASSWORD."""
    expected = os.environ.get("ADMIN_PASSWORD")
    if not expected or x_admin_password != expected:
        raise HTTPException(status_code=401, detail="No autorizado")
