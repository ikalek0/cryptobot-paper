// ─── CRYPTOBOT PAPER — SERVER ─────────────────────────────────────────────────
// Instancia de aprendizaje: opera agresivamente en paper para
// optimizar parámetros y exportarlos al bot LIVE cuando son buenos.
"use strict";
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const express    = require("express");
const http       = require("http");
const path       = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const { CryptoBotFinal, PAIRS }       = require("./engine");
const { ensureTradeLogTable, logTrade } = require("./trade_logger");
const { scheduleWeeklyReport, scheduleTradeAnalysisReminder } = require("./weekly_report");
const { saveState, loadState, deleteState, getClient } = require("./database");
const { Blacklist, MarketGuard, getTradingScore } = require("./market");
const { CryptoPanicDefense } = require("./cryptoPanic");
const { fetchFearGreed, fetchNewsAlert, fetchAllKlines, runNightlyReplay } = require("./feeds");
const { exportParams, calcSyncStats } = require("./sync");
const { runHistoricalSimulation }     = require("./historicalSimulation");
const tg         = require("./telegram");


let _cachedSentiment = { composite: 50, fearGreed: { value: 50, label: "Neutral" }, lastUpdate: 0 };
function fetchSentimentData() {
  const http = require("http");
  return new Promise((res, rej) => {
    const req = http.get("http://localhost:3004/api/sentiment", r => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => { try { res(JSON.parse(d)); } catch(e) { rej(e); } });
    });
    req.on("error", rej);
    req.setTimeout(5000, () => { req.destroy(); rej(new Error("timeout")); });
  });
}
async function updateSentimentFromService() {
  try { const data = await fetchSentimentData(); _cachedSentiment = data; return data; }
  catch(e) { return _cachedSentiment; }
}
const PORT    = process.env.PORT    || 3002;
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

const blacklist   = new Blacklist(3, 12); // Cooldown más corto en paper (12h)
const marketGuard = new MarketGuard();
const cryptoPanic = new CryptoPanicDefense();
// cryptoPanic.start(); — disabled: rate limited

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, "../public")));
app.use(express.json());
// ── Basic Auth ──────────────────────────────────────────────────────────────
const BASIC_USER = process.env.AUTH_USER || "bafir";
const BASIC_PASS = process.env.AUTH_PASS || "bafir2026";
app.use((req, res, next) => {
  // Allow API calls from localhost (bots calling each other)
  if(req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1") return next();
  // Allow /api/* without auth so bots can consume sentiment/arb data
  if(req.path.startsWith("/api/")) return next();
  const auth = req.headers["authorization"];
  if(!auth || !auth.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="BAFIR Trading"');
    return res.status(401).send("Acceso restringido");
  }
  const [user, pass] = Buffer.from(auth.slice(6), "base64").toString().split(":");
  if(user !== BASIC_USER || pass !== BASIC_PASS) {
    res.set("WWW-Authenticate", 'Basic realm="BAFIR Trading"');
    return res.status(401).send("Credenciales incorrectas");
  }
  next();
});


function broadcast(msg) {
  const d = JSON.stringify(msg);
  wss.clients.forEach(c => { if(c.readyState===WebSocket.OPEN) c.send(d); });
}

app.get("/api/state",  (_,res) => res.json(bot ? { ...bot.getState(), instance:"PAPER", blacklist:blacklist.getStatus() } : {}));
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
  tg.startCommandListener(() => ({ ...bot.getState(), instance:"PAPER" }));

  // ── Pre-popular candle cache con klines históricas reales (Opus 4) ──────────
  // Da al ML 6 meses de contexto antes de operar en vivo
  // Prefill 2500 velas 1h (~104 días) por par — cubre bull/bear/lateral
  const PREFILL_SYMS = ["BTCUSDC","ETHUSDC","SOLUSDC","BNBUSDC","XRPUSDC"];
  (async () => {
    for(const sym of PREFILL_SYMS) {
      try {
        // 3 requests × 1000 candles = 3000 velas (~125 días de 1h)
        const allKlines = [];
        let endTime = null;
        for(let page=0; page<3; page++) {
          let url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1h&limit=1000`;
          if(endTime) url += `&endTime=${endTime}`;
          const batch = await new Promise((res,rej)=>{
            const https=require("https");
            const t=setTimeout(()=>rej(new Error("timeout")),15000);
            https.get(url,r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>{clearTimeout(t);try{res(JSON.parse(d));}catch(e){rej(e);}});}).on("error",rej);
          });
          if(!batch.length) break;
          for(let i=batch.length-1;i>=0;i--) allKlines.unshift(batch[i]);
          endTime = batch[0][0]-1;
          await new Promise(r=>setTimeout(r,300));
        }
        if(allKlines.length < 10) continue;
        global.ohlcvCache[sym] = allKlines.map(k=>({
          open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5], ts:k[0]
        }));
        global.candleCache[sym+"_1h"] = global.ohlcvCache[sym].map(c=>({...c,start:c.ts}));
        console.log("[PAPER-HIST] "+sym+": "+allKlines.length+" velas 1h (~"+Math.round(allKlines.length/24)+"d) precargadas");
        await new Promise(r=>setTimeout(r,500));
      } catch(e) { console.warn("[PAPER-HIST] prefill "+sym+":", e.message); }
    }
    console.log("[PAPER-HIST] ✅ Prefill completo — DQN tiene contexto de "+PREFILL_SYMS.length+" pares");
  })();

  updateSentimentFromService().then(d=>{bot.fearGreed=d?.fearGreed?.value??d?.composite??50;bot.fearGreedSource='bafir-sentiment';}).catch(()=>{});

  // Simulación histórica al arrancar (no bloquea el bot)
  const HIST_SYMBOLS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","ADAUSDT","XRPUSDT","LINKUSDT","AVAXUSDT"];
  runHistoricalSimulation(HIST_SYMBOLS, "1h")
    .then(results => {
      bot.historicalResults = results;
      const summary = Object.entries(results).map(([p,v])=>`${p}:${Object.keys(v.bySymbol||{}).length}pares`).join(" ");
      console.log(`[PAPER] Simulación histórica OK — ${summary}`);
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
  ws.on("message", raw=>{ try{
    const data=JSON.parse(raw)?.data||JSON.parse(raw);
    if(data?.s&&data?.c&&bot){
      const price=parseFloat(data.c);
      bot.updatePrice(data.s,price);
      lastPriceTs=Date.now();
      // Accumulate tick into synthetic 1m candle, then build 30m/1h/4h
      if(!global.ohlcvCache[data.s]) global.ohlcvCache[data.s]=[];
      const now=Date.now(), barStart=Math.floor(now/60000)*60000;
      const last=global.ohlcvCache[data.s].slice(-1)[0];
      if(!last||last.ts!==barStart) {
        global.ohlcvCache[data.s].push({open:price,high:price,low:price,close:price,volume:0,ts:barStart});
        global.ohlcvCache[data.s]=global.ohlcvCache[data.s].slice(-200);
      } else {
        last.high=Math.max(last.high,price);
        last.low=Math.min(last.low,price);
        last.close=price;
      }
      _buildHigherTFCandle(data.s, global.ohlcvCache[data.s]);
    }
  }catch(e){} });
  ws.on("close",   ()=>{ binanceLive=false; setTimeout(connectBinance,5000); });
  ws.on("error",   e=>console.error("[BINANCE]",e.message));
}

// ── Higher TF candle accumulators (Opus 4: paper migra a velas reales) ──────
global.candleCache   = global.candleCache   || {}; // "BTCUSDC_1h" → candles[]
global.candleCurrent = global.candleCurrent || {}; // current open bar per sym+tf
const TF_MINUTES = { "30m":30, "1h":60, "4h":240 };

function _buildHigherTFCandle(sym, ohlcv1m) {
  if(!ohlcv1m?.length) return;
  const last = ohlcv1m[ohlcv1m.length-1];
  if(!last?.ts) return;
  for(const [tf, mins] of Object.entries(TF_MINUTES)) {
    const key = sym+"_"+tf;
    const barMs = mins*60*1000;
    const barStart = Math.floor(last.ts/barMs)*barMs;
    if(!global.candleCurrent[key]) {
      global.candleCurrent[key]={open:last.open,high:last.high,low:last.low,close:last.close,volume:last.volume||0,start:barStart};
    }
    const cur=global.candleCurrent[key];
    if(barStart>cur.start) {
      if(!global.candleCache[key]) global.candleCache[key]=[];
      global.candleCache[key].push({...cur,close:last.close});
      if(global.candleCache[key].length>300) global.candleCache[key].shift();
      global.candleCurrent[key]={open:last.open,high:last.high,low:last.low,close:last.close,volume:last.volume||0,start:barStart};
      // Update ohlcvCache with the closed 1h candle for ML features
      if(tf==="1h"&&bot) {
        if(!global.ohlcvCache[sym]) global.ohlcvCache[sym]=[];
        const c=global.candleCache[key].slice(-1)[0];
        if(c&&global.ohlcvCache[sym].slice(-1)[0]?.ts!==c.start) {
          global.ohlcvCache[sym].push({open:c.open,high:c.high,low:c.low,close:c.close,volume:c.volume||0,ts:c.start});
          global.ohlcvCache[sym]=global.ohlcvCache[sym].slice(-200);
        }
      }
    } else {
      cur.high=Math.max(cur.high,last.high); cur.low=Math.min(cur.low,last.low);
      cur.close=last.close; cur.volume=(cur.volume||0)+(last.volume||0);
    }
  }
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

    const marketState=marketGuard.update(bot.prices["BTCUSDT"]);
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
        // Structured trade log → PostgreSQL
        // BUG-M (24 abr 2026): logTrade usaba `client` no declarado → trade_log
        // siempre vacío en paper. Fix: obtener el pool via getClient() (exportado
        // post-76108e6) y llamar logTrade con él. Silenciar fallos (try/catch) para
        // no tumbar el loop si PG está down.
        try {
          const db = await getClient();
          // BUG-R2 (24 abr 2026): antes el objeto trade venía sin entryPrice/
          // openTs/investUsdc/rsiAtEntry → server caía al `|| null` y todos los
          // trades paper quedaban con esas columnas NULL. Engine ahora los
          // popula (commit BUG-R2 en engine.js); server los pasa tal cual.
          if (db) await logTrade(db, {
            bot:"paper", symbol:trade.symbol, strategy:trade.strategy||"DQN",
            openTs:trade.openTs||null, closeTs:Date.now(),
            entryPrice:trade.entryPrice||null, exitPrice:trade.price||null,
            pnlPct:trade.pnl, investUsdc:trade.investUsdc||null,
            reason:trade.reason||null,
            regime:bot.marketRegime||"UNKNOWN",
            rsiAtEntry:trade.rsiAtEntry||null,
            fearGreed:bot.fearGreed||null,
            hourUtc:new Date().getUTCHours(),
          });
        } catch(e) {}
      }
    }

    if(circuitBreaker?.triggered&&!cbNotified){ tg.notifyCircuitBreaker(circuitBreaker.drawdown); cbNotified=true; }
    if(!circuitBreaker?.triggered) cbNotified=false;
    if(drawdownAlert?.triggered) tg.notifyMaxDrawdown(drawdownAlert);
    if(!circuitBreaker?.triggered) cbNotified=false;
    if(optimizerResult?.changes?.length>0) tg.notifyOptimizer(optimizerResult);

    // Fear & Greed cada hora
    if(Date.now()-lastFearGreedCheck>3600000){
      lastFearGreedCheck=Date.now();
      updateSentimentFromService().then(d=>{bot.fearGreed=d?.fearGreed?.value??d?.composite??50;bot.fearGreedSource='bafir-sentiment';}).catch(()=>{});
    }

    // Noticias cada 10 min
    if(ticks%300===0){ fetchNewsAlert().then(news=>{ if(news?.negative) tg.notifyNewsAlert(news); }); }

    // ── REPLAY NOCTURNO + EXPORTAR AL LIVE ───────────────────────────────────
    const replayKey=new Date().toDateString()+"_02";
    if(new Date().getUTCHours()===2&&lastNightlyReplay!==replayKey&&Object.keys(bot.history).length>0){
      lastNightlyReplay=replayKey;
      console.log("[PAPER] Replay nocturno + descargando klines de Binance…");
      // Descargar klines reales de Binance para enriquecer el replay
      const klines=await fetchAllKlines(["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","ADAUSDT","XRPUSDT"],"1h",500).catch(()=>({}));
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

    broadcast({ type:"tick", data:{ ...bot.getState(), signals, newTrades, circuitBreaker, optimizerResult, binanceLive, instance:"PAPER", marketDefensive:marketGuard.isDefensive(), tradingHour:getTradingScore(), dailyPnlPct:bot._dailyPnlPct||0, momentumMult:bot.hourMultiplier } });

    // Enviar equity a BAFIR como instancia paper
    if(ticks%60===0) sendEquityToBafirPaper(bot.totalValue());

    if(ticks%20===0) save().catch(e=>console.error("[SAVE]",e));

  }, TICK_MS);

  scheduleWeeklyReport(tg, null, "paper", null);
scheduleTradeAnalysisReminder(tg, null, "paper");

server.listen(PORT, ()=>console.log(`\n📋 CRYPTOBOT PAPER en http://localhost:${PORT} | Capital: $${CAPITAL_USDT} USDT\n`));
}

wss.on("connection", ws=>{ if(bot) ws.send(JSON.stringify({type:"state",data:{...bot.getState(),instance:"PAPER"}})); });
