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
 * normal win (Even/Odd keeps the owner's 3.1). The Martingale stake is never
 * cut for the stop loss: the recovery trade is placed in full, and the run
 * stops once the loss has reached or passed the stop loss (so the last trade
 * may take it past), with a popup as for take profit. A balance that cannot
 * cover the next trade ends the run with a popup pointing to Deriv to top up.
 * Each new run starts from nothing.
 *
 * THE WATCH (deriv/watch.js). From the moment an account shows, every type is
 * traded on paper — the same pick, the same next-tick entry, the user's own
 * stake, Martingale, recovery, take profit and stop loss — and read, per type,
 * against its own odds. The type tabs and the start popup show the reading as
 * colour and a figure; nothing is bought for it. With SAFE on (the default), a
 * run whose type turns red pauses — only ever after a winning trade, never in
 * a losing streak — says so, and carries on by itself once its type is green
 * again, to the take profit. Stop works at any moment, paused or not.
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
  var STATE_KEY = "shalo_bot_v2";
  var KEEP_KEY = "shalo_bot_keep";      // 1: "Save settings" is on
  var SAFE_KEY = "shalo_bot_safe";      // 0: "Safe" is off (it is on unless turned off)
  var PX_KEY = "shalo_bot_px", PX_TTL = 12 * 3600e3;   // payouts seen, per market and side
  var WATCH_HIST = 1000;                // ticks per market replayed through the watch
  var DEPOSIT_URL = "https://home.deriv.com/dashboard/portfolio";
  var FALLBACK_MIN = 0.35;
  var LOG_ROWS = 2000;
  var ENABLED = ["evenodd", "risefall", "overunder", "matchdiff"];

  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} },
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
      variants: ["0", "1", "2", "3", "4", "5", "6", "7", "8"], defVariant: "0",
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

  /* ── recovery, when the balance cannot pay the Martingale ─────────── */

  /* Differs and Over 0 pay about 6% a win, so their Martingale is x17.7 and a small
     balance soon cannot pay the next stake. Rather than stop there, the run wins the
     streak back with an Over/Under that pays more and so needs a far smaller stake: the
     likeliest one (Over 1 · 80%, then Over 2 · 70%, Over 3 · 60%, Over 4 · 50%) whose
     stake the balance covers, sized to bring back what the streak lost plus the profit of
     one ordinary win. Never below an even chance: a 10% contract on the last cents is a
     lottery ticket, not a recovery. The Martingale is untouched — it keeps counting, and
     the next win puts the stake back to the start. When no stake fits, the run stops for
     the balance as before. Differs and Over/Under 0–3 recover this way: the others'
     Martingales are small. */
  var RECOVER_CTS = ["DIGITOVER", "DIGITUNDER"], RECOVER_LAST = 4;   // Over 4 / Under 5 · 50%
  function winChance(spec) {
    if (spec.type === "matchdiff") return spec.variant === "diff" ? 0.9 : 0.1;
    if (spec.type === "overunder") return (9 - Number(spec.variant)) / 10;
    return 0;
  }
  function recovers(spec) { return winChance(spec) > 0.5; }
  /** The contract types a run can hold: its own, and the recovery's. */
  function runContracts(spec) {
    return recovers(spec) ? spec.contracts.concat(RECOVER_CTS.filter(function (c) { return spec.contracts.indexOf(c) < 0; })) : spec.contracts;
  }
  /** A contract of the run, back as a side: the type's own, else a recovery Over/Under. */
  function runSide(spec, ct, barrier) {
    var sd = sideOf(spec, ct, barrier);
    if (sd || !recovers(spec) || RECOVER_CTS.indexOf(ct) < 0 || barrier == null || barrier === "") return sd;
    var b = Number(barrier);
    return sideOf(makeSpec("overunder", String(ct === "DIGITOVER" ? b : 9 - b)), ct, b);
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
    markets: {}, order: [], subs: [], streams: {}, pricedAt: 0, pricedStake: 0, pricedSpec: "",
  };

  function lastDigit(quote, dec) {
    var s = Number(quote).toFixed(isFinite(dec) && dec >= 0 ? dec : 2);
    return Number(s.charAt(s.length - 1));
  }

  function hubStop() {
    var old = hub.account;
    hub.gen++;
    hub.subs.forEach(function (s) { try { s.end(); } catch (e) {} });
    hub.subs = [];
    hub.streams = {};
    hub.ready = false;
    hub.starting = null;
    hub.account = null;
    // Deriv keeps a subscription until it is forgotten, and refuses a second
    // one to the same market on the same socket (AlreadySubscribed).
    if (old && D.accountOf(old)) D.askOn(old, { forget_all: "ticks" }, 5000).catch(function () {});
  }

  /** One market's tick stream on the hub's socket. */
  function subscribeMarket(accountId, sym, gen) {
    var m = hub.markets[sym];
    var s = D.streamOn(accountId, { ticks: sym, subscribe: 1 }, function (msg) {
      if (gen !== hub.gen) return;
      if (msg.closed) return hubRecover(accountId, gen);
      if (msg.subscription && msg.subscription.id) m.subId = msg.subscription.id;
      if (msg.error || !msg.tick) return;
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
      if (watch) watch.feed(sym, msg.tick.epoch, q, m.dec, m.name);
      scheduleNow();
    });
    if (s) { hub.subs.push(s); hub.streams[sym] = s; }
    return s;
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

      // Whatever this socket was still subscribed to goes first.
      try { await D.askOn(accountId, { forget_all: "ticks" }, 8000); } catch (e) {}
      if (gen !== hub.gen) return;
      hub.order.forEach(function (sym) { subscribeMarket(accountId, sym, gen); });
      hub.ready = true;
      hub.starting = null;
      paintMin();
      setTimeout(afterHub, 0);
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
      var stake = live ? run.stake0 : readSettings().stake;
      var spec = live ? run.spec : formSpec();
      hubStart(accountId, stake, null, spec).catch(function () { setTimeout(function () { hubRecover(accountId, hub.gen); }, 3000); });
    }, 600);
  }

  function lineUp(accountId) {
    var f = D.feeds && D.feeds[accountId];
    return !!(f && f.ws && f.ws.readyState === 1);
  }

  /* The watchdog: a market whose ticks stopped while the line is up is
     resubscribed on its own (at most every 30 s); if every market is quiet
     the streams are rebuilt. A dropped line is trading.js's to reopen, and
     the closed streams bring hubRecover. */
  var resubAt = {}, rebuildAt = 0;
  setInterval(function () {
    // (In a background tab too: a bot keeps trading while its page is not on screen.)
    if (!hub.ready || !hub.account || !lineUp(hub.account)) return;
    var now = Date.now(), acc = hub.account, gen = hub.gen;
    var quiet = hub.order.filter(function (sym) { return now - hub.markets[sym].at > 25000; });
    if (!quiet.length) return;
    if (quiet.length === hub.order.length) {
      if (now - rebuildAt < 60000) return;
      rebuildAt = now;
      return hubRecover(acc, gen);
    }
    quiet.forEach(function (sym) {
      if (now - (resubAt[sym] || 0) < 30000) return;
      resubAt[sym] = now;
      var m = hub.markets[sym], old = hub.streams[sym];
      if (old) { try { old.end(); } catch (e) {} }
      var again = function () { if (gen === hub.gen) subscribeMarket(acc, sym, gen); };
      if (m.subId) D.askOn(acc, { forget: m.subId }, 5000).then(again, again);
      else again();
      m.subId = null;
    });
  }, 5000);

  /** What a win pays on each market and side through this account (app
   *  markup included), read at the stake or at PRICE_REF if that is more —
   *  at 0.35 every market rounds to the same cents, and a Martingale stake
   *  would then land on one that pays less. A refusal for rate keeps the
   *  last price; any other (a market that offers no return) clears it. */
  async function price(accountId, stake, gen, onEach, spec) {
    var amount = Math.max(round2(stake) || 0, hub.minStake, PRICE_REF);
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
      remember(j[0], key, m.ratio[key]);
      if (onEach) onEach();
    }));
    savePrices();
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

  /** One market and side, read now (or at `now`, in ms). Null when its prices or ticks are stale. */
  function candidate(m, sd, now) {
    var ratio = m && m.ratio && m.ratio[sd.priceKey];
    if (!ratio || m.digits.length < WINDOW || (now || Date.now()) - m.at > 20000) return null;
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

  /** The one best trade right now for this type — on the hub's markets, or on `list`
   *  (the watch's view of them) at the moment `now`. */
  function choose(spec, list, now) {
    var all = [];
    (list || hub.order.map(function (sym) { return hub.markets[sym]; })).forEach(function (m) {
      spec.sides.forEach(function (sd) { var c = candidate(m, sd, now); if (c) all.push(c); });
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
    if (nowTimer || !(run && run.active)) return;
    nowTimer = setTimeout(function () { nowTimer = 0; paintNow(); }, 500);
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

  /* Every visit starts from the defaults; what the user changes lives in this page only —
     unless "Save settings" is on, which keeps it in this browser for the next visit. */
  var keep = store.get(KEEP_KEY) === 1;
  var state = (keep && store.get(STATE_KEY)) || null;
  if (!keep) store.del(STATE_KEY);
  if (!state || !state.t) state = { type: "matchdiff", t: {} };   // Matches/Differs (Differs) first
  if (ENABLED.indexOf(state.type) < 0) state.type = "matchdiff";
  function persist() { if (keep) store.set(STATE_KEY, state); }
  function setKeep(on) {
    keep = on;
    if (on) { store.set(KEEP_KEY, 1); saveForm(); }
    else { store.del(KEEP_KEY); store.del(STATE_KEY); }
  }
  function typeState(type) {
    var ts = state.t[type] || (state.t[type] = {});
    if (!ts.mult) ts.mult = {};
    if (!ts.own) ts.own = {};                // the figures the user typed: stake, tp, sl
    if (!ts.variant) ts.variant = TYPES[type].defVariant;
    return ts;
  }

  /* Starting figures, until the user types their own (any figure, above or below these): a
     0.35 stake on every account (never under the smallest stake Deriv accepts), a take profit
     of 3% of the account's balance but never under 3 USD, and a 1,000 stop loss. Each
     Martingale has its own tested default (TYPES). */
  var DEFAULT_STAKE = 0.35, DEFAULT_TP_SHARE = 0.03, DEFAULT_TP_MIN = 3, DEFAULT_SL = 1000;
  function defaultsFor(balance) {
    var tp = balance > 0 ? round2(balance * DEFAULT_TP_SHARE) : 0;
    return { stake: Math.max(hub.minStake || FALLBACK_MIN, DEFAULT_STAKE), tp: Math.max(DEFAULT_TP_MIN, tp), sl: DEFAULT_SL };
  }
  function balanceOf(id) {
    var acc = id && D.accountOf(id);
    return acc && acc.balance != null ? Number(acc.balance) : NaN;
  }
  var FIGURES = { botStake: "stake", botTp: "tp", botSl: "sl" };
  var formVariant = null;   // the variant whose multiplier the field is showing

  function num(id) {
    var raw = String($(id).value || "").replace(",", ".").trim();
    var v = Number(raw);
    return raw && isFinite(v) ? v : NaN;
  }
  function readSettings() {
    var t = TYPES[state.type], variant = t.variants ? $("botVar").value : t.defVariant;
    return {
      type: state.type, variant: variant,
      stake: round2(num("botStake")), tp: round2(num("botTp")), sl: round2(num("botSl")),
      mult: dynamicMult(state.type, variant) ? multFor(state.type, variant) : Math.round(num("botMult") * 100) / 100,
    };
  }
  function formSpec() { var s = readSettings(); return makeSpec(s.type, s.variant); }

  /** The form's Martingale and prediction into this type's memory (the figures are kept as they are typed). */
  function saveForm() {
    var s = readSettings(), ts = typeState(s.type), v = formVariant || s.variant;
    if (s.mult >= 1 && !dynamicMult(s.type, v)) ts.mult[v] = s.mult;
    ts.variant = s.variant;
    persist();
  }
  function multFor(type, variant) {
    var v = typeState(type).mult[variant];
    return v >= 1 ? v : TYPES[type].defMult(variant);
  }
  /* Differs and Over/Under 0–3: when the balance cannot pay the Martingale's stake a
     recovery takes over (see recovery), so their Martingale is dynamic and the field says
     so instead of a figure. The figure (multFor: the tested default, or one saved before)
     still steps the stake after each loss, exactly as before; the field just cannot be
     typed into for these. */
  function dynamicMult(type, variant) { return recovers(makeSpec(type, variant)); }
  function paintMult(type, variant) {
    var dyn = dynamicMult(type, variant), f = $("botMult");
    f.readOnly = dyn;
    if (f.parentNode && f.parentNode.classList) f.parentNode.classList.toggle("is-dynamic", dyn);
    f.value = dyn ? T("Dynamic") : String(multFor(type, variant));
  }
  /** Each figure: the user's own for this type, or the balance's default. */
  function paintFigures() {
    var ts = typeState(state.type), c = D.current(), d = defaultsFor(balanceOf(c && c.id));
    Object.keys(FIGURES).forEach(function (id) {
      var k = FIGURES[id], v = ts.own[k] && ts[k] > 0 ? ts[k] : d[k];
      // Money in cents (0.35, 302.32); a whole figure stays whole (1000).
      $(id).value = k === "stake" || v % 1 ? v.toFixed(2) : String(v);
    });
  }
  /** A figure typed by the user is theirs from then on (a balance change no longer moves it). */
  function onFigure(e) {
    var k = FIGURES[e.target.id], v = round2(num(e.target.id)), ts = typeState(state.type);
    ts.own[k] = 1;
    if (v > 0) ts[k] = v;
    persist();
  }
  function loadForm() {
    var type = state.type, t = TYPES[type];
    paintFigures();
    paintVariants();
    formVariant = t.variants ? $("botVar").value : t.defVariant;
    paintMult(type, formVariant);
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
    persist();
    say("");
    syncLanes();
  }
  function onVariant() {
    var s = readSettings(), ts = typeState(s.type);
    var m = num("botMult");
    if (formVariant && m >= 1 && !dynamicMult(s.type, formVariant)) ts.mult[formVariant] = Math.round(m * 100) / 100;
    formVariant = s.variant;
    ts.variant = s.variant;
    paintMult(s.type, s.variant);
    persist();
    syncLanes();
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
    $("botMin").textContent = fill(T("Smallest stake: {min}"), { min: money(hub.minStake, hub.currency) });
    Array.prototype.forEach.call(document.querySelectorAll("[data-bot-cur]"), function (e) { e.textContent = hub.currency; });
  }

  /* ── the watch: every type on paper, all the time (deriv/watch.js) ───── */

  var safe = store.get(SAFE_KEY) !== 0;
  var pxCache = store.get(PX_KEY) || {};
  function remember(sym, key, ratio) {
    (pxCache[sym] || (pxCache[sym] = {}))[key] = [ratio == null ? 0 : ratio, Date.now()];
  }
  function savePrices() { store.set(PX_KEY, pxCache); }
  /** Payouts seen before (in the last 12 hours), for the sides not priced yet. */
  function applyPrices() {
    hub.order.forEach(function (sym) {
      var c = pxCache[sym], m = hub.markets[sym];
      if (!c || !m) return;
      Object.keys(c).forEach(function (k) {
        if (m.ratio[k] === undefined && Date.now() - c[k][1] < PX_TTL) m.ratio[k] = c[k][0] > 0 ? c[k][0] : null;
      });
    });
  }

  /** The figures a lane trades with: the running run's own, else what the form holds for
   *  that type (the user's own figure, or the balance's default). */
  function figuresFor(spec) {
    var c = D.current(), bal = balanceOf(c && c.id), min = hub.minStake || FALLBACK_MIN;
    if (run && run.active && run.spec.key === spec.key) return { stake: run.stake0, mult: run.mult, tp: run.tp, sl: run.sl, balance: bal, min: min };
    var ts = typeState(spec.type), d = defaultsFor(bal);
    var own = function (k) { return ts.own[k] && ts[k] > 0 ? ts[k] : d[k]; };
    var f = { stake: own("stake"), mult: multFor(spec.type, spec.variant), tp: own("tp"), sl: own("sl"), balance: bal, min: min };
    if (spec.type === state.type) {
      var s = readSettings();
      if (s.variant === spec.variant) {
        if (s.stake > 0) f.stake = s.stake;
        if (s.tp > 0) f.tp = s.tp;
        if (s.sl > 0) f.sl = s.sl;
        if (s.mult >= 1) f.mult = s.mult;
      }
    }
    return f;
  }
  /** The prediction each type's lane trades: the form's for the type on screen, else the type's own. */
  function laneVariant(type) {
    if (run && run.active && run.spec.type === type) return run.spec.variant;
    if (type === state.type && TYPES[type].variants && $("botVar").value) return $("botVar").value;
    return typeState(type).variant;
  }
  function laneSpecs() { return ENABLED.map(function (t) { return makeSpec(t, laneVariant(t)); }); }
  function laneKey(type) { return makeSpec(type, laneVariant(type)).key; }

  var watch = global.ShaloWatch ? global.ShaloWatch.create({
    choose: function (spec, list, now) { return choose(spec, list, now); },
    settings: figuresFor,
    ratios: function (sym) { var m = hub.markets[sym]; return m ? m.ratio : null; },
    recovers: recovers,
    recoverRatio: function (n) {
      for (var i = 0; i < hub.order.length; i++) { var m = hub.markets[hub.order[i]], r = m && m.ratio["DIGITOVER:" + n]; if (r > 1) return r; }
      return null;
    },
  }) : null;

  /** The lanes the watch keeps: each type as the form has it (and a run's, while it runs). */
  function syncLanes() {
    if (!watch) return;
    var want = {};
    laneSpecs().forEach(function (sp) { want[sp.key] = 1; watch.track(sp); });
    watch.keys().forEach(function (k) { if (!want[k]) watch.untrack(k); });
    pricing.again = true;
    watchPrices();
    paintWatch();
  }

  /** The hub on, while idle too: the watch reads the markets from the moment an account shows. */
  var idleTimer = 0, idleTries = 0;
  function idleHub() {
    if (!watch) return;
    clearTimeout(idleTimer);
    var c = D.current();
    if (!c || $("acct").hidden || (run && run.active) || hub.starting || (hub.ready && hub.account === c.id)) return;
    if (!lineUp(c.id)) { idleTimer = setTimeout(idleHub, 3000); return; }
    var s = readSettings();
    hubStart(c.id, s.stake > 0 ? s.stake : FALLBACK_MIN, null, formSpec()).catch(function () {
      idleTimer = setTimeout(idleHub, Math.min(60000, 3000 * Math.pow(2, idleTries++)));
    });
  }
  /** A hub just came up (idle, a scan, a rebuild): prices seen before, the lanes, the recent
   *  ticks of every market — then the watch replays them and follows the live ticks. */
  function afterHub() {
    if (!watch || !hub.ready) return;
    idleTries = 0;
    applyPrices();
    syncLanes();
    var acc = hub.account, gen = hub.gen;
    watchHistory(acc, gen).then(function () {
      if (gen !== hub.gen) return;
      if (!watch.started()) watch.start();
      else rewindCold(true);
      watchPrices();
      paintWatch();
    });
  }
  /** Lanes with too few paper trades to read replay the ticks the watch holds, with the figures
   *  as they are now, instead of waiting minutes for live ones: when another account comes up
   *  (always), and when the balance on this one moves (only once it pays the lane's starting
   *  stake — a deposit, a demo top-up). A lane that reads, one replaying right now (its state
   *  has no sessions then), and one already replayed with a balance that paid are left alone,
   *  so balance updates never set off replay after replay. */
  var coldAt = {};   // lane key → the balance its last such replay ran with
  function rewindCold(always) {
    if (!watch || !watch.started()) return;
    laneSpecs().forEach(function (sp) {
      var st = watch.state(sp.key);
      if (!st || !st.sessions || st.n >= 12) return;
      var f = figuresFor(sp), pays = f.balance >= f.stake;
      if (!always && (!pays || coldAt[sp.key] >= f.stake)) return;
      coldAt[sp.key] = f.balance;
      watch.rewind(sp.key);
    });
  }
  async function watchHistory(acc, gen) {
    var syms = hub.order.slice();
    for (var i = 0; i < syms.length; i += 6) {
      if (gen !== hub.gen) return;
      await Promise.all(syms.slice(i, i + 6).map(async function (sym) {
        try {
          var h = await D.askOn(acc, { ticks_history: sym, end: "latest", count: WATCH_HIST, style: "ticks" }, 15000);
          var m = hub.markets[sym];
          if (!h.error && h.history && h.history.prices && h.history.prices.length) watch.load(sym, h.history.times, h.history.prices, Number(h.pip_size), m && m.name);
        } catch (e) {}
      }));
    }
  }
  /** The payouts the lanes need and the hub has not seen: four at a time, never while a run
   *  trades (its own prices come first); the recovery's Over 1–4 on one market. A lane that
   *  waited for its prices is replayed once they are in. */
  var pricing = { busy: false, again: false };
  async function watchPrices() {
    if (!watch || pricing.busy || !hub.ready || !hub.account || (run && run.active)) return;
    pricing.busy = true; pricing.again = false;
    var acc = hub.account, gen = hub.gen, amount = Math.max(hub.minStake || FALLBACK_MIN, PRICE_REF);
    var ask = async function (sym, ct, barrier) {
      var key = ct + (barrier != null ? ":" + barrier : ""), m = hub.markets[sym];
      if (!m || m.ratio[key] !== undefined) return;
      var req = { proposal: 1, amount: amount, basis: "stake", currency: hub.currency, underlying_symbol: sym, contract_type: ct, duration: 1, duration_unit: "t" };
      if (barrier != null) req.barrier = String(barrier);
      var r = await D.askOn(acc, req, 10000);
      if (gen !== hub.gen) return;
      if (!r.error) m.ratio[key] = Number(r.proposal.payout) / amount;
      else if (r.error.code !== "RateLimit") m.ratio[key] = null;
      if (m.ratio[key] !== undefined) remember(sym, key, m.ratio[key]);
    };
    try {
      var specs = laneSpecs();
      for (var s = 0; s < specs.length; s++) {
        var spec = specs[s], jobs = [];
        hub.order.forEach(function (sym) { spec.prices.forEach(function (pr) { jobs.push([sym, pr.ct, pr.barrier]); }); });
        jobs = jobs.filter(function (j) { var m = hub.markets[j[0]]; return m && m.ratio[j[1] + (j[2] != null ? ":" + j[2] : "")] === undefined; });
        for (var i = 0; i < jobs.length; i += 4) {
          if (gen !== hub.gen || (run && run.active)) return;
          await Promise.all(jobs.slice(i, i + 4).map(function (j) { return ask(j[0], j[1], j[2]).catch(function () {}); }));
          await sleep(150);
        }
        if (jobs.length && watch.started()) { var st = watch.state(spec.key); if (st && st.n < 12) watch.rewind(spec.key); }
      }
      if (hub.order.length) for (var n = 1; n <= RECOVER_LAST; n++) {
        if (gen !== hub.gen || (run && run.active)) return;
        var have = hub.order.some(function (sym) { var m = hub.markets[sym]; return m && m.ratio["DIGITOVER:" + n] > 1; });
        if (!have) await ask(hub.order[0], "DIGITOVER", n).catch(function () {});
      }
    } catch (e) {} finally {
      pricing.busy = false;
      savePrices();
      if (pricing.again) setTimeout(watchPrices, 500);
    }
  }
  setInterval(function () { if (!(run && run.active)) watchPrices(); }, 60000);

  /* The reading, painted: each type's tab, the start popup and the pause popup carry
     data-watch (green / yellow / red, or warm while it reads, off with no markets) and
     --watch (0–1); the design lives in the page's CSS. No words, only colour and a figure. */
  var watchTimer = 0, pendingKey = null;
  function paintWatch() { if (!watchTimer) watchTimer = setTimeout(function () { watchTimer = 0; drawWatch(); }, 250); }
  function gauge(el, st) {
    var on = !!(watch && hub.ready), state = on && st ? st.state : "off";
    el.setAttribute("data-watch", state);
    el.style.setProperty("--watch", st && st.pct != null ? (st.pct / 100).toFixed(3) : String(st && st.warm ? st.warm : 0));
    return state;
  }
  function meter(box, key) {
    if (!box || !watch) return;
    if (key) box.setAttribute("data-key", key); else key = box.getAttribute("data-key");
    var st = key ? watch.state(key) : null;
    gauge(box, st);
    var pct = box.querySelector(".bm-watch-pct");
    if (pct) pct.textContent = st && st.pct != null ? Math.round(st.pct) + "%" : "…";
  }
  function drawWatch() {
    if (!watch) return;
    Array.prototype.forEach.call(document.querySelectorAll(".bot-type"), function (b) {
      var t = b.getAttribute("data-type");
      if (!TYPES[t]) return;
      var st = watch.state(laneKey(t)), mark = b.querySelector(".bot-watch");
      if (!mark) { mark = document.createElement("i"); mark.className = "bot-watch"; mark.setAttribute("aria-hidden", "true"); b.appendChild(mark); }
      gauge(b, st);
      mark.title = st && st.pct != null ? Math.round(st.pct) + "%" : "";
    });
    if (modal.view === "bmDone") meter($("bmWatch"));
    if (modal.view === "bmHold") meter($("bmHoldWatch"));
  }
  if (watch) watch.on(function () { paintWatch(); });
  setInterval(function () { if (watch) drawWatch(); }, 3000);

  /* ── Safe: a run pauses while its type reads red, and carries on when it is green ── */

  /** True while the run waits (the loop goes round again). A pause starts only with no trade
   *  in a losing streak — after a win, or before the first trade — so nothing is left to
   *  win back; it ends when the type reads green again, or when Safe is turned off. */
  async function holding(r) {
    var st = watch && hub.ready ? watch.state(r.spec.key) : null;
    if (!r.held) {
      if (!safe || !st || st.state !== "red") return false;
      var last = r.log[0];
      if (last && !last.won) return false;
      r.held = { at: Date.now(), start: !r.n };
      saveRun(r);
      showHold(r);
    } else if (!safe || (st && st.state === "green")) {
      r.held = null;
      saveRun(r);
      if (modal.view === "bmHold") closeModal();
      paintRun(T("Stable again — trading resumed."));
      return false;
    }
    paintRun();
    if (Date.now() - (r.heldSaved || 0) > 30000) { r.heldSaved = Date.now(); saveRun(r); }   // a reload keeps the paused run
    await sleep(600);
    return true;
  }
  function showHold(r) {
    var open = function () {
      if (run !== r || !r.active || !r.held || !($("bmRoot").hidden || modal.view === "bmDone")) return;
      var secs = Math.max(0, Math.floor(Date.now() / 1000 - r.startedAt));
      $("bmHoldTitle").textContent = T("Unstable conditions detected");
      $("bmHoldText").textContent = r.n
        ? T("The bot paused after a winning trade, with your profit kept. It resumes by itself as soon as conditions are stable again, and carries on to your take profit.")
        : T("The bot is waiting to place its first trade. It starts by itself as soon as conditions are stable again, and trades on to your take profit.");
      $("bmHoldPl").textContent = signed(r.pl, r.currency);
      // Up or down in the page's own colours (each page keeps its own classes on the figure).
      $("bmHoldPl").classList.toggle("is-up", r.pl > 0);
      $("bmHoldPl").classList.toggle("is-down", r.pl < 0);
      $("bmHoldN").textContent = String(r.n);
      $("bmHoldRate").textContent = r.n ? Math.round(100 * r.won / r.n) + "%" : "—";
      $("bmHoldTime").textContent = [Math.floor(secs / 3600), Math.floor(secs / 60) % 60, secs % 60].map(function (v) { return (v < 10 ? "0" : "") + v; }).join(":");
      openModal("bmHold");
      meter($("bmHoldWatch"), r.spec.key);
    };
    // The start popup has the stage for a moment; the pause takes over as it steps aside.
    if (modal.view === "bmDone") setTimeout(open, 2900); else open();
  }

  /* ── the popup ─────────────────────────────────────────────────────── */

  var modal = { view: null, onClose: null, lastFocus: null, glide: false };
  function openModal(view) {
    ["bmScan", "bmDone", "bmErr", "bmWin", "bmLoss", "bmFund", "bmHold", "bmReal"].forEach(function (id) { if ($(id)) $(id).hidden = id !== view; });
    if ($("bmRoot").hidden) {
      modal.lastFocus = document.activeElement;
      $("bmRoot").hidden = false;
      document.documentElement.style.overflow = "hidden";
    }
    $("bmRoot").setAttribute("data-view", view);
    $("bmRoot").setAttribute("aria-labelledby", view === "bmReal" ? "bmRealTitle" : "bmTitle");
    modal.view = view;
    var focus = $("bmRoot").querySelector("#" + view + " .btn-blue") || $("bmRoot").querySelector(".bm-x");
    if (focus) setTimeout(function () { try { focus.focus(); } catch (e) {} }, 30);
  }
  function closeModal() {
    if ($("bmRoot").hidden) return;
    var was = modal.view;
    $("bmRoot").hidden = true;
    document.documentElement.style.overflow = "";
    modal.view = null;
    // The result popup is the one that started a session: show its trades, even if a quick
    // session has already finished by now.
    if ((was === "bmDone" || modal.glide) && run) toTrades();
    modal.glide = false;
    scanToken++;                         // a scan still running is abandoned
    if (modal.lastFocus && modal.lastFocus.focus) modal.lastFocus.focus();
    try { global.dispatchEvent(new CustomEvent("shalo:popupclosed")); } catch (e) {}   // trading.js: a real account found meanwhile
  }

  /** One column (a phone, a small tablet): the trades are below the settings,
   *  so once the bot is running the page glides down to them. */
  function toTrades() {
    if (!global.matchMedia || !global.matchMedia("(max-width: 1000px)").matches) return;
    var el = document.querySelector(".bot-main");
    if (!el) return;
    var nav = document.querySelector(".tnav");
    var top = el.getBoundingClientRect().top + global.pageYOffset - ((nav && nav.offsetHeight) || 60) - 10;
    var calm = global.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(function () { global.scrollTo({ top: Math.max(0, top), behavior: calm ? "auto" : "smooth" }); }, 60);
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

  var scanOn = null;   // the account the last scan was started on
  async function scanAndOffer(e) {
    var c = D.current();
    if (!c) return;
    // Try again goes on with the scan the user started: never on another account.
    if (e && e.currentTarget === $("bmRetry") && scanOn && scanOn !== c.id) return closeModal();
    scanOn = c.id;
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
      if (!fresh || hub.pricedSpec !== spec.key) {
        // Already live (or started for another type): price this type at this stake and read the patterns now.
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
      if (watch) { watch.track(spec); meter($("bmWatch"), spec.key); }
      $("bmStake").textContent = money(s.stake, hub.currency);
      $("bmMult").textContent = dynamicMult(s.type, s.variant) ? T("Dynamic") : "×" + s.mult;
      $("bmTp").textContent = money(s.tp, hub.currency);
      $("bmSl").textContent = money(s.sl, hub.currency);
      openModal("bmDone");
      // No button to press: the bot starts on what the popup shows, and the
      // popup steps aside a moment later (x closes it sooner; trading goes on).
      startRun();
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

  /* ── the run ───────────────────────────────────────────────────────── */

  var run = null;

  /** A resumed run's own settings on the form: its type, its prediction and the figures
   *  it trades with (the reload painted the defaults), kept as this type's own for after it. */
  function showRun(sv) {
    var t = TYPES[sv.type], ts = typeState(sv.type), s = sv.settings || {}, v = makeSpec(sv.type, sv.variant).variant;
    state.type = sv.type;
    if (t.variants) ts.variant = v;
    ["stake", "tp", "sl"].forEach(function (k) { if (s[k] > 0) { ts[k] = s[k]; ts.own[k] = 1; } });
    if (s.mult >= 1 && !dynamicMult(sv.type, v)) ts.mult[v] = s.mult;
    $("botVar").value = "";
    loadForm();
    paintType();
  }
  function newRun(account, s, spec) {
    return {
      account: account, active: true, stopping: false, ended: null, spec: spec,
      stake0: s.stake, stake: s.stake, tp: s.tp, sl: s.sl, mult: s.mult,
      pl: 0, n: 0, won: 0, lost: 0, streak: 0, errors: 0, unpaid: 0, bookedAt: 0,
      log: [], ids: {}, currency: hub.currency, startedAt: Math.floor(Date.now() / 1000) - 1,
      bought: {}, pending: null,
    };
  }

  /** Is this contract one of this run's? Its id came back from a buy this run made, or it
   *  is the one buy whose answer the line lost: the same contract, market and stake, bought
   *  after it was sent (claimed once). The account may be trading elsewhere at the same time
   *  — another device, another bot, Deriv's own site — and none of that is this run's.
   *  A run saved before the run kept its buys (bought: null) takes what it finds, as then. */
  function ours(r, x) {
    if (!r.bought) return true;
    var id = String(x.contract_id);
    if (r.bought[id]) return true;
    var p = r.pending;
    if (p && Number(x.purchase_time) >= p.at && kindOf(x) === p.type && symOf(x) === p.sym && Math.abs(Number(x.buy_price) - p.stake) < 0.005) {
      r.bought[id] = 1;
      r.pending = null;
      return true;
    }
    return false;
  }

  /* ── a run that survives the page ──────────────────────────────────── */

  /* Saved after every trade in this tab's sessionStorage (a reload keeps it,
     another tab does not see it), and resumed after a reload. A heartbeat in
     localStorage says which page is running it: a duplicated tab, which copies
     sessionStorage, sees the original still beating and leaves it alone. */
  var RUN_KEY = "shalo_bot_run", LOCK_KEY = "shalo_bot_lock";
  var TAB = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var beat = 0, wake = null;
  var session = {
    get: function () { try { return JSON.parse(sessionStorage.getItem(RUN_KEY) || "null"); } catch (e) { return null; } },
    set: function (v) { try { sessionStorage.setItem(RUN_KEY, JSON.stringify(v)); } catch (e) {} },
    del: function () { try { sessionStorage.removeItem(RUN_KEY); } catch (e) {} },
  };
  function lockHolder() {
    var l = store.get(LOCK_KEY);
    return l && l.tab !== TAB && Date.now() - l.at < 6000 ? l : null;
  }
  function saveRun(r) {
    if (!r || !r.active) return;
    session.set({
      v: 1, account: r.account, type: r.spec.type, variant: r.spec.variant, stopping: !!r.stopping, held: !!r.held,
      settings: { stake: r.stake0, tp: r.tp, sl: r.sl, mult: r.mult }, stake: r.stake,
      pl: r.pl, n: r.n, won: r.won, lost: r.lost, streak: r.streak, startedAt: r.startedAt, currency: r.currency,
      ids: Object.keys(r.ids), savedAt: Date.now(),
      bought: r.bought ? Object.keys(r.bought).filter(function (id) { return !r.ids[id]; }) : null, pending: r.pending || null,
      log: r.log.slice(0, 300).map(function (x) { return { id: x.id, at: x.at, market: x.market, label: x.label, tone: x.tone, share: x.share, stake: x.stake, pl: x.pl, won: x.won, total: x.total }; }),
    });
  }
  function keepAwake(on) {
    if (!navigator.wakeLock) return;
    if (on && !wake && document.visibilityState === "visible") {
      navigator.wakeLock.request("screen").then(function (w) {
        wake = w;
        w.addEventListener("release", function () { if (wake === w) wake = null; });
      }).catch(function () {});
    } else if (!on && wake) { try { wake.release(); } catch (e) {} wake = null; }
  }
  function holdRun(r) {
    clearInterval(beat);
    var tick = function () { store.set(LOCK_KEY, { tab: TAB, account: r.account, at: Date.now() }); };
    tick();
    beat = setInterval(tick, 2000);
    saveRun(r);
    keepAwake(true);
  }
  function releaseRun() {
    clearInterval(beat);
    beat = 0;
    var l = store.get(LOCK_KEY);
    if (l && l.tab === TAB) { try { localStorage.removeItem(LOCK_KEY); } catch (e) {} }
    session.del();
    keepAwake(false);
  }
  // A page going away lets go of the lock at once, so its reload can resume.
  global.addEventListener("pagehide", function () {
    var l = store.get(LOCK_KEY);
    if (l && l.tab === TAB) { try { localStorage.removeItem(LOCK_KEY); } catch (e) {} }
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && run && run.active) keepAwake(true);
  });

  /** After a reload: the saved run, if it is this tab's, recent, and no other
   *  page is running it. Trades Deriv settled while the page was gone are added
   *  (and set the next stake by the same Martingale rule) before it trades on. */
  var resumeTried = false;
  async function resumeRun() {
    if (resumeTried || (run && run.active)) return;
    var sv = session.get();
    if (!sv || sv.v !== 1) { resumeTried = true; return; }
    if (Date.now() - sv.savedAt > 15 * 60000 || sv.stopping || !TYPES[sv.type]) { resumeTried = true; session.del(); return; }
    var acc = D.accountOf(sv.account);
    if (!acc || !lineUp(sv.account)) return;              // try again when this account's line is up
    if (lockHolder()) { resumeTried = true; return; }     // the original tab is still running it
    resumeTried = true;
    var spec = makeSpec(sv.type, sv.variant);
    var r = newRun(sv.account, sv.settings, spec);
    r.stake = sv.stake; r.pl = sv.pl; r.n = sv.n; r.won = sv.won; r.lost = sv.lost; r.streak = sv.streak;
    r.startedAt = sv.startedAt; r.currency = sv.currency || r.currency; r.resumed = true;
    sv.ids.forEach(function (id) { r.ids[id] = 1; });
    r.bought = null;
    if (Array.isArray(sv.bought)) { r.bought = {}; sv.bought.forEach(function (id) { r.bought[String(id)] = 1; }); }
    r.pending = sv.pending || null;
    if (sv.held) r.held = { at: Date.now(), start: !r.n };
    run = r;
    showRun(sv);
    syncLanes();
    $("botLog").innerHTML = "";
    sv.log.slice().reverse().forEach(function (x) {
      var row = Object.assign({}, x);
      r.log.unshift(row);
      row.el = rowEl(row, r.currency);
      $("botLog").insertBefore(row.el, $("botLog").firstChild);
    });
    holdRun(r);
    paintRun(T("Resuming your session…"));
    paintButton();
    paintNow();
    // What settled while the page was gone, oldest first; then wait out anything still open.
    for (var attempt = 0; attempt < 20; attempt++) {
      try {
        var cts = runContracts(spec);
        var pt = await D.askOn(r.account, { profit_table: 1, limit: 100, sort: "DESC", description: 1, contract_type: cts, date_from: String(r.startedAt) }, 10000);
        ((pt.profit_table && pt.profit_table.transactions) || []).filter(function (x) {
          return x.contract_id && Number(x.purchase_time) >= r.startedAt && !r.ids[x.contract_id] && cts.indexOf(kindOf(x)) >= 0 && ours(r, x);
        }).reverse().forEach(function (x) {
          var sym = symOf(x), m = hub.markets[sym], own = sideOf(spec, kindOf(x), barrierOf(x)), sd = own || runSide(spec, kindOf(x), barrierOf(x));
          var pl = round2(Number(x.sell_price) - Number(x.buy_price));
          record(r, { market: (m && m.name) || sym, sym: sym, side: sd, label: kindOf(x), share: null, late: true },
            { id: x.contract_id, won: pl > 0, pl: pl, stake: Number(x.buy_price), at: Number(x.sell_time || x.purchase_time) * 1000 });
          // A recovery trade stood in for one Martingale step: a loss moves the Martingale on from where it was.
          r.stake = pl > 0 ? r.stake0 : round2((own ? Number(x.buy_price) : r.stake) * r.mult);
        });
        var pf = await D.askOn(r.account, { portfolio: 1 }, 10000);
        var open = ((pf.portfolio && pf.portfolio.contracts) || []).some(function (x) {
          return Number(x.purchase_time) >= r.startedAt && cts.indexOf(kindOf(x)) >= 0 && !r.ids[x.contract_id] && ours(r, x);
        });
        if (!open) break;
      } catch (e) { /* the line is coming back */ }
      await sleep(2000);
    }
    saveRun(r);
    say(T("Your session was resumed after the page reloaded."), "info");
    if (r.held) showHold(r);
    loop(r);
  }

  function startRun() {
    if (!pending || (run && run.active)) return;
    var c = D.accountOf(pending.account);
    var s = pending.settings, spec = pending.spec, first = pending.pick;
    pending = null;
    if (!c) return;
    saveForm();
    // A fresh start: nothing from the last run carries over.
    run = newRun(c.id, s, spec);
    run.first = first;
    $("botLog").innerHTML = "";
    syncLanes();
    holdRun(run);
    paintRun();
    paintButton();
    paintNow();
    loop(run);
  }

  function stop() {
    if (!run || !run.active) return;
    run.stopping = true;
    saveRun(run);                         // a reload now does not trade on
    paintRun();
    paintButton();
  }

  function end(r, reason, detail) {
    if (!r.active) return;
    r.active = false;
    r.ended = { reason: reason, detail: detail || "", at: Math.floor(Date.now() / 1000) + 1 };
    r.held = null;
    if (modal.view === "bmHold") closeModal();
    releaseRun();
    try { global.dispatchEvent(new CustomEvent("shalo:runend")); } catch (e) {}
    paintRun();
    paintButton();
    paintNow();
    syncLanes();
    finalSync(r).then(function () {
      // A popup for how it ended — taking over from the start popup, never over a new scan.
      if (run !== r || !($("bmRoot").hidden || modal.view === "bmDone")) return;
      if (reason === "tp") celebrate(r);
      else if (reason === "sl") stopped(r);
      else if (reason === "balance") topUp(r.account, r.stake);
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
    var waited = 0, lastWait = 0, nudged = 0;
    while (r.active) {
      if (r.stopping) return end(r, "user");
      if (r.pl >= r.tp - 1e-9) return end(r, "tp");
      if (-r.pl >= r.sl - 1e-9) return end(r, "sl");
      if ((r.held || safe) && await holding(r)) continue;
      var acc = D.accountOf(r.account), rec = null, live = hub.ready && hub.account === r.account;
      if (acc && acc.balance != null && r.stake > acc.balance + 1e-9) {
        if (await covered(r) || r.stopping) continue;
        // The Martingale stake is more than the balance: recover with a contract that pays more —
        // once the prices are in (after a reload they come a moment later: wait, as for any trade).
        var canRecover = recovers(r.spec) && owed(r) > 0;
        if (canRecover && live) {
          try { rec = await recovery(r, Number(D.accountOf(r.account).balance)); } catch (e) { rec = null; }
          if (r.stopping) continue;
        }
        if (!rec && (!canRecover || live)) return end(r, "balance");
      }

      if (!rec && hub.ready && hub.account === r.account && (Date.now() - hub.pricedAt > 5 * 60000 || hub.pricedSpec !== r.spec.key)) {
        try { await price(r.account, r.stake0, hub.gen, null, r.spec); } catch (e) {}
      }

      var pick = rec ? rec.pick : live ? (firstPick(r) || choose(r.spec)) : null;
      if (!pick) {
        // Only time with the line up and the page on screen counts: a phone
        // that froze the page, or Deriv being away, never ends a run.
        var now = Date.now(), up = lineUp(r.account) && document.visibilityState !== "hidden";
        if (lastWait && up) waited += Math.min(now - lastWait, 2000);
        lastWait = now;
        if (waited > 180000) return end(r, "nodata");
        if (!up && now - nudged > 5000 && D.revive) { nudged = now; D.revive(); }
        if (!hub.ready && !hub.starting && !recovering) hubStart(r.account, r.stake0, null, r.spec).catch(function () {});
        paintRun(up ? T("Waiting for live prices…") : T("Reconnecting to Deriv…"));
        await sleep(400);
        continue;
      }
      waited = 0; lastWait = 0;

      var res;
      if (rec) { r.showStake = rec.stake; paintRun(fill(T("Recovering with {side}"), { side: pick.side.label() })); }
      try { res = await buyOnce(r, pick, rec ? rec.stake : null); }
      catch (e) {
        r.showStake = null;
        if (e.wait) {
          // Not connected: nothing was bought. Wait for the line, do not count it.
          paintRun(T("Reconnecting to Deriv…"));
          if (D.revive) D.revive();
          try { await D.whenOpenOn(r.account, 15000); } catch (x) {}
          continue;
        }
        r.errors++;
        if (e.code === "InsufficientBalance") {
          if (r.errors < 3 && (await covered(r) || r.stopping)) continue;
          return end(r, "balance");
        }
        if (e.fatal || r.errors >= 3) return end(r, "error", e.message);
        paintRun(e.message);
        await sleep(1500);
        continue;
      }
      r.errors = 0;
      r.showStake = null;
      record(r, { market: pick.m.name, sym: pick.m.sym, side: pick.side, share: pick.share }, res);
      // A win decided at its exit tick is paid out when Deriv books it.
      var pay = res.won ? round2(res.stake + res.pl) : 0;
      r.unpaid = round2(r.unpaid + pay);
      res.final.then(function (f) { r.unpaid = round2(r.unpaid - pay); r.bookedAt = Date.now(); if (f) correct(r, f.id, f); });
      r.stake = res.won ? r.stake0 : round2(r.stake * r.mult);
      saveRun(r);
      paintRun();
    }
  }

  /** A trade is decided at its exit tick, but Deriv pays a win out only when it books the
   *  sale, 1 to 7 seconds later: until then the balance lacks that payout. True once the
   *  balance covers the next stake; false at once when even the payouts still to come
   *  would not cover it (a Martingale stake the account cannot pay), or once they have
   *  come and the balance has had a moment to show them. */
  async function covered(r) {
    var t0 = Date.now();
    for (;;) {
      var acc = D.accountOf(r.account);
      if (!acc || acc.balance == null || r.stake <= Number(acc.balance) + 1e-9) return true;
      if (!r.active || r.stopping || Date.now() - t0 > 30000) return false;
      if (r.stake > Number(acc.balance) + r.unpaid + 1e-9 && Date.now() - r.bookedAt > 3000) return false;
      paintRun(T("Waiting for Deriv to pay out the last trade…"));
      await sleep(250);
    }
  }

  /** What the losing streak has cost so far: the stakes since the last win. */
  function owed(r) {
    var s = 0;
    for (var i = 0; i < r.log.length && !r.log[i].won; i++) s += Number(r.log[i].stake) || 0;
    return round2(s);
  }
  async function payoutOf(account, sym, ct, barrier, amount) {
    var q = await D.askOn(account, { proposal: 1, amount: amount, basis: "stake", currency: hub.currency, underlying_symbol: sym,
      contract_type: ct, duration: 1, duration_unit: "t", barrier: String(barrier) }, 10000);
    return q.error ? null : Number(q.proposal.payout);
  }
  /** The recovery trade ({ pick, stake }), or null when no contract's stake fits the balance. */
  async function recovery(r, balance) {
    var debt = owed(r);
    if (!(debt > 0) || !recovers(r.spec) || !(balance >= hub.minStake)) return null;
    var main = choose(r.spec);
    var need = round2(debt + (main ? Math.max(0, r.stake0 * (main.ratio - 1)) : 0));
    var from = Math.round(9 - 10 * winChance(r.spec)) + 1;     // less likely than the type's own: pays more
    var syms = main ? [main.m.sym] : [];
    hub.order.forEach(function (s) { if (syms.indexOf(s) < 0) syms.push(s); });
    var ref = Math.max(PRICE_REF, hub.minStake), tried = 0;
    for (var i = 0; i < syms.length && tried < 3; i++) {
      var m = hub.markets[syms[i]];
      if (!m || m.digits.length < WINDOW || Date.now() - m.at > 20000) continue;
      tried++;
      for (var n = from; n <= RECOVER_LAST; n++) {
        var p = await payoutOf(r.account, m.sym, "DIGITOVER", n, ref);
        if (!p) { if (n === from) break; continue; }             // this market does not sell Over/Under
        var stake = Math.max(hub.minStake, Math.ceil(need / (p / ref - 1) * 100) / 100);
        if (!(p > ref) || stake > balance + 1e-9) continue;
        // Deriv's price at this very stake rounds to cents: make sure it wins back the lot.
        for (var k = 0; k < 4; k++) {
          var pay = await payoutOf(r.account, m.sym, "DIGITOVER", n, stake);
          if (!pay || round2(pay - stake) >= need - 1e-9) break;
          stake = round2(stake + Math.ceil((need - (pay - stake)) / (pay / stake - 1) * 100) / 100);
        }
        if (stake > balance + 1e-9) continue;
        var spec = makeSpec("overunder", String(n)), best = null;
        spec.sides.forEach(function (sd) { m.ratio[sd.priceKey] = p / ref; });
        spec.sides.forEach(function (sd) { var c = candidate(m, sd); if (c && (!best || better(c, best))) best = c; });
        if (best) return { pick: best, stake: stake };
      }
    }
    return null;
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
    var row = { id: res.id, at: res.at || Date.now(), market: what.market, side: what.side ? what.side.key : "", label: label, tone: tone, share: what.share, stake: res.stake, pl: res.pl, won: res.won, total: r.pl, late: !!what.late };
    r.log.unshift(row);
    if (run !== r) return;
    row.el = rowEl(row, r.currency);
    slideIn($("botLog"), row.el);
    var list = $("botLog");
    while (list.children.length > LOG_ROWS) list.removeChild(list.lastChild);
    paintRun();
  }

  function rowEl(row, cur) {
    var el = document.createElement("li");
    el.className = "bot-row " + (row.won ? "is-won" : "is-lost");
    el.innerHTML =
      '<span class="br-t">' + esc(new Date(row.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })) + "</span>" +
      '<span class="br-m">' + esc(row.market) + "</span>" +
      '<span class="br-s"><span class="b-chip b-chip--' + (row.tone || "a") + '">' + esc(row.label) + (row.share != null ? " " + Math.round(row.share * 100) + "%" : "") + "</span></span>" +
      '<span class="br-k">' + esc(money(row.stake, cur)) + "</span>" +
      '<span class="br-p">' + esc(signed(row.pl, cur)) + "</span>" +
      '<span class="br-c">' + esc(signed(row.total, cur)) + "</span>";
    return el;
  }

  /** A new trade at the top: it comes in from the right and lands against the
   *  left edge with a hit; the rows already there glide down to make room. */
  function slideIn(list, el) {
    var calm = global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var before = Array.prototype.slice.call(list.children, 0, 24);
    var tops = before.map(function (x) { return x.getBoundingClientRect().top; });
    list.insertBefore(el, list.firstChild);
    if (calm || !el.animate) return;
    before.forEach(function (x, i) {
      var d = tops[i] - x.getBoundingClientRect().top;
      if (d) x.animate([{ transform: "translateY(" + d + "px)" }, { transform: "none" }], { duration: 280, easing: "cubic-bezier(.2,.8,.2,1)" });
    });
    el.classList.add("is-new");
    setTimeout(function () { el.classList.remove("is-new"); }, 900);
  }

  /** After a run: Deriv's profit table is the record. Anything of this run
   *  the page did not see settle (a contract still open at the stop, a line
   *  that dropped) is added now — the log matches Deriv, last trade included. */
  async function finalSync(r) {
    var cts = runContracts(r.spec), mine = function (x) { return cts.indexOf(kindOf(x)) >= 0; };
    for (var attempt = 0; attempt < 4; attempt++) {
      try {
        await D.whenOpenOn(r.account, 6000);
        var pt = await D.askOn(r.account, { profit_table: 1, limit: 100, sort: "DESC", description: 1, contract_type: cts, date_from: String(r.startedAt) }, 10000);
        var rows = ((pt.profit_table && pt.profit_table.transactions) || []).filter(function (x) {
          return x.contract_id && Number(x.purchase_time) >= r.startedAt && Number(x.purchase_time) <= r.ended.at && mine(x) && !r.ids[x.contract_id] && ours(r, x);
        });
        rows.reverse().forEach(function (x) {
          var sym = symOf(x), m = hub.markets[sym];
          var sd = runSide(r.spec, kindOf(x), barrierOf(x));
          var pl = round2(Number(x.sell_price) - Number(x.buy_price));
          record(r, { market: (m && m.name) || sym, sym: sym, side: sd, label: kindOf(x), share: null, late: true },
            { id: x.contract_id, won: pl > 0, pl: pl, stake: Number(x.buy_price), at: Number(x.sell_time || x.purchase_time) * 1000 });
        });
        var pf = await D.askOn(r.account, { portfolio: 1 }, 10000);
        var open = ((pf.portfolio && pf.portfolio.contracts) || []).some(function (x) {
          return Number(x.purchase_time) >= r.startedAt && mine(x) && !r.ids[x.contract_id] && ours(r, x);
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
  function buyOnce(r, pick, amount) {
    return new Promise(function (resolve, reject) {
      var sd = pick.side, type = sd.ct;
      var stake = amount != null ? amount : r.stake;
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
      var checking = false;
      async function lost() {
        if (settled || checking) return;
        checking = true;
        paintRun(T("Checking the trade with Deriv…"));
        var match = function (x) {
          return (bought && Number(x.contract_id) === Number(bought.contract_id)) ||
            (!bought && Number(x.purchase_time) >= started && kindOf(x) === type && symOf(x) === pick.m.sym && Math.abs(Number(x.buy_price) - stake) < 0.005);
        };
        // Ten answers from Deriv, however long the line takes to come back
        // (up to 10 minutes of outage); nothing is bought while it checks.
        var answers = 0, since = Date.now();
        while (!settled && answers < 10 && Date.now() - since < 600000) {
          try {
            await D.whenOpenOn(r.account, 6000);
            var pt = await D.askOn(r.account, { profit_table: 1, limit: 10, sort: "DESC", description: 1, contract_type: [type] }, 10000);
            var hit = ((pt.profit_table && pt.profit_table.transactions) || []).filter(match)[0];
            if (hit) { own(hit.contract_id); return settle(result({ buy_price: hit.buy_price, sell_price: hit.sell_price }, hit.contract_id), true); }
            var pf = await D.askOn(r.account, { portfolio: 1 }, 10000);
            answers++;
            var open = ((pf.portfolio && pf.portfolio.contracts) || []).some(match);
            if (!open && !bought && answers >= 2) { r.pending = null; return fail(new Error(T("The trade was not placed. Nothing was spent."))); }
          } catch (x) { if (D.revive) D.revive(); }
          await sleep(2500);
        }
        checking = false;
        if (!settled) {
          var f = new Error(T("Could not confirm the last trade. The bot stopped so nothing is bought twice — check your Deriv statement."));
          f.fatal = true;
          fail(f);
        }
      }

      /** This run bought `id`: kept with the run (a reload keeps it too). */
      function own(id) {
        if (r.bought && id != null) r.bought[String(id)] = 1;
        r.pending = null;
        saveRun(r);
      }
      var params = { contract_type: type, underlying_symbol: pick.m.sym, duration: 1, duration_unit: "t", basis: "stake", amount: stake, currency: r.currency };
      if (sd.barrier != null) params.barrier = String(sd.barrier);
      // Sent but not yet answered: if the line goes now, the contract found for it is this run's.
      r.pending = { at: started, type: type, sym: pick.m.sym, stake: stake };
      saveRun(r);
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
          r.pending = null;                // refused: nothing was bought
          var e = new Error(T(m.error.message || "Deriv refused the trade."));
          e.code = m.error.code || "";
          e.fatal = /InsufficientBalance|ContractBuyValidationError|InvalidContract|AuthorizationRequired|PermissionDenied/.test(e.code);
          return fail(e);
        }
        if (m.msg_type === "buy" && m.buy) {
          bought = m.buy;
          own(m.buy.contract_id);
          if (m.subscription) subId = m.subscription.id;
        } else if (c) {
          if (m.subscription && !subId) subId = m.subscription.id;
          if (c.is_sold) settle(result(c, c.contract_id), true);
          else if (decided(c)) settle(result(c, c.contract_id), false);
        }
      });
      if (!handle) {
        r.pending = null;
        clearTimeout(guard); settled = closed = true; finalResolve(null);
        var w = new Error(T("Not connected to Deriv yet. Try again in a moment."));
        w.wait = true;
        reject(w);
      }
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

  /** A result popup; one that takes over from the start popup still glides to the trades on a phone. */
  function result(view) {
    var glide = modal.view === "bmDone";
    openModal(view);
    modal.glide = glide;
  }
  function celebrate(r) {
    $("bmWinAmt").textContent = signed(r.pl, r.currency);
    $("bmWinSum").textContent = fill(T("Trades: {n} · Won: {w} · Lost: {l}"), { n: r.n, w: r.won, l: r.lost });
    result("bmWin");
  }

  /* ── the stop-loss popup ───────────────────────────────────────────── */

  function stopped(r) {
    $("bmLossAmt").textContent = signed(r.pl, r.currency);
    $("bmLossSum").textContent = fill(T("Trades: {n} · Won: {w} · Lost: {l}"), { n: r.n, w: r.won, l: r.lost });
    result("bmLoss");
  }

  /* ── not enough balance: where to top up ───────────────────────────── */

  function topUp(accountId, stake) {
    var acc = D.accountOf(accountId), real = !!(acc && acc.type === "real"), cur = (acc && acc.currency) || hub.currency;
    $("bmFundText").textContent = fill(T("Your balance ({bal}) can't cover the next trade ({stake})."), { bal: money(acc ? Number(acc.balance) || 0 : 0, cur), stake: money(stake, cur) });
    $("bmFundNote").textContent = real ? T("Already deposited but don't see it here? On Deriv, tap Transfer and move the money to Options.") : T("Top up or reset your demo balance on Deriv.");
    $("bmFundGo").textContent = real ? T("Deposit on Deriv") : T("Go to Deriv");
    $("bmFundGo").href = DEPOSIT_URL;
    result("bmFund");
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
    $("botNext").textContent = r && r.active ? money(r.showStake != null ? r.showStake : r.stake, cur) : "—";
    $("botStreak").textContent = String(r ? r.streak : 0);
    $("botEmpty").hidden = !!(r && r.n);
    $("logN").textContent = r && r.n ? fill(T("{n} this run"), { n: r.n }) : "";

    var text, kind;
    if (!r) { text = T("Ready"); kind = "idle"; }
    else if (r.active && r.stopping) { text = T("Stopping after this trade…"); kind = "wait"; }
    else if (r.active && r.held) { text = T("Paused — waiting for stable conditions…"); kind = "wait"; }
    else if (r.active) { text = note || (r.n ? T("Running") : T("Starting…")); kind = "run"; }
    else {
      text = T(REASONS[r.ended.reason] || "Stopped.");
      if (r.ended.detail) text += " " + r.ended.detail;
      kind = r.ended.reason === "tp" ? "won" : (r.ended.reason === "user" ? "idle" : "bad");
    }
    $("botStateText").textContent = text;
    $("botState").className = "bot-state bot-state--" + kind;
  }

  /* ── no real account yet: what it takes to start ──────────────────── */

  /** No account at all on the login (trading.js): nothing to trade on until a real one is
   *  open. A login with only a demo trades on it as before. */
  function needsReal() { return !D.current() && D.needsReal && D.needsReal() === "none"; }
  var realOffered = false;
  /** The popup's words: for a login with no account, or one with only a demo (which stays in use). */
  function realWords() {
    var demo = D.needsReal && D.needsReal() === "real";
    $("bmRealText").textContent = T(demo ? "This Deriv login has only a demo account so far." : "This Deriv login has no trading account yet.");
    $("bmRealMore").textContent = T(demo
      ? "Your demo account is there for practice. To trade real money, the Smart Scan bot needs a real Deriv account. Setting one up on Deriv takes a few minutes, and it appears here the moment it is ready."
      : "The Smart Scan bot trades on a real Deriv account. Setting one up on Deriv takes a few minutes, and the bot is ready the moment it appears here.");
  }
  function offerReal() {
    realWords();
    openModal("bmReal");
  }

  function paintButton() {
    var b = $("botGo"), c = D.current();
    var running = !!(run && run.active);
    b.classList.toggle("is-stop", running);
    b.disabled = !!(running && run.stopping) || (!c && !needsReal());
    $("botGoText").textContent = running ? (run.stopping ? T("Stopping…") : T("Stop")) : T("Scan & start");
    b.classList.toggle("is-real", !running && !!(c && c.type === "real"));
    ["botStake", "botTp", "botSl", "botMult", "botVar"].forEach(function (id) { $(id).disabled = running; });
    $("botTypes").classList.toggle("is-locked", running);
    Array.prototype.forEach.call(document.querySelectorAll(".bot-type"), function (t) { t.disabled = running && !t.classList.contains("is-on"); });
  }

  function say(text, kind) {
    var el = $("botMsg");
    el.textContent = text || "";
    el.className = "bot-msg" + (kind ? " bot-msg--" + kind : "");
    el.hidden = !text;
  }

  /* ── wiring ────────────────────────────────────────────────────────── */

  function onAccount() {
    var c = D.current(), noReal = needsReal();
    var on = (!!c || noReal) && !$("acct").hidden;
    $("scan").hidden = !on;
    paintButton();
    // No account at all: the page as it is with the bot at rest, and once a visit by itself
    // (again on Start) the popup on opening a real one. Nothing here reads or trades.
    if (noReal) {
      // The figures from no balance (a balance left from another login would set them otherwise).
      if (!(run && run.active)) paintFigures();
      if (modal.view === "bmReal") realWords();   // the login's kind changed with the popup up
      if (on && !realOffered) { realOffered = true; offerReal(); }
      return;
    }
    if (modal.view === "bmReal") {
      if (!(D.needsReal && D.needsReal())) closeModal();   // a real account came in meanwhile
      else realWords();                                    // no account before, a demo now: its words
    }
    // A different chip while idle: the next scan starts on that account.
    if (on && !(run && run.active) && hub.account && hub.account !== c.id) hubStop();
    if (on) idleHub();
    // The same account, idle, its balance moved: a lane the old balance kept cold may read now.
    if (on && !(run && run.active) && hub.ready && hub.account === c.id) rewindCold(false);
    if (on && !hub.account) {
      var acc = D.accountOf(c.id);
      if (acc && acc.currency && acc.currency !== hub.currency) { hub.currency = acc.currency; paintMin(); }
    }
    if (on && !(run && run.active)) paintFigures();
    if (!resumeTried) resumeRun();
    // Only a demo: it stays in use; once a visit, with nothing else on screen and no run
    // going or coming back, the popup says how to open a real account.
    // Only before any run of this visit: a run's result popup is never taken over by it.
    if (on && !realOffered && D.needsReal && D.needsReal() === "real" && resumeTried && !run && !modal.view) { realOffered = true; offerReal(); }
  }

  loadForm();
  paintType();
  paintMin();

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
  Object.keys(FIGURES).forEach(function (id) { $(id).addEventListener("input", onFigure); });
  $("botKeep").checked = keep;
  $("botKeep").addEventListener("change", function () { setKeep($("botKeep").checked); });
  if ($("botSafe")) {
    $("botSafe").checked = safe;
    $("botSafe").addEventListener("change", function () {
      safe = $("botSafe").checked;
      if (safe) store.del(SAFE_KEY); else store.set(SAFE_KEY, 0);
    });
  }
  if ($("bmHoldStop")) $("bmHoldStop").addEventListener("click", function () { stop(); closeModal(); });
  $("botGo").addEventListener("click", function () {
    if (run && run.active) return stop();
    if (needsReal()) return offerReal();          // nothing to trade on until a real account is open
    if (lockHolder()) return say(T("The bot is already running in another tab or window. Stop it there first."), "bad");
    var s = readSettings();
    var err = validate(s);
    if (err) return say(err, "bad");
    var c = D.current(), acc = c && D.accountOf(c.id);
    if (acc && acc.balance != null && s.stake > Number(acc.balance) + 1e-9) return topUp(c.id, s.stake);
    scanAndOffer();
  });
  $("bmRetry").addEventListener("click", scanAndOffer);
  $("bmRoot").addEventListener("click", function (e) { if (e.target.closest("[data-bm-close]")) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("bmRoot").hidden) closeModal(); });
  global.addEventListener("shalo:account", onAccount);
  global.addEventListener("langchange", function () { paintRun(); paintButton(); paintMin(); paintNow(); paintType(); paintVariants(); if (dynamicMult(state.type, formVariant)) paintMult(state.type, formVariant); if (modal.view === "bmReal") realWords(); });   // the word, in the new language; a typed figure stays
  // The sign-in ended, or a note took the page (Deriv upgrading the account), while the popup
  // on opening a real account was up: the page says so, not the popup.
  global.addEventListener("shalo:expired", function () { if (modal.view === "bmReal") closeModal(); });
  global.addEventListener("shalo:note", function () { if (modal.view === "bmReal") closeModal(); });
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
    watch: watch, laneKey: laneKey, safe: function () { return safe; },
  };
})(window);
