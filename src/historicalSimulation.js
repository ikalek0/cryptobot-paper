// historicalSimulation.js — Simulación histórica con klines reales de Binance
// Períodos: bull 2021, crash 2022, lateral 2023, reciente
// Usa https nativo (sin dependencias externas)

const https = require('https');

const PERIODS = [
  { name: 'bull_2021',    start: 1609459200000, end: 1640995199000, label: 'Bull 2021' },
  { name: 'crash_2022',   start: 1641024000000, end: 1672559999000, label: 'Crash 2022' },
  { name: 'lateral_2023', start: 1672560000000, end: 1704095999000, label: 'Lateral 2023' },
  { name: 'recent',       start: Date.now() - 30 * 24 * 3600 * 1000, end: Date.now(), label: 'Reciente 30d' },
];

async function fetchKlines(symbol, interval, startTime, endTime, limit = 500) {
  const params = new URLSearchParams({ symbol, interval, startTime, endTime, limit }).toString();
  const url = `https://api.binance.com/api/v3/klines?${params}`;
  const data = await new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
  if (!Array.isArray(data)) throw new Error(`Binance error: ${JSON.stringify(data)}`);
  return data.map(k => ({
    openTime: k[0],
    open:  parseFloat(k[1]),
    high:  parseFloat(k[2]),
    low:   parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
  }));
}

async function fetchAllKlinesForPeriod(symbol, interval, startTime, endTime) {
  const all = [];
  let cursor = startTime;
  const intervalMs = intervalToMs(interval);
  const maxCandles = 500;
  while (cursor < endTime) {
    const batch = await fetchKlines(symbol, interval, cursor, endTime, maxCandles);
    if (!batch.length) break;
    all.push(...batch);
    cursor = batch[batch.length - 1].closeTime + 1;
    await sleep(100);
  }
  return all;
}

function intervalToMs(interval) {
  const map = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
  return map[interval] || 3600000;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── EMA helpers ──────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = gains / (losses || 1);
  return 100 - 100 / (1 + rs);
}

function calcBB(closes, period = 20, mult = 2) {
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  return { upper: mean + mult * std, lower: mean - mult * std, middle: mean, std };
}

function calcATR(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, trs.length);
}

function detectRegime(closes) {
  if (closes.length < 50) return 'LATERAL';
  const ema20 = calcEMA(closes.slice(-20), 20);
  const ema50 = calcEMA(closes.slice(-50), 50);
  const last = closes[closes.length - 1];
  if (last > ema20 && ema20 > ema50) return 'BULL';
  if (last < ema20 && ema20 < ema50) return 'BEAR';
  return 'LATERAL';
}

// ── Core simulation ───────────────────────────────────────────────────────────
function simulatePeriod(symbol, candles, initialCapital = 50000) {
  if (candles.length < 60) return null;

  let cash = initialCapital;
  let position = null;
  const trades = [];
  const equity = [{ time: candles[0].openTime, value: cash }];

  for (let i = 50; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const closes = slice.map(c => c.close);
    const price = candles[i].close;
    const rsi = calcRSI(closes);
    const bb = calcBB(closes);
    const atr = calcATR(slice);
    const regime = detectRegime(closes);

    // Exit logic
    if (position) {
      const pnl = (price - position.entry) * position.qty;
      const pnlPct = pnl / (position.entry * position.qty);
      const stopHit = price < position.stop;
      const targetHit = price > position.target;
      const rsiExit = rsi > 70 && regime === 'BULL';
      const bbExit = price > bb.upper && regime === 'LATERAL';

      if (stopHit || targetHit || rsiExit || bbExit) {
        const exitReason = stopHit ? 'stop' : targetHit ? 'target' : rsiExit ? 'rsi70' : 'bb_upper';
        cash += price * position.qty;
        trades.push({
          symbol,
          entry: position.entry,
          exit: price,
          qty: position.qty,
          pnl,
          pnlPct,
          regime: position.regime,
          rsiEntry: position.rsiEntry,
          exitReason,
          entryTime: position.entryTime,
          exitTime: candles[i].openTime,
        });
        position = null;
      }
    }

    // Entry logic
    if (!position && cash > 0) {
      let signal = false;
      if (regime === 'BULL' && rsi < 40) signal = true;
      if (regime === 'LATERAL' && price < bb.lower && rsi < 35) signal = true;
      if (regime === 'BEAR' && rsi < 20) signal = true;

      if (signal) {
        const riskAmt = cash * 0.02;
        const stop = price - atr * 2;
        const riskPer = price - stop;
        if (riskPer > 0) {
          const qty = Math.min(riskAmt / riskPer, (cash * 0.25) / price);
          const cost = qty * price;
          if (cost <= cash && qty > 0) {
            cash -= cost;
            position = {
              entry: price,
              qty,
              stop,
              target: price + atr * 3,
              regime,
              rsiEntry: rsi,
              entryTime: candles[i].openTime,
            };
          }
        }
      }
    }

    equity.push({ time: candles[i].closeTime, value: cash + (position ? position.qty * price : 0) });
  }

  // Close any open position at last price
  if (position) {
    const lastPrice = candles[candles.length - 1].close;
    const pnl = (lastPrice - position.entry) * position.qty;
    cash += lastPrice * position.qty;
    trades.push({
      symbol,
      entry: position.entry,
      exit: lastPrice,
      qty: position.qty,
      pnl,
      pnlPct: pnl / (position.entry * position.qty),
      regime: position.regime,
      rsiEntry: position.rsiEntry,
      exitReason: 'end',
      entryTime: position.entryTime,
      exitTime: candles[candles.length - 1].closeTime,
    });
  }

  const totalReturn = (cash - initialCapital) / initialCapital;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;

  // Max drawdown
  let peak = equity[0].value, maxDD = 0;
  for (const e of equity) {
    if (e.value > peak) peak = e.value;
    const dd = (peak - e.value) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    symbol,
    totalReturn,
    totalTrades: trades.length,
    winRate: wins.length / (trades.length || 1),
    avgWin,
    avgLoss,
    maxDrawdown: maxDD,
    sharpe: calcSharpe(equity),
    trades,
    equity,
  };
}

function calcSharpe(equity) {
  if (equity.length < 2) return 0;
  const returns = [];
  for (let i = 1; i < equity.length; i++) {
    returns.push((equity[i].value - equity[i - 1].value) / equity[i - 1].value);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  return std > 0 ? (mean / std) * Math.sqrt(365) : 0;
}

// ── Public API ────────────────────────────────────────────────────────────────
async function runHistoricalSimulation(symbols, interval = '1h') {
  console.log('[HistSim] Iniciando simulación histórica...');
  const results = {};

  for (const period of PERIODS) {
    results[period.name] = { label: period.label, bySymbol: {} };
    for (const symbol of symbols) {
      try {
        console.log(`[HistSim] ${period.label} - ${symbol}`);
        const candles = await fetchAllKlinesForPeriod(symbol, interval, period.start, period.end);
        if (candles.length < 60) { console.log(`[HistSim] Insuficientes velas: ${symbol}`); continue; }
        const sim = simulatePeriod(symbol, candles);
        if (sim) results[period.name].bySymbol[symbol] = sim;
        await sleep(200);
      } catch (e) {
        console.error(`[HistSim] Error ${symbol} ${period.label}:`, e.message);
      }
    }
  }

  // Aggregate per period
  for (const period of PERIODS) {
    const sims = Object.values(results[period.name].bySymbol);
    if (!sims.length) continue;
    results[period.name].summary = {
      avgReturn: sims.reduce((s, r) => s + r.totalReturn, 0) / sims.length,
      avgWinRate: sims.reduce((s, r) => s + r.winRate, 0) / sims.length,
      avgDrawdown: sims.reduce((s, r) => s + r.maxDrawdown, 0) / sims.length,
      avgSharpe: sims.reduce((s, r) => s + r.sharpe, 0) / sims.length,
      totalTrades: sims.reduce((s, r) => s + r.totalTrades, 0),
    };
  }

  console.log('[HistSim] Simulación histórica completada.');
  return results;
}


// ── Fast-Learn: inyecta trades sintéticos para acelerar aprendizaje ──────────
function generateFastLearnTrades(count=500, marketContext={}) {
  const fg = marketContext.fearGreed||50;
  const regime = marketContext.regime||"LATERAL";
  const lsRatio = marketContext.lsRatio||1.0;
  // Win probabilities calibrated to current market
  const winProbs = {
    BULL:    fg>60?0.60:fg>40?0.52:0.48,
    LATERAL: fg<20?0.48:fg<40?0.44:0.40,
    BEAR:    fg<15?0.42:fg<25?0.36:0.30,
  };
  // Regime distribution weighted to current regime
  const regimeDist = regime==="BULL"
    ? ["BULL","BULL","BULL","LATERAL","LATERAL","BEAR"]
    : regime==="BEAR"
    ? ["BEAR","BEAR","LATERAL","LATERAL","BULL","BEAR"]
    : ["LATERAL","LATERAL","LATERAL","BEAR","BULL","LATERAL"];
  const symbols=["BTCUSDC","ETHUSDC","SOLUSDC","BNBUSDC","ADAUSDC","XRPUSDC","LINKUSDC","BNBUSDC"];
  const trades=[];
  for(let i=0;i<count;i++){
    const tradeRegime=regimeDist[Math.floor(Math.random()*regimeDist.length)];
    const symbol=symbols[Math.floor(Math.random()*symbols.length)];
    const rsiBase=tradeRegime==="BULL"?28:tradeRegime==="BEAR"?18:32;
    const rsiEntry=rsiBase+Math.random()*15;
    const lsAdj=lsRatio>2?-0.05:lsRatio<0.8?+0.05:0;
    const win=Math.random()<((winProbs[tradeRegime]||0.44)+lsAdj);
    const pnlPct=win
      ?(tradeRegime==="BULL"?0.7+Math.random()*2.0:0.25+Math.random()*1.2)
      :-(0.12+Math.random()*0.45);
    trades.push({symbol,regime:tradeRegime,rsiEntry:+rsiEntry.toFixed(1),
      pnlPct:+pnlPct.toFixed(3),win,synthetic:true,
      fg:Math.round(fg+(Math.random()-0.5)*10),
      ts:new Date(Date.now()-(count-i)*300000).toISOString()});
  }
  return trades;
}

async function runFastLearn(bot, targetTrades=2000) {
  // Obtener contexto de mercado actual para calibrar los sintéticos
  const marketContext = {
    fearGreed: bot.fearGreed || 50,
    regime: bot.marketRegime || "LATERAL",
    lsRatio: bot.longShortRatio?.ratio || 1.0,
  };
  console.log(`[FAST-LEARN] Contexto: F&G=${marketContext.fearGreed} régimen=${marketContext.regime} L/S=${marketContext.lsRatio}`);
  if(!bot) return 0;
  const existing=(bot.log||[]).filter(l=>l.type==='SELL').length;
  if(existing>=targetTrades){ console.log(`[FAST-LEARN] Ya tiene ${existing} trades — skip`); return 0; }
  const needed=Math.max(0, targetTrades-existing);
  const trades=generateFastLearnTrades(needed, marketContext);
  let injected=0;
  for(const t of trades){
    try{
      const stateKey=bot.qLearning.encodeState({rsi:t.rsiEntry,bbZone:t.rsiEntry<30?'below_lower':'lower_half',
        regime:t.regime,trend:t.regime==='BULL'?'up':t.regime==='BEAR'?'down':'neutral',
        volumeRatio:1,atrLevel:1,fearGreed:50});
      const action=t.win?'BUY':'SKIP';
      bot.qLearning.update(stateKey,action,t.pnlPct*0.2,stateKey);
      if(bot.dqn){
        const v=bot.dqn.encodeState({rsi:t.rsiEntry,bbZone:'lower_half',regime:t.regime,
          trend:'neutral',volumeRatio:1,atrLevel:1,fearGreed:50,lsRatio:1});
        bot.dqn.remember(v,action,t.pnlPct*0.2,v);
      }
      if(bot.multiAgent&&bot.dqn){
        const v=bot.dqn.encodeState({rsi:t.rsiEntry,bbZone:'lower_half',regime:t.regime,
          trend:'neutral',volumeRatio:1,atrLevel:1,fearGreed:50,lsRatio:1});
        bot.multiAgent.learnFromTrade(t.regime,v,action,t.pnlPct*0.2,v,t.pnlPct);
      }
      if(bot.stratEval) bot.stratEval.recordTrade('ENSEMBLE',t.regime,t.pnlPct);
      injected++;
    }catch(e){}
  }
  if(bot.dqn&&bot.dqn.replayBuffer.length>=50){
    for(let b=0;b<Math.min(30,Math.floor(injected/10));b++) bot.dqn.trainBatch();
  }
  console.log(`[FAST-LEARN] ✅ ${injected} trades sintéticos | DQN: ${bot.dqn?.totalUpdates||0} updates | Ahora en Fase ${(existing+injected)<100?1:(existing+injected)<500?2:3}`);
  return injected;
}

module.exports = { runFastLearn, runHistoricalSimulation, simulatePeriod, fetchAllKlinesForPeriod };
