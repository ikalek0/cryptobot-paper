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
const { fetchFearGreed, fetchNewsAlert, fetchAllKlines, runNightlyReplay, fetchLongShortRatio, fetchFundingRate, fetchRedditSentiment, fetchOpenInterest, fetchTakerVolume } = require("./feeds");
const { exportParams, calcSyncStats } = require("./sync");
const { runHistoricalSimulation, runFastLearn } = require("./historicalSimulation");
const { runBacktest, runRollingWalkForward, runIntradayWalkForward, runMultiTimeframeWF } = require("./backtest");
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
app.get("/api/backtest", async (_,res) => {
  try {
    const now=Date.now();
    const syms=["BTCUSDC","ETHUSDC","SOLUSDC","BNBUSDC","ADAUSDC","XRPUSDC"];
    const [bt30, rwf] = await Promise.all([
      runBacktest(syms, now-30*86400000, now),
      runRollingWalkForward(syms, 30, 7, 3),
    ]);
    res.json({ok:true, backtest30d:bt30?{return:bt30.totalReturn,wr:bt30.winRate,sharpe:bt30.sharpe,dd:bt30.maxDrawdown,pf:bt30.profitFactor}:null, walkForward:rwf});
  } catch(e) { res.json({ok:false,error:e.message}); }
});

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
// Reset endpoint eliminado por seguridad — no exponer esta funcionalidad

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

// ── Replay nocturno: re-entrenar con klines del día anterior ──────────────────
function scheduleNightlyLearning() {
  function msUntil0030() {
    const now=new Date(), next=new Date();
    next.setUTCHours(0,30,0,0);
    if(next<=now) next.setUTCDate(next.getUTCDate()+1);
    return next-now;
  }
  setTimeout(async function runNightly() {
    if(!bot) { setTimeout(runNightly, 24*60*60*1000); return; }
    console.log("[NIGHTLY] Iniciando replay nocturno con datos reales...");
    try {
      const { fetchAllKlinesForPeriod, simulatePeriod } = require("./historicalSimulation");
      const yesterday = Date.now() - 25*60*60*1000;
      const now2 = Date.now() - 60*1000;
      const symbols = ["BTCUSDC","ETHUSDC","SOLUSDC","BNBUSDC","XRPUSDC","ADAUSDC"];
      let injected = 0;
      for (const sym of symbols) {
        try {
          const candles = await fetchAllKlinesForPeriod(sym, "1h", yesterday, now2);
          if (candles.length < 10) continue;
          const sim = simulatePeriod(sym, candles);
          if (!sim || !sim.trades.length) continue;
          for (const t of sim.trades) {
            const rsiBin = t.rsiEntry<35?'low':t.rsiEntry<45?'mid_low':'mid';
            const stateKey = `${t.regime}|${rsiBin}|lower_half|neutral|normal|normal_vol`;
            const reward = t.pnlPct>0 ? Math.min(2, t.pnlPct*20) : Math.max(-2, t.pnlPct*20);
            bot.qLearning.update(stateKey, t.pnlPct>0?"BUY":"SKIP", reward*0.5, stateKey);
            bot.patternMemory.recordTrade(sym, {rsiEntry:t.rsiEntry||50, bbEntry:{lower:0,mid:0.5,upper:1}, entryPrice:t.entry, regime:t.regime, pnlPct:t.pnlPct, win:t.pnlPct>0});
            injected++;
          }
        } catch(e) { console.warn(`[NIGHTLY] ${sym}:`, e.message); }
      }
      if(injected>0 && bot.dqn && bot.dqn.replayBuffer.length>=50) {
        for(let i=0;i<Math.min(10,Math.floor(injected/5));i++) bot.dqn.trainBatch();
        console.log(`[DQN] Nightly training: ${bot.dqn.totalUpdates} updates total`);
      }
      console.log(`[NIGHTLY] Replay OK — ${injected} trades inyectados en Q-Learning`);
      if(injected>0) tg.send && tg.send(`📋 <b>[PAPER] Replay nocturno OK</b>
${injected} trades del día anterior inyectados`);
    } catch(e) { console.warn("[NIGHTLY] Error:", e.message); }
    setTimeout(runNightly, 24*60*60*1000);
  }, msUntil0030());
  console.log(`[NIGHTLY] Replay nocturno programado en ${Math.round(msUntil0030()/3600000)}h`);
}
scheduleNightlyLearning();

  tgControls = tg.startCommandListener(() => ({...bot.getState(),instance:"PAPER",dailyPnlPct:bot._dailyPnlPct||0,momentumMult:bot.hourMultiplier||1,cryptoPanic:cryptoPanic.getStatus()}));

  fetchFearGreed().then(fg => { bot.fearGreed=fg.value; bot.fearGreedPublished=fg.publishedAt; bot.fearGreedSource=fg.source||"unknown"; console.log(`[F&G] ${fg.value} (${fg.source}) publicado: ${fg.publishedAt||"desconocido"}`); });

  // Simulación histórica al arrancar (no bloquea el bot)
  const HIST_SYMBOLS = ["BTCUSDC","ETHUSDC","SOLUSDC","BNBUSDC","ADAUSDC","XRPUSDC","LINKUSDC","AVAXUSDC"];
  runHistoricalSimulation(HIST_SYMBOLS, "1h")
    .then(results => {
      bot.historicalResults = results;
      const summary = Object.entries(results).map(([p,v])=>`${p}:${Object.keys(v.bySymbol||{}).length}pares`).join(" ");
      console.log(`[PAPER] Simulación histórica OK — ${summary}`);

      // ── INYECTAR APRENDIZAJE HISTÓRICO EN Q-LEARNING ──────────────────────
      // Los trades simulados actualizan la tabla Q → bot llega pre-entrenado
      let injected = 0;
      for (const [period, result] of Object.entries(results)) {
        for (const [symbol, sim] of Object.entries(result.bySymbol||{})) {
        const trades = sim.trades || [];
        for (const t of trades) {
          if (!t.rsiEntry || !t.regime) continue;
          // Codificar estado de entrada
          const rsiBin = t.rsiEntry<25?'vs_low':t.rsiEntry<35?'low':t.rsiEntry<45?'mid_low':t.rsiEntry<55?'mid':'mid_high';
          const bbZone = t.bbEntry<0.15?'below_lower':t.bbEntry<0.35?'lower_half':t.bbEntry<0.65?'upper_half':'above_upper';
          const stateKey = `${t.regime}|${rsiBin}|${bbZone||'lower_half'}|neutral|normal|normal_vol`;
          // Reward: ganó → reforzar BUY, perdió → reforzar SKIP
          const reward = t.pnlPct > 0 ? Math.min(1.5, t.pnlPct * 15) : Math.max(-1.5, t.pnlPct * 15);
          const action = t.pnlPct > 0 ? "BUY" : "SKIP";
          bot.qLearning.update(stateKey, action, reward * 0.3, stateKey);
          // DQN: también inyectar experiencias históricas
          if (bot.dqn) {
            const dqnVec = bot.dqn.encodeState({
              rsi: t.rsiEntry||50,
              bbZone: t.bbEntry!=null ? (t.bbEntry<0.2?'below_lower':t.bbEntry<0.4?'lower_half':t.bbEntry<0.6?'upper_half':'above_upper') : 'lower_half',
              regime: t.regime||'LATERAL',
              trend: 'neutral',
              volumeRatio: 1, atrLevel: 1,
              fearGreed: 50, lsRatio: 1
            });
            const dqnAction = (t.pnlPct||0) > 0 ? "BUY" : "SKIP";
            const dqnReward = Math.max(-1.5, Math.min(1.5, (t.pnlPct||0) * 10));
            bot.dqn.remember(dqnVec, dqnAction, dqnReward * 0.3, dqnVec, false);
          }
          // PatternMemory
          if (bot.patternMemory && t.symbol) {
            bot.patternMemory.recordTrade(t.symbol, {
              rsiEntry: t.rsiEntry||50, bbEntry: {lower:0,mid:0.5,upper:1},
              entryPrice: t.entry||100, regime: t.regime,
              pnlPct: t.pnlPct||0, win: (t.pnlPct||0) > 0
            });
          }
          injected++;
        }
        } // end bySymbol
      }
      if (injected > 0) {
        console.log(`[PAPER] Aprendizaje histórico inyectado: ${injected} trades → Q-Learning + DQN actualizados`);
        // Fast-learn: trades sintéticos para llegar a Fase 2 más rápido
        runFastLearn(bot, 300).catch(e=>console.warn('[FAST-LEARN] Error:', e.message));
        // Pre-train DQN on historical data (multiple passes)
        if(bot.dqn && bot.dqn.replayBuffer.length >= 50) {
          let dqnLoss = 0;
          for(let i=0;i<10;i++) dqnLoss = bot.dqn.trainBatch();
          console.log(`[DQN] Pre-training: 10 batches, final loss: ${dqnLoss.toFixed(6)}`);
        }
      }

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
// Tres streams: miniTicker + kline_1m + depth (order book pressure)
const tickerStreams = PAIRS.map(p=>`${p.symbol.toLowerCase()}@miniTicker`).join("/");
const klineStreams  = ["BTCUSDC","ETHUSDC","SOLUSDC","BNBUSDC"].map(s=>`${s.toLowerCase()}@kline_1m`).join("/");
// Depth: solo para BTC y ETH (los más líquidos, marcan el tono del mercado)
const depthStreams  = ["BTCUSDC","ETHUSDC"].map(s=>`${s.toLowerCase()}@depth5@1000ms`).join("/");
const streamUrl = `wss://stream.binance.com:9443/stream?streams=${tickerStreams}/${klineStreams}/${depthStreams}`;

// Order book pressure cache: {symbol: {bidVol, askVol, ratio, pressure}}
if(!global.obPressure) global.obPressure = {};
let binanceLive=false, lastPriceTs=Date.now();

// OHLCV cache: {symbol: {open,high,low,close,volume,ts}[]}
if(!global.ohlcvCache) global.ohlcvCache = {};

function connectBinance() {
  const ws=new WebSocket(streamUrl);
  ws.on("open",    ()=>{ binanceLive=true; console.log("[BINANCE] ✓ Stream en vivo (ticker + kline_1m)"); });
  ws.on("message", raw=>{
    try{
      const msg=JSON.parse(raw);
      const data=msg.data||msg;
      if(!data||!bot) return;
      // miniTicker: precio en tiempo real
      if(data.e==="24hrMiniTicker"||data.c){
        bot.updatePrice(data.s,parseFloat(data.c));
        lastPriceTs=Date.now();
      }
      // depth: order book pressure + spoofing detection
      if(data.e==="depthUpdate"||data.lastUpdateId){
        const sym = data.s||data.symbol;
        if(sym && data.bids && data.asks) {
          const bidVol = data.bids.slice(0,5).reduce((s,b)=>s+parseFloat(b[1]),0);
          const askVol = data.asks.slice(0,5).reduce((s,a)=>s+parseFloat(a[1]),0);
          const total = bidVol + askVol || 1;
          const ratio = bidVol / (askVol || 1);
          const pressure = ratio > 2.0 ? "BUY" : ratio < 0.5 ? "SELL" : "NEUTRAL";

          // Spoofing detection: pared grande que aparece y desaparece en <10s
          const prev = global.obPressure[sym]||{};
          const prevBidMax = prev.maxBidLevel||0;
          const curBidMax = data.bids.length ? parseFloat(data.bids[0][1]) : 0;
          // Si había una pared grande (>5x el promedio) y desapareció → spoofing
          const isSpoofing = prevBidMax > bidVol*3 && curBidMax < prevBidMax*0.3;

          global.obPressure[sym] = {
            bidVol, askVol, ratio:+ratio.toFixed(2), pressure,
            maxBidLevel: curBidMax,
            spoofingDetected: isSpoofing,
            spoofingTs: isSpoofing ? Date.now() : (prev.spoofingTs||0),
          };
          if(isSpoofing) console.log(`[SPOOF] ${sym} pared falsa detectada → ignorar señal compra próximos 5min`);
        }
      }
      // kline_1m: vela completa → ATR real, volumen real
      if(data.e==="kline"&&data.k?.x){ // x=true cuando la vela está cerrada
        const k=data.k;
        const sym=k.s;
        if(!global.ohlcvCache[sym]) global.ohlcvCache[sym]=[];
        global.ohlcvCache[sym].push({
          open:parseFloat(k.o), high:parseFloat(k.h),
          low:parseFloat(k.l),  close:parseFloat(k.c),
          volume:parseFloat(k.v), ts:k.T
        });
        global.ohlcvCache[sym]=global.ohlcvCache[sym].slice(-200); // últimas 200 velas
        // Actualizar volumeHistory con volumen REAL
        if(bot.volumeHistory&&bot.volumeHistory[sym]){
          const recent=global.ohlcvCache[sym].slice(-5);
          const avgVol=recent.slice(0,-1).reduce((s,c)=>s+c.volume,0)/(recent.length-1||1);
          const curVol=recent[recent.length-1]?.volume||0;
          if(avgVol>0) bot.volumeHistory[sym]=[...(bot.volumeHistory[sym]||[]),[curVol/avgVol]].slice(-50);
        }
      }
    }catch(e){}
  });
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
    const newTradesThisTick = newTrades || [];
    ticks++;

    for(const trade of newTrades) {
      if(trade.type==="SELL") {
        if(trade.pnl<0){ const wasBl=blacklist.isBlacklisted(trade.symbol); blacklist.recordLoss(trade.symbol); if(!wasBl&&blacklist.isBlacklisted(trade.symbol)) tg.notifyBlacklist(trade.symbol); }
        else blacklist.recordWin(trade.symbol);
        // Notificar trades significativos (umbrales configurables desde Bafir)
        if(trade.type==="SELL"){
          const cfg=global._alertConfig||{paperWinPct:5,paperLossPct:4};
          if(trade.pnl>=cfg.paperWinPct) tg.notifyBigWin && tg.notifyBigWin(trade);
          if(trade.pnl<=-cfg.paperLossPct) tg.notifyBigLoss && tg.notifyBigLoss(trade);
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
      fetchLongShortRatio("BTCUSDT").then(ls=>{bot.longShortRatio=ls; if(ls.signal!=="NEUTRAL") console.log(`[L/S] ${ls.ratio} → ${ls.signal}`);}).catch(()=>{});
      fetchFundingRate("BTCUSDT").then(fr=>{bot.fundingRate=fr; if(fr.signal!=="NEUTRAL") console.log(`[FUND] ${fr.rate}% → ${fr.signal}`);}).catch(()=>{});
      fetchOpenInterest("BTCUSDT").then(oi=>{bot.openInterest=oi; console.log(`[OI] ${oi.change>0?"+":""}${oi.change}% → ${oi.trend}`);}).catch(()=>{});
      fetchTakerVolume("BTCUSDT").then(tv=>{bot.takerVolume=tv; if(tv.signal!=="NEUTRAL") console.log(`[TAKER] ${tv.ratio} → ${tv.signal}`);}).catch(()=>{});
      // Reddit sentiment cada 2h (señal más lenta pero gratis)
      if(Date.now()-(bot._lastRedditFetch||0)>7200000) {
        bot._lastRedditFetch=Date.now();
        fetchRedditSentiment().then(rs=>{bot.redditSentiment=rs; console.log(`[REDDIT] Score:${rs.score} ${rs.signal} (${rs.postCount} posts)`);}).catch(()=>{});
      }
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
    // Intraday replay cada 3h: aprende del día en curso (×100 velocidad)
    if(ticks%5400===0 && ticks>900 && Object.keys(bot.history).length>5) {
      const todaySells=(bot.log||[]).filter(l=>l.type==="SELL"&&l.ts&&new Date(l.ts).toDateString()===new Date().toDateString());
      if(todaySells.length>=5) {
        const wins=todaySells.filter(l=>l.pnl>0).length;
        const todayWR=Math.round(wins/todaySells.length*100);
        const todayAvgPnl=+(todaySells.reduce((s,l)=>s+(l.pnl||0),0)/todaySells.length).toFixed(2);
        // Si el día va mal (WR<35%), ajustar score mínimo hacia arriba
        if(todayWR<35 && todaySells.length>=8) {
          const cur=bot.optimizer.getParams();
          if(cur.minScore<72){
            bot.optimizer.params.minScore=Math.min(72,cur.minScore+3);
            console.log(`[INTRADAY-REPLAY] WR${todayWR}% → minScore subido a ${bot.optimizer.params.minScore}`);
          }
        }
        // Si va bien (WR>60%), relajar un poco para capturar más oportunidades
        else if(todayWR>60 && todaySells.length>=8) {
          const cur=bot.optimizer.getParams();
          if(cur.minScore>50){
            bot.optimizer.params.minScore=Math.max(50,cur.minScore-2);
            console.log(`[INTRADAY-REPLAY] WR${todayWR}% → minScore bajado a ${bot.optimizer.params.minScore}`);
          }
        }
        console.log(`[INTRADAY-REPLAY] Hoy: ${todaySells.length} ops WR${todayWR}% avgPnl${todayAvgPnl}%`);
      }
    }
    // Re-simulación histórica cada 6h con datos frescos de Binance
    // Intradía WF - cada 1800 ticks (~1h) usa historial en RAM, sin API
    if(ticks%1800===0 && ticks>0) {
      try {
        const intradayWF = runIntradayWalkForward(bot);
        if(intradayWF) {
          bot._intradayWF = intradayWF;
          if(intradayWF.verdict==="SOBREAJUSTE") {
            console.warn(`[WF-INTRA] ⚠️ Ratio ${intradayWF.avgRatio} — ${intradayWF.verdict}`);
            tg.send && tg.send(`⚠️ <b>[PAPER] WF intradía</b>\nRatio: ${intradayWF.avgRatio} — ${intradayWF.verdict}\n${intradayWF.robustCount}/${intradayWF.totalSymbols} pares robustos`);
          } else {
            console.log(`[WF-INTRA] Ratio ${intradayWF.avgRatio} — ${intradayWF.verdict} (${intradayWF.robustCount}/${intradayWF.totalSymbols})`);
          }
        }
      } catch(e) { console.warn('[WF-INTRA]', e.message); }
    }

    // Full 3-level WF cada 6h (21600 ticks)
    if(ticks%21600===1 && ticks>1) {
      const WF_SYMS = ["BTCUSDC","ETHUSDC","SOLUSDC","BNBUSDC"];
      runMultiTimeframeWF(bot, WF_SYMS).then(wf => {
        bot._multiWF = wf;
        console.log(`[WF-MULTI] ${wf.verdict} | Combined: ${wf.combined}`);
        tg.send && tg.send(
          `📊 <b>[PAPER] Walk-Forward 3 niveles</b>\n\n`+
          `⏱ Intradía: ${wf.intraday?.verdict||"—"} (ratio ${wf.intraday?.avgRatio||"—"})\n`+
          `📅 Semanal: ${wf.weekly?.verdict||"—"} (ratio ${wf.weekly?.avgOverfitRatio||"—"})\n`+
          `📆 Mensual: ${wf.monthly?.verdict||"—"} (ratio ${wf.monthly?.avgOverfitRatio||"—"})\n\n`+
          `<b>Global: ${wf.verdict}</b>\n<i>${wf.recommendation}</i>`
        );
      }).catch(e=>console.warn('[WF-MULTI]', e.message));
    }

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
    // Sync inteligente al live cada hora: régimen+pares+multiAgent
    if(ticks%1800===0 && bot.qLearning) {
      const qStats = bot.qLearning.getTopStates ? bot.qLearning.getTopStates(20) : [];
      const goodStates = qStats.filter(s=>s.bestAction?.[1]>0.3);

      // Calcular mejor par por régimen en las últimas 200 operaciones
      const recentSells = (bot.log||[]).filter(l=>l.type==="SELL"&&l.pnl!=null).slice(-200);
      const regimePairPerf = {};
      for(const t of recentSells) {
        const key = `${t.regime||"UNKNOWN"}|${t.symbol}`;
        if(!regimePairPerf[key]) regimePairPerf[key]={wins:0,total:0,pnl:0};
        regimePairPerf[key].total++;
        regimePairPerf[key].pnl+=t.pnl||0;
        if((t.pnl||0)>0) regimePairPerf[key].wins++;
      }
      const bestPairsByRegime = {};
      for(const [key,perf] of Object.entries(regimePairPerf)) {
        const [regime,sym]=key.split("|");
        const wr=perf.total>=3?perf.wins/perf.total:0;
        if(!bestPairsByRegime[regime]||wr>bestPairsByRegime[regime].wr) {
          bestPairsByRegime[regime]={symbol:sym,wr:+wr.toFixed(2),trades:perf.total,avgPnl:+(perf.pnl/perf.total).toFixed(2)};
        }
      }

      if(goodStates.length>0 || Object.keys(bestPairsByRegime).length>0) {
        const body=JSON.stringify({
          secret:process.env.SYNC_SECRET||"bafir_sync_secret_2024",
          dailyLearning:{
            winRate:bot.recentWinRate()||0,
            avgPnl:0, nTrades:1,
            regime:bot.marketRegime,
            optimizerParams:bot.optimizer.getParams(),
            qTopStates:goodStates,
          },
          positive:false, hasLearning:true,
          bestPairsByRegime, // qué pares funcionan mejor en cada régimen
          multiAgentStats:bot.multiAgent?.getAllStats()||null,
          kellyStats: recentSells.length>=10 ? {
            winRate:Math.round(recentSells.filter(l=>l.pnl>0).length/recentSells.length*100),
            avgWin:+(recentSells.filter(l=>l.pnl>0).reduce((s,l)=>s+l.pnl,0)/(recentSells.filter(l=>l.pnl>0).length||1)).toFixed(2),
            avgLoss:+(Math.abs(recentSells.filter(l=>l.pnl<0).reduce((s,l)=>s+l.pnl,0))/(recentSells.filter(l=>l.pnl<0).length||1)).toFixed(2),
          } : null,
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

    // Paper shadow: notificar al live de operaciones para validación A/B
    if(newTradesThisTick && newTradesThisTick.length > 0) {
      const liveUrl = process.env.LIVE_BOT_URL||"";
      const BOT_SECRET = process.env.BOT_SECRET||"bafir_bot_secret";
      if(liveUrl) {
        for(const t of newTradesThisTick) {
          try {
            const endpoint = t.type==="BUY" ? "/api/shadow/entry" : "/api/shadow/exit";
            const payload = t.type==="BUY"
              ? {secret:BOT_SECRET, symbol:t.symbol, entryPrice:t.price, strategy:t.strategy, regime:bot.marketRegime, stateKey:""}
              : {secret:BOT_SECRET, symbol:t.symbol, exitPrice:t.price, pnl:t.pnl};
            const body = JSON.stringify(payload);
            const mod2 = liveUrl.startsWith("https")?require("https"):require("http");
            const u = new URL(endpoint, liveUrl);
            const r2 = mod2.request({hostname:u.hostname,path:u.pathname,method:"POST",
              headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},()=>{});
            r2.on("error",()=>{}); r2.write(body); r2.end();
          } catch(e) {}
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
