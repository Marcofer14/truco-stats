# Dominio: Truco Stats

## El negocio

**Truco Stats** es una plataforma de seguimiento estadístico para un grupo de amigos que juegan truco regularmente — partidos sueltos y torneos amateurs. El sistema almacena el historial completo de cada partido, calcula un puntaje ELO por jugador, y expone un dashboard público con rankings, rivalidades, rachas y métricas históricas.

El sistema no es comercial: la audiencia son los ~20 jugadores que cargan resultados y los curiosos del grupo que entran a chusmear el ranking. No hay autenticación de jugadores (cualquiera puede cargar un resultado), pero sí hay un **panel admin** protegido por contraseña que aprueba o rechaza cada pendiente antes de publicarlo.

## Actores y flujo

1. **Jugador casual** — entra a `/cargar.html`, completa un formulario (jugadores, equipos, ganador, fecha, formato/modalidad), envía. Su carga queda en estado `pendiente` esperando revisión.
2. **Admin (Marco)** — entra a `/admin.html` con su password, revisa la cola, aprueba o rechaza. Al aprobar, el sistema corre la **transacción ACID** que:
   - inserta el torneo (si aplica)
   - inserta los partidos
   - inserta una entrada por jugador en `elo_historial` con el delta de ELO
   - actualiza `jugadores.eloActual`
   - marca el pendiente como `aprobado`
3. **Visitante público** — entra a `/`, ve el dashboard: ranking ELO con divisiones (Hierro a Campeón), win rate global, clutch (semifinales/finales), mejores parejas, peor enemigo, rachas actuales, head-to-head, últimos partidos y torneos.

## Queries críticas

| Query | Frecuencia | Endpoint |
|---|---|---|
| Ranking ELO global | Cada visita al home | `GET /api/stats/elo` |
| Win rate por jugador, filtrable por modalidad | Cada visita + cambio de tab | `GET /api/stats/winrate?modalidad=2v2` |
| Pares de "cazador → víctima" (>75% wins en >=2 partidos) | Cada visita | `GET /api/stats/peor-enemigo` |
| Racha actual W/L de cada jugador | Cada visita + tab | `GET /api/stats/rachas` |
| Head-to-head detallado entre dos jugadores | Click en peor enemigo | `GET /api/stats/h2h?a=X&b=Y` |
| Listado de pendientes para admin | Cada login admin | `GET /api/admin/pendientes` |

## Volumen estimado

| Colección | Tamaño actual | Proyección 5 años |
|---|---|---|
| `jugadores` | 20 | ~50 |
| `torneos` | ~5 | ~80 |
| `partidos` | ~80 | ~2.000 |
| `elo_historial` | ~400 (5 por partido) | ~10.000 |
| `pendientes` | <10 activos (se purgan) | constante (~10) |

Es un dominio chico. **MongoDB sobra** para esto en términos de volumen — la justificación de elegir MongoDB es el **modelado polimórfico** (un torneo embebe sus equipos como arrays bidimensionales, cada partido tiene metadatos opcionales como `torneoId` o `eloSnapshot`) y la **expresividad de las aggregations** (peor-enemigo es una pipeline de 13 stages que en SQL sería pesadilla).

**Redis** justifica su lugar como capa de aceleración: el ranking ELO se consulta en cada visita al home, el cache de aggregations por modalidad evita recomputar pipelines costosas, y la List `feed:partidos` actúa como materialized view de las últimas 20 partidas.
