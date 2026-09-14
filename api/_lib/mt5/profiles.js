/**
 * EVIE MT5 — the three risk profiles.
 *
 * One engine, three parameter sets. Conservative takes fewer trades and never
 * adds to a position; Aggressive presses winners and trades the in-between
 * regime at half size. Every figure is a percentage of the account's CURRENT
 * balance, which is why the same profile behaves sensibly on $50 and on
 * $50,000 without anybody changing a setting.
 */

const PROFILES = {
  conservative: {
    key: "conservative",
    label: "Conservative",
    blurb: "Fewer, high-conviction trades. No adding to positions. Tight risk, wide stops.",
    riskPerTradePct: 0.4,   // risked on the opening entry
    maxOpenRiskPct: 1,      // everything open at once, added up
    maxDailyLossPct: 2,     // once breached, no new entries today
    adxGate: 30,            // how strong a trend has to be to count as one
    tradeTransitional: false,
    maxPyramidAdds: 0,
    rangeAdds: 0,
    atrTrailMult: 3.0,      // trailing distance, in ATRs
    minRR: 2.0,
    corrClusterCap: 1,      // per correlation group
    partials: [{ atR: 1, closePct: 50 }],
  },
  moderate: {
    key: "moderate",
    label: "Moderate",
    blurb: "Balanced. Trades the clean trends and ranges, scales in up to twice on strength.",
    riskPerTradePct: 0.75,
    maxOpenRiskPct: 2.5,
    maxDailyLossPct: 3,
    adxGate: 25,
    tradeTransitional: false,
    maxPyramidAdds: 2,
    rangeAdds: 0,
    atrTrailMult: 2.5,
    minRR: 1.75,
    corrClusterCap: 1.5,
    partials: [{ atR: 1, closePct: 33 }, { atR: 2, closePct: 33 }],
  },
  aggressive: {
    key: "aggressive",
    label: "Aggressive",
    blurb: "Presses winners hard — pyramids into strong trends, trades more setups, bigger runners.",
    riskPerTradePct: 1.5,
    maxOpenRiskPct: 5,
    maxDailyLossPct: 5,
    adxGate: 21,
    tradeTransitional: true,
    maxPyramidAdds: 4,
    rangeAdds: 1,
    atrTrailMult: 2.0,
    minRR: 1.2,
    corrClusterCap: 2,
    partials: [{ atR: 1.5, closePct: 25 }], // bank a quarter, let the rest run
  },
};

const PROFILE_LIST = [PROFILES.conservative, PROFILES.moderate, PROFILES.aggressive];

module.exports = { PROFILES, PROFILE_LIST };
