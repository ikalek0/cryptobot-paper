// ─── DATABASE MODULE ─────────────────────────────────────────────────────────
// Usa PostgreSQL si está disponible (Railway), sino guarda en disco (local).
// Circuit breaker: si PG falla una vez (DNS, timeout, conexión cerrada), queda
// DESACTIVADO hasta el próximo restart — evita spam de reintentos en el log.
"use strict";

const fs   = require("fs");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL || "";
const STATE_FILE   = path.join(__dirname, "../data/state.json");
const BAK_FILE     = STATE_FILE + ".bak";
const TMP_FILE     = STATE_FILE + ".tmp";

// ── Escritura atómica ────────────────────────────────────────────────────────
// Pipeline: write(tmp) → fsync → close → rotate(original→bak) → rename(tmp→original)
// Si kill -9 cae en cualquier punto: o bien state.json queda íntegro (write
// anterior) o bien state.json.bak contiene la versión previa válida.
function atomicWriteFile(filePath, data) {
  const tmpPath = filePath + ".tmp";
  const bakPath = filePath + ".bak";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  if (fs.existsSync(filePath)) {
    fs.renameSync(filePath, bakPath);
  }
  fs.renameSync(tmpPath, filePath);
}

// Intenta parsear un JSON desde disco. Devuelve null si falla (con warning).
function tryReadJson(filePath, label) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[DB] ${label} corrupto o ilegible: ${e.message}`);
    return null;
  }
}

// Hosts conocidos como muertos: bail out sin esperar al timeout de DNS
const DEAD_HOSTS = ["railway.internal", "railway.app"];

// ── PostgreSQL client (lazy load + circuit breaker) ──────────────────────────
let pgClient        = null;
let pgDisabled      = false; // true tras el primer fallo — no reintentar
let pgMessageLogged = false; // garantiza que el aviso sólo se loguea una vez

function disablePg(reason) {
  pgDisabled = true;
  pgClient = null;
  if (!pgMessageLogged) {
    console.log(`[DB] PostgreSQL desactivado — usando disco. Motivo: ${reason}`);
    pgMessageLogged = true;
  }
}

async function getClient() {
  if (pgDisabled) return null;
  if (pgClient)   return pgClient;

  if (!DATABASE_URL) {
    disablePg("DATABASE_URL no configurada");
    return null;
  }
  if (DEAD_HOSTS.some(h => DATABASE_URL.includes(h))) {
    disablePg("DATABASE_URL apunta a host abandonado (Railway)");
    return null;
  }

  try {
    const { Client } = require("pg");
    pgClient = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pgClient.connect();
    // Crear tabla si no existe
    await pgClient.query(`
      CREATE TABLE IF NOT EXISTS bot_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        ts    TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("[DB] PostgreSQL conectado ✓");
    return pgClient;
  } catch(e) {
    disablePg(`connect falló: ${e.message}`);
    return null;
  }
}

// ── SAVE ─────────────────────────────────────────────────────────────────────
async function saveState(state) {
  const json = JSON.stringify(state);
  try {
    const client = await getClient();
    if (client) {
      await client.query(
        `INSERT INTO bot_state (key, value, ts) VALUES ('paper_main', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, ts = NOW()`,
        [json]
      );
      return;
    }
  } catch(e) {
    disablePg(`saveState query falló: ${e.message}`);
  }
  // Fallback a disco con escritura atómica + rotación de .bak
  atomicWriteFile(STATE_FILE, json);
}

// ── LOAD ─────────────────────────────────────────────────────────────────────
async function loadState() {
  try {
    const client = await getClient();
    if (client) {
      const res = await client.query(`SELECT value FROM bot_state WHERE key = 'paper_main'`);
      if (res.rows.length > 0) {
        console.log("[DB] Estado cargado desde PostgreSQL ✓");
        return JSON.parse(res.rows[0].value);
      }
    }
  } catch(e) {
    disablePg(`loadState query falló: ${e.message}`);
  }
  // Fallback a disco con recuperación desde .bak si el principal está corrupto
  const primary = tryReadJson(STATE_FILE, "state.json");
  if (primary) {
    console.log("[DB] Estado cargado desde disco ✓");
    return primary;
  }
  if (fs.existsSync(STATE_FILE)) {
    // existe pero corrupto → intentar .bak
    const bak = tryReadJson(BAK_FILE, "state.json.bak");
    if (bak) {
      console.warn("[DB] state.json corrupto, cargando desde state.json.bak ✓");
      return bak;
    }
    console.error("[DB] state.json y state.json.bak ambos ilegibles — arranque limpio");
    return null;
  }
  // principal no existe: probar bak por si crash dejó sólo .bak
  const bakOnly = tryReadJson(BAK_FILE, "state.json.bak");
  if (bakOnly) {
    console.warn("[DB] state.json ausente, cargando desde state.json.bak ✓");
    return bakOnly;
  }
  return null;
}

// ── DELETE ────────────────────────────────────────────────────────────────────
async function deleteState() {
  try {
    const client = await getClient();
    if (client) await client.query(`DELETE FROM bot_state WHERE key = 'paper_main'`);
  } catch(e) { disablePg(`deleteState query falló: ${e.message}`); }
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  if (fs.existsSync(BAK_FILE))   fs.unlinkSync(BAK_FILE);
  if (fs.existsSync(TMP_FILE))   fs.unlinkSync(TMP_FILE);
}

module.exports = { saveState, loadState, deleteState };
