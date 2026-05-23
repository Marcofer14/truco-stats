// ── MIGRACIÓN: nombre → username + nombreCompleto ──
// Cómo correrlo: abrí mongosh en Compass conectado a truco_db y pegá TODO este archivo.
// Idempotente: podés correrlo varias veces sin romper nada.

const map = {
  "Marco":      "Marco Fernandez",
  "Oruga":      "Joaquin Rasines Alcaraz",
  "Guido":      "Guido Presta",
  "Tobi":       "Tobias Vilapreno",
  "Nano":       "Manuel Camblong",
  "ManaMaxul":  "Manuel Medan",
  "Tinchi":     "Martin Busch",
  "Brinzo":     "Juani Brinzo",
  "Beto":       "Beto",
  "Marc":       "Marc Doman",
  "Samuel":     "Mathias Samuel",
  "John":       "Juan Cocaña",
  "Fede":       "Federico Cristi",
  "Simon":      "Simon Cannavaro",
  "Maxi":       "Maxi Reddig",
  "Lauti":      "Lautaro Castares",
  "Figi":       "Julian Figini",
  "Lip":        "Felipe Sorondo",
  "Arrow":      "Agustin Arrojo",
  "Pici":       "Marco Picci",
};

print("=== Migrando jugadores ===");

let updated = 0;
const noEncontrados = [];

for (const [username, nombreCompleto] of Object.entries(map)) {
  // Busca por nombre legacy O por username (si la migración ya corrió antes)
  const r = db.jugadores.updateOne(
    { $or: [ { nombre: username }, { username: username } ] },
    {
      $set: {
        username: username,
        usernameLower: username.toLowerCase(),
        nombreCompleto: nombreCompleto,
      },
      $unset: { nombre: "" },
    }
  );
  if (r.matchedCount === 0) noEncontrados.push(username);
  else updated++;
}

print(`✅ Actualizados con nombre completo: ${updated}`);
if (noEncontrados.length) {
  print(`⚠️  No encontrados en la DB (¿se borraron?): ${noEncontrados.join(", ")}`);
}

// Cualquier jugador que aún tenga `nombre` y no fue mapeado: copiamos como fallback
const huerfanos = db.jugadores.find({ nombre: { $exists: true } }).toArray();
for (const j of huerfanos) {
  db.jugadores.updateOne(
    { _id: j._id },
    {
      $set: {
        username: j.nombre,
        usernameLower: j.nombre.toLowerCase(),
        nombreCompleto: j.nombre,
      },
      $unset: { nombre: "" },
    }
  );
}
if (huerfanos.length) {
  print(`⚠️  Migrados sin nombre completo (username = nombre): ${huerfanos.map(j => j.nombre).join(", ")}`);
}

// Índice único case-insensitive sobre username
try {
  db.jugadores.createIndex({ usernameLower: 1 }, { unique: true, name: "uniq_usernameLower" });
  print("✅ Índice único creado en usernameLower");
} catch (e) {
  if (e.codeName === "IndexOptionsConflict" || e.codeName === "IndexKeySpecsConflict") {
    print("ℹ️  Índice ya existía");
  } else {
    print("⚠️  Error creando índice: " + e.message);
  }
}

print("\n=== Resultado final ===");
db.jugadores.find({}, { username: 1, nombreCompleto: 1, eloActual: 1 }).sort({ username: 1 }).forEach(j => {
  print(`${j.username.padEnd(12)} → ${j.nombreCompleto.padEnd(28)} (ELO ${j.eloActual})`);
});
