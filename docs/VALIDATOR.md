# Validator JSON Schema (Mongo-level)

Defensa en profundidad: aunque el código Python valida en `services/slots.py`
antes de cualquier insert, el validator de Mongo es la última red de seguridad
ante un bug, un script que escriba directo a la DB, o un cliente que
bypassée el backend.

Durante la migración de `nombre` → `username` el validator viejo se
deshabilitó (era incompatible con el shape nuevo). Hay que **re-aplicarlo**
con el shape actual.

## Cómo aplicarlo

1. Abrir MongoDB Compass.
2. Conectar al cluster de Atlas.
3. Botón `>_ MONGOSH` abajo a la izquierda.
4. En el prompt:

```javascript
use truco_db
```

5. Pegar y ejecutar:

```javascript
db.runCommand({
  collMod: "jugadores",
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["username", "usernameLower", "nombreCompleto", "eloActual", "activo", "fechaRegistro"],
      properties: {
        username:       { bsonType: "string", pattern: "^[a-zA-Z0-9_]{3,20}$" },
        usernameLower:  { bsonType: "string" },
        nombreCompleto: { bsonType: "string", minLength: 2, maxLength: 60 },
        eloActual:      { bsonType: ["int", "double"] },
        activo:         { bsonType: "bool" },
        fechaRegistro:  { bsonType: "date" },
        creadoPor:      { bsonType: ["string", "null"] },
        origen:         { bsonType: ["object", "null"] }
      }
    }
  },
  validationLevel: "moderate",
  validationAction: "error"
})
```

Salida esperada: `{ ok: 1, ... }`

## Por qué `validationLevel: "moderate"`

Mongo soporta tres niveles:
- `off`: ignora el validator
- `strict`: aplica a **todos** los inserts y updates
- `moderate`: aplica solo a inserts y updates de docs que ya cumplen el schema

Elegimos `moderate` porque si quedó algún jugador legacy con shape malformado
(ej: que faltó migrar algún campo), `moderate` no rompe el update — pero los
docs nuevos sí están protegidos.

## Verificar que funciona

Probar inserción con shape inválido:

```javascript
db.jugadores.insertOne({
  username: "x",  // muy corto, deberia fallar el pattern
  usernameLower: "x",
  nombreCompleto: "Test",
  eloActual: 1200,
  activo: true,
  fechaRegistro: new Date()
})
```

Esperado: `MongoServerError: Document failed validation`.

## Deshabilitar temporalmente (solo si hace falta para migrar data)

```javascript
db.runCommand({ collMod: "jugadores", validator: {}, validationLevel: "off" })
```

Después de la migración, **siempre** volver a aplicar el validator del bloque anterior.

## Validators para otras colecciones (opcional)

Hoy solo `jugadores` tiene validator. Si la defensa lo pide o se quiere
ampliar la red de seguridad, las otras colecciones también pueden tener uno.
Ejemplo para `partidos`:

```javascript
db.runCommand({
  collMod: "partidos",
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["fecha", "tipoPartido", "ronda", "equipoA", "equipoB", "equipoGanador"],
      properties: {
        fecha:         { bsonType: "date" },
        tipoPartido:   { enum: ["partido_suelto", "torneo", "final"] },
        ronda:         { bsonType: "string" },
        equipoA:       { bsonType: "array", items: { bsonType: "objectId" } },
        equipoB:       { bsonType: "array", items: { bsonType: "objectId" } },
        equipoGanador: { bsonType: "array", items: { bsonType: "objectId" } },
        torneoId:      { bsonType: ["objectId", "null"] },
        eloSnapshot:   { bsonType: "object" }
      }
    }
  },
  validationLevel: "moderate",
  validationAction: "error"
})
```

Esto se puede aplicar incrementalmente sin afectar el código.
