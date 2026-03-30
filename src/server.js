// ─── CRYPTOBOT PAPER — SERVER ─────────────────────────────────────────────────
// Instancia de aprendizaje: opera agresivamente en paper para
// optimizar parámetros y exportarlos al bot LIVE cuando son buenos.
"use strict";

const express    = require("express");
const http       = require("http");
const path       = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const { CryptoBotFinal, PAIRS }       = require("./engine");
const { saveState, loadState, deleteState } = require("./database");
const { Blacklist, MarketGuard, getTradingScore } = require("./market");
const { CryptoPanicDefense } = require("./cryptoPanic");
const { fetchFearGreed, fetchNewsAlert, fetchAllKlines, runNightlyReplay } = require("./feeds");
const { exportParams, calcSyncStats } = require("./sync");
const { runHistoricalSimulation }     = require("./historicalSimulation");
const tg         = require("./telegram");

const PORT    = process.env.PORT    || 3000;
const TICK_MS = parseInt(process.env.TICK_MS || "1000"); // 1s por defecto — variable Railway TICK_MS

// Capital ficticio grande — cuantas más operaciones, mejor aprende
const CAPITAL_USDT = parseFloat(process.env.CAPITAL_USDT || "50000");

const BAFIR_URL    = process.env.BAFIR_URL    || "https://bafir-trading-production.up.railway.app";
const BAFIR_SECRET = process.env.BAFIR_SECRET || "bafir_bot_secret";
const LIVE_URL     = process.env.LIVE_BOT_URL  || "";
const SYNC_SECRET  = process.env.SYNC_SECRET   || "sync_secret";

function sendEquityToBafirPaper(value) {
  try {
    const https2=require("https"),http2=require("http");
    const body=JSON.stringify({secret:BAFIR_SECRET,value});
    const url=new URL("/api/bot/equity/paper",BAFIR_URL);
    const mod=url.protocol==="https:"?https2:http2;
    const req=mod.request({hostname:url.hostname,path:url.pathname,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},()=>{});
    req.on("error",()=>{}); req.write(body); req.end();
  } catch(e){}
}

const blacklist   = new Blacklist(5, 1); // Paper: 5 pérdidas → solo 1h ban (aprender de todo)
const marketGuard = new MarketGuard();
const cryptoPanic = new CryptoPanicDefense();
cryptoPanic.start();

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// Servir index.html SIN cache para que siempre cargue la última versión
app.get("/", (req,res) => res.sendFile(path.join(__dirname,"../public/index.html"), {headers:{"Cache-Control":"no-store"}}));
app.get("/index.html", (req,res) => res.sendFile(path.join(__dirname,"../public/index.html"), {headers:{"Cache-Control":"no-store"}}));
app.use(express.static(path.join(__dirname, "../public")));
app.use(express.json());

function broadcast(msg) {
  const d = JSON.stringify(msg);
  wss.clients.forEach(c => { if(c.readyState===WebSocket.OPEN) c.send(d); });
}

app.get("/api/state",  (_,res) => res.json(bot ? { ...bot.getState(), instance:"PAPER", blacklist:blacklist.getStatus(), dailyPnlPct:bot._dailyPnlPct||0, momentumMult:bot.hourMultiplier||1, cryptoPanic:cryptoPanic?.getStatus?.()??null } : {loading:true,instance:"PAPER",totalValue:0}));
app.get("/api/health", (_,res) => res.json({ ok:true, instance:"PAPER", tick:bot?.tick, uptime:process.uptime(), tv:bot?.totalValue() }));

// Datos de aprendizaje (Q-Learning, ensemble, patrones, contrafactuales)
app.get("/api/learning", (_,res) => {
  if(!bot) return res.status(503).json({error:"Bot no iniciado"});
  res.json({
    qLearning:   { topStates:bot.qLearning.getTopStates(10), epsilon:bot.qLearning.epsilon },
    ensemble:    bot.ensemble.getWeights(),
    counterfactual: bot.cfMemory.getSummary(),
    intradayTrends: bot.intradayTrend.getAllTrends(),
    historicalSimulation: bot.historicalResults
      ? Object.fromEntries(Object.entries(bot.historicalResults).map(([k,v])=>[k,v.summary]))
      : null,
  });
});

// Score de confianza (calculado desde estadísticas actuales)
app.get("/api/confidence", (_,res) => {
  if(!bot) return res.status(503).json({error:"Bot no iniciado"});
  const wr=bot.recentWinRate()||50;
  const sells=bot.log.filter(l=>l.type==="SELL");
  const consec=calcConsecutive(sells);
  const dd=(bot.maxEquity-bot.totalValue())/bot.maxEquity;
  let score=50+(wr-50)*0.6;
  if(consec.wins>=3) score=Math.min(100,score+consec.wins*3);
  if(consec.losses>=2) score=Math.max(0,score-consec.losses*5);
  score=Math.max(0,Math.min(100,Math.round(score-dd*100)));
  const label=score>=80?"Muy alta":score>=65?"Alta":score>=45?"Moderada":score>=30?"Baja":"Muy baja";
  const color=score>=80?"#00c851":score>=65?"#33b5e5":score>=45?"#ffbb33":score>=30?"#ff8800":"#cc0000";
  res.json({score,label,color,winRate:wr,drawdown:+(dd*100).toFixed(2)});
});
app.post("/api/reset", async (_,res) => {
  bot=new CryptoBotFinal(); bot.mode="PAPER";
  blacklist.restore({});
  await deleteState();
  broadcast({type:"state",data:bot.getState()});
  res.json({ok:true});
});

// Endpoint para que el LIVE consulte el estado del PAPER
app.get("/api/paper/status", (req,res) => {
  if (!bot) return res.status(503).json({error:"Bot no iniciado"});
  const stats7d = calcSyncStats(bot.log, 7);
  const stats1d  = calcSyncStats(bot.log, 1);
  res.json({
    instance:   "PAPER",
    tick:       bot.tick,
    totalValue: bot.totalValue(),
    returnPct:  bot.getState().returnPct,
    params:     bot.optimizer.getParams(),
    stats7d, stats1d,
    pairScores: bot.pairScores,
    marketRegime: bot.marketRegime,
  });
});

function calcConsecutive(sells){
  let wins=0,losses=0;
  for(const s of sells.slice(0,10)){
    if(s.pnl>0){if(losses>0)break;wins++;}else{if(wins>0)break;losses++;}
  }
  return{wins,losses};
}

let bot;
let tgControls = null; // control remoto Telegram
(async () => {
  const saved = await loadState();
  bot = new CryptoBotFinal(saved);
  bot.mode = "PAPER";

  // En paper sin límite de operaciones — aprender lo máximo posible
  bot._paperMode = true;

  if (saved?.blacklistData) blacklist.restore(saved.blacklistData);
  console.log(`[PAPER] Bot iniciado — capital ficticio: $${CAPITAL_USDT} USDT`);

  tg.notifyStartup("PAPER (aprendizaje)");
  tg.scheduleReports(() => ({ ...bot.getState(), instance:"PAPER" }));

// ── SYNC DIARIO SELECTIVO: cada día a las 03:00 UTC paper→live ───────────────
function scheduleDailySync() {
  function msUntil3am() {
    const now=new Date(), next=new Date();
    next.setUTCHours(3,0,0,0);
    if(next<=now) next.setUTCDate(next.getUTCDate()+1);
    return next-now;
  }
  setTimeout(function runDailySync() {
    if(bot) {
      console.log("[SYNC-DAILY] Ejecutando sync diario paper→live...");
      exportDailyLearning(bot, process.env.LIVE_BOT_URL, process.env.SYNC_SECRET||"bafir_sync_secret_2024");
    }
    setTimeout(runDailySync, 24*60*60*1000);
  }, msUntil3am());
  console.log(`[SYNC-DAILY] Programado en ${Math.round(msUntil3am()/3600000)}h`);
}
scheduleDailySync();

  tgControls = tg.startCommandListener(() => ({...bot.getState(),instance:"PAPER",dailyPnlPct:bot._dailyPnlPct||0,momentumMult:bot.hourMultiplier||1,cryptoPanic:cryptoPanic.getStatus()}));

  fetchFearGreed().then(fg => { bot.fearGreed=fg.value; bot.fearGreedPublished=fg.publishedAt; bot.fearGreedSource=fg.source||"unknown"; console.log(`[F&G] ${fg.value} (${fg.source}) publicado: ${fg.publishedAt||"desconocido"}`); });

  // Simulación histórica al arrancar (no bloquea el bot)
  const HIST_SYMBOLS = ["BTCUSDC","ETHUSDC","SOLUSDC","BNBUSDC","ADAUSDC","XRPUSDC","LINKUSDC","AVAXUSDC"];
  runHistoricalSimulation(HIST_SYMBOLS, "1h")
    .then(results => {
      bot.historicalResults = results;
      const summary = Object.entries(results).map(([p,v])=>`${p}:${Object.keys(v.bySymbol||{}).length}pares`).join(" ");
      console.log(`[PAPER] Simulación histórica OK — ${summary}`);

      // Walk-forward: validar que params actuales no están overfitting
      // Usar el historial del bot real (log de trades) para calcular WF básico
      if (bot.log && bot.log.length > 50) {
        const sells = bot.log.filter(l=>l.type==="SELL"&&l.pnl!=null);
        const mid = Math.floor(sells.length * 0.7);
        const trainSells = sells.slice(0, mid);
        const testSells  = sells.slice(mid);
        const trainWR = trainSells.length ? Math.round(trainSells.filter(l=>l.pnl>0).length/trainSells.length*100) : 0;
        const testWR  = testSells.length  ? Math.round(testSells.filter(l=>l.pnl>0).length/testSells.length*100)   : 0;
        const overfit = trainWR > 0 ? (testWR/trainWR).toFixed(2) : "n/a";
        bot.walkForwardResult = { trainWR, testWR, overfit, trainN:trainSells.length, testN:testSells.length };
        console.log(`[WF] Train WR: ${trainWR}% (${trainSells.length} ops) | Test WR: ${testWR}% (${testSells.length} ops) | Ratio: ${overfit}`);
        if (parseFloat(overfit) < 0.5 && testSells.length > 10) {
          console.warn("[WF] ⚠️ Posible overfitting — modelo funciona mejor en train que en test");
        }
      }
    })
    .catch(e => console.warn("[PAPER] Simulación histórica error:", e.message));

  startLoop();
})();

let ticks=0;
async function save() {
  if(!bot) return;
  const s=bot.getState();
  s.blacklistData=blacklist.serialize();
  s.optimizerHistory=bot.optimizer.history;
  s.trailingHighs=bot.trailing.highs;
  s.reentryTs=bot.reentryTs;
  await saveState(s);
}
process.on("SIGTERM",async()=>{await save();process.exit(0);});
process.on("SIGINT", async()=>{await save();process.exit(0);});

const symbols   = PAIRS.map(p=>p.symbol.toLowerCase());
const streamUrl = `wss://stream.binance.com:9443/stream?streams=${symbols.map(s=>`${s}@miniTicker`).join("/")}`;
let binanceLive=false, lastPriceTs=Date.now();

function connectBinance() {
  const ws=new WebSocket(streamUrl);
  ws.on("open",    ()=>{ binanceLive=true; console.log("[BINANCE] ✓ Stream en vivo"); });
  ws.on("message", raw=>{ try{const{data}=JSON.parse(raw);if(data?.s&&data?.c&&bot){bot.updatePrice(data.s,parseFloat(data.c));lastPriceTs=Date.now();}}catch(e){} });
  ws.on("close",   ()=>{ binanceLive=false; setTimeout(connectBinance,5000); });
  ws.on("error",   e=>console.error("[BINANCE]",e.message));
}

const SEEDS={BTCUSDT:67000,ETHUSDT:3500,SOLUSDT:180,BNBUSDT:580,AVAXUSDT:38,ADAUSDT:0.45,DOTUSDT:8.5,LINKUSDT:18,UNIUSDT:10,AAVEUSDT:95,XRPUSDT:0.52,LTCUSDT:82};
function simulatePrices() {
  if(!bot||Date.now()-lastPriceTs<10000) return;
  PAIRS.forEach(p=>{ const last=bot.prices[p.symbol]||SEEDS[p.symbol]||100; bot.updatePrice(p.symbol,last*(1+0.007*(Math.random()+Math.random()-1)*1.2+0.00004)); });
}

let wasDefensive=false, cbNotified=false;
let lastFearGreedCheck=0, lastNightlyReplay="";

function startLoop() {
  connectBinance();

  setInterval(async () => {
    if(!bot) return;
    simulatePrices();

    const marketState=marketGuard.update(bot.prices["BTCUSDC"]);
    if(marketState?.defensive&&!wasDefensive){ tg.notifyDefensiveMode(marketState.btcDrawdown); wasDefensive=true; }
    if(!marketState?.defensive&&wasDefensive){ tg.notifyDefensiveOff(); wasDefensive=false; }

    bot.marketDefensive=marketGuard.isDefensive();
    bot.hourMultiplier=getTradingScore().score;
    bot.blacklist=blacklist;

    // ── MOMENTUM BOOST (paper): días muy buenos → aprender con más volumen ──
    const todaySellsPaper = bot.log.filter(l => {
      if (l.type !== "SELL") return false;
      const d = new Date(l.ts), n = new Date();
      return d.getDate()===n.getDate() && d.getMonth()===n.getMonth() && d.getFullYear()===n.getFullYear();
    });
    const todayPnlPaper = todaySellsPaper.reduce((s,l)=>s+(l.pnl||0),0);
    bot._dailyPnlPct = todayPnlPaper;
    bot._dailyLimitBoost = todayPnlPaper >= 7 ? Math.round(todayPnlPaper / 3) : 0;
    const momentumMult = todayPnlPaper<0?0.8:todayPnlPaper<5?1.0:todayPnlPaper<10?1.4:todayPnlPaper<15?1.8:2.5;
    bot._cryptoPanicFn = (sym) => cryptoPanic.getSizeMultiplier(sym);
    bot._newsMultiplier = cryptoPanic.globalDefensive ? 0.3 : 1.0;
    bot.hourMultiplier = getTradingScore().score * momentumMult * (cryptoPanic.globalDefensive ? 0.5 : 1.0);

    // Alerta Telegram momentum paper
    const prevMomPaper = bot._prevMomentumLevel || 1.0;
    if (momentumMult >= 1.6 && prevMomPaper < 1.6 && tg.notifyMomentumBoost)
      tg.notifyMomentumBoost(momentumMult, todayPnlPaper);
    bot._prevMomentumLevel = momentumMult;

    // ── Aplicar parámetros aprendidos a los subsistemas (paper) ──────────────
    if (bot.riskLearning) {
      cryptoPanic._learnedGlobalThreshold = bot.riskLearning.get("cpGlobalThreshold", 5);
      cryptoPanic._learnedExpiryHours     = bot.riskLearning.get("cpExpiryHours", 2);
      if (bot.trailing) bot.trailing._learnedTrailingMin = bot.riskLearning.get("trailingMinPct", 2) / 100;
    }

    // En PAPER: límite diario muy alto para aprender más
    // Sobreescribimos getDailyLimit para que sea siempre 50 en paper
    const { signals, newTrades, circuitBreaker, optimizerResult, drawdownAlert, dailyLimit, dailyUsed } = bot.evaluate();
    ticks++;

    for(const trade of newTrades) {
      if(trade.type==="SELL") {
        if(trade.pnl<0){ const wasBl=blacklist.isBlacklisted(trade.symbol); blacklist.recordLoss(trade.symbol); if(!wasBl&&blacklist.isBlacklisted(trade.symbol)) tg.notifyBlacklist(trade.symbol); }
        else blacklist.recordWin(trade.symbol);
        // Notificar trades significativos
        if(trade.type==="SELL"){
          if(trade.pnl>=5) tg.notifyBigWin && tg.notifyBigWin(trade);
          if(trade.pnl<=-4) tg.notifyBigLoss && tg.notifyBigLoss(trade);
        }
      }
    }

    if(circuitBreaker?.triggered&&!cbNotified){ tg.notifyCircuitBreaker(circuitBreaker.drawdown); cbNotified=true; }
    if(!circuitBreaker?.triggered) cbNotified=false;
    if(drawdownAlert?.triggered) tg.notifyMaxDrawdown(drawdownAlert);
    if(!circuitBreaker?.triggered) cbNotified=false;
    if(optimizerResult?.changes?.length>0) tg.notifyOptimizer(optimizerResult);

    // Fear & Greed cada 30min (alternative.me publica 1x/día, pero puede actualizarse)
    if(Date.now()-lastFearGreedCheck>1800000){
      lastFearGreedCheck=Date.now();
      fetchFearGreed().then(fg=>{ bot.fearGreed=fg.value; bot.fearGreedPublished=fg.publishedAt; bot.fearGreedSource=fg.source||"unknown"; console.log(`[F&G] ${fg.value} (${fg.source||"?"}) · ${fg.publishedAt?.slice(0,16)||"?"}`); });
    }

    // Noticias cada 10 min
    if(ticks%300===0){ fetchNewsAlert().then(news=>{ if(news?.negative) tg.notifyNewsAlert(news); }); }

    // ── REPLAY NOCTURNO + EXPORTAR AL LIVE ───────────────────────────────────
    const replayKey=new Date().toDateString()+"_02";
    if(new Date().getUTCHours()===2&&lastNightlyReplay!==replayKey&&Object.keys(bot.history).length>0){
      lastNightlyReplay=replayKey;
      console.log("[PAPER] Replay nocturno + descargando klines de Binance…");
      // Descargar klines reales de Binance para enriquecer el replay
      const klines=await fetchAllKlines(["BTCUSDC","ETHUSDC","SOLUSDC","BNBUSDC","ADAUSDC","XRPUSDC"],"1h",500).catch(()=>({}));
      const best=runNightlyReplay(bot.history, bot.optimizer.getParams(), klines);
      const cur=bot.optimizer.getParams();
      if(best.winRate>60&&(best.params.emaFast!==cur.emaFast||best.params.minScore!==cur.minScore)){
        Object.assign(bot.optimizer.params, best.params);
        tg.notifyNightlyReplay(best);
      }

      // Exportar parámetros al LIVE si hay URL configurada
      if(LIVE_URL) {
        const stats7d=calcSyncStats(bot.log, 7);
        console.log(`[PAPER→LIVE] WR 7d: ${stats7d.winRate}% | ${stats7d.nTrades} ops`);
        exportParams(bot.optimizer.getParams(), calcSyncStats(bot.log, 1), LIVE_URL, SYNC_SECRET);
        tg.notifyPaperExport(stats7d, bot.optimizer.getParams());
      }
    }

    const paperTotalTrades=bot.log.filter(l=>l.type==="SELL").length;
const paperPhase=paperTotalTrades<100?1:paperTotalTrades<500?2:3;
const paperLimit=paperPhase===1?2000:paperPhase===2?500:300;
broadcast({ type:"tick", data:{ ...bot.getState(), signals, newTrades, circuitBreaker, optimizerResult, binanceLive, instance:"PAPER", marketDefensive:marketGuard.isDefensive(), tradingHour:getTradingScore(), dailyPnlPct:bot._dailyPnlPct||0, momentumMult:bot.hourMultiplier, dailyLimit:paperLimit, learningPhase:paperPhase } });

    // Enviar equity a BAFIR como instancia paper
    if(ticks%60===0) sendEquityToBafirPaper(bot.totalValue());
    // Re-simulación histórica cada 6h con datos frescos de Binance
    if(ticks%10800===0 && ticks>0) {
      const HIST_SYMBOLS = ["BTCUSDC","ETHUSDC","SOLUSDC","BNBUSDC","ADAUSDC","XRPUSDC","LINKUSDC","AVAXUSDC"];
      console.log("[PAPER] Re-simulación histórica periódica (6h)...");
      runHistoricalSimulation(HIST_SYMBOLS, "1h")
        .then(results => {
          bot.historicalResults = results;
          // Re-ejecutar walk-forward con datos actualizados
          if(bot.log && bot.log.length > 50) {
            const sells = bot.log.filter(l=>l.type==="SELL"&&l.pnl!=null);
            const mid = Math.floor(sells.length * 0.7);
            const testWR = sells.slice(mid).length ? Math.round(sells.slice(mid).filter(l=>l.pnl>0).length/sells.slice(mid).length*100) : 0;
            const trainWR = sells.slice(0,mid).length ? Math.round(sells.slice(0,mid).filter(l=>l.pnl>0).length/sells.slice(0,mid).length*100) : 0;
            bot.walkForwardResult = {trainWR, testWR, overfit:(testWR/Math.max(trainWR,1)).toFixed(2), trainN:mid, testN:sells.length-mid};
            console.log(`[WF] Train:${trainWR}% Test:${testWR}% Ratio:${bot.walkForwardResult.overfit}`);
          }
          console.log("[PAPER] Re-simulación OK");
        })
        .catch(e => console.warn("[PAPER] Re-simulación error:", e.message));
    }
    // Sync Q-states al live cada hora (aprendizaje continuo, no solo a las 3am)
    if(ticks%1800===0 && bot.qLearning) {
      const qStats = bot.qLearning.getTopStates(20);
      const goodStates = qStats.filter(s=>s.bestAction[1]>0.3);
      if(goodStates.length>0) {
        const body=JSON.stringify({
          secret:process.env.SYNC_SECRET||"bafir_sync_secret_2024",
          dailyLearning:{
            winRate:bot.recentWinRate()||0,
            avgPnl:0, nTrades:1,
            regime:bot.marketRegime,
            optimizerParams:bot.optimizer.getParams(),
            qTopStates:goodStates,
          },
          positive:false, hasLearning:true
        });
        const liveUrl=process.env.LIVE_BOT_URL||"";
        if(liveUrl){
          const mod2=liveUrl.startsWith("https")?require("https"):require("http");
          const u=new URL("/api/sync/daily",liveUrl);
          const sig=require("crypto").createHmac("sha256",process.env.SYNC_SECRET||"bafir_sync_secret_2024").update(body).digest("hex");
          const r2=mod2.request({hostname:u.hostname,path:u.pathname,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body),"X-Signature":sig}},()=>{});
          r2.on("error",()=>{}); r2.write(body); r2.end();
          console.log(`[PAPER→LIVE] Sync Q-states horario: ${goodStates.length} estados útiles`);
        }
      }
    }

    if(ticks%20===0) save().catch(e=>console.error("[SAVE]",e));

  }, TICK_MS);

}

// Servidor arranca INMEDIATAMENTE — healthcheck pasa, WS disponible de inmediato
server.listen(PORT, ()=>console.log(`\n📋 CRYPTOBOT PAPER en http://localhost:${PORT} | Capital: $${CAPITAL_USDT} USDC\n`));

wss.on("connection", ws=>{
  // Enviar estado inicial
  try {
    if(bot) ws.send(JSON.stringify({type:"state",data:{...bot.getState(),instance:bot.mode,syncHistory}}));
    else    ws.send(JSON.stringify({type:"state",data:{loading:true,instance:"LIVE",totalValue:0}}));
  } catch(e) {}
  // Heartbeat: ping cada 25s para evitar que Railway cierre la conexión idle
  const hb = setInterval(()=>{ if(ws.readyState===WebSocket.OPEN) ws.ping(); else clearInterval(hb); }, 25000);
  ws.on("pong", ()=>{});
  ws.on("close", ()=>clearInterval(hb));
});
