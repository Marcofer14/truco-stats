require("dotenv").config();
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const MONGO_URI  = process.env.MONGO_URI;
const ADMIN_PASS = process.env.ADMIN_PASSWORD;
const PORT       = process.env.PORT || 3000;
const DB_NAME    = "truco_db";
const K_NORMAL   = 32;
const K_FINAL    = 48;
const K_VET      = 16;
const UMBRAL_VET = 30;
const RONDAS_FIN = new Set(["semifinal", "final"]);

let db;

if (!MONGO_URI) {
  console.error("MONGO_URI no definido. Agregalo en Render > Environment.");
  process.exit(1);
}
if (!ADMIN_PASS) {
  console.warn("ADMIN_PASSWORD no definido.");
}

// ── CONEXIÓN ─────────────────────────────────────────────────────────────────
async function conectarConReintento() {
  for (let i = 1; i <= 10; i++) {
    try {
      const client = new MongoClient(MONGO_URI, { tls: true, serverSelectionTimeoutMS: 10000 });
      await client.connect();
      db = client.db(DB_NAME);
      console.log("✅ Conectado a MongoDB Atlas");
      return;
    } catch (err) {
      console.error(`❌ Intento ${i}/10:`, err.message);
      if (i < 10) await new Promise(r => setTimeout(r, 10000));
    }
  }
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (req.headers["x-admin-password"] !== ADMIN_PASS)
    return res.status(401).json({ error: "No autorizado" });
  next();
}

// ── ELO ───────────────────────────────────────────────────────────────────────
function eloEsperado(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

// ── HELPERS DE SLOT ───────────────────────────────────────────────────────────
async function resolverSlots(slots) {
  const idMap  = {};
  const unicos = [...new Set(slots.filter(Boolean))];
  for (const slot of unicos) {
    if (typeof slot !== "string")
      throw new Error(`Slot inválido (no es string): ${JSON.stringify(slot)}`);
    if (slot.startsWith("NEW:")) {
      const nombre = slot.slice(4).trim();
      if (!nombre) throw new Error("Jugador nuevo sin nombre.");
      const existe = await db.collection("jugadores").findOne({
        nombre: { $regex: new RegExp(`^${nombre}$`, "i") },
      });
      if (existe) {
        idMap[slot] = existe._id;
      } else {
        const id = new ObjectId();
        await db.collection("jugadores").insertOne({
          _id: id, nombre, eloActual: 1200, activo: true, fechaRegistro: new Date(),
        });
        idMap[slot] = id;
      }
    } else {
      if (!/^[a-f\d]{24}$/i.test(slot))
        throw new Error(`"${slot}" no es un ObjectId válido (24 hex chars).`);
      idMap[slot] = new ObjectId(slot);
    }
  }
  return idMap;
}

async function obtenerElos(ids) {
  const jugadoresDB = await db.collection("jugadores")
    .find({ _id: { $in: ids } }).toArray();
  const eloMap = {}, jugados = {};
  for (const j of jugadoresDB) {
    eloMap[j._id.toString()]  = j.eloActual;
    jugados[j._id.toString()] = await db.collection("partidos").countDocuments({
      $or: [
        { equipoA: j._id },
        { equipoB: j._id },
      ],
    });
  }
  return { eloMap, jugados };
}

function calcularElo(ids, exp, res, ronda, eloMap, jugados, partidoId, torneoId, fecha) {
  const historial = [];
  for (const id of ids) {
    const s  = id.toString();
    const k  = RONDAS_FIN.has(ronda) ? K_FINAL : jugados[s] >= UMBRAL_VET ? K_VET : K_NORMAL;
    const nu = Math.round(eloMap[s] + k * (res - exp));
    const entry = { jugadorId: id, eloAnterior: eloMap[s], eloNuevo: nu, delta: nu - eloMap[s], partidoId, fecha, ronda };
    if (torneoId) entry.torneoId = torneoId;
    historial.push(entry);
    eloMap[s] = nu;
    jugados[s]++;
  }
  return historial;
}

async function actualizarElosDB(eloMap) {
  for (const [s, elo] of Object.entries(eloMap))
    await db.collection("jugadores").updateOne({ _id: new ObjectId(s) }, { $set: { eloActual: elo } });
}

// ── Helper: resolver nombres de un array de IDs ──────────────────────────────
async function resolverNombres(ids) {
  if (!ids || !ids.length) return [];
  const jugadores = await db.collection("jugadores")
    .find({ _id: { $in: ids.map(id => typeof id === "string" ? new ObjectId(id) : id) } })
    .toArray();
  const map = {};
  for (const j of jugadores) map[j._id.toString()] = j.nombre;
  return ids.map(id => map[(typeof id === "string" ? id : id.toString())] || "Desconocido");
}

// ── API: JUGADORES ────────────────────────────────────────────────────────────
app.get("/api/jugadores", async (req, res) => {
  try {
    const data = await db.collection("jugadores")
      .find({}, { projection: { nombre: 1, eloActual: 1 } })
      .sort({ nombre: 1 }).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: STATS ─────────────────────────────────────────────────────────────────
app.get("/api/stats/elo", async (req, res) => {
  try {
    const data = await db.collection("jugadores")
      .find({}, { projection: { nombre: 1, eloActual: 1 } })
      .sort({ eloActual: -1 }).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/stats/winrate", async (req, res) => {
  try {
    const data = await db.collection("partidos").aggregate([
      { $addFields: {
          todos: { $setUnion: ["$equipoA", "$equipoB"] }
      }},
      { $unwind: "$todos" },
      { $addFields: {
          gano: { $in: ["$todos", "$equipoGanador"] }
      }},
      { $group: {
          _id: "$todos",
          partidos: { $sum: 1 },
          victorias: { $sum: { $cond: ["$gano", 1, 0] } }
      }},
      { $addFields: {
          derrotas: { $subtract: ["$partidos", "$victorias"] },
          winRate: { $round: [{ $multiply: [{ $divide: ["$victorias", "$partidos"] }, 100] }, 1] }
      }},
      { $lookup: { from: "jugadores", localField: "_id", foreignField: "_id", as: "j" } },
      { $unwind: "$j" },
      { $project: { nombre: "$j.nombre", partidos: 1, victorias: 1, derrotas: 1, winRate: 1 } },
      { $sort: { winRate: -1 } },
    ]).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/stats/parejas", async (req, res) => {
  try {
    const data = await db.collection("partidos").aggregate([
      // Para cada partido, crear dos entradas: una por equipoA y una por equipoB
      { $project: {
          equipos: [
            { jugadores: "$equipoA", gano: { $eq: ["$equipoA", "$equipoGanador"] } },
            { jugadores: "$equipoB", gano: { $eq: ["$equipoB", "$equipoGanador"] } }
          ]
      }},
      { $unwind: "$equipos" },
      // Solo parejas (2 jugadores)
      { $match: { "equipos.jugadores.1": { $exists: true }, "equipos.jugadores.2": { $exists: false } } },
      { $addFields: {
          pareja: { $cond: [
            { $lt: [{ $arrayElemAt: ["$equipos.jugadores", 0] }, { $arrayElemAt: ["$equipos.jugadores", 1] }] },
            "$equipos.jugadores",
            [{ $arrayElemAt: ["$equipos.jugadores", 1] }, { $arrayElemAt: ["$equipos.jugadores", 0] }]
          ]},
          gano: "$equipos.gano"
      }},
      { $group: { _id: "$pareja", partidos: { $sum: 1 }, victorias: { $sum: { $cond: ["$gano", 1, 0] } } } },
      { $addFields: { winRate: { $round: [{ $multiply: [{ $divide: ["$victorias", "$partidos"] }, 100] }, 1] } } },
      { $lookup: { from: "jugadores", localField: "_id", foreignField: "_id", as: "jugadores" } },
      { $addFields: { nombres: { $map: { input: "$jugadores", as: "j", in: "$$j.nombre" } } } },
      { $sort: { winRate: -1, partidos: -1 } },
      { $limit: 10 },
    ]).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/stats/torneos", async (req, res) => {
  try {
    const data = await db.collection("torneos").aggregate([
      { $sort: { fecha: -1 } },
      { $limit: 10 },
      // Resolver nombres del equipo ganador
      { $lookup: {
          from: "jugadores",
          localField: "equipoGanador",
          foreignField: "_id",
          as: "ganadorInfo"
      }},
      { $addFields: {
          ganadorNombres: { $map: { input: "$ganadorInfo", as: "j", in: "$$j.nombre" } }
      }},
      { $project: {
          nombre: 1, fecha: 1, formato: 1, modalidad: 1,
          ganadorNombres: 1,
          equipoGanador: 1
      }},
    ]).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/stats/finales", async (req, res) => {
  try {
    const data = await db.collection("partidos").aggregate([
      { $match: { ronda: { $in: ["semifinal", "final"] } } },
      { $addFields: {
          todos: { $setUnion: ["$equipoA", "$equipoB"] }
      }},
      { $unwind: "$todos" },
      { $addFields: {
          gano: { $in: ["$todos", "$equipoGanador"] }
      }},
      { $group: {
          _id: "$todos",
          finalesJugadas: { $sum: 1 },
          finalesGanadas: { $sum: { $cond: ["$gano", 1, 0] } }
      }},
      { $addFields: {
          winRate: { $round: [{ $multiply: [{ $divide: ["$finalesGanadas", "$finalesJugadas"] }, 100] }, 1] }
      }},
      { $lookup: { from: "jugadores", localField: "_id", foreignField: "_id", as: "j" } },
      { $unwind: "$j" },
      { $project: { nombre: "$j.nombre", finalesJugadas: 1, finalesGanadas: 1, winRate: 1 } },
      { $sort: { winRate: -1 } },
    ]).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: PARTIDOS RECIENTES ──────────────────────────────────────────────────
app.get("/api/stats/partidos", async (req, res) => {
  try {
    const data = await db.collection("partidos").aggregate([
      { $sort: { fecha: -1 } },
      { $limit: 20 },
      // Resolver nombres de equipoA
      { $lookup: { from: "jugadores", localField: "equipoA", foreignField: "_id", as: "equipoAInfo" } },
      { $lookup: { from: "jugadores", localField: "equipoB", foreignField: "_id", as: "equipoBInfo" } },
      { $lookup: { from: "jugadores", localField: "equipoGanador", foreignField: "_id", as: "ganadorInfo" } },
      { $lookup: { from: "torneos", localField: "torneoId", foreignField: "_id", as: "torneoInfo" } },
      { $addFields: {
          equipoANombres: { $map: { input: "$equipoAInfo", as: "j", in: "$$j.nombre" } },
          equipoBNombres: { $map: { input: "$equipoBInfo", as: "j", in: "$$j.nombre" } },
          ganadorNombres: { $map: { input: "$ganadorInfo", as: "j", in: "$$j.nombre" } },
          torneoNombre: { $arrayElemAt: ["$torneoInfo.nombre", 0] }
      }},
      { $project: {
          fecha: 1, tipoPartido: 1, ronda: 1, torneoId: 1, torneoNombre: 1,
          equipoANombres: 1, equipoBNombres: 1, ganadorNombres: 1,
          eloSnapshot: 1
      }},
    ]).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ENVIAR PENDIENTE ──────────────────────────────────────────────────────────
app.post("/api/pendientes", async (req, res) => {
  try {
    const { tipo, enviadoPor } = req.body;

    if (!tipo || !enviadoPor)
      return res.status(400).json({ error: "Faltan: tipo y enviadoPor" });

    if (tipo === "torneo") {
      const { torneo, partidos } = req.body;
      if (!torneo || !partidos?.length)
        return res.status(400).json({ error: "Faltan torneo o partidos" });
      await db.collection("pendientes").insertOne({
        tipo, torneo, partidos, enviadoPor, estado: "pendiente", fechaEnvio: new Date(),
      });

    } else if (tipo === "partido_suelto") {
      const { fecha, modalidad, equipoA, equipoB, equipoGanador } = req.body;
      if (!fecha || !modalidad || !equipoA?.length || !equipoB?.length || !equipoGanador?.length)
        return res.status(400).json({ error: "Partido incompleto: faltan fecha, modalidad, equipoA, equipoB o equipoGanador" });
      await db.collection("pendientes").insertOne({
        tipo, enviadoPor, fecha, modalidad, equipoA, equipoB, equipoGanador,
        estado: "pendiente", fechaEnvio: new Date(),
      });

    } else {
      return res.status(400).json({ error: "Tipo desconocido: " + tipo });
    }

    res.json({ ok: true, mensaje: "Enviado. Marco lo revisará." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: LISTAR PENDIENTES ──────────────────────────────────────────────────
app.get("/api/admin/pendientes", adminAuth, async (req, res) => {
  try {
    const data = await db.collection("pendientes")
      .find({ estado: "pendiente" }).sort({ fechaEnvio: -1 }).toArray();

    // Resolver nombres de jugadores para mostrar en admin
    const allSlots = new Set();
    for (const p of data) {
      if (p.tipo === "torneo") {
        for (const eq of (p.torneo?.equipos || [])) {
          for (const s of eq) if (s && !s.startsWith("NEW:")) allSlots.add(s);
        }
        for (const s of (p.torneo?.ganador || [])) if (s && !s.startsWith("NEW:")) allSlots.add(s);
        for (const partido of (p.partidos || [])) {
          for (const s of partido.equipoA) if (s && !s.startsWith("NEW:")) allSlots.add(s);
          for (const s of partido.equipoB) if (s && !s.startsWith("NEW:")) allSlots.add(s);
        }
      } else {
        for (const s of (p.equipoA || [])) if (s && !s.startsWith("NEW:")) allSlots.add(s);
        for (const s of (p.equipoB || [])) if (s && !s.startsWith("NEW:")) allSlots.add(s);
        for (const s of (p.equipoGanador || [])) if (s && !s.startsWith("NEW:")) allSlots.add(s);
      }
    }

    // Lookup nombres
    const ids = [...allSlots].filter(s => /^[a-f\d]{24}$/i.test(s)).map(s => new ObjectId(s));
    const jugadores = ids.length
      ? await db.collection("jugadores").find({ _id: { $in: ids } }).toArray()
      : [];
    const nombreMap = {};
    for (const j of jugadores) nombreMap[j._id.toString()] = j.nombre;

    // Agregar nombreMap a la respuesta
    res.json({ pendientes: data, nombreMap });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: RECHAZAR ───────────────────────────────────────────────────────────
app.post("/api/admin/rechazar/:id", adminAuth, async (req, res) => {
  try {
    await db.collection("pendientes").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { estado: "rechazado", fechaResolucion: new Date() } }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: APROBAR ────────────────────────────────────────────────────────────
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: LIMPIAR PROCESADOS ─────────────────────────────────────────────────
app.delete("/api/admin/pendientes/procesados", adminAuth, async (req, res) => {
  try {
    const r = await db.collection("pendientes").deleteMany({
      estado: { $in: ["aprobado", "rechazado"] },
    });
    res.json({ ok: true, borrados: r.deletedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PROCESAR: PARTIDO SUELTO ──────────────────────────────────────────────────
async function procesarPartidoSuelto(p) {
  const { equipoA: slotsA, equipoB: slotsB, equipoGanador: slotsGanador, fecha } = p;

  const idMap  = await resolverSlots([...slotsA, ...slotsB]);
  const eqA    = slotsA.map(s => idMap[s]);
  const eqB    = slotsB.map(s => idMap[s]);
  const eqGanador = slotsGanador.map(s => idMap[s]);

  const { eloMap, jugados } = await obtenerElos([...eqA, ...eqB]);

  const avgA = eqA.reduce((s, id) => s + eloMap[id.toString()], 0) / eqA.length;
  const avgB = eqB.reduce((s, id) => s + eloMap[id.toString()], 0) / eqB.length;
  const expA = eloEsperado(avgA, avgB);

  // Determinar si ganó A o B comparando los IDs
  const ganadorEsA = eqGanador.every(id => eqA.some(a => a.toString() === id.toString()));
  const resA = ganadorEsA ? 1 : 0;
  const fec  = new Date(fecha);

  const pid = new ObjectId();
  await db.collection("partidos").insertOne({
    _id: pid, fecha: fec,
    tipoPartido: "partido_suelto",
    ronda: "partido_suelto",
    equipoA: eqA, equipoB: eqB,
    equipoGanador: eqGanador,
    eloSnapshot: { promedioA: Math.round(avgA), promedioB: Math.round(avgB) },
  });

  const hist = [
    ...calcularElo(eqA, expA,     resA,     "partido_suelto", eloMap, jugados, pid, null, fec),
    ...calcularElo(eqB, 1 - expA, 1 - resA, "partido_suelto", eloMap, jugados, pid, null, fec),
  ];
  if (hist.length) await db.collection("elo_historial").insertMany(hist);
  await actualizarElosDB(eloMap);
}

// ── PROCESAR: TORNEO ──────────────────────────────────────────────────────────
async function procesarTorneo(pendiente) {
  const { torneo, partidos } = pendiente;

  const todosSlots = [...new Set([
    ...torneo.equipos.flat(),
    ...(torneo.ganador || []),
    ...partidos.flatMap(p => [...p.equipoA, ...p.equipoB, ...(p.equipoGanador || [])]),
  ])];

  const idMap       = await resolverSlots(todosSlots);
  const resEquipo   = eq => eq.map(s => idMap[s]);
  const todosIds    = Object.values(idMap);
  const { eloMap, jugados } = await obtenerElos(todosIds);

  const torneoId = new ObjectId();
  await db.collection("torneos").insertOne({
    _id: torneoId,
    nombre:    torneo.nombre,
    fecha:     new Date(torneo.fecha),
    formato:   torneo.formato,
    modalidad: torneo.modalidad,
    estado:    "finalizado",
    equipos:   torneo.equipos.map(resEquipo),
    equipoGanador: (torneo.ganador ?? []).map(s => idMap[s]),
  });

  for (const p of partidos) {
    const eqA  = resEquipo(p.equipoA);
    const eqB  = resEquipo(p.equipoB);
    const eqGanador = (p.equipoGanador || []).map(s => idMap[s]);

    const avgA = eqA.reduce((s, id) => s + eloMap[id.toString()], 0) / eqA.length;
    const avgB = eqB.reduce((s, id) => s + eloMap[id.toString()], 0) / eqB.length;
    const expA = eloEsperado(avgA, avgB);

    // Determinar si ganó A o B
    const ganadorEsA = eqGanador.every(id => eqA.some(a => a.toString() === id.toString()));
    const resA = ganadorEsA ? 1 : 0;
    const fec  = new Date(torneo.fecha);

    // Determinar tipoPartido
    const esRondaFinal = RONDAS_FIN.has(p.ronda);
    const tipoPartido = p.ronda === "final" ? "final" : "torneo";

    const pid = new ObjectId();
    await db.collection("partidos").insertOne({
      _id: pid, torneoId, fecha: fec,
      tipoPartido,
      ronda: p.ronda,
      equipoA: eqA, equipoB: eqB,
      equipoGanador: eqGanador,
      eloSnapshot: { promedioA: Math.round(avgA), promedioB: Math.round(avgB) },
    });

    const hist = [
      ...calcularElo(eqA, expA,     resA,     p.ronda, eloMap, jugados, pid, torneoId, fec),
      ...calcularElo(eqB, 1 - expA, 1 - resA, p.ronda, eloMap, jugados, pid, torneoId, fec),
    ];
    await db.collection("elo_historial").insertMany(hist);
  }

  await actualizarElosDB(eloMap);
}

// ── ARRANQUE ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
conectarConReintento();
