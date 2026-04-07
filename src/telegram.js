// ─── TELEGRAM FINAL ───────────────────────────────────────────────────────────
"use strict";

const https = require("https");
const TOKEN   = process.env.TELEGRAM_TOKEN   || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

function send(text) {
  if(!TOKEN||!CHAT_ID) return;
  const body=JSON.stringify({chat_id:CHAT_ID,text,parse_mode:"HTML"});
  const req=https.request({hostname:"api.telegram.org",path:`/bot${TOKEN}/sendMessage`,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}},res=>{if(res.statusCode!==200)console.warn("[TG]",res.statusCode);});
  req.on("error",e=>console.warn("[TG]",e.message));
  req.write(body);req.end();
}

// ── Eventos importantes únicamente ───────────────────────────────────────────
function notifyCircuitBreaker(drawdown) { send(`📋 ⚡ <b>[PAPER] CIRCUIT BREAKER</b>\nPérdida diaria: <b>${(Math.abs(drawdown)*100).toFixed(2)}%</b>\nBot pausado hasta mañana.`); }
function notifyBigWin(trade)  { send(`📋 💰 <b>[PAPER] GANANCIA IMPORTANTE</b>\n<b>${trade.symbol}</b>  +${trade.pnl}%\nPrecio: $${trade.price}  Comisión: $${trade.fee}`); }
function notifyBigLoss(trade) { send(`📋 📉 <b>[PAPER] PÉRDIDA IMPORTANTE</b>\n<b>${trade.symbol}</b>  ${trade.pnl}%\nRazón: ${trade.reason}`); }
function notifyDefensiveMode(btcDrawdown) { send(`📋 🛡️ <b>[PAPER] MODO DEFENSIVO</b>\nBTC cayó <b>${Math.abs(btcDrawdown)}%</b> desde el máximo de hoy. Sin nuevas posiciones.`); }
function notifyDefensiveOff()  { send(`📋 ✅ <b>[PAPER] Modo defensivo desactivado</b> — Bot retoma operaciones.`); }
function notifyBlacklist(sym)  { send(`📋 🚫 <b>[PAPER] ${sym} bloqueado 1h</b> — 5 pérdidas consecutivas.`); }
function notifyOptimizer(r)    { if(!r?.changes?.length)return; send(`📋 🧠 <b>[PAPER] OPTIMIZADOR</b>\nWR: ${r.winRate}%  avgP&L: ${r.avgPnl}%\nCambios: ${r.changes.join(", ")}`); }
function notifyNightlyReplay(b){ send(`📋 🌙 <b>[PAPER] REPLAY NOCTURNO</b>\nMejor estrategia: EMA ${b.params.emaFast}/${b.params.emaSlow} · Score ${b.params.minScore}\nWR: ${b.winRate}%  avgP&L: ${b.avgPnl}%`); }
function notifyNewsAlert(news) { send(`📋 ⚠️ <b>[PAPER] NOTICIA IMPORTANTE</b>\n${news.title}\nPares: ${news.currencies?.join(", ")||"—"}`); }
function notifyFearGreed(val,label) { const e=val<25?"😱":val>75?"🤑":"😐"; send(`${e} <b>Fear & Greed: ${val} — ${label}</b>\n${val<30?"Posible oportunidad de compra":val>75?"Mercado sobrecomprado, precaución":""}`); }
function notifyDailyLimitChange(regime,limit,wr){ send(`📋 📊 <b>[PAPER] Límite diario actualizado</b>\nRégimen: ${regime} | WR reciente: ${wr||"—"}%\nNuevo límite: <b>${limit} operaciones/día</b>`); }

function notifyStartup(mode) {
  send(`📋 <b>📋 PAPER BOT arrancado</b>\nModo: <b>${mode}</b>\n\n✅ Trailing Stop · Circuit Breaker · Modo Defensivo\n✅ Blacklist · Auto-Optimizer · Horarios óptimos\n✅ Fear & Greed · Alertas noticias · Replay nocturno\n✅ Contrafactual · Score por par · Régimen mercado\n✅ Límite diario dinámico · Comisiones BNB\n✅ PostgreSQL · BAFIR TRADING conectado\n\n/estado /semana /ayuda`);
}

// ── Resúmenes ─────────────────────────────────────────────────────────────────
function buildDaily(state) {
  const tv=state.totalValue||10000,ret=state.returnPct||0;
  const today=new Date().toDateString();
  const ts=(state.log||[]).filter(l=>l.type==="SELL"&&l.ts&&new Date(l.ts).toDateString()===today);
  const wins=ts.filter(l=>l.pnl>0).length,pnl=ts.reduce((s,l)=>s+(l.pnl||0),0),fees=ts.reduce((s,l)=>s+(l.fee||0),0);
  return `📋 ${ret>=0?"📈":"📉"} <b>[PAPER] RESUMEN DIARIO</b> — ${new Date().toLocaleDateString("es-ES")}\n\n`+
    `💼 Capital: <b>$${tv.toFixed(2)}</b>  (${ret>=0?"+":""}${ret.toFixed(2)}%)\n`+
    `📋 Hoy: ${ts.length} ops · ${wins}/${ts.length} ganadoras · P&L ${pnl>=0?"+":""}${pnl.toFixed(2)}%\n`+
    `💸 Comisiones: $${fees.toFixed(2)}  |  WR global: ${state.winRate||"—"}%\n`+
    `🌡️ Fear & Greed: ${state.fearGreed||"—"} (${state.fearGreedSource||"?"})  |  Régimen: ${state.marketRegime||"—"}\n`+
    `📊 Límite hoy: ${state.dailyTrades?.count||0}/${state.dailyLimit||10} ops\n`+
    `⚙️ Score mín: ${state.optimizerParams?.minScore||65} | EMA ${state.optimizerParams?.emaFast}/${state.optimizerParams?.emaSlow}`;
}
function buildWeekly(state) {
  const tv=state.totalValue||10000,ret=state.returnPct||0;
  const wa=Date.now()-7*24*60*60*1000;
  const ws=(state.log||[]).filter(l=>l.type==="SELL"&&l.ts&&new Date(l.ts).getTime()>wa);
  const wins=ws.filter(l=>l.pnl>0).length,pnl=ws.reduce((s,l)=>s+(l.pnl||0),0),fees=ws.reduce((s,l)=>s+(l.fee||0),0);
  const wr=ws.length?Math.round(wins/ws.length*100):0;
  const sorted=[...ws].sort((a,b)=>b.pnl-a.pnl),best=sorted[0],worst=sorted[sorted.length-1];
  const topPairs=Object.entries(state.pairScores||{}).sort((a,b)=>b[1].score-a[1].score).slice(0,3).map(([s,p])=>`${s}(${p.score})`).join(", ");
  return `📋 ${ret>=0?"🏆":"📉"} <b>[PAPER] RESUMEN SEMANAL</b>\n\n`+
    `💼 Capital: <b>$${tv.toFixed(2)}</b>  (${ret>=0?"+":""}${ret.toFixed(2)}%)\n`+
    `📋 ${ws.length} ops · WR ${wr}% · P&L ${pnl>=0?"+":""}${pnl.toFixed(2)}% · Fees $${fees.toFixed(2)}\n`+
    (best?`🥇 Mejor: <b>${best.symbol}</b> +${best.pnl}%\n`:"")+
    (worst?`💀 Peor: <b>${worst.symbol}</b> ${worst.pnl}%\n`:"")+
    `⭐ Top pares: ${topPairs||"—"}\n`+
    `📈 Régimen: ${state.marketRegime||"—"} | Fear&Greed: ${state.fearGreed||"—"}`;
}

function notifyDailySummary(state)  { send(buildDaily(state)); }
function notifyWeeklySummary(state) { send(buildWeekly(state)); }

// ── Comandos Telegram completos ───────────────────────────────────────────────
let lastUpdateId=0;
function startCommandListener(getState, botControls={}) {
  if(!TOKEN) return;
  
  function buildHelp(mode) {
    return "📖 <b>Comandos BAFIR " + mode + "</b>\n\n" +
      "<b>Info:</b>\n/estado /semana /posiciones /log\n/noticias /momentum /aprendizaje /riesgo\n\n" +
      "<b>Control:</b>\n/pausa — pausar nuevas entradas\n/reanudar — reanudar\n/modo — configuración actual\n" +
      (mode.includes("LIVE") ? "/balance — balance Binance real" : "");
  }

  function buildPositions(state) {
    const entries = Object.entries(state.portfolio||{});
    if (!entries.length) return "📭 <b>Sin posiciones abiertas</b>";
    const lines = entries.map(([sym,pos]) => {
      const cp=(state.prices||{})[sym]||pos.entryPrice;
      const pnl=((cp-pos.entryPrice)/pos.entryPrice*100).toFixed(2);
      const e=pnl>=2?"🟢":pnl>=0?"🟡":pnl>=-2?"🟠":"🔴";
      return e+" <b>"+sym.replace("USDT","")+"</b> "+(pnl>=0?"+":"")+pnl+"% · Stop $"+pos.stopLoss+" · "+pos.strategy;
    });
    return "📊 <b>Posiciones abiertas ("+entries.length+")</b>\n"+lines.join("\n");
  }

  function buildLog10(state) {
    const sells=(state.log||[]).filter(l=>l.type==="SELL").slice(0,10);
    if(!sells.length) return "📭 Sin operaciones aún";
    return "📋 <b>Últimas ops</b>\n"+sells.map(t=>{
      const p=(t.pnl||0).toFixed(2),e=t.pnl>=2?"💰":t.pnl>=0?"✅":"❌";
      const h=t.ts?new Date(t.ts).toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"}):"";
      return e+" "+t.symbol.replace("USDT","")+" "+(t.pnl>=0?"+":"")+p+"% · "+t.reason+" "+h;
    }).join("\n");
  }

  function buildMomentum(state) {
    const dp=state.dailyPnlPct||0, m=state.momentumMult||1;
    const lvl=dp<0?"🛡 Defensivo":dp<3?"— Normal":dp<7?"🚀 Boosted ×"+m.toFixed(1):dp<12?"🚀🚀 Fuerte ×"+m.toFixed(1):"🔥🔥 Máximo ×"+m.toFixed(1);
    const ts=(state.log||[]).filter(l=>l.type==="SELL"&&l.ts&&new Date(l.ts).toDateString()===new Date().toDateString());
    return "⚡ <b>Momentum hoy</b>\nP&L: <b>"+(dp>=0?"+":"")+dp.toFixed(2)+"%</b>\n"+lvl+"\nOps: "+ts.length+" ("+ts.filter(l=>l.pnl>0).length+" ganadoras)";
  }

  function buildLearning(state) {
    const t=(state.log||[]).filter(l=>l.type==="SELL").length;
    const ph=t<100?"🌱 Fase 1 (exploración)":t<500?"🔧 Fase 2 (refinamiento)":"🎯 Fase 3 (optimizado)";
    const ql=state.qLearningStats||{};
    const dqn=state.dqnStats||{};
    const qStates=ql.states||0;
    const eps=ql.epsilon!=null?(ql.epsilon*100).toFixed(1)+"%":"?";
    const replay=ql.replayBuffer||0;
    const wf=state.walkForwardResult;
    const wfLine=wf?"\nWF: Train "+wf.trainWR+"% -> Test "+wf.testWR+"% (ratio "+wf.overfit+")":"";
    const streak=state.streakMult!=null?"\nStreak: x"+state.streakMult.toFixed(2):"";
    const dqnInfo=dqn.totalUpdates>0?"\nDQN: "+dqn.totalUpdates+" updates | loss:"+dqn.avgLoss.toFixed(5)+" | buf:"+dqn.replaySize:"\nDQN: aun pre-entrenando";
    return "[PAPER] Aprendizaje\n"+ph+"\n\nTrades: "+t+" | WR: "+(state.winRate||0)+"%\nRegimen: "+(state.marketRegime||"?")+" | F&G: "+(state.fearGreed||"?")+"\n\nQ-Table: "+qStates+" estados | Exploracion: "+eps+"\nBuffer: "+replay+dqnInfo+wfLine+streak;
  }

  function buildRisk(state) {
    const p=state.optimizerParams||{};
    return "⚙️ <b>Parámetros</b>\nScore min: "+p.minScore+"\nEMA: "+p.emaFast+"/"+p.emaSlow+"\nRSI oversold: "+p.rsiOversold+"\nATR: "+p.atrMult;
  }

  let paused=false;

  function poll() {
    const req=https.get("https://api.telegram.org/bot"+TOKEN+"/getUpdates?offset="+(lastUpdateId+1)+"&timeout=20",res=>{
      let d="";res.on("data",c=>d+=c);
      res.on("end",()=>{
        try {
          const json=JSON.parse(d);
          for(const u of(json.result||[])){
            lastUpdateId=u.update_id;
            const text=(u.message?.text||"").trim();
            const chatId=u.message?.chat?.id?.toString();
            if(chatId!==CHAT_ID){continue;}
            const state=getState();
            if(!state||state.loading) return send("⏳ Bot inicializando, intenta en unos segundos.");
            const mode=state.instance||state.mode||"BOT";
            if(text==="/estado")       send(buildDaily(state));
            else if(text==="/semana")  send(buildWeekly(state));
            else if(text==="/posiciones") send(buildPositions(state));
            else if(text==="/log")     send(buildLog10(state));
            else if(text==="/momentum")send(buildMomentum(state));
            else if(text==="/aprendizaje"){
              const ma=state.multiAgentStats||{};
              const agents=ma.agents||{};
              const maLines=Object.entries(agents).filter(([,a])=>a.trades>0)
                .map(([r,a])=>r+": WR "+a.winRate+"% ("+a.trades+" trades, eps "+a.dqn?.epsilon+")").join("\n");
              send(buildLearning(state)+(maLines?"\n\nAgentes especializados:\n"+maLines:""));
            }
            else if(text==="/riesgo")  send(buildRisk(state));
            else if(text==="/pausa"){
              paused=true;
              if(botControls.setPaused) botControls.setPaused(true);
              send("⏸ <b>Bot pausado</b>\nNo se abrirán nuevas posiciones. Stops activos.");
            }
            else if(text==="/reanudar"){
              paused=false;
              if(botControls.setPaused) botControls.setPaused(false);
              send("▶️ <b>Bot reanudado</b>\nOperaciones normales restauradas.");
            }
            else if(text==="/modo"){
              const cp=state.cryptoPanic||{};
              send("⚙️ <b>Modo: "+mode+"</b>\nRégimen: "+(state.marketRegime||"—")+"\nDefensivo: "+(state.marketDefensive?"SÍ":"NO")+"\nCP: "+(cp.globalDefensive?"🚨 ALERTA":"✅ OK")+"\n×"+(state.momentumMult||1).toFixed(2)+"\nPausado: "+(paused?"SÍ":"NO"));
            }
            else if(text==="/noticias"){
              const cp=state.cryptoPanic||{};
              send("📰 <b>CryptoPanic</b>\n"+(cp.globalDefensive?"🚨 DEFENSIVO GLOBAL":"✅ Normal")+"\nPares: "+((cp.defensivePairs||[]).map(p=>p.replace("USDT","")).join(",")||"ninguno")+"\nCheck: "+(cp.lastCheck?new Date(cp.lastCheck).toLocaleTimeString("es-ES"):"—"));
            }
            else if(text==="/balance" && botControls.getBalance){
              botControls.getBalance().then(bal=>{
                if(!bal||!bal.length){send("❌ Sin conexión Binance real");return;}
                send("💰 <b>Balance</b>\n"+bal.filter(b=>parseFloat(b.free)>0.001).map(b=>b.asset+": "+parseFloat(b.free).toFixed(4)).join("\n"));
              }).catch(()=>send("❌ Error balance"));
            }
                        else if(text==="/estrategias"){
              const se=state.stratEvalStats||{weights:{},performance:{},adaptations:[]};
              const w=se.weights||{};
              const lines=Object.entries(w).map(([s,v])=>s+": x"+v).join("\n");
              const last=se.adaptations?.slice(-2).map(a=>a.changes?.join(", ")||"").join("\n")||"Sin adaptaciones aun";
              send("[PAPER] Meta-learning estrategias\n\nPesos actuales:\n"+lines+"\n\nUltimas adaptaciones:\n"+last);
            }
            else if(text==="/mercado"){
              const ls=state.longShortRatio||{ratio:"?",signal:"?"};
              const fr=state.fundingRate||{rate:"?",signal:"?"};
              const rs=state.redditSentiment||{score:50,signal:"?",postCount:0};
              const fgE=state.fearGreed<20?"PANICO":state.fearGreed<40?"MIEDO":state.fearGreed>75?"CODICIA":"NEUTRAL";
              const msg="[PAPER] Estado del mercado\n\n"+
                "Regimen: "+(state.marketRegime||"?")+"\n"+
                "Fear&Greed: "+(state.fearGreed||"?")+" "+fgE+" ("+(state.fearGreedSource||"?")+")"+"\n"+
                "Reddit sentiment: "+rs.score+"/100 "+rs.signal+" ("+rs.postCount+" posts)"+"\n\n"+
                "Long/Short: "+ls.ratio+" -> "+ls.signal+"\n"+
                "Funding BTC: "+fr.rate+"% -> "+fr.signal+"\n\n"+
                "Defensivo: "+(state.marketDefensive?"SI":"NO");
              send(msg);
            }
            else if(text==="/top"){
              const ps=state.pairScores||{};
              const pairs=Object.entries(ps)
                .map(([s,p])=>({s:s.replace("USDC",""),wins:p.wins||0,losses:p.losses||0,pnl:+(p.totalPnl||0).toFixed(1),wr:p.wins+p.losses>0?Math.round(p.wins/(p.wins+p.losses)*100):0}))
                .filter(p=>p.wins+p.losses>=2)
                .sort((a,b)=>b.pnl-a.pnl);
              if(!pairs.length){send("No hay datos suficientes por par aun");return;}
              const fmt=(p)=>(p.wr>=50?"G ":"X ")+""+p.s+": WR "+p.wr+"% P&L "+(p.pnl>0?"+":"")+p.pnl+"%";
              const top=pairs.slice(0,5).map(fmt).join("\n");
              const worst=pairs.slice(-3).reverse().map(fmt).join("\n");
              send("PAPER Ranking de pares\n\nMejores:\n"+top+"\n\nPeores:\n"+worst);
            }
            else if(text==="/walkforward"){
              const wf = state.walkForwardResult;
              if(!wf) send("🔄 Walk-forward aún no calculado (espera a que termine la simulación histórica)");
              else send(`📊 <b>[PAPER] Walk-Forward Analysis</b>
Entrenamiento: WR ${wf.trainWR}% (${wf.trainN} ops)
Test real: WR ${wf.testWR}% (${wf.testN} ops)
Ratio: ${wf.overfit} ${parseFloat(wf.overfit)<0.7?"⚠️ Overfitting posible":"✅ Robusto"}`);
            }
            else if(text==="/situacion") {
              const s = getState ? getState() : {};
              if(!s||s.loading) return send("❌ Bot no iniciado aún");
              const HR2 = "─────────────────────";
              const tv = s.totalValue||0, cash = s.cash||0;
              const regime = s.marketRegime||"UNKNOWN";
              const fg = s.fearGreed||50;
              const fgLabel = fg<25?"😱 Pánico":fg<40?"😟 Miedo":fg<60?"😐 Neutral":fg<75?"😊 Codicia":"🤑 Euforia";
              const wr = s.recentWinRate??null;
              const dp = s.dailyPnlPct||0, ret = s.returnPct||0;
              const allSells = (s.log||[]).filter(l=>l.type==="SELL");
              const todaySells = allSells.filter(l=>Date.now()-new Date(l.ts||0).getTime()<86400000);
              const todayWins = todaySells.filter(l=>l.pnl>0).length;
              const todayPnlAbs = todaySells.reduce((a,l)=>a+(l.pnlAbs||0),0);
              const openPos = Object.entries(s.portfolio||{});
              const mom = s.momentumMult||1;
              const posLines = openPos.length
                ? openPos.slice(0,8).map(([sym,pos])=>{
                    const price = s.prices?.[sym]||pos.entryPrice;
                    const pnl = ((price-pos.entryPrice)/pos.entryPrice*100);
                    return `${pnl>0?"🟢":pnl<-1?"🔴":"🟡"} ${sym.replace("USDC","")} ${pnl>=0?"+":""}${pnl.toFixed(2)}% · ${pos.strategy||"—"}`;
                  }).join("\n")+(openPos.length>8?`\n... y ${openPos.length-8} más`:"")
                : "Sin posiciones abiertas";
              const lastOps = todaySells.slice(0,5).map(t=>
                `${t.pnl>0?"✅":t.pnl<-1?"❌":"⚠️"} ${(t.symbol||"").replace("USDC","")} ${t.pnl>=0?"+":""}${(t.pnl||0).toFixed(2)}% · ${t.reason||""}`
              ).join("\n")||"Sin operaciones hoy";
              const regimeEx = regime==="BULL"?"alcista — entradas más agresivas":regime==="BEAR"?"bajista — solo rebotes extremos":"lateral — mean reversion y scalps selectivos";
              const fgEx = fg<25?"pánico extremo = oportunidad de rebote":fg<40?"miedo = bot más selectivo":fg>75?"euforia = reduciendo exposición":"neutral = parámetros estándar";
              const momEx = mom<=0.7?"defensivo por P&L negativo":mom>=1.5?"agresivo por P&L positivo":"neutro";
              send([
                `📋 <b>SITUACIÓN PAPER</b>`,
                HR2,
                `💼 Capital: <b>$${tv.toFixed(2)}</b> (${ret>=0?"+":""}${ret.toFixed(2)}% total)`,
                `📅 Hoy: <b>${todaySells.length} ops</b> · ${todayWins} ganadoras · WR ${wr!=null?wr+"%":"—"} · P&L ${dp>=0?"+":""}${dp.toFixed(2)}%`,
                `💰 Abs hoy: ${todayPnlAbs>=0?"+":""}$${Math.abs(todayPnlAbs).toFixed(2)} | Efectivo: $${cash.toFixed(2)}`,
                HR2,
                `🌡️ Régimen: <b>${regime}</b> | F&G: <b>${fg} ${fgLabel}</b>`,
                HR2,
                `📂 Posiciones (${openPos.length}):\n${posLines}`,
                HR2,
                `🔄 Últimas ops hoy:\n${lastOps}`,
                HR2,
                `🧠 Contexto: Régimen ${regimeEx}. Sentimiento: ${fgEx}. Momentum: ${momEx}.`,
              ].join("\n"));
            }
            
            else if(text==="/resetcapital") {
                // Reset capital to $50k KEEPING all learning:
                // DQN weights, Q-table, MultiAgent, StrategyEvaluator, trade history
                // Only resets: cash, portfolio (open positions), equity curve
                const bot = botControls.getBot?.();
                if(!bot) return send("❌ Bot no disponible");
                const oldTv = bot.totalValue ? bot.totalValue() : 0;
                const oldCash = bot.cash||0;
                const openPos = Object.keys(bot.portfolio||{}).length;
                
                // Reset capital state KEEPING all learning
                bot.cash = 50000;
                bot.portfolio = {};
                bot.equity = [{v:50000, t:Date.now()}];
                bot.maxEquity = 50000;
                bot.dailyTrades = {count:0, date:new Date().toDateString()};
                
                // Save immediately
                if(bot.saveState) bot.saveState().catch(e=>console.warn("[RESET] Save error:", e.message));
                
                send([
                  "✅ <b>Capital reseteado a $50,000</b>",
                  "─────────────────────",
                  `Capital anterior: $${oldTv.toFixed(2)}`,
                  `Efectivo anterior: $${oldCash.toFixed(2)}`,
                  `Posiciones cerradas: ${openPos}`,
                  "",
                  "✅ Mantenido intacto:",
                  "• DQN weights y replay buffer",
                  "• Q-Learning table",
                  "• MultiAgent (4 agentes)",
                  "• StrategyEvaluator",
                  `• Historial de ${(bot.log||[]).filter(l=>l.type==="SELL").length} trades`,
                  "• Pair scores y blacklist",
                  "",
                  "💼 Nuevo capital: $50,000 USDC",
                ].join("\n"));
              }
            else if(text==="/ayuda") send(buildHelp(mode));
          }
        } catch(e){}
        setTimeout(poll,1000);
      });
    });
    req.on("error",()=>setTimeout(poll,5000));
    req.setTimeout(25000,()=>{req.destroy();setTimeout(poll,1000);});
  }
  poll();
  console.log("[TG] Comandos: /estado /posiciones /log /pausa /reanudar /momentum /noticias /riesgo /aprendizaje /walkforward /ayuda");
  return { isPaused: () => paused };
}


// ── Programar resúmenes ───────────────────────────────────────────────────────
function scheduleReports(getState) {
  function msUntil(h,m=0){const now=new Date(),next=new Date();next.setHours(h,m,0,0);if(next<=now)next.setDate(next.getDate()+1);return next-now;}
  function msUntilSunday(){const now=new Date(),next=new Date();const d=(7-now.getDay())%7||7;next.setDate(now.getDate()+d);next.setHours(20,0,0,0);return next-now;}
  setTimeout(()=>{notifyDailySummary(getState());setInterval(()=>notifyDailySummary(getState()),24*60*60*1000);},msUntil(20));
  setTimeout(()=>{notifyWeeklySummary(getState());setInterval(()=>notifyWeeklySummary(getState()),7*24*60*60*1000);},msUntilSunday());
  console.log(`[TG] Diario en ${Math.round(msUntil(20)/60000)}min | Semanal en ${Math.round(msUntilSunday()/3600000)}h`);
}

function notifyMomentumBoost(mult, pnlPct) {
  if (mult >= 1.6) send(`🚀 <b>PAPER MOMENTUM x${mult.toFixed(1)}</b>\nP&L hoy: <b>+${pnlPct.toFixed(1)}%</b>\nAprendiendo con posiciones más grandes.`);
}
function notifyTradeWithExplanation(trade, regime) {
  if (!trade || trade.type !== "SELL" || Math.abs(trade.pnl||0) < 1) return;
  const sym = (trade.symbol||"").replace("USDT","") || "—";
  const pnl = trade.pnl || 0;
  const emoji = pnl >= 3 ? "💰" : pnl >= 0 ? "✅" : "⚠️";
  const reason = trade.reason || "señal";
  const msg = emoji+" <b>[PAPER] "+sym+" "+(pnl>=0?"+":"")+pnl.toFixed(2)+"%</b>\nRazón: "+reason+" · Régimen: "+regime;
  send(msg);
}

module.exports = {
  notifyCircuitBreaker,notifyBigWin,notifyBigLoss,
  notifyDefensiveMode,notifyDefensiveOff,notifyBlacklist,
  notifyOptimizer,notifyNightlyReplay,notifyNewsAlert,
  notifyFearGreed,notifyDailyLimitChange,notifyStartup,
  notifyDailySummary,notifyWeeklySummary,
  scheduleReports,startCommandListener,
  notifyMomentumBoost, notifyTradeWithExplanation, send,
};

// ── Notificaciones sync paper→live ────────────────────────────────────────────
function notifyPaperExport(stats, params) {
  send(`📤 <b>PAPER → LIVE exportando parámetros</b>\nWR 7d: ${stats.winRate}% | ${stats.nTrades} ops\nEMA ${params.emaFast}/${params.emaSlow} | Score ${params.minScore}\nEl LIVE evaluará si los adopta.`);
}
module.exports.notifyPaperExport = notifyPaperExport;

function notifyMaxDrawdown(alert) {
  send(`🚨 <b>ALERTA DRAWDOWN MÁXIMO</b>\nPérdida desde máximo: <b>${alert.drawdownPct}%</b>\nMáximo histórico: $${alert.maxEquity}\nValor actual: $${alert.currentEquity}\nRevisa la estrategia manualmente.`);
}
module.exports.notifyMaxDrawdown = notifyMaxDrawdown;
