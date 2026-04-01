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

if (!MONGO_URI) {
  console.error("Missing required environment variable: MONGO_URI");
  process.exit(1);
}
if (!ADMIN_PASS) {
  console.warn("Warning: ADMIN_PASSWORD not set.");
}

// ── CONEXIÓN ────────────────────────────────────────────────────────────────
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

// ── HELPERS DE SLOT ─────────────────────────────────────────────────────────
function validarSlot(slot) {
  if (!slot || typeof slot !== "string") {
    throw new Error(`Slot inválido: ${JSON.stringify(slot)}`);
  }
  if (!slot.startsWith("NEW:") && !/^[a-f\d]{24}$/i.test(slot)) {
    throw new Error(`"${slot}" no es un ObjectId válido (debe ser 24 caracteres hex)`);
  }
}

async function resolverSlots(slots) {
  // Devuelve un idMap: slot → ObjectId
  const idMap = {};
  const unicos = [...new Set(slots)];

  for (const slot of unicos) {
    validarSlot(slot);

    if (slot.startsWith("NEW:")) {
      const nombre = slot.slice(4).trim();
      if (!nombre) throw new Error("Jugador nuevo sin nombre.");
      const existe = await db.collection("jugadores").findOne({
        nombre: { $regex: new RegExp("^" + nombre + "$", "i") },
      });
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
  return idMap;
}

async function obtenerElos(ids) {
  // Devuelve { eloMap, partidosJugados } para un array de ObjectId
  const jugadoresDB = await db.collection("jugadores")
    .find({ _id: { $in: ids } })
    .toArray();

  const eloMap = {};
  const partidosJugados = {};
  for (const j of jugadoresDB) {
    eloMap[j._id.toString()] = j.eloActual;
    partidosJugados[j._id.toString()] = await db.collection("partidos").countDocuments({
      $or: [{ equipoA: j._id }, { equipoB: j._id }],
    });
  }
  return { eloMap, partidosJugados };
}

function calcularYRegistrarElo(ids, exp, resultado, esFinal, eloMap, partidosJugados, partidoId, torneoId, fecha, ronda) {
  const historial = [];
  for (const id of ids) {
    const idStr = id.toString();
    const k = esFin(ronda) ? K_FINAL : (partidosJugados[idStr] >= UMBRAL_VET ? K_VET : K_NORMAL);
    const nuevo = Math.round(eloMap[idStr] + k * (resultado - exp));
    historial.push({
      jugadorId:   id,
      eloAnterior: eloMap[idStr],
      eloNuevo:    nuevo,
      delta:       nuevo - eloMap[idStr],
      partidoId,
      ...(torneoId ? { torneoId } : {}),
      fecha,
      ronda,
    });
    eloMap[idStr] = nuevo;
    partidosJugados[idStr]++;
  }
  return historial;
}

function esFin(ronda) {
  return RONDAS_FIN.has(ronda);
}

async function actualizarElosEnDB(eloMap) {
  for (const [idStr, elo] of Object.entries(eloMap)) {
    await db.collection("jugadores")
      .updateOne({ _id: new ObjectId(idStr) }, { $set: { eloActual: elo } });
  }
}

// ── API: JUGADORES ──────────────────────────────────────────────────────────
app.get("/api/jugadores", async (req, res) => {
  try {
    const jugadores = await db.collection("jugadores")
      .find({}, { projection: { nombre: 1, eloActual: 1 } })
      .sort({ nombre: 1 })
      .toArray();
    res.json(jugadores);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: STATS ───────────────────────────────────────────────────────────────
app.get("/api/stats/elo", async (req, res) => {
  try {
    const data = await db.collection("jugadores")
      .find({}, { projection: { nombre: 1, eloActual: 1 } })
      .sort({ eloActual: -1 })
      .toArray();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
          _id:       "$_id",
          nombre:    { $first: "$nombre" },
          fecha:     { $first: "$fecha" },
          formato:   { $first: "$formato" },
          modalidad: { $first: "$modalidad" },
          ganadores: { $push: "$gj.nombre" },
        },
      },
      { $sort: { fecha: -1 } },
    ]).toArray();
    res.json(torneos);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

// ── API: ENVIAR PENDIENTE ────────────────────────────────────────────────────
app.post("/api/pendientes", async (req, res) => {
  try {
    const body = req.body;
    const { tipo, enviadoPor } = body;

    if (!tipo || !enviadoPor) {
      return res.status(400).json({ error: "Faltan campos: tipo y enviadoPor son requeridos" });
    }

    if (tipo === "torneo") {
      const { torneo, partidos } = body;
      if (!torneo || !partidos?.length) {
        return res.status(400).json({ error: "Faltan torneo o partidos" });
      }
      await db.collection("pendientes").insertOne({
        tipo, torneo, partidos, enviadoPor,
        estado: "pendiente", fechaEnvio: new Date(),
      });

    } else if (tipo === "partido_suelto") {
      const { fecha, modalidad, equipoA, equipoB, ganador } = body;
      if (!fecha || !modalidad || !equipoA?.length || !equipoB?.length || !ganador) {
        return res.status(400).json({ error: "Faltan campos del partido" });
      }
      await db.collection("pendientes").insertOne({
        tipo, enviadoPor, fecha, modalidad, equipoA, equipoB, ganador,
        estado: "pendiente", fechaEnvio: new Date(),
      });

    } else {
      return res.status(400).json({ error: "Tipo desconocido: " + tipo });
    }

    res.json({ ok: true, mensaje: "Enviado. Marco lo revisará antes de publicarlo." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: ADMIN ───────────────────────────────────────────────────────────────
app.get("/api/admin/pendientes", adminAuth, async (req, res) => {
  try {
    const data = await db.collection("pendientes")
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
    const pendiente = await db.collection("pendientes")
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!pendiente) return res.status(404).json({ error: "No encontrado" });

    if (pendiente.tipo === "partido_suelto") {
      await procesarPartidoSuelto(pendiente);
    } else {
      await procesarTorneo(pendiente);
    }

    await db.collection("pendientes").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { estado: "aprobado", fechaResolucion: new Date() } }
    );

    res.json({ ok: true, mensaje: "Aprobado y publicado." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Borrar pendientes ya procesados
app.delete("/api/admin/pendientes/procesados", adminAuth, async (req, res) => {
  try {
    const result = await db.collection("pendientes").deleteMany({
      estado: { $in: ["aprobado", "rechazado"] },
    });
    res.json({ ok: true, borrados: result.deletedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LÓGICA: PARTIDO SUELTO ───────────────────────────────────────────────────
async function procesarPartidoSuelto(pendiente) {
  const { equipoA: slotsA, equipoB: slotsB, ganador, fecha } = pendiente;

  // 1. Resolver jugadores
  const idMap = await resolverSlots([...slotsA, ...slotsB]);
  const equipoA = slotsA.map(s => idMap[s]);
  const equipoB = slotsB.map(s => idMap[s]);

  // 2. Obtener ELOs actuales
  const todosIds = [...equipoA, ...equipoB];
  const { eloMap, partidosJugados } = await obtenerElos(todosIds);

  // 3. Calcular ELO
  const avgA  = equipoA.reduce((s, id) => s + eloMap[id.toString()], 0) / equipoA.length;
  const avgB  = equipoB.reduce((s, id) => s + eloMap[id.toString()], 0) / equipoB.length;
  const expA  = eloEsperado(avgA, avgB);
  const resA  = ganador === "A" ? 1 : 0;

  // 4. Insertar partido (sin torneoId)
  const partidoId = new ObjectId();
  await db.collection("partidos").insertOne({
    _id:         partidoId,
    fecha:       new Date(fecha),
    ronda:       "partido_suelto",
    equipoA,
    equipoB,
    ganador,
    eloSnapshot: { promedioA: Math.round(avgA), promedioB: Math.round(avgB) },
  });

  // 5. Registrar ELO historial y actualizar jugadores
  const histA = calcularYRegistrarElo(equipoA, expA, resA, false, eloMap, partidosJugados, partidoId, null, new Date(fecha), "partido_suelto");
  const histB = calcularYRegistrarElo(equipoB, 1 - expA, 1 - resA, false, eloMap, partidosJugados, partidoId, null, new Date(fecha), "partido_suelto");

  const historial = [...histA, ...histB].map(h => {
    const entry = { ...h };
    delete entry.torneoId; // no hay torneo para partidos sueltos
    return entry;
  });

  if (historial.length) await db.collection("elo_historial").insertMany(historial);
  await actualizarElosEnDB(eloMap);
}

// ── LÓGICA: TORNEO ───────────────────────────────────────────────────────────
async function procesarTorneo(pendiente) {
  const { torneo, partidos } = pendiente;

  // 1. Resolver jugadores de equipos + partidos
  const todosSlots = [...new Set([
    ...torneo.equipos.flat(),
    ...partidos.flatMap(p => [...p.equipoA, ...p.equipoB]),
  ])];

  const idMap = await resolverSlots(todosSlots);
  const resolverEquipo = (eq) => eq.map(slot => idMap[slot]);

  // 2. Obtener ELOs actuales
  const todosIds = Object.values(idMap);
  const { eloMap, partidosJugados } = await obtenerElos(todosIds);

  // 3. Insertar torneo
  const torneoId = new ObjectId();
  await db.collection("torneos").insertOne({
    _id:       torneoId,
    nombre:    torneo.nombre,
    fecha:     new Date(torneo.fecha),
    formato:   torneo.formato,
    modalidad: torneo.modalidad,
    estado:    "finalizado",
    equipos:   torneo.equipos.map(resolverEquipo),
    ganador:   (torneo.ganador ?? []).map(slot => idMap[slot]),
  });

  // 4. Procesar partidos con ELO
  for (const partido of partidos) {
    const equipoA  = resolverEquipo(partido.equipoA);
    const equipoB  = resolverEquipo(partido.equipoB);
    const avgA     = equipoA.reduce((s, id) => s + eloMap[id.toString()], 0) / equipoA.length;
    const avgB     = equipoB.reduce((s, id) => s + eloMap[id.toString()], 0) / equipoB.length;
    const expA     = eloEsperado(avgA, avgB);
    const resA     = partido.ganador === "A" ? 1 : 0;

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

    const histA = calcularYRegistrarElo(equipoA, expA, resA, false, eloMap, partidosJugados, partidoId, torneoId, new Date(torneo.fecha), partido.ronda);
    const histB = calcularYRegistrarElo(equipoB, 1 - expA, 1 - resA, false, eloMap, partidosJugados, partidoId, torneoId, new Date(torneo.fecha), partido.ronda);

    await db.collection("elo_historial").insertMany([...histA, ...histB]);
  }

  // 5. Actualizar ELOs finales
  await actualizarElosEnDB(eloMap);
}

// ── ARRANQUE ─────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`🚀 Server corriendo en puerto ${PORT}`);
});

conectarConReintento();
