// darwin.js — Simulación paralela: 3 instancias compiten, la mejor gana
// Cada instancia es una copia virtual del engine con distintos parámetros
// No usa procesos reales — simula internamente con el historial de precios

"use strict";
const { CryptoBotFinal } = require("./engine");

// Perfiles de los 3 competidores
const DARWIN_PROFILES = [
  { name:"AGRESIVO",    minScore:55, trailingPct:0.025, maxPos:5, atrMult:1.5 },
  { name:"NEUTRO",      minScore:65, trailingPct:0.035, maxPos:4, atrMult:2.0 },
  { name:"CONSERVADOR", minScore:78, trailingPct:0.050, maxPos:3, atrMult:2.5 },
];

class DarwinSimulation {
  constructor() {
    this.instances = [];
    this.winner = null;
    this.lastRun = null;
    this.history = []; // historial de ganadores
    this.running = false;
  }

  // Clonar el estado actual del bot vivo para cada instancia
  async run(liveBot) {
    if(this.running) return null;
    this.running = true;
    const results = [];

    for(const profile of DARWIN_PROFILES) {
      try {
        // Crear instancia con estado del bot vivo + parámetros alternativos
        const clone = new CryptoBotFinal({
          log: [...(liveBot.log||[]).slice(-200)], // últimos 200 trades
          cash: liveBot.cash,
          portfolio: {},  // sin posiciones abiertas (simulación limpia)
          equity: [...(liveBot.equity||[])],
        });
        clone.mode = "DARWIN";
        clone.optimizer.params.minScore = profile.minScore;
        clone.profile.trailingPct = profile.trailingPct;
        clone.profile.maxOpenPositions = profile.maxPos;

        // Simular con el historial de precios de los últimos N ticks
        const priceHistory = liveBot.history || {};
        let simTicks = 0;
        const symbols = Object.keys(priceHistory).filter(s => priceHistory[s]?.length > 50);

        for(let tick = 0; tick < Math.min(500, Math.min(...symbols.map(s=>priceHistory[s].length-1))); tick++) {
          for(const sym of symbols) {
            const p = priceHistory[sym][tick];
            if(p) clone.updatePrice(sym, p);
          }
          clone.evaluate();
          simTicks++;
        }

        const sells = (clone.log||[]).filter(l=>l.type==="SELL");
        const wins = sells.filter(l=>l.pnl>0).length;
        const wr = sells.length ? Math.round(wins/sells.length*100) : 0;
        const finalTV = clone.totalValue();
        const ret = liveBot.cash > 0 ? ((finalTV-liveBot.cash)/liveBot.cash*100) : 0;

        results.push({ profile:profile.name, wr, trades:sells.length, returnPct:+ret.toFixed(2), finalTV, ticks:simTicks });
      } catch(e) {
        results.push({ profile:profile.name, wr:0, trades:0, returnPct:0, error:e.message });
      }
    }

    // Elegir ganador: score = WR * 0.5 + returnPct * 0.5
    results.sort((a,b) => (b.wr*0.5 + b.returnPct*0.5) - (a.wr*0.5 + a.returnPct*0.5));
    this.winner = results[0];
    this.lastRun = new Date().toISOString();
    this.history.push({ ts:this.lastRun, winner:this.winner.profile, results });
    if(this.history.length > 30) this.history.shift();
    this.running = false;

    console.log(`[DARWIN] 🏆 Ganador: ${this.winner.profile} WR:${this.winner.wr}% ret:${this.winner.returnPct}%`);
    for(const r of results) {
      console.log(`[DARWIN]   ${r.profile}: WR:${r.wr}% trades:${r.trades} ret:${r.returnPct}%`);
    }
    return results;
  }

  // Aplicar los parámetros del ganador al bot vivo
  applyWinner(liveBot) {
    if(!this.winner) return false;
    const profile = DARWIN_PROFILES.find(p=>p.name===this.winner.profile);
    if(!profile || !liveBot) return false;
    liveBot.optimizer.params.minScore = profile.minScore;
    liveBot.profile.trailingPct = profile.trailingPct;
    liveBot.profile.maxOpenPositions = profile.maxPos;
    console.log(`[DARWIN] ✅ Parámetros del ganador "${profile.name}" aplicados al bot`);
    return true;
  }

  getStatus() {
    return { winner:this.winner, lastRun:this.lastRun, running:this.running, historyCount:this.history.length, recentWinners: this.history.slice(-5).map(h=>h.winner) };
  }
}

module.exports = { DarwinSimulation };
