# Truco Stats — Informe del TP NoSQL

Documento maestro del Trabajo Práctico Integrador: Diseño de Sistemas NoSQL de Alto Rendimiento.

## Dominio elegido

**Plataforma de estadísticas de truco entre amigos.** Almacena partidos y torneos, calcula ELO por jugador, sirve un dashboard público con ~10 métricas (ranking, win rate, parejas, peor enemigo, rachas, head-to-head, etc.) y tiene un panel admin que aprueba cargas pendientes con transacción ACID.

Detalle completo en [`DOMAIN.md`](./DOMAIN.md).

## Cumplimiento punto a punto

### Fase 1 — Modelado y Fundamentos

| Requisito | Cubierto por |
|---|---|
| Definición de Dominio | [`DOMAIN.md`](./DOMAIN.md) |
| Diseño de Esquema (diagrama) | [`SCHEMA.md`](./SCHEMA.md) — Mermaid classDiagram + descripción campo por campo |
| 3 decisiones Embedding vs Referencing | [`SCHEMA.md#las-3-decisiones-de-modelado`](./SCHEMA.md) — `eloSnapshot` embed, `equipoA/B` referencing, `pendientes.partidos` embed |
| Script Seed | [`seed.py`](../seed.py) — drop + reinsert con 12 jugadores + 1 torneo + 4 partidos sueltos + 1 pendiente |

### Fase 2 — Integración y Procesamiento Avanzado

| Requisito | Cubierto por |
|---|---|
| Driver oficial Python (PyMongo) | [`requirements.txt`](../requirements.txt), todos los `routes/` y `services/` |
| ≥3 pipelines de Aggregation | [`routes/stats.py`](../routes/stats.py) — implementamos 7 pipelines: `winrate`, `parejas`, `finales`, `torneos`, `peor-enemigo` (con `$reduce` + `$concatArrays` + `$setDifference`), `partidos`, `h2h` |
| Índices ESR en consultas críticas | [`db/indexes.py`](../db/indexes.py) + justificación en [`INDEXES.md`](./INDEXES.md) — 9 índices compuestos |

### Fase 3 — Integridad y Escalabilidad

| Requisito | Cubierto por |
|---|---|
| Transacción multi-documento (ACID) | [`services/transactions.py`](../services/transactions.py) — `aprobar_pendiente_atomico` envuelve insert torneo + N partidos + N*M elo_historial + N updates jugadores con `session.with_transaction()` |
| Análisis CAP | [`CAP.md`](./CAP.md) — Mongo Atlas como CP, write concern majority, comportamiento ante partición |
| Estrategia de Sharding | [`SHARDING.md`](./SHARDING.md) — propuestas con hashed shard keys, hot-spots evitados |

### Fase 4 — Aceleración con Redis

| Requisito | Cubierto por |
|---|---|
| ≥2 estructuras distintas a Strings | [`services/cache.py`](../services/cache.py) — usamos **3**: Sorted Set (`lb:elo`), Hash (`cache:stats:*`), List (`feed:partidos`) |
| TTL + invalidación coherente | TTL 60s en el Hash `cache:stats:*`. Invalidación explícita vía `invalidate_all_after_write()` en cada admin action (aprobar/rechazar/editar) |

## Manejo de errores en la transacción

`services/transactions.py:aprobar_pendiente_atomico`:
- Valida que el pendiente exista (`LookupError` → 404).
- Valida que esté en estado `pendiente` (no re-procesar) → `ValueError` → 400.
- Envuelve todo el flujo en `session.with_transaction()` que aplica retry automático ante `TransientTransactionError`.
- Cualquier excepción dentro del `_txn` provoca rollback automático: Mongo descarta TODOS los writes de la sesión.

`services/slots.py:resolver_slots`:
- Race-safe ante el índice único `usernameLower`: ante `DuplicateKeyError` re-busca y usa el ganador de la carrera.

`routes/admin.py:aprobar`:
- Recibe excepciones específicas (LookupError, ValueError) y devuelve códigos HTTP correctos.
- Excepción genérica → 500 con mensaje legible.

## Eficiencia de los pipelines

Las aggregations costosas (winrate, peor-enemigo, parejas) están cacheadas en Redis Hash con TTL 60s. La primera request del minuto computa, las siguientes leen de Redis en O(1).

El pipeline más complejo, `/api/stats/peor-enemigo`, tiene 13 stages incluyendo `$reduce` con `$concatArrays` para generar pares de oponentes en ambas direcciones. Ver detalle en [`routes/stats.py`](../routes/stats.py).

## Cómo correr / evaluar

```bash
# 1. Clonar el repo
git clone https://github.com/Marcofer14/truco-stats
cd truco-stats

# 2. Crear venv e instalar
python -m venv .venv
.venv/Scripts/activate  # Windows
pip install -r requirements.txt

# 3. Configurar .env
echo "MONGO_URI=mongodb+srv://..." > .env
echo "ADMIN_PASSWORD=test" >> .env
echo "REDIS_URL=redis://localhost:6379" >> .env  # opcional, fallback a Mongo

# 4. Seed
python seed.py --force

# 5. Levantar servidor
uvicorn server:app --reload

# 6. Probar
curl http://localhost:8000/api/health
curl http://localhost:8000/api/stats/elo
```

## Estructura del repo

```
truco-stats/
├── server.py             # FastAPI app + lifespan
├── seed.py               # Script de carga inicial
├── requirements.txt
├── db/
│   ├── client.py         # Singletons Mongo + Redis
│   ├── indexes.py        # ensure_indexes() con ESR
│   └── serialize.py      # ObjectId/datetime -> JSON
├── services/
│   ├── elo.py            # Constantes y funciones ELO
│   ├── slots.py          # Validacion + resolver_slots (race-safe)
│   ├── transactions.py   # procesar_* con with_transaction
│   ├── cache.py          # Wrappers Redis (Sorted Set, Hash, List)
│   └── auth.py           # FastAPI dependency admin
├── routes/
│   ├── jugadores.py
│   ├── stats.py          # 9 endpoints (7 pipelines)
│   ├── pendientes.py
│   └── admin.py          # 6 endpoints protegidos
├── docs/                 # ENTREGABLES DEL TP
│   ├── INFORME.md        # (este)
│   ├── DOMAIN.md
│   ├── SCHEMA.md
│   ├── CAP.md
│   ├── SHARDING.md
│   └── INDEXES.md
└── public/               # Frontend (no parte del TP, dashboard funcional)
```

## Notas de defensa

- **Por qué FastAPI y no Flask:** async-ready, validación con Pydantic incorporada, OpenAPI auto-generada en `/docs`. Para el TP la elección es indistinta; FastAPI es más moderno y deja la puerta abierta a optimizaciones I/O-bound si se sumara async-Mongo (motor).
- **Por qué PyMongo y no Motor:** el TP exige el driver oficial sync. Mongo Atlas M0 no tiene contención de conexiones suficiente como para necesitar async.
- **Por qué Upstash y no Redis self-hosted:** free tier, sin friction de mantener un servidor. La estrategia de cache es agnóstica al provider.
- **Por qué `_id: hashed` como shard key de `partidos` y no `fecha`:** evita el hot tail clásico al insertar siempre data nueva. Detalle en [`SHARDING.md`](./SHARDING.md).
