// intradayTrend.js — Detección de tendencia intradiaria (media 2h)
// Mantiene buffer de precios de las últimas 2h para calcular tendencia micro

class IntradayTrend {
  constructor(windowMs = 2 * 60 * 60 * 1000) {
    this.windowMs = windowMs; // 2 horas en ms
    // { [symbol]: [{ price, time }] }
    this.priceBuffers = {};
    this.trends = {};
  }

  addPrice(symbol, price, time = Date.now()) {
    if (!this.priceBuffers[symbol]) this.priceBuffers[symbol] = [];
    this.priceBuffers[symbol].push({ price, time });
    // Purge old entries
    const cutoff = time - this.windowMs;
    this.priceBuffers[symbol] = this.priceBuffers[symbol].filter(p => p.time >= cutoff);
    // Recalculate trend
    this.trends[symbol] = this._calcTrend(this.priceBuffers[symbol]);
  }

  _calcTrend(buffer) {
    if (buffer.length < 5) return { direction: 'neutral', slope: 0, confidence: 0, sma2h: null };

    // Simple linear regression slope
    const n = buffer.length;
    const xs = buffer.map((_, i) => i);
    const ys = buffer.map(p => p.price);
    const xMean = (n - 1) / 2;
    const yMean = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - xMean) * (ys[i] - yMean);
      den += (xs[i] - xMean) ** 2;
    }
    const slope = den ? num / den : 0;

    // Normalize slope as % per point
    const slopePct = yMean > 0 ? slope / yMean : 0;

    // SMA over window
    const sma2h = yMean;

    // Current price vs SMA
    const lastPrice = ys[ys.length - 1];
    const pctAboveSMA = (lastPrice - sma2h) / sma2h;

    // Confidence: based on how many points
    const confidence = Math.min(1, n / 60); // full confidence at 60+ points

    let direction;
    if (slopePct > 0.0005) direction = 'up';
    else if (slopePct < -0.0005) direction = 'down';
    else direction = 'neutral';

    // Extra: detect consolidation vs breakout
    const prices = buffer.map(p => p.price);
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const range = (high - low) / yMean;
    const isConsolidating = range < 0.01; // < 1% range
    const isBreakingUp = lastPrice > high * 0.998 && direction === 'up';
    const isBreakingDown = lastPrice < low * 1.002 && direction === 'down';

    return {
      direction,
      slope: slopePct,
      confidence,
      sma2h,
      pctAboveSMA,
      range,
      isConsolidating,
      isBreakingUp,
      isBreakingDown,
      pointCount: n,
    };
  }

  getTrend(symbol) {
    return this.trends[symbol] || { direction: 'neutral', slope: 0, confidence: 0 };
  }

  // Is the intraday trend aligned with the trade direction (BUY)?
  isAlignedForBuy(symbol) {
    const t = this.getTrend(symbol);
    return t.direction === 'up' || t.direction === 'neutral';
  }

  // Is there a bearish intraday trend? (warning to avoid BUY)
  isBearishIntraday(symbol) {
    const t = this.getTrend(symbol);
    return t.direction === 'down' && t.confidence > 0.4;
  }

  getAllTrends() {
    return Object.fromEntries(
      Object.entries(this.trends).map(([sym, t]) => [sym, { ...t, symbol: sym }])
    );
  }

  toJSON() {
    // Don't persist full buffers — too large. Save last trend per symbol.
    return { trends: this.trends };
  }
}

module.exports = { IntradayTrend };
