# 🃏 Truco Stats

> Plataforma de estadísticas para un grupo de amigos que juega truco. ELO,
> rankings, parejas, peor enemigo, head-to-head, rachas y un panel admin
> que aprueba cargas con transacciones ACID.

**Demo en vivo:** [truco-stats.onrender.com](https://truco-stats.onrender.com)

**Repo:** [github.com/Marcofer14/truco-stats](https://github.com/Marcofer14/truco-stats)

---

## ¿Qué es?

Truco Stats es el sistema oficial de mi grupo para registrar partidos sueltos
y torneos amateurs de truco. Cualquiera del grupo entra a `/cargar.html`,
arma el partido o el torneo, lo envía. El admin lo revisa desde `/admin.html`
y al aprobar se dispara una transacción que actualiza el ELO de todos los
jugadores involucrados y publica la entrada en el dashboard público.

Lo construí como Trabajo Práctico Integrador de la materia *Diseño de
Sistemas NoSQL de Alto Rendimiento* (ver [`docs/INFORME.md`](docs/INFORME.md))
pero también es producto real que el grupo usa.

### Lo que hace el dashboard

- **Ranking ELO** con 6 divisiones (Hierro → Campeón).
- **Win rate global** y filtrable por modalidad (2v2 / 3v3 / 1v1).
- **Clutch:** porcentaje de victoria en semifinales + finales.
- **Mejores parejas:** duos con mejor win rate.
- **Peor enemigo:** quién te gana sistemáticamente (>75% en ≥2 partidos).
- **Rachas:** consecutivas actuales y máximas históricas.
- **Head-to-Head:** click en cualquier rivalidad y se abre el historial completo.
- **Últimos torneos y partidos** con cargado polimórfico.

---

## Stack tecnológico

| Capa | Tecnología | Por qué |
|---|---|---|
| **Backend** | Python 3.11 + FastAPI | Async-ready, OpenAPI auto-generada, Pydantic para validación |
| **DB primaria** | MongoDB Atlas M0 (replica set CP) | Modelado polimórfico + aggregations expresivas |
| **Driver Mongo** | PyMongo (oficial) | Soporte completo de transacciones ACID con `with_transaction` |
| **Cache + materialized views** | Upstash Redis (free) | Sorted Set para leaderboard, Hash para cache de stats (TTL 60s), List para feed |
| **Frontend** | HTML + JS vanilla + Tailwind | Sin framework. Tres páginas (`index`, `cargar`, `admin`) sirviéndose como static via FastAPI |
| **Estilo visual** | Bauhaus (Archivo Black + Inter, paleta crema + rojo/azul/amarillo + negro) | Identidad fuerte, sin gradientes ni sombras |
| **Hosting** | Render.com (free tier) | Auto-deploy on push, manejo de runtime via `runtime.txt` |
| **Testing** | pytest sobre módulos puros | Validación de ELO y parsing de slots |
| **CI** | GitHub Actions | py_compile + pytest en cada push |

### Decisiones que justifican el stack

- **Mongo + Redis (no solo Mongo)**: el TP exige usar ambos. Mongo es source of truth, Redis acelera lecturas con materialized views. Si Redis muere, la app degrada graceful y sigue funcionando.
- **CP sobre AP**: ante una partición de red, Mongo Atlas prioriza consistencia. Justificado en [`docs/CAP.md`](docs/CAP.md) — para nuestro dominio un duplicado de jugador rompe la lógica de ELO; un blip de disponibilidad de 30s es aceptable.
- **Referencing sobre embedding** para jugadores en partidos: los nombres mutan, no queremos reescribir N partidos por rename. Detalle de las 3 decisiones de modelado en [`docs/SCHEMA.md`](docs/SCHEMA.md).

---

## Arquitectura

```
┌──────────────────────┐
│   Render (free)      │  Python 3.11.10 + uvicorn
└──────────┬───────────┘
           │
   ┌───────┴───────────────────────────────────┐
   │           server.py (FastAPI)             │
   │  lifespan: connect → ensure_indexes → warmup
   └─┬──────┬──────┬───────────┬───────────────┘
     │      │      │           │
   routes/      services/         db/
     │            │                │
     │      ┌─────┴──────┐    ┌────┴────┐
     │      │ elo        │    │ client  │
     │      │ slots      │    │ indexes │
     │      │ transactions────│ serialize
     │      │ cache      │    └─────────┘
     │      │ auth       │
     │      └────────────┘
     │
     └─────────────────┬─────────────────┐
                       ▼                 ▼
            ┌──────────────────┐  ┌──────────────┐
            │  MongoDB Atlas   │  │  Upstash     │
            │  (source truth)  │  │  Redis       │
            └──────────────────┘  └──────────────┘
```

Las 5 colecciones de Mongo: `jugadores`, `partidos`, `torneos`,
`elo_historial`, `pendientes`. Diagrama detallado en [`docs/SCHEMA.md`](docs/SCHEMA.md).

---

## Quickstart local

```bash
# 1. Clonar
git clone https://github.com/Marcofer14/truco-stats
cd truco-stats

# 2. Venv + dependencias
python -m venv .venv
.venv\Scripts\activate           # Windows
# source .venv/bin/activate      # macOS/Linux
pip install -r requirements.txt

# 3. Configurar .env (copiá .env.example)
cp .env.example .env
# Editá .env con tus credenciales reales de Atlas

# 4. (Opcional) Poblar la DB con data de prueba
python seed.py --force

# 5. Levantar servidor
uvicorn server:app --reload

# 6. Verificar
curl http://localhost:8000/api/health
# {"status":"ok","service":"truco-stats","stack":"python+pymongo"}
```

Abrí [http://localhost:8000](http://localhost:8000) en el navegador y vas a ver el dashboard.

### Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `MONGO_URI` | ✅ | Connection string de MongoDB Atlas |
| `ADMIN_PASSWORD` | ✅ | Pass del panel `/admin.html` |
| `REDIS_URL` | ❌ | Conexión Redis (`rediss://...`). Sin esto, app levanta sin cache |
| `PORT` | ❌ | Puerto local. Default 8000 |

`.env` está gitignored, nunca commitees credenciales reales.

---

## Tests

```bash
pip install -r requirements-dev.txt

# Tests rapidos (funciones puras, sin DB) — corren en CI
pytest tests/test_elo.py tests/test_slots.py -v

# Tests de integracion contra Atlas (REQUIERE MONGO_URI)
# Crea DB temporal truco_db_test_rollback, prueba la transaccion ACID
# incluyendo el caso de rollback ante excepcion, y limpia al final
pytest tests/test_transactions_integration.py -v
```

El test estrella es
[`test_rollback_no_deja_data_parcial_cuando_falla_mitad_transaccion`](tests/test_transactions_integration.py)
— inserta jugadores + un pendiente, fuerza una excepción artificial a mitad
de `procesar_partido_suelto`, y verifica que NADA quedó en la DB. Demuestra
que `session.with_transaction()` está haciendo rollback correctamente.

## Demo script

Para una presentación en vivo de 2 minutos:

```bash
python scripts/demo.py                              # contra produccion
python scripts/demo.py --url http://localhost:8000  # contra local
python scripts/demo.py --slow                       # pausa entre secciones
```

Recorre los endpoints en orden, muestra los datos formateados con colores
ANSI, mide latencia y evidencia el uso de Redis vs fallback a Mongo.

---

## Deploy en Render

Pre-requisitos:
- Cuenta en [MongoDB Atlas](https://cloud.mongodb.com) con cluster M0.
- Cuenta en [Upstash](https://upstash.com) con un Redis database.
- Cuenta en [Render](https://render.com).

Pasos resumidos:

1. New → Web Service → conectar el repo de GitHub.
2. Configurar:
   - **Runtime:** Python 3
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn server:app --host 0.0.0.0 --port $PORT`
   - **Health Check Path:** `/api/health`
   - **Instance Type:** Free
3. Environment Variables:
   ```
   MONGO_URI       = mongodb+srv://...
   ADMIN_PASSWORD  = tu_password_secreto
   REDIS_URL       = rediss://default:pass@host:port
   ```
4. Create Web Service. Tarda ~2 min.

Detalle completo + troubleshooting en [`DEPLOY.md`](DEPLOY.md).

### Para verificar que está sirviendo Python

```bash
curl https://truco-stats.onrender.com/api/health
# Debe responder: {"status":"ok","stack":"python+pymongo"}
```

---

## Estructura del repo

```
truco-stats/
├── server.py             # FastAPI app + lifespan
├── seed.py               # Drop & reseed (usa las transacciones reales)
├── requirements.txt
├── requirements-dev.txt  # pytest
├── runtime.txt           # python-3.11.10
├── Procfile              # uvicorn server:app
├── db/
│   ├── client.py         # Singletons Mongo + Redis + close_all
│   ├── indexes.py        # ensure_indexes() con 9 índices ESR
│   └── serialize.py      # to_jsonable(): ObjectId/datetime → JSON
├── services/
│   ├── elo.py            # K_NORMAL=32, K_FINAL=48, k_factor(), elo_esperado()
│   ├── slots.py          # Parser NEW:user|nombre + resolver_slots race-safe
│   ├── transactions.py   # procesar_torneo / procesar_partido_suelto + with_transaction
│   ├── cache.py          # Redis: Sorted Set + Hash + List + invalidate_all
│   └── auth.py           # FastAPI dependency admin_auth
├── routes/
│   ├── jugadores.py      # GET /api/jugadores
│   ├── stats.py          # 9 endpoints (winrate, parejas, peor-enemigo, h2h, etc)
│   ├── pendientes.py     # POST /api/pendientes (público)
│   └── admin.py          # 6 endpoints protegidos por x-admin-password
├── docs/                 # Entregables del TP
│   ├── INFORME.md        # Punto de entrada — leer primero
│   ├── DOMAIN.md         # Caso de negocio
│   ├── SCHEMA.md         # Diagrama + 3 decisiones embed/ref
│   ├── CAP.md            # Justificación de Mongo como CP
│   ├── SHARDING.md       # Propuestas de Shard Keys
│   ├── INDEXES.md        # Tabla de los 9 índices con regla ESR
│   └── VALIDATOR.md      # Cómo aplicar el JSON Schema en Mongo
├── public/               # Frontend Bauhaus (HTML estático + CSS + JS vanilla)
│   ├── index.html        # Dashboard
│   ├── cargar.html       # Wizard de carga
│   ├── admin.html        # Panel admin
│   └── style.css         # Tema Bauhaus compartido
├── tests/
│   ├── test_elo.py
│   └── test_slots.py
├── .github/workflows/
│   └── ci.yml            # py_compile + pytest en cada push
├── DEPLOY.md             # Guía detallada de deploy
└── README.md             # Este archivo
```

---

## Trabajo Práctico — entregables

El proyecto cubre las 4 fases del TP de NoSQL:

| Fase | Cubre |
|---|---|
| **1 — Modelado** | [`docs/DOMAIN.md`](docs/DOMAIN.md), [`docs/SCHEMA.md`](docs/SCHEMA.md), [`seed.py`](seed.py) |
| **2 — Procesamiento** | PyMongo, 7 pipelines en [`routes/stats.py`](routes/stats.py), [`docs/INDEXES.md`](docs/INDEXES.md) |
| **3 — Integridad y escala** | [`services/transactions.py`](services/transactions.py), [`docs/CAP.md`](docs/CAP.md), [`docs/SHARDING.md`](docs/SHARDING.md) |
| **4 — Redis** | [`services/cache.py`](services/cache.py) con Sorted Set + Hash + List + TTL + invalidación |

**Punto de entrada del informe:** [`docs/INFORME.md`](docs/INFORME.md).

---

## Defensa / demo en vivo

Recomendado tener abierto antes de la defensa:

1. **GitHub repo** — código + historial de commits.
2. **MongoDB Compass** conectado a Atlas — para mostrar las colecciones, `db.partidos.find().explain()` con `IXSCAN` y los validators.
3. **Upstash Console** — para mostrar las 3 estructuras Redis en vivo (`ZRANGE lb:elo 0 -1 WITHSCORES REV`, `KEYS cache:stats:*`, `LRANGE feed:partidos 0 -1`).
4. **truco-stats.onrender.com** — dashboard funcionando.
5. **Render logs** — para mostrar `[mongo] Conectado`, `[indexes] OK`, `[redis] Conectado`.

Demo flow sugerido:
1. Mostrar `/api/health` → confirma stack Python.
2. Mostrar el dashboard funcionando.
3. Cargar un partido desde `/cargar.html`.
4. Aprobarlo desde `/admin.html` mientras se ven los logs.
5. En Upstash mostrar `cache:stats:*` borrado (invalidación) y `lb:elo` actualizado (write-through).
6. En Compass mostrar el partido nuevo + las entradas de `elo_historial` + el `eloActual` actualizado del jugador.

---

## Autor / colaboración

- Marco Fernandez ([@Marcofer14](https://github.com/Marcofer14))

Grupo del TP: [completar con nombres del grupo de 4-5 personas]

## Licencia

MIT — usalo, forkealo, hacé tu propio truco stats.
