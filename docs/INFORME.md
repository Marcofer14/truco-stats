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

---

## FAQ defensiva — preguntas típicas

Material de estudio antes de la defensa. Cada integrante debería tener
respuestas listas para estas preguntas.

### Stack y arquitectura

**¿Por qué MongoDB y no PostgreSQL?**
> El modelo es polimórfico: un torneo embebe un array de equipos que a su
> vez es array de jugadores (jerarquía); un partido suelto tiene metadatos
> opcionales (`torneoId`, `eloSnapshot` embebido). Mongo permite ese shape
> natural. En SQL serían 3 tablas con joins. Además, los pipelines como
> `peor-enemigo` se expresan en 13 stages declarativos vs. CTEs anidados en
> SQL.

**¿Por qué Redis si Mongo ya tiene cache interno?**
> Mongo cachea bloques de disco, no resultados de queries derivadas. La
> aggregation de `peor-enemigo` recorre todos los partidos haciendo $reduce
> + $concatArrays — costosa de recomputar. Cacheándola en un Hash con TTL
> 60s, dos visitas en el mismo minuto no pagan el costo dos veces. Además,
> el TP lo exige.

**¿Por qué tres estructuras Redis (Sorted Set, Hash, List)?**
> Cada una soluciona un patrón distinto:
> - **Sorted Set `lb:elo`**: ranking O(log N) sin recomputar. Materialized view, write-through.
> - **Hash `cache:stats`**: cache de respuestas de aggregations costosas con TTL 60s.
> - **List `feed:partidos`**: feed circular para clientes livianos (mobile, webhook).

### Modelado (las 3 decisiones de embed/ref)

**¿Por qué `eloSnapshot` embebido en `partidos`?**
> Inmutable (snapshot histórico), tamaño fijo (2 ints), se lee siempre con
> el partido. Si fuera referencing, cada lectura agregaría un lookup gratuito.

**¿Por qué `equipoA/B/Ganador` referencing y no embed completo del jugador?**
> Si embebiéramos jugadores en partidos, un rename de "Marco" → "MarcoF"
> obligaría a reescribir N partidos (~60 para un jugador activo). Con refs,
> el lookup es barato (índice por `_id`) y la fuente de verdad queda única.

**¿Por qué `pendientes.partidos` embebido como array?**
> Un pendiente es una **unidad atómica de revisión**: el admin aprueba o
> rechaza el torneo entero, no partidos individuales. Mantener todo en un
> doc evita joins y respeta el lifecycle corto (minutos/horas hasta resolver).

### Transacción ACID

**¿Qué pasa si la transacción falla a la mitad?**
> Rollback completo. Lo probamos en `tests/test_transactions_integration.py`:
> forzamos una excepción artificial en `_actualizar_elos` (paso final) y
> verificamos que los inserts de partido y elo_historial que YA habían
> sucedido dentro de la sesión se deshacen. El pendiente queda como
> `pendiente`, ningún ELO cambia.

**¿Por qué `session.with_transaction()` y no manualmente `start_transaction` + `commit`?**
> `with_transaction` aplica retry automático ante `TransientTransactionError`
> (errores recuperables: connection drop, primary changed, etc). Manualmente
> tendrías que implementar esa lógica de retry. Es la API recomendada por
> MongoDB para casos en producción.

**¿Cómo manejan errores específicos en la transacción?**
> `routes/admin.py:aprobar()` distingue: `LookupError` → 404, `ValueError`
> → 400 (mensajes de validación del dominio), `Exception` → 500. Dentro de
> la transacción, `resolver_slots` maneja `DuplicateKeyError` ante el índice
> único `usernameLower` (race-safe ante creación simultánea del mismo username).

### CAP

**¿Por qué CP y no AP?**
> El dominio prioriza corrección: dos jugadores con el mismo username
> rompen la lógica de ELO. Prefiero que en una partición de 30s el sitio
> no acepte writes (CP) a que termine con data corrupta (AP).

**¿Qué hace Mongo Atlas ante una partición?**
> Atlas M0 ya es replica set de 3 nodos. Si el primary se aísla, los 2
> secondaries restantes mantienen quórum y eligen un nuevo primary
> automáticamente. El ex-primary se rinde (steps down) al darse cuenta que
> está aislado. Writes pausan hasta nuevo primary (~30s típico).

### Índices

**¿Qué es la regla ESR?**
> Equality, Sort, Range — orden óptimo de campos en un índice compuesto.
> Ejemplo: para `db.partidos.find({equipoA: marco_id}).sort({fecha: -1})`,
> el índice ideal es `{equipoA: 1, fecha: -1}`. Primero Equality (filtrar
> rápido al bucket de Marco), luego Sort (las entries del bucket ya están
> ordenadas por fecha desc). Sin Range en este caso.

**¿Por qué dos índices separados (`equipoA`, `equipoB`) y no uno solo?**
> Mongo usa **un prefijo contiguo** de un índice compuesto por query. Si
> tuviéramos `{equipoA: 1, equipoB: 1}`, una query por `equipoB` solo no
> usaría el índice. Dos índices separados cubren ambos patrones.

### Sharding

**¿Por qué `_id: hashed` como shard key de `partidos` y no `fecha`?**
> `{fecha: 1}` es range-based y genera hot tail: todas las inserciones de
> partidos recientes caen en el mismo chunk → un solo shard recibe el 100%
> de la escritura del momento. Con hashed sobre `_id` (que ya tiene alta
> entropía), las inserciones se distribuyen uniformemente desde el primer
> instante.

**¿Y las queries por rango temporal? Con hashed perdés esa ventaja, ¿no?**
> Sí, queries por rango de fechas se vuelven scatter-gather (todos los
> shards filtran y devuelven). Pero esas queries son **cacheadas en Redis
> con TTL 60s** y no son hot path. El trade-off es: writes baratos siempre
> (alta frecuencia) vs reads caros eventuales (mitigados por cache). Para
> nuestro dominio gana writes.

### Redis y cache

**¿Cómo invalidan el cache de forma coherente con el negocio?**
> `invalidate_all_after_write()` se llama POST-commit de la transacción
> Mongo. Borra `cache:stats:*` y rebuildea `lb:elo` + `feed:partidos` desde
> Mongo. Si Redis está caído, las operaciones son no-ops y la app sigue
> funcionando (graceful degradation).

**¿Qué pasa si Redis muere?**
> El código en `services/cache.py` chequea `get_redis()` antes de cada
> operación. Si retorna None, falla suavemente. Los endpoints de stats caen
> al fallback de Mongo. Mismo resultado, menos performance. Cero downtime.

**¿Por qué TTL 60s y no 5 min o 1 hora?**
> Trade-off entre staleness y costo de recompute. Con 60s, en el peor caso
> un usuario ve datos 60s viejos — aceptable para stats de truco. Si fuera
> 1 hora, una aprobación tarda hora en reflejarse, lo cual ofende. Si fuera
> 5s, recomputamos demasiado. 60s es el sweet spot empírico para nuestro
> tráfico (cero a bajo).

### Operacional y futuro

**¿Cómo escalarían si el grupo creciera a 1000 jugadores?**
> Hoy estamos en Atlas M0 (free, replica set 3 nodos, sin sharding). Subir
> a M10 da más RAM y abre sharding. La estrategia de Shard Keys propuesta
> en `SHARDING.md` permite escalado horizontal sin re-modelar. Redis
> Upstash free tier (10k commands/día) puede subir a paid (~$3/mes para
> 100k commands/día).

**¿Cuál fue el mayor desafío del proyecto?**
> La migración de Node a Python conservando shape JSON 100% compatible con
> el frontend. Específicamente: serializar `ObjectId` y `datetime` con el
> mismo formato que producía el driver de Mongo de Node (helper
> `db/serialize.py:to_jsonable()`).

**¿Cómo testean la transacción?**
> `tests/test_transactions_integration.py` corre contra Atlas real (DB
> temporal `truco_db_test_rollback`), seedea jugadores + un pendiente,
> monkey-patcha `_actualizar_elos` para tirar excepción, llama a
> `aprobar_pendiente_atomico`, y verifica que NADA quedó en la DB. El test
> se skipea en CI (no le damos credenciales de Atlas) pero corre local con
> `MONGO_URI` seteado.
