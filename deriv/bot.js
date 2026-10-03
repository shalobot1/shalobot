/**
 * SHALOBOT — the Smart Scan bot, Even/Odd.
 *
 * LIVE SCAN. On the account's own socket (no extra connection; Deriv allows
 * five per person): which markets offer Even/Odd right now, what a win pays
 * on each at this account's stake (app markup and rounding included), and a
 * tick stream per market keeping its last WINDOW last digits. Each digit is
 * written with the decimals Deriv gives, so a trailing zero is a real 0.
 *
 * THE PICK, before every trade: among the markets that pay the most, the
 * market and side whose last WINDOW ticks come closest to 100% of one side;
 * a tie goes to the faster market. That is the rule the owner asked for. It
 * was backtested on 400,000 real ticks before it was written: the chosen side
 * averaged an 82% "pattern" over 10 ticks and won 49.4% — the digits are
 * random, so a pattern is history, not a forecast. The page shows it as what
 * it is.
 *
 * THE RUN. One contract at a time, always 1 tick. Martingale: after a loss
 * the stake is multiplied (default x3.1), after a win it goes back to the
 * starting stake. The run stops on take profit, on stop loss, on Stop, or
 * when the account cannot cover the next stake — and a stake that would carry
 * the loss past the stop loss is never placed, so the loss never overshoots it.
 * Every new run starts from nothing: its log and its figures are cleared.
 *
 * Each buy is one `buy` with its parameters and subscribe (no separate quote
 * round trip), settled from the contract stream on that same request. A line
 * that drops with a trade in flight is reconciled from the profit table and
 * the portfolio before the bot moves on — it never buys blind.
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

  var WINDOW = 10;                       // "the last few ticks"
  var TIER = 0.004;                      // markets within this of the best payout count as best-paying
  var DEFAULTS = { stake: 1, tp: 1000, sl: 1000, mult: 3.1 };
  var SETTINGS_KEY = "shalo_bot_settings";
  var FALLBACK_MIN = 0.35;

  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  /* ── money ─────────────────────────────────────────────────────────── */

  function money(v, cur) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
    } catch (e) { return Number(v).toFixed(2) + " " + (cur || ""); }
  }
  function signed(v, cur) { return (v > 0 ? "+" : v < 0 ? "−" : "") + money(Math.abs(v), cur); }

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
  }

  /** Start (or restart) the scan on one account. Safe to call again: a
   *  newer start makes every callback of an older one a no-op. */
  function hubStart(accountId, stake) {
    if (hub.account === accountId && (hub.ready || hub.starting)) return hub.starting || Promise.resolve();
    hubStop();
    hub.account = accountId;
    var gen = hub.gen;
    hub.starting = (async function () {
      for (var i = 0; ; i++) {
        try { await D.whenOpenOn(accountId, 6000); break; }
        catch (e) { if (gen !== hub.gen) return; if (i > 6) throw new Error(T("Not connected to Deriv yet. Try again in a moment.")); await sleep(800); }
      }
      if (gen !== hub.gen) return;
      var acc = D.accountOf(accountId);
      hub.currency = (acc && acc.currency) || "USD";

      var a = await D.askOn(accountId, { active_symbols: "brief", contract_type: ["DIGITEVEN"] });
      if (a.error) throw new Error(a.error.message);
      var list = (a.active_symbols || []).filter(function (x) { return x.exchange_is_open && !x.is_trading_suspended; });
      if (!list.length) throw new Error(T("No Even/Odd market is open right now."));
      if (gen !== hub.gen) return;

      // The smallest stake Deriv takes for this currency, from Deriv's own refusal.
      var probe = await D.askOn(accountId, { proposal: 1, amount: 0.01, basis: "stake", currency: hub.currency, underlying_symbol: list[0].underlying_symbol, contract_type: "DIGITEVEN", duration: 1, duration_unit: "t" });
      var arg = probe.error && probe.error.code_args && Number(probe.error.code_args[0]);
      hub.minStake = isFinite(arg) && arg > 0 ? arg : FALLBACK_MIN;

      hub.markets = {}; hub.order = [];
      list.forEach(function (x) {
        hub.order.push(x.underlying_symbol);
        hub.markets[x.underlying_symbol] = { sym: x.underlying_symbol, name: x.underlying_symbol_name, digits: [], times: [], ratio: null, at: 0 };
      });

      // History first, so every market has a full window from the start.
      await Promise.all(hub.order.map(async function (sym) {
        var h = await D.askOn(accountId, { ticks_history: sym, end: "latest", count: 50, style: "ticks" });
        var m = hub.markets[sym];
        if (!h.error && h.history) {
          var dec = Number(h.pip_size);
          m.digits = h.history.prices.map(function (q) { return lastDigit(q, dec); }).slice(-WINDOW);
          m.times = h.history.times.slice(-50);
          m.at = Date.now();
        }
      }));
      if (gen !== hub.gen) return;
      await price(accountId, stake, gen);
      if (gen !== hub.gen) return;

      // Then the live streams, one per market.
      hub.order.forEach(function (sym) {
        var s = D.streamOn(accountId, { ticks: sym, subscribe: 1 }, function (msg) {
          if (gen !== hub.gen) return;
          if (msg.closed) return hubRecover(accountId, gen);
          if (msg.error || !msg.tick) return;
          var m = hub.markets[sym];
          m.digits.push(lastDigit(msg.tick.quote, Number(msg.tick.pip_size)));
          if (m.digits.length > WINDOW) m.digits.splice(0, m.digits.length - WINDOW);
          m.times.push(msg.tick.epoch);
          if (m.times.length > 50) m.times.splice(0, m.times.length - 50);
          m.at = Date.now();
          scheduleScanPaint();
        });
        if (s) hub.subs.push(s);
      });
      hub.ready = true;
      hub.starting = null;
      paintMin();
      scheduleScanPaint();
    })().catch(function (e) {
      if (gen === hub.gen) { hub.starting = null; hub.account = null; }
      throw e;
    });
    return hub.starting;
  }

  /** The line dropped: the streams are gone with it. Rebuild the scan once
   *  the socket is back, keeping the run (if any) waiting meanwhile. */
  var recovering = false;
  function hubRecover(accountId, gen) {
    if (recovering || gen !== hub.gen) return;
    recovering = true;
    hub.ready = false;
    hub.account = null;
    setTimeout(function () {
      recovering = false;
      var stake = run && run.active ? run.stake0 : readSettings().stake || DEFAULTS.stake;
      hubStart(accountId, stake).catch(function () { setTimeout(function () { hubRecover(accountId, hub.gen); }, 3000); });
    }, 600);
  }

  /** What a win pays on each market at this stake, through this account. */
  async function price(accountId, stake, gen) {
    var amount = Math.max(round2(stake || DEFAULTS.stake), hub.minStake);
    await Promise.all(hub.order.map(async function (sym) {
      var r = await D.askOn(accountId, { proposal: 1, amount: amount, basis: "stake", currency: hub.currency, underlying_symbol: sym, contract_type: "DIGITEVEN", duration: 1, duration_unit: "t" });
      if (gen !== hub.gen) return;
      hub.markets[sym].ratio = r.error ? null : Number(r.proposal.payout) / amount;
    }));
    hub.pricedAt = Date.now();
    hub.pricedStake = amount;
  }

  function interval(m) {
    var t = m.times;
    return t.length > 2 ? (t[t.length - 1] - t[0]) / (t.length - 1) : 2;
  }

  /** The pick: the best-paying markets, then the side closest to 100% over
   *  the last WINDOW ticks, then the faster market. */
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
        var c = { m: m, side: s[0], share: s[1], speed: interval(m) };
        if (!best || c.share > best.share + 1e-9 || (Math.abs(c.share - best.share) < 1e-9 && c.speed < best.speed - 0.25)) best = c;
      });
    });
    return best;
  }

  /* ── painting the scan ─────────────────────────────────────────────── */

  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var sideName = function (s) { return s === "even" ? T("Even") : T("Odd"); };

  var paintTimer = 0;
  function scheduleScanPaint() {
    if (paintTimer) return;
    paintTimer = setTimeout(function () { paintTimer = 0; paintScan(); }, 600);
  }

  function paintScan() {
    if (!hub.order.length) return;
    var pick = choose();
    var top = Math.max.apply(null, hub.order.map(function (s) { var m = hub.markets[s]; return (m && m.ratio) || 0; }));
    var rows = hub.order.map(function (s) { return hub.markets[s]; }).filter(Boolean).map(function (m) {
      var even = m.digits.length ? m.digits.filter(function (d) { return d % 2 === 0; }).length / m.digits.length : null;
      var lead = even == null ? null : (even >= 0.5 ? "even" : "odd");
      return { m: m, even: even, lead: lead, share: even == null ? 0 : Math.max(even, 1 - even), best: m.ratio && m.ratio >= top - TIER };
    });
    rows.sort(function (a, b) {
      if (a.best !== b.best) return a.best ? -1 : 1;
      return b.share - a.share || (b.m.ratio || 0) - (a.m.ratio || 0);
    });

    if (pick) {
      $("pickMarket").textContent = pick.m.name;
      $("pickSide").textContent = sideName(pick.side);
      $("pickSide").className = "bot-pick-side bot-pick-side--" + pick.side;
      $("pickShare").textContent = fill(T("{p}% of the last {n} ticks"), { p: Math.round(pick.share * 100), n: WINDOW });
      $("botPick").hidden = false;
    }
    $("scanCount").textContent = fill(T("{n} markets · live"), { n: rows.length });
    $("scanRows").innerHTML = rows.map(function (r) {
      var m = r.m, isPick = pick && pick.m === m;
      var pays = m.ratio ? "+" + ((m.ratio - 1) * 100).toFixed(1) + "%" : "—";
      var bar = r.even == null ? "" :
        '<span class="bot-bar" aria-hidden="true"><i class="e" style="width:' + Math.round(r.even * 100) + '%"></i></span>';
      return '<tr class="' + (isPick ? "is-pick" : "") + (r.best ? "" : " is-low") + '">' +
        '<td class="b-n">' + esc(m.name) + "</td>" +
        '<td class="b-pay">' + esc(pays) + "</td>" +
        '<td class="b-split">' + bar + '<span class="b-nums">' + (r.even == null ? "—" : Math.round(r.even * 100) + "% / " + Math.round((1 - r.even) * 100) + "%") + "</span></td>" +
        '<td class="b-lead">' + (r.lead ? '<span class="b-chip b-chip--' + r.lead + '">' + esc(sideName(r.lead)) + " " + Math.round(r.share * 100) + "%</span>" : "—") + "</td></tr>";
    }).join("");
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
    if (s.stake < hub.minStake) return fill(T("The smallest stake Deriv accepts is {min}."), { min: money(hub.minStake, hub.currency) });
    if (!(s.tp > 0)) return T("Enter a take profit above zero.");
    if (!(s.sl > 0)) return T("Enter a stop loss above zero.");
    if (s.stake > s.sl) return T("The stake cannot be larger than the stop loss.");
    if (!(s.mult >= 1 && s.mult <= 10)) return T("Martingale must be between 1 (off) and 10.");
    return "";
  }

  function paintMin() {
    $("botMin").textContent = fill(T("Smallest stake Deriv accepts: {min}."), { min: money(hub.minStake, hub.currency) });
    Array.prototype.forEach.call(document.querySelectorAll("[data-bot-cur]"), function (e) { e.textContent = hub.currency; });
  }

  /* ── the run ───────────────────────────────────────────────────────── */

  var run = null;

  function newRun(account, s) {
    return {
      account: account, active: true, stopping: false, ended: null,
      stake0: s.stake, stake: s.stake, tp: s.tp, sl: s.sl, mult: s.mult,
      pl: 0, n: 0, won: 0, lost: 0, streak: 0, errors: 0, log: [], currency: hub.currency,
    };
  }

  async function start() {
    if (run && run.active) return;
    var c = D.current();
    if (!c) return;
    var s = readSettings();
    say("");
    try { await hubStart(c.id, s.stake); } catch (e) { return say(e.message, "bad"); }
    var err = validate(s);
    if (err) return say(err, "bad");
    store.set(SETTINGS_KEY, s);

    // A fresh start: nothing from the last run carries over.
    run = newRun(c.id, s);
    $("botLog").innerHTML = "";
    paintRun();
    paintButton();

    if (Math.abs(hub.pricedStake - Math.max(s.stake, hub.minStake)) > 0.001 || Date.now() - hub.pricedAt > 5 * 60000) {
      try { await price(c.id, s.stake, hub.gen); } catch (e) {}
    }
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
    r.ended = { reason: reason, detail: detail || "" };
    paintRun();
    paintButton();
  }

  async function loop(r) {
    var waitedSince = 0;
    while (r.active) {
      if (r.stopping) return end(r, "user");
      if (r.pl >= r.tp - 1e-9) return end(r, "tp");
      if (-r.pl >= r.sl - 1e-9) return end(r, "sl");
      if (-r.pl + r.stake > r.sl + 1e-9) return end(r, "sl-next");
      var acc = D.accountOf(r.account);
      if (acc && acc.balance != null && r.stake > acc.balance + 1e-9) return end(r, "balance");

      // Refresh what each market pays every few minutes during a long run.
      if (Date.now() - hub.pricedAt > 5 * 60000 && hub.ready) { try { await price(r.account, r.stake0, hub.gen); } catch (e) {} }

      var pick = hub.ready ? choose() : null;
      if (!pick) {
        if (!waitedSince) waitedSince = Date.now();
        if (Date.now() - waitedSince > 45000) return end(r, "nodata");
        paintRun(T("Waiting for live prices…"));
        await sleep(400);
        continue;
      }
      waitedSince = 0;

      var res;
      try { res = await buyOnce(r, pick); }
      catch (e) {
        r.errors++;
        if (e.fatal || r.errors >= 3) return end(r, "error", e.message);
        paintRun(e.message);
        await sleep(1500);
        continue;
      }
      r.errors = 0;
      record(r, pick, res);
      r.stake = res.won ? r.stake0 : round2(r.stake * r.mult);
      paintRun();
    }
  }

  function record(r, pick, res) {
    r.n++;
    r.pl = round2(r.pl + res.pl);
    if (res.won) { r.won++; r.streak = 0; } else { r.lost++; r.streak++; }
    var row = { at: Date.now(), market: pick.m.name, side: pick.side, share: pick.share, stake: res.stake, pl: res.pl, won: res.won, total: r.pl };
    r.log.unshift(row);
    if (r.log.length > 500) r.log.length = 500;
    var el = document.createElement("li");
    el.className = "bot-row " + (row.won ? "is-won" : "is-lost");
    el.innerHTML =
      '<span class="br-t">' + esc(new Date(row.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })) + "</span>" +
      '<span class="br-m">' + esc(row.market) + "</span>" +
      '<span class="br-s b-chip b-chip--' + row.side + '">' + esc(sideName(row.side)) + " " + Math.round(row.share * 100) + "%</span>" +
      '<span class="br-k">' + esc(money(row.stake, r.currency)) + "</span>" +
      '<span class="br-p">' + esc(signed(row.pl, r.currency)) + "</span>" +
      '<span class="br-c">' + esc(signed(row.total, r.currency)) + "</span>";
    var list = $("botLog");
    list.insertBefore(el, list.firstChild);
    while (list.children.length > 200) list.removeChild(list.lastChild);
  }

  /** One contract, one tick, start to settlement. Resolves { won, pl, stake }. */
  function buyOnce(r, pick) {
    return new Promise(function (resolve, reject) {
      var type = pick.side === "even" ? "DIGITEVEN" : "DIGITODD";
      var stake = r.stake;
      var started = Math.floor(Date.now() / 1000) - 2;
      var settled = false, bought = null, subId = null, handle = null;
      var guard = setTimeout(function () { if (!settled) lost(); }, 30000);

      function done(v, err) {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        if (handle) handle.end();
        if (subId) D.askOn(r.account, { forget: subId }, 5000).catch(function () {});
        if (err) reject(err); else resolve(v);
      }
      function fromContract(c) {
        var pl = c.profit != null && c.profit !== "" ? Number(c.profit)
          : Number(c.sell_price != null ? c.sell_price : 0) - Number(c.buy_price);
        pl = round2(pl);
        done({ won: c.status === "won" || pl > 0, pl: pl, stake: Number(c.buy_price) || stake });
      }
      async function lost() {
        if (settled) return;
        paintRun(T("Checking the trade with Deriv…"));
        for (var i = 0; i < 8 && !settled; i++) {
          try {
            await D.whenOpenOn(r.account, 6000);
            var match = function (x) {
              return (bought && Number(x.contract_id) === Number(bought.contract_id)) ||
                (!bought && Number(x.purchase_time) >= started && String(x.shortcode || "").indexOf(type + "_" + pick.m.sym + "_") === 0);
            };
            var pt = await D.askOn(r.account, { profit_table: 1, limit: 10, sort: "DESC", description: 1 }, 10000);
            var hit = ((pt.profit_table && pt.profit_table.transactions) || []).filter(match)[0];
            if (hit) return fromContract({ buy_price: hit.buy_price, sell_price: hit.sell_price, status: Number(hit.sell_price) > Number(hit.buy_price) ? "won" : "lost" });
            var pf = await D.askOn(r.account, { portfolio: 1 }, 10000);
            var open = ((pf.portfolio && pf.portfolio.contracts) || []).some(match);
            if (!open && !bought && i >= 1) {
              var e = new Error(T("The trade was not placed. Nothing was spent."));
              return done(null, e);
            }
          } catch (x) { /* still reconnecting */ }
          await sleep(2500);
        }
        if (!settled) { var f = new Error(T("Could not confirm the last trade. The bot stopped so nothing is bought twice — check your Deriv statement.")); f.fatal = true; done(null, f); }
      }

      handle = D.streamOn(r.account, {
        buy: 1, price: stake, subscribe: 1,
        parameters: { contract_type: type, underlying_symbol: pick.m.sym, duration: 1, duration_unit: "t", basis: "stake", amount: stake, currency: r.currency },
      }, function (m) {
        if (settled) return;
        if (m.closed) return lost();
        if (m.error) {
          if (bought) return lost();
          var e = new Error(T(m.error.message || "Deriv refused the trade."));
          var code = m.error.code || "";
          e.fatal = /InsufficientBalance|ContractBuyValidationError|InvalidContract|AuthorizationRequired|PermissionDenied/.test(code);
          return done(null, e);
        }
        if (m.msg_type === "buy" && m.buy) {
          bought = m.buy;
          if (m.subscription) subId = m.subscription.id;
        } else if (m.msg_type === "proposal_open_contract" && m.proposal_open_contract) {
          if (m.subscription && !subId) subId = m.subscription.id;
          if (m.proposal_open_contract.is_sold) fromContract(m.proposal_open_contract);
        }
      });
      if (!handle) { clearTimeout(guard); settled = true; reject(new Error(T("Not connected to Deriv yet. Try again in a moment."))); }
    });
  }

  /* ── painting the run ──────────────────────────────────────────────── */

  var REASONS = {
    user: "Stopped.",
    tp: "Take profit reached.",
    sl: "Stop loss reached.",
    "sl-next": "Stopped: the next stake would pass the stop loss.",
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
    $("botNext").textContent = r ? money(r.stake, cur) : "—";
    $("botStreak").textContent = String(r ? r.streak : 0);
    $("botEmpty").hidden = !!(r && r.n);
    $("logN").textContent = r && r.n ? fill(T("{n} this run"), { n: r.n }) : "";

    var st = $("botState"), text, kind;
    if (!r) { text = T("Ready"); kind = "idle"; }
    else if (r.active && r.stopping) { text = T("Stopping after this trade…"); kind = "wait"; }
    else if (r.active) { text = note || (r.n ? T("Running") : T("Starting…")); kind = "run"; }
    else {
      text = T(REASONS[r.ended.reason] || "Stopped.");
      if (r.ended.detail) text += " " + r.ended.detail;
      kind = r.ended.reason === "tp" ? "won" : (r.ended.reason === "user" ? "idle" : "bad");
    }
    $("botStateText").textContent = text;
    st.className = "bot-state bot-state--" + kind;
  }

  function paintButton() {
    var b = $("botGo"), c = D.current();
    var running = run && run.active;
    b.classList.toggle("is-stop", !!running);
    b.disabled = !!(running && run.stopping) || !c;
    var where = c ? (c.type === "real" ? T("Real") : T("Demo")) : "";
    $("botGoText").textContent = running ? (run.stopping ? T("Stopping…") : T("Stop")) : fill(T("Start on {account}"), { account: where });
    b.classList.toggle("is-real", !running && !!(c && c.type === "real"));
    ["botStake", "botTp", "botSl", "botMult"].forEach(function (id) { $(id).disabled = !!running; });
    if (running) {
      var acc = D.accountOf(run.account);
      $("botOn").textContent = acc ? fill(T("Trading on {account} {id}"), { account: acc.type === "real" ? T("Real") : T("Demo"), id: acc.id }) : "";
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
    if (!on) return;
    // The scan follows the chip — except while a run is going, when it stays
    // on the run's own account.
    var target = run && run.active ? run.account : c.id;
    if (hub.account !== target) {
      hubStart(target, readSettings().stake || DEFAULTS.stake).catch(function (e) { say(e.message, "bad"); });
    }
  }

  var saved = store.get(SETTINGS_KEY) || {};
  $("botStake").value = (saved.stake >= FALLBACK_MIN ? saved.stake : DEFAULTS.stake).toFixed(2);
  $("botTp").value = String(saved.tp > 0 ? saved.tp : DEFAULTS.tp);
  $("botSl").value = String(saved.sl > 0 ? saved.sl : DEFAULTS.sl);
  $("botMult").value = String(saved.mult >= 1 ? saved.mult : DEFAULTS.mult);

  $("botGo").addEventListener("click", function () { if (run && run.active) stop(); else start(); });
  global.addEventListener("shalo:account", onAccount);
  global.addEventListener("langchange", function () { paintScan(); paintRun(); paintButton(); paintMin(); });
  global.addEventListener("beforeunload", function (e) {
    if (run && run.active) { e.preventDefault(); e.returnValue = ""; }
  });
  paintRun();
  onAccount();
})(window);
