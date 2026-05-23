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

// ── FILTRO DE MODALIDAD ───────────────────────────────────────────────────────
// Modalidad derivada por tamano de equipo (1=individual, 2=2v2, 3=3v3)
function modalidadFilter(req) {
  const m = req.query.modalidad;
  const sizeMap = { individual: 1, "2v2": 2, "3v3": 3 };
  if (!m || !sizeMap[m]) return null;
  return { $expr: { $eq: [{ $size: "$equipoA" }, sizeMap[m]] } };
}

// ── VALIDACIONES JUGADOR ─────────────────────────────────────────────────────
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function validarUsername(u) {
  if (typeof u !== "string" || !USERNAME_RE.test(u))
    throw new Error(`Username inválido: "${u}". Debe ser 3-20 caracteres alfanuméricos o "_".`);
}
function validarNombreCompleto(n) {
  if (typeof n !== "string" || n.trim().length < 2 || n.trim().length > 60)
    throw new Error(`Nombre completo inválido: "${n}". Debe tener entre 2 y 60 caracteres.`);
}

// Parsea un slot "NEW:username|Nombre Completo" o legacy "NEW:nombre"
function parsearSlotNuevo(slot) {
  const payload = slot.slice(4);
  let username, nombreCompleto;
  if (payload.includes("|")) {
    [username, nombreCompleto] = payload.split("|").map(s => (s ?? "").trim());
  } else {
    username = nombreCompleto = payload.trim();
  }
  validarUsername(username);
  validarNombreCompleto(nombreCompleto);
  return { username, nombreCompleto };
}

// Para validar formato en POST /api/pendientes (no toca la DB)
function validarSlotsParaPendiente(slots) {
  for (const slot of slots) {
    if (typeof slot !== "string") throw new Error("Slot inválido (no es string).");
    if (slot.startsWith("NEW:")) parsearSlotNuevo(slot);
    else if (!/^[a-f\d]{24}$/i.test(slot)) throw new Error(`Slot "${slot}" no es ObjectId válido.`);
  }
}

// ── HELPERS DE SLOT ───────────────────────────────────────────────────────────
async function resolverSlots(slots, ctx = {}) {
  const idMap  = {};
  const unicos = [...new Set(slots.filter(Boolean))];
  for (const slot of unicos) {
    if (typeof slot !== "string")
      throw new Error(`Slot inválido (no es string): ${JSON.stringify(slot)}`);
    if (slot.startsWith("NEW:")) {
      const { username, nombreCompleto } = parsearSlotNuevo(slot);
      const existe = await db.collection("jugadores").findOne({
        usernameLower: username.toLowerCase(),
      });
      if (existe) {
        idMap[slot] = existe._id;
      } else {
        const id = new ObjectId();
        const ahora = new Date();
        const doc = {
          _id: id,
          username,
          usernameLower: username.toLowerCase(),
          nombreCompleto,
          eloActual: 1200,
          activo: true,
          fechaRegistro: ahora,
          creadoPor: ctx.enviadoPor ?? null,
          origen: {
            tipo: ctx.tipo ?? null,
            pendienteId: ctx.pendienteId ?? null,
            fechaAprobacion: ahora,
          },
        };
        try {
          await db.collection("jugadores").insertOne(doc);
        } catch (e) {
          // Carrera contra el índice único: alguien creó el username entre el findOne y el insert
          if (e.code === 11000) {
            const fallback = await db.collection("jugadores").findOne({ usernameLower: username.toLowerCase() });
            if (!fallback) throw e;
            idMap[slot] = fallback._id;
            continue;
          }
          throw e;
        }
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

// ── Helper: resolver display de un array de IDs ──────────────────────────────
async function resolverNombres(ids) {
  if (!ids || !ids.length) return [];
  const jugadores = await db.collection("jugadores")
    .find({ _id: { $in: ids.map(id => typeof id === "string" ? new ObjectId(id) : id) } })
    .toArray();
  const map = {};
  for (const j of jugadores) map[j._id.toString()] = j.username;
  return ids.map(id => map[(typeof id === "string" ? id : id.toString())] || "Desconocido");
}

// ── API: JUGADORES ────────────────────────────────────────────────────────────
app.get("/api/jugadores", async (req, res) => {
  try {
    const data = await db.collection("jugadores")
      .find({}, { projection: { username: 1, nombreCompleto: 1, eloActual: 1 } })
      .sort({ username: 1 }).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: STATS ─────────────────────────────────────────────────────────────────
app.get("/api/stats/elo", async (req, res) => {
  try {
    const data = await db.collection("jugadores")
      .find({}, { projection: { username: 1, nombreCompleto: 1, eloActual: 1 } })
      .sort({ eloActual: -1 }).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/stats/winrate", async (req, res) => {
  try {
    const filter = modalidadFilter(req);
    const data = await db.collection("partidos").aggregate([
      ...(filter ? [{ $match: filter }] : []),
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
      { $project: { username: "$j.username", nombreCompleto: "$j.nombreCompleto", partidos: 1, victorias: 1, derrotas: 1, winRate: 1 } },
      { $sort: { winRate: -1 } },
    ]).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/stats/parejas", async (req, res) => {
  try {
    const filter = modalidadFilter(req);
    const data = await db.collection("partidos").aggregate([
      ...(filter ? [{ $match: filter }] : []),
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
      { $addFields: {
          usernames:        { $map: { input: "$jugadores", as: "j", in: "$$j.username" } },
          nombresCompletos: { $map: { input: "$jugadores", as: "j", in: "$$j.nombreCompleto" } },
      } },
      { $project: { jugadores: 0 } },
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
          ganadorUsernames:        { $map: { input: "$ganadorInfo", as: "j", in: "$$j.username" } },
          ganadorNombresCompletos: { $map: { input: "$ganadorInfo", as: "j", in: "$$j.nombreCompleto" } },
      }},
      { $project: {
          nombre: 1, fecha: 1, formato: 1, modalidad: 1,
          ganadorUsernames: 1, ganadorNombresCompletos: 1,
          equipoGanador: 1
      }},
    ]).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/stats/finales", async (req, res) => {
  try {
    const filter = modalidadFilter(req);
    const data = await db.collection("partidos").aggregate([
      ...(filter ? [{ $match: filter }] : []),
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
      { $project: { username: "$j.username", nombreCompleto: "$j.nombreCompleto", finalesJugadas: 1, finalesGanadas: 1, winRate: 1 } },
      { $sort: { winRate: -1 } },
    ]).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: PEOR ENEMIGO ─────────────────────────────────────────────────────────
// Pares (A, B) donde A le gana a B >75% en >=2 enfrentamientos
app.get("/api/stats/peor-enemigo", async (req, res) => {
  try {
    const filter = modalidadFilter(req);
    const data = await db.collection("partidos").aggregate([
      ...(filter ? [{ $match: filter }] : []),
      // Determinar equipo perdedor: si todos los ganadores estan en equipoA, perdio B; si no, perdio A
      { $addFields: {
          loserTeam: {
            $cond: [
              { $eq: [{ $size: { $setDifference: ["$equipoGanador", "$equipoA"] } }, 0] },
              "$equipoB",
              "$equipoA"
            ]
          }
      }},
      // Generar pares (ganador, perdedor) en ambas direcciones
      { $project: {
          winPairs: {
            $reduce: {
              input: "$equipoGanador",
              initialValue: [],
              in: { $concatArrays: [
                "$$value",
                { $map: { input: "$loserTeam", as: "L", in: { a: "$$this", b: "$$L", aGano: true } } }
              ]}
            }
          },
          losePairs: {
            $reduce: {
              input: "$loserTeam",
              initialValue: [],
              in: { $concatArrays: [
                "$$value",
                { $map: { input: "$equipoGanador", as: "W", in: { a: "$$this", b: "$$W", aGano: false } } }
              ]}
            }
          }
      }},
      { $project: { allPairs: { $concatArrays: ["$winPairs", "$losePairs"] } } },
      { $unwind: "$allPairs" },
      { $group: {
          _id: { a: "$allPairs.a", b: "$allPairs.b" },
          partidos:  { $sum: 1 },
          victorias: { $sum: { $cond: ["$allPairs.aGano", 1, 0] } }
      }},
      { $match: { partidos: { $gte: 2 } } },
      { $addFields: {
          winRate: { $round: [{ $multiply: [{ $divide: ["$victorias", "$partidos"] }, 100] }, 1] }
      }},
      { $match: { winRate: { $gt: 75 } } },
      { $lookup: { from: "jugadores", localField: "_id.a", foreignField: "_id", as: "cazador" } },
      { $lookup: { from: "jugadores", localField: "_id.b", foreignField: "_id", as: "victima" } },
      { $unwind: "$cazador" },
      { $unwind: "$victima" },
      { $project: {
          _id: 0,
          cazadorId:              "$cazador._id",
          cazadorUsername:        "$cazador.username",
          cazadorNombreCompleto:  "$cazador.nombreCompleto",
          victimaId:              "$victima._id",
          victimaUsername:        "$victima.username",
          victimaNombreCompleto:  "$victima.nombreCompleto",
          partidos: 1, victorias: 1, winRate: 1
      }},
      { $sort: { winRate: -1, partidos: -1 } },
      { $limit: 30 },
    ]).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: PARTIDOS RECIENTES ──────────────────────────────────────────────────
app.get("/api/stats/partidos", async (req, res) => {
  try {
    const filter = modalidadFilter(req);
    const data = await db.collection("partidos").aggregate([
      ...(filter ? [{ $match: filter }] : []),
      { $sort: { fecha: -1 } },
      { $limit: 20 },
      // Resolver nombres de equipoA
      { $lookup: { from: "jugadores", localField: "equipoA", foreignField: "_id", as: "equipoAInfo" } },
      { $lookup: { from: "jugadores", localField: "equipoB", foreignField: "_id", as: "equipoBInfo" } },
      { $lookup: { from: "jugadores", localField: "equipoGanador", foreignField: "_id", as: "ganadorInfo" } },
      { $lookup: { from: "torneos", localField: "torneoId", foreignField: "_id", as: "torneoInfo" } },
      { $addFields: {
          equipoAUsernames:        { $map: { input: "$equipoAInfo", as: "j", in: "$$j.username" } },
          equipoBUsernames:        { $map: { input: "$equipoBInfo", as: "j", in: "$$j.username" } },
          ganadorUsernames:        { $map: { input: "$ganadorInfo", as: "j", in: "$$j.username" } },
          equipoANombresCompletos: { $map: { input: "$equipoAInfo", as: "j", in: "$$j.nombreCompleto" } },
          equipoBNombresCompletos: { $map: { input: "$equipoBInfo", as: "j", in: "$$j.nombreCompleto" } },
          ganadorNombresCompletos: { $map: { input: "$ganadorInfo", as: "j", in: "$$j.nombreCompleto" } },
          torneoNombre: { $arrayElemAt: ["$torneoInfo.nombre", 0] }
      }},
      { $project: {
          fecha: 1, tipoPartido: 1, ronda: 1, torneoId: 1, torneoNombre: 1,
          equipoAUsernames: 1, equipoBUsernames: 1, ganadorUsernames: 1,
          equipoANombresCompletos: 1, equipoBNombresCompletos: 1, ganadorNombresCompletos: 1,
          eloSnapshot: 1
      }},
    ]).toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: RACHAS ───────────────────────────────────────────────────────────────
// Para cada jugador devuelve racha actual (length + W/L), max ganadas, max perdidas
app.get("/api/stats/rachas", async (req, res) => {
  try {
    const filter = modalidadFilter(req);
    const partidos = await db.collection("partidos")
      .find(filter ? filter : {})
      .sort({ fecha: 1 })
      .toArray();

    const porJugador = {};
    for (const p of partidos) {
      const ganadores = new Set(p.equipoGanador.map(id => id.toString()));
      const todos = [...p.equipoA, ...p.equipoB];
      for (const id of todos) {
        const k = id.toString();
        (porJugador[k] ??= []).push({ fecha: p.fecha, gano: ganadores.has(k) });
      }
    }

    const ids = Object.keys(porJugador).map(s => new ObjectId(s));
    const jugadores = await db.collection("jugadores")
      .find({ _id: { $in: ids } }, { projection: { username: 1, nombreCompleto: 1, eloActual: 1 } })
      .toArray();
    const jMap = {};
    for (const j of jugadores) jMap[j._id.toString()] = j;

    const result = [];
    for (const [jid, evs] of Object.entries(porJugador)) {
      evs.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
      const ultimo = evs[evs.length - 1];

      // Racha actual: consecutivos al final con mismo resultado
      let actualLen = 0;
      for (let i = evs.length - 1; i >= 0; i--) {
        if (evs[i].gano === ultimo.gano) actualLen++;
        else break;
      }

      // Maxima racha de ganadas y de perdidas en toda la historia
      let maxWin = 0, maxLose = 0, curWin = 0, curLose = 0;
      for (const e of evs) {
        if (e.gano) { curWin++; curLose = 0; if (curWin > maxWin) maxWin = curWin; }
        else        { curLose++; curWin = 0; if (curLose > maxLose) maxLose = curLose; }
      }

      const j = jMap[jid];
      if (!j) continue;
      result.push({
        jugadorId: jid,
        username: j.username,
        nombreCompleto: j.nombreCompleto,
        eloActual: j.eloActual,
        actualLen,
        actualGano: ultimo.gano,
        maxWin,
        maxLose,
        totalPartidos: evs.length,
      });
    }

    // Ordenar: rachas ganadoras primero (largas arriba), luego perdedoras (cortas arriba)
    result.sort((a, b) => {
      if (a.actualGano !== b.actualGano) return a.actualGano ? -1 : 1;
      if (a.actualGano) return b.actualLen - a.actualLen;
      return a.actualLen - b.actualLen;
    });

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: HEAD-TO-HEAD ─────────────────────────────────────────────────────────
// Historial detallado entre dos jugadores (en equipos opuestos)
app.get("/api/stats/h2h", async (req, res) => {
  try {
    const { a, b } = req.query;
    if (!a || !b) return res.status(400).json({ error: "Faltan params a, b" });
    if (!/^[a-f\d]{24}$/i.test(a) || !/^[a-f\d]{24}$/i.test(b))
      return res.status(400).json({ error: "IDs invalidos" });
    if (a === b) return res.status(400).json({ error: "a y b deben ser distintos" });

    const idA = new ObjectId(a);
    const idB = new ObjectId(b);

    const partidos = await db.collection("partidos").aggregate([
      { $match: {
          $or: [
            { equipoA: idA, equipoB: idB },
            { equipoA: idB, equipoB: idA },
          ]
      }},
      { $sort: { fecha: -1 } },
      { $lookup: { from: "jugadores", localField: "equipoA", foreignField: "_id", as: "eqAInfo" } },
      { $lookup: { from: "jugadores", localField: "equipoB", foreignField: "_id", as: "eqBInfo" } },
      { $lookup: { from: "torneos", localField: "torneoId", foreignField: "_id", as: "torneoInfo" } },
      { $addFields: {
          equipoAUsernames: { $map: { input: "$eqAInfo", as: "j", in: "$$j.username" } },
          equipoBUsernames: { $map: { input: "$eqBInfo", as: "j", in: "$$j.username" } },
          torneoNombre:     { $arrayElemAt: ["$torneoInfo.nombre", 0] },
          aGano:            { $in: [idA, "$equipoGanador"] },
      }},
      { $project: {
          fecha: 1, ronda: 1, tipoPartido: 1, torneoNombre: 1,
          equipoAUsernames: 1, equipoBUsernames: 1, aGano: 1,
          eloSnapshot: 1,
      }}
    ]).toArray();

    const aWins = partidos.filter(p => p.aGano).length;
    const bWins = partidos.length - aWins;

    const [jugA, jugB] = await Promise.all([
      db.collection("jugadores").findOne({ _id: idA }, { projection: { username: 1, nombreCompleto: 1, eloActual: 1 } }),
      db.collection("jugadores").findOne({ _id: idB }, { projection: { username: 1, nombreCompleto: 1, eloActual: 1 } }),
    ]);

    res.json({
      a: { id: a, ...jugA, wins: aWins },
      b: { id: b, ...jugB, wins: bWins },
      total: partidos.length,
      partidos,
    });
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

      // Validar todos los slots (NEW: y ObjectId) antes de aceptar el pendiente
      const todosSlots = [
        ...(torneo.equipos || []).flat(),
        ...(torneo.ganador || []),
        ...partidos.flatMap(p => [...(p.equipoA || []), ...(p.equipoB || []), ...(p.equipoGanador || [])]),
      ];
      validarSlotsParaPendiente(todosSlots);

      await db.collection("pendientes").insertOne({
        tipo, torneo, partidos, enviadoPor, estado: "pendiente", fechaEnvio: new Date(),
      });

    } else if (tipo === "partido_suelto") {
      const { fecha, modalidad, equipoA, equipoB, equipoGanador } = req.body;
      if (!fecha || !modalidad || !equipoA?.length || !equipoB?.length || !equipoGanador?.length)
        return res.status(400).json({ error: "Partido incompleto: faltan fecha, modalidad, equipoA, equipoB o equipoGanador" });

      validarSlotsParaPendiente([...equipoA, ...equipoB, ...equipoGanador]);

      await db.collection("pendientes").insertOne({
        tipo, enviadoPor, fecha, modalidad, equipoA, equipoB, equipoGanador,
        estado: "pendiente", fechaEnvio: new Date(),
      });

    } else {
      return res.status(400).json({ error: "Tipo desconocido: " + tipo });
    }

    res.json({ ok: true, mensaje: "Enviado. Marco lo revisará." });
  } catch (e) { res.status(400).json({ error: e.message }); }
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

    // Lookup nombres (devolvemos username + nombreCompleto por cada _id)
    const ids = [...allSlots].filter(s => /^[a-f\d]{24}$/i.test(s)).map(s => new ObjectId(s));
    const jugadores = ids.length
      ? await db.collection("jugadores").find({ _id: { $in: ids } }).toArray()
      : [];
    const nombreMap = {};
    for (const j of jugadores) {
      nombreMap[j._id.toString()] = { username: j.username, nombreCompleto: j.nombreCompleto };
    }

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

// ── ADMIN: JUGADORES (listar y editar) ────────────────────────────────────────
app.get("/api/admin/jugadores", adminAuth, async (req, res) => {
  try {
    const data = await db.collection("jugadores")
      .find({})
      .sort({ usernameLower: 1 })
      .toArray();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/admin/jugadores/:id", adminAuth, async (req, res) => {
  try {
    const { username, nombreCompleto, activo } = req.body;
    const update = {};

    if (username !== undefined) {
      validarUsername(username);
      // Verificar que no choque con otro jugador
      const choque = await db.collection("jugadores").findOne({
        usernameLower: username.toLowerCase(),
        _id: { $ne: new ObjectId(req.params.id) },
      });
      if (choque) return res.status(409).json({ error: `Username "${username}" ya lo usa otro jugador.` });
      update.username = username;
      update.usernameLower = username.toLowerCase();
    }
    if (nombreCompleto !== undefined) {
      validarNombreCompleto(nombreCompleto);
      update.nombreCompleto = nombreCompleto;
    }
    if (activo !== undefined) update.activo = !!activo;

    if (!Object.keys(update).length)
      return res.status(400).json({ error: "Nada para actualizar." });

    const r = await db.collection("jugadores").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: update }
    );
    if (r.matchedCount === 0) return res.status(404).json({ error: "Jugador no encontrado." });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
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

  const ctx = { enviadoPor: p.enviadoPor, pendienteId: p._id, tipo: "partido_suelto" };
  const idMap  = await resolverSlots([...slotsA, ...slotsB], ctx);
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

  const ctx = { enviadoPor: pendiente.enviadoPor, pendienteId: pendiente._id, tipo: "torneo" };
  const idMap       = await resolverSlots(todosSlots, ctx);
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
