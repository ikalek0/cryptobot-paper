// ─── CRYPTOBOT ENGINE v3 — ESTRATEGIA ADAPTATIVA + Q-LEARNING + ENSEMBLE ─────
"use strict";

const { RISK_PROFILES, CircuitBreaker, TrailingStop, calcPositionSize, AutoOptimizer } = require("./risk");
const { PatternMemory }    = require("./patternMemory");
const { RiskLearning }     = require("./riskLearning");
const { CorrelationManager } = require("./correlationManager");
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
];

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

function computeSignal(sym,history,params,regime="UNKNOWN"){
  switch(regime){
    case"BULL":return signalMomentum(sym,history,params);
    case"LATERAL":return signalMeanReversion(sym,history,params);
    case"BEAR":return signalBear(sym,history,params);
    default:return signalMomentum(sym,history,params);
  }
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

// ── CLASE PRINCIPAL ───────────────────────────────────────────────────────────
class CryptoBotFinal {
  constructor(saved=null){
    this.profile=RISK_PROFILES["paper"];
    this.breaker=new CircuitBreaker(this.profile.maxDailyLoss);
    this.trailing=new TrailingStop();
    this.optimizer=new AutoOptimizer();
    // ── Módulos de aprendizaje v3 ──────────────────────────────────────────
    this.patternMemory  = new PatternMemory();
    this.cfMemory       = new CounterfactualMemory();
    this.qLearning      = new QLearning({ alpha:0.2, gamma:0.85, epsilon:0.25 }); // Aprendizaje más rápido en paper
    this.ensemble       = new EnsembleVoter();
    this.intradayTrend  = new IntradayTrend();
    this.riskLearning   = new RiskLearning();
    this.corrManager    = new CorrelationManager();
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
      // Restaurar módulos de aprendizaje
      if(saved.learningData){
        this.patternMemory.loadJSON(saved.learningData.patternMemory);
        this.cfMemory.loadJSON(saved.learningData.cfMemory);
        this.qLearning.loadJSON(saved.learningData.qLearning);
        this.ensemble.loadJSON(saved.learningData.ensemble);
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

    const signals=PAIRS.map(p=>({
      ...p,price:this.prices[p.symbol]||0,
      ...computeSignal(p.symbol,this.history,params,this.marketRegime),
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
      const sig=signals.find(s=>s.symbol===symbol);
      // MR exit: en LATERAL tomar beneficio en BB 65% (no esperar 90%)
      // Esto mejora WR aunque reduce tamaño de ganancia individual
      const mrTarget = this.marketRegime==="LATERAL" ? 0.65 : 0.85;
      const mrExit=sig?.bbPos>mrTarget&&sig?.rsiVal>58;
      const bearSell=this.marketRegime==="BEAR"&&pos.profitLocked<0&&ts.profitLocked<0;
      // En paper: no salir solo por señal SELL débil — esperar stop o trailing con beneficio real
      const signalExit=sig?.signal==="SELL"&&sig?.score<=(100-params.minScore-10)&&ts.profitLocked>0.5;
      if(cp<=pos.stopLoss||ts.hit||signalExit||mrExit||bearSell||timeStop){
        const proceeds=pos.qty*cp*(1-fee),pnl=((cp-pos.entryPrice)/pos.entryPrice)*100-fee*100*2;
        this.cash+=proceeds;
        const reason=cp<=pos.stopLoss?"STOP LOSS":ts.hit?"TRAILING STOP":mrExit?"MR OBJETIVO":bearSell?"BEAR EXIT":"SEÑAL VENTA";
        // Análisis contrafactual
        const futureCandles=(this.history[symbol]||[]).slice(-20).map(p=>({open:p,high:p*1.002,low:p*0.998,close:p,volume:1000}));
        const cfAnalysis=analyzeCounterfactual({...pos,symbol,pnlPct:pnl/100,exit:cp,exitReason:reason,rsiEntry:sig?.rsiVal||50,bbEntry:null,id:`${symbol}_${Date.now()}`},futureCandles);
        this.cfMemory.add(cfAnalysis);
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
        const nextState=this.qLearning.encodeState({rsi:closeRsi,bbZone:closeBBZone,regime:this.marketRegime,trend:closeTrend.direction,volumeRatio:closeVolRatio,atrLevel:closeAtr});
        this.qLearning.recordTradeOutcome(pos.entryState,pnl/100,nextState);
        this.qLearning.decayEpsilon();
        if(pos.ensembleVotes) this.ensemble.updateWeights(pos.ensembleVotes,win);
        if(Math.random()<0.05) this.patternMemory.updateCorrelations();
        delete this.portfolio[symbol];this.trailing.remove(symbol);
        if(pnl<0){
          this.reentryTs[symbol]=Date.now();
          // Circuit breaker inteligente: 5 pérdidas seguidas → pausa 30min
          this._consecutiveLosses=(this._consecutiveLosses||0)+1;
          if(this._consecutiveLosses>=5&&!this._smartPause){
            this._smartPause=Date.now()+30*60*1000;
            console.log(`[PAPER][SMART-CB] 5 pérdidas seguidas → pausa 30min`);
          }
        } else {
          this._consecutiveLosses=0;
        }
        if(this._smartPause&&Date.now()>this._smartPause) this._smartPause=null;
        const trade={type:"SELL",symbol,name:pos.name,qty:+pos.qty.toFixed(6),price:+cp.toFixed(4),pnl:+pnl.toFixed(2),reason,mode:this.mode,fee:+(pos.qty*cp*fee).toFixed(4),ts:new Date().toISOString(),strategy:pos.strategy||"MOMENTUM"};
        newTrades.push(trade);this.dailyTrades.count++;
        this.optimizer.recordTrade(pnl,reason);updatePairScore(this.pairScores,symbol,pnl);
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
        const reserve=this.totalValue()*MIN_CASH_RESERVE,availCash=Math.max(0,this.cash-reserve);
        // Score mínimo progresivo
        // Si WR muy bajo, exigir señales más fuertes para aprender qué funciona
        const baseMin = learningPhase === 1 ? 20 : learningPhase === 2 ? 35 : (this.marketRegime==="BEAR"?55:45);
        const regimeMin = isStruggling ? Math.min(baseMin + 15, 65) : baseMin;
        const fearAdj=this.fearGreed<25?1.2:this.fearGreed>80?0.6:1.0;
        const groupCount={};
        Object.keys(this.portfolio).forEach(sym=>{const p=PAIRS.find(p=>p.symbol===sym);if(p)groupCount[p.group]=(groupCount[p.group]||0)+1;});

        // Respetar pausa de Telegram
      if(this._pausedByTelegram) return {signals,newTrades,circuitBreaker:cb,optimizerResult:optResult,dailyLimit:paperDailyLimit||dailyLimit,dailyUsed:this.dailyTrades.count,drawdownAlert};
      const buyable=signals.filter(s=>{
          if(s.signal!=="BUY"||s.score<regimeMin)return false;
          if(this.portfolio[s.symbol])return false;
          if(s.isPumping)return false; // solo filtrar pumps extremos siempre
          // Cooldown corto en fase 1, normal en fase 3
          const cooldown = learningPhase===1 ? 60*1000 : learningPhase===2 ? 10*60*1000 : 30*60*1000; // paper: cooldown mínimo para aprender más
          const ll=this.reentryTs[s.symbol];if(ll&&Date.now()-ll<cooldown)return false;
          // Límite por grupo solo en fase 3
          if(learningPhase===3){const grp=PAIRS.find(p=>p.symbol===s.symbol)?.group;if(grp&&(groupCount[grp]||0)>=3)return false;}
          return true;
        }).sort((a,b)=>{
          const scoreA = a.score*(this.pairScores[a.symbol]?.score||50)/100;
          const scoreB = b.score*(this.pairScores[b.symbol]?.score||50)/100;
          // Bonus por momentum propio
          const momA = (a.mom10||0) > 1 ? 1.1 : 1.0;
          const momB = (b.mom10||0) > 1 ? 1.1 : 1.0;
          // Bonus por confirmación de pares correlacionados
          const corrA = this.corrManager.getSizeMultiplier(a.symbol, this.portfolio, this.prices, a.score);
          const corrB = this.corrManager.getSizeMultiplier(b.symbol, this.portfolio, this.prices, b.score);
          return (scoreB*momB*corrB)-(scoreA*momA*corrA);
        }).slice(0,maxPos-nOpen);

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
          const stateKey=this.qLearning.encodeState({rsi:rsiVal,bbZone,regime:this.marketRegime,trend:trendData.direction,volumeRatio:volData.ratio,atrLevel});
          const qAction=this.qLearning.chooseAction(stateKey);
          const ensResult=this.ensemble.vote({rsi:rsiVal,bb,bbZone,price,regime:this.marketRegime,ema20,ema50,volumeRatio:volData.ratio,trend:trendData.direction,atr:atrVal});

          // Fase 1: sin filtro ensemble/Q — opera todo para aprender
          // Fase 2: solo bloquea si ensemble muy negativo
          // Fase 3: requiere consenso real
          // ── Filtro por fases: más estricto a medida que el bot aprende ──────
          // Fase 1 (exploración): aprender de todo, solo filtrar scores muy bajos
          if(learningPhase===1 && sig.score<25) continue;
          // Fase 2: solo bloquear si ensemble muy negativo
          if(learningPhase===2 && ensResult.buyRatio<0.15 && qAction==="SKIP") continue;
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
          // BTC guard solo en caídas severas (-4%) para no bloquear rebotes normales
          if(btcMom5<-4 && sig.symbol!=="BTCUSDC" && this.marketRegime==="LATERAL") continue;

          const volAnom = getVolumeAnomaly(this.volumeHistory, sig.symbol);
          const volBoost = volAnom.anomaly && sig.score > 55 ? 1.3 : 1.0;
          const corrMult = this.corrManager.getSizeMultiplier(sig.symbol, this.portfolio, this.prices, sig.score);
          const invest=calcPositionSize(availCash,sig.score,sig.atrPct,this.profile,nOpen)*this.hourMultiplier*fearAdj*corrMult*volBoost*pmBoost;
          if(invest<10||invest>availCash)continue;
          const qty=invest*(1-fee)/price,atrV=atr(h,14);
          // Paper: stop más amplio (5%) para dar tiempo a aprender, no salir en cada fluctuación
          const minStop=price*0.950,stopLoss=Math.min(price-Math.max(this.profile.atrMultiplier*atrV,price*0.025),minStop);
          this.cash-=invest;
          this.portfolio[sig.symbol]={qty,entryPrice:price,stopLoss:+stopLoss.toFixed(4),trailingStop:+stopLoss.toFixed(4),trailingHigh:+price.toFixed(4),profitLocked:0,name:sig.name,ts:new Date().toISOString(),strategy:sig.strategy||"ENSEMBLE",rsiEntry:rsiVal,bbEntry:bb,regime:this.marketRegime,entryState:stateKey,ensembleVotes:ensResult.votes};
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
      fearGreedSource:this.fearGreedSource||"unknown",dailyTrades:this.dailyTrades,dailyLimit,
      totalFees:+this.log.reduce((s,l)=>s+(l.fee||0),0).toFixed(2),
      contrafactualLog:this.contrafactualLog.slice(0,10),
      useBnb:this.useBnb,recentWinRate:wr,
      priceHistory:Object.fromEntries(Object.entries(this.history||{}).map(([k,v])=>[k,v.slice(-200)])),
      volumeAnomaly:Object.fromEntries(Object.keys(this.volumeHistory||{}).map(k=>[k,getVolumeAnomaly(this.volumeHistory,k)])),
      riskLearningStats:this.riskLearning.getStats(),
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
    };
    return JSON.stringify(s);
  }
}

module.exports={CryptoBotFinal,PAIRS,CATEGORIES,INITIAL_CAPITAL};
