"""Truco Stats — backend FastAPI (PyMongo + Redis).

Reemplaza al server.js de Node. El frontend en public/ no cambia.
"""
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from db.client import close_all, connect_mongo, connect_redis
from db.indexes import ensure_indexes
from routes.admin import router as admin_router
from routes.jugadores import router as jugadores_router
from routes.pendientes import router as pendientes_router
from routes.stats import router as stats_router

load_dotenv()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Conecta Mongo + Redis al startup, cierra al shutdown."""
    db = connect_mongo()
    ensure_indexes(db)
    connect_redis()  # opcional: si falla, seguimos sin cache
    yield
    close_all()


app = FastAPI(
    title="Truco Stats",
    description="Estadisticas y API para Truco entre amigos. Backend PyMongo + Redis.",
    version="2.0.0",
    lifespan=lifespan,
)


# ── HEALTH ───────────────────────────────────────────────────────────────────
@app.get("/api/health")
def health():
    return {"status": "ok", "service": "truco-stats", "stack": "python+pymongo"}


# ── ROUTERS DE API ───────────────────────────────────────────────────────────
app.include_router(jugadores_router)
app.include_router(stats_router)
app.include_router(pendientes_router)
app.include_router(admin_router)


# ── STATIC FILES (DEBE IR DESPUES DE LOS ROUTERS) ────────────────────────────
# Sirve public/index.html en /, public/cargar.html en /cargar.html, etc.
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
if os.path.isdir(PUBLIC_DIR):
    app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="static")


# ── ENTRYPOINT LOCAL (`python server.py`) ────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", 3000))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=True)
