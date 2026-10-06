/**
 * SHALOBOT — the simulator's Deriv.
 *
 * Loaded by deriv/door.js before anything else on /trading, and only with the
 * mode on. It is NOT a second copy of the page: trading.js and bot.js run
 * exactly as they do every day, and the only thing swapped underneath them is
 * Deriv — our /api/deriv/* endpoints answered here, and the WebSocket they
 * would have opened replaced by one that speaks the same protocol.
 *
 * A forked page would drift from the real one within a week. A fake server
 * cannot: if a trade works here, the same code made it work.
 *
 * ── What it copies (measured on the live API, 2026-10-05) ───────────────────
 *
 *   - The same 25 markets the scan uses (the 20 digit markets and the 5 Step
 *     indices), with Deriv's names, decimals, tick rates (1 s or 2 s), the size
 *     of a typical tick, how often a tick repeats (Jump 100: 22%) and the jumps.
 *   - Payouts through the app, to the cent: a digit contract pays
 *     stake / (chance + c), where c is 0.042 on most markets, 0.05 on R_100,
 *     1HZ10V and 1HZ100V, and 0.38 on JD100 (which is why it refuses Differs and
 *     most Over/Under: "This contract offers no return"). Rise/Fall pays each
 *     market's own measured rate. Deriv's smallest stake (0.35) and its refusal,
 *     an unaffordable stake refused as Deriv refuses it.
 *   - The messages, field for field: the buy, "waiting for entry tick", the
 *     contract decided at its exit tick (sent twice), booked as sold about a
 *     second later (twice), the balance stream at the buy and at the sale, the
 *     profit table and the portfolio.
 *
 * ── It says what it is ──────────────────────────────────────────────────────
 *
 * A badge reading "Simulation · not real money" is always on screen: in the
 * header, and on a phone pinned under it while the page scrolls. That badge
 * (and the setup card) are where the simulation says so; everything else
 * reads exactly like the real page — REAL / DEMO on the chip, Real account
 * and Demo account in the list with the user's own account numbers (read with
 * the real session), the demo holding the actual demo balance and the real
 * one the card's. Practice and testing need the real page's behaviour, not a
 * page that passes for real money: the badge is what keeps it from that.
 *
 * ── How an outcome is arranged ──────────────────────────────────────────────
 *
 * As Evie's: the simulator decides which way a contract should go and then
 * CHOOSES THE SETTLING TICK so it genuinely settles that way — a scripted loss
 * on Differs 3 really lands on a 3, in the same feed the scan is reading, so
 * the digits, the pattern, the payout and the balance all agree with each
 * other. Which trades lose is the plan set on the card (three clicks on the
 * green dot in the balance chip): none, a run in a row, or at random, and
 * whether the first trade loses.
 *
 * ── Kept apart from the real page ───────────────────────────────────────────
 *
 * Everything trading.js and bot.js store (settings, the running session, the
 * last balances) is renamed underneath them while the mode is on, so practice
 * figures never land on the real page and a real session is never resumed in
 * here. The simulated balances are kept at every settlement, so a session
 * picks up where the last one stopped.
 */

(function (global) {
  "use strict";

  /* ── apart from the real page ──────────────────────────────────────── */

  var OURS = /^shalo_(deriv|bot)/;
  ["getItem", "setItem", "removeItem"].forEach(function (fn) {
    var real = Storage.prototype[fn];
    Storage.prototype[fn] = function (k) {
      var args = Array.prototype.slice.call(arguments);
      if (typeof k === "string" && OURS.test(k)) args[0] = "sim." + k;
      return real.apply(this, args);
    };
  });

  var round2 = function (v) { return Math.round(v * 100) / 100; };
  var rnd = function (a, b) { return a + Math.random() * (b - a); };
  function uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 3 | 8)).toString(16);
    });
  }
  function digits(n) { var s = ""; while (s.length < n) s += Math.floor(Math.random() * 10); return s; }

  /* ── the setup: balances, the plan, the account ids ────────────────── */

  var SETUP = "shalo_ui_p";
  function setup() {
    var d = { real: 1000, demo: 10000, mode: "none", streak: [1, 3], gap: [3, 10], per10: [1, 3], apart: true, firstLoss: false, ids: null };
    var raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(SETUP) || "null");
      if (raw) Object.keys(d).forEach(function (k) { if (raw[k] !== undefined && raw[k] !== null) d[k] = raw[k]; });
    } catch (e) {}
    // A setup saved before the ranges had one count: it becomes a range of one.
    if (raw && raw.count != null && raw.streak == null) {
      var n = Math.round(Number(raw.count) || 0);
      d.streak = [clamp(n, 1, 10), clamp(n, 1, 10)];
      d.per10 = [clamp(n, 0, 10), clamp(n, 0, 10)];
    }
    d.streak = range(d.streak, 1, 10, [1, 3]);
    d.gap = range(d.gap, 1, 100, [3, 10]);
    d.per10 = range(d.per10, 0, 10, [1, 3]);
    // Made once per device and kept; they say what they are.
    // Made once per device until the real session gives the accounts' own numbers (see adoptIds).
    if (!d.ids || !d.ids.real || !d.ids.demo) d.ids = { real: "SIM" + digits(8), demo: "SIMD" + digits(7) };
    return d;
  }
  function save(c) { try { localStorage.setItem(SETUP, JSON.stringify(c)); } catch (e) {} }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  /** A [from, to] pair of whole numbers inside lo…hi, the smaller first. */
  function range(r, lo, hi, dflt) {
    if (!r || r.length !== 2 || !isFinite(Number(r[0])) || !isFinite(Number(r[1]))) r = dflt;
    var a = clamp(Math.round(Number(r[0])), lo, hi), b = clamp(Math.round(Number(r[1])), lo, hi);
    return a <= b ? [a, b] : [b, a];
  }
  var cfg = setup();
  save(cfg);

  /* Which trades lose, worked out afresh for every run of the bot, the way a
     real run has its own luck — nothing to set again between runs:
       None      every trade wins.
       In a row  losing streaks, each as long as a number drawn from its range
                 (1–3 say), with a drawn number of wins before each, again
                 and again until the run ends.
       Random    in every 10 trades a drawn number of losses (1–3 say) at
                 random places — never two together, unless that is allowed.
     "First trade loses" opens every run with a loss (In a row: with a whole
     streak); off, the first trade of a run always wins. A run's plan is kept
     for the tab (sessionStorage), so a run that resumes after a reload goes on
     where it was rather than starting over.

     The card's numbers are for a 50/50 trade (Even/Odd, Rise/Fall, Over 4):
     the plan says how each trade would go at even odds, and every other
     contract keeps to its own, as on Deriv. One that wins more often than
     even loses only that share of the plan's losses — Differs and Over 0 one
     in five (q / 0.5), so even settings give their real 10% and two losses
     running are rare; one that wins less often also loses that share of the
     plan's wins — Matches, (q - 0.5) / 0.5, its real 90% at even settings. */
  var PLAN = "shalo_ui_r";
  function draw(r) { return r[0] + Math.floor(Math.random() * (r[1] - r[0] + 1)); }
  /** A contract's chance to win on Deriv (ties aside). */
  function chanceOf(ct, b) {
    if (ct === "DIGITDIFF") return 0.9;
    if (ct === "DIGITMATCH") return 0.1;
    if (ct === "DIGITOVER") return (9 - b) / 10;
    if (ct === "DIGITUNDER") return b / 10;
    return 0.5;   // Even/Odd, Rise/Fall
  }
  function Plan(c, key) {
    this.c = c; this.key = key;
    this.n = 0;               // trades so far in this run
    this.losing = false;      // In a row: in a streak (else in the wins before one)
    this.left = 0;            // In a row: trades left in the current stretch
    this.block = -1;          // Random: which ten
    this.marks = [];          // Random: the trades of that ten that lose
    this.lastLoss = 0;
  }
  /** Does this trade lose? `p`: its contract's chance to win. */
  Plan.prototype.loses = function (p) {
    var c = this.c, t = ++this.n, forced = t === 1 && !!c.firstLoss, even;
    if (c.mode === "consecutive") {
      if (t === 1) { this.losing = forced; this.left = draw(forced ? c.streak : c.gap); }
      else if (this.left <= 0) { this.losing = !this.losing; this.left = draw(this.losing ? c.streak : c.gap); }
      this.left--;
      even = this.losing;
    } else if (c.mode === "random") {
      var b = Math.floor((t - 1) / 10);
      if (b !== this.block) { this.block = b; this.marks = this.place(b); }
      even = forced || this.marks.indexOf(t) >= 0;
    } else even = forced;
    // The plan is for even odds; this contract's own (see above).
    var q = 1 - (p == null ? 0.5 : p), lose = even;
    if (!forced && q < 0.5) lose = even && Math.random() < q / 0.5;
    else if (!forced && q > 0.5 && !even && t > 1 && c.mode !== "none") lose = Math.random() < (q - 0.5) / 0.5;   // None: every trade wins; a run's first wins
    // "Never two in a row" holds for every contract, whichever way its loss came.
    if (lose && !forced && c.mode === "random" && c.apart !== false && this.lastLoss === t - 1) lose = false;
    if (lose) this.lastLoss = t;
    return lose;
  };
  /** Random: the losing trades among 10b+1 … 10b+10 — exactly the number
   *  drawn (as many as fit, apart: five), every arrangement equally likely.
   *  Trade 1 is the first trade's own: it loses only for "First trade loses",
   *  and then counts as one of the first ten. */
  Plan.prototype.place = function (b) {
    var c = this.c, apart = c.apart !== false, from = 10 * b + 1, to = from + 9, want = draw(c.per10);
    if (b === 0) { from = 2; if (c.firstLoss) { want--; if (apart) from = 3; } }
    else if (apart && this.lastLoss === from - 1) from++;           // not straight after the last ten's last loss
    var n = to - from + 1, k = Math.max(0, Math.min(want, apart ? Math.ceil(n / 2) : n));
    // k of n places; apart, k of n - k + 1 then spread out one each, which keeps them apart
    var m = apart ? n - k + 1 : n, pool = [];
    for (var i = 0; i < m; i++) pool.push(i);
    for (i = 0; i < k; i++) { var j = i + Math.floor(Math.random() * (m - i)), x = pool[i]; pool[i] = pool[j]; pool[j] = x; }
    return pool.slice(0, k).sort(function (p, q) { return p - q; }).map(function (q, i) { return from + q + (apart ? i : 0); });
  };
  var plan = null;
  /** The plan of the run that is buying (by its account and start), restored after a reload. */
  function planNow() {
    var r = null;
    try { r = global.ShaloBot && global.ShaloBot.run(); } catch (e) {}
    var key = r && r.active ? r.account + "@" + r.startedAt : "";
    if (plan && plan.key === key) return plan;
    plan = new Plan(cfg, key);
    try {
      var s = JSON.parse(sessionStorage.getItem(PLAN) || "null");
      if (key && s && s.key === key) ["n", "losing", "left", "block", "marks", "lastLoss"].forEach(function (f) { if (s[f] != null) plan[f] = s[f]; });
    } catch (e) {}
    return plan;
  }
  function keepPlan() {
    try {
      sessionStorage.setItem(PLAN, JSON.stringify({ key: plan.key, n: plan.n, losing: plan.losing, left: plan.left, block: plan.block, marks: plan.marks, lastLoss: plan.lastLoss }));
    } catch (e) {}
  }

  /* ── the markets ───────────────────────────────────────────────────── */

  /* [symbol, name, submarket, decimals, seconds per tick, typical move, a recent
     price, share of ticks that repeat, Rise pays, Fall pays, digit commission
     (null: no digit contracts)] */
  var TABLE = [
    ["1HZ75V", "Volatility 75 (1s) Index", "random_index", 2, 1, 0.636, 4786.18, 0.009, 1.7826, 1.7824, 0.042],
    ["RDBULL", "Bull Market Index", "random_daily", 4, 2, 0.467, 1085.8468, 0, 1.8053, 1.8179, 0.042],
    ["R_25", "Volatility 25 Index", "random_index", 3, 2, 0.16, 2586.666, 0.002, 1.7826, 1.7825, 0.042],
    ["1HZ15V", "Volatility 15 (1s) Index", "random_index", 3, 1, 0.368, 13714.625, 0, 1.7825, 1.7825, 0.042],
    ["JD50", "Jump 50 Index", "jump_index", 2, 1, 6.04, 65355.05, 0, 1.8117, 1.8115, 0.042],
    ["1HZ90V", "Volatility 90 (1s) Index", "random_index", 3, 1, 3.62, 23451.284, 0, 1.7826, 1.7824, 0.042],
    ["JD10", "Jump 10 Index", "jump_index", 2, 1, 1.85, 93487.87, 0.004, 1.8116, 1.8116, 0.042],
    ["1HZ100V", "Volatility 100 (1s) Index", "random_index", 2, 1, 0.188, 1094.1, 0.024, 1.7987, 1.7984, 0.05],
    ["1HZ50V", "Volatility 50 (1s) Index", "random_index", 2, 1, 15.7, 185192.01, 0, 1.7826, 1.7825, 0.042],
    ["RDBEAR", "Bear Market Index", "random_daily", 4, 2, 0.395, 1013.1356, 0, 1.8161, 1.8071, 0.042],
    ["1HZ25V", "Volatility 25 (1s) Index", "random_index", 2, 1, 36.9, 861268.11, 0, 1.7826, 1.7825, 0.042],
    ["JD25", "Jump 25 Index", "jump_index", 2, 1, 6.64, 124206.85, 0.001, 1.8084, 1.8083, 0.042],
    ["JD75", "Jump 75 Index", "jump_index", 2, 1, 1.84, 6288.23, 0.003, 1.8117, 1.8115, 0.042],
    ["JD100", "Jump 100 Index", "jump_index", 2, 1, 0.0498, 107.81, 0.216, 1.852, 1.8517, 0.38],
    ["1HZ30V", "Volatility 30 (1s) Index", "random_index", 3, 1, 0.322, 6113.594, 0.001, 1.7826, 1.7825, 0.042],
    ["R_75", "Volatility 75 Index", "random_index", 4, 2, 8.88, 46640.2057, 0, 1.7827, 1.7824, 0.042],
    ["R_10", "Volatility 10 Index", "random_index", 3, 2, 0.127, 5048.886, 0.004, 1.7825, 1.7825, 0.042],
    ["1HZ10V", "Volatility 10 (1s) Index", "random_index", 2, 1, 0.166, 9530.67, 0.018, 1.8018, 1.8018, 0.05],
    ["R_100", "Volatility 100 Index", "random_index", 2, 2, 0.156, 616.14, 0.032, 1.8118, 1.8114, 0.05],
    ["R_50", "Volatility 50 Index", "random_index", 4, 2, 0.0105, 84.0652, 0.005, 1.7826, 1.7825, 0.042],
    ["stpRNG4", "Step Index 400", "step_index", 1, 1, 0.4, 8470.4, 0, 1.845, 1.845, null],
    ["stpRNG3", "Step Index 300", "step_index", 1, 1, 0.3, 13695.4, 0, 1.845, 1.845, null],
    ["stpRNG2", "Step Index 200", "step_index", 1, 1, 0.2, 10681.2, 0, 1.845, 1.845, null],
    ["stpRNG", "Step Index 100", "step_index", 1, 1, 0.1, 7262.1, 0, 1.845, 1.845, null],
    ["stpRNG5", "Step Index 500", "step_index", 1, 1, 0.5, 3688.5, 0, 1.845, 1.845, null],
  ];
  var MIN_STAKE = 0.35, MAX_PAYOUT = 10000, HISTORY = 1000;

  var markets = {}, order = [];
  TABLE.forEach(function (r) {
    var m = { sym: r[0], name: r[1], sub: r[2], dec: r[3], iv: r[4], sd: r[5], ties: r[7], call: r[8], put: r[9], c: r[10] };
    m.unit = Math.pow(10, -m.dec);
    m.price = r[6] * (1 + rnd(-0.002, 0.002));
    m.ticks = [];             // { epoch, quote }, the last HISTORY
    markets[m.sym] = m;
    order.push(m.sym);
  });
  function fix(m, v) { return Number(Number(v).toFixed(m.dec)); }
  function shown(m, v) { return Number(v).toFixed(m.dec); }
  function lastDigit(m, v) { var s = shown(m, v); return Number(s.charAt(s.length - 1)); }
  function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5) * 2; }

  /** One natural move: a repeat as often as the market repeats, a Step index's
   *  fixed step, otherwise a roughly gaussian move with the odd jump. */
  function move(m) {
    if (m.sub === "step_index") return Math.random() < 0.5 ? m.sd : -m.sd;
    if (Math.random() < m.ties) return 0;
    var d = gauss() * m.sd * 1.25;
    if (m.sub === "jump_index" && Math.random() < 0.002) d *= 15;
    d = Math.round(d / m.unit) * m.unit;
    return d === 0 ? (Math.random() < 0.5 ? m.unit : -m.unit) : d;
  }

  /** The nearest quote to `q` whose last digit is in `wanted`. */
  function withDigit(m, q, wanted) {
    var scaled = Math.round(q / m.unit), best = null;
    for (var delta = 0; delta <= 9 && best == null; delta++) {
      [delta, -delta].forEach(function (d) {
        if (best != null) return;
        var v = scaled + d;
        if (wanted.indexOf(((v % 10) + 10) % 10) >= 0) best = v;
      });
    }
    return fix(m, best * m.unit);
  }

  // A thousand ticks of past for every market, ending now.
  var now = Math.floor(Date.now() / 1000);
  order.forEach(function (s) {
    var m = markets[s], t = now - (now % m.iv), back = [], p = m.price;
    for (var i = 0; i < HISTORY; i++) { back.push({ epoch: t - i * m.iv, quote: fix(m, p) }); p -= move(m); }
    m.ticks = back.reverse();
    m.price = m.ticks[m.ticks.length - 1].quote;
  });

  /* ── what Deriv pays ───────────────────────────────────────────────── */

  function chance(ct, b) {
    switch (ct) {
      case "DIGITEVEN": case "DIGITODD": return 0.5;
      case "DIGITDIFF": return 0.9;
      case "DIGITMATCH": return 0.1;
      case "DIGITOVER": return (9 - b) / 10;
      case "DIGITUNDER": return b / 10;
    }
    return null;
  }
  /** { payout } or { error } — what a proposal or a buy at this stake gets. */
  function quote(m, ct, b, amount) {
    if (!(amount >= MIN_STAKE)) return { error: { code: "ContractBuyValidationError", code_args: ["0.35"], details: { field: "amount" }, message: "Please enter a stake amount that's at least 0.35.", subcode: "InvalidMinStake" } };
    var payout;
    if (ct === "CALL" || ct === "PUT") payout = round2(amount * (ct === "CALL" ? m.call : m.put));
    else {
      var p = chance(ct, b);
      if (p == null || m.c == null) return { error: { code: "ContractBuyValidationError", message: "Trading is not offered for this asset." } };
      if (p + m.c >= 1) return { error: { code: "ContractBuyValidationError", message: "This contract offers no return." } };
      payout = round2(amount / (p + m.c));
    }
    if (payout > MAX_PAYOUT) return { error: { code: "ContractBuyValidationError", message: "Your payout exceeds the maximum payout of 10000.00." } };
    return { payout: payout };
  }

  function longcode(m, ct, b) {
    switch (ct) {
      case "DIGITEVEN": return "Win payout if the last digit of " + m.name + " is even after 1 tick.";
      case "DIGITODD": return "Win payout if the last digit of " + m.name + " is odd after 1 tick.";
      case "DIGITDIFF": return "Win payout if the last digit of " + m.name + " is not " + b + " after 1 tick.";
      case "DIGITMATCH": return "Win payout if the last digit of " + m.name + " is " + b + " after 1 tick.";
      case "DIGITOVER": return "Win payout if the last digit of " + m.name + " is strictly higher than " + b + " after 1 tick.";
      case "DIGITUNDER": return "Win payout if the last digit of " + m.name + " is strictly lower than " + b + " after 1 tick.";
      case "CALL": return "Win payout if " + m.name + " after 1 tick is strictly higher than entry spot.";
      case "PUT": return "Win payout if " + m.name + " after 1 tick is strictly lower than entry spot.";
    }
    return "";
  }
  function shortcode(m, ct, b, payout, t) {
    return ct + "_" + m.sym + "_" + payout + "_" + t + "_1T_" + (ct === "CALL" || ct === "PUT" ? "S0P" : (b == null ? 0 : b)) + "_0";
  }

  /* ── the accounts ──────────────────────────────────────────────────── */

  /* No label or title of their own: the chip and the list give the real page's words
     (REAL / DEMO, Real account / Demo account, in the visitor's language) and, once the
     real session has answered, the accounts' own numbers (below). The demo trades the
     actual demo balance; the real one the card's balance. The badge says what it is. */
  var accounts = {
    real: { id: cfg.ids.real, type: "real", label: "", title: "", balance: round2(Number(cfg.real) || 0) },
    demo: { id: cfg.ids.demo, type: "demo", label: "", title: "", balance: round2(Number(cfg.demo) || 0) },
  };
  function byId(id) { return accounts.real.id === id ? accounts.real : accounts.demo.id === id ? accounts.demo : null; }
  var ACCOUNT_NO = 60000000 + Math.floor(Math.random() * 9000000);

  /* The running totals, kept at every buy and every settlement; a contract a
     reload leaves in flight is kept too and settled when the page is back (see
     below), so a stake is never banked without its payout or the other way. */
  function keepBalances() {
    var c = setup();
    c.real = accounts.real.balance;
    c.demo = accounts.demo.balance;
    save(c);
  }

  // The closed contracts, kept for this tab so the profit table survives a reload.
  var LEDGER = "shalo_ui_l";
  var ledger = (function () { try { return JSON.parse(sessionStorage.getItem(LEDGER) || "[]") || []; } catch (e) { return []; } })();
  function keepLedger() { try { sessionStorage.setItem(LEDGER, JSON.stringify(ledger.slice(-400))); } catch (e) {} }

  var nextContract = 15649000000 + Math.floor(Math.random() * 900000) * 10;
  var nextTxn = 29968000000 + Math.floor(Math.random() * 900000) * 10;

  /* Contracts in flight when the page went away. Deriv finishes them on its
     servers whatever the page does, and the profit table has them afterwards —
     so does this: each is settled as it was always going to be, at load. */
  var OPEN = "shalo_ui_o";
  var open = [];              // contracts waiting for their ticks
  function keepOpen() {
    try {
      sessionStorage.setItem(OPEN, JSON.stringify(open.filter(function (c) { return !c.sold; }).map(function (c) {
        return { account: c.acct.id, id: c.id, txn: c.txn, sym: c.sym, ct: c.ct, stake: c.stake, payout: c.payout, t: c.t, won: c.won, longcode: c.longcode, shortcode: c.shortcode };
      })));
    } catch (e) {}
  }
  (function () {
    var left = [];
    try { left = JSON.parse(sessionStorage.getItem(OPEN) || "[]") || []; } catch (e) {}
    left.forEach(function (c) {
      var a = byId(c.account);
      if (!a) return;
      if (c.won) a.balance = round2(a.balance + c.payout);
      nextTxn += 1000 + Math.floor(Math.random() * 9000);
      ledger.push({ account: c.account, buy_price: c.stake, contract_id: c.id, contract_type: c.ct, duration_type: "ticks", longcode: c.longcode,
        payout: c.payout, purchase_time: c.t, sell_price: c.won ? c.payout : 0, sell_time: c.t + 2, shortcode: c.shortcode,
        transaction_id: c.txn, underlying_symbol: c.sym });
    });
    if (left.length) { keepBalances(); keepLedger(); }
    try { sessionStorage.removeItem(OPEN); } catch (e) {}
  })();

  /* ── the socket ────────────────────────────────────────────────────── */

  var sockets = [];

  function latency(a, b) { return Math.round(rnd(a || 90, b || 280)); }

  function FakeSocket(url) {
    var self = this;
    this.url = String(url);
    this.acct = /\/demo\b/.test(this.url) ? accounts.demo : accounts.real;
    this.readyState = 0;
    this.ticks = {};          // symbol → { sub, req }
    this.subs = {};           // subscription id → { kind, sym?, req }
    this.balanceSub = null;
    sockets.push(this);
    setTimeout(function () {
      if (self.readyState !== 0) return;
      self.readyState = 1;
      if (self.onopen) self.onopen({});
    }, latency(140, 320));
  }
  FakeSocket.CONNECTING = 0; FakeSocket.OPEN = 1; FakeSocket.CLOSING = 2; FakeSocket.CLOSED = 3;
  FakeSocket.prototype.CONNECTING = 0; FakeSocket.prototype.OPEN = 1; FakeSocket.prototype.CLOSING = 2; FakeSocket.prototype.CLOSED = 3;

  FakeSocket.prototype.deliver = function (obj) {
    if (this.readyState !== 1 || !this.onmessage) return;
    this.onmessage({ data: JSON.stringify(obj) });
  };
  /** A reply, after the wire has taken its share of the time. */
  FakeSocket.prototype.reply = function (obj, wait) {
    var self = this;
    setTimeout(function () { self.deliver(obj); }, wait == null ? latency() : wait);
  };
  FakeSocket.prototype.close = function () {
    var self = this;
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.ticks = {}; this.subs = {}; this.balanceSub = null;
    sockets = sockets.filter(function (s) { return s !== self; });
    setTimeout(function () { if (self.onclose) self.onclose({ code: 1000 }); }, 0);
  };
  FakeSocket.prototype.addEventListener = function (type, fn) { this["on" + type] = fn; };

  FakeSocket.prototype.err = function (req, type, error) {
    this.reply({ echo_req: req, error: error, msg_type: type, req_id: req.req_id });
  };

  FakeSocket.prototype.send = function (raw) {
    var req; try { req = JSON.parse(raw); } catch (e) { return; }
    if (this.readyState !== 1) return;
    if (req.ping) return this.reply({ echo_req: req, msg_type: "ping", ping: "pong", req_id: req.req_id });
    if (req.balance) return this.balance(req);
    if (req.active_symbols) return this.symbols(req);
    if (req.ticks_history) return this.history(req);
    if (req.ticks) return this.tickStream(req);
    if (req.forget_all) return this.forgetAll(req);
    if (req.forget) return this.forget(req);
    if (req.proposal) return this.proposal(req);
    if (req.buy) return this.buy(req);
    if (req.profit_table) return this.profitTable(req);
    if (req.portfolio) return this.portfolio(req);
    this.err(req, "error", { code: "UnrecognisedRequest", message: "Unrecognised request." });
  };

  FakeSocket.prototype.balanceMsg = function () {
    var b = this.balanceSub;
    return { balance: { balance: this.acct.balance, currency: "USD", id: b ? b.id : uuid(), loginid: this.acct.id },
      echo_req: b ? b.req : { balance: 1 }, msg_type: "balance", req_id: b ? b.req.req_id : undefined, subscription: b ? { id: b.id } : undefined };
  };
  FakeSocket.prototype.balance = function (req) {
    if (req.subscribe) this.balanceSub = { id: uuid(), req: req };
    var m = this.balanceMsg();
    if (!req.subscribe) { m.echo_req = req; m.req_id = req.req_id; delete m.subscription; }
    this.reply(m);
  };
  function pushBalance(acct) {
    sockets.forEach(function (s) { if (s.acct === acct && s.balanceSub) s.deliver(s.balanceMsg()); });
  }

  FakeSocket.prototype.symbols = function (req) {
    var types = [].concat(req.contract_type || []);
    var digit = types.some(function (t) { return /^DIGIT/.test(t); });
    var list = order.filter(function (s) { return !digit || markets[s].c != null; }).map(function (s) {
      var m = markets[s];
      return { exchange_is_open: 1, is_trading_suspended: 0, market: "synthetic_index", pip_size: m.unit, subgroup: "synthetics",
        submarket: m.sub, trade_count: 100000 + (s.length * 7919) % 900000, underlying_symbol: s, underlying_symbol_name: m.name, underlying_symbol_type: "stockindex" };
    });
    this.reply({ active_symbols: list, echo_req: req, msg_type: "active_symbols", req_id: req.req_id });
  };

  FakeSocket.prototype.history = function (req) {
    var m = markets[req.ticks_history];
    if (!m) return this.err(req, "history", { code: "InvalidSymbol", message: "Symbol " + req.ticks_history + " is invalid." });
    var n = Math.max(1, Math.min(HISTORY, Number(req.count) || 500));
    var t = m.ticks.slice(-n);
    this.reply({ echo_req: req, history: { prices: t.map(function (x) { return x.quote; }), times: t.map(function (x) { return x.epoch; }) },
      msg_type: "history", pip_size: m.dec, req_id: req.req_id });
  };

  function tickMsg(m, x, s) {
    return { echo_req: s.req, msg_type: "tick", req_id: s.req.req_id, subscription: { id: s.id },
      tick: { ask: x.quote, bid: x.quote, epoch: x.epoch, id: s.id, pip_size: m.dec, quote: x.quote, symbol: m.sym } };
  }
  FakeSocket.prototype.tickStream = function (req) {
    var m = markets[req.ticks];
    if (!m) return this.err(req, "tick", { code: "InvalidSymbol", message: "Symbol " + req.ticks + " is invalid." });
    if (this.ticks[m.sym]) return this.err(req, "tick", { code: "AlreadySubscribed", message: "You are already subscribed to " + m.sym + "." });
    var s = { id: uuid(), req: req, kind: "ticks", sym: m.sym };
    if (req.subscribe) { this.ticks[m.sym] = s; this.subs[s.id] = s; }
    this.reply(tickMsg(m, m.ticks[m.ticks.length - 1], s));
  };
  FakeSocket.prototype.forget = function (req) {
    var s = this.subs[req.forget];
    if (s) { delete this.subs[req.forget]; if (s.kind === "ticks") delete this.ticks[s.sym]; }
    this.reply({ echo_req: req, forget: s ? 1 : 0, msg_type: "forget", req_id: req.req_id });
  };
  FakeSocket.prototype.forgetAll = function (req) {
    var self = this, kinds = [].concat(req.forget_all), gone = [];
    Object.keys(this.subs).forEach(function (id) {
      var s = self.subs[id];
      if (kinds.indexOf(s.kind) >= 0) { gone.push(id); delete self.subs[id]; if (s.kind === "ticks") delete self.ticks[s.sym]; }
    });
    this.reply({ echo_req: req, forget_all: gone, msg_type: "forget_all", req_id: req.req_id });
  };

  FakeSocket.prototype.proposal = function (req) {
    var m = markets[req.underlying_symbol];
    if (!m) return this.err(req, "proposal", { code: "InvalidSymbol", message: "Symbol " + req.underlying_symbol + " is invalid." });
    var b = req.barrier == null ? null : Number(req.barrier);
    var q = quote(m, req.contract_type, b, Number(req.amount));
    if (q.error) return this.err(req, "proposal", q.error);
    var last = m.ticks[m.ticks.length - 1];
    this.reply({ echo_req: req, msg_type: "proposal", req_id: req.req_id, subscription: undefined,
      proposal: { ask_price: Number(req.amount), date_expiry: last.epoch + m.iv + 1, date_start: last.epoch, display_value: Number(req.amount).toFixed(2),
        id: uuid(), longcode: longcode(m, req.contract_type, b), payout: q.payout, spot: last.quote, spot_time: last.epoch } });
  };

  /** One contract's message, at whatever stage it has reached. */
  function poc(c) {
    var m = markets[c.sym], digit = /^DIGIT/.test(c.ct);
    var p = {
      account_id: ACCOUNT_NO, barrier_count: 1, bid_price: "0.00", buy_price: c.stake.toFixed(2), contract_id: c.id, contract_type: c.ct, currency: "USD",
      current_spot: shown(m, c.spotNow), current_spot_time: c.spotTime, date_expiry: c.t + 1, date_settlement: c.t + 1, date_start: c.t, expiry_time: c.t + 1,
      id: c.sub, is_expired: 0, is_intraday: 1, is_path_dependent: 0, is_settleable: 0, is_sold: 0, is_valid_to_cancel: 0, is_valid_to_sell: 0,
      longcode: c.longcode, payout: c.payout.toFixed(2), profit: (round2(c.payout * 0.84) - c.stake).toFixed(2), profit_percentage: 0,
      purchase_time: c.t, shortcode: c.shortcode, status: "open", tick_count: 1, tick_stream: [], transaction_ids: { buy: c.txn }, underlying_symbol: c.sym,
    };
    if (digit && c.barrier != null) p.barrier = String(c.barrier);
    if (c.entry != null) {
      p.entry_spot = shown(m, c.entry); p.entry_spot_time = c.entryTime;
      if (!digit) p.barrier = shown(m, c.entry);
    }
    if (c.exit == null) {
      p.validation_error = "Waiting for entry tick."; p.validation_error_code = "EntryTickMissing"; p.validation_error_code_args = null;
      p.profit_percentage = Math.round(Number(p.profit) / c.stake * 10000) / 100;
      return p;
    }
    var profit = c.won ? round2(c.payout - c.stake) : -c.stake;
    p.exit_spot = shown(m, c.exit); p.exit_spot_time = c.exitTime;
    p.current_spot = shown(m, c.exit); p.current_spot_time = c.exitTime;
    p.is_expired = 1; p.is_settleable = 1; p.is_valid_to_sell = c.sold ? 0 : 1;
    p.bid_price = (c.won ? c.payout : 0).toFixed(2);
    p.profit = profit.toFixed(2);
    p.profit_percentage = Math.round(profit / c.stake * 10000) / 100;
    p.tick_stream = (digit ? [c.exitTime] : [c.entryTime, c.exitTime]).map(function (e, i) {
      var v = digit || i ? c.exit : c.entry;
      return { epoch: e, tick: v, tick_display_value: shown(m, v) };
    });
    if (c.sold) {
      p.is_sold = 1; p.sell_price = (c.won ? c.payout : 0).toFixed(2); p.sell_time = c.soldAt;
      p.status = c.won ? "won" : "lost"; p.transaction_ids = { buy: c.txn, sell: c.sellTxn };
      p.validation_error = "This contract has been sold."; p.validation_error_code = "ContractAlreadySold"; p.validation_error_code_args = null;
    }
    return p;
  }
  function pocMsg(c) {
    return { echo_req: { contract_id: String(c.id), proposal_open_contract: 1, req_id: c.req.req_id, subscribe: 1 },
      msg_type: "proposal_open_contract", proposal_open_contract: poc(c), req_id: c.req.req_id, subscription: { id: c.sub } };
  }
  FakeSocket.prototype.pushContract = function (c) {
    if (!c.listening || this.readyState !== 1) return;
    this.deliver(pocMsg(c));
  };

  /* A buy executes when it reaches the server (half the round trip) and is
     answered at the end of it — ~0.3-0.4 s in all, as measured. The contract
     waits for the first tick after that second, like Deriv's, and nothing about
     it is sent before its buy reply. */
  FakeSocket.prototype.buy = function (req) {
    var self = this, prm = req.parameters || {};
    var arrive = latency(130, 190), back = latency(160, 230);
    setTimeout(function () {
      if (self.readyState !== 1) return;
      var m = markets[prm.underlying_symbol];
      if (!m) return self.err(req, "buy", { code: "InvalidSymbol", message: "Symbol " + prm.underlying_symbol + " is invalid." });
      var amount = Number(prm.amount), b = prm.barrier == null ? null : Number(prm.barrier);
      var q = quote(m, prm.contract_type, b, amount);
      if (q.error) return self.err(req, "buy", q.error);
      if (Number(req.price) < amount) return self.err(req, "buy", { code: "ContractBuyValidationError", message: "Contract's stake amount is more than the maximum purchase price." });
      var acct = self.acct;
      if (amount > acct.balance + 1e-9) {
        return self.err(req, "buy", { code: "InsufficientBalance", message: "Your account balance (USD " + acct.balance.toFixed(2) + ") is insufficient to buy this contract (USD " + amount.toFixed(2) + ")." });
      }
      var t = Math.floor(Date.now() / 1000), last = m.ticks[m.ticks.length - 1];
      nextContract += 1000 + Math.floor(Math.random() * 9000);
      nextTxn += 1000 + Math.floor(Math.random() * 9000);
      var c = {
        id: nextContract, txn: nextTxn, sub: uuid(), req: req, sock: self, acct: acct,
        sym: m.sym, ct: prm.contract_type, barrier: b, stake: amount, payout: q.payout, t: t,
        longcode: longcode(m, prm.contract_type, b), shortcode: shortcode(m, prm.contract_type, b, q.payout, t),
        spotNow: last.quote, spotTime: last.epoch, entry: null, exit: null,
        won: !planNow().loses(chanceOf(prm.contract_type, b)),   // decided at the buy, at this contract's odds
        listening: !!req.subscribe, sold: false, replyAt: Date.now() + back,
      };
      keepPlan();
      acct.balance = round2(acct.balance - amount);
      open.push(c);
      keepBalances();
      keepOpen();
      self.reply({ buy: { balance_after: acct.balance, buy_price: amount, contract_id: c.id, longcode: c.longcode, payout: c.payout, purchase_time: t,
        shortcode: c.shortcode, start_time: t, transaction_id: c.txn }, echo_req: req, msg_type: "buy", req_id: req.req_id,
        subscription: req.subscribe ? { id: c.sub } : undefined }, back);
      setTimeout(function () { pushBalance(acct); }, back + 5);
      setTimeout(function () { if (c.exit == null) self.pushContract(c); }, back + 13);
    }, arrive);
  };
  /** After its buy reply, never before. */
  function afterReply(c, ms) { return Math.max(ms, c.replyAt + 20 - Date.now()); }

  FakeSocket.prototype.profitTable = function (req) {
    var acct = this.acct, types = req.contract_type ? [].concat(req.contract_type) : null;
    var from = Number(req.date_from || 0), to = req.date_to ? Number(req.date_to) : Infinity;
    var rows = ledger.filter(function (x) {
      return x.account === acct.id && x.purchase_time >= from && x.purchase_time <= to && (!types || types.indexOf(x.contract_type) >= 0);
    }).sort(function (a, b) { return req.sort === "ASC" ? a.purchase_time - b.purchase_time : b.purchase_time - a.purchase_time; });
    rows = rows.slice(Number(req.offset) || 0, (Number(req.offset) || 0) + (Number(req.limit) || 50)).map(function (x) {
      var o = Object.assign({}, x); delete o.account; return o;
    });
    this.reply({ echo_req: req, msg_type: "profit_table", profit_table: { count: rows.length, transactions: rows }, req_id: req.req_id });
  };

  FakeSocket.prototype.portfolio = function (req) {
    var acct = this.acct;
    var list = open.filter(function (c) { return c.acct === acct && !c.sold; }).map(function (c) {
      return { app_id: 1, buy_price: c.stake, contract_id: c.id, contract_type: c.ct, currency: "USD", date_start: c.t, expiry_time: c.t + 1,
        longcode: c.longcode, payout: c.payout, purchase_time: c.t, shortcode: c.shortcode, symbol: c.sym, transaction_id: c.txn, underlying_symbol: c.sym };
    });
    this.reply({ echo_req: req, msg_type: "portfolio", portfolio: { contracts: list }, req_id: req.req_id });
  };

  /* ── the clock: every market ticks on its own second ───────────────── */

  /** The next quote for a market: natural, unless a contract is waiting on it —
   *  then the one that settles it the way the plan says. */
  function nextQuote(m, epoch) {
    var q = fix(m, m.price + move(m));
    var waiting = open.filter(function (c) { return c.sym === m.sym && c.exit == null && epoch > c.t; });
    var c = waiting[0];
    if (!c) return q;
    var digit = /^DIGIT/.test(c.ct);
    if (digit) {
      var win = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter(function (d) { return wins(c.ct, c.barrier, d); });
      var want = c.won ? win : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter(function (d) { return win.indexOf(d) < 0; });
      return withDigit(m, q, want);
    }
    if (c.entry == null) return q;                       // Rise/Fall: this tick is the entry
    var up = (c.ct === "CALL") === c.won;
    var step = m.sub === "step_index" ? m.sd : Math.max(m.unit, Math.abs(q - c.entry) || m.unit);
    return fix(m, c.entry + (up ? step : -step));
  }
  function wins(ct, b, d) {
    switch (ct) {
      case "DIGITEVEN": return d % 2 === 0;
      case "DIGITODD": return d % 2 === 1;
      case "DIGITDIFF": return d !== b;
      case "DIGITMATCH": return d === b;
      case "DIGITOVER": return d > b;
      case "DIGITUNDER": return d < b;
    }
    return false;
  }

  function tick(m, epoch) {
    var q = nextQuote(m, epoch);
    m.price = q;
    var x = { epoch: epoch, quote: q };
    m.ticks.push(x);
    if (m.ticks.length > HISTORY) m.ticks.splice(0, m.ticks.length - HISTORY);
    sockets.forEach(function (s) { var sub = s.ticks[m.sym]; if (sub) s.deliver(tickMsg(m, x, sub)); });

    open.filter(function (c) { return c.sym === m.sym && c.exit == null && epoch > c.t; }).forEach(function (c) {
      var digit = /^DIGIT/.test(c.ct);
      if (c.entry == null) {
        c.entry = q; c.entryTime = epoch;
        if (!digit) { c.spotNow = q; c.spotTime = epoch; setTimeout(function () { c.sock.pushContract(c); }, afterReply(c, latency(60, 110))); return; }
      }
      c.exit = q; c.exitTime = epoch;
      decided(c);
    });
  }

  /** Decided at its exit tick (sent twice, as Deriv does); booked as sold about
   *  a second later, with the balance first, as Deriv does. */
  function decided(c) {
    var s = c.sock, first = afterReply(c, latency(70, 110));
    setTimeout(function () { s.pushContract(c); }, first);
    setTimeout(function () { s.pushContract(c); }, first + 4);
    setTimeout(function () {
      c.sold = true;
      c.soldAt = Math.floor(Date.now() / 1000);
      nextTxn += 1000 + Math.floor(Math.random() * 9000);
      c.sellTxn = nextTxn;
      if (c.won) c.acct.balance = round2(c.acct.balance + c.payout);
      keepBalances();
      ledger.push({ account: c.acct.id, buy_price: c.stake, contract_id: c.id, contract_type: c.ct, duration_type: "ticks", longcode: c.longcode,
        payout: c.payout, purchase_time: c.t, sell_price: c.won ? c.payout : 0, sell_time: c.soldAt, shortcode: c.shortcode,
        transaction_id: c.txn, underlying_symbol: c.sym });
      keepLedger();
      open = open.filter(function (x) { return x !== c; });
      keepOpen();
      pushBalance(c.acct);
      setTimeout(function () { s.pushContract(c); s.pushContract(c); }, latency(120, 160));
    }, first + latency(780, 1150));
  }

  var lastEpoch = now;
  function clock() {
    var e = Math.floor(Date.now() / 1000);
    // A tab the browser froze catches up in one go rather than skipping time.
    for (var t = Math.max(lastEpoch + 1, e - 300); t <= e; t++) {
      order.forEach(function (s) { var m = markets[s]; if (t % m.iv === 0) tick(m, t); });
    }
    lastEpoch = e;
    setTimeout(clock, 1000 - (Date.now() % 1000) + 8);
  }
  setTimeout(clock, 1000 - (Date.now() % 1000) + 8);

  /* ── our own server's answers ──────────────────────────────────────── */

  function wsUrl(a) { return "wss://api.derivws.com/trading/v1/options/ws/" + a.type + "?otp=" + digits(6) + uuid().replace(/-/g, "").slice(0, 26); }
  function sessionFor(withWs) {
    return {
      connected: true, expiresAt: Date.now() + 29 * 24 * 3600 * 1000, renewSoon: false,
      accounts: [accounts.real, accounts.demo].map(function (a) {
        var o = { id: a.id, type: a.type, currency: "USD", balance: a.balance, status: "active", label: a.label, title: a.title };
        if (withWs) o.ws = wsUrl(a);
        return o;
      }),
    };
  }
  var realFetch = global.fetch ? global.fetch.bind(global) : null;

  /* The demo balance is the actual one. At every load it is read from our own
     server with the real session (the fetch kept above, before it is swapped)
     and the first answer this page gives waits for it, up to a few seconds.
     Not while a run is still going on that account: a reload mid-run must not
     move the money under the bot. Not connected, or Deriv not answering: the
     last actual balance stays. */
  function savedRun() {
    try { return JSON.parse(sessionStorage.getItem("shalo_bot_run") || "null"); }   // the bot's own key, renamed into sim.*
    catch (e) { return null; }
  }
  function demoBusy() { var r = savedRun(); return !!(r && r.account === accounts.demo.id); }
  /** The accounts' own numbers. Not while a run is going (it trades under the numbers it
   *  started with); the trades this tab has on record move to the new numbers with them. */
  function adoptIds(realId, demoId) {
    var was = { real: accounts.real.id, demo: accounts.demo.id };
    if (realId) accounts.real.id = String(realId);
    if (demoId) accounts.demo.id = String(demoId);
    if (was.real === accounts.real.id && was.demo === accounts.demo.id) return;
    ledger.forEach(function (x) {
      if (x.account === was.real) x.account = accounts.real.id;
      else if (x.account === was.demo) x.account = accounts.demo.id;
    });
    keepLedger();
    var c = setup();
    c.ids = { real: accounts.real.id, demo: accounts.demo.id };
    save(c);
  }
  var demoReady = (function () {
    if (!realFetch) return Promise.resolve();
    var read = realFetch("/api/deriv/session", { credentials: "same-origin", cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (s) {
        var list = (s && s.connected && s.accounts) || [];
        var pick = function (type) {
          return list.filter(function (a) { return a.type === type && a.status === "active"; })[0] || list.filter(function (a) { return a.type === type; })[0];
        };
        var real = pick("real"), demo = pick("demo");
        if (!savedRun()) adoptIds(real && real.id, demo && demo.id);   // numbers only: the real balance stays the card's
        var b = demo ? Number(demo.balance) : NaN;
        if (!isFinite(b) || b < 0 || demoBusy()) return;
        accounts.demo.balance = round2(b);
        keepBalances();
      })
      .catch(function () {});
    return Promise.race([read, new Promise(function (resolve) { setTimeout(resolve, 4000); })]);
  })();

  global.fetch = function (input, init) {
    var u;
    try { u = new URL(typeof input === "string" ? input : input.url, global.location.href); } catch (e) { u = null; }
    if (!u || u.origin !== global.location.origin || u.pathname.indexOf("/api/deriv/") !== 0) return realFetch(input, init);
    var body = {}, path = u.pathname;
    try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) {}
    return demoReady.then(function () {
      var out;
      if (path === "/api/deriv/session") out = sessionFor(u.searchParams.get("otp") === "1");
      else if (path === "/api/deriv/otp") { var a = byId(body.account); out = a ? { url: wsUrl(a) } : { error: "unknown_account" }; }
      else out = { ok: true };
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve(new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } }));
        }, latency(110, 260));
      });
    });
  };
  global.WebSocket = FakeSocket;

  /* ── the card: three clicks on the green dot in the balance chip ───── */

  function card() {
    var c = setup();
    /* Two whole numbers, from and to: each streak, gap or ten draws its own from between them. */
    function pair(id, lo, hi) {
      var f = function (s) { return '<input class="sim-i" id="' + id + s + '" type="number" min="' + lo + '" max="' + hi + '" step="1" inputmode="numeric" />'; };
      return '<span class="sim-pair">' + f("a") + '<span class="sim-to">to</span>' + f("b") + "</span>";
    }
    var wrap = document.createElement("div");
    wrap.className = "sim-setup";
    wrap.hidden = true;
    wrap.setAttribute("data-i18n-skip", "");
    wrap.innerHTML =
      '<div class="sim-card" role="dialog" aria-modal="true" aria-labelledby="simT">' +
        '<div class="sim-head"><div><p class="sim-k">Practice — no money, no Deriv</p><h2 class="sim-t" id="simT">Set up the simulation</h2></div>' +
        '<button class="btn btn-line sim-close" type="button" data-sim-close>Close</button></div>' +
        '<div class="sim-body">' +
          '<label class="sim-f"><span class="sim-fk">Simulation account balance (USD)</span><span class="sim-with"><input class="sim-i" id="simReal" type="number" min="0" step="0.01" inputmode="decimal" />' +
            '<button class="btn btn-line sim-rand" type="button" data-rand="simReal">Random</button></span></label>' +
          '<div class="sim-f"><span class="sim-fk">Losses</span><div class="sim-seg" id="simMode" role="radiogroup" aria-label="Losses">' +
            '<button class="sim-sb" type="button" role="radio" data-mode="none">None</button>' +
            '<button class="sim-sb" type="button" role="radio" data-mode="consecutive">In a row</button>' +
            '<button class="sim-sb" type="button" role="radio" data-mode="random">Random</button></div>' +
            '<p class="sim-hint" data-for-not="none">For a 50/50 trade (Even/Odd, Rise/Fall). Other contracts keep their own odds: Differs and Over 0 lose about a fifth as often and seldom twice running; Matches loses most trades.</p></div>' +
          '<div class="sim-f" data-for="consecutive"><span class="sim-fk">Losses in a row</span>' + pair("simS", 1, 10) + '</div>' +
          '<div class="sim-f" data-for="consecutive"><span class="sim-fk">Wins before each streak</span>' + pair("simG", 1, 100) + '</div>' +
          '<div class="sim-f" data-for="random"><span class="sim-fk">Losses in every 10 trades</span>' + pair("simR", 0, 10) + '</div>' +
          '<div class="sim-f sim-row" data-for="random"><span class="sim-fk">Never two in a row</span><button class="sim-tog" id="simApart" type="button" role="switch" aria-checked="true" aria-label="Never two in a row"><i></i></button></div>' +
          '<div class="sim-f sim-row"><span class="sim-fk">First trade of each run loses</span><button class="sim-tog" id="simFirst" type="button" role="switch" aria-checked="false" aria-label="First trade of each run loses"><i></i></button></div>' +
        '</div>' +
        '<p class="sim-say" id="simSay"></p>' +
        '<button class="btn btn-blue btn-lg sim-go" id="simGo" type="button">Start simulation</button>' +
        '<p class="sim-note">Everything past this card is the trading page itself — every market, every trade type, the scan, the martingale and the bot, priced and paced the way Deriv prices and paces them, down to a stake the balance cannot cover being refused. Only the money and the outcomes are arranged.</p>' +
      "</div>";
    document.body.appendChild(wrap);
    var $ = function (id) { return document.getElementById(id); };
    var mode = c.mode;

    function on(id) { return $(id).getAttribute("aria-checked") === "true"; }
    function readPair(id, lo, hi, dflt) { return range([Number($(id + "a").value), Number($(id + "b").value)], lo, hi, dflt); }
    function writePair(id, r) { $(id + "a").value = r[0]; $(id + "b").value = r[1]; }
    function span(r) { return r[0] === r[1] ? String(r[0]) : r[0] + " to " + r[1]; }
    function count(r, one, many) { return span(r) + " " + (r[1] === 1 ? one : many); }
    function describe() {
      var first = on("simFirst");
      var opener = first ? " The first trade of each run loses." : " The first trade of each run wins.";
      if (mode === "none") return first ? "The first trade of each run loses; every other trade wins." : "Every trade wins.";
      if (mode === "consecutive") {
        var s = readPair("simS", 1, 10, [1, 3]), g = readPair("simG", 1, 100, [3, 10]);
        return (first ? "Each run opens with " + count(s, "loss", "losses in a row") + ", then " + count(g, "win", "wins") + ", then another streak — "
          : "Each run: " + count(g, "win", "wins") + ", then " + count(s, "loss", "losses in a row") + ", and again — ") +
          "every streak and every gap draws its own number from the range, until the run ends.";
      }
      var r = readPair("simR", 0, 10, [1, 3]), apart = on("simApart");
      if (r[1] === 0) return "Every trade wins." + (first ? " Only the first trade of each run loses." : "");
      return "In every 10 trades, " + count(r, "loses", "lose") + " at random places" +
        (apart ? ", never two in a row" + (r[1] > 5 ? " (five is the most that fits)" : "") : ", and they can come together") + "." + opener;
    }
    function refresh() {
      Array.prototype.forEach.call($("simMode").children, function (b) {
        var on = b.getAttribute("data-mode") === mode;
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-checked", String(on));
      });
      Array.prototype.forEach.call(wrap.querySelectorAll("[data-for]"), function (f) { f.hidden = f.getAttribute("data-for") !== mode; });
      Array.prototype.forEach.call(wrap.querySelectorAll("[data-for-not]"), function (f) { f.hidden = f.getAttribute("data-for-not") === mode; });
      $("simSay").textContent = describe();
    }
    function fillIn() {
      var c2 = setup();
      $("simReal").value = Number(c2.real).toFixed(2);
      writePair("simS", c2.streak); writePair("simG", c2.gap); writePair("simR", c2.per10);
      mode = c2.mode;
      $("simApart").setAttribute("aria-checked", String(c2.apart !== false));
      $("simFirst").setAttribute("aria-checked", String(!!c2.firstLoss));
      refresh();
    }
    $("simMode").addEventListener("click", function (e) { var b = e.target.closest(".sim-sb"); if (b) { mode = b.getAttribute("data-mode"); refresh(); } });
    ["simFirst", "simApart"].forEach(function (id) {
      $(id).addEventListener("click", function () { this.setAttribute("aria-checked", String(!on(id))); refresh(); });
    });
    Array.prototype.forEach.call(wrap.querySelectorAll(".sim-pair input"), function (i) { i.addEventListener("input", refresh); });
    // A balance that looks like somebody's actual account, not a round thousand.
    Array.prototype.forEach.call(wrap.querySelectorAll("[data-rand]"), function (b) {
      b.addEventListener("click", function () {
        $(b.getAttribute("data-rand")).value = (50 + Math.floor(Math.random() * 24951) + Math.floor(Math.random() * 100) / 100).toFixed(2);
      });
    });
    function close() { wrap.hidden = true; }
    wrap.addEventListener("click", function (e) { if (e.target === wrap || e.target.closest("[data-sim-close]")) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !wrap.hidden) close(); });
    $("simGo").addEventListener("click", function () {
      var real = Number($("simReal").value);
      if (!isFinite(real) || real < 0) { $("simSay").textContent = "Give the account a balance to start with."; return; }
      var c2 = setup();
      c2.real = round2(real); c2.mode = mode;
      c2.streak = readPair("simS", 1, 10, [1, 3]); c2.gap = readPair("simG", 1, 100, [3, 10]); c2.per10 = readPair("simR", 0, 10, [1, 3]);
      c2.apart = on("simApart");
      c2.firstLoss = on("simFirst");
      delete c2.count;
      save(c2);
      try { sessionStorage.removeItem(LEDGER); sessionStorage.removeItem(PLAN); } catch (e) {}
      global.location.reload();
    });

    function openCard() {
      var r = global.ShaloBot && global.ShaloBot.run();
      if (r && r.active) return;           // a running session keeps its world
      fillIn();
      wrap.hidden = false;
    }
    /* Three clicks on the chip's green dot. Its clicks are its own here: they
       do not open the account list. */
    var dot = document.getElementById("acctLive");
    if (dot) {
      dot.addEventListener("click", function (e) { e.stopPropagation(); });
      if (global.ShaloTaps) global.ShaloTaps(dot, 3, openCard);   // counted in door.js, iPhones included
    }

    /* The badge: what the page is — in the header beside the name where there
       is room, on a phone pinned under the header (sim.css), always in sight. */
    function badge(cls) {
      var el = document.createElement("span");
      el.className = "sim-badge " + cls;
      el.setAttribute("data-i18n-skip", "");
      el.innerHTML = '<i aria-hidden="true"></i><b>Simulation</b><span>not real money</span>';
      return el;
    }
    var brand = document.querySelector(".tnav .brand"), main = document.getElementById("tmain");
    if (brand) brand.parentNode.insertBefore(badge("sim-badge--nav"), brand.nextSibling);
    if (main) main.insertBefore(badge("sim-badge--top"), main.firstChild);
    // How far down the phone badge pins: just under the fixed header, whatever its height.
    var nav = document.querySelector(".tnav");
    function navHeight() { if (nav) document.documentElement.style.setProperty("--sim-nav-h", nav.offsetHeight + "px"); }
    navHeight();
    global.addEventListener("resize", navHeight);

  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", card);
  else card();
})(window);
