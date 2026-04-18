#!/usr/bin/env node
// ── COLD-START SEED GENERATOR ────────────────────────────────────────────────
// Descarga 2500 velas 1h de 6 pares desde Binance (endpoint público, sin API
// key), simula Q-learning y detecta patrones candlestick básicos, y deja un
// seed en data/cold-start-seed.json para que un paper bot arranque "caliente".
//
// Uso:  node scripts/cold-start.js
// Output: data/cold-start-seed.json con shape compatible con CryptoBotFinal:
//   { learningData: { qLearning: {...}, patternMemory: {...} }, meta... }
"use strict";

const fs    = require("fs");
const path  = require("path");
const https = require("https");

const PAIRS       = ["BTCUSDC","ETHUSDC","SOLUSDC","BNBUSDC","XRPUSDC","ATOMUSDC"];
const INTERVAL    = "1h";
const N_CANDLES   = 2500;
const BINANCE_MAX = 1000; // hard cap del endpoint
const OUT_FILE    = path.join(__dirname, "..", "data", "cold-start-seed.json");

const Q_ALPHA     = 0.1;
const Q_GAMMA     = 0.95;
const OUTCOME_WIN = 5;   // velas hacia delante para medir outcome Q-learning
const PATTERN_WIN = 3;   // velas hacia delante para outcome de patrones

// ── HTTP GET con retry ───────────────────────────────────────────────────────
function httpGetJson(url, attempt = 1) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "cryptobot-paper-cold-start/1.0" } }, res => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error(`JSON parse fail: ${e.message}, body=${buf.slice(0,200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
  }).catch(async e => {
    if (attempt < 3) {
      const delay = 1000 * attempt;
      console.warn(`[FETCH] intento ${attempt} falló (${e.message}); reintentando en ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      return httpGetJson(url, attempt + 1);
    }
    throw e;
  });
}

// ── Download 2500 klines paginando backwards ─────────────────────────────────
async function fetchKlines(symbol) {
  const all = [];
  let endTime = null;
  while (all.length < N_CANDLES) {
    const remaining = N_CANDLES - all.length;
    const limit = Math.min(BINANCE_MAX, remaining);
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&limit=${limit}` +
                (endTime ? `&endTime=${endTime}` : "");
    const batch = await httpGetJson(url);
    if (!Array.isArray(batch) || batch.length === 0) break;
    // batch is ascending by time; prepend and advance endTime to first kline - 1
    all.unshift(...batch);
    endTime = batch[0][0] - 1;
    if (batch.length < limit) break; // no hay más histórico
  }
  // dedup por openTime (por si hubo solape)
  const seen = new Set();
  const dedup = [];
  for (const k of all) {
    if (seen.has(k[0])) continue;
    seen.add(k[0]); dedup.push(k);
  }
  dedup.sort((a,b) => a[0] - b[0]);
  return dedup.slice(-N_CANDLES);
}

// ── Indicadores ──────────────────────────────────────────────────────────────
function ema(arr, p) {
  if (!arr.length) return 0;
  const k = 2 / (p + 1);
  return arr.reduce((prev, cur, i) => i === 0 ? cur : cur * k + prev * (1 - k));
}
function rsi(arr, p = 14) {
  if (arr.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = arr.length - p; i < arr.length; i++) {
    const d = arr[i] - arr[i-1];
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}
function bollinger(arr, p = 20, mult = 2) {
  if (arr.length < p) return null;
  const slice = arr.slice(-p);
  const mid = slice.reduce((a,b) => a + b, 0) / p;
  const sd  = Math.sqrt(slice.reduce((s,v) => s + (v - mid) ** 2, 0) / p);
  return { upper: mid + mult * sd, lower: mid - mult * sd, middle: mid };
}

// ── Bucketizers (alineados con qlearning.js / patternMemory.js) ──────────────
function rsiBin(r) {
  return r < 25 ? 'vs_low' : r < 35 ? 'low' : r < 45 ? 'mid_low' :
         r < 55 ? 'mid'    : r < 65 ? 'mid_high' : r < 75 ? 'high' : 'vs_high';
}
function rsiBucketPattern(r) {
  if (r < 20) return 'oversold_extreme';
  if (r < 30) return 'oversold';
  if (r < 40) return 'below_mid';
  if (r < 60) return 'mid';
  if (r < 70) return 'above_mid';
  return 'overbought';
}
function bbZone(price, bb) {
  if (!bb) return 'unknown';
  if (price < bb.lower)   return 'below_lower';
  if (price < bb.middle)  return 'lower_half';
  if (price < bb.upper)   return 'upper_half';
  return 'above_upper';
}
function regimeFromEma(ema20, ema50) {
  if (ema20 > ema50 * 1.003) return 'BULL';
  if (ema20 < ema50 * 0.997) return 'BEAR';
  return 'LATERAL';
}

// ── Candlestick patterns ─────────────────────────────────────────────────────
function detectPattern(prev, cur) {
  const [/*t*/, open, high, low, close] = cur.map(Number);
  const body     = Math.abs(close - open);
  const range    = high - low || 1e-9;
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;

  // Doji: cuerpo < 10% del rango total
  if (body / range < 0.10) return { name: 'doji', bias: 'BUY' };

  // Hammer: mecha inferior > 2x cuerpo, cuerpo en mitad superior del rango
  if (lowerWick > 2 * body && (Math.min(open, close) - low) / range > 0.5) {
    return { name: 'hammer', bias: 'BUY' };
  }

  if (prev) {
    const pOpen = +prev[1], pClose = +prev[4];
    const prevBearish = pClose < pOpen;
    const prevBullish = pClose > pOpen;
    const curBullish  = close > open;
    const curBearish  = close < open;
    // Bullish engulfing
    if (prevBearish && curBullish && open < pClose && close > pOpen) {
      return { name: 'bullish_engulf', bias: 'BUY' };
    }
    // Bearish engulfing
    if (prevBullish && curBearish && open > pClose && close < pOpen) {
      return { name: 'bearish_engulf', bias: 'SKIP' };
    }
  }
  return null;
}

// ── Q-update Bellman ─────────────────────────────────────────────────────────
function initQState(Q, key) {
  if (!Q[key]) Q[key] = { BUY: 0, HOLD: 0, SKIP: 0 };
}
function qUpdate(Q, state, action, reward, nextState) {
  initQState(Q, state);
  initQState(Q, nextState);
  const maxNextQ = Math.max(...Object.values(Q[nextState]));
  const oldQ = Q[state][action];
  Q[state][action] = oldQ + Q_ALPHA * (reward + Q_GAMMA * maxNextQ - oldQ);
}

// ── Seed builder ─────────────────────────────────────────────────────────────
function stateKey(regime, rsiVal, price, bb) {
  // Shape compatible con QLearning.encodeState() en runtime si trend='neutral',
  // atrBin='normal', volBin='normal_vol', fgBin='' (mercado "neutro").
  return `${regime}|${rsiBin(rsiVal)}|${bbZone(price, bb)}|neutral|normal|normal_vol`;
}

function processKlines(symbol, klines, Q, patterns) {
  if (!klines || klines.length < 100) {
    console.warn(`  ${symbol}: sólo ${klines?.length || 0} velas, saltando`);
    return { qUpdates: 0, patternsDetected: 0 };
  }
  const closes = klines.map(k => +k[4]);
  let qUpdates = 0;
  let patternsDetected = 0;
  if (!patterns[symbol]) patterns[symbol] = {};

  // Ventana mínima: 50 (para EMA50 + BB20) hasta len - 5 (outcome window)
  for (let i = 50; i < klines.length - OUTCOME_WIN; i++) {
    const window = closes.slice(0, i + 1);
    const e20 = ema(window.slice(-50), 20);
    const e50 = ema(window.slice(-100), 50);
    const r   = rsi(window, 14);
    const bb  = bollinger(window, 20);
    if (!bb) continue;

    const price    = closes[i];
    const regime   = regimeFromEma(e20, e50);
    const state    = stateKey(regime, r, price, bb);

    // Outcome 5 velas hacia delante
    const future   = closes[i + OUTCOME_WIN];
    const ratio    = future / price;
    let reward, action;
    if (ratio > 1.015)       { action = 'BUY';  reward = +1.0; }
    else if (ratio < 0.985)  { action = 'SKIP'; reward = +1.0; }
    else                     { action = 'HOLD'; reward = +0.5; }

    // Siguiente estado (vela i+1)
    const nClose  = closes[i + 1];
    const nWin    = closes.slice(0, i + 2);
    const nE20    = ema(nWin.slice(-50), 20);
    const nE50    = ema(nWin.slice(-100), 50);
    const nRsi    = rsi(nWin, 14);
    const nBb     = bollinger(nWin, 20) || bb;
    const nRegime = regimeFromEma(nE20, nE50);
    const nState  = stateKey(nRegime, nRsi, nClose, nBb);

    qUpdate(Q, state, action, reward, nState);
    qUpdates++;

    // ── Patrones candlestick ────────────────────────────────────────────────
    if (i >= 51) {
      const pat = detectPattern(klines[i-1], klines[i]);
      if (pat && i + PATTERN_WIN < klines.length) {
        const outcomePrice = closes[i + PATTERN_WIN];
        const pnlPct = (outcomePrice - price) / price;
        const win = pat.bias === 'BUY' ? pnlPct > 0 : pnlPct < 0;
        const key = `candle_${pat.name}|${regime}`;
        if (!patterns[symbol][key]) patterns[symbol][key] = { wins: 0, losses: 0, totalPnl: 0, count: 0 };
        const p = patterns[symbol][key];
        p.count++;
        p.totalPnl += pnlPct * 100; // pct %
        if (win) p.wins++; else p.losses++;
        patternsDetected++;
      }

      // ── Además seed del formato canónico patternMemory (regime|rsiBucket|bbZone) ──
      // Esto aporta valor al getPatternScore() que consulta el engine en runtime.
      const canonKey = `${regime}|${rsiBucketPattern(r)}|${bbZone(price, bb)}`;
      if (!patterns[symbol][canonKey]) patterns[symbol][canonKey] = { wins: 0, losses: 0, totalPnl: 0, count: 0 };
      const pc = patterns[symbol][canonKey];
      pc.count++;
      pc.totalPnl += ((closes[i + OUTCOME_WIN] - price) / price) * 100;
      if (ratio > 1.0) pc.wins++; else pc.losses++;
    }
  }

  console.log(`  ${symbol}: ${klines.length} velas, ${qUpdates} Q-updates, ${patternsDetected} patrones`);
  return { qUpdates, patternsDetected };
}

async function processPair(symbol, Q, patterns) {
  console.log(`[COLD-START] Fetching ${symbol}…`);
  let klines;
  try { klines = await fetchKlines(symbol); }
  catch (e) { console.error(`  fetch fail ${symbol}: ${e.message}`); return { qUpdates: 0, patternsDetected: 0 }; }
  return processKlines(symbol, klines, Q, patterns);
}

function buildSeed(Q, patterns, extra={}) {
  return {
    generatedAt: new Date().toISOString(),
    nCandles: N_CANDLES,
    nPairs: PAIRS.length,
    pairs: PAIRS,
    interval: INTERVAL,
    source: "binance-klines-public",
    ...extra,
    learningData: {
      qLearning: { Q, epsilon: 0.15, alpha: Q_ALPHA, gamma: Q_GAMMA },
      patternMemory: { patterns, correlations: {}, returnHistory: {} },
    },
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const started = Date.now();
  const Q = {};
  const patterns = {};

  let totalQ = 0, totalP = 0;
  for (const pair of PAIRS) {
    const { qUpdates, patternsDetected } = await processPair(pair, Q, patterns);
    totalQ += qUpdates;
    totalP += patternsDetected;
  }

  const seed = buildSeed(Q, patterns);

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(seed));

  const sz = fs.statSync(OUT_FILE).size;
  const qEntries = Object.keys(Q).length;
  const pSymbols = Object.keys(patterns).length;
  const pTotal   = Object.values(patterns).reduce((s,o) => s + Object.keys(o).length, 0);
  const secs     = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\n[COLD-START] done in ${secs}s`);
  console.log(`  out: ${OUT_FILE}`);
  console.log(`  size: ${sz} bytes`);
  console.log(`  Q-states: ${qEntries}`);
  console.log(`  Q-updates: ${totalQ}`);
  console.log(`  patterns entries: ${pTotal} (across ${pSymbols} symbols)`);
  console.log(`  candlestick detections: ${totalP}`);
}

// Export para tests. Sólo ejecuta main() cuando se llama directamente.
module.exports = {
  processKlines, buildSeed, fetchKlines,
  ema, rsi, bollinger, rsiBin, bbZone, regimeFromEma, detectPattern,
  stateKey, qUpdate, OUT_FILE, PAIRS, N_CANDLES, INTERVAL,
};

if (require.main === module) {
  main().catch(e => { console.error("cold-start FAILED:", e); process.exit(1); });
}
