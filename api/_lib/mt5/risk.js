/**
 * EVIE MT5 — the risk governor.
 *
 * The split of labour: here we decide risk as a PERCENTAGE of balance — which
 * trades, how much of the account each one is allowed, and what the whole book
 * may carry at once. The Expert Advisor turns those percentages into exact lot
 * sizes using the contract specification its own terminal holds. Tick value and
 * volume step are not in Deriv's public feed and the terminal has them exactly,
 * so this file stays deliberately ignorant of them.
 */

/**
 * Pick the trades to actually take. Candidates arrive ranked by confidence; the
 * strongest in each correlation group is kept and the rest of that group is
 * dropped, then the list is cut off once the summed risk would exceed what the
 * profile allows to be open at once.
 *
 * This is the piece that stops "long EUR/USD, long GBP/USD, long AUD/USD" being
 * booked as three positions when it is one bet on the dollar falling.
 */
function selectByRisk(candidates, profile) {
  const ranked = candidates.slice().sort((a, b) => b.sig.confidence - a.sig.confidence);
  const clusterExposure = new Map();
  let openRisk = 0;
  const chosen = [];

  for (const { sig, market } of ranked) {
    if (openRisk + sig.riskPct > profile.maxOpenRiskPct + 1e-9) continue;
    const used = clusterExposure.get(market.corr) || 0;
    if (used + sig.riskPct > profile.corrClusterCap + 1e-9) continue;
    chosen.push(sig);
    clusterExposure.set(market.corr, used + sig.riskPct);
    openRisk += sig.riskPct;
  }
  return chosen;
}

module.exports = { selectByRisk };
