require("dotenv").config();
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const MONGO_URI    = process.env.MONGO_URI;
const ADMIN_PASS   = process.env.ADMIN_PASSWORD;
const PORT         = process.env.PORT || 3000;
const DB_NAME      = "truco_db";
const K_NORMAL     = 32;
const K_FINAL      = 48;
const K_VET        = 16;
const UMBRAL_VET   = 30;
const RONDAS_FIN   = new Set(["semifinal", "final"]);

let db;

// Validate required environment variables early with helpful message
if (!MONGO_URI) {
  console.error("Missing required environment variable: MONGO_URI");
  console.error(
    "On Render, add it under your service -> Environment -> Environment Variables. Example:\n  MONGO_URI=mongodb+srv://user:password@cluster0.mongodb.net/truco_db?retryWrites=true&w=majority"
  );
  process.exit(1);
}

if (!ADMIN_PASS) {
  console.warn("Warning: ADMIN_PASSWORD not set. Admin endpoints requiring x-admin-password will reject requests.");
}

// ── CONEXIÓN ────────────────────────────────────────────────────────────────
async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  console.log("✅ Conectado a MongoDB");
}

// ── AUTH ADMIN ──────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (req.headers["x-admin-password"] !== ADMIN_PASS) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

// ── ELO ─────────────────────────────────────────────────────────────────────
function eloEsperado(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

// ── API: JUGADORES ──────────────────────────────────────────────────────────
app.get("/api/jugadores", async (req, res) => {
  try {
    const jugadores = await db
      .collection("jugadores")
      .find({}, { projection: { nombre: 1, eloActual: 1 } })
      .sort({ nombre: 1 })
      .toArray();
    res.json(jugadores);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: STATS ───────────────────────────────────────────────────────────────

// Ranking ELO
app.get("/api/stats/elo", async (req, res) => {
  try {
    const data = await db
      .collection("jugadores")
      .find({}, { projection: { nombre: 1, eloActual: 1 } })
      .sort({ eloActual: -1 })
      .toArray();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Win rate general
app.get("/api/stats/winrate", async (req, res) => {
  try {
    const data = await db.collection("partidos").aggregate([
      {
        $addFields: {
          ganadores: { $cond: [{ $eq: ["$ganador", "A"] }, "$equipoA", "$equipoB"] },
          todos:     { $setUnion: ["$equipoA", "$equipoB"] },
        },
      },
      { $unwind: "$todos" },
      { $addFields: { gano: { $in: ["$todos", "$ganadores"] } } },
      {
        $group: {
          _id:       "$todos",
          partidos:  { $sum: 1 },
          victorias: { $sum: { $cond: ["$gano", 1, 0] } },
        },
      },
      {
        $addFields: {
          derrotas: { $subtract: ["$partidos", "$victorias"] },
          winRate:  { $round: [{ $multiply: [{ $divide: ["$victorias", "$partidos"] }, 100] }, 1] },
        },
      },
      { $lookup: { from: "jugadores", localField: "_id", foreignField: "_id", as: "j" } },
      { $unwind: "$j" },
      { $project: { nombre: "$j.nombre", partidos: 1, victorias: 1, derrotas: 1, winRate: 1 } },
      { $sort: { winRate: -1 } },
    ]).toArray();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Mejores parejas
app.get("/api/stats/parejas", async (req, res) => {
  try {
    const data = await db.collection("partidos").aggregate([
      {
        $project: {
          equipos: [
            { jugadores: "$equipoA", gano: { $eq: ["$ganador", "A"] } },
            { jugadores: "$equipoB", gano: { $eq: ["$ganador", "B"] } },
          ],
        },
      },
      { $unwind: "$equipos" },
      {
        $match: {
          "equipos.jugadores.1": { $exists: true },
          "equipos.jugadores.2": { $exists: false },
        },
      },
      {
        $addFields: {
          pareja: {
            $cond: [
              { $lt: [{ $arrayElemAt: ["$equipos.jugadores", 0] }, { $arrayElemAt: ["$equipos.jugadores", 1] }] },
              "$equipos.jugadores",
              [{ $arrayElemAt: ["$equipos.jugadores", 1] }, { $arrayElemAt: ["$equipos.jugadores", 0] }],
            ],
          },
          gano: "$equipos.gano",
        },
      },
      {
        $group: {
          _id:       "$pareja",
          partidos:  { $sum: 1 },
          victorias: { $sum: { $cond: ["$gano", 1, 0] } },
        },
      },
      {
        $addFields: {
          winRate: { $round: [{ $multiply: [{ $divide: ["$victorias", "$partidos"] }, 100] }, 1] },
        },
      },
      { $lookup: { from: "jugadores", localField: "_id", foreignField: "_id", as: "jugadores" } },
      { $addFields: { nombres: { $map: { input: "$jugadores", as: "j", in: "$$j.nombre" } } } },
      { $sort: { winRate: -1, partidos: -1 } },
      { $limit: 10 },
    ]).toArray();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Últimos torneos
app.get("/api/stats/torneos", async (req, res) => {
  try {
    const torneos = await db.collection("torneos").aggregate([
      { $sort: { fecha: -1 } },
      { $limit: 10 },
      { $unwind: { path: "$ganador", preserveNullAndEmptyArrays: true } },
      { $lookup: { from: "jugadores", localField: "ganador", foreignField: "_id", as: "gj" } },
      { $unwind: { path: "$gj", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id:        "$_id",
          nombre:     { $first: "$nombre" },
          fecha:      { $first: "$fecha" },
          formato:    { $first: "$formato" },
          modalidad:  { $first: "$modalidad" },
          ganadores:  { $push: "$gj.nombre" },
        },
      },
      { $sort: { fecha: -1 } },
    ]).toArray();
    res.json(torneos);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Win rate en finales
app.get("/api/stats/finales", async (req, res) => {
  try {
    const data = await db.collection("partidos").aggregate([
      { $match: { ronda: { $in: ["semifinal", "final"] } } },
      {
        $addFields: {
          ganadores: { $cond: [{ $eq: ["$ganador", "A"] }, "$equipoA", "$equipoB"] },
          todos:     { $setUnion: ["$equipoA", "$equipoB"] },
        },
      },
      { $unwind: "$todos" },
      { $addFields: { gano: { $in: ["$todos", "$ganadores"] } } },
      {
        $group: {
          _id:            "$todos",
          finalesJugadas: { $sum: 1 },
          finalesGanadas: { $sum: { $cond: ["$gano", 1, 0] } },
        },
      },
      {
        $addFields: {
          winRate: { $round: [{ $multiply: [{ $divide: ["$finalesGanadas", "$finalesJugadas"] }, 100] }, 1] },
        },
      },
      { $lookup: { from: "jugadores", localField: "_id", foreignField: "_id", as: "j" } },
      { $unwind: "$j" },
      { $project: { nombre: "$j.nombre", finalesJugadas: 1, finalesGanadas: 1, winRate: 1 } },
      { $sort: { winRate: -1 } },
    ]).toArray();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: ENVIAR TORNEO (va a pendientes) ────────────────────────────────────
app.post("/api/pendientes", async (req, res) => {
  try {
    const { torneo, partidos, enviadoPor } = req.body;

    if (!torneo || !partidos || !enviadoPor) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

    await db.collection("pendientes").insertOne({
      torneo,
      partidos,
      enviadoPor,
      estado:      "pendiente",
      fechaEnvio:  new Date(),
    });

    res.json({ ok: true, mensaje: "Torneo enviado. Marco lo revisará antes de publicarlo." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: ADMIN ───────────────────────────────────────────────────────────────

app.get("/api/admin/pendientes", adminAuth, async (req, res) => {
  try {
    const data = await db
      .collection("pendientes")
      .find({ estado: "pendiente" })
      .sort({ fechaEnvio: -1 })
      .toArray();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/rechazar/:id", adminAuth, async (req, res) => {
  try {
    await db.collection("pendientes").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { estado: "rechazado", fechaResolucion: new Date() } }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/aprobar/:id", adminAuth, async (req, res) => {
  try {
    const pendiente = await db
      .collection("pendientes")
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!pendiente) return res.status(404).json({ error: "No encontrado" });

    await procesarTorneo(pendiente);

    await db.collection("pendientes").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { estado: "aprobado", fechaResolucion: new Date() } }
    );

    res.json({ ok: true, mensaje: "Torneo aprobado y publicado." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LÓGICA DE APROBACIÓN ─────────────────────────────────────────────────────
async function procesarTorneo(pendiente) {
  const { torneo, partidos } = pendiente;

  // 1. Resolver jugadores: crear nuevos (NEW:Nombre) y mapear existentes a ObjectId
  const idMap = {}; // "NEW:Nombre" o idString => ObjectId resuelto

  const todosSlots = [...new Set(torneo.equipos.flat())];

  for (const slot of todosSlots) {
    if (slot.startsWith("NEW:")) {
      const nombre = slot.slice(4).trim();
      // Verificar que no exista ya
      const existe = await db.collection("jugadores").findOne({ nombre: { $regex: new RegExp("^" + nombre + "$", "i") } });
      if (existe) {
        idMap[slot] = existe._id;
      } else {
        const nuevoId = new ObjectId();
        await db.collection("jugadores").insertOne({
          _id: nuevoId, nombre, eloActual: 1200, activo: true, fechaRegistro: new Date(),
        });
        idMap[slot] = nuevoId;
      }
    } else {
      idMap[slot] = new ObjectId(slot);
    }
  }

  const resolverEquipo = (eq) => eq.map(slot => idMap[slot]);

  // Obtener ELO de todos los jugadores
  const todosIds = Object.values(idMap);
  const jugadoresDB = await db.collection("jugadores").find({ _id: { $in: todosIds } }).toArray();

  const eloMap = {};
  const partidosJugados = {};
  for (const j of jugadoresDB) {
    eloMap[j._id.toString()] = j.eloActual;
    partidosJugados[j._id.toString()] = await db.collection("partidos").countDocuments({
      $or: [{ equipoA: j._id }, { equipoB: j._id }],
    });
  }

  // 2. Insertar torneo
  const torneoId = new ObjectId();
  await db.collection("torneos").insertOne({
    _id:       torneoId,
    nombre:    torneo.nombre,
    fecha:     new Date(torneo.fecha),
    formato:   torneo.formato,
    modalidad: torneo.modalidad,
    estado:    "finalizado",
    equipos:   torneo.equipos.map(resolverEquipo),
    ganador:   torneo.ganador.map(slot => idMap[slot]),
  });

  // 3. Procesar cada partido con ELO
  for (const partido of partidos) {
    const equipoA = resolverEquipo(partido.equipoA);
    const equipoB = resolverEquipo(partido.equipoB);

    const avgA = equipoA.reduce((s, id) => s + eloMap[id.toString()], 0) / equipoA.length;
    const avgB = equipoB.reduce((s, id) => s + eloMap[id.toString()], 0) / equipoB.length;

    const expA   = eloEsperado(avgA, avgB);
    const expB   = 1 - expA;
    const resA   = partido.ganador === "A" ? 1 : 0;
    const resB   = 1 - resA;
    const esFin  = RONDAS_FIN.has(partido.ronda);

    const partidoId = new ObjectId();
    await db.collection("partidos").insertOne({
      _id:         partidoId,
      torneoId,
      fecha:       new Date(torneo.fecha),
      ronda:       partido.ronda,
      equipoA,
      equipoB,
      ganador:     partido.ganador,
      eloSnapshot: { promedioA: Math.round(avgA), promedioB: Math.round(avgB) },
    });

    const historial = [];

    const actualizarElo = (ids, exp, res) => {
      for (const id of ids) {
        const idStr = id.toString();
        const k = esFin ? K_FINAL : partidosJugados[idStr] >= UMBRAL_VET ? K_VET : K_NORMAL;
        const nuevo = Math.round(eloMap[idStr] + k * (res - exp));
        historial.push({
          jugadorId:   id,
          eloAnterior: eloMap[idStr],
          eloNuevo:    nuevo,
          delta:       nuevo - eloMap[idStr],
          partidoId,
          torneoId,
          fecha:       new Date(torneo.fecha),
          ronda:       partido.ronda,
        });
        eloMap[idStr] = nuevo;
        partidosJugados[idStr]++;
      }
    };

    actualizarElo(equipoA, expA, resA);
    actualizarElo(equipoB, expB, resB);

    await db.collection("elo_historial").insertMany(historial);
  }

  // 4. Actualizar ELO final de cada jugador
  for (const [idStr, elo] of Object.entries(eloMap)) {
    await db
      .collection("jugadores")
      .updateOne({ _id: new ObjectId(idStr) }, { $set: { eloActual: elo } });
  }
}

// ── ARRANQUE ─────────────────────────────────────────────────────────────────
// El servidor arranca siempre en el puerto. Si MongoDB falla, reintenta cada 10s.
const server = app.listen(PORT, () => {
  console.log(`🚀 Server corriendo en puerto ${PORT}`);
});

async function conectarConReintento() {
  const maxIntentos = 10;
  for (let i = 1; i <= maxIntentos; i++) {
    try {
      const client = new MongoClient(MONGO_URI, {
        tls: true,
        serverSelectionTimeoutMS: 10000,
      });
      await client.connect();
      db = client.db(DB_NAME);
      console.log("✅ Conectado a MongoDB Atlas");
      return;
    } catch (err) {
      console.error(`❌ Intento ${i}/${maxIntentos} fallido:`, err.message);
      if (i < maxIntentos) {
        console.log("   Reintentando en 10 segundos...");
        await new Promise(r => setTimeout(r, 10000));
      } else {
        console.error("No se pudo conectar a MongoDB después de varios intentos.");
      }
    }
  }
}

conectarConReintento();
  