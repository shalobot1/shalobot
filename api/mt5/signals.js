const { runEngine } = require("../_lib/mt5/engine");
const { PROFILES, PROFILE_LIST } = require("../_lib/mt5/profiles");

/**
 * GET /api/mt5/signals
 *
 *   ?profile=conservative|moderate|aggressive
 *   &categories=forex,volatility
 *   &format=csv        — the Expert Advisor's feed
 *
 * One source of truth for both readers. The page fetches JSON and draws it; the
 * Expert Advisor fetches the same thing as CSV, because MQL5 has no JSON parser
 * and hand-rolling one inside a trading bot is a bad place to find a bug.
 *
 * The short cache is what makes many terminals polling every thirty seconds
 * cost the same as one. It is deliberately shorter than a five-minute bar, so
 * nothing is ever served from a bar that has since closed.
 *
 * A failed refresh falls back to the last good answer rather than erroring.
 * A bot holding a position needs the caps in this feed to keep managing it, and
 * a momentary hiccup at the feed is no reason to take those away.
 */

const VALID_PROFILES = ["conservative", "moderate", "aggressive"];
const VALID_CATEGORIES = ["forex", "metals", "crypto"];
const CACHE_MS = 25000;

const cache = new Map();

module.exports = async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const sp = url.searchParams;

  const profile = VALID_PROFILES.indexOf(sp.get("profile")) > -1 ? sp.get("profile") : "aggressive";
  let categories = (sp.get("categories") || sp.get("category") || "forex,metals,crypto")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => VALID_CATEGORIES.indexOf(c) > -1);
  if (!categories.length) categories = ["forex"];

  const key = profile + ":" + categories.slice().sort().join("+");
  const hit = cache.get(key);
  const fresh = hit && Date.now() - hit.at < CACHE_MS;

  let data;
  if (fresh) {
    data = hit.data;
  } else {
    try {
      data = await runEngine(profile, categories);
      cache.set(key, { at: Date.now(), data });
    } catch (e) {
      console.error("[shalo mt5] engine failed:", e);
      if (!hit) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.statusCode = 502;
        return res.end(JSON.stringify({ error: "Could not reach the market feed. Try again in a moment." }));
      }
      data = hit.data;
    }
  }

  // Never let a CDN hold this: a signal is only worth acting on while the bar
  // it was computed from is still the current one.
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (sp.get("format") === "csv") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end(toCsv(data));
  }

  // The three profiles ride along so the page describes what the engine will
  // actually do rather than a copy of it that could drift.
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.end(JSON.stringify(Object.assign({}, data, {
    cached: !!fresh,
    profiles: PROFILE_LIST.map((p) => ({
      key: p.key, label: p.label, blurb: p.blurb, riskPerTradePct: p.riskPerTradePct,
    })),
  })));
};

/**
 * The Expert Advisor's feed: one line per signal, plus three comment lines.
 *
 *   SYMBOL,SIDE,ENTRY,SL,TP,RISKPCT,CONF,DIGITS,TRAILATR,PARTIALS,ADDS,CLUSTER
 *
 * PARTIALS is "price:closePct;…" and ADDS is "price:sizePct;…", each "-" when
 * empty. The `# caps:` line carries the profile's aggregate limits, so the
 * account-wide ceilings live in one place rather than being retyped into every
 * terminal. `ts=` lets the bot recognise a stale feed and manage what is open
 * without opening anything new.
 */
function toCsv(d) {
  const p = PROFILES[d.profile] || PROFILES.moderate;
  const head =
    "# shalo mt5 | profile=" + d.profile + " | ts=" + d.generatedAt +
      " | signals=" + d.signals.length + " | cats=" + d.categories.join("+") + "\n" +
    "# caps: maxOpenRisk=" + p.maxOpenRiskPct + " corrCap=" + p.corrClusterCap +
      " dailyLoss=" + p.maxDailyLossPct + "\n" +
    "# cols: SYMBOL,SIDE,ENTRY,SL,TP,RISKPCT,CONF,DIGITS,TRAILATR,PARTIALS(p:c;..),ADDS(p:s;..),CLUSTER";

  const rows = d.signals.map((s) => [
    s.symbol, s.side, s.entry, s.stopLoss, s.takeProfit, s.riskPct, s.confidence, s.digits,
    s.trailAtr,
    s.partials.map((pp) => pp.price + ":" + pp.closePct).join(";") || "-",
    s.adds.map((a) => a.price + ":" + a.sizePct).join(";") || "-",
    s.corr || "-",
  ].join(","));

  return [head].concat(rows).join("\n") + "\n";
}
