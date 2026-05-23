# Análisis CAP

## Teorema CAP — recap rápido

Ante una **partición de red** (P), un sistema distribuido elige entre:
- **C** (Consistency): todos los nodos ven el mismo dato; si no se puede garantizar, rechazamos la operación.
- **A** (Availability): cada nodo responde (con lo que sabe), aunque pueda ser data vieja.

Mongo Atlas con **replica set** es **CP**: prioriza consistencia. Cuando un primary se aísla del resto del replica set, deja de aceptar writes hasta que el conjunto vuelva a tener mayoría y elija un nuevo primary. Eso es elegir C sobre A.

## Configuración elegida en Truco Stats

Estamos sobre **MongoDB Atlas M0** (tier gratuito) que ya es un replica set de 3 nodos (1 primary + 2 secondaries) en una sola región. No hay sharding (M0 no lo soporta).

### Write concern: `majority`

Toda escritura — incluyendo las transacciones ACID en `services/transactions.py` — usa `writeConcern: "majority"` (default en sesiones con `with_transaction`). Esto significa que un write se confirma sólo cuando es persistido en la mayoría de los nodos (2 de 3 en M0). Si ocurre una partición que aísla al primary, el primary no podrá confirmar writes hasta que se reúna con la mayoría (o un secondary tome el rol).

**Consecuencia:** ante partición, el sistema **bloquea writes** durante segundos hasta que el replica set elige un nuevo primary. Es CP textbook.

### Read concern: `local` por default, `majority` dentro de transacciones

- Las queries de stats públicos usan `readConcern: "local"` (default): leen del primary del shard al que están conectadas. Si justo después de un failover el cliente está conectado al ex-primary, podría leer data vieja por **milisegundos**. Aceptable para stats que se updatean cada minuto.
- Las transacciones ACID usan `readConcern: "snapshot"` automáticamente (PyMongo lo aplica al iniciar la transacción). Esto garantiza que dentro de la transacción todas las lecturas vean el mismo snapshot consistente, sin importar concurrencia.

## ¿Por qué CP y no AP para nosotros?

| Argumento | Decisión |
|---|---|
| El sistema no es time-sensitive: nadie pierde plata si por 30 segundos no se puede aprobar un partido durante una partición. | A puede esperar |
| En cambio, si el sistema fuera AP y aceptara writes durante una partición, podrían crearse **dos jugadores con el mismo username** en ramas distintas que después hay que mergear. El índice único sobre `usernameLower` solo funciona si las escrituras pasan por el mismo nodo (consistencia). | C es no-negociable |
| El ELO es **acumulativo y dependiente del estado actual** (lee `eloActual`, calcula delta, escribe nuevo `eloActual`). Sin consistencia, dos aprobaciones simultáneas podrían leer el mismo `eloActual` y aplicar deltas en serie, perdiendo uno. | C es crítica para la lógica de negocio |
| El volumen es bajo (~60 partidos cargados al año), las particiones en Atlas son raras (downtime SLA 99.95%) y duran segundos. El costo de elegir CP es muy bajo. | Bajo costo, alto beneficio |

## ¿Cómo afecta esto al uso de Redis?

Redis es **AP** dentro de su propio diseño (Redis Standalone es trivialmente consistente porque es un solo nodo; Redis Cluster es AP). En Truco Stats:

- Redis es **cache + materialized views**, **no es fuente de verdad**. Mongo siempre tiene la última palabra.
- Si Redis se cae, los endpoints caen al fallback de Mongo (graceful degradation implementado en `services/cache.py`).
- Si Redis está vivo pero su data está stale (porque alguien aprobó algo y la invalidación todavía no llegó), aceptamos esa inconsistencia eventual:
  - Las stats agregadas son cacheadas por 60s. En la peor ventana, un usuario ve datos 60s viejos. Aceptable.
  - El leaderboard (`lb:elo`) se rebuildea inmediatamente después de cada aprobación. Si Redis tiene un blip justo en ese instante, el siguiente request rebuildea cuando alguien lo lea.

**En síntesis:** Mongo es CP para garantizar la corrección del estado del juego (ELO, jugadores únicos, partidos atómicos). Redis acelera lecturas con eventual consistency aceptada, sin nunca convertirse en single source of truth.
