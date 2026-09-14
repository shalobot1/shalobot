/**
 * EVIE MT5 — the strategy. One classifier in front of two engines.
 *
 * Every symbol, every bar, is put into a regime by the EMA stack, ADX and
 * Choppiness together. A clean trend goes to the TREND engine (breakout, ATR
 * trail, adds on strength); a genuine range goes to the RANGE engine (fade the
 * extreme back to the mean, hard stop). Everything in between is "manage what
 * is open, start nothing new" — that single refusal is what removes most of the
 * losses, because the in-between state is where a market takes money off
 * anybody with an opinion.
 *
 * The output is either a signal the Expert Advisor can execute verbatim, or a
 * reason for standing aside — which is worth as much on the page, because
 * "nothing is happening" and "the bot is broken" look identical without it.
 */

const {
  adx, atr, bollinger, choppiness, closes, donchian, ema, keltner, rsi, zScore,
} = require("./indicators");

const CHOP_TREND = 38.2; // below this, the market is going somewhere
const CHOP_RANGE = 61.8; // above this, it is going nowhere
const MIN_BARS = 120;    // fewer than this and the indicators are still settling

const round = (v, digits) => Number(v.toFixed(digits));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const noSignal = (m, regime, reason, now) => ({
  symbol: m.mt5, ws: m.ws, name: m.name, category: m.category, regime, reason, generatedAt: now,
});

/** Which of the three states the market is in right now. */
function classify(c, adxGate) {
  const v = closes(c);
  const e8 = ema(v, 8), e21 = ema(v, 21), e55 = ema(v, 55);
  const adxVal = adx(c, 14);
  const chop = choppiness(c, 14);
  const up = e8 > e21 && e21 > e55;
  const down = e8 < e21 && e21 < e55;
  const dir = up ? "buy" : down ? "sell" : null;

  if (adxVal >= adxGate && chop < CHOP_TREND && dir) {
    return { regime: dir === "buy" ? "trend_up" : "trend_down", adxVal, chop, dir };
  }
  if (adxVal < 20 && chop > CHOP_RANGE) return { regime: "range", adxVal, chop, dir: null };
  return { regime: "transitional", adxVal, chop, dir };
}

/** TREND — take the breakout in the direction the EMAs already agree on. */
function trendSignal(c, m, p, side, adxVal, now) {
  const price = c[c.length - 1].c;
  const a = atr(c, 14);
  if (!(a > 0)) return null;
  const dc = donchian(c, 20);
  const micro = donchian(c, 10);
  const kel = keltner(c, 20, 2);

  // Two ways in: a fresh break of the 20-bar channel, or a pullback to the
  // middle that then re-breaks the 10-bar channel — the continuation entry.
  const brokeOut = side === "buy" ? price >= dc.hi : price <= dc.lo;
  const pulledBack = side === "buy" ? price <= kel.mid * 1.001 : price >= kel.mid * 0.999;
  const microBreak = side === "buy" ? price >= micro.hi : price <= micro.lo;
  if (!(brokeOut || (pulledBack && microBreak))) return null;

  const stopDist = p.atrTrailMult * a;
  const stopLoss = side === "buy" ? price - stopDist : price + stopDist;
  const takeProfit = side === "buy" ? price + p.minRR * stopDist : price - p.minRR * stopDist;

  // Adds sit on pullbacks toward the EMA21, each one smaller than the last.
  const adds = [];
  const e21 = ema(closes(c), 21);
  for (let i = 1; i <= p.maxPyramidAdds; i++) {
    const back = side === "buy" ? e21 - i * 0.15 * a : e21 + i * 0.15 * a;
    // Never place an add past the stop: it could only ever fill after the
    // position it was adding to had already been closed out.
    if (side === "buy" ? back <= stopLoss : back >= stopLoss) break;
    adds.push({ price: round(back, m.digits), sizePct: round(p.riskPerTradePct / (i + 1), 2) });
  }

  // Partials measured in R, where 1R is the stop distance. Whatever is left
  // rides the trail.
  const partials = p.partials.map((pp) => ({
    price: round(side === "buy" ? price + pp.atR * stopDist : price - pp.atR * stopDist, m.digits),
    closePct: pp.closePct,
  }));

  const strength = clamp((adxVal - p.adxGate) / 25, 0, 1); // how far past the gate
  const confidence = Math.round(clamp(58 + strength * 34, 0, 95));

  return {
    symbol: m.mt5, ws: m.ws, name: m.name, category: m.category, corr: m.corr, side,
    regime: side === "buy" ? "trend_up" : "trend_down",
    confidence, entry: round(price, m.digits),
    stopLoss: round(stopLoss, m.digits), takeProfit: round(takeProfit, m.digits),
    riskPct: p.riskPerTradePct, trailAtr: round(stopDist, m.digits),
    adds, partials,
    reason: "Trend " + (side === "buy" ? "up" : "down") + " · ADX " + adxVal.toFixed(0) +
      " · " + (brokeOut ? "channel breakout" : "pullback continuation"),
    digits: m.digits, generatedAt: now, ttlSec: 180,
  };
}

/** RANGE — fade a stretched close back to the mean. Never on Crash/Boom. */
function rangeSignal(c, m, p, now) {
  if (m.trendOnly) return null;
  const price = c[c.length - 1].c;
  const a = atr(c, 14);
  const z = zScore(c, 20);
  const bb = bollinger(c, 20, 2);
  const r = rsi(c, 14);
  const loBand = m.category === "volatility" ? 20 : 30;
  const hiBand = m.category === "volatility" ? 80 : 70;

  let side = null;
  if (z <= -2 && r <= loBand) side = "buy";
  else if (z >= 2 && r >= hiBand) side = "sell";
  if (!side) return null;
  if (Math.abs(z) >= 3) return null; // too stretched to stand in front of

  const sd = Math.abs(price - bb.mid) / Math.max(Math.abs(z), 1e-9); // roughly one sigma
  // The stop sits out at the z=±3 level, but floored by a slice of ATR so it
  // cannot collapse to noise width as the z-score approaches 3.
  const stopDist = Math.max(0.6 * a, (3 - Math.abs(z)) * sd);
  const stopLoss = side === "buy" ? price - stopDist : price + stopDist;
  const takeProfit = bb.mid;
  if (Math.abs(takeProfit - price) / Math.max(stopDist, 1e-9) < 1.0) return null;

  const partials = [{ price: round((price + bb.mid) / 2, m.digits), closePct: 50 }];
  const confidence = Math.round(clamp(52 + (Math.abs(z) - 2) * 20, 0, 88));

  return {
    symbol: m.mt5, ws: m.ws, name: m.name, category: m.category, corr: m.corr, side,
    regime: "range", confidence, entry: round(price, m.digits),
    stopLoss: round(stopLoss, m.digits), takeProfit: round(takeProfit, m.digits),
    riskPct: p.riskPerTradePct * 0.8, // a fade gets less than a trend
    trailAtr: round(p.atrTrailMult * a, m.digits),
    adds: [], partials,
    reason: "Range fade · z " + z.toFixed(1) + " · RSI " + r.toFixed(0),
    digits: m.digits, generatedAt: now, ttlSec: 180,
  };
}

/** Evaluate one symbol: a signal to act on, or the reason there is not one. */
function evaluate(candles, market, profile, now) {
  if (candles.length < MIN_BARS) return noSignal(market, "no_trade", "warming up (not enough history)", now);
  const { regime, adxVal, dir } = classify(candles, profile.adxGate);

  if (regime === "trend_up" || regime === "trend_down") {
    const side = regime === "trend_up" ? "buy" : "sell";
    return trendSignal(candles, market, profile, side, adxVal, now) ||
      noSignal(market, regime, "in trend, waiting for entry trigger", now);
  }
  if (regime === "range") {
    return rangeSignal(candles, market, profile, now) ||
      noSignal(market, regime, "ranging, price not at a band extreme", now);
  }
  // Transitional: only Aggressive touches it, at half size, and only with the
  // direction the EMAs are already pointing.
  if (regime === "transitional" && profile.tradeTransitional && dir && !market.trendOnly) {
    const s = trendSignal(candles, market, profile, dir, Math.max(adxVal, profile.adxGate), now);
    if (s) {
      s.riskPct = round(s.riskPct * 0.5, 2);
      s.confidence = Math.min(s.confidence, 62);
      s.reason = "Transitional " + (dir === "buy" ? "up" : "down") + " (reduced size) · " + s.reason;
      return s;
    }
  }
  return noSignal(market, regime,
    regime === "transitional" ? "regime unclear — standing aside" : "no tradable regime", now);
}

/** A signal carries a side; a stand-aside does not. */
const isSignal = (o) => o && o.side !== undefined;

module.exports = { evaluate, isSignal, MIN_BARS };
