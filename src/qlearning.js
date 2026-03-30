// qlearning.js — Q-Learning ligero + Ensemble de estrategias con votación ponderada

// ── Q-Learning ────────────────────────────────────────────────────────────────
const ACTIONS = ['BUY', 'HOLD', 'SKIP'];

class QLearning {
  constructor({ alpha = 0.1, gamma = 0.9, epsilon = 0.15 } = {}) {
    this.alpha = alpha;   // learning rate
    this.gamma = gamma;   // discount factor
    this.epsilon = epsilon; // exploration rate
    this.Q = {};          // { stateKey: { BUY: 0, HOLD: 0, SKIP: 0 } }
    this.lastState = null;
    this.lastAction = null;
  }

  // ── State encoding ──────────────────────────────────────────────────────
  encodeState({ rsi, bbZone, regime, trend, volumeRatio, atrLevel }) {
    const rsiBin = rsi < 25 ? 'vs_low' : rsi < 35 ? 'low' : rsi < 45 ? 'mid_low' :
                   rsi < 55 ? 'mid' : rsi < 65 ? 'mid_high' : rsi < 75 ? 'high' : 'vs_high';
    const atrBin = atrLevel < 0.5 ? 'calm' : atrLevel < 1.5 ? 'normal' : 'volatile';
    const volBin = volumeRatio > 1.5 ? 'high_vol' : volumeRatio < 0.7 ? 'low_vol' : 'normal_vol';
    return `${regime}|${rsiBin}|${bbZone}|${trend}|${atrBin}|${volBin}`;
  }

  _initState(key) {
    if (!this.Q[key]) this.Q[key] = { BUY: 0, HOLD: 0, SKIP: 0 };
  }

  // ── Choose action (epsilon-greedy) ──────────────────────────────────────
  chooseAction(stateKey) {
    this._initState(stateKey);
    if (Math.random() < this.epsilon) {
      // Explore
      return ACTIONS[Math.floor(Math.random() * ACTIONS.length)];
    }
    // Exploit best known action
    const q = this.Q[stateKey];
    return Object.entries(q).reduce((best, [a, v]) => v > best[1] ? [a, v] : best, ['HOLD', -Infinity])[0];
  }

  // ── Update Q-value after observing reward ───────────────────────────────
  update(state, action, reward, nextState) {
    this._initState(state);
    this._initState(nextState);
    const maxNextQ = Math.max(...Object.values(this.Q[nextState]));
    const oldQ = this.Q[state][action];
    this.Q[state][action] = oldQ + this.alpha * (reward + this.gamma * maxNextQ - oldQ);
  }

  // ── Record outcome of a trade ────────────────────────────────────────────
  recordTradeOutcome(entryState, pnlPct, nextState) {
    // Reward: scaled pnl, capped at ±2
    const reward = Math.max(-2, Math.min(2, pnlPct * 20));
    const resolvedNext = nextState || entryState;
    this.update(entryState, this.lastAction || "BUY", reward, resolvedNext);
    this.lastState = null; this.lastAction = null;
  }

  encodeState_fromLast() { return this.lastState; }

  // ── Decay epsilon over time ──────────────────────────────────────────────
  decayEpsilon(minEpsilon = 0.03, factor = 0.9995, totalTrades = 0) {
    // Más agresivo después de 500 trades - ya exploró suficiente
    const adjustedMin = totalTrades > 500 ? 0.03 : totalTrades > 200 ? 0.05 : 0.08;
    const adjustedFactor = totalTrades > 500 ? 0.999 : 0.9995;
    this.epsilon = Math.max(adjustedMin, this.epsilon * adjustedFactor);
  }

  // ── Stats ────────────────────────────────────────────────────────────────
  getTopStates(topN = 10) {
    return Object.entries(this.Q)
      .map(([state, actions]) => ({
        state,
        bestAction: Object.entries(actions).reduce((b, [a, v]) => v > b[1] ? [a, v] : b, ['', -Infinity]),
        values: actions,
      }))
      .sort((a, b) => b.bestAction[1] - a.bestAction[1])
      .slice(0, topN);
  }

  toJSON() { return { Q: this.Q, epsilon: this.epsilon, alpha: this.alpha, gamma: this.gamma }; }
  loadJSON(data) {
    if (!data) return;
    if (data.Q) this.Q = data.Q;
    if (data.epsilon !== undefined) this.epsilon = data.epsilon;
  }
}

// ── Ensemble de estrategias con votación ponderada ────────────────────────────

/**
 * Cada estrategia es una función que recibe el contexto de mercado
 * y devuelve { vote: 'BUY'|'SKIP', confidence: 0-1 }
 */
class EnsembleVoter {
  constructor() {
    // Pesos iniciales igualitarios, actualizados por rendimiento
    this.strategies = [
      { name: 'ema_rsi_bull',    weight: 1.0, wins: 0, losses: 0, fn: stratEmaRsiBull },
      { name: 'mean_reversion',  weight: 1.0, wins: 0, losses: 0, fn: stratMeanReversion },
      { name: 'momentum',        weight: 1.0, wins: 0, losses: 0, fn: stratMomentum },
      { name: 'bear_rebound',    weight: 1.0, wins: 0, losses: 0, fn: stratBearRebound },
      { name: 'volume_spike',    weight: 1.0, wins: 0, losses: 0, fn: stratVolumeSpike },
    ];
    this.MIN_WEIGHT = 0.2;
    this.MAX_WEIGHT = 3.0;
  }

  /**
   * Vota y devuelve decisión final ponderada.
   * Requiere quórum mínimo para BUY.
   */
  vote(context) {
    const votes = [];
    for (const s of this.strategies) {
      try {
        const v = s.fn(context);
        if (v) votes.push({ name: s.name, ...v, weight: s.weight });
      } catch (e) { /* silent */ }
    }

    const buyWeight = votes.filter(v => v.vote === 'BUY').reduce((s, v) => s + v.weight * v.confidence, 0);
    const skipWeight = votes.filter(v => v.vote === 'SKIP').reduce((s, v) => s + v.weight * v.confidence, 0);
    const totalWeight = buyWeight + skipWeight || 1;
    const buyRatio = buyWeight / totalWeight;

    // Require 55% weighted consensus for BUY
    const decision = buyRatio >= 0.55 ? 'BUY' : 'SKIP';
    const confidence = decision === 'BUY' ? buyRatio : 1 - buyRatio;

    return {
      decision,
      confidence,
      buyRatio,
      votes: votes.map(v => ({ name: v.name, vote: v.vote, confidence: v.confidence, weight: v.weight })),
    };
  }

  /** Update weights based on which strategies voted correctly */
  updateWeights(strategyVotes, tradeWon) {
    for (const sv of strategyVotes) {
      const s = this.strategies.find(x => x.name === sv.name);
      if (!s) continue;
      const correct = (sv.vote === 'BUY' && tradeWon) || (sv.vote === 'SKIP' && !tradeWon);
      if (correct) {
        s.wins++;
        s.weight = Math.min(this.MAX_WEIGHT, s.weight * 1.05);
      } else {
        s.losses++;
        s.weight = Math.max(this.MIN_WEIGHT, s.weight * 0.95);
      }
    }
  }

  getWeights() {
    return this.strategies.map(s => ({
      name: s.name,
      weight: s.weight,
      winRate: s.wins + s.losses > 0 ? s.wins / (s.wins + s.losses) : null,
    }));
  }

  toJSON() {
    return { strategies: this.strategies.map(({ fn, ...rest }) => rest) };
  }
  loadJSON(data) {
    if (!data?.strategies) return;
    for (const saved of data.strategies) {
      const s = this.strategies.find(x => x.name === saved.name);
      if (s) Object.assign(s, { weight: saved.weight, wins: saved.wins, losses: saved.losses });
    }
  }
}

// ── Individual strategy functions ─────────────────────────────────────────────
function stratEmaRsiBull({ rsi, regime, price, ema20, ema50, trend }) {
  if (regime === 'BEAR') return { vote: 'SKIP', confidence: 0.65 };
  // BULL: strong buy signal
  if (regime === 'BULL' && rsi < 45 && price > ema20 && ema20 > ema50)
    return { vote: 'BUY', confidence: 0.75 + (45 - rsi) / 100 };
  // LATERAL: EMA aligned + RSI oversold
  if (regime === 'LATERAL' && rsi < 38 && price > ema50)
    return { vote: 'BUY', confidence: 0.60 };
  return { vote: 'SKIP', confidence: 0.5 };
}

function stratMeanReversion({ rsi, bbZone, regime, price, bb }) {
  if (regime === 'BEAR') return { vote: 'SKIP', confidence: 0.7 };
  if (bbZone === 'below_lower' && rsi < 35) return { vote: 'BUY', confidence: 0.75 };
  if (bbZone === 'above_upper') return { vote: 'SKIP', confidence: 0.65 };
  return { vote: 'SKIP', confidence: 0.45 };
}

function stratMomentum({ rsi, trend, volumeRatio, regime }) {
  if (regime === 'BEAR') return { vote: 'SKIP', confidence: 0.65 };
  if (trend === 'up' && rsi > 40 && rsi < 65 && volumeRatio >= 0.8)
    return { vote: 'BUY', confidence: 0.55 + Math.min(0.2, (volumeRatio-0.8)*0.25) };
  if (trend === 'down' && rsi > 60) return { vote: 'SKIP', confidence: 0.65 };
  return { vote: 'SKIP', confidence: 0.45 };
}

function stratBearRebound({ rsi, regime, bbZone }) {
  if (regime !== 'BEAR') return { vote: 'SKIP', confidence: 0.55 };
  if (rsi < 20 && bbZone === 'below_lower') return { vote: 'BUY', confidence: 0.7 };
  return { vote: 'SKIP', confidence: 0.6 };
}

function stratVolumeSpike({ volumeRatio, rsi, bbZone }) {
  if (volumeRatio > 1.5 && rsi < 45 && bbZone !== 'above_upper')
    return { vote: 'BUY', confidence: 0.5 + Math.min(0.25, (volumeRatio-1.5)*0.2) };
  if (volumeRatio > 1.2 && rsi < 38 && (bbZone === 'below_lower' || bbZone === 'lower_half'))
    return { vote: 'BUY', confidence: 0.55 };
  return { vote: 'SKIP', confidence: 0.45 };
}

module.exports = { QLearning, EnsembleVoter };
