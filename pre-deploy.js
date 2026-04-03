#!/usr/bin/env node
// pre-deploy.js — Validación automática antes de deployar a live
// Uso: node pre-deploy.js [--force]
// Corre rolling walk-forward y bloquea el deploy si el modelo hace overfitting

const { runRollingWalkForward } = require("./src/backtest");

const FORCE = process.argv.includes("--force");
const MIN_RATIO = 0.55;
const SYMBOLS = ["BTCUSDC","ETHUSDC","SOLUSDC","BNBUSDC","ADAUSDC","XRPUSDC"];

async function main() {
  console.log("\n🔍 PRE-DEPLOY: Rolling Walk-Forward validation...");
  console.log("   Símbolos:", SYMBOLS.join(", "));
  console.log("   Ventanas: 3 × (30d train + 7d test)\n");

  const result = await runRollingWalkForward(SYMBOLS, 30, 7, 3);

  console.log("\n📊 RESULTADOS:");
  for(const w of result.windows) {
    const icon = w.isRobust ? "✅" : "⚠️";
    console.log(`   ${icon} Ventana ${w.window}: Train WR ${w.train.wr}% → Test WR ${w.test.wr}% (ratio: ${w.overfitRatio})`);
  }

  console.log(`\n   Ratio promedio: ${result.avgOverfitRatio}`);
  console.log(`   Veredicto: ${result.verdict}`);
  console.log(`   Ventanas robustas: ${result.robustWindows}/${result.totalWindows}\n`);

  if(result.avgOverfitRatio < MIN_RATIO && !FORCE) {
    console.error("❌ DEPLOY BLOQUEADO");
    console.error(`   Ratio ${result.avgOverfitRatio} < mínimo ${MIN_RATIO}`);
    console.error("   El modelo puede estar sobreajustado.");
    console.error("   Para forzar el deploy: node pre-deploy.js --force\n");
    process.exit(1);
  } else if(result.avgOverfitRatio < MIN_RATIO && FORCE) {
    console.warn("⚠️  Deploy forzado pese a ratio bajo. Monitoriza el live de cerca.");
  } else {
    console.log("✅ DEPLOY AUTORIZADO — Modelo robusto\n");
  }
}

main().catch(e => {
  console.error("Error en pre-deploy:", e.message);
  process.exit(1);
});
