// ─── CRYPTOBOT ENGINE v3.1 — DQN 12 features, dim mismatch fix — ESTRATEGIA ADAPTATIVA + Q-LEARNING + ENSEMBLE ─────
"use strict";

const { RISK_PROFILES, CircuitBreaker, TrailingStop, calcPositionSize, AutoOptimizer } = require("./risk");
const { PatternMemory }    = require("./patternMemory");
const { DQN }             = require("./dqn");
const { MultiAgentSystem }   = require("./multiAgent");
const { StrategyEvaluator } = require("./strategyEvaluator");
const { RiskLearning }     = require("./riskLearning");
const { CorrelationManager } = require("./correlationManager");
const { AdaptiveStopLoss, AdaptiveHours, NewsImpactLearner, AdaptiveRegimeDetector, calcAdaptiveLR, calcAdaptiveKelly, calcRealKelly } = require("./adaptive_learning");
const { QLearning, EnsembleVoter } = require("./qlearning");
const { IntradayTrend }    = require("./intradayTrend");
const { analyzeCounterfactual, CounterfactualMemory } = require("./counterfactual");

const INITIAL_CAPITAL  = parseFloat(process.env.CAPITAL_USDC || process.env.CAPITAL_USDT || "50000");
const MIN_CASH_RESERVE = 0.15;
const PUMP_THRESHOLD   = 0.08;
const REENTRY_COOLDOWN = 2 * 60 * 60 * 1000;
const BNB_FEE          = 0.00075;
const NORMAL_FEE       = 0.001;
const MAX_DRAWDOWN_PCT = 0.15;
// PAPER: sin circuit breaker ni blacklist — aprender en todas las condiciones

const PAIRS = [
  { symbol:"BTCUSDC",  name:"Bitcoin",   short:"BTC",  category:"L1",   group:"major" },
  { symbol:"ETHUSDC",  name:"Ethereum",  short:"ETH",  category:"L1",   group:"major" },
  { symbol:"SOLUSDC",  name:"Solana",    short:"SOL",  category:"L1",   group:"alt1"  },
  { symbol:"BNBUSDC",  name:"BNB",       short:"BNB",  category:"L1",   group:"alt1"  },
  { symbol:"AVAXUSDC", name:"Avalanche", short:"AVAX", category:"L1",   group:"alt2"  },
  { symbol:"ADAUSDC",  name:"Cardano",   short:"ADA",  category:"L1",   group:"alt2"  },
  { symbol:"DOTUSDC",  name:"Polkadot",  short:"DOT",  category:"L1",   group:"alt2"  },
  { symbol:"LINKUSDC", name:"Chainlink", short:"LINK", category:"DeFi", group:"defi"  },
  { symbol:"UNIUSDC",  name:"Uniswap",   short:"UNI",  category:"DeFi", group:"defi"  },
  { symbol:"AAVEUSDC", name:"Aave",      short:"AAVE", category:"DeFi", group:"defi"  },
  { symbol:"XRPUSDC",  name:"Ripple",    short:"XRP",  category:"Pago", group:"pay"   },
  { symbol:"LTCUSDC",  name:"Litecoin",  short:"LTC",  category:"Pago", group:"pay"   },
  // Nuevos pares
  { symbol:"POLUSDC",name:"Polygon (POL)",   short:"POL",category:"L2",   group:"l2"    },
  { symbol:"OPUSDC",   name:"Optimism",  short:"OP",   category:"L2",   group:"l2"    },
  { symbol:"ARBUSDC",  name:"Arbitrum",  short:"ARB",  category:"L2",   group:"l2"    },
  { symbol:"ATOMUSDC", name:"Cosmos",    short:"ATOM", category:"L1",   group:"alt3"  },
  { symbol:"NEARUSDC", name:"NEAR",      short:"NEAR", category:"L1",   group:"alt3"  },
  { symbol:"APTUSDC",  name:"Aptos",     short:"APT",  category:"L1",   group:"alt3"  },
  // ── USDT: mejor liquidez para los mismos activos ─────────────────────────
  { symbol:"BTCUSDT",  name:"Bitcoin",   short:"BTC",  category:"L1",   group:"major", quoteAsset:"USDT" },
  { symbol:"ETHUSDT",  name:"Ethereum",  short:"ETH",  category:"L1",   group:"major", quoteAsset:"USDT" },
  { symbol:"SOLUSDT",  name:"Solana",    short:"SOL",  category:"L1",   group:"alt1",  quoteAsset:"USDT" },
  { symbol:"BNBUSDT",  name:"BNB",       short:"BNB",  category:"L1",   group:"alt1",  quoteAsset:"USDT" },
  { symbol:"XRPUSDT",  name:"Ripple",    short:"XRP",  category:"Pago", group:"pay",   quoteAsset:"USDT" },
  { symbol:"LINKUSDT", name:"Chainlink", short:"LINK", category:"DeFi", group:"defi",  quoteAsset:"USDT" },
  { symbol:"ADAUSDT",  name:"Cardano",   short:"ADA",  category:"L1",   group:"alt2",  quoteAsset:"USDT" },
  { symbol:"DOTUSDT",  name:"Polkadot",  short:"DOT",  category:"L1",   group:"alt2",  quoteAsset:"USDT" },
  // ── Nuevos pares alto volumen solo en paper (testing) ────────────────────
  { symbol:"SUIUSDT",  name:"Sui",       short:"SUI",  category:"L1",   group:"alt3",  quoteAsset:"USDT" },
  { symbol:"TONUSDT",  name:"TON",       short:"TON",  category:"L1",   group:"alt3",  quoteAsset:"USDT" },
  { symbol:"DOGEUSDT", name:"Dogecoin",  short:"DOGE", category:"Meme", group:"meme",  quoteAsset:"USDT" },
  { symbol:"TRXUSDT",  name:"TRON",      short:"TRX",  category:"L1",   group:"alt3",  quoteAsset:"USDT" },
]
const PAIRS_MAP = new Map(PAIRS.map(p=>[p.symbol,p]));
;

const CATEGORIES = {
  L1:   { name:"Layer 1", color:"#f7931a", emoji:"🔶" },
  L2:   { name:"Layer 2", color:"#7b68ee", emoji:"🔷" },
  DeFi: { name:"DeFi",    color:"#00c8ff", emoji:"💎" },
  Pago: { name:"Pagos",   color:"#00e5a0", emoji:"💸" },
};

// ── Multi-timeframe: agrega precios en velas de 5min y 15min ─────────────────
// Cada 150 ticks (5min a 2s/tick) guardamos un cierre de "vela 5min"
// Así el bot puede ver tendencias en múltiples timeframes
function updateMultiTF(tfHistory, symbol, price, tick) {
  if (!tfHistory[symbol]) tfHistory[symbol] = { tf5: [], tf15: [], tf60: [], lastPrice: price };
  tfHistory[symbol].lastPrice = price;
  // Vela 5min cada 150 ticks (150 × 2s = 5min)
  if (tick % 150 === 0) { tfHistory[symbol].tf5 = [...(tfHistory[symbol].tf5||[]), price].slice(-100); }
  // Vela 15min cada 450 ticks
  if (tick % 450 === 0) { tfHistory[symbol].tf15 = [...(tfHistory[symbol].tf15||[]), price].slice(-100); }
  // Vela 1h cada 1800 ticks
  if (tick % 1800 === 0) { tfHistory[symbol].tf60 = [...(tfHistory[symbol].tf60||[]), price].slice(-100); }
}

function getDailyLimit(regime, wr) {
  let base = regime==="BULL"?25:regime==="LATERAL"?15:regime==="BEAR"?5:10;
  if(wr!==null){if(wr>65)base=Math.round(base*1.3);else if(wr<45)base=Math.round(base*0.6);else if(wr<50)base=Math.round(base*0.8);}
  return Math.max(3,Math.min(25,base));
}

// ── Indicadores ───────────────────────────────────────────────────────────────
function ema(arr,p){if(!arr.length)return 0;const k=2/(p+1);return arr.reduce((prev,cur,i)=>i===0?cur:cur*k+prev*(1-k));}
function rsi(arr,p=14){if(arr.length<p+1)return 50;let g=0,l=0;for(let i=arr.length-p;i<arr.length;i++){const d=arr[i]-arr[i-1];if(d>0)g+=d;else l-=d;}if(l===0)return 100;return 100-100/(1+g/l);}
function atr(closes,p=14){if(closes.length<2)return closes[0]*0.03;const trs=closes.slice(1).map((c,i)=>Math.abs(c-closes[i]));return trs.slice(-p).reduce((a,b)=>a+b,0)/Math.min(trs.length,p);}
function stdDev(arr){if(arr.length<2)return 0;const mean=arr.reduce((a,b)=>a+b,0)/arr.length;return Math.sqrt(arr.reduce((s,v)=>s+(v-mean)**2,0)/arr.length);}
function bollingerBands(arr,p=20,mult=2){
  if(arr.length<p)return{upper:arr[arr.length-1]*1.02,lower:arr[arr.length-1]*0.98,mid:arr[arr.length-1]};
  const slice=arr.slice(-p),mid=slice.reduce((a,b)=>a+b,0)/p;
  const sd=Math.sqrt(slice.reduce((s,v)=>s+(v-mid)**2,0)/p);
  return{upper:mid+mult*sd,lower:mid-mult*sd,mid};
}

// ── Régimen con ADX ───────────────────────────────────────────────────────────
// ADX mide la FUERZA de la tendencia (no la dirección)
// ADX > 25 = tendencia fuerte (BULL o BEAR según dirección)
// ADX < 20 = sin tendencia (LATERAL)
function calcADX(h, period=14) {
  if (h.length < period*2) return 15; // sin datos = asumir lateral
  const slice = h.slice(-(period*2+1));
  let plusDM=0, minusDM=0, tr=0;
  const smoothed = { plusDM:0, minusDM:0, tr:0 };
  for (let i=1; i<slice.length; i++) {
    const high=slice[i]*1.001, low=slice[i]*0.999; // approx sin datos OHLC
    const prevHigh=slice[i-1]*1.001, prevLow=slice[i-1]*0.999, prevClose=slice[i-1];
    const upMove=high-prevHigh, downMove=prevLow-low;
    const pdm = upMove>downMove&&upMove>0 ? upMove : 0;
    const mdm = downMove>upMove&&downMove>0 ? downMove : 0;
    const atr=Math.max(high-low, Math.abs(high-prevClose), Math.abs(low-prevClose));
    if (i <= period) { smoothed.plusDM+=pdm; smoothed.minusDM+=mdm; smoothed.tr+=atr; }
    else {
      smoothed.plusDM = smoothed.plusDM - smoothed.plusDM/period + pdm;
      smoothed.minusDM= smoothed.minusDM- smoothed.minusDM/period + mdm;
      smoothed.tr     = smoothed.tr     - smoothed.tr/period      + atr;
    }
  }
  if (!smoothed.tr) return 15;
  const plusDI=100*smoothed.plusDM/smoothed.tr;
  const minusDI=100*smoothed.minusDM/smoothed.tr;
  const dx=Math.abs(plusDI-minusDI)/(plusDI+minusDI||1)*100;
  return +dx.toFixed(1);
}

function detectRegime(h) {
  if (!h||h.length<50) return "UNKNOWN";
  const last=h[h.length-1];
  const ma20=h.slice(-20).reduce((a,b)=>a+b,0)/20;
  const ma50=h.slice(-50).reduce((a,b)=>a+b,0)/50;
  const trend20=(last-h[Math.max(0,h.length-20)])/h[Math.max(0,h.length-20)]*100;
  const trend5 =(last-h[Math.max(0,h.length-5)]) /h[Math.max(0,h.length-5)] *100;
  const trend50=(last-h[Math.max(0,h.length-50)])/h[Math.max(0,h.length-50)]*100;
  const adx=calcADX(h, 14);

  // BEAR fuerte: ADX alto + dirección bajista clara
  if (adx > 25 && last<ma20 && trend20<-1.5 && trend5<0) return "BEAR";
  // BEAR rápido: caída >3% en 5 velas
  if (trend5 < -3 && last < ma20) return "BEAR";

  // BULL fuerte: ADX alto + dirección alcista
  if (adx > 25 && last>ma20 && trend20>1.5 && trend5>0) return "BULL";
  // BULL claro: MAs alineadas al alza
  if (last>ma20 && ma20>ma50 && trend20>3 && adx>18) return "BULL";

  // LATERAL BAJISTA: downtrend lento sin fuerza suficiente para BEAR
  // Esto ocurre en mercados como ahora (F&G=9, caída gradual)
  if (last<ma20 && ma20<ma50 && trend20<-2 && trend50<-5) return "BEAR"; // tratar como BEAR
  if (last<ma20 && trend20<-1.5) return "LATERAL"; // downtrend leve → lateral conservador

  return "LATERAL";
}

// ── Señales adaptativas ───────────────────────────────────────────────────────

// Detectar volumen anómalo — si el cambio de precio reciente es 3x la media
// Es un proxy de volumen real basado en la magnitud de movimiento de precio
function getVolumeAnomaly(volumeHistory, symbol) {
  const vh = volumeHistory?.[symbol] || [];
  if (vh.length < 20) return { anomaly: false, ratio: 1.0 };
  const recent = vh.slice(-3).reduce((a,b)=>a+b,0)/3;  // últimas 3 lecturas
  const baseline = vh.slice(-30,-3).reduce((a,b)=>a+b,0)/27;  // media 30 lecturas previas
  const ratio = baseline > 0 ? recent / baseline : 1.0;
  return { anomaly: ratio > 2.5, ratio: +ratio.toFixed(2) };
}

function signalMomentum(sym,history,params){
  const h=history[sym]||[];
  if(h.length<10)return{signal:"HOLD",score:50,reason:"Sin datos",rsiVal:50,atrPct:3,mom10:0,strategy:"MOMENTUM"};
  const last=h[h.length-1],emaFast=ema(h,params.emaFast),emaSlow=ema(h,params.emaSlow);
  const rsiVal=rsi(h),atrVal=atr(h),atrPct=(atrVal/last)*100;
  const mom10=((last-h[Math.max(0,h.length-10)])/h[Math.max(0,h.length-10)])*100;
  const vol30=stdDev(h.slice(-30).map((v,i,a)=>i===0?0:(v-a[i-1])/a[i-1]));
  const volP=vol30>0.03?0.8:1.0;
  let score=50;
  const emaDiff=((emaFast-emaSlow)/emaSlow)*100;
  score+=Math.max(-25,Math.min(25,emaDiff*10));
  if(rsiVal<params.rsiOversold)score+=20;else if(rsiVal<45)score+=10;else if(rsiVal>params.rsiOverbought)score-=20;else if(rsiVal>58)score-=8;
  if(mom10>5)score+=15;else if(mom10>2)score+=8;if(mom10<-5)score-=15;else if(mom10<-2)score-=8;
  score=Math.max(5,Math.min(95,Math.round(score*volP)));
  let signal=score>=params.minScore?"BUY":score<=(100-params.minScore)?"SELL":"HOLD";
  return{signal,score,reason:`MOMENTUM · EMA ${emaFast.toFixed(1)}/${emaSlow.toFixed(1)} · RSI ${rsiVal.toFixed(0)} · Mom ${mom10.toFixed(1)}%`,rsiVal:+rsiVal.toFixed(1),atrPct:+atrPct.toFixed(2),mom10:+mom10.toFixed(2),emaFast,emaSlow,strategy:"MOMENTUM"};
}

function signalMeanReversion(sym,history,params){
  const h=history[sym]||[];
  if(h.length<20)return{signal:"HOLD",score:50,reason:"Sin datos",rsiVal:50,atrPct:3,mom10:0,strategy:"MEAN_REVERSION"};
  const last=h[h.length-1],bb=bollingerBands(h,20,2);
  const rsiVal=rsi(h),atrVal=atr(h),atrPct=(atrVal/last)*100;
  const bbRange=bb.upper-bb.lower||1,bbPos=(last-bb.lower)/bbRange;
  let score=50,signal="HOLD",reason="";
  // MR: RSI<40 Y BB<20% para señal normal, RSI<35 Y BB<12% para señal fuerte
  if(bbPos<0.12&&rsiVal<35){score=82+Math.round((0.12-bbPos)*200);signal="BUY";reason=`MEAN REV FUERTE · BB ${(bbPos*100).toFixed(0)}% · RSI ${rsiVal.toFixed(0)} (sobreventa extrema)`;}
  else if(bbPos<0.20&&rsiVal<40){score=68+Math.round((0.20-bbPos)*100);signal="BUY";reason=`MEAN REV · BB ${(bbPos*100).toFixed(0)}% · RSI ${rsiVal.toFixed(0)} (sobreventa)`;}
  else if(bbPos<0.30&&rsiVal<45){score=58+Math.round((0.30-bbPos)*60);signal="BUY";reason=`MEAN REV DÉBIL · BB ${(bbPos*100).toFixed(0)}% · RSI ${rsiVal.toFixed(0)}`;}
  else if(bbPos>0.85&&rsiVal>65){score=22-Math.round((bbPos-0.85)*100);signal="SELL";reason=`MEAN REV FUERTE · BB ${(bbPos*100).toFixed(0)}% · RSI ${rsiVal.toFixed(0)} (sobrecompra clara)`;}
  else if(bbPos>0.75&&rsiVal>58){score=35-Math.round((bbPos-0.75)*80);signal="SELL";reason=`MEAN REV · BB ${(bbPos*100).toFixed(0)}% · RSI ${rsiVal.toFixed(0)} (sobrecompra)`;}
  else{score=50+Math.round((0.5-bbPos)*20);reason=`En rango · BB ${(bbPos*100).toFixed(0)}% · RSI ${rsiVal.toFixed(0)}`;}
  score=Math.max(5,Math.min(95,score));
  signal=score>=params.minScore?"BUY":score<=(100-params.minScore)?"SELL":"HOLD";
  return{signal,score,reason,rsiVal:+rsiVal.toFixed(1),atrPct:+atrPct.toFixed(2),mom10:0,bbPos:+bbPos.toFixed(2),strategy:"MEAN_REVERSION"};
}

function signalBear(sym,history,params){
  const h=history[sym]||[];
  if(h.length<10)return{signal:"HOLD",score:30,reason:"Sin datos",rsiVal:50,atrPct:3,mom10:0,strategy:"BEAR"};
  const last=h[h.length-1],rsiVal=rsi(h),atrVal=atr(h),atrPct=(atrVal/last)*100;
  const bb=bollingerBands(h,20,2.5),bbPos=(last-bb.lower)/(bb.upper-bb.lower||1);
  const mom5=h.length>5?((last-h[h.length-6])/h[h.length-6]*100):0;
  let score=30,signal="HOLD",reason=`BEAR · RSI ${rsiVal.toFixed(0)} · Esperando rebote extremo`;
  // Rebote extremo: RSI<20 + BB muy bajo + momentum 5v empezando a girar
  if(rsiVal<20&&bbPos<0.05){score=75;signal="BUY";reason=`BEAR REBOTE EXTREMO · RSI ${rsiVal.toFixed(0)} · BB ${(bbPos*100).toFixed(0)}%`;}
  else if(rsiVal<25&&bbPos<0.10&&mom5>0){score=62;signal="BUY";reason=`BEAR REBOTE · RSI ${rsiVal.toFixed(0)} · BB ${(bbPos*100).toFixed(0)}% · Mom girando`;}
  return{signal,score,reason,rsiVal:+rsiVal.toFixed(1),atrPct:+atrPct.toFixed(2),mom10:0,bbPos:+bbPos.toFixed(2),strategy:"BEAR"};
}

// ── SCALPING: micro-rebotes en cualquier régimen ─────────────────────────────
// Target: 0.3-0.8% en 5-30 min. Stop: 0.8%. Funciona bien en BEAR/LATERAL
function signalScalp(sym, history, params) {
  const h = history[sym]||[];
  if (h.length < 10) return {signal:"HOLD",score:30,strategy:"SCALP"};
  const last = h[h.length-1];
  const rsiVal = rsi(h);
  const bb = bollingerBands(h, 10, 1.8); // BB más ajustado para scalp
  const bbPos = (last - bb.lower) / (bb.upper - bb.lower || 1);
  const atrVal = atr(h, 5); // ATR corto para scalp
  const atrPct = (atrVal / last) * 100;
  const mom3 = h.length>3 ? ((last-h[h.length-4])/h[h.length-4]*100) : 0;
  const mom1 = h.length>1 ? ((last-h[h.length-2])/h[h.length-2]*100) : 0;

  let score = 30, signal = "HOLD", reason = "";

  // Scalp BUY: caída brusca + RSI bajo + micro-rebote iniciándose
  if (bbPos < 0.15 && rsiVal < 38 && mom1 >= 0) {
    score = 62 + Math.round((0.15-bbPos)*150);
    signal = "BUY";
    reason = `SCALP · BB ${(bbPos*100).toFixed(0)}% · RSI ${rsiVal.toFixed(0)} · Mom+`;
  } else if (bbPos < 0.25 && rsiVal < 32 && mom3 < -1.5 && mom1 >= 0) {
    score = 58;
    signal = "BUY";
    reason = `SCALP REBOTE · RSI ${rsiVal.toFixed(0)} · Giro`;
  }

  return {signal, score, reason, rsiVal:+rsiVal.toFixed(1),
          atrPct:+atrPct.toFixed(2), mom10:+mom3.toFixed(2),
          bbPos:+bbPos.toFixed(2), strategy:"SCALP"};
}

function computeSignal(sym,history,params,regime="UNKNOWN"){
  switch(regime){
    case"BULL":   return signalMomentum(sym,history,params);
    case"LATERAL":return signalMeanReversion(sym,history,params);
    case"BEAR":   return signalBear(sym,history,params);
    default:      return signalMomentum(sym,history,params);
  }
}

// En BEAR: también generar señal scalp para complementar
// Analiza tendencia multi-timeframe y devuelve sesgo alcista/bajista
function getMultiTFBias(tfData) {
  if (!tfData) return { bias: 0, label: "neutral" };
  const { tf5=[], tf15=[], tf60=[] } = tfData;
  let bullPoints = 0, bearPoints = 0;
  // 5min trend
  if (tf5.length >= 3) {
    const t5 = (tf5[tf5.length-1] - tf5[tf5.length-3]) / tf5[tf5.length-3] * 100;
    if (t5 > 0.3) bullPoints += 2; else if (t5 < -0.3) bearPoints += 2;
  }
  // 15min trend
  if (tf15.length >= 3) {
    const t15 = (tf15[tf15.length-1] - tf15[tf15.length-3]) / tf15[tf15.length-3] * 100;
    if (t15 > 0.5) bullPoints += 3; else if (t15 < -0.5) bearPoints += 3;
  }
  // 1h trend — más peso
  if (tf60.length >= 2) {
    const t60 = (tf60[tf60.length-1] - tf60[tf60.length-2]) / tf60[tf60.length-2] * 100;
    if (t60 > 0.3) bullPoints += 4; else if (t60 < -0.3) bearPoints += 4;
  }
  const bias = bullPoints - bearPoints; // positive = bullish, negative = bearish
  const label = bias >= 4 ? "strong_bull" : bias >= 2 ? "bull" : bias <= -4 ? "strong_bear" : bias <= -2 ? "bear" : "neutral";
  return { bias, label, bullPoints, bearPoints };
}

function computeSignalWithScalp(sym, history, params, regime, tfHistory={}) {
  const main = computeSignal(sym, history, params, regime);
  
  // Multi-timeframe bias
  const mtf = getMultiTFBias(tfHistory[sym]);
  
  // If 1h trend is strongly bearish → skip weak BUY signals
  if (mtf.label === "strong_bear" && main.signal === "BUY" && main.score < 70) {
    return { ...main, signal: "HOLD", score: main.score - 15, reason: main.reason + " [MTF BEAR block]" };
  }
  // If 1h trend is bullish → boost BUY signals slightly
  if ((mtf.label === "bull" || mtf.label === "strong_bull") && main.signal === "BUY") {
    return { ...main, score: Math.min(95, main.score + 8), reason: main.reason + " [MTF BULL +" + mtf.bullPoints + "]" };
  }
  
  if (regime === "BEAR" || regime === "LATERAL") {
    const scalp = signalScalp(sym, history, params);
    // Only do scalp if MTF is not strongly bearish
    if (scalp.signal === "BUY" && scalp.score > main.score && mtf.label !== "strong_bear") {
      return scalp;
    }
  }
  return main;
}

function isPumping(h,w=6){if(!h||h.length<w)return false;return(h[h.length-1]-h[h.length-w])/h[h.length-w]>PUMP_THRESHOLD;}
function isFallingFast(h,w=6,thr=0.03){if(!h||h.length<w)return false;return(h[h.length-1]-h[h.length-w])/h[h.length-w]<-thr;}

function correlation(h1,h2,n=20){
  if(!h1||!h2||h1.length<n||h2.length<n)return 0;
  const a=h1.slice(-n).map((v,i,arr)=>i===0?0:(v-arr[i-1])/arr[i-1]);
  const b=h2.slice(-n).map((v,i,arr)=>i===0?0:(v-arr[i-1])/arr[i-1]);
  const ma=a.reduce((s,v)=>s+v,0)/n,mb=b.reduce((s,v)=>s+v,0)/n;
  const num=a.reduce((s,v,i)=>s+(v-ma)*(b[i]-mb),0);
  const den=Math.sqrt(a.reduce((s,v)=>s+(v-ma)**2,0)*b.reduce((s,v)=>s+(v-mb)**2,0));
  return den===0?0:+(num/den).toFixed(2);
}

function checkCorrelation(portfolio,symbol,history){
  const h=history[symbol]||[];
  let count=0;
  for(const sym of Object.keys(portfolio)){const c=correlation(h,history[sym]||[]);if(c>0.8)count++;}
  return count<2;
}

function updatePairScore(scores,symbol,pnl){
  if(!scores[symbol])scores[symbol]={wins:0,losses:0,totalPnl:0,score:50};
  const s=scores[symbol];
  if(pnl>0){s.wins++;s.totalPnl+=pnl;}else{s.losses++;s.totalPnl+=pnl;}
  const total=s.wins+s.losses,wr=total?s.wins/total:0.5,avgPnl=total?s.totalPnl/total:0;
  s.score=Math.max(20,Math.min(100,Math.round(50+wr*30+avgPnl*2)));
  return s.score;
}

function getFee(useBnb=true){return useBnb?BNB_FEE:NORMAL_FEE;}
function runContrafactual(sym,history,ticksBack=10){
  const h=history[sym]||[];if(h.length<ticksBack+1)return null;
  const ep=h[h.length-ticksBack-1],cp=h[h.length-1];
  return{symbol:sym,ticksBack,entryPrice:+ep.toFixed(4),currentPrice:+cp.toFixed(4),pnl:+((cp-ep)/ep*100).toFixed(2)};
}

// ── Stop dinámico basado en ATR (igual que live) ─────────────────────────────
function calcDynamicStop(entryPrice, atrVal, regime) {
  const atrPct = atrVal / entryPrice;
  let multiplier;
  if      (atrPct < 0.005) multiplier = 1.5;
  else if (atrPct < 0.015) multiplier = 2.0;
  else if (atrPct < 0.030) multiplier = 2.5;
  else                     multiplier = 3.0;
  if (regime === "BEAR")    multiplier *= 1.2; // más amplio en BEAR
  if (regime === "LATERAL") multiplier *= 0.9; // más ajustado en LATERAL
  multiplier = Math.min(3.5, Math.max(1.5, multiplier));
  const stop = entryPrice - atrVal * multiplier;
  const stopPct = ((entryPrice - stop) / entryPrice * 100).toFixed(2) + "%";
  return { stop: Math.max(stop, entryPrice * 0.92), stopPct }; // max 8% stop
}

// ── CLASE PRINCIPAL ───────────────────────────────────────────────────────────
class CryptoBotFinal {
  constructor(saved=null){
    this.profile=RISK_PROFILES["paper"];
    this.breaker=new CircuitBreaker(this.profile.maxDailyLoss);
    this.trailing=new TrailingStop();
    this.optimizer=new AutoOptimizer();
    // ── Módulos de aprendizaje v3 ──────────────────────────────────────────
    this.patternMemory  = new PatternMemory();
    this.dqn            = new DQN({ lr:0.001, gamma:0.95, epsilon:0.15 });
    this.multiAgent     = new MultiAgentSystem();
    this.stratEval      = new StrategyEvaluator(); // meta-learning de estrategias // agentes especializados por régimen
    this.cfMemory       = new CounterfactualMemory();
    this.qLearning      = new QLearning({ alpha:0.2, gamma:0.85, epsilon:0.25 }); // Aprendizaje más rápido en paper
    this.ensemble       = new EnsembleVoter();
    this.intradayTrend  = new IntradayTrend();
    this.riskLearning   = new RiskLearning();
    this.corrManager    = new CorrelationManager();
    this.adaptiveStop   = new AdaptiveStopLoss();
    this.adaptiveHours  = new AdaptiveHours();
    this.newsLearner    = new NewsImpactLearner();
    this.regimeDetector = new AdaptiveRegimeDetector();
    this.historicalResults = null;
    if(saved){
      this.prices=saved.prices||{};this.history=saved.history||{};this.portfolio=saved.portfolio||{};
      this.cash=saved.cash||INITIAL_CAPITAL;this.log=saved.log||[];this.equity=saved.equity||[INITIAL_CAPITAL];
      this.tick=saved.tick||0;this.mode=saved.mode||"PAPER";this.optLog=saved.optLog||[];
      this.equityHistory=saved.equityHistory||[];
      this.pairScores=saved.pairScores||{};this.reentryTs=saved.reentryTs||{};
      this.dailyTrades=saved.dailyTrades||{date:"",count:0};this.useBnb=saved.useBnb!==undefined?saved.useBnb:true;
      this.contrafactualLog=saved.contrafactualLog||[];
      this.maxEquity=saved.maxEquity||INITIAL_CAPITAL;this.drawdownAlerted=saved.drawdownAlerted||false;
      this.tfHistory=saved.tfHistory||{};
      if(saved.optimizerHistory)this.optimizer.history=saved.optimizerHistory;
      if(saved.optimizerParams)Object.assign(this.optimizer.params,saved.optimizerParams);
      if(saved.trailingHighs)this.trailing.highs=saved.trailingHighs;
      if(saved.adaptiveStop)   this.adaptiveStop.restore(saved.adaptiveStop);
      if(saved.adaptiveHours)  this.adaptiveHours.restore(saved.adaptiveHours);
      if(saved.newsLearner)    this.newsLearner.restore(saved.newsLearner);
      if(saved.regimeDetector) this.regimeDetector.restore(saved.regimeDetector);
      // Restaurar módulos de aprendizaje
      if(saved.learningData){
        this.patternMemory.loadJSON(saved.learningData.patternMemory);
        this.cfMemory.loadJSON(saved.learningData.cfMemory);
        this.qLearning.loadJSON(saved.learningData.qLearning);
        if(saved.learningData.dqn) {
          try {
            this.dqn.loadJSON(saved.learningData.dqn);
          } catch(dqnErr) {
            console.warn("[DQN] Incompatible saved weights (dim mismatch) — resetting DQN. Reason:", dqnErr.message);
            // Old model had different input size - start fresh with new architecture
          }
        }
        if(saved.learningData.multiAgent) this.multiAgent.loadJSON(saved.learningData.multiAgent);
        if(saved.learningData.stratEval) this.stratEval.loadJSON(saved.learningData.stratEval);
        this.ensemble.loadJSON(saved.learningData.ensemble);
      }
      // Safety: si el estado restaurado tiene capital casi en 0 (crash mid-trade)
      // y no hay posiciones abiertas → resetear cash al capital inicial
      if(this.totalValue() < INITIAL_CAPITAL * 0.01 && Object.keys(this.portfolio).length === 0) {
        console.warn(`[ENGINE] ⚠️ Cash casi en 0 sin posiciones abiertas → reseteando a $${INITIAL_CAPITAL}`);
        this.cash = INITIAL_CAPITAL;
      }
      console.log(`[ENGINE v3] Restaurado tick #${this.tick} | $${this.totalValue().toFixed(2)}`);
    }else{
      this.prices={};this.history={};this.portfolio={};
      this.cash=INITIAL_CAPITAL;this.log=[];this.equity=[{v:INITIAL_CAPITAL,t:Date.now()}];
      this.tick=0;this.mode="PAPER";this.optLog=[];
      this.pairScores={};this.reentryTs={};this.dailyTrades={date:"",count:0};
      this.useBnb=true;this.contrafactualLog=[];
      this.maxEquity=INITIAL_CAPITAL;this.drawdownAlerted=false;
      this.tfHistory={};
    }
    this.marketDefensive=false;this.hourMultiplier=1.0;
    this.marketRegime="UNKNOWN";this.fearGreed=50;
    this.blacklist=null;
  }

  updatePrice(sym,price){
    const prevPrice = this.prices[sym] || price;
    this.prices[sym]=price;
    // Multi-timeframe aggregation: build 5m and 1h candles from 2s ticks
    if(!this._mtfBuf) this._mtfBuf = {};
    if(!this._mtfBuf[sym]) this._mtfBuf[sym] = {ticks5m:[], ticks1h:[]};
    const buf = this._mtfBuf[sym];
    buf.ticks5m.push(price);
    buf.ticks1h.push(price);
    // 5m candle: every 150 ticks (150 × 2s = 5min)
    if(buf.ticks5m.length >= 150) {
      if(!this.history5m) this.history5m = {};
      if(!this.history5m[sym]) this.history5m[sym] = [];
      const close5m = buf.ticks5m[buf.ticks5m.length-1];
      this.history5m[sym].push(close5m);
      if(this.history5m[sym].length > 300) this.history5m[sym].shift(); // 25h
      buf.ticks5m = [];
    }
    // 1h candle: every 1800 ticks (1800 × 2s = 1h)
    if(buf.ticks1h.length >= 1800) {
      if(!this.history1h) this.history1h = {};
      if(!this.history1h[sym]) this.history1h[sym] = [];
      const close1h = buf.ticks1h[buf.ticks1h.length-1];
      this.history1h[sym].push(close1h);
      if(this.history1h[sym].length > 168) this.history1h[sym].shift(); // 1 semana
      buf.ticks1h = [];
    }
    // Volume proxy: track magnitude of price changes
    if(!this.volumeHistory) this.volumeHistory={};
    if(!this.volumeHistory[sym]) this.volumeHistory[sym]=[];
    const changePct=Math.abs((price-prevPrice)/prevPrice);
    this.volumeHistory[sym].push(changePct);
    if(this.volumeHistory[sym].length>100) this.volumeHistory[sym].shift();
    this.history[sym]=[...(this.history[sym]||[]),price].slice(-200);
    updateMultiTF(this.tfHistory,sym,price,this.tick);
    this.intradayTrend.addPrice(sym,price);
  }
  totalValue(){return this.cash+Object.entries(this.portfolio).reduce((s,[sym,pos])=>s+pos.qty*(this.prices[sym]||pos.entryPrice),0);}
  checkDailyReset(){const today=new Date().toDateString();if(this.dailyTrades.date!==today)this.dailyTrades={date:today,count:0};}
  recentWinRate(){const sells=this.log.filter(l=>l.type==="SELL").slice(0,20);if(!sells.length)return null;return Math.round(sells.filter(l=>l.pnl>0).length/sells.length*100);}

  checkMaxDrawdown(tv){
    if(tv>this.maxEquity){this.maxEquity=tv;this.drawdownAlerted=false;}
    const dd=(this.maxEquity-tv)/this.maxEquity;
    if(dd>=MAX_DRAWDOWN_PCT&&!this.drawdownAlerted){this.drawdownAlerted=true;return{triggered:true,drawdownPct:+(dd*100).toFixed(2),maxEquity:+this.maxEquity.toFixed(2)};}
    return{triggered:false,drawdownPct:+(dd*100).toFixed(2)};
  }

  evaluate(){
    if(Object.keys(this.prices).length<3)return{signals:[],newTrades:[],circuitBreaker:null,optimizerResult:null,drawdownAlert:null};
    this.tick++;this.checkDailyReset();
    const tv=this.totalValue();
    const cb={triggered:false,drawdown:0};
    this.marketRegime=detectRegime(this.history["BTCUSDC"]);
    const drawdownAlert={triggered:false,drawdownPct:0};

    const wr=this.recentWinRate(),dailyLimit=getDailyLimit(this.marketRegime,wr);
    const totalTrades=this.log.filter(l=>l.type==="SELL").length;
    // Meta-learning: evaluar qué estrategias funcionan ahora
    const metaResult = this.stratEval.evaluate(this.marketRegime);
    const learningPhase=totalTrades<100?1:totalTrades<500?2:3;
    if(this.tick===1||this.tick%1800===0) console.log(`[PAPER][FASE ${learningPhase}] Trades: ${totalTrades} | Régimen: ${this.marketRegime} | WR: ${wr||"—"}%`);

    // PAPER: límite diario muy alto para maximizar aprendizaje
    // Aprendizaje adaptativo: si WR muy bajo, aprender a ser más selectivo
    const recentWR = this.recentWinRate() || 50;
    const isStruggling = recentWR < 25 && totalTrades > 50;
    if (isStruggling && this.tick % 900 === 0) {
      console.log(`[PAPER][APRENDIZAJE] WR bajo (${recentWR}%) → siendo más selectivo en entradas`);
    }
    const paperDailyLimit = (learningPhase === 1 ? 5000 : learningPhase === 2 ? 2000 : 500) + (this._dailyLimitBoost||0);
    const dailyLimitReached=this.dailyTrades.count>=paperDailyLimit;
    const params=this.optimizer.getParams();

    // Aplicar pesos de meta-learning a los scores de cada estrategia
    const signals=PAIRS.map(p=>({
      ...p,price:this.prices[p.symbol]||0,
      ...(()=>{
        const sig=computeSignalWithScalp(p.symbol,this.history,params,this.marketRegime,this.tfHistory);
        const sw=this.stratEval?.getWeight(sig.strategy)||1.0;
        return {...sig, score:Math.min(95,Math.round(sig.score*sw))};
      })(),
      isPumping:isPumping(this.history[p.symbol]),isFalling:isFallingFast(this.history[p.symbol]),
      pairScore:this.pairScores[p.symbol]?.score||50,
    }));

    const newTrades=[],fee=getFee(this.useBnb);
    this.riskLearning.evaluateDecisions(this.prices);
    const rlResult=this.riskLearning.optimize();
    if(rlResult) this._rlChanges=rlResult;

    // GESTIÓN POSICIONES
    for(const[symbol,pos]of Object.entries(this.portfolio)){
      const cp=this.prices[symbol]||pos.entryPrice;
      // Dynamic trailing based on ATR volatility
      const hArr = this.history[symbol]||[];
      const dynTrailingPct = Math.max(0.025, Math.min(0.10,
        hArr.length>=14 ? (atr(hArr,14)/cp)*3.0 : this.profile.trailingPct
      ));
      const ts=this.trailing.update(symbol,cp,pos.entryPrice,dynTrailingPct);
      // Time stop: cerrar posición si lleva más de 4h sin moverse significativamente
      const posAgeSec = (Date.now() - new Date(pos.ts).getTime()) / 1000;
      const posAgeLimitSec = 4 * 3600;
      const priceMovePct = Math.abs((cp - pos.entryPrice) / pos.entryPrice * 100);
      // Paper: sin time stop - que aprenda a aguantar posiciones
      const timeStop = false;

      this.portfolio[symbol].trailingStop=+ts.stopPrice.toFixed(4);
      this.portfolio[symbol].trailingHigh=+ts.maxHigh.toFixed(4);
      this.portfolio[symbol].profitLocked=+ts.profitLocked.toFixed(2);
      // Micro-reward: el DQN aprende en cada tick, no solo al cerrar
      if(this.dqn && pos.dqnState && this.tick % 10 === 0) {
        const tickPnl = (cp - pos.entryPrice) / pos.entryPrice;
        // Reward proporcional al P&L no realizado, escalado suavemente
        const microReward = Math.max(-0.3, Math.min(0.3, tickPnl * 5));
        // Si va bien → refuerza positivamente el BUY; si va mal → refuerza SKIP
        if(pos.dqnState && pos.dqnState.length === this.dqn.inputSize) {
          this.dqn.remember(pos.dqnState, "BUY", microReward, pos.dqnState, false);
        }
        // Train con estos micro-rewards cada 50 ticks de posición abierta
        if(this.tick % 50 === 0 && this.dqn.replayBuffer.length > this.dqn.minReplaySize) {
          this.dqn.trainBatch();
        }
      }
      const sig=signals.find(s=>s.symbol===symbol);
      // MR exit: en LATERAL tomar beneficio en BB 65% (no esperar 90%)
      // Esto mejora WR aunque reduce tamaño de ganancia individual
      // Scalp: salir rápido cuando hay beneficio
      const isScalp = pos.strategy === "SCALP";
      // In LATERAL: higher SCALP target to avoid noise scratches
        const scalpTarget = this.marketRegime==="LATERAL" ? 1.008 : this.marketRegime==="BEAR" ? 1.006 : 1.004;
        const scalpExit = isScalp && cp >= pos.entryPrice * scalpTarget;

      // Partial exit: punto óptimo aprendido por par/régimen (default +1.5%)
      const _partialPct = this.adaptiveStop
        ? Math.max(1.005, Math.min(1.04, 1 + (this.adaptiveStop.getStop(symbol, this.marketRegime, new Date().getUTCHours(), 0.015) * 0.5)))
        : 1.015; // fallback 1.5%
      if (!isScalp && !pos.partialDone && cp >= pos.entryPrice * _partialPct) {
        const partialQty = pos.qty * 0.5;
        const proceeds = partialQty * cp * (1 - fee);
        this.cash += proceeds;
        this.portfolio[symbol].qty -= partialQty;
        this.portfolio[symbol].partialDone = true;
        // Subir stop al break-even una vez tomado beneficio parcial
        this.portfolio[symbol].stopLoss = Math.max(pos.stopLoss, pos.entryPrice * 1.001);
        const pnlPart = (cp - pos.entryPrice) / pos.entryPrice * 100 - fee * 200;
        const partialPnlAbs = +(partialQty * cp * (pnlPart/100)).toFixed(2);
        const partialTrade = {type:"SELL",symbol,name:pos.name,qty:+partialQty.toFixed(6),price:+cp.toFixed(4),pnl:+pnlPart.toFixed(2),pnlAbs:partialPnlAbs,reason:"PARTIAL EXIT",mode:this.mode,fee:+(partialQty*cp*fee).toFixed(4),ts:new Date().toISOString(),strategy:pos.strategy||"ENSEMBLE"};
        newTrades.push(partialTrade);
        console.log(`[PAPER][PARTIAL] ${symbol} +${pnlPart.toFixed(2)}% → 50% vendido, stop→BE`);
      }
      // Exit targets adaptativos por régimen - trend riding en BULL
      const mrTarget = this.marketRegime==="BULL"    ? 0.92 :   // BULL: dejar correr
                       this.marketRegime==="LATERAL" ? 0.65 :   // LATERAL: salir rápido
                       0.82;                                     // BEAR: target normal
      const mrRsi    = this.marketRegime==="BULL" ? 72 : 58;
      const mrExit   = !isScalp && sig?.bbPos>mrTarget && sig?.rsiVal>mrRsi;
      // Trend riding: en BULL con beneficio asegurado → ampliar trailing a 4%
      // También si este par lleva racha ganadora en el mismo régimen
      const pairWins = (this._pairStreak||{})[symbol]?.wins||0;
      const regimeContinues = pos.regime === this.marketRegime;
      const trendRide = (this.marketRegime==="BULL" || (pairWins>=2 && regimeContinues)) && !isScalp && (pos.profitLocked||0)>0.3;
      if(trendRide) {
        // Trailing escala con win streak: 2→4%, 4→5%, 6+→6%
        const trailPct = pairWins>=6 ? 0.94 : pairWins>=4 ? 0.95 : 0.96;
        const bullTrail = cp * trailPct;
        if(bullTrail > (this.portfolio[symbol]?.trailingStop||0)) {
          this.portfolio[symbol].trailingStop = +bullTrail.toFixed(4);
          if(pairWins>=4) console.log(`[TREND-RIDE] ${symbol} streak=${pairWins} trailing=${((1-trailPct)*100).toFixed(0)}%`);
        }
      }
      const bearSell=this.marketRegime==="BEAR"&&pos.profitLocked<0&&ts.profitLocked<0;
      // En paper: no salir solo por señal SELL débil — esperar stop o trailing con beneficio real
      const signalExit=sig?.signal==="SELL"&&sig?.score<=(100-params.minScore-10)&&ts.profitLocked>0.5;
      if(cp<=pos.stopLoss||ts.hit||signalExit||mrExit||bearSell||timeStop||scalpExit){
        const proceeds=pos.qty*cp*(1-fee),pnl=((cp-pos.entryPrice)/pos.entryPrice)*100-fee*100*2;
        this.cash+=proceeds;
        const reason=cp<=pos.stopLoss?"STOP LOSS":ts.hit?"TRAILING STOP":scalpExit?"SCALP TARGET":mrExit?"MR OBJETIVO":bearSell?"BEAR EXIT":"SEÑAL VENTA";
        // Análisis contrafactual
        const futureCandles=(this.history[symbol]||[]).slice(-20).map(p=>({open:p,high:p*1.002,low:p*0.998,close:p,volume:1000}));
        const cfAnalysis=analyzeCounterfactual({...pos,symbol,pnlPct:pnl/100,exit:cp,exitReason:reason,rsiEntry:sig?.rsiVal||50,bbEntry:null,id:`${symbol}_${Date.now()}`},futureCandles);
        this.cfMemory.add(cfAnalysis);
        // Aprender del contrafactual: si habría ganado más aguantando → Q-Learning bonus
        if(cfAnalysis && cfAnalysis.holdReturn > 0 && pnl < 0) {
          // Salimos con pérdida pero aguantar habría dado ganancia → reforzar HOLD en este estado
          const cfReward = Math.min(0.5, cfAnalysis.holdReturn * 5);
          if(pos.entryState) this.qLearning.update(pos.entryState, "HOLD", cfReward, pos.entryState);
        }
        // Actualizar pattern memory y Q-Learning
        const win=pnl>0;
        this.patternMemory.recordTrade(symbol,{rsiEntry:pos.rsiEntry||50,bbEntry:pos.bbEntry,entryPrice:pos.entryPrice,regime:pos.regime||this.marketRegime,pnlPct:pnl/100,win});
        // Calcular nextState real (estado actual al cerrar)
        const closeH=this.history[symbol]||[cp];
        const closeRsi=rsi(closeH),closeBB=bollingerBands(closeH);
        const closeBBZone=cp<closeBB.lower?"below_lower":cp<closeBB.mid?"lower_half":cp<closeBB.upper?"upper_half":"above_upper";
        const closeAtr=atr(closeH)/(cp*0.01);
        const closeTrend=this.intradayTrend.getTrend(symbol);
        const closeVolRatio=getVolumeAnomaly(this.volumeHistory,symbol).ratio;
        const nextState=this.qLearning.encodeState({rsi:closeRsi,bbZone:closeBBZone,regime:this.marketRegime,trend:closeTrend.direction,volumeRatio:closeVolRatio,atrLevel:closeAtr,fearGreed:this.fearGreed});
        this.qLearning.recordTradeOutcome(pos.entryState,pnl/100,nextState,{reason});
        // DQN: guardar experiencia y entrenar
        if(pos.dqnState) {
          const dqnReward = Math.max(-2, Math.min(2, pnl/100*15))
            + (win?0.3:0) + (reason==="SCALP TARGET"||reason==="MR OBJETIVO"?0.4:0)
            + (reason==="STOP LOSS"?-0.5:0);
          const closeVec = this.dqn.encodeState({rsi:closeRsi,bbZone:closeBBZone,regime:this.marketRegime,
            trend:closeTrend.direction,volumeRatio:closeVolRatio,atrLevel:closeAtr,
            fearGreed:this.fearGreed,lsRatio:this.longShortRatio?.ratio||1,
            sessionHour:new Date(Date.now()+2*3600000).getUTCHours(),winStreak:0,btcTrend24h:0,volatilityPct:50});
          // Validate dimensions before training (old states may have 8 inputs)
          if(pos.dqnState && pos.dqnState.length === this.dqn.inputSize) {
            this.dqn.remember(pos.dqnState, pos.dqnAction||"BUY", dqnReward, closeVec, false);
          }
          // Multi-agent: el agente del régimen de entrada aprende
          if(pos.dqnState) {
            // Only use dqnState if dimensions match
          const _validDqnState = pos.dqnState && pos.dqnState.length === this.dqn.inputSize ? pos.dqnState : null;
          const maLoss = this.multiAgent.learnFromTrade(
              pos.regime||this.marketRegime, _validDqnState,
              pos.dqnAction||"BUY", dqnReward, closeVec, pnl
            );
          }
          // Train DQN general every 50 trades
          if(totalTrades>0 && totalTrades%50===0 && this.dqn.replayBuffer.length>=50) {
            const loss=this.dqn.trainBatch(5);
            if(totalTrades%200===0) console.log(`[DQN] Updates:${this.dqn.totalUpdates} Loss:${loss.toFixed(4)} | MA: BULL-WR:${this.multiAgent.agents.BULL?.winRate}% BEAR-WR:${this.multiAgent.agents.BEAR?.winRate}%`);
          }
          this.dqn.decayEpsilon(0.03, totalTrades);
          this.multiAgent.decayEpsilon(totalTrades);
        }

        // DQN: record experience and train
        if(pos.dqnState) {
          const nextDqnState = this.dqn.encodeState({
            rsi:closeRsi, bbZone:closeBBZone, regime:this.marketRegime,
            trend:closeTrend.direction, volumeRatio:closeVolRatio,
            atrLevel:closeAtr, fearGreed:this.fearGreed,
            lsRatio:this.longShortRatio?.ratio||1,
            sessionHour:new Date(Date.now()+2*3600000).getUTCHours(),winStreak:0,btcTrend24h:0,volatilityPct:50
          });
          // Reward: same as Q-Learning but continuous
          const dqnReward = Math.max(-2, Math.min(2, pnl/100*20))
            + (win ? 0.3 : 0)
            + (reason==="SCALP TARGET"||reason==="MR OBJETIVO" ? 0.4 : 0)
            + (reason==="STOP LOSS" ? -0.5 : 0);
          if(pos.dqnState && pos.dqnState.length === this.dqn.inputSize) {
            this.dqn.remember(pos.dqnState, "BUY", dqnReward, nextDqnState, false);
          }

          // Train every 50 trades
          if(totalTrades > 0 && totalTrades % 50 === 0 && this.dqn.replayBuffer.length >= 50) {
            const loss = this.dqn.trainBatch();
            if(totalTrades % 200 === 0) console.log(`[DQN] Train loss: ${loss.toFixed(6)} | Updates: ${this.dqn.totalUpdates} | Epsilon: ${this.dqn.epsilon.toFixed(3)}`);
          }
        }
        // Añadir al replay buffer para aprendizaje futuro
        const replayReward = Math.max(-2, Math.min(2, pnl/100*20)) + (win?0.3:0) + (reason==="SCALP TARGET"||reason==="MR OBJETIVO"?0.4:0) + (reason==="STOP LOSS"?-0.5:0);
        this.qLearning.addToReplayBuffer(pos.entryState||nextState, "BUY", replayReward, nextState);
        // Experience replay cada 50 trades
        if(totalTrades>0 && totalTrades%50===0) {
          const replayed=this.qLearning.experienceReplay(20);
          if(replayed>0) console.log(`[Q-LEARNING] Experience replay: ${replayed} experiencias re-aprendidas`);
        }
        this.qLearning.decayEpsilon(0.03, 0.9995, totalTrades);
        this.dqn.decayEpsilon(0.03, totalTrades);
        if(pos.ensembleVotes) this.ensemble.updateWeights(pos.ensembleVotes,win);
        if(Math.random()<0.05) this.patternMemory.updateCorrelations();
        delete this.portfolio[symbol];this.trailing.remove(symbol);
        if(pnl<0){
          this.reentryTs[symbol]=Date.now();
          // Circuit breaker inteligente: 5 pérdidas seguidas → pausa 30min
          this._consecutiveLosses=(this._consecutiveLosses||0)+1;
          this._streakMult = Math.max(0.5, 1.0 - this._consecutiveLosses * 0.08);
          if(!this._pairStreak) this._pairStreak={};
          this._pairStreak[symbol]=(this._pairStreak[symbol]||{wins:0,losses:0});
          this._pairStreak[symbol].losses++;
          this._pairStreak[symbol].wins=0; // reset win streak on loss // reduce size on losing streak
          if(this._consecutiveLosses>=5&&!this._smartPause){
            this._smartPause=Date.now()+30*60*1000;
            console.log(`[PAPER][SMART-CB] 5 pérdidas seguidas → pausa 30min`);
          }
        } else {
          this._consecutiveLosses=0;
          this._streakMult = Math.min(1.3, (this._streakMult||1.0) + 0.05);
          if(!this._pairStreak) this._pairStreak={};
          if(!this._pairStreak[symbol]) this._pairStreak[symbol]={wins:0,losses:0};
          this._pairStreak[symbol].wins++;
          this._pairStreak[symbol].losses=0; // boost on winning streak
        }
        if(this._smartPause&&Date.now()>this._smartPause) this._smartPause=null;
        const pnlAbs = +(pos.qty * cp * (pnl/100)).toFixed(2); // P&L en USD absoluto
        const trade={type:"SELL",symbol,name:pos.name,qty:+pos.qty.toFixed(6),price:+cp.toFixed(4),pnl:+pnl.toFixed(2),pnlAbs,reason,mode:this.mode,fee:+(pos.qty*cp*fee).toFixed(4),ts:new Date().toISOString(),strategy:pos.strategy||"MOMENTUM"};
        newTrades.push(trade);this.dailyTrades.count++;
        this.optimizer.recordTrade(pnl,reason);updatePairScore(this.pairScores,symbol,pnl);
        this.stratEval.recordTrade(pos.strategy, this.marketRegime, pnl);
        // ── Autoaprendizaje adaptativo en cada SELL ───────────────────────
        const _eh = pos.ts ? new Date(pos.ts).getUTCHours() : new Date().getUTCHours();
        const _tr = {symbol,pnl,reason,strategy:pos.strategy||"ENSEMBLE",ts:new Date().toISOString()};
        if(this.adaptiveStop)  this.adaptiveStop.recordTrade(_tr, this.marketRegime, _eh);
        if(this.adaptiveHours) this.adaptiveHours.recordTrade(_tr, this.marketRegime);
        if(this.regimeDetector) this.regimeDetector.recordOutcome(pos.regime||this.marketRegime, pnl, {lsRatio:this.longShortRatio?.ratio, fg:this.fearGreed});
        if(this.qLearning) {
          const _s=this.log.filter(l=>l.type==="SELL");
          const _wr=_s.length>=10?_s.slice(-20).filter(l=>l.pnl>0).length/Math.min(20,_s.length):0.5;
          this.qLearning.lr = calcAdaptiveLR(0.1, _s.length, _wr);
        }
        console.log(`[${this.mode}][${this.marketRegime}][SELL] ${symbol} ${reason} P&L:${pnl.toFixed(2)}% | ${this.dailyTrades.count}/${paperDailyLimit}`);
      }
    }

    // NUEVAS ENTRADAS — sin blacklist, con ensemble+qlearning
    const smartPauseActive=this._smartPause&&Date.now()<this._smartPause;
    if(!dailyLimitReached&&!this.marketDefensive&&!smartPauseActive){
      const nOpen=Object.keys(this.portfolio).length;
      // Posiciones máximas según fase
      const maxPos = PAIRS.length; // paper: siempre máximas posiciones para aprender
      if(nOpen<maxPos){
        const reserve=this.totalValue()*MIN_CASH_RESERVE; let availCash=Math.max(0,this.cash-reserve);
        // Score mínimo progresivo
        // Si WR muy bajo, exigir señales más fuertes para aprender qué funciona
        const baseMin = learningPhase === 1 ? 20 : learningPhase === 2 ? 35 : (this.marketRegime==="BEAR"?55:45);
        const regimeMin = isStruggling ? Math.min(baseMin + 15, 65) : baseMin;
        // In LATERAL: extreme fear = mean reversion opportunity
        const fearAdj = this.marketRegime==="LATERAL"
          ? (this.fearGreed<25?1.3:this.fearGreed<35?1.1:this.fearGreed>75?0.8:1.0)
          : (this.fearGreed<25?1.2:this.fearGreed>80?0.6:1.0);
        const groupCount={};
        Object.keys(this.portfolio).forEach(sym=>{const p=PAIRS_MAP.get(sym);if(p)groupCount[p.group]=(groupCount[p.group]||0)+1;});

        // Respetar pausa de Telegram
      if(this._pausedByTelegram) return {signals,newTrades,circuitBreaker:cb,optimizerResult:optResult,dailyLimit:paperDailyLimit||dailyLimit,dailyUsed:this.dailyTrades.count,drawdownAlert};
      // In LATERAL: penalize SCALP (prefer mean reversion), boost MR signals
      if(this.marketRegime==="LATERAL" || this.marketRegime==="BEAR") {
        signals.forEach(s=>{
          if(s.strategy==="SCALP") s.score = Math.round(s.score*0.75); // SCALP less relevant in sideways
          if(s.strategy==="MR" || s.strategy==="MEAN_REVERSION") s.score = Math.min(99,Math.round(s.score*1.15)); // MR preferred
        });
      }
      const buyable=signals.filter(s=>{
          if(s.signal!=="BUY"||s.score<regimeMin)return false;
          if(this.portfolio[s.symbol])return false;
          if(s.isPumping)return false; // solo filtrar pumps extremos siempre
          // Cooldown corto en fase 1, normal en fase 3
          const cooldown = learningPhase===1 ? 60*1000 : learningPhase===2 ? 10*60*1000 : 30*60*1000;
          const ll=this.reentryTs[s.symbol];
          if(ll && Date.now()-ll < cooldown) {
            // RE-ENTRY LOGIC: si la señal es muy fuerte Y el precio recuperó, re-entrar antes
            const timeSinceStop = Date.now() - ll;
            const priceRecovered = this.prices[s.symbol] > (this._lastStopPrice?.[s.symbol]||0) * 1.005;
            const signalVeryStrong = s.score >= 88;
            const regimeBull = this.marketRegime === "BULL";
            // Re-entrar a los 20min si señal fuerte + precio recuperó + BULL
            if(timeSinceStop > 20*60*1000 && priceRecovered && signalVeryStrong && regimeBull) {
              // Permitir re-entrada temprana
            } else {
              return false;
            }
          }
          // Correlation buckets: límite adaptativo según régimen
          // BULL confirmado: permite hasta 2 del mismo grupo (la correlación trabaja a favor)
          // LATERAL/BEAR: máx 1 por grupo (evita perder doble en reversión)
          const CORR_BUCKETS = {
            major: ["BTCUSDC","ETHUSDC","SOLUSDC","BNBUSDC"],
            l2:    ["OPUSDC","ARBUSDC","POLUSDC"],
            defi:  ["UNIUSDC","AAVEUSDC","LINKUSDC"],
          };
          const maxPerBucket = this.marketRegime==="BULL" ? 2 : 1;
          let corrBlocked = false;
          for(const [, syms] of Object.entries(CORR_BUCKETS)) {
            if(syms.includes(s.symbol)) {
              const openInBucket = Object.keys(this.portfolio).filter(p=>syms.includes(p)).length;
              if(openInBucket >= maxPerBucket && learningPhase >= 2) { corrBlocked=true; break; }
            }
          }
          if(corrBlocked) return false;
          // Límite por grupo solo en fase 3
          if(learningPhase===3){const grp=PAIRS.find(p=>p.symbol===s.symbol)?.group;if(grp&&(groupCount[grp]||0)>=2)return false;}
          return true;
        }).sort((a,b)=>{
          const pairScoreA = this.pairScores[a.symbol]?.score||50;
          const pairScoreB = this.pairScores[b.symbol]?.score||50;
          // Cross-pair learning: si PatternMemory de pares correlacionados confirma → boost
          const crossA = this.patternMemory.getCrossLearnedBias(a.symbol, a.rsiVal||50, null, this.prices[a.symbol], this.marketRegime);
          const crossB = this.patternMemory.getCrossLearnedBias(b.symbol, b.rsiVal||50, null, this.prices[b.symbol], this.marketRegime);
          const crossBoostA = crossA && crossA.crossLearnedScore > 0.6 ? 1.15 : 1.0;
          const crossBoostB = crossB && crossB.crossLearnedScore > 0.6 ? 1.15 : 1.0;
          const scoreA = a.score*(pairScoreA/100)*crossBoostA;
          const scoreB = b.score*(pairScoreB/100)*crossBoostB;
          const momA = (a.mom10||0) > 1 ? 1.1 : 1.0;
          const momB = (b.mom10||0) > 1 ? 1.1 : 1.0;
          const corrA = this.corrManager.getSizeMultiplier(a.symbol, this.portfolio, this.prices, a.score);
          const corrB = this.corrManager.getSizeMultiplier(b.symbol, this.portfolio, this.prices, b.score);
          return (scoreB*momB*corrB)-(scoreA*momA*corrA);
        }).slice(0,maxPos-nOpen);

        let mtfBoost = 1.0; // default, overridden inside loop
        for(const sig of buyable){
          const price=this.prices[sig.symbol];if(!price)continue;

          // ── Ensemble + Q-Learning (progresivos) ───────────────────────────
          const h=this.history[sig.symbol]||[price];
          const rsiVal=rsi(h),bb=bollingerBands(h),atrVal=atr(h);
          const ema20=ema(h.slice(-20),20),ema50=h.length>=50?ema(h.slice(-50),50):ema20;
          const bbZone=price<bb.lower?"below_lower":price<bb.mid?"lower_half":price<bb.upper?"upper_half":"above_upper";
          const atrLevel=atrVal/(price*0.01);
          const trendData=this.intradayTrend.getTrend(sig.symbol);

          const volData=getVolumeAnomaly(this.volumeHistory,sig.symbol);
          const stateKey=this.qLearning.encodeState({rsi:rsiVal,bbZone,regime:this.marketRegime,trend:trendData.direction,volumeRatio:volData.ratio,atrLevel,fearGreed:this.fearGreed});
          const qAction=this.qLearning.chooseAction(stateKey);
          // DQN action: más inteligente que tabla Q, activo desde fase 2
          let dqnAction = qAction; // fallback to Q-table
          if(totalTrades >= 50) {
            const dqnState = this.dqn.encodeState({
              rsi:rsiVal, bbZone, regime:this.marketRegime,
              trend:trendData.direction, volumeRatio:volData.ratio,
              atrLevel, fearGreed:this.fearGreed,
              lsRatio:this.longShortRatio?.ratio||1,
              sessionHour:new Date(Date.now()+2*3600000).getUTCHours(),winStreak:0,btcTrend24h:0,volatilityPct:50
            });
            dqnAction = this.dqn.chooseAction(dqnState);
            // Store state for later training
            sig._dqnState = dqnState;
          }
          // Consensus: si Q-table y DQN coinciden → más confianza
          const dqnConsensus = dqnAction === qAction;
          const ensResult=this.ensemble.vote({rsi:rsiVal,bb,bbZone,price,regime:this.marketRegime,ema20,ema50,volumeRatio:volData.ratio,trend:trendData.direction,atr:atrVal});

          // Triple consensus: Q-table + DQN + Multi-agent todos de acuerdo
          // dqnState may not exist if totalTrades < 50 - use safe fallback
          const _dqnVec = sig._dqnState || null;
          const maAction = (_dqnVec && this.multiAgent)
            ? (this.multiAgent.chooseAction(_dqnVec, this.marketRegime)||qAction)
            : qAction;
          const allAgree  = dqnAction==="BUY" && maAction==="BUY" && qAction!=="SKIP";
          const anyVeto   = dqnAction==="SKIP" && maAction==="SKIP" && qAction==="SKIP";
          const dqnBoost  = allAgree ? 1.25 : dqnConsensus && dqnAction==="BUY" ? 1.1 : 1.0;
          if(anyVeto && learningPhase>=2) continue;

          // Fase 1: sin filtro ensemble/Q — opera todo para aprender
          // Fase 2: solo bloquea si ensemble muy negativo
          // Fase 3: requiere consenso real
          // ── Filtro por fases: más estricto a medida que el bot aprende ──────
          // Fase 1 (exploración): aprender de todo, solo filtrar scores muy bajos
          if(learningPhase===1 && sig.score<25) continue;
          // Fase 2: solo bloquear si ensemble muy negativo
          if(learningPhase===2 && ensResult.buyRatio<0.15 && qAction==="SKIP") continue;
          // DQN veto en fase 3: si DQN dice SKIP con alta confianza → no entrar
          if(learningPhase===3 && totalTrades>=200) {
            const dqnQ = sig._dqnState ? this.dqn.getQValues(sig._dqnState) : null;
            if(dqnQ && dqnQ.SKIP > dqnQ.BUY + 0.5) continue; // DQN muy convencido de SKIP
          }
          // Fase 3: consenso mínimo (más permisivo que antes para seguir aprendiendo)
          if(learningPhase===3 && ensResult.buyRatio<0.25 && qAction==="SKIP") continue;
          // PatternMemory: boost score si patrón conocido es favorable, bloquear si negativo
          const pm=this.patternMemory.getPatternScore(sig.symbol,rsiVal,bollingerBands(h),price,this.marketRegime);
          if(pm && pm.count>=5 && pm.winRate<0.30) continue; // patrón probadamente malo
          const pmBoost = pm && pm.count>=3 && pm.winRate>0.55 ? 1.15 : 1.0; // patrón bueno → boost tamaño
          // MR: solo bloquear sobrecompra clara
          // Extra: no entrar si BTC cayó >2% en las últimas 5 velas (contagio bearish)
          const btcH=this.history["BTCUSDC"]||[];
          const btcMom5=btcH.length>5?((btcH[btcH.length-1]-btcH[btcH.length-6])/btcH[btcH.length-6]*100):0;
          // BTC guard solo en caídas severas (-4%)
          if(btcMom5<-4 && sig.symbol!=="BTCUSDC" && this.marketRegime==="LATERAL") continue;

          // Pump & Dump detection: movimiento >5% en 30 velas = posible manipulación
          const pumpH = this.history[sig.symbol]||[];
          if(pumpH.length>=30) {
            const pump30 = ((pumpH[pumpH.length-1]-pumpH[pumpH.length-30])/pumpH[pumpH.length-30]*100);
            if(pump30 > 5) {
              // Precio subió >5% rápidamente → el "dip" puede seguir bajando (dump phase)
              console.log(`[P&D] ${sig.symbol} subió ${pump30.toFixed(1)}% en 30 velas → bloqueado`);
              this.reentryTs[sig.symbol] = Date.now() + 2*60*60*1000; // 2h cooldown
              continue;
            }
          }

          // Order book pressure + spoofing detection
          const obBTC = (global.obPressure||{})["BTCUSDC"]||{};
          const obSym = (global.obPressure||{})[sig.symbol]||{};
          // Si se detectó spoofing en los últimos 5min → no entrar (señal falsa)
          const spoofingRecent = obSym.spoofingDetected &&
            (Date.now() - (obSym.spoofingTs||0)) < 5*60*1000;
          if(spoofingRecent) continue;
          if(obBTC.pressure==="SELL" && obBTC.ratio<0.4 && sig.strategy!=="SCALP") {
            sig.score = Math.round(sig.score * 0.7);
          }
          const obBoost = obSym.pressure==="BUY" && obSym.ratio>2.0 ? 1.2 : 1.0;

          // On-chain: Open Interest + Taker Volume
          const oi = this.openInterest||{trend:"STABLE",change:0};
          const tv = this.takerVolume||{signal:"NEUTRAL",ratio:1};
          // OI creciendo + compradores dominando = señal fuerte de continuación
          const onChainBoost = (oi.trend==="GROWING" && tv.signal==="BUYERS_DOMINANT") ? 1.2 :
                               (oi.trend==="DECLINING" && tv.signal==="SELLERS_DOMINANT") ? 0.6 :
                               tv.signal==="BUYERS_DOMINANT" ? 1.1 :
                               tv.signal==="SELLERS_DOMINANT" ? 0.8 : 1.0;
          // OI creciendo + precio cayendo = short squeeze inminente → boost MR
          const shortSqueezeBoost = (oi.trend==="GROWING" && this.marketRegime==="BEAR" && sig.strategy==="MEAN_REVERSION") ? 1.25 : 1.0;

          // Reddit sentiment: refuerza o debilita señal
          const reddit = this.redditSentiment||{signal:"NEUTRAL",score:50};
          const redditMult = reddit.signal==="BULLISH" && sig.strategy!=="SCALP" ? 1.1 :
                             reddit.signal==="BEARISH" ? 0.85 : 1.0;
          // También considerar menciones específicas del par
          const coin = sig.symbol.replace("USDC","");
          const coinMentions = reddit.mentions?.[coin]||0;
          const mentionBoost = coinMentions>=3 && reddit.signal==="BULLISH" ? 1.1 : 1.0;

          // Long/Short ratio: si mercado muy apalancado long → peligro de liquidación masiva
          const lsRatio = this.longShortRatio||{signal:"NEUTRAL"};
          const fundRate = this.fundingRate||{signal:"NEUTRAL"};
          // Muchos longs + funding positivo alto = mercado sobrecomprado → reducir exposición MR
          const lsGuard = lsRatio.signal==="OVERLEVERAGED_LONG" && fundRate.signal==="LONGS_PAYING"
            ? 0.6  // riesgo de flush de longs
            : lsRatio.signal==="OVERLEVERAGED_SHORT" && fundRate.signal==="SHORTS_PAYING"
            ? 1.3  // potential short squeeze = buena oportunidad MR
            : 1.0;

          // Multi-timeframe: si tenemos datos 1h, confirmar que no están en tendencia opuesta
          const tf60 = (global.tfHistory||{})[sig.symbol]?.tf60||[];
          if(tf60.length>=5 && sig.strategy==="MEAN_REVERSION") {
            const tf60Trend = ((tf60[tf60.length-1]-tf60[tf60.length-5])/tf60[tf60.length-5]*100);
            // En MR: si 1h muestra caída >3% → probable que el dip siga → reducir score
            if(tf60Trend < -3) { sig.score = Math.round(sig.score * 0.75); }
            // Si 1h muestra subida → MR tiene más chance de funcionar → boost
            if(tf60Trend > 2 && this.marketRegime==="LATERAL") { sig.score = Math.min(95, Math.round(sig.score * 1.15)); }
          }

          const volAnom = getVolumeAnomaly(this.volumeHistory, sig.symbol);
          const volBoost = volAnom.anomaly && sig.score > 55 ? 1.3 : 1.0;
          // Volatility gate: ATR muy alto = mercado caótico → reducir exposición
          const h2=this.history[sig.symbol]||[];
          const curAtrPct=h2.length>14?atr(h2,14)/(h2[h2.length-1]||1)*100:2;
          const volGate = curAtrPct > 5 ? 0.5 :   // extremamente volátil → mitad
                          curAtrPct > 3 ? 0.75 :   // muy volátil → reducir
                          curAtrPct < 0.5 ? 1.1 :  // muy calmado → ligero boost
                          1.0;
          const corrMult = this.corrManager.getSizeMultiplier(sig.symbol, this.portfolio, this.prices, sig.score);
          const streakMult = this._streakMult||1.0;
          // Confidence: cuántas veces hemos visto este estado y qué resultado dio
          const stateVisits = (this.qLearning._stateVisits||{})[stateKey]||0;
          const stateQ = this.qLearning.Q[stateKey]||{BUY:0,HOLD:0,SKIP:0};
          const qConfidence = stateVisits < 5 ? 0.6 :     // estado nuevo → precaución
                              stateVisits > 50 && stateQ.BUY > stateQ.SKIP ? 1.2 : // conocido bueno
                              stateVisits > 20 && stateQ.BUY < stateQ.SKIP ? 0.7 : // conocido malo
                              1.0;
          // Kelly data from recent trades
          const recentSells = this.log.filter(l=>l.type==="SELL"&&l.pnl!=null).slice(-50);
          const kellyData = recentSells.length>=10 ? {
            trades:recentSells.length,
            winRate:Math.round(recentSells.filter(l=>l.pnl>0).length/recentSells.length*100),
            avgWin:recentSells.filter(l=>l.pnl>0).reduce((s,l)=>s+l.pnl,0)/(recentSells.filter(l=>l.pnl>0).length||1),
            avgLoss:Math.abs(recentSells.filter(l=>l.pnl<0).reduce((s,l)=>s+l.pnl,0)/(recentSells.filter(l=>l.pnl<0).length||1)),
          } : null;
          // Adaptive Kelly: ajustar por correlación real del portfolio
          const _adaptiveKellyMult = calcAdaptiveKelly(1.0, this.portfolio, this.prices, this.history);
          // Multi-timeframe boost: 1h trend alignment with 5m signal
          const _mtf5 = this.tfHistory[sig.symbol]?.price5m || null;
          const _mtf1h = this.history[sig.symbol]?.slice(-6)?.reduce((s,p)=>s+p,0)/6 || null;
          mtfBoost = (_mtf5 && _mtf1h && sig.signal==="BUY")
            ? (_mtf5 > _mtf1h ? 1.1 : 0.9)  // 5m above 1h avg = aligned trend
            : 1.0;
          // Pair performance multiplier (must be before invest)
          const _ppScore = (this.pairScores||{})[sig.symbol]||0;
          const _pairMult = _ppScore < -3 ? 0.6 : _ppScore < -1 ? 0.8 : _ppScore > 3 ? 1.15 : 1.0;
          const invest=calcPositionSize(availCash,sig.score,sig.atrPct,this.profile,nOpen,kellyData)*this.hourMultiplier*fearAdj*corrMult*volBoost*pmBoost*streakMult*qConfidence*volGate*obBoost*lsGuard*redditMult*mentionBoost*dqnBoost*onChainBoost*shortSqueezeBoost*_adaptiveKellyMult*_pairMult*mtfBoost;
          if(invest<10||invest>Math.min(availCash, tv*0.15))continue; // max 15% per position
          const qty=invest*(1-fee)/price,atrV=atr(h,14);
          // Convert SCALP to MR for better R/R learning
          if(sig.strategy==="SCALP") {
            sig.strategy = "MEAN_REVERSION";
            sig.score = Math.round(sig.score * 0.85);
          }
          const isScalpEntry = sig.strategy === "SCALP"; // always false now
          let stopLoss;
          if (isScalpEntry) {
            // SCALP is disabled (converted to MR) - this branch never runs
            stopLoss = price * 0.992;
          } else {
            // R/R enforcement: ensure stops make mathematical sense
            // MR: min 0.8% stop, MOMENTUM: min 1.0% stop
            // Stop dinámico ATR + autoaprendizaje adaptativo
            const dynStop = calcDynamicStop(price, atrV, this.marketRegime);
            const learnedPct = this.adaptiveStop
              ? this.adaptiveStop.getStop(sig.symbol, this.marketRegime, new Date().getUTCHours(), dynStop.stopPct||0.03)
              : (dynStop.stopPct||0.03);
            // Hora también afecta al sizing
            const hourMult = this.adaptiveHours
              ? this.adaptiveHours.getHourMultiplier(sig.symbol, this.marketRegime, new Date().getUTCHours())
              : 1.0;
            if(hourMult !== 1.0) sig._hourMult = hourMult; // para que calcPositionSize lo use si quiere
            stopLoss = price * (1 - learnedPct);
          }
          this.cash = Math.max(0, this.cash - invest);
          // Recalcular para siguiente trade del mismo tick
          availCash = Math.max(0, this.cash - this.totalValue()*0.05);
          this.portfolio[sig.symbol]={qty,entryPrice:price,stopLoss:+stopLoss.toFixed(4),trailingStop:+stopLoss.toFixed(4),trailingHigh:+price.toFixed(4),profitLocked:0,name:sig.name,ts:new Date().toISOString(),strategy:sig.strategy||"ENSEMBLE",rsiEntry:rsiVal,bbEntry:bb,regime:this.marketRegime,entryState:stateKey,dqnState:sig._dqnState||null,dqnAction:dqnAction||"BUY",ensembleVotes:ensResult.votes};
          const trade={type:"BUY",symbol:sig.symbol,name:sig.name,qty:+qty.toFixed(6),price:+price.toFixed(4),stopLoss:+stopLoss.toFixed(4),score:sig.score,pnl:null,mode:this.mode,fee:+(invest*fee).toFixed(4),ts:new Date().toISOString(),strategy:sig.strategy||"ENSEMBLE"};
          newTrades.push(trade);this.dailyTrades.count++;
          const g=PAIRS.find(p=>p.symbol===sig.symbol)?.group||"";groupCount[g]=(groupCount[g]||0)+1;
          console.log(`[${this.mode}][${this.marketRegime}][ENSEMBLE][BUY] ${sig.symbol} score:${sig.score} Q:${qAction} Ens:${ensResult.decision}(${(ensResult.buyRatio*100).toFixed(0)}%) $${invest.toFixed(0)} | ${this.dailyTrades.count}/${paperDailyLimit}`);
        }
      }
    }

    if(this.tick%10===0){
      const cf=PAIRS.slice(0,4).map(p=>runContrafactual(p.symbol,this.history,10)).filter(Boolean);
      if(cf.length){this.contrafactualLog=[...cf,...this.contrafactualLog].slice(0,50);const avg=cf.reduce((s,c)=>s+c.pnl,0)/cf.length;if(avg>3&&params.minScore>60)this.optimizer.params.minScore=Math.max(60,params.minScore-1);}
    }

    if(newTrades.length)this.log=[...newTrades,...this.log].slice(0,300);
    // Equity: guardamos cada tick para los últimos 500 puntos (tiempo real)
    // + puntos downsampled cada 30 ticks para historial más largo
    const ePoint={v:this.totalValue(),t:Date.now()};
    this.equity=[...this.equity,ePoint].slice(-500);
    // Historial largo: guardar 1 punto cada 30 ticks (~1 min en paper)
    if(!this.equityHistory) this.equityHistory=[];
    if(this.tick%30===0) this.equityHistory=[...this.equityHistory,ePoint].slice(-2000);
    const optResult=this.optimizer.optimize();
    if(optResult?.changes?.length>0)this.optLog=[optResult,...this.optLog].slice(0,30);

    return{signals,newTrades,circuitBreaker:cb,optimizerResult:optResult,dailyLimit:paperDailyLimit,dailyUsed:this.dailyTrades.count,drawdownAlert};
  }

  getState(){
    const tv=this.totalValue(),ret=((tv-INITIAL_CAPITAL)/INITIAL_CAPITAL)*100;
    const wins=this.log.filter(l=>l.type==="SELL"&&l.pnl>0).length,sells=this.log.filter(l=>l.type==="SELL").length;
    const wr=this.recentWinRate(),dailyLimit=getDailyLimit(this.marketRegime,wr);
    const dd=(this.maxEquity-tv)/this.maxEquity;
    return{
      prices:this.prices,history:this.history,portfolio:this.portfolio,
      cash:this.cash,log:this.log.slice(0,100),equity:this.equity.map(e=>typeof e==="object"?e:{v:e,t:Date.now()}),equityHistory:(this.equityHistory||[]).slice(-500),tick:this.tick,
      mode:this.mode,totalValue:tv,returnPct:ret,
      winRate:sells?+((wins/sells)*100).toFixed(0):null,
      pairs:PAIRS,categories:CATEGORIES,
      circuitBreaker:this.breaker.check(tv),
      optimizerParams:this.optimizer.getParams(),
      optLog:this.optLog,profile:this.profile,
      pairScores:this.pairScores,marketRegime:this.marketRegime,
      fearGreed:this.fearGreed,
      fearGreedPublished:this.fearGreedPublished||null,
      fearGreedSource:this.fearGreedSource||"unknown",
      longShortRatio:this.longShortRatio||null,
      fundingRate:this.fundingRate||null,
      redditSentiment:this.redditSentiment||null,
      openInterest:this.openInterest||null,
      takerVolume:this.takerVolume||null,
      dailyTrades:this.dailyTrades,dailyLimit:(()=>{const lp=this.learningPhase||3;return(lp===1?5000:lp===2?2000:500)+(this._dailyLimitBoost||0);})(),
      totalFees:+this.log.reduce((s,l)=>s+(l.fee||0),0).toFixed(2),
      contrafactualLog:this.contrafactualLog.slice(0,10),
      useBnb:this.useBnb,recentWinRate:wr,
      priceHistory:Object.fromEntries(Object.entries(this.history||{}).map(([k,v])=>[k,v.slice(-200)])),
      volumeAnomaly:Object.fromEntries(Object.keys(this.volumeHistory||{}).map(k=>[k,getVolumeAnomaly(this.volumeHistory,k)])),
      riskLearningStats:this.riskLearning.getStats(),
      qLearningStats:{
        states:Object.keys(this.qLearning.Q||{}).length,
        epsilon:+((this.qLearning.epsilon||0.15).toFixed(3)),
        replayBuffer:(this.qLearning._replayBuffer||[]).length,
      },
      dqnStats:this.dqn?.getStats()||null,
      walkForwardIntra:this._intradayWF||null,
      walkForwardMulti:this._multiWF||null,
      multiAgentStats:this.multiAgent?.getAllStats()||null,
      stratEvalStats:this.stratEval?.getStats()||null,
      dqnStats:this.dqn.getStats(),
      streakMult:+(this._streakMult||1.0).toFixed(2),
      walkForwardResult:this.walkForwardResult||null,
      riskLearningParams:this.riskLearning.params,
      correlationStatus:this.corrManager.getStatus(this.portfolio,this.prices),
      maxEquity:+this.maxEquity.toFixed(2),drawdownPct:+(dd*100).toFixed(2),
    };
  }

  serialize(){
    const s=this.getState();
    s.optimizerHistory=this.optimizer.history;
    if(s.learningData) s.learningData.riskLearning=this.riskLearning.toJSON();s.trailingHighs=this.trailing.highs;
    s.reentryTs=this.reentryTs;s.maxEquity=this.maxEquity;s.drawdownAlerted=this.drawdownAlerted;
    s.tfHistory=this.tfHistory;
    s.learningData={
      patternMemory:this.patternMemory.toJSON(),
      cfMemory:this.cfMemory.toJSON(),
      qLearning:this.qLearning.toJSON(),
      ensemble:this.ensemble.toJSON(),
      dqn:this.dqn.toJSON(),
      multiAgent:this.multiAgent.toJSON(),
      stratEval:this.stratEval.toJSON(),
    };
    return JSON.stringify(s);
  }
}

module.exports={CryptoBotFinal,PAIRS,CATEGORIES,INITIAL_CAPITAL};
