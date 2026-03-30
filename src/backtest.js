// backtest.js — Backtesting completo usando la lógica real del engine
// Corre offline con klines de Binance y devuelve métricas completas

const { fetchAllKlinesForPeriod } = require("./historicalSimulation");

async function runBacktest(symbols, startTime, endTime, initialCapital=50000) {
  const BNB_FEE = 0.00075;
  const PERIODS_MS = endTime - startTime;
  
  let cash = initialCapital;
  const portfolio = {};
  const trades = [];
  const equityCurve = [];
  
  // Fetch klines for all symbols
  const klines = {};
  for(const sym of symbols) {
    try {
      const candles = await fetchAllKlinesForPeriod(sym, "1h", startTime, endTime);
      if(candles.length > 50) klines[sym] = candles;
      console.log(`[BT] ${sym}: ${candles.length} velas`);
    } catch(e) { console.warn(`[BT] ${sym} error:`, e.message); }
    await new Promise(r=>setTimeout(r,200));
  }
  
  const syms = Object.keys(klines);
  if(!syms.length) return null;
  const maxLen = Math.max(...syms.map(s=>klines[s].length));
  
  // Run simulation tick by tick
  for(let i=50; i<maxLen; i++) {
    const prices = {};
    const histories = {};
    
    for(const sym of syms) {
      const arr = klines[sym];
      if(i >= arr.length) continue;
      prices[sym] = arr[i].close;
      histories[sym] = arr.slice(Math.max(0,i-100),i+1).map(c=>c.close);
    }
    
    // Simple regime from BTC
    const btcH = histories["BTCUSDC"]||[];
    const btcMa20 = btcH.length>=20 ? btcH.slice(-20).reduce((a,b)=>a+b,0)/20 : btcH[btcH.length-1]||0;
    const btcLast = btcH[btcH.length-1]||0;
    const btcTrend = btcH.length>=20 ? (btcLast-btcH[btcH.length-20])/btcH[btcH.length-20]*100 : 0;
    const regime = btcLast>btcMa20&&btcTrend>2?"BULL":btcLast<btcMa20&&btcTrend<-2?"BEAR":"LATERAL";
    
    // Exit check
    for(const [sym, pos] of Object.entries(portfolio)) {
      const cp = prices[sym];
      if(!cp) continue;
      const pnlPct = (cp-pos.entry)/pos.entry*100;
      const h = histories[sym]||[];
      // RSI for exit
      let rsiVal=50;
      if(h.length>=15){let g=0,l=0;for(let j=h.length-14;j<h.length;j++){const d=h[j]-h[j-1];if(d>0)g+=d;else l-=d;}rsiVal=l===0?100:100-100/(1+g/l);}
      const bbH=h.slice(-20),bbMid=bbH.reduce((a,b)=>a+b,0)/(bbH.length||1);
      const bbSD=Math.sqrt(bbH.reduce((s,v)=>s+(v-bbMid)**2,0)/(bbH.length||1));
      const bbPos=(cp-(bbMid-2*bbSD))/((4*bbSD)||1);
      
      const stopHit = cp<=pos.stop;
      const mrTarget = regime==="BULL"?0.92:regime==="LATERAL"?0.65:0.80;
      const targetHit = bbPos>mrTarget && rsiVal>58 && !stopHit;
      const trailHit = pnlPct>1 && cp<pos.trailHigh*0.97;
      
      if(pnlPct>0 && cp>pos.trailHigh) portfolio[sym].trailHigh=cp;
      
      if(stopHit||targetHit||trailHit) {
        const proceeds=pos.qty*cp*(1-BNB_FEE);
        cash+=proceeds;
        const realPnl=(cp-pos.entry)/pos.entry*100-BNB_FEE*200;
        trades.push({sym,entry:pos.entry,exit:cp,pnlPct:+realPnl.toFixed(2),regime:pos.regime,reason:stopHit?"STOP":targetHit?"TARGET":"TRAIL",time:klines[sym]?.[i]?.openTime});
        delete portfolio[sym];
      }
    }
    
    // Entry check - max 3 positions
    if(Object.keys(portfolio).length<3) {
      for(const sym of syms) {
        if(portfolio[sym]) continue;
        const h = histories[sym]||[];
        if(h.length<20) continue;
        const cp=prices[sym];
        let rsiVal=50;
        if(h.length>=15){let g=0,l=0;for(let j=h.length-14;j<h.length;j++){const d=h[j]-h[j-1];if(d>0)g+=d;else l-=d;}rsiVal=l===0?100:100-100/(1+g/l);}
        const bbH=h.slice(-20),bbMid=bbH.reduce((a,b)=>a+b,0)/(bbH.length||1);
        const bbSD=Math.sqrt(bbH.reduce((s,v)=>s+(v-bbMid)**2,0)/(bbH.length||1));
        const bbPos=(cp-(bbMid-2*bbSD))/((4*bbSD)||1);
        
        let signal=false;
        if(regime==="BULL"&&rsiVal<40) signal=true;
        if(regime==="LATERAL"&&bbPos<0.2&&rsiVal<38) signal=true;
        if(regime==="BEAR"&&rsiVal<22&&bbPos<0.08) signal=true;
        
        if(signal && cash>100) {
          const invest=cash*0.30;
          const atrVal=h.length>2?Math.abs(h[h.length-1]-h[h.length-2]):cp*0.02;
          const stop=cp-atrVal*2;
          const qty=invest/cp;
          cash-=invest*(1+BNB_FEE);
          portfolio[sym]={entry:cp,qty,stop,trailHigh:cp,regime};
          if(Object.keys(portfolio).length>=3) break;
        }
      }
    }
    
    if(i%100===0) {
      const tv=cash+Object.entries(portfolio).reduce((s,[sym,p])=>s+(prices[sym]||p.entry)*p.qty,0);
      equityCurve.push({t:klines[syms[0]]?.[i]?.openTime||i, v:tv});
    }
  }
  
  // Close remaining positions
  const lastPrices = {};
  for(const sym of syms) { const arr=klines[sym]; lastPrices[sym]=arr[arr.length-1]?.close||0; }
  for(const [sym,pos] of Object.entries(portfolio)) {
    const cp=lastPrices[sym]||pos.entry;
    cash+=pos.qty*cp*(1-BNB_FEE);
    trades.push({sym,entry:pos.entry,exit:cp,pnlPct:+((cp-pos.entry)/pos.entry*100).toFixed(2),regime:pos.regime,reason:"END"});
  }
  
  // Metrics
  const finalValue = cash;
  const totalReturn = (finalValue-initialCapital)/initialCapital*100;
  const wins = trades.filter(t=>t.pnlPct>0);
  const losses = trades.filter(t=>t.pnlPct<=0);
  const winRate = trades.length ? Math.round(wins.length/trades.length*100) : 0;
  const avgWin = wins.length ? wins.reduce((s,t)=>s+t.pnlPct,0)/wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s,t)=>s+t.pnlPct,0)/losses.length : 0;
  const profitFactor = avgLoss!==0 ? Math.abs(avgWin*wins.length/(avgLoss*losses.length)) : 99;
  
  // Sharpe ratio (simplified, daily)
  const returns = equityCurve.map((p,i)=>i>0?(p.v-equityCurve[i-1].v)/equityCurve[i-1].v:0).slice(1);
  const meanR = returns.reduce((a,b)=>a+b,0)/(returns.length||1);
  const stdR = Math.sqrt(returns.reduce((s,v)=>s+(v-meanR)**2,0)/(returns.length||1));
  const sharpe = stdR>0 ? +(meanR/stdR*Math.sqrt(365)).toFixed(2) : 0;
  
  // Max drawdown
  let peak=initialCapital,maxDD=0;
  for(const p of equityCurve) { if(p.v>peak)peak=p.v; const dd=(peak-p.v)/peak*100; if(dd>maxDD)maxDD=dd; }
  
  return {
    totalReturn:+totalReturn.toFixed(2), finalValue:+finalValue.toFixed(2),
    trades:trades.length, winRate, avgWin:+avgWin.toFixed(2), avgLoss:+avgLoss.toFixed(2),
    profitFactor:+profitFactor.toFixed(2), sharpe, maxDrawdown:+maxDD.toFixed(2),
    byRegime: {
      BULL:  trades.filter(t=>t.regime==="BULL"),
      LATERAL: trades.filter(t=>t.regime==="LATERAL"),
      BEAR:  trades.filter(t=>t.regime==="BEAR"),
    },
    equityCurve, periodDays: Math.round(PERIODS_MS/86400000)
  };
}

// ── Rolling Walk-Forward Analysis ─────────────────────────────────────────────
// Divide el historial en ventanas deslizantes de entrenamiento/test
// Si test_WR / train_WR < 0.6 → posible overfitting → alerta
async function runRollingWalkForward(symbols, trainDays=30, testDays=7, windows=4) {
  const now = Date.now();
  const results = [];

  for(let w=0; w<windows; w++) {
    const testEnd   = now - w * testDays * 86400000;
    const testStart = testEnd - testDays * 86400000;
    const trainEnd  = testStart;
    const trainStart= trainEnd - trainDays * 86400000;

    try {
      const [train, test] = await Promise.all([
        runBacktest(symbols, trainStart, trainEnd),
        runBacktest(symbols, testStart, testEnd),
      ]);
      if(!train||!test) continue;

      const overfitRatio = train.winRate>0 ? +(test.winRate/train.winRate).toFixed(2) : null;
      results.push({
        window: w+1,
        trainPeriod: new Date(trainStart).toISOString().slice(0,10)+' → '+new Date(trainEnd).toISOString().slice(0,10),
        testPeriod:  new Date(testStart).toISOString().slice(0,10)+' → '+new Date(testEnd).toISOString().slice(0,10),
        train: { wr:train.winRate, ret:train.totalReturn, sharpe:train.sharpe, dd:train.maxDrawdown },
        test:  { wr:test.winRate,  ret:test.totalReturn,  sharpe:test.sharpe,  dd:test.maxDrawdown  },
        overfitRatio,
        isRobust: overfitRatio!==null ? overfitRatio>=0.6 : null,
      });
    } catch(e) { console.warn(`[RWF] Window ${w+1} error:`, e.message); }
  }

  const avgOverfit = results.filter(r=>r.overfitRatio!==null).reduce((s,r)=>s+r.overfitRatio,0)/(results.length||1);
  const robustWindows = results.filter(r=>r.isRobust===true).length;

  return {
    windows: results,
    avgOverfitRatio: +avgOverfit.toFixed(2),
    robustWindows,
    totalWindows: results.length,
    verdict: avgOverfit>=0.65 ? "ROBUSTO" : avgOverfit>=0.50 ? "ACEPTABLE" : "POSIBLE_OVERFITTING",
  };
}

module.exports = { runBacktest, runRollingWalkForward };
