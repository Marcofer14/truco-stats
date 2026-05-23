# Estrategia de Sharding

## Contexto

MongoDB Atlas M0 (tier free) **no soporta sharding**. Esta propuesta es teórica: describe qué Shard Keys aplicaríamos si subiéramos a un tier dedicado y necesitáramos escalar horizontalmente.

El criterio rector es **evitar hotspots** — distribuir uniformemente la carga de escritura entre shards — y **mantener performance** en las queries críticas. Sharding mal hecho puede empeorar performance: una query que antes pegaba a 1 nodo puede terminar haciendo `scatter-gather` a todos.

---

## Propuesta por colección

### `partidos` — **Shard Key: `{ _id: "hashed" }`**

Es la colección con más volumen futuro (~2k docs en 5 años, ~100/año). Las queries críticas son:

| Query | Patrón | Afectada por sharding? |
|---|---|---|
| Ranking por jugador (`equipoA` IN) | multikey scatter | Sí, pero el índice resuelve antes |
| Últimos 20 partidos (sort por `fecha` desc) | scatter-gather + merge sort | Sí |
| Partidos de un torneo (`torneoId`) | scatter-gather | Sí |
| Aggregations grandes (winrate, peor-enemigo) | scatter-gather inevitable | Sí |

**Alternativa rechazada: `{ fecha: 1, _id: 1 }`**
Sería range-based y ofrecería **targeted queries** para rangos temporales. Pero genera un **hot tail**: todas las inserciones de partidos recientes van al último chunk → un solo shard recibe TODA la escritura del momento. Inaceptable en producción.

**Por qué `{ _id: "hashed" }`:**
- Los `_id` de Mongo (ObjectId) ya tienen alta entropía. El hash distribuye uniformemente entre shards.
- Las inserciones se reparten entre todos los shards desde el primer instante (no hot tail).
- Las queries por `_id` siguen siendo targeted (pegan a un solo shard).
- Las aggregations grandes (winrate, peor-enemigo, partidos recientes) hacen scatter-gather, pero ya las cacheamos en Redis con TTL 60s → no es un cuello de botella.

### `elo_historial` — **Shard Key: `{ jugadorId: "hashed" }`**

Tabla append-only que crece con cada partido (~5x partidos). Query típica: "evolución del ELO de un jugador" → `find({jugadorId: X}).sort({fecha: -1})`.

**Por qué hashed por `jugadorId`:**
- Distribución uniforme entre shards (ningún jugador genera hot spots).
- La query crítica de un jugador específico es **targeted a un solo shard** (el que tiene su hash). 
- Sacrificamos queries por rango de `jugadorId` (que no hacemos nunca).

### `jugadores` — **Shard Key: `{ usernameLower: "hashed" }`**

Colección chica (~50 docs proyectados a 5 años). Honestamente, no necesita sharding nunca: cabe entera en cualquier shard. Pero si por uniformidad arquitectónica se decide shardear:

**Por qué hashed por `usernameLower`:**
- Las lookups de jugador son por username (al crear NEW: slot) → la query es targeted al shard del hash.
- Distribución uniforme.
- El índice **unique** sobre `usernameLower` debe ser **parte de la shard key** para mantener unicidad global (regla de Mongo): que sea hashed sobre el mismo campo cumple esto.

### `torneos` — **Single shard (no shardear)**

Colección de bajo volumen (~80 docs en 5 años). Las queries son siempre globales (top 10 últimos). Shardear introduce scatter-gather sin beneficio. Mantener en un solo shard (no shardear, o usar `{ _id: "hashed" }` si por uniformidad se requiere).

### `pendientes` — **Single shard (no shardear)**

Colección **efímera**: docs viven minutos/horas, se purgan al aprobar o vía `DELETE /api/admin/pendientes/procesados`. Volumen permanente cercano a 0. No vale la pena shardear.

---

## Tabla resumen

| Colección | Shard Key propuesta | Tipo | Por qué |
|---|---|---|---|
| `jugadores` | `{ usernameLower: "hashed" }` | hashed | unicidad + targeted lookups |
| `partidos` | `{ _id: "hashed" }` | hashed | volumen alto, evita hot tail por fecha |
| `elo_historial` | `{ jugadorId: "hashed" }` | hashed | queries por jugador targeted |
| `torneos` | (no shardear) | — | volumen bajo |
| `pendientes` | (no shardear) | — | colección efímera |

## Trade-offs aceptados

1. **Aggregations grandes son scatter-gather**. Aceptable porque el resultado se cachea en Redis 60s.
2. **No tenemos targeted queries por rango temporal** sobre `partidos`. Si en el futuro se necesita (ej: "partidos de Marco en abril 2026"), agregamos un índice por `{equipoA: 1, fecha: -1}` y la query usa el índice intra-shard. El scatter sigue siendo barato porque cada shard filtra rápido.
3. **Si en el futuro un solo jugador concentra el 50% de los partidos** (ej: Marco juega 100x más que otros), la shard key hashed por jugadorId en `elo_historial` lo concentra en un shard. Para mitigarlo se podría re-evaluar a `{jugadorId: 1, fecha: 1}` compound. No es un escenario realista para este dominio.
