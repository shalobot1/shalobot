/**
 * EVIE MT5 — the orchestrator, and the only entry point the route calls.
 *
 * Pull the candles, run the strategy on every market, then put the whole
 * basket through the risk governor in ONE pass. The governor has to see
 * everything at once: correlation and the open-risk budget are properties of
 * the book, not of forex separately from synthetics.
 *
 * Signals fire on CLOSED bars. The bar still forming has a close that is just
 * the current price, so a breakout "confirmed" on it un-confirms itself
 * seconds later — the classic way a backtest looks brilliant and the live
 * account does not.
 *
 * Alongside the signals it returns everything that did NOT fire, with the
 * reason. A quiet page with no explanation is indistinguishable from a broken
 * one.
 */

const { fetchCandlesBatch } = require("./feed");
const { evaluate, isSignal } = require("./strategy");
const { selectByRisk } = require("./risk");
const { marketsByCategory, LIVE_CATEGORIES } = require("./markets");
const { PROFILES } = require("./profiles");

/** Seconds per bar. M5 on everything we trade today. */
const GRANULARITY = { forex: 300, metals: 300, crypto: 300 };
const DEFAULT_GRAN = 300;
const BARS = 250;

/** Drop the bar that is still forming. */
function closedOnly(candles, granularitySec, now) {
  if (!candles || !candles.length) return [];
  const last = candles[candles.length - 1];
  return last.t > now - granularitySec ? candles.slice(0, -1) : candles;
}

async function runEngine(profileKey, categoriesIn) {
  const profile = PROFILES[profileKey] || PROFILES.moderate;
  const wanted = (Array.isArray(categoriesIn) ? categoriesIn : [categoriesIn || "forex"]).filter(Boolean);
  const categories = wanted.filter((c) => LIVE_CATEGORIES.indexOf(c) > -1);
  if (!categories.length) categories.push("forex");
  const now = Math.floor(Date.now() / 1000);

  // Everything on the same bar length shares a socket. Today that is one
  // socket for the lot; the grouping is here so a category on a different
  // timeframe would not silently get the wrong candles.
  const byGran = new Map();
  for (const category of categories) {
    const gran = GRANULARITY[category] || DEFAULT_GRAN;
    const markets = marketsByCategory(category);
    if (!markets.length) continue;
    byGran.set(gran, (byGran.get(gran) || []).concat(markets));
  }

  const outputs = [];
  const candidates = [];
  let evaluated = 0, withData = 0;

  for (const [gran, markets] of byGran) {
    const candlesBySym = await fetchCandlesBatch(markets.map((m) => m.ws), gran, BARS);
    for (const m of markets) {
      evaluated++;
      const candles = closedOnly(candlesBySym.get(m.ws), gran, now);
      if (candles.length) withData++;
      const out = evaluate(candles, m, profile, now);
      outputs.push({ out, market: m });
      if (isSignal(out)) candidates.push({ sig: out, market: m });
    }
  }

  const signals = selectByRisk(candidates, profile);
  const chosen = new Set(signals.map((s) => s.symbol));

  const standAside = outputs
    .filter((o) => !isSignal(o.out) || !chosen.has(o.out.symbol))
    .map((o) => ({
      symbol: o.market.mt5,
      name: o.market.name,
      regime: o.out.regime,
      reason: isSignal(o.out)
        ? "held back by the risk cap (correlation / open-risk budget)"
        : o.out.reason,
    }));

  return {
    profile: profileKey,
    categories,
    generatedAt: now,
    granularitySec: GRANULARITY[categories[0]] || DEFAULT_GRAN,
    signals,
    standAside,
    meta: { evaluated, withData },
  };
}

module.exports = { runEngine };
