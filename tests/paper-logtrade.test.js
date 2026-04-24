// BUG-M (24 abr 2026): regresión — logTrade funciona end-to-end con un pool PG.
// Contexto: antes del fix, server.js:377 llamaba _lt(client, ...) con client no
// declarado, silenciado por try/catch → trade_log siempre vacío. Tras el fix,
// server.js obtiene el pool via await getClient() y llama await logTrade(db, e).
// Estos tests cubren directamente logTrade (no server.js) con un pool mock.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { logTrade } = require("../src/trade_logger");

function makeMockPool() {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [] };
    },
  };
}

const sampleEvent = {
  bot: "paper",
  symbol: "BTCUSDT",
  strategy: "DQN",
  openTs: 1777000000000,
  closeTs: 1777000120000,   // 120s = 2 min
  entryPrice: 50000,
  exitPrice: 50500,
  pnlPct: 1.0,
  reason: "target",
  regime: "BULL",
  fearGreed: 60,
  hourUtc: 14,
};

test("BUG-M: logTrade invoca pool.query con INSERT y 20 valores en orden", async () => {
  const pool = makeMockPool();
  await logTrade(pool, sampleEvent);
  assert.equal(pool.calls.length, 1, "query debe invocarse exactamente 1 vez");
  const { sql, values } = pool.calls[0];
  assert.match(sql, /INSERT INTO trade_log/i);
  assert.match(sql, /\$20/, "SQL debe tener 20 placeholders");
  assert.equal(values.length, 20, "array de values debe tener 20 elementos");
  assert.equal(values[0], "paper", "values[0] = bot");
  assert.equal(values[1], "BTCUSDT", "values[1] = symbol");
  assert.equal(values[2], "DQN", "values[2] = strategy");
  assert.equal(values[3], "long", "values[3] = direction default 'long'");
  assert.equal(values[6], 2, "values[6] = duration_min (120s / 60 = 2)");
});

test("BUG-M: logTrade con db=null es no-op silencioso (no throw, no crash)", async () => {
  await assert.doesNotReject(() => logTrade(null, sampleEvent));
});

test("BUG-M: logTrade con db undefined es no-op silencioso", async () => {
  await assert.doesNotReject(() => logTrade(undefined, sampleEvent));
});

test("BUG-M: logTrade captura errores del pool sin propagarlos (resilient)", async () => {
  const failingPool = {
    async query() { throw new Error("conn lost"); },
  };
  // Debe tragarse el error (warning a consola, pero no reject).
  await assert.doesNotReject(() => logTrade(failingPool, sampleEvent));
});

test("BUG-M: duration_min null si falta openTs o closeTs", async () => {
  const pool = makeMockPool();
  const incomplete = { ...sampleEvent, openTs: null };
  await logTrade(pool, incomplete);
  const { values } = pool.calls[0];
  assert.equal(values[6], null, "duration_min debe ser null si openTs es null");
});
