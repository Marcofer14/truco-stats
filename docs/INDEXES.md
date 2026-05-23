# Índices compuestos — regla ESR

Cada índice declarado en [`db/indexes.py`](../db/indexes.py) sigue la regla **ESR (Equality, Sort, Range)**: primero los campos que se filtran por igualdad, luego los que se ordenan, finalmente los que se filtran por rango. Esto maximiza la eficiencia del index scan y evita reordenamientos en memoria.

## Tabla resumen

| Colección | Índice | E (Equality) | S (Sort) | R (Range) | Endpoint que lo usa |
|---|---|---|---|---|---|
| `jugadores` | `{ usernameLower: 1 }` **UNIQUE** | `usernameLower` | — | — | `resolver_slots` al crear/buscar jugador, `editar_jugador` para chequear unicidad |
| `partidos` | `{ equipoA: 1, fecha: -1 }` | `equipoA` (multikey) | `fecha` desc | — | "Últimos partidos de un jugador" (en h2h, futuro perfil de jugador) |
| `partidos` | `{ equipoB: 1, fecha: -1 }` | `equipoB` (multikey) | `fecha` desc | — | Igual que el anterior pero para el otro equipo (Mongo no usa el mismo índice para `equipoA` y `equipoB` simultáneamente sin `$or`) |
| `partidos` | `{ tipoPartido: 1, fecha: -1 }` | `tipoPartido` | `fecha` desc | — | `/api/stats/finales` filtra por `tipoPartido in ["semifinal", "final"]` y ordena por fecha |
| `partidos` | `{ torneoId: 1, fecha: 1 }` | `torneoId` | `fecha` asc | — | Listado de partidos de un torneo en orden cronológico |
| `partidos` | `{ fecha: -1 }` | — | `fecha` desc | — | `/api/stats/partidos` últimos 20, ordenado por fecha desc |
| `elo_historial` | `{ jugadorId: 1, fecha: -1 }` | `jugadorId` | `fecha` desc | — | "Evolución del ELO de un jugador" (no hay endpoint público todavía pero está listo para sumar feature) |
| `pendientes` | `{ estado: 1, fechaEnvio: -1 }` | `estado` | `fechaEnvio` desc | — | `/api/admin/pendientes` filtra `estado="pendiente"` y ordena por más recientes primero |
| `torneos` | `{ fecha: -1 }` | — | `fecha` desc | — | `/api/stats/torneos` últimos 10 torneos |

## Ejemplo detallado: `partidos { equipoA: 1, fecha: -1 }`

Query típica:
```js
db.partidos.find({ equipoA: ObjectId("...marco") }).sort({ fecha: -1 }).limit(20)
```

**Sin el índice:** Mongo hace un COLLSCAN completo de `partidos`, filtra en memoria por presencia de Marco en el array, ordena por fecha → O(n log n) sobre toda la colección.

**Con el índice ESR:** Mongo entra al árbol B-tree por el bucket `equipoA=marco_id` (multikey, una entrada por partido donde Marco aparece). Esas entradas YA están ordenadas por `fecha desc` dentro del bucket (segundo campo del índice). Lee las primeras 20 y termina. O(log n) + 20.

**Verificación:**
```js
db.partidos.find({equipoA: ObjectId("...")}).sort({fecha:-1}).explain("executionStats")
// winningPlan.stage = "IXSCAN" con indexName="esr_equipoA_fecha"
// executionStats.totalDocsExamined = 20 (no toda la colección)
```

## Por qué NO armamos un único índice `{ equipoA: 1, equipoB: 1, fecha: -1 }`

Tentación: "un índice con todos los campos hace todo más rápido". Realidad: Mongo solo puede usar **un prefijo contiguo** del índice por query. Si filtras por `equipoB` solo, ese índice no sirve. Mejor dos índices separados que pegan a queries distintas.

## Índices que NO creamos (intencionalmente)

| Índice tentador | Por qué no | Alternativa |
|---|---|---|
| `partidos { equipoGanador: 1 }` | Solo se usa dentro de aggregations grandes (winrate, finales) que ya hacen scatter scan. Costo de mantener el índice no se justifica. | Aggregation iterates partidos completos; OK. |
| `jugadores { eloActual: -1 }` | El ranking se sirve desde Redis Sorted Set `lb:elo`. Mongo solo se usa como fallback con `.sort({eloActual:-1})` sobre 20 docs → COLLSCAN es trivial. | Redis para hot path, sort en memoria para fallback. |
| `elo_historial { partidoId: 1 }` | No queryamos por partido (nadie pregunta "ELOs de este partido específico"). Estaría idle. | — |

## Comportamiento esperado con sharding (futuro)

Si se shardea según [`SHARDING.md`](./SHARDING.md), los índices se mantienen **por shard** (Mongo crea automáticamente índices locales en cada shard). Las queries por `equipoA` siguen siendo eficientes intra-shard; las aggregations grandes hacen scatter-gather con uso de índice por shard.
