# Deploy en Render — backend Python

## Pre-requisitos

- Cuenta en MongoDB Atlas (free tier M0 alcanza).
- Cuenta en Render.com.
- Cuenta en Upstash (Redis free tier) o Render Key Value.

## Setup nuevo

### 1. MongoDB Atlas

1. Creá un cluster gratis M0.
2. En "Database Access" creá un usuario con contraseña.
3. En "Network Access" → "Allow access from anywhere" (`0.0.0.0/0`).
4. Click "Connect" → "Drivers" → Python → copiá el connection string.
5. Reemplazá `<password>` con la del paso 2.

### 2. Redis (Upstash)

1. Entrá a [upstash.com](https://upstash.com), creá una cuenta.
2. Create database → Type: Regional → Name: `truco-stats`.
3. Copiá la `UPSTASH_REDIS_REST_URL` — NO, querés la **Redis CLI URL** (formato `rediss://default:password@host:port`).

### 3. Render

1. New → Web Service → conectá el repo.
2. Configurá:
   - **Runtime**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn server:app --host 0.0.0.0 --port $PORT`
   - **Instance Type**: Free
3. En **Environment Variables**:
   ```
   MONGO_URI       = (de Atlas)
   ADMIN_PASSWORD  = (tu pass del panel admin)
   REDIS_URL       = (de Upstash, rediss://...)
   ```
4. Create Web Service.

Render buildea y deploya. URL final: `https://truco-stats.onrender.com`.

## Migración desde el backend Node

Si tu deploy actual está corriendo Node (`server.js`) y querés switchear a Python:

1. Verificá que `requirements.txt`, `runtime.txt`, `Procfile` y `server.py` están en el repo.
2. En Render → Settings de tu service:
   - Cambiá **Runtime** a `Python 3`.
   - Cambiá **Build Command** a `pip install -r requirements.txt`.
   - Cambiá **Start Command** a `uvicorn server:app --host 0.0.0.0 --port $PORT`.
3. Agregá `REDIS_URL` en Environment.
4. Save & deploy. Tarda ~2 min.

El frontend (`public/`) no necesita cambios — los endpoints tienen el mismo shape JSON.

## Seed inicial

Para arrancar con data de prueba:

```bash
# Localmente, con MONGO_URI seteado en .env:
python seed.py --force
```

El script:
- Borra todas las colecciones de `truco_db`.
- Crea los índices ESR.
- Inserta 12 jugadores, 1 torneo (6 partidos round-robin), 4 partidos sueltos, 1 pendiente sin aprobar.
- Después se puede levantar `uvicorn server:app --reload` y todos los endpoints devuelven data.

## Plan gratis de Render

El plan gratis "duerme" la app después de 15 min sin tráfico. La primera visita tarda ~30 s en despertar. Esto no afecta la data — Mongo y Redis siguen activos.

## Cómo verificar que está sirviendo Python (no Node)

```bash
curl https://truco-stats.onrender.com/api/health
# {"status":"ok","service":"truco-stats","stack":"python+pymongo"}
```

Si responde `Cannot GET /api/health` o algo de Express, todavía estás en Node.
