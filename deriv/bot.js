/**
 * SHALOBOT — the Smart Scan bot for Deriv's digit contracts. A full automation:
 *
 *   Pick a trade type (Even/Odd, Over/Under, Matches/Differs), then Scan &
 *   start → a popup scans every market live (progress bar), settles on the ONE
 *   best market and side (animated tick), and the bot starts on it by
 *   itself. The bot then trades one 1-tick contract at a time — re-scanning before
 *   every trade — until take profit, stop loss, Stop, or a balance that cannot
 *   cover the next stake. Take profit ends in a congratulations popup.
 *
 * THE TYPES. Each is a set of sides the scan chooses between, all with the
 * same chance of winning, so the scan decides WHERE and WHICH, never how much
 * risk — that is the user's choice:
 *   Even/Odd         Even or Odd (50%).
 *   Rise/Fall        Rise or Fall over one tick (50%). The top payout tier is
 *                    the Step indices (1.845, prices move in fixed steps so a
 *                    tick never ties); Volatility indices pay 1.783.
 *   Over/Under       the user picks a prediction pair, Over N / Under 9−N —
 *                    mirror contracts with the same chance and the same payout
 *                    (measured on all 20 markets) — and the scan picks the side.
 *   Matches/Differs  the user picks Differs (90%) or Matches (10%), and the
 *                    scan picks the digit.
 *
 * THE SCAN, on the account's own socket (no extra connection; Deriv allows
 * five per person): which markets sell digit contracts or 1-tick Rise/Fall
 * now; what a win pays on each side through this app (markup included, read at
 * a stake of 10 so cent rounding does not hide the gaps between markets); and a
 * tick stream per market keeping its last LONG last digits — each written with
 * the decimals Deriv gives, so a trailing zero is a real 0 — and its last LONG
 * tick-to-tick moves.
 *
 * THE PICK: among the sides that pay the most (for Rise/Fall: payout times the
 * share of ticks that move at all, since an equal tick loses), the one whose last WINDOW ticks
 * would have won closest to 100% of the time; a tie goes to the last LONG
 * ticks, then to the faster market. This is the owner's rule. Backtested on
 * 400,000 real ticks the digits are random, so it is shown as a recent
 * pattern, never as odds.
 *
 * THE RUN. Martingale: after a loss the stake is multiplied, after a win it
 * returns to the starting stake. Each type and prediction remembers its own
 * multiplier; the defaults are the smallest that win back every loss plus one
 * normal win (Even/Odd keeps the owner's 3.1). Stop loss stops the run once
 * the loss has reached it — the next stake is NOT held back for fear of
 * passing it, because the recovery trade may be the one that wins (so the
 * final loss can exceed the stop loss by up to the last stake). Each new run
 * starts from nothing.
 *
 * EVERY TRADE IS LOGGED. Each buy is one `buy` with its parameters and
 * subscribe, settled from the contract stream; a line that drops with a trade
 * in flight is reconciled from the profit table and the portfolio before the
 * bot moves on, never bought twice. When a run ends, Deriv's own profit table
 * is read back and any contract of the run that the page did not see settle is
 * added, so the last trade before a stop is always in the list.
 */

(function (global) {
  "use strict";

  var D = global.ShaloDeriv;
  if (!D) return;

  var $ = function (id) { return document.getElementById(id); };
  var T = function (s) { return typeof global.t === "function" ? global.t(s) : s; };
  var fill = function (s, v) { return String(s).replace(/\{(\w+)\}/g, function (_, k) { return v[k] != null ? v[k] : ""; }); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var round2 = function (v) { return Math.round(v * 100) / 100; };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };

  var WINDOW = 10;          // the pattern the user sees: the last 10 ticks
  var LONG = 100;           // the tie-break: the last 100
  var TIER = 0.0025;        // "pays the most": within 0.25% of the best payout
  var MULT_MAX = 50;
  var PRICE_REF = 10;       // payouts are read at 10 or more: at 0.35 the cent rounding hides the gaps between markets
  var DEFAULTS = { stake: 1, tp: 1000, sl: 1000 };
  var STATE_KEY = "shalo_bot_v2";
  var OLD_KEY = "shalo_bot_settings";   // Even/Odd only, before the types
  var FALLBACK_MIN = 0.35;
  var LOG_ROWS = 2000;
  var ENABLED = ["evenodd", "risefall", "overunder", "matchdiff"];

  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  function money(v, cur) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
    } catch (e) { return Number(v).toFixed(2) + " " + (cur || ""); }
  }
  function signed(v, cur) { return (v > 0 ? "+" : v < 0 ? "−" : "") + money(Math.abs(v), cur); }

  /* ── the trade types ───────────────────────────────────────────────── */

  /* The smallest multiplier that wins back every loss plus one normal win:
     payout / (payout − 1), at the top payout through this app at stake 1,
     rounded up (measured 2026-10-04). */
  var OU_MULT = { 0: 17.7, 1: 6.3, 2: 3.9, 3: 2.8, 4: 2.2, 5: 1.8, 6: 1.6, 7: 1.4, 8: 1.2 };

  /** One contract the bot can buy. `wins(x)`: does x win it, where x is a
   *  last digit (series "digits") or a tick-to-tick move, +1 / -1 / 0
   *  (series "moves"). `priceBarrier`: the barrier its price is read at. */
  function side(key, ct, barrier, tone, wins, label, opts) {
    opts = opts || {};
    var pb = opts.priceBarrier != null ? opts.priceBarrier : barrier;
    return { key: key, ct: ct, barrier: barrier, tone: tone, wins: wins, label: label, series: opts.series || "digits",
      price: { ct: ct, barrier: pb }, priceKey: ct + (pb != null ? ":" + pb : "") };
  }

  var TYPES = {
    evenodd: {
      title: "Scanning Even/Odd markets",
      lede: "Finds the best Even/Odd market and side, then trades it one 1-tick contract at a time until your take profit or stop loss.",
      variants: null, defVariant: "x",
      defMult: function () { return 3.1; },
      contracts: function () { return ["DIGITEVEN", "DIGITODD"]; },
      sides: function () {
        return [
          side("even", "DIGITEVEN", null, "a", function (d) { return d % 2 === 0; }, function () { return T("Even"); }),
          side("odd", "DIGITODD", null, "b", function (d) { return d % 2 === 1; }, function () { return T("Odd"); }),
        ];
      },
      pricing: function () { return T("Pricing Even and Odd on {n} markets…"); },
      dot: function (d) { return d % 2 === 0 ? "e" : "o"; },
    },
    risefall: {
      title: "Scanning Rise/Fall markets",
      lede: "Finds the best market and direction, Rise or Fall, then trades it one 1-tick contract at a time until your take profit or stop loss.",
      variants: null, defVariant: "x",
      // Step indices pay 1.845 and never tie: 1.845 / 0.845, rounded up.
      defMult: function () { return 2.2; },
      contracts: function () { return ["CALL", "PUT"]; },
      sides: function () {
        return [
          side("rise", "CALL", null, "a", function (x) { return x > 0; }, function () { return T("Rise"); }, { series: "moves" }),
          side("fall", "PUT", null, "b", function (x) { return x < 0; }, function () { return T("Fall"); }, { series: "moves" }),
        ];
      },
      pricing: function () { return T("Pricing Rise and Fall on {n} markets…"); },
    },
    overunder: {
      title: "Scanning Over/Under markets",
      lede: "Finds the best market and side for your prediction, Over or Under, then trades it one 1-tick contract at a time until your take profit or stop loss.",
      variantLabel: "Prediction",
      variants: ["0", "1", "2", "3", "4", "5", "6", "7", "8"], defVariant: "2",
      variantText: function (v) { var n = Number(v); return fill(T("Over {a} / Under {b} · {p}%"), { a: n, b: 9 - n, p: (9 - n) * 10 }); },
      defMult: function (v) { return OU_MULT[v] || 2; },
      contracts: function () { return ["DIGITOVER", "DIGITUNDER"]; },
      sides: function (v) {
        var n = Number(v), u = 9 - n;
        return [
          side("over" + n, "DIGITOVER", n, "a", function (d) { return d > n; }, function () { return fill(T("Over {n}"), { n: n }); }),
          side("under" + u, "DIGITUNDER", u, "b", function (d) { return d < u; }, function () { return fill(T("Under {n}"), { n: u }); }),
        ];
      },
      pricing: function (v) { var n = Number(v); return fill(T("Pricing Over {a} and Under {b} on {n} markets…"), { a: n, b: 9 - n, n: "{n}" }); },
    },
    matchdiff: {
      title: "Scanning Matches/Differs markets",
      lede: "Finds the best market and digit for your contract, Differs or Matches, then trades it one 1-tick contract at a time until your take profit or stop loss.",
      variantLabel: "Contract",
      variants: ["diff", "match"], defVariant: "diff",
      variantText: function (v) { return v === "match" ? fill(T("Matches · {p}%"), { p: 10 }) : fill(T("Differs · {p}%"), { p: 90 }); },
      defMult: function (v) { return v === "match" ? 1.2 : 17.7; },
      contracts: function (v) { return v === "match" ? ["DIGITMATCH"] : ["DIGITDIFF"]; },
      // Every digit has the same chance, so one price per market serves all ten.
      sides: function (v) {
        var out = [];
        for (var k = 0; k <= 9; k++) (function (k) {
          out.push(v === "match"
            ? side("match" + k, "DIGITMATCH", k, "b", function (d) { return d === k; }, function () { return fill(T("Matches {n}"), { n: k }); }, { priceBarrier: 5 })
            : side("diff" + k, "DIGITDIFF", k, "a", function (d) { return d !== k; }, function () { return fill(T("Differs {n}"), { n: k }); }, { priceBarrier: 5 }));
        })(k);
        return out;
      },
      pricing: function (v) { return v === "match" ? T("Pricing Matches on {n} markets…") : T("Pricing Differs on {n} markets…"); },
    },
  };

  /** Everything a scan or a run needs to know about one type and variant. */
  function makeSpec(type, variant) {
    var t = TYPES[type];
    var v = t.variants ? (t.variants.indexOf(variant) >= 0 ? variant : t.defVariant) : t.defVariant;
    var sides = t.sides(v), prices = [], seen = {};
    sides.forEach(function (sd) { if (!seen[sd.priceKey]) { seen[sd.priceKey] = 1; prices.push(sd.price); } });
    return { type: type, variant: v, key: type + ":" + v, t: t, sides: sides, prices: prices, contracts: t.contracts(v) };
  }

  /** A contract of Deriv's, back as one of this spec's sides (for the log). */
  function sideOf(spec, ct, barrier) {
    var b = barrier == null || barrier === "" ? null : Number(barrier);
    return spec.sides.filter(function (sd) { return sd.ct === ct && (sd.barrier == null || sd.barrier === b); })[0] || null;
  }

  /** A contract's type, market and barrier, from its own fields, else its short code. */
  function kindOf(x) {
    if (x.contract_type) return String(x.contract_type);
    var m = /^(DIGIT[A-Z]+)_/.exec(String(x.shortcode || ""));
    return m ? m[1] : "";
  }
  function symOf(x) {
    if (x.underlying_symbol) return String(x.underlying_symbol);
    var sc = String(x.shortcode || "").replace(/^DIGIT[A-Z]+_/, "");
    var known = hub.order.filter(function (s) { return sc.indexOf(s + "_") === 0; }).sort(function (a, b) { return b.length - a.length; })[0];
    return known || sc.split("_")[0];
  }
  function barrierOf(x) {
    if (x.barrier != null && x.barrier !== "") return x.barrier;
    var m = /_\d+T_(\d)_\d+$/.exec(String(x.shortcode || ""));   // DIGITOVER_R_10_0.47_1791086752_1T_2_0
    return m ? m[1] : null;
  }

  /* ── the live scan ─────────────────────────────────────────────────── */

  var hub = {
    account: null, gen: 0, ready: false, starting: null,
    currency: "USD", minStake: FALLBACK_MIN,
    markets: {}, order: [], subs: [], pricedAt: 0, pricedStake: 0, pricedSpec: "",
  };

  function lastDigit(quote, dec) {
    var s = Number(quote).toFixed(isFinite(dec) && dec >= 0 ? dec : 2);
    return Number(s.charAt(s.length - 1));
  }

  function hubStop() {
    hub.gen++;
    hub.subs.forEach(function (s) { try { s.end(); } catch (e) {} });
    hub.subs = [];
    hub.ready = false;
    hub.starting = null;
    hub.account = null;
  }

  /** Start (or join the start of) the scan on one account. `prog(done,
   *  total, step)` hears each step. A newer start silences an older one. */
  function hubStart(accountId, stake, prog, spec) {
    prog = prog || function () {};
    if (hub.account === accountId && hub.ready) return Promise.resolve();
    if (hub.account === accountId && hub.starting) return hub.starting;
    hubStop();
    hub.account = accountId;
    var gen = hub.gen;
    hub.starting = (async function () {
      prog(0, 1, T("Connecting to the markets…"));
      for (var i = 0; ; i++) {
        try { await D.whenOpenOn(accountId, 6000); break; }
        catch (e) {
          if (gen !== hub.gen) return;
          if (i > 6) throw new Error(T("Not connected to Deriv yet. Try again in a moment."));
          await sleep(800);
        }
      }
      if (gen !== hub.gen) return;
      var acc = D.accountOf(accountId);
      hub.currency = (acc && acc.currency) || "USD";

      // The 20 digit markets (the same for every digit type, measured), and
      // the synthetic indices that sell Rise/Fall — in ticks, which adds the
      // 5 Step indices. Forex and the rest sell Rise/Fall only in minutes.
      var a = await D.askOn(accountId, { active_symbols: "brief", contract_type: ["DIGITEVEN"] });
      if (a.error) throw new Error(a.error.message);
      var rf = await D.askOn(accountId, { active_symbols: "brief", contract_type: ["CALL"] });
      var open = function (x) { return x.exchange_is_open && !x.is_trading_suspended; };
      var list = (a.active_symbols || []).filter(open), seenSym = {};
      list.forEach(function (x) { seenSym[x.underlying_symbol] = 1; });
      ((rf && rf.active_symbols) || []).forEach(function (x) {
        // (The basket indices are synthetic too, but sell Rise/Fall only in minutes.)
        if (open(x) && x.market === "synthetic_index" && !/basket/.test(x.submarket || "") && !seenSym[x.underlying_symbol]) { seenSym[x.underlying_symbol] = 1; list.push(x); }
      });
      if (!list.length) throw new Error(T("No Even/Odd market is open right now."));
      if (gen !== hub.gen) return;

      // Deriv's own refusal names the smallest stake for this currency.
      var probe = await D.askOn(accountId, { proposal: 1, amount: 0.01, basis: "stake", currency: hub.currency, underlying_symbol: list[0].underlying_symbol, contract_type: "DIGITEVEN", duration: 1, duration_unit: "t" });
      var arg = probe.error && probe.error.code_args && Number(probe.error.code_args[0]);
      hub.minStake = isFinite(arg) && arg > 0 ? arg : FALLBACK_MIN;

      hub.markets = {}; hub.order = [];
      list.forEach(function (x) {
        hub.order.push(x.underlying_symbol);
        hub.markets[x.underlying_symbol] = { sym: x.underlying_symbol, name: x.underlying_symbol_name, digits: [], moves: [], times: [], ratio: {}, at: 0, lastQuote: null, lastEpoch: 0 };
      });

      var total = hub.order.length * (1 + spec.prices.length), done = 0;
      prog(0, total, fill(T("Reading the last ticks of {n} markets…"), { n: hub.order.length }));
      await Promise.all(hub.order.map(async function (sym) {
        var h = await D.askOn(accountId, { ticks_history: sym, end: "latest", count: LONG + 1, style: "ticks" });
        var m = hub.markets[sym];
        if (!h.error && h.history && h.history.prices.length) {
          var dec = Number(h.pip_size), pr = h.history.prices.map(Number);
          m.dec = dec;
          m.digits = pr.map(function (q) { return lastDigit(q, dec); }).slice(-LONG);
          m.moves = pr.slice(1).map(function (q, i) { return Math.sign(q - pr[i]); }).slice(-LONG);
          m.times = h.history.times.slice(-50);
          m.lastQuote = pr[pr.length - 1];
          m.lastEpoch = h.history.times[h.history.times.length - 1];
          m.at = Date.now();
        }
        prog(++done, total);
      }));
      if (gen !== hub.gen) return;
      prog(done, total, fill(spec.t.pricing(spec.variant), { n: hub.order.length }));
      await price(accountId, stake, gen, function () { prog(++done, total); }, spec);
      if (gen !== hub.gen) return;

      hub.order.forEach(function (sym) {
        var s = D.streamOn(accountId, { ticks: sym, subscribe: 1 }, function (msg) {
          if (gen !== hub.gen) return;
          if (msg.closed) return hubRecover(accountId, gen);
          if (msg.error || !msg.tick) return;
          var m = hub.markets[sym];
          m.at = Date.now();
          // The subscription opens with the latest tick, which the history already has.
          if (msg.tick.epoch <= m.lastEpoch) return;
          var q = Number(msg.tick.quote);
          m.dec = Number(msg.tick.pip_size);
          m.digits.push(lastDigit(q, m.dec));
          if (m.digits.length > LONG) m.digits.splice(0, m.digits.length - LONG);
          if (m.lastQuote != null) {
            m.moves.push(Math.sign(Number(q.toFixed(m.dec)) - Number(m.lastQuote.toFixed(m.dec))));
            if (m.moves.length > LONG) m.moves.splice(0, m.moves.length - LONG);
          }
          m.lastQuote = q;
          m.lastEpoch = msg.tick.epoch;
          m.times.push(msg.tick.epoch);
          if (m.times.length > 50) m.times.splice(0, m.times.length - 50);
          m.at = Date.now();
          scheduleNow();
        });
        if (s) hub.subs.push(s);
      });
      hub.ready = true;
      hub.starting = null;
      paintMin();
    })().catch(function (e) {
      if (gen === hub.gen) { hub.starting = null; hub.account = null; }
      throw e;
    });
    return hub.starting;
  }

  /** The line dropped and took the streams with it: rebuild once it is back. */
  var recovering = false;
  function hubRecover(accountId, gen) {
    if (recovering || gen !== hub.gen) return;
    recovering = true;
    hubStop();
    setTimeout(function () {
      recovering = false;
      var live = run && run.active;
      var stake = live ? run.stake0 : (readSettings().stake || DEFAULTS.stake);
      var spec = live ? run.spec : formSpec();
      hubStart(accountId, stake, null, spec).catch(function () { setTimeout(function () { hubRecover(accountId, hub.gen); }, 3000); });
    }, 600);
  }

  /** What a win pays on each market and side through this account (app
   *  markup included), read at the stake or at PRICE_REF if that is more —
   *  at 0.35 every market rounds to the same cents, and a Martingale stake
   *  would then land on one that pays less. A refusal for rate keeps the
   *  last price; any other (a market that offers no return) clears it. */
  async function price(accountId, stake, gen, onEach, spec) {
    var amount = Math.max(round2(stake || DEFAULTS.stake), hub.minStake, PRICE_REF);
    var jobs = [];
    hub.order.forEach(function (sym) { spec.prices.forEach(function (p) { jobs.push([sym, p]); }); });
    await Promise.all(jobs.map(async function (j) {
      var req = { proposal: 1, amount: amount, basis: "stake", currency: hub.currency, underlying_symbol: j[0], contract_type: j[1].ct, duration: 1, duration_unit: "t" };
      if (j[1].barrier != null) req.barrier = String(j[1].barrier);
      var r = await D.askOn(accountId, req);
      if (gen !== hub.gen) return;
      var key = j[1].ct + (j[1].barrier != null ? ":" + j[1].barrier : "");
      var m = hub.markets[j[0]];
      if (!r.error) m.ratio[key] = Number(r.proposal.payout) / amount;
      else if (r.error.code !== "RateLimit") m.ratio[key] = null;
      if (onEach) onEach();
    }));
    hub.pricedAt = Date.now();
    hub.pricedStake = amount;
    hub.pricedSpec = spec.key;
  }

  function interval(m) {
    var t = m.times;
    return t.length > 2 ? (t[t.length - 1] - t[0]) / (t.length - 1) : 2;
  }
  function share(digits, wins) {
    if (!digits.length) return 0;
    var n = 0;
    for (var i = 0; i < digits.length; i++) if (wins(digits[i])) n++;
    return n / digits.length;
  }

  /** One market and side, read now. Null when its prices or ticks are stale. */
  function candidate(m, sd) {
    var ratio = m && m.ratio[sd.priceKey];
    if (!ratio || m.digits.length < WINDOW || Date.now() - m.at > 20000) return null;
    var series = m[sd.series] || [];
    if (series.length < WINDOW) return null;
    var last = series.slice(-WINDOW);
    // What a win is worth here: the payout, and for a move the share of ticks
    // that move at all — an equal tick loses both Rise and Fall, and Jump 100
    // ties about one tick in five (measured), so its higher payout is a trap.
    var value = sd.series === "moves" ? ratio * (1 - share(series, function (x) { return x === 0; })) : ratio;
    return { m: m, side: sd, ratio: ratio, value: value, share: share(last, sd.wins), long: share(series, sd.wins), speed: interval(m), digits: last };
  }
  function better(a, b) {
    if (Math.abs(a.share - b.share) > 1e-9) return a.share > b.share;
    if (Math.abs(a.long - b.long) > 1e-9) return a.long > b.long;
    return a.speed < b.speed - 0.25;
  }

  /** The one best trade right now for this type. */
  function choose(spec) {
    var all = [];
    hub.order.forEach(function (sym) {
      spec.sides.forEach(function (sd) { var c = candidate(hub.markets[sym], sd); if (c) all.push(c); });
    });
    if (!all.length) return null;
    var top = Math.max.apply(null, all.map(function (c) { return c.value; }));
    var best = null;
    all.forEach(function (c) { if (c.value >= top * (1 - TIER) && (!best || better(c, best))) best = c; });
    return best;
  }

  function dots(el, p, spec) {
    el.innerHTML = p.digits.map(function (d) {
      var cls = spec.t.dot ? spec.t.dot(d) : (p.side.wins(d) ? "w t-" + p.side.tone : "x");
      var glyph = p.side.series === "moves" ? (d > 0 ? "↑" : d < 0 ? "↓" : "=") : d;
      return '<i class="' + cls + '">' + glyph + "</i>";
    }).join("");
  }

  /* ── the live card, while a run is going ───────────────────────────── */

  var nowTimer = 0;
  function scheduleNow() {
    if (nowTimer || !((run && run.active) || (modal.view === "bmDone" && pending))) return;
    nowTimer = setTimeout(function () { nowTimer = 0; paintNow(); paintPick(); }, 500);
  }
  function paintNow() {
    var on = !!(run && run.active);
    $("botNow").hidden = !on;
    if (!on) return;
    var p = choose(run.spec);
    if (!p) return;
    $("nowMarket").textContent = p.m.name;
    $("nowSide").textContent = p.side.label();
    $("nowSide").className = "bot-now-side bot-now-side--" + p.side.tone;
    $("nowShare").textContent = Math.round(p.share * 100) + "%";
    dots($("nowDots"), p, run.spec);
  }

  /* ── settings: one set per type, one multiplier per prediction ─────── */

  var state = store.get(STATE_KEY);
  if (!state || !state.t) {
    var old = store.get(OLD_KEY) || {};
    state = { type: "evenodd", t: { evenodd: { stake: old.stake, tp: old.tp, sl: old.sl, variant: "x", mult: { x: old.mult } } } };
  }
  if (ENABLED.indexOf(state.type) < 0) state.type = "evenodd";
  function typeState(type) {
    var ts = state.t[type] || (state.t[type] = {});
    if (!ts.mult) ts.mult = {};
    if (!ts.variant) ts.variant = TYPES[type].defVariant;
    return ts;
  }
  var formVariant = null;   // the variant whose multiplier the field is showing

  function num(id) {
    var raw = String($(id).value || "").replace(",", ".").trim();
    var v = Number(raw);
    return raw && isFinite(v) ? v : NaN;
  }
  function readSettings() {
    var t = TYPES[state.type];
    return {
      type: state.type, variant: t.variants ? $("botVar").value : t.defVariant,
      stake: round2(num("botStake")), tp: round2(num("botTp")), sl: round2(num("botSl")), mult: Math.round(num("botMult") * 100) / 100,
    };
  }
  function formSpec() { var s = readSettings(); return makeSpec(s.type, s.variant); }

  /** The form's numbers into this type's memory (only the ones that are numbers). */
  function saveForm() {
    var s = readSettings(), ts = typeState(s.type);
    if (s.stake > 0) ts.stake = s.stake;
    if (s.tp > 0) ts.tp = s.tp;
    if (s.sl > 0) ts.sl = s.sl;
    if (s.mult >= 1) ts.mult[formVariant || s.variant] = s.mult;
    ts.variant = s.variant;
    store.set(STATE_KEY, state);
  }
  function multFor(type, variant) {
    var v = typeState(type).mult[variant];
    return v >= 1 ? v : TYPES[type].defMult(variant);
  }
  function loadForm() {
    var type = state.type, t = TYPES[type], ts = typeState(type);
    $("botStake").value = (ts.stake >= FALLBACK_MIN ? ts.stake : DEFAULTS.stake).toFixed(2);
    $("botTp").value = String(ts.tp > 0 ? ts.tp : DEFAULTS.tp);
    $("botSl").value = String(ts.sl > 0 ? ts.sl : DEFAULTS.sl);
    paintVariants();
    formVariant = t.variants ? $("botVar").value : t.defVariant;
    $("botMult").value = String(multFor(type, formVariant));
  }
  function paintVariants() {
    var t = TYPES[state.type], ts = typeState(state.type);
    $("botVarWrap").hidden = !t.variants;
    if (!t.variants) return;
    $("botVarLabel").textContent = T(t.variantLabel);
    var cur = $("botVar").value || ts.variant;
    if (t.variants.indexOf(cur) < 0) cur = ts.variant;
    if (t.variants.indexOf(cur) < 0) cur = t.defVariant;
    $("botVar").innerHTML = t.variants.map(function (v) { return '<option value="' + v + '">' + esc(t.variantText(v)) + "</option>"; }).join("");
    $("botVar").value = cur;
  }
  function paintType() {
    Array.prototype.forEach.call(document.querySelectorAll(".bot-type"), function (b) {
      var on = b.getAttribute("data-type") === state.type;
      b.hidden = ENABLED.indexOf(b.getAttribute("data-type")) < 0;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.tabIndex = on ? 0 : -1;
    });
    $("botLede").textContent = T(TYPES[state.type].lede);
  }
  function setType(type) {
    if (type === state.type || ENABLED.indexOf(type) < 0 || (run && run.active)) return;
    saveForm();
    state.type = type;
    $("botVar").value = "";
    loadForm();
    paintType();
    store.set(STATE_KEY, state);
    say("");
  }
  function onVariant() {
    var s = readSettings(), ts = typeState(s.type);
    var m = num("botMult");
    if (formVariant && m >= 1) ts.mult[formVariant] = Math.round(m * 100) / 100;
    formVariant = s.variant;
    ts.variant = s.variant;
    $("botMult").value = String(multFor(s.type, s.variant));
    store.set(STATE_KEY, state);
  }

  function validate(s) {
    if (!(s.stake > 0)) return T("Enter a stake.");
    if (s.stake < hub.minStake - 1e-9) return fill(T("The smallest stake Deriv accepts is {min}."), { min: money(hub.minStake, hub.currency) });
    if (!(s.tp > 0)) return T("Enter a take profit above zero.");
    if (!(s.sl > 0)) return T("Enter a stop loss above zero.");
    if (!(s.mult >= 1 && s.mult <= MULT_MAX)) return fill(T("Martingale must be between 1 (off) and {max}."), { max: MULT_MAX });
    return "";
  }
  function paintMin() {
    $("botMin").textContent = fill(T("Smallest stake Deriv accepts: {min}."), { min: money(hub.minStake, hub.currency) });
    Array.prototype.forEach.call(document.querySelectorAll("[data-bot-cur]"), function (e) { e.textContent = hub.currency; });
  }

  /* ── the popup ─────────────────────────────────────────────────────── */

  var modal = { view: null, onClose: null, lastFocus: null };
  function openModal(view) {
    ["bmScan", "bmDone", "bmErr", "bmWin"].forEach(function (id) { $(id).hidden = id !== view; });
    if ($("bmRoot").hidden) {
      modal.lastFocus = document.activeElement;
      $("bmRoot").hidden = false;
      document.documentElement.style.overflow = "hidden";
    }
    $("bmRoot").setAttribute("data-view", view);
    modal.view = view;
    var focus = $("bmRoot").querySelector("#" + view + " .btn-blue") || $("bmRoot").querySelector(".bm-x");
    if (focus) setTimeout(function () { try { focus.focus(); } catch (e) {} }, 30);
  }
  function closeModal() {
    if ($("bmRoot").hidden) return;
    $("bmRoot").hidden = true;
    document.documentElement.style.overflow = "";
    modal.view = null;
    scanToken++;                         // a scan still running is abandoned
    if (modal.lastFocus && modal.lastFocus.focus) modal.lastFocus.focus();
  }

  /* The bar eases towards the real progress and never jumps backwards, and a
     scan is shown for at least a moment so the result reads as found, not
     as a flash. */
  var bar = { shown: 0, target: 0, raf: 0 };
  function setProgress(frac, step) {
    bar.target = Math.max(bar.target, Math.min(1, frac));
    if (step) $("bmStep").textContent = step;
    if (!bar.raf) bar.raf = requestAnimationFrame(tickBar);
  }
  function tickBar() {
    bar.raf = 0;
    bar.shown += (bar.target - bar.shown) * 0.18;
    if (Math.abs(bar.target - bar.shown) < 0.002) bar.shown = bar.target;
    $("bmBar").style.width = (bar.shown * 100).toFixed(1) + "%";
    $("bmPct").textContent = Math.round(bar.shown * 100) + "%";
    if (bar.shown < bar.target) bar.raf = requestAnimationFrame(tickBar);
  }

  var scanToken = 0, pending = null;

  async function scanAndOffer() {
    var c = D.current();
    if (!c) return;
    var s = readSettings();
    var spec = makeSpec(s.type, s.variant);
    saveForm();
    say("");
    var token = ++scanToken;
    bar.shown = 0; bar.target = 0;
    $("bmTitle").textContent = T(spec.t.title);
    setProgress(0, T("Connecting to the markets…"));
    openModal("bmScan");
    var t0 = Date.now();
    try {
      var fresh = hub.account !== c.id || !hub.ready;
      await hubStart(c.id, s.stake, function (done, total, step) {
        if (token === scanToken) setProgress(0.08 + 0.72 * (total ? done / total : 0), step);
      }, spec);
      if (token !== scanToken) return;
      var err = validate(s);
      if (err) throw new Error(err);
      if (!fresh) {
        // Already live: price this type again at this stake and read the patterns now.
        setProgress(0.35, fill(spec.t.pricing(spec.variant), { n: hub.order.length }));
        var n = 0, total = hub.order.length * spec.prices.length;
        await price(c.id, s.stake, hub.gen, function () { if (token === scanToken) setProgress(0.35 + 0.45 * (++n / total)); }, spec);
      }
      if (token !== scanToken) return;
      setProgress(0.9, T("Finding the strongest pattern…"));
      var pick = null;
      for (var i = 0; i < 20 && !pick; i++) { pick = choose(spec); if (!pick) await sleep(300); }
      if (!pick) throw new Error(T("Deriv did not price any market just now. Try again."));
      var spent = Date.now() - t0;
      if (spent < 1600) await sleep(1600 - spent);
      if (token !== scanToken) return;
      setProgress(1, T("Done"));
      await sleep(350);
      if (token !== scanToken) return;

      pending = { account: c.id, settings: s, spec: spec, pick: null };
      showPick(choose(spec) || pick);
      $("bmStake").textContent = money(s.stake, hub.currency);
      $("bmMult").textContent = "×" + s.mult;
      $("bmTp").textContent = money(s.tp, hub.currency);
      $("bmSl").textContent = money(s.sl, hub.currency);
      openModal("bmDone");
      // No button to press: the bot starts on what the popup shows, and the
      // popup steps aside a moment later (x closes it sooner; trading goes on).
      startRun(true);
      setTimeout(function () { if (modal.view === "bmDone") closeModal(); }, 2800);
    } catch (e) {
      if (token !== scanToken) return;
      $("bmErrText").textContent = e.message || T("The scan did not finish. Try again.");
      openModal("bmErr");
    }
  }

  /** The popup's result: the first trade the bot places, while it is fresh. */
  function showPick(p) {
    pending.pick = { sym: p.m.sym, side: p.side.key, at: Date.now() };
    $("bmMarket").textContent = p.m.name;
    $("bmSide").textContent = p.side.label();
    $("bmSide").className = "bm-pick-side bm-pick-side--" + p.side.tone;
    $("bmShare").textContent = fill(T("{p}% of the last {n} ticks"), { p: Math.round(p.share * 100), n: WINDOW });
    dots($("bmDots"), p, pending.spec);
  }
  function paintPick() {
    if (modal.view !== "bmDone" || !pending || hub.account !== pending.account) return;
    var p = choose(pending.spec);
    if (p) showPick(p);
  }

  /* ── the run ───────────────────────────────────────────────────────── */

  var run = null;

  function newRun(account, s, spec) {
    return {
      account: account, active: true, stopping: false, ended: null, spec: spec,
      stake0: s.stake, stake: s.stake, tp: s.tp, sl: s.sl, mult: s.mult,
      pl: 0, n: 0, won: 0, lost: 0, streak: 0, errors: 0,
      log: [], ids: {}, currency: hub.currency, startedAt: Math.floor(Date.now() / 1000) - 1,
    };
  }

  function startRun(keepPopup) {
    if (!pending || (run && run.active)) return;
    var c = D.accountOf(pending.account);
    var s = pending.settings, spec = pending.spec, first = pending.pick;
    pending = null;
    if (!keepPopup) closeModal();
    if (!c) return;
    saveForm();
    // A fresh start: nothing from the last run carries over.
    run = newRun(c.id, s, spec);
    run.first = first;
    $("botLog").innerHTML = "";
    paintRun();
    paintButton();
    paintNow();
    loop(run);
  }

  function stop() {
    if (!run || !run.active) return;
    run.stopping = true;
    paintRun();
    paintButton();
  }

  function end(r, reason, detail) {
    if (!r.active) return;
    r.active = false;
    r.ended = { reason: reason, detail: detail || "", at: Math.floor(Date.now() / 1000) + 1 };
    paintRun();
    paintButton();
    paintNow();
    finalSync(r).then(function () {
      // Not over a scan the user has already started.
      if (reason === "tp" && run === r && $("bmRoot").hidden) celebrate(r);
    });
  }

  /** The first trade is the one the popup showed, while it is still fresh. */
  function firstPick(r) {
    var f = r.first;
    if (!f || r.n || Date.now() - f.at > 60000) return null;
    r.first = null;
    var sd = r.spec.sides.filter(function (x) { return x.key === f.side; })[0];
    return sd ? candidate(hub.markets[f.sym], sd) : null;
  }

  async function loop(r) {
    var waitedSince = 0;
    while (r.active) {
      if (r.stopping) return end(r, "user");
      if (r.pl >= r.tp - 1e-9) return end(r, "tp");
      if (-r.pl >= r.sl - 1e-9) return end(r, "sl");
      var acc = D.accountOf(r.account);
      if (acc && acc.balance != null && r.stake > acc.balance + 1e-9) return end(r, "balance");

      if (hub.ready && hub.account === r.account && (Date.now() - hub.pricedAt > 5 * 60000 || hub.pricedSpec !== r.spec.key)) {
        try { await price(r.account, r.stake0, hub.gen, null, r.spec); } catch (e) {}
      }

      var pick = hub.ready && hub.account === r.account ? (firstPick(r) || choose(r.spec)) : null;
      if (!pick) {
        if (!waitedSince) waitedSince = Date.now();
        if (Date.now() - waitedSince > 60000) return end(r, "nodata");
        if (!hub.ready && !hub.starting && !recovering) hubStart(r.account, r.stake0, null, r.spec).catch(function () {});
        paintRun(T("Waiting for live prices…"));
        await sleep(400);
        continue;
      }
      waitedSince = 0;

      var res;
      try { res = await buyOnce(r, pick); }
      catch (e) {
        r.errors++;
        if (e.code === "InsufficientBalance") return end(r, "balance");
        if (e.fatal || r.errors >= 3) return end(r, "error", e.message);
        paintRun(e.message);
        await sleep(1500);
        continue;
      }
      r.errors = 0;
      record(r, { market: pick.m.name, sym: pick.m.sym, side: pick.side, share: pick.share }, res);
      if (res.final) res.final.then(function (f) { if (f) correct(r, f.id, f); });
      r.stake = res.won ? r.stake0 : round2(r.stake * r.mult);
      paintRun();
    }
  }

  /** One row of the log and the run's figures, once per contract. */
  function record(r, what, res) {
    if (res.id && r.ids[res.id]) return;
    if (res.id) r.ids[res.id] = 1;
    r.n++;
    r.pl = round2(r.pl + res.pl);
    if (res.won) { r.won++; r.streak = 0; } else { r.lost++; r.streak++; }
    var label = what.side ? what.side.label() : what.label;
    var tone = what.side ? what.side.tone : "a";
    var row = { id: res.id, at: res.at || Date.now(), market: what.market, side: what.side ? what.side.key : "", label: label, share: what.share, stake: res.stake, pl: res.pl, won: res.won, total: r.pl, late: !!what.late };
    r.log.unshift(row);
    if (run !== r) return;
    var el = document.createElement("li");
    el.className = "bot-row " + (row.won ? "is-won" : "is-lost");
    el.innerHTML =
      '<span class="br-t">' + esc(new Date(row.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })) + "</span>" +
      '<span class="br-m">' + esc(row.market) + "</span>" +
      '<span class="br-s"><span class="b-chip b-chip--' + tone + '">' + esc(label) + (row.share != null ? " " + Math.round(row.share * 100) + "%" : "") + "</span></span>" +
      '<span class="br-k">' + esc(money(row.stake, r.currency)) + "</span>" +
      '<span class="br-p">' + esc(signed(row.pl, r.currency)) + "</span>" +
      '<span class="br-c">' + esc(signed(row.total, r.currency)) + "</span>";
    row.el = el;
    var list = $("botLog");
    list.insertBefore(el, list.firstChild);
    while (list.children.length > LOG_ROWS) list.removeChild(list.lastChild);
    paintRun();
  }

  /** After a run: Deriv's profit table is the record. Anything of this run
   *  the page did not see settle (a contract still open at the stop, a line
   *  that dropped) is added now — the log matches Deriv, last trade included. */
  async function finalSync(r) {
    var mine = function (x) { return r.spec.contracts.indexOf(kindOf(x)) >= 0; };
    for (var attempt = 0; attempt < 4; attempt++) {
      try {
        await D.whenOpenOn(r.account, 6000);
        var pt = await D.askOn(r.account, { profit_table: 1, limit: 100, sort: "DESC", description: 1, contract_type: r.spec.contracts, date_from: String(r.startedAt) }, 10000);
        var rows = ((pt.profit_table && pt.profit_table.transactions) || []).filter(function (x) {
          return x.contract_id && Number(x.purchase_time) >= r.startedAt && Number(x.purchase_time) <= r.ended.at && mine(x) && !r.ids[x.contract_id];
        });
        rows.reverse().forEach(function (x) {
          var sym = symOf(x), m = hub.markets[sym];
          var sd = sideOf(r.spec, kindOf(x), barrierOf(x));
          var pl = round2(Number(x.sell_price) - Number(x.buy_price));
          record(r, { market: (m && m.name) || sym, sym: sym, side: sd, label: kindOf(x), share: null, late: true },
            { id: x.contract_id, won: pl > 0, pl: pl, stake: Number(x.buy_price), at: Number(x.sell_time || x.purchase_time) * 1000 });
        });
        var pf = await D.askOn(r.account, { portfolio: 1 }, 10000);
        var open = ((pf.portfolio && pf.portfolio.contracts) || []).some(function (x) {
          return Number(x.purchase_time) >= r.startedAt && mine(x) && !r.ids[x.contract_id];
        });
        if (!open) break;
      } catch (e) { /* the line is coming back */ }
      await sleep(2000);
    }
    if (run === r) { paintRun(); paintButton(); }
  }

  /** One contract, one tick. Resolves { won, pl, stake, id, at, final }.
   *
   *  A 1-tick digit contract is decided by its exit tick, and Deriv says so at
   *  once (is_expired, is_settleable, the exit spot and the final profit);
   *  booking it as sold follows 1 to 7 seconds later. The bot moves on at the
   *  exit tick — but only when the exit spot's own last digit agrees with the
   *  profit — and keeps listening until Deriv books it: `final` resolves with
   *  the booked result (or null if the line went), and the run corrects
   *  itself on the rare chance the two differ. */
  function buyOnce(r, pick) {
    return new Promise(function (resolve, reject) {
      var sd = pick.side, type = sd.ct;
      var stake = r.stake;
      var started = Math.floor(Date.now() / 1000) - 2;
      var settled = false, closed = false, bought = null, subId = null, handle = null, tail = 0;
      var finalResolve, final = new Promise(function (res) { finalResolve = res; });
      var guard = setTimeout(function () { if (!settled) lost(); }, 30000);

      function close() {
        if (closed) return;
        closed = true;
        clearTimeout(guard);
        clearTimeout(tail);
        if (handle) handle.end();
        if (subId) D.askOn(r.account, { forget: subId }, 5000).catch(function () {});
      }
      function fail(err) {
        if (settled) return;
        settled = true;
        close();
        finalResolve(null);
        reject(err);
      }
      function result(c, id) {
        var pl = c.profit != null && c.profit !== "" ? Number(c.profit)
          : Number(c.sell_price != null ? c.sell_price : 0) - Number(c.buy_price);
        pl = round2(pl);
        return { won: pl > 0, pl: pl, stake: Number(c.buy_price) || stake, id: id || c.contract_id || (bought && bought.contract_id), at: Date.now() };
      }
      /** isFinal: Deriv has booked it. Otherwise the exit tick has decided it. */
      function settle(v, isFinal) {
        if (!settled) {
          settled = true;
          clearTimeout(guard);
          v.final = final;
          resolve(v);
          if (isFinal) { finalResolve(v); close(); }
          else tail = setTimeout(function () { finalResolve(null); close(); }, 30000);
        } else if (isFinal) { finalResolve(v); close(); }
      }
      function decided(c) {
        if (Number(c.is_expired) !== 1 || Number(c.is_settleable) !== 1) return false;
        if (c.exit_spot == null || c.exit_spot === "" || c.profit == null || c.profit === "") return false;
        var m = hub.markets[pick.m.sym];
        if (sd.series === "moves") {
          if (c.entry_spot == null || c.entry_spot === "") return false;
          return sd.wins(Math.sign(Number(c.exit_spot) - Number(c.entry_spot))) === (Number(c.profit) > 0);
        }
        var spot = m && isFinite(m.dec) ? Number(c.exit_spot).toFixed(m.dec) : String(c.exit_spot);
        return sd.wins(Number(spot.charAt(spot.length - 1))) === (Number(c.profit) > 0);
      }
      async function lost() {
        if (settled) return;
        paintRun(T("Checking the trade with Deriv…"));
        var match = function (x) {
          return (bought && Number(x.contract_id) === Number(bought.contract_id)) ||
            (!bought && Number(x.purchase_time) >= started && kindOf(x) === type && symOf(x) === pick.m.sym);
        };
        for (var i = 0; i < 10 && !settled; i++) {
          try {
            await D.whenOpenOn(r.account, 6000);
            var pt = await D.askOn(r.account, { profit_table: 1, limit: 10, sort: "DESC", description: 1, contract_type: [type] }, 10000);
            var hit = ((pt.profit_table && pt.profit_table.transactions) || []).filter(match)[0];
            if (hit) return settle(result({ buy_price: hit.buy_price, sell_price: hit.sell_price }, hit.contract_id), true);
            var pf = await D.askOn(r.account, { portfolio: 1 }, 10000);
            var open = ((pf.portfolio && pf.portfolio.contracts) || []).some(match);
            if (!open && !bought && i >= 1) return fail(new Error(T("The trade was not placed. Nothing was spent.")));
          } catch (x) { /* still reconnecting */ }
          await sleep(2500);
        }
        if (!settled) {
          var f = new Error(T("Could not confirm the last trade. The bot stopped so nothing is bought twice — check your Deriv statement."));
          f.fatal = true;
          fail(f);
        }
      }

      var params = { contract_type: type, underlying_symbol: pick.m.sym, duration: 1, duration_unit: "t", basis: "stake", amount: stake, currency: r.currency };
      if (sd.barrier != null) params.barrier = String(sd.barrier);
      handle = D.streamOn(r.account, { buy: 1, price: stake, subscribe: 1, parameters: params }, function (m) {
        if (closed) return;
        var c = m.msg_type === "proposal_open_contract" && m.proposal_open_contract;
        if (settled) {
          // Decided already; only Deriv's booking is still to come.
          if (c && c.is_sold) settle(result(c, c.contract_id), true);
          else if (m.closed || m.error) { finalResolve(null); close(); }
          return;
        }
        if (m.closed) return lost();
        if (m.error) {
          if (bought) return lost();
          var e = new Error(T(m.error.message || "Deriv refused the trade."));
          e.code = m.error.code || "";
          e.fatal = /InsufficientBalance|ContractBuyValidationError|InvalidContract|AuthorizationRequired|PermissionDenied/.test(e.code);
          return fail(e);
        }
        if (m.msg_type === "buy" && m.buy) {
          bought = m.buy;
          if (m.subscription) subId = m.subscription.id;
        } else if (c) {
          if (m.subscription && !subId) subId = m.subscription.id;
          if (c.is_sold) settle(result(c, c.contract_id), true);
          else if (decided(c)) settle(result(c, c.contract_id), false);
        }
      });
      if (!handle) { clearTimeout(guard); settled = closed = true; finalResolve(null); reject(new Error(T("Not connected to Deriv yet. Try again in a moment."))); }
    });
  }

  /** Deriv booked a trade differently from its exit tick: put the run right. */
  function correct(r, id, f) {
    var row = r.log.filter(function (x) { return x.id === id; })[0];
    if (!row || (row.pl === f.pl && row.won === f.won)) return;
    r.corrections = (r.corrections || 0) + 1;
    r.pl = round2(r.pl - row.pl + f.pl);
    if (row.won !== f.won) {
      if (f.won) { r.won++; r.lost--; } else { r.lost++; r.won--; }
    }
    row.pl = f.pl; row.won = f.won;
    if (row.el) {
      row.el.className = "bot-row " + (f.won ? "is-won" : "is-lost");
      row.el.querySelector(".br-p").textContent = signed(f.pl, r.currency);
    }
    if (run === r) paintRun();
  }

  /* ── the take-profit popup ─────────────────────────────────────────── */

  function celebrate(r) {
    $("bmWinAmt").textContent = signed(r.pl, r.currency);
    $("bmWinSum").textContent = fill(T("Trades: {n} · Won: {w} · Lost: {l}"), { n: r.n, w: r.won, l: r.lost });
    openModal("bmWin");
  }

  /* ── painting the run ──────────────────────────────────────────────── */

  var REASONS = {
    user: "Stopped.",
    tp: "Take profit reached.",
    sl: "Stop loss reached.",
    balance: "Stopped: the account cannot cover the next stake.",
    nodata: "Stopped: no live prices from Deriv.",
    error: "Stopped after an error.",
  };

  function paintRun(note) {
    var r = run;
    var cur = (r && r.currency) || hub.currency;
    $("botPl").textContent = signed(r ? r.pl : 0, cur);
    $("botPl").className = "bot-pl-v" + (r && r.pl > 0 ? " is-up" : r && r.pl < 0 ? " is-down" : "");
    $("botN").textContent = String(r ? r.n : 0);
    $("botWon").textContent = String(r ? r.won : 0);
    $("botLost").textContent = String(r ? r.lost : 0);
    $("botNext").textContent = r && r.active ? money(r.stake, cur) : "—";
    $("botStreak").textContent = String(r ? r.streak : 0);
    $("botEmpty").hidden = !!(r && r.n);
    $("logN").textContent = r && r.n ? fill(T("{n} this run"), { n: r.n }) : "";

    var text, kind;
    if (!r) { text = T("Ready"); kind = "idle"; }
    else if (r.active && r.stopping) { text = T("Stopping after this trade…"); kind = "wait"; }
    else if (r.active) { text = note || (r.n ? T("Running") : T("Starting…")); kind = "run"; }
    else {
      text = T(REASONS[r.ended.reason] || "Stopped.");
      if (r.ended.detail) text += " " + r.ended.detail;
      kind = r.ended.reason === "tp" ? "won" : (r.ended.reason === "user" ? "idle" : "bad");
    }
    $("botStateText").textContent = text;
    $("botState").className = "bot-state bot-state--" + kind;
  }

  function paintButton() {
    var b = $("botGo"), c = D.current();
    var running = !!(run && run.active);
    b.classList.toggle("is-stop", running);
    b.disabled = !!(running && run.stopping) || !c;
    $("botGoText").textContent = running ? (run.stopping ? T("Stopping…") : T("Stop")) : T("Scan & start");
    b.classList.toggle("is-real", !running && !!(c && c.type === "real"));
    ["botStake", "botTp", "botSl", "botMult", "botVar"].forEach(function (id) { $(id).disabled = running; });
    $("botTypes").classList.toggle("is-locked", running);
    Array.prototype.forEach.call(document.querySelectorAll(".bot-type"), function (t) { t.disabled = running && !t.classList.contains("is-on"); });
    if (running) {
      var acc = D.accountOf(run.account);
      $("botOn").textContent = acc ? fill(T("Trading on {account} {id}"), { account: acc.type === "real" ? T("Real") : T("Demo"), id: acc.id }) : "";
      $("botOn").hidden = false;
    } else if (c) {
      $("botOn").textContent = fill(T("Will trade on {account} {id}"), { account: c.type === "real" ? T("Real") : T("Demo"), id: c.id });
      $("botOn").hidden = false;
    } else $("botOn").hidden = true;
  }

  function say(text, kind) {
    var el = $("botMsg");
    el.textContent = text || "";
    el.className = "bot-msg" + (kind ? " bot-msg--" + kind : "");
    el.hidden = !text;
  }

  /* ── wiring ────────────────────────────────────────────────────────── */

  function onAccount() {
    var c = D.current();
    var on = !!c && !$("acct").hidden;
    $("scan").hidden = !on;
    paintButton();
    // A different chip while idle: the next scan starts on that account.
    if (on && !(run && run.active) && hub.account && hub.account !== c.id) hubStop();
    if (on && !hub.account) {
      var acc = D.accountOf(c.id);
      if (acc && acc.currency && acc.currency !== hub.currency) { hub.currency = acc.currency; paintMin(); }
    }
  }

  loadForm();
  paintType();

  $("botTypes").addEventListener("click", function (e) {
    var b = e.target.closest(".bot-type");
    if (b) setType(b.getAttribute("data-type"));
  });
  $("botTypes").addEventListener("keydown", function (e) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    var tabs = Array.prototype.filter.call(document.querySelectorAll(".bot-type"), function (b) { return !b.hidden && !b.disabled; });
    var i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    var next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    setType(next.getAttribute("data-type"));
    next.focus();
    e.preventDefault();
  });
  $("botVar").addEventListener("change", onVariant);
  $("botGo").addEventListener("click", function () {
    if (run && run.active) return stop();
    var s = readSettings();
    var err = validate(s);
    if (err) return say(err, "bad");
    scanAndOffer();
  });
  $("bmRetry").addEventListener("click", scanAndOffer);
  $("bmRoot").addEventListener("click", function (e) { if (e.target.closest("[data-bm-close]")) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("bmRoot").hidden) closeModal(); });
  global.addEventListener("shalo:account", onAccount);
  global.addEventListener("langchange", function () { paintRun(); paintButton(); paintMin(); paintNow(); paintType(); paintVariants(); });
  global.addEventListener("beforeunload", function (e) { if (run && run.active) { e.preventDefault(); e.returnValue = ""; } });

  // The column heads line up with the rows whatever the scrollbar takes.
  var wrap = document.querySelector(".bot-log-wrap"), head = document.querySelector(".bot-log-head");
  if (wrap && head && global.ResizeObserver) {
    var gutter = function () { head.style.setProperty("--sb", Math.max(0, wrap.offsetWidth - wrap.clientWidth) + "px"); };
    var ro = new ResizeObserver(gutter);
    ro.observe(wrap);
    ro.observe($("botLog"));
  }

  paintRun();
  onAccount();
  global.ShaloBot = {
    run: function () { return run; }, hub: hub, types: TYPES, makeSpec: makeSpec,
    spec: formSpec, choose: function (spec) { return choose(spec || formSpec()); },
    candidate: candidate, state: function () { return state; },
  };
})(window);
