// ─── PARAMETER SYNC v4 ───────────────────────────────────────────────────────
// Reglas de adopción:
// - Días 1-14 (bootstrapping): adopta cada noche si paper > live (sin exigir 7 días)
// - Día 15+: exige 7 días consecutivos donde paper > live en WR Y avgPnl
// - Siempre: mínimo 5 ops/día y parámetros diferentes
// - El live espera 1 hora al PRIMER arranque (no en reinicios)
"use strict";

const crypto = require("crypto");
const https  = require("https");
const http   = require("http");

const BOOTSTRAP_DAYS = 14; // días sin restricción de N días consecutivos

// ── PAPER → exportar ─────────────────────────────────────────────────────────
function exportParams(params, paperStats, liveUrl, secret) {
  if (!liveUrl) { console.log("[SYNC] LIVE_BOT_URL no configurada"); return; }

  const payload    = { params, paperStats, exportedAt: new Date().toISOString() };
  const bodyStr    = JSON.stringify({ secret, ...payload });
  const signature  = crypto.createHmac("sha256", secret).update(bodyStr).digest("hex");

  try {
    const url = new URL("/api/sync/params", liveUrl);
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request({
      hostname: url.hostname, path: url.pathname, method: "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        "X-Signature":    signature, // firma HMAC
      },
    }, res => {
      let d=""; res.on("data",c=>d+=c);
      res.on("end",()=>{ try { const r=JSON.parse(d); console.log(`[PAPER→LIVE] ${r.adopted?"✅":"⏸"}: ${r.reason}`); } catch(e){} });
    });
    req.on("error", e => console.warn("[SYNC]", e.message));
    req.setTimeout(8000, () => { req.destroy(); });
    req.write(bodyStr); req.end();
  } catch(e) { console.warn("[SYNC]", e.message); }
}

// ── LIVE → evaluar si adoptar ─────────────────────────────────────────────────
function evaluateIncomingParams(incoming, currentParams, currentLiveStats, syncHistory) {
  const { params, paperStats, exportedAt } = incoming;
  const MIN_TRADES    = 5;
  const STRICT_DAYS   = 7;

  // Registrar
  syncHistory.push({ ts:exportedAt||new Date().toISOString(), paperStats, liveStats:currentLiveStats, params });
  while (syncHistory.length > 120) syncHistory.shift();

  // ── Check 1: suficientes operaciones
  if ((paperStats.nTrades||0) < MIN_TRADES) {
    return { adopted:false, reason:`Paper solo hizo ${paperStats.nTrades} ops (mínimo ${MIN_TRADES})`, syncHistory };
  }

  // ── Check 2: paper mejor que live en WR Y avgPnl
  const wrBetter  = (paperStats.winRate||0) > (currentLiveStats.winRate||0);
  const pnlBetter = (paperStats.avgPnl||0)  > (currentLiveStats.avgPnl||0);
  if (!wrBetter || !pnlBetter) {
    return {
      adopted: false,
      reason:  `Paper no supera al live — WR: ${paperStats.winRate}% vs ${currentLiveStats.winRate}% | avgPnl: ${paperStats.avgPnl}% vs ${currentLiveStats.avgPnl}%`,
      syncHistory,
    };
  }

  // ── Check 3: parámetros diferentes
  if (JSON.stringify(params) === JSON.stringify(currentParams)) {
    return { adopted:false, reason:"Parámetros idénticos, sin cambio", syncHistory };
  }

  // ── Check 4: ¿estamos en bootstrapping (primeros 14 días)?
  const isBootstrap = syncHistory.length <= BOOTSTRAP_DAYS;

  if (isBootstrap) {
    // En bootstrapping: adoptar directamente si paper > live (ya comprobado arriba)
    return {
      adopted:    true,
      newParams:  params,
      reason:     `Bootstrap día ${syncHistory.length}/${BOOTSTRAP_DAYS} — paper WR ${paperStats.winRate}% > live ${currentLiveStats.winRate}%`,
      paperStats, currentLiveStats, syncHistory, bootstrap: true,
    };
  }

  // ── Check 5: post-bootstrapping — 7 días consecutivos siendo mejor
  const recentDays = syncHistory.slice(-STRICT_DAYS);
  if (recentDays.length < STRICT_DAYS) {
    return { adopted:false, reason:`Solo ${recentDays.length}/${STRICT_DAYS} días de historial`, syncHistory };
  }

  const allGood = recentDays.every(d =>
    (d.paperStats?.winRate||0) > (d.liveStats?.winRate||0) &&
    (d.paperStats?.avgPnl||0)  > (d.liveStats?.avgPnl||0)  &&
    (d.paperStats?.nTrades||0) >= MIN_TRADES
  );

  if (!allGood) {
    const good = recentDays.filter(d =>
      (d.paperStats?.winRate||0) > (d.liveStats?.winRate||0) &&
      (d.paperStats?.nTrades||0) >= MIN_TRADES
    ).length;
    return { adopted:false, reason:`Solo ${good}/${STRICT_DAYS} días consecutivos siendo mejor`, syncHistory };
  }

  const avgWR  = recentDays.reduce((s,d)=>s+(d.paperStats?.winRate||0),0)/recentDays.length;
  const avgPnl = recentDays.reduce((s,d)=>s+(d.paperStats?.avgPnl||0),0)/recentDays.length;

  return {
    adopted:    true,
    newParams:  params,
    reason:     `${STRICT_DAYS} días consecutivos — paper WR ${avgWR.toFixed(0)}% avgPnl ${avgPnl.toFixed(2)}%`,
    paperStats, currentLiveStats, syncHistory, bootstrap: false,
  };
}

function calcSyncStats(log, days=1) {
  const cutoff = Date.now()-days*24*60*60*1000;
  const recent = log.filter(l=>l.type==="SELL"&&new Date(l.ts).getTime()>cutoff);
  const wins   = recent.filter(l=>l.pnl>0).length;
  const avgPnl = recent.length?recent.reduce((s,l)=>s+l.pnl,0)/recent.length:0;
  return { winRate:recent.length?Math.round(wins/recent.length*100):0, avgPnl:+avgPnl.toFixed(2), nTrades:recent.length, daysTracked:days };
}


// ── SYNC DIARIO SELECTIVO: envía solo lo aprendido hoy ───────────────────────
// Paper exporta al live los parámetros que funcionaron MEJOR hoy,
// no una comparación global. Live los adopta si hoy fue positivo.
function exportDailyLearning(bot, liveUrl, secret) {
  if (!liveUrl) return;
  
  const today = new Date().toDateString();
  const todaySells = (bot.log||[]).filter(l=>l.type==="SELL"&&new Date(l.ts).toDateString()===today);
  if (todaySells.length < 3) {
    console.log(`[SYNC-DAILY] Solo ${todaySells.length} ops hoy, no hay suficiente para aprender`);
    return;
  }
  
  const wins   = todaySells.filter(l=>l.pnl>0).length;
  const winRate = Math.round(wins/todaySells.length*100);
  const avgPnl  = todaySells.reduce((s,l)=>s+(l.pnl||0),0)/todaySells.length;
  
  // Extraer qué aprendió hoy el bot
  const dailyLearning = {
    date: today,
    winRate, avgPnl: +avgPnl.toFixed(2), nTrades: todaySells.length,
    // Parámetros del optimizador actual
    optimizerParams: bot.optimizer?.getParams() || {},
    // Pares con mejor rendimiento hoy
    topPairs: Object.entries(
      todaySells.reduce((acc, t) => {
        if (!acc[t.symbol]) acc[t.symbol] = {wins:0,n:0,pnl:0};
        acc[t.symbol].n++;
        acc[t.symbol].pnl += t.pnl||0;
        if(t.pnl>0) acc[t.symbol].wins++;
        return acc;
      }, {})
    ).map(([sym,st]) => ({symbol:sym, wr:Math.round(st.wins/st.n*100), avgPnl:+(st.pnl/st.n).toFixed(2), n:st.n}))
     .sort((a,b)=>b.wr-a.wr).slice(0,6),
    // Régimen del mercado predominante hoy
    regime: bot.marketRegime,
    // Q-Learning top states aprendidos hoy (comprimido)
    qTopStates: bot.qLearning ? Object.entries(bot.qLearning.Q||{})
      .filter(([,v])=>Math.max(...Object.values(v))>0.1)
      .slice(0,20)
      .map(([state,actions])=>({state, best:Object.entries(actions).sort((a,b)=>b[1]-a[1])[0]}))
      : [],
  };
  
  const positive = winRate >= 50 && avgPnl > 0;
  const body = JSON.stringify({ secret, dailyLearning, positive });
  const sig  = crypto.createHmac("sha256", secret).update(body).digest("hex");
  
  try {
    const url = new URL("/api/sync/daily", liveUrl);
    const mod = url.protocol==="https:" ? https : http;
    const req = mod.request({
      hostname: url.hostname, path: url.pathname, method: "POST",
      headers: {"Content-Type":"application/json","Content-Length":Buffer.byteLength(body),"X-Signature":sig}
    }, res => {
      let d=""; res.on("data",c=>d+=c);
      res.on("end",()=>{ try{const r=JSON.parse(d);console.log(`[SYNC-DAILY] ${r.adopted?"✅ Adoptado":"⏸ Ignorado"}: ${r.reason}`);}catch(e){} });
    });
    req.on("error",e=>console.warn("[SYNC-DAILY]",e.message));
    req.setTimeout(8000,()=>req.destroy()); 
    req.write(body); req.end();
  } catch(e) { console.warn("[SYNC-DAILY]", e.message); }
}

module.exports = { exportParams, evaluateIncomingParams, calcSyncStats, exportDailyLearning };
