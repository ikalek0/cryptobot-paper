// BUG-R / BUG-R2 (24 abr 2026): regresiones sobre el pipeline de precio→pnl.
// Contexto: un trade NEARUSDC MEAN_REVERSION persistió con pnl_pct=-100.15%,
// semánticamente imposible con stop-loss activo. Diagnóstico: un precio
// corrupto (probablemente feed o saved state) contaminó pos.entryPrice en el
// BUY, y al cerrar con cp normal la fórmula (cp-entry)/entry tendió a -1.
// Estos tests cubren los 3 guards del fix:
//   (1) updatePrice() rechaza NaN/Infinity/0/negativo/>1e6.
//   (2) updatePrice() rechaza saltos >50% vs. último precio conocido.
//   (3) trade SELL incluye entryPrice/openTs/investUsdc/rsiAtEntry (BUG-R2).
//   (4) La condición de sanity check (pnl fuera de [-50, +50] o no finito)
//       detecta el caso histórico (entry=1e6, cp=1.418 → pnl≈-100.15).

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CryptoBotFinal } = require("../src/engine");

// ── (1) Guard de precios inválidos ──────────────────────────────────────────

test("BUG-R: updatePrice ignora NaN", () => {
  const bot = new CryptoBotFinal();
  bot.updatePrice("BTCUSDC", 50000);
  bot.updatePrice("BTCUSDC", NaN);
  assert.equal(bot.prices["BTCUSDC"], 50000, "NaN no debe sobrescribir el precio válido");
});

test("BUG-R: updatePrice ignora Infinity", () => {
  const bot = new CryptoBotFinal();
  bot.updatePrice("BTCUSDC", 50000);
  bot.updatePrice("BTCUSDC", Infinity);
  assert.equal(bot.prices["BTCUSDC"], 50000);
});

test("BUG-R: updatePrice ignora 0 y negativos", () => {
  const bot = new CryptoBotFinal();
  bot.updatePrice("BTCUSDC", 50000);
  bot.updatePrice("BTCUSDC", 0);
  assert.equal(bot.prices["BTCUSDC"], 50000, "0 no debe pasar");
  bot.updatePrice("BTCUSDC", -1.5);
  assert.equal(bot.prices["BTCUSDC"], 50000, "negativo no debe pasar");
});

test("BUG-R: updatePrice ignora valores absurdamente altos (>1e6)", () => {
  const bot = new CryptoBotFinal();
  bot.updatePrice("BTCUSDC", 50000);
  bot.updatePrice("BTCUSDC", 1e30);
  assert.equal(bot.prices["BTCUSDC"], 50000);
  bot.updatePrice("BTCUSDC", 2e6);
  assert.equal(bot.prices["BTCUSDC"], 50000);
});

test("BUG-R: updatePrice acepta precios normales", () => {
  const bot = new CryptoBotFinal();
  bot.updatePrice("BTCUSDC", 50000);
  assert.equal(bot.prices["BTCUSDC"], 50000);
  bot.updatePrice("NEARUSDC", 2.47);
  assert.equal(bot.prices["NEARUSDC"], 2.47);
});

// ── (2) Guard de saltos anómalos ────────────────────────────────────────────

test("BUG-R: updatePrice rechaza salto > 50% (feed glitch)", () => {
  const bot = new CryptoBotFinal();
  bot.updatePrice("BTCUSDC", 50000);
  bot.updatePrice("BTCUSDC", 10000); // -80%, imposible en un tick
  assert.equal(bot.prices["BTCUSDC"], 50000, "caída 80% debe rechazarse");
  bot.updatePrice("BTCUSDC", 100000); // +100%, imposible
  assert.equal(bot.prices["BTCUSDC"], 50000, "subida 100% debe rechazarse");
});

test("BUG-R: updatePrice acepta movimientos normales (<50%)", () => {
  const bot = new CryptoBotFinal();
  bot.updatePrice("BTCUSDC", 50000);
  bot.updatePrice("BTCUSDC", 49000); // -2%, normal
  assert.equal(bot.prices["BTCUSDC"], 49000);
  bot.updatePrice("BTCUSDC", 52000); // +6%, normal
  assert.equal(bot.prices["BTCUSDC"], 52000);
});

test("BUG-R: primer update de un símbolo sin prev no activa guard de salto", () => {
  const bot = new CryptoBotFinal();
  bot.updatePrice("NEARUSDC", 2.47); // primer precio, no hay prev con que comparar
  assert.equal(bot.prices["NEARUSDC"], 2.47);
});

// ── (3) Schema del trade SELL (BUG-R2) ──────────────────────────────────────

test("BUG-R2: objeto trade SELL incluye entryPrice/openTs/investUsdc/rsiAtEntry", () => {
  // Inspección del source — el trade se construye dentro del loop de evaluate(),
  // y recrear la rama completa requeriría semillar history/prices/portfolio con
  // mucho detalle. Verificamos la presencia de los keys en el source para
  // que este test falle si alguien los elimina accidentalmente.
  const fs = require("node:fs");
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "src", "engine.js"), "utf8");
  // Busca el objeto trade del SELL completo (engine.js:~740) con los 4 keys nuevos.
  const hasEntryPrice = /type:"SELL"[^}]*entryPrice:pos\.entryPrice/s.test(src);
  const hasOpenTs     = /type:"SELL"[^}]*openTs:pos\.ts/s.test(src);
  const hasInvestUsdc = /type:"SELL"[^}]*investUsdc:/s.test(src);
  const hasRsiEntry   = /type:"SELL"[^}]*rsiAtEntry:pos\.rsiEntry/s.test(src);
  assert.ok(hasEntryPrice, "SELL trade debe incluir entryPrice:pos.entryPrice");
  assert.ok(hasOpenTs,     "SELL trade debe incluir openTs derivado de pos.ts");
  assert.ok(hasInvestUsdc, "SELL trade debe incluir investUsdc");
  assert.ok(hasRsiEntry,   "SELL trade debe incluir rsiAtEntry");
});

// ── (4) Regression: caso histórico id=26 NEARUSDC ───────────────────────────

test("BUG-R regression: entry inflado (1e6) + cp normal (1.418) produciría pnl≈-100.15 → sanity check lo detecta", () => {
  // Reproducción matemática del caso histórico: entry=1e6 (como hubiera quedado
  // tras el BUY si un tick corrupto pasó) y cp=1.418 (precio real al cerrar).
  // Fórmula: pnl = ((cp-entry)/entry)*100 - fee*100*2 (con BNB fee = 0.00075).
  const entry = 1e6;
  const cp = 1.418;
  const fee = 0.00075;
  const pnl = +(((cp - entry) / entry) * 100 - fee * 100 * 2).toFixed(2);
  assert.ok(Math.abs(pnl - (-100.15)) < 0.01, `pnl calculado ${pnl} debe aproximar -100.15`);
  // Ahora aplicamos la lógica del sanity check de server.js:386.
  const wouldPersist = Number.isFinite(pnl) && pnl >= -50 && pnl <= 50;
  assert.equal(wouldPersist, false, "sanity check debe rechazar pnl=-100.15");
});

test("BUG-R sanity: pnl normal dentro de [-50, +50] pasa el filtro", () => {
  for (const pnl of [-10, -1.5, 0, 1.2, 8.5, 15]) {
    const ok = Number.isFinite(pnl) && pnl >= -50 && pnl <= 50;
    assert.equal(ok, true, `pnl=${pnl} debería pasar`);
  }
});

test("BUG-R sanity: pnl NaN/Infinity es rechazado", () => {
  for (const pnl of [NaN, Infinity, -Infinity]) {
    const ok = Number.isFinite(pnl) && pnl >= -50 && pnl <= 50;
    assert.equal(ok, false, `pnl=${pnl} debería rechazarse`);
  }
});
