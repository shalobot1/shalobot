/**
 * SHALOBOT — the Smart Scan bot, Even/Odd. A full automation:
 *
 *   Scan & start → a popup scans every Even/Odd market live (progress bar),
 *   settles on the ONE best market and side (animated tick), and Start trading
 *   hands it to the bot. The bot then trades one 1-tick contract at a time —
 *   re-scanning before every trade — until take profit, stop loss, Stop, or a
 *   balance that cannot cover the next stake. Take profit ends in a
 *   congratulations popup.
 *
 * THE SCAN, on the account's own socket (no extra connection; Deriv allows
 * five per person): which markets offer Even/Odd now; what a win pays on each
 * at this account's stake (app markup and rounding included); and a tick
 * stream per market keeping its last WINDOW last digits, each written with
 * the decimals Deriv gives so a trailing zero is a real 0.
 *
 * THE PICK: among the markets that pay the most, the market and side whose
 * last WINDOW ticks come closest to 100% of one side; a tie goes to the
 * faster market. This is the owner's rule. Backtested on 400,000 real ticks
 * it won ~50% — the digits are random — so it is shown as a recent pattern,
 * never as odds.
 *
 * THE RUN. Martingale: after a loss the stake is multiplied (default x3.1),
 * after a win it returns to the starting stake. Stop loss stops the run once
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

  var WINDOW = 10;
  var TIER = 0.004;
  var DEFAULTS = { stake: 1, tp: 1000, sl: 1000, mult: 3.1 };
  var SETTINGS_KEY = "shalo_bot_settings";
  var FALLBACK_MIN = 0.35;
  var LOG_ROWS = 2000;

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
  var sideName = function (s) { return s === "even" ? T("Even") : T("Odd"); };

  /** A contract's type and market, from its own fields, else its short code. */
  function kindOf(x) {
    if (x.contract_type) return String(x.contract_type);
    var m = /^(DIGITEVEN|DIGITODD)_/.exec(String(x.shortcode || ""));
    return m ? m[1] : "";
  }
  function symOf(x) {
    if (x.underlying_symbol) return String(x.underlying_symbol);
    var sc = String(x.shortcode || "").replace(/^DIGIT(EVEN|ODD)_/, "");
    var known = hub.order.filter(function (s) { return sc.indexOf(s + "_") === 0; }).sort(function (a, b) { return b.length - a.length; })[0];
    return known || sc.split("_")[0];
  }

  /* ── the live scan ─────────────────────────────────────────────────── */

  var hub = {
    account: null, gen: 0, ready: false, starting: null,
    currency: "USD", minStake: FALLBACK_MIN,
    markets: {}, order: [], subs: [], pricedAt: 0, pricedStake: 0,
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
  function hubStart(accountId, stake, prog) {
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

      var a = await D.askOn(accountId, { active_symbols: "brief", contract_type: ["DIGITEVEN"] });
      if (a.error) throw new Error(a.error.message);
      var list = (a.active_symbols || []).filter(function (x) { return x.exchange_is_open && !x.is_trading_suspended; });
      if (!list.length) throw new Error(T("No Even/Odd market is open right now."));
      if (gen !== hub.gen) return;

      // Deriv's own refusal names the smallest stake for this currency.
      var probe = await D.askOn(accountId, { proposal: 1, amount: 0.01, basis: "stake", currency: hub.currency, underlying_symbol: list[0].underlying_symbol, contract_type: "DIGITEVEN", duration: 1, duration_unit: "t" });
      var arg = probe.error && probe.error.code_args && Number(probe.error.code_args[0]);
      hub.minStake = isFinite(arg) && arg > 0 ? arg : FALLBACK_MIN;

      hub.markets = {}; hub.order = [];
      list.forEach(function (x) {
        hub.order.push(x.underlying_symbol);
        hub.markets[x.underlying_symbol] = { sym: x.underlying_symbol, name: x.underlying_symbol_name, digits: [], times: [], ratio: null, at: 0 };
      });

      var total = hub.order.length * 2, done = 0;
      prog(0, total, fill(T("Reading the last ticks of {n} markets…"), { n: hub.order.length }));
      await Promise.all(hub.order.map(async function (sym) {
        var h = await D.askOn(accountId, { ticks_history: sym, end: "latest", count: 50, style: "ticks" });
        var m = hub.markets[sym];
        if (!h.error && h.history) {
          var dec = Number(h.pip_size);
          m.dec = dec;
          m.digits = h.history.prices.map(function (q) { return lastDigit(q, dec); }).slice(-WINDOW);
          m.times = h.history.times.slice(-50);
          m.at = Date.now();
        }
        prog(++done, total);
      }));
      if (gen !== hub.gen) return;
      prog(done, total, fill(T("Pricing Even and Odd on {n} markets…"), { n: hub.order.length }));
      await price(accountId, stake, gen, function () { prog(++done, total); });
      if (gen !== hub.gen) return;

      hub.order.forEach(function (sym) {
        var s = D.streamOn(accountId, { ticks: sym, subscribe: 1 }, function (msg) {
          if (gen !== hub.gen) return;
          if (msg.closed) return hubRecover(accountId, gen);
          if (msg.error || !msg.tick) return;
          var m = hub.markets[sym];
          m.dec = Number(msg.tick.pip_size);
          m.digits.push(lastDigit(msg.tick.quote, m.dec));
          if (m.digits.length > WINDOW) m.digits.splice(0, m.digits.length - WINDOW);
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
      var stake = run && run.active ? run.stake0 : (readSettings().stake || DEFAULTS.stake);
      hubStart(accountId, stake).catch(function () { setTimeout(function () { hubRecover(accountId, hub.gen); }, 3000); });
    }, 600);
  }

  /** What a win pays on each market at this stake, through this account. */
  async function price(accountId, stake, gen, onEach) {
    var amount = Math.max(round2(stake || DEFAULTS.stake), hub.minStake);
    await Promise.all(hub.order.map(async function (sym) {
      var r = await D.askOn(accountId, { proposal: 1, amount: amount, basis: "stake", currency: hub.currency, underlying_symbol: sym, contract_type: "DIGITEVEN", duration: 1, duration_unit: "t" });
      if (gen !== hub.gen) return;
      hub.markets[sym].ratio = r.error ? null : Number(r.proposal.payout) / amount;
      if (onEach) onEach();
    }));
    hub.pricedAt = Date.now();
    hub.pricedStake = amount;
  }

  function interval(m) {
    var t = m.times;
    return t.length > 2 ? (t[t.length - 1] - t[0]) / (t.length - 1) : 2;
  }

  /** The one best trade right now. */
  function choose() {
    var fresh = hub.order.map(function (s) { return hub.markets[s]; }).filter(function (m) {
      return m && m.ratio && m.digits.length >= WINDOW && Date.now() - m.at < 20000;
    });
    if (!fresh.length) return null;
    var top = Math.max.apply(null, fresh.map(function (m) { return m.ratio; }));
    var best = null;
    fresh.forEach(function (m) {
      if (m.ratio < top - TIER) return;
      var even = m.digits.filter(function (d) { return d % 2 === 0; }).length / m.digits.length;
      [["even", even], ["odd", 1 - even]].forEach(function (s) {
        var c = { m: m, side: s[0], share: s[1], speed: interval(m), digits: m.digits.slice() };
        if (!best || c.share > best.share + 1e-9 || (Math.abs(c.share - best.share) < 1e-9 && c.speed < best.speed - 0.25)) best = c;
      });
    });
    return best;
  }

  function dots(el, digits) {
    el.innerHTML = digits.map(function (d) {
      var e = d % 2 === 0;
      return '<i class="' + (e ? "e" : "o") + '">' + d + "</i>";
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
    var p = choose();
    if (!p) return;
    $("nowMarket").textContent = p.m.name;
    $("nowSide").textContent = sideName(p.side);
    $("nowSide").className = "bot-now-side bot-now-side--" + p.side;
    $("nowShare").textContent = Math.round(p.share * 100) + "%";
    dots($("nowDots"), p.digits);
  }

  /* ── settings ──────────────────────────────────────────────────────── */

  function num(id) {
    var raw = String($(id).value || "").replace(",", ".").trim();
    var v = Number(raw);
    return raw && isFinite(v) ? v : NaN;
  }
  function readSettings() {
    return { stake: round2(num("botStake")), tp: round2(num("botTp")), sl: round2(num("botSl")), mult: Math.round(num("botMult") * 100) / 100 };
  }
  function validate(s) {
    if (!(s.stake > 0)) return T("Enter a stake.");
    if (s.stake < hub.minStake - 1e-9) return fill(T("The smallest stake Deriv accepts is {min}."), { min: money(hub.minStake, hub.currency) });
    if (!(s.tp > 0)) return T("Enter a take profit above zero.");
    if (!(s.sl > 0)) return T("Enter a stop loss above zero.");
    if (!(s.mult >= 1 && s.mult <= 10)) return T("Martingale must be between 1 (off) and 10.");
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
    say("");
    var token = ++scanToken;
    bar.shown = 0; bar.target = 0;
    setProgress(0, T("Connecting to the markets…"));
    openModal("bmScan");
    var t0 = Date.now();
    try {
      var fresh = hub.account !== c.id || !hub.ready;
      await hubStart(c.id, s.stake, function (done, total, step) {
        if (token === scanToken) setProgress(0.08 + 0.72 * (total ? done / total : 0), step);
      });
      if (token !== scanToken) return;
      var err = validate(s);
      if (err) throw new Error(err);
      if (!fresh) {
        // Already live: price again at this stake and read the patterns now.
        setProgress(0.35, fill(T("Pricing Even and Odd on {n} markets…"), { n: hub.order.length }));
        var n = 0, total = hub.order.length;
        await price(c.id, s.stake, hub.gen, function () { if (token === scanToken) setProgress(0.35 + 0.45 * (++n / total)); });
      }
      if (token !== scanToken) return;
      setProgress(0.9, T("Finding the strongest pattern…"));
      var pick = null;
      for (var i = 0; i < 20 && !pick; i++) { pick = choose(); if (!pick) await sleep(300); }
      if (!pick) throw new Error(T("Deriv did not price any market just now. Try again."));
      var spent = Date.now() - t0;
      if (spent < 1600) await sleep(1600 - spent);
      if (token !== scanToken) return;
      setProgress(1, T("Done"));
      await sleep(350);
      if (token !== scanToken) return;

      pending = { account: c.id, settings: s, pick: null };
      showPick(pick);
      $("bmStake").textContent = money(s.stake, hub.currency);
      $("bmMult").textContent = "×" + s.mult;
      $("bmTp").textContent = money(s.tp, hub.currency);
      $("bmSl").textContent = money(s.sl, hub.currency);
      $("bmStart").textContent = fill(T("Start trading on {account}"), { account: c.type === "real" ? T("Real") : T("Demo") });
      openModal("bmDone");
    } catch (e) {
      if (token !== scanToken) return;
      $("bmErrText").textContent = e.message || T("The scan did not finish. Try again.");
      openModal("bmErr");
    }
  }

  /** The popup's result, and what Start will trade. While the popup is open
   *  it follows the ticks, so the first trade is always what is on screen. */
  function showPick(p) {
    pending.pick = { sym: p.m.sym, side: p.side, at: Date.now() };
    $("bmMarket").textContent = p.m.name;
    $("bmSide").textContent = sideName(p.side);
    $("bmSide").className = "bm-pick-side bm-pick-side--" + p.side;
    $("bmShare").textContent = fill(T("{p}% of the last {n} ticks"), { p: Math.round(p.share * 100), n: WINDOW });
    dots($("bmDots"), p.digits);
  }
  function paintPick() {
    if (modal.view !== "bmDone" || !pending || hub.account !== pending.account) return;
    var p = choose();
    if (p) showPick(p);
  }

  /* ── the run ───────────────────────────────────────────────────────── */

  var run = null;

  function newRun(account, s) {
    return {
      account: account, active: true, stopping: false, ended: null,
      stake0: s.stake, stake: s.stake, tp: s.tp, sl: s.sl, mult: s.mult,
      pl: 0, n: 0, won: 0, lost: 0, streak: 0, errors: 0,
      log: [], ids: {}, currency: hub.currency, startedAt: Math.floor(Date.now() / 1000) - 1,
    };
  }

  function startRun() {
    if (!pending || (run && run.active)) return;
    var c = D.accountOf(pending.account);
    var s = pending.settings, first = pending.pick;
    pending = null;
    closeModal();
    if (!c) return;
    store.set(SETTINGS_KEY, s);
    // A fresh start: nothing from the last run carries over.
    run = newRun(c.id, s);
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
    var m = hub.markets[f.sym];
    if (!m || !m.ratio || m.digits.length < WINDOW || Date.now() - m.at > 20000) return null;
    var even = m.digits.filter(function (d) { return d % 2 === 0; }).length / m.digits.length;
    return { m: m, side: f.side, share: f.side === "even" ? even : 1 - even, digits: m.digits.slice() };
  }

  async function loop(r) {
    var waitedSince = 0;
    while (r.active) {
      if (r.stopping) return end(r, "user");
      if (r.pl >= r.tp - 1e-9) return end(r, "tp");
      if (-r.pl >= r.sl - 1e-9) return end(r, "sl");
      var acc = D.accountOf(r.account);
      if (acc && acc.balance != null && r.stake > acc.balance + 1e-9) return end(r, "balance");

      if (Date.now() - hub.pricedAt > 5 * 60000 && hub.ready && hub.account === r.account) {
        try { await price(r.account, r.stake0, hub.gen); } catch (e) {}
      }

      var pick = hub.ready && hub.account === r.account ? (firstPick(r) || choose()) : null;
      if (!pick) {
        if (!waitedSince) waitedSince = Date.now();
        if (Date.now() - waitedSince > 60000) return end(r, "nodata");
        if (!hub.ready && !hub.starting && !recovering) hubStart(r.account, r.stake0).catch(function () {});
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
    var row = { id: res.id, at: res.at || Date.now(), market: what.market, side: what.side, share: what.share, stake: res.stake, pl: res.pl, won: res.won, total: r.pl, late: !!what.late };
    r.log.unshift(row);
    if (run !== r) return;
    var el = document.createElement("li");
    el.className = "bot-row " + (row.won ? "is-won" : "is-lost");
    el.innerHTML =
      '<span class="br-t">' + esc(new Date(row.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })) + "</span>" +
      '<span class="br-m">' + esc(row.market) + "</span>" +
      '<span class="br-s"><span class="b-chip b-chip--' + row.side + '">' + esc(sideName(row.side)) + (row.share != null ? " " + Math.round(row.share * 100) + "%" : "") + "</span></span>" +
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
    for (var attempt = 0; attempt < 4; attempt++) {
      try {
        await D.whenOpenOn(r.account, 6000);
        var pt = await D.askOn(r.account, { profit_table: 1, limit: 100, sort: "DESC", description: 1, contract_type: ["DIGITEVEN", "DIGITODD"], date_from: String(r.startedAt) }, 10000);
        var rows = ((pt.profit_table && pt.profit_table.transactions) || []).filter(function (x) {
          return x.contract_id && Number(x.purchase_time) >= r.startedAt && Number(x.purchase_time) <= r.ended.at &&
            /^DIGIT(EVEN|ODD)$/.test(kindOf(x)) && !r.ids[x.contract_id];
        });
        rows.reverse().forEach(function (x) {
          var sym = symOf(x), m = hub.markets[sym];
          var pl = round2(Number(x.sell_price) - Number(x.buy_price));
          record(r, { market: (m && m.name) || sym, sym: sym, side: kindOf(x) === "DIGITEVEN" ? "even" : "odd", share: null, late: true },
            { id: x.contract_id, won: pl > 0, pl: pl, stake: Number(x.buy_price), at: Number(x.sell_time || x.purchase_time) * 1000 });
        });
        var pf = await D.askOn(r.account, { portfolio: 1 }, 10000);
        var open = ((pf.portfolio && pf.portfolio.contracts) || []).some(function (x) {
          return Number(x.purchase_time) >= r.startedAt && /^DIGIT(EVEN|ODD)$/.test(kindOf(x)) && !r.ids[x.contract_id];
        });
        if (!open) break;
      } catch (e) { /* the line is coming back */ }
      await sleep(2000);
    }
    if (run === r) { paintRun(); paintButton(); }
  }

  /** One contract, one tick. Resolves { won, pl, stake, id, at, final }.
   *
   *  A 1-tick Even/Odd contract is decided by its exit tick, and Deriv says so
   *  at once (is_expired, is_settleable, the exit spot and the final profit);
   *  booking it as sold follows 1 to 7 seconds later. The bot moves on at the
   *  exit tick — but only when the exit spot's own last digit agrees with the
   *  profit — and keeps listening until Deriv books it: `final` resolves with
   *  the booked result (or null if the line went), and the run corrects
   *  itself on the rare chance the two differ. */
  function buyOnce(r, pick) {
    return new Promise(function (resolve, reject) {
      var type = pick.side === "even" ? "DIGITEVEN" : "DIGITODD";
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
        var spot = m && isFinite(m.dec) ? Number(c.exit_spot).toFixed(m.dec) : String(c.exit_spot);
        var even = Number(spot.charAt(spot.length - 1)) % 2 === 0;
        return (even === (type === "DIGITEVEN")) === (Number(c.profit) > 0);
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

      handle = D.streamOn(r.account, {
        buy: 1, price: stake, subscribe: 1,
        parameters: { contract_type: type, underlying_symbol: pick.m.sym, duration: 1, duration_unit: "t", basis: "stake", amount: stake, currency: r.currency },
      }, function (m) {
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
    ["botStake", "botTp", "botSl", "botMult"].forEach(function (id) { $(id).disabled = running; });
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

  var saved = store.get(SETTINGS_KEY) || {};
  $("botStake").value = (saved.stake >= FALLBACK_MIN ? saved.stake : DEFAULTS.stake).toFixed(2);
  $("botTp").value = String(saved.tp > 0 ? saved.tp : DEFAULTS.tp);
  $("botSl").value = String(saved.sl > 0 ? saved.sl : DEFAULTS.sl);
  $("botMult").value = String(saved.mult >= 1 ? saved.mult : DEFAULTS.mult);

  $("botGo").addEventListener("click", function () {
    if (run && run.active) return stop();
    var s = readSettings();
    var err = validate(s);
    if (err) return say(err, "bad");
    scanAndOffer();
  });
  $("bmStart").addEventListener("click", startRun);
  $("bmRetry").addEventListener("click", scanAndOffer);
  $("bmRoot").addEventListener("click", function (e) { if (e.target.closest("[data-bm-close]")) closeModal(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("bmRoot").hidden) closeModal(); });
  global.addEventListener("shalo:account", onAccount);
  global.addEventListener("langchange", function () { paintRun(); paintButton(); paintMin(); paintNow(); });
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
  global.ShaloBot = { run: function () { return run; }, hub: hub, choose: choose };
})(window);
