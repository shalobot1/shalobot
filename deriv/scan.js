/**
 * SHALOBOT — Smart Scan, starting with Even/Odd.
 *
 * What a scan does, every time, live from Deriv on the account in the chip:
 *   1. asks which markets offer Even/Odd right now (active_symbols filtered
 *      by DIGITEVEN), open and not suspended;
 *   2. prices Even and Odd on each one at the stake and ticks chosen, on the
 *      account's own socket — so the payout is the one this account gets,
 *      app markup included, rounded at this stake;
 *   3. reads each market's last 1,000 ticks (ticks_history), writing every
 *      quote with the decimals Deriv gives (a trailing zero is a real 0).
 *
 * How it ranks — and why it ranks this way. Every last digit on these markets
 * is drawn at random: Even and Odd are each exactly 50% on every market, every
 * tick. That was tested on 400,000 real ticks before this was written (every
 * market 49.3–50.5% even; no carry-over from one tick to the next; following
 * or fading the recent majority won 48–51%, which is noise). So the only thing
 * that truly differs between the choices is what a win pays, and the scan
 * ranks by expected return — win chance × payout − stake:
 *   - the highest-paying market first (most pay +84.5%, a few pay less);
 *   - among equal payers, the faster market (1-second ticks settle sooner);
 *   - then the side that came up more often in the last 1,000 ticks, shown
 *     as what it is — recent history — never as better odds.
 *
 * Trading uses the same socket: one `buy` carrying its parameters (no
 * separate quote round trip), subscribed, so the settlement streams back on
 * the request that placed it. One trade at a time; a dropped line mid-trade
 * is reconciled from the profit table before anything is retried.
 */

(function (global) {
  "use strict";

  var D = global.ShaloDeriv;
  if (!D) return;

  var $ = function (id) { return document.getElementById(id); };
  var T = function (s) { return typeof global.t === "function" ? global.t(s) : s; };
  var fill = function (s, v) { return String(s).replace(/\{(\w+)\}/g, function (_, k) { return v[k] != null ? v[k] : ""; }); };

  var MIN_STAKE = 0.35;
  var HISTORY = 1000;
  var STAKE_KEY = "shalo_scan_stake";
  var TICKS_KEY = "shalo_scan_ticks";
  var WIN_CHANCE = 0.5;

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  var scanning = false, trading = false, best = null, results = [];
  var tally = { n: 0, won: 0, pl: 0 };

  /* ── money and numbers ─────────────────────────────────────────────── */

  function cur() { var c = D.current(); return (c && c.currency) || "USD"; }
  function money(v, c) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: c || cur(), currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
    } catch (e) { return Number(v).toFixed(2) + " " + (c || cur()); }
  }
  function signed(v, c) { return (v > 0 ? "+" : v < 0 ? "−" : "") + money(Math.abs(v), c); }
  function pct(v, digits) { return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v * 100).toFixed(digits == null ? 1 : digits) + "%"; }

  function readStake() {
    var raw = String($("scanStake").value || "").replace(",", ".").trim();
    var v = Number(raw);
    if (!raw || !isFinite(v)) return { error: T("Enter a stake.") };
    v = Math.round(v * 100) / 100;
    if (v < MIN_STAKE) return { error: fill(T("The smallest stake Deriv accepts is {min}."), { min: money(MIN_STAKE) }) };
    return { value: v };
  }
  function readTicks() {
    var v = Number($("scanTicks").value);
    return v >= 1 && v <= 10 ? v : 1;
  }

  /* ── waiting for the account's socket ──────────────────────────────── */

  async function ready() {
    var until = Date.now() + 25000;
    for (;;) {
      try { await D.whenOpen(4000); return; }
      catch (e) {
        if (Date.now() > until) throw new Error(T("Not connected to Deriv yet. Try again in a moment."));
        await new Promise(function (r) { setTimeout(r, 500); });
      }
    }
  }

  /* ── the scan ──────────────────────────────────────────────────────── */

  /** Run `fn` over `items`, at most `n` at a time. */
  function pool(items, n, fn, onEach) {
    var i = 0, done = 0, out = new Array(items.length);
    return new Promise(function (resolve) {
      if (!items.length) return resolve(out);
      function next() {
        if (i >= items.length) return;
        var k = i++;
        Promise.resolve(fn(items[k])).then(function (v) { out[k] = v; }, function (e) { out[k] = { error: e.message }; })
          .then(function () { done++; if (onEach) onEach(done, items.length); if (done === items.length) resolve(out); else next(); });
      }
      for (var j = 0; j < Math.min(n, items.length); j++) next();
    });
  }

  function lastDigits(h) {
    var dec = Number(h.pip_size);
    var prices = (h.history && h.history.prices) || [];
    return prices.map(function (q) {
      var s = Number(q).toFixed(isFinite(dec) && dec >= 0 ? dec : 2);
      return Number(s.charAt(s.length - 1));
    });
  }

  async function priceMarket(sym, name, stake, ticks, currency) {
    var base = { proposal: 1, amount: stake, basis: "stake", currency: currency, underlying_symbol: sym, duration: ticks, duration_unit: "t" };
    var r = await Promise.all([
      D.ask(Object.assign({ contract_type: "DIGITEVEN" }, base)),
      D.ask(Object.assign({ contract_type: "DIGITODD" }, base)),
      D.ask({ ticks_history: sym, end: "latest", count: HISTORY, style: "ticks" }),
    ]);
    var pe = r[0], po = r[1], h = r[2];
    var out = { sym: sym, name: name };
    if (pe.error || po.error) out.priceError = (pe.error || po.error).message;
    else {
      out.payEven = Number(pe.proposal.payout);
      out.payOdd = Number(po.proposal.payout);
    }
    if (h.error) out.historyError = h.error.message;
    else {
      var digits = lastDigits(h);
      var even = digits.filter(function (d) { return d % 2 === 0; }).length;
      out.n = digits.length;
      out.evenShare = digits.length ? even / digits.length : null;
      var t = (h.history && h.history.times) || [];
      out.interval = t.length > 1 ? (t[t.length - 1] - t[0]) / (t.length - 1) : null;
    }
    return out;
  }

  /** Both sides of every market, ranked by what a trade is worth on average,
   *  then speed, then recent history. */
  function rank(list, stake) {
    var picks = [];
    list.forEach(function (m) {
      if (!m || m.priceError || m.payEven == null) return;
      [["even", m.payEven, m.evenShare], ["odd", m.payOdd, m.evenShare == null ? null : 1 - m.evenShare]].forEach(function (s) {
        picks.push({
          m: m, side: s[0], payout: s[1],
          ret: (s[1] - stake) / stake,                       // what a win adds, per 1 staked
          ev: WIN_CHANCE * s[1] / stake - 1,                 // average result per 1 staked
          recent: s[2],
        });
      });
    });
    picks.sort(function (a, b) {
      var e = Math.round(b.ev * 1000) - Math.round(a.ev * 1000);
      if (e) return e;
      var ia = a.m.interval || 99, ib = b.m.interval || 99;
      if (Math.abs(ia - ib) > 0.25) return ia - ib;
      return (b.recent || 0) - (a.recent || 0);
    });
    return picks;
  }

  async function scan() {
    if (scanning) return;
    var st = readStake();
    if (st.error) return say(st.error, "bad");
    var ticks = readTicks();
    scanning = true;
    paintBusy(true);
    progress(0, 1, T("Finding the markets…"));
    try {
      await ready();
      var currency = cur();
      var a = await D.ask({ active_symbols: "brief", contract_type: ["DIGITEVEN"] });
      if (a.error) throw new Error(a.error.message);
      var markets = (a.active_symbols || []).filter(function (x) { return x.exchange_is_open && !x.is_trading_suspended; });
      if (!markets.length) throw new Error(T("No Even/Odd market is open right now."));
      progress(0, markets.length);
      var list = await pool(markets, 5, function (x) {
        return priceMarket(x.underlying_symbol, x.underlying_symbol_name, st.value, ticks, currency);
      }, function (done, total) { progress(done, total); });
      results = list.filter(Boolean);
      var picks = rank(results, st.value);
      if (!picks.length) throw new Error(T("Deriv did not price any market just now. Try again."));
      best = picks[0];
      best.stake = st.value; best.ticks = ticks; best.at = Date.now(); best.picks = picks;
      paintBest();
      paintAll(picks);
      say("", "");
    } catch (e) {
      say(e.message || T("The scan did not finish. Try again."), "bad");
    } finally {
      scanning = false;
      paintBusy(false);
    }
  }

  /* ── painting ──────────────────────────────────────────────────────── */

  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var sideName = function (s) { return s === "even" ? T("Even") : T("Odd"); };

  function paintBusy(on) {
    $("scanGo").disabled = on;
    $("scanGo").classList.toggle("is-busy", on);
    $("scanGoText").textContent = on ? T("Scanning…") : (best ? T("Scan again") : T("Scan markets"));
    $("scanProg").hidden = !on;
    paintTradeButton();
  }

  function progress(done, total, text) {
    $("scanBar").style.width = (total ? Math.round(done / total * 100) : 0) + "%";
    $("scanProgText").textContent = text || fill(T("Checked {done} of {total} markets…"), { done: done, total: total });
  }

  function paintBest() {
    if (!best) return;
    var m = best.m, other = best.side === "even" ? "odd" : "even";
    $("scanBest").hidden = false;
    $("bestMarket").textContent = m.name;
    $("bestSide").textContent = sideName(best.side);
    $("bestSide").className = "scan-side scan-side--" + best.side;
    $("bestPay").textContent = pct(best.ret);
    $("bestChance").textContent = Math.round(WIN_CHANCE * 100) + "%";
    $("bestRecent").textContent = m.evenShare == null ? "—" :
      fill(T("{a} {ap} · {b} {bp}"), {
        a: sideName(best.side), ap: (best.recent * 100).toFixed(1) + "%",
        b: sideName(other), bp: ((1 - best.recent) * 100).toFixed(1) + "%",
      });
    $("bestEv").textContent = pct(best.ev);
    $("bestSpeed").textContent = m.interval ? fill(T("about {s}s"), { s: m.interval < 1.5 ? 1 : Math.round(m.interval) }) : "—";
    $("bestWhen").textContent = fill(T("{stake} stake · {ticks} tick(s)"), { stake: money(best.stake), ticks: best.ticks });
    $("scanStake").value = best.stake.toFixed(2);
    paintTradeButton();
  }

  function paintAll(picks) {
    var seen = {}, rows = [];
    picks.forEach(function (p) { if (!seen[p.m.sym]) { seen[p.m.sym] = 1; rows.push(p); } });
    results.forEach(function (m) { if (m && !seen[m.sym]) rows.push({ m: m, failed: true }); });
    $("scanAllN").textContent = String(rows.length);
    $("scanRows").innerHTML = rows.map(function (p, i) {
      var m = p.m;
      if (p.failed) {
        return '<tr class="is-off"><td class="sc-n">' + esc(m.name) + '</td><td colspan="4">' + esc(T("not priced")) + "</td></tr>";
      }
      return '<tr' + (i === 0 ? ' class="is-best"' : "") + '>' +
        '<td class="sc-n">' + esc(m.name) + "</td>" +
        '<td class="sc-pay">' + esc(pct(p.ret)) + "</td>" +
        '<td class="sc-split" translate="no">' + (m.evenShare == null ? "—" : (m.evenShare * 100).toFixed(1) + "% / " + ((1 - m.evenShare) * 100).toFixed(1) + "%") + "</td>" +
        '<td class="sc-side">' + esc(sideName(p.side)) + "</td>" +
        '<td class="sc-ev">' + esc(pct(p.ev)) + "</td></tr>";
    }).join("");
    $("scanAll").hidden = false;
  }

  function paintTradeButton() {
    var b = $("scanTrade");
    if (!b) return;
    var c = D.current();
    var where = c ? (c.type === "real" ? T("Real") : T("Demo")) : "";
    if (trading) { b.disabled = true; $("scanTradeText").textContent = T("Trading…"); return; }
    b.disabled = !best || scanning || !c;
    b.classList.toggle("is-real", !!(c && c.type === "real"));
    $("scanTradeText").textContent = best ? fill(T("Trade {side} on {account}"), { side: sideName(best.side), account: where }) : T("Trade");
  }

  function say(text, kind) {
    var el = $("scanMsg");
    el.textContent = text || "";
    el.className = "scan-msg" + (kind ? " scan-msg--" + kind : "");
    el.hidden = !text;
  }

  function paintTally() {
    if (!tally.n) { $("scanTally").hidden = true; return; }
    $("scanTally").hidden = false;
    $("tallyN").textContent = String(tally.n);
    $("tallyWon").textContent = String(tally.won);
    $("tallyPl").textContent = signed(tally.pl);
    $("tallyPl").className = tally.pl > 0 ? "is-up" : tally.pl < 0 ? "is-down" : "";
  }

  /* ── trading ───────────────────────────────────────────────────────── */

  function result(text, kind) {
    var el = $("scanResult");
    el.hidden = !text;
    el.textContent = text || "";
    el.className = "scan-result" + (kind ? " scan-result--" + kind : "");
  }

  async function trade() {
    if (trading || !best) return;
    var c = D.current();
    if (!c) return;
    var st = readStake();
    if (st.error) return result(st.error, "bad");
    if (c.balance != null && st.value > c.balance + 1e-9) {
      return result(fill(T("Not enough balance on this account: {bal}. The smallest stake is {min}."), { bal: money(c.balance), min: money(MIN_STAKE) }), "bad");
    }
    store.set(STAKE_KEY, String(st.value));
    var ticks = readTicks();
    var pick = best;
    var type = pick.side === "even" ? "DIGITEVEN" : "DIGITODD";
    trading = true;
    paintTradeButton();
    result(fill(T("Buying {side} on {market}…"), { side: sideName(pick.side), market: pick.m.name }), "wait");

    try { await ready(); } catch (e) { trading = false; paintTradeButton(); return result(e.message, "bad"); }

    var started = Math.floor(Date.now() / 1000) - 2;
    var settled = false, bought = null, subId = null;
    var guard = setTimeout(function () { if (!settled) lost("timeout"); }, 30000 + ticks * 3000);

    function finish() {
      settled = true;
      clearTimeout(guard);
      if (handle) handle.end();
      if (subId) D.ask({ forget: subId }, 5000).catch(function () {});
      trading = false;
      paintTradeButton();
    }

    function settle(c) {
      if (settled) return;
      // Deriv's own figure first; the sum only when it is missing.
      var pl = c.profit != null && c.profit !== "" ? Number(c.profit)
        : Number(c.sell_price != null ? c.sell_price : (c.status === "won" ? c.payout : 0)) - Number(c.buy_price);
      pl = Math.round(pl * 100) / 100;
      var won = c.status === "won" || pl > 0;
      tally.n++; if (won) tally.won++; tally.pl = Math.round((tally.pl + pl) * 100) / 100;
      finish();
      result(won ? fill(T("Won {pl} on {market}."), { pl: signed(pl), market: pick.m.name })
                 : fill(T("Lost {pl} on {market}."), { pl: signed(pl), market: pick.m.name }), won ? "won" : "lost");
      paintTally();
    }

    /* The line went quiet or dropped with a trade in flight. Never buy again
       blind: ask Deriv what happened to it first. */
    async function lost(why) {
      if (settled) return;
      result(T("Checking the trade with Deriv…"), "wait");
      for (var i = 0; i < 6 && !settled; i++) {
        try {
          await ready();
          var pt = await D.ask({ profit_table: 1, limit: 10, sort: "DESC", description: 1 }, 10000);
          var rows = (pt.profit_table && pt.profit_table.transactions) || [];
          var hit = rows.filter(function (r) {
            return (bought && Number(r.contract_id) === Number(bought.contract_id)) ||
              (!bought && Number(r.purchase_time) >= started && String(r.shortcode || "").indexOf(type + "_" + pick.m.sym + "_") === 0);
          })[0];
          if (hit) {
            return settle({ buy_price: hit.buy_price, sell_price: hit.sell_price, status: Number(hit.sell_price) > Number(hit.buy_price) ? "won" : "lost" });
          }
          var pf = await D.ask({ portfolio: 1 }, 10000);
          var open = ((pf.portfolio && pf.portfolio.contracts) || []).some(function (r) {
            return (bought && Number(r.contract_id) === Number(bought.contract_id)) ||
              (!bought && Number(r.purchase_time) >= started && String(r.shortcode || "").indexOf(type + "_" + pick.m.sym + "_") === 0);
          });
          if (!open && !bought && i >= 1) {
            finish();
            return result(T("The trade was not placed. Nothing was spent."), "bad");
          }
        } catch (e) { /* the line is still coming back */ }
        await new Promise(function (r) { setTimeout(r, 2500); });
      }
      if (!settled) { finish(); result(T("Could not confirm the trade yet. Check your Deriv statement before trading again."), "bad"); }
    }

    var handle = D.stream({
      buy: 1, price: st.value, subscribe: 1,
      parameters: { contract_type: type, underlying_symbol: pick.m.sym, duration: ticks, duration_unit: "t", basis: "stake", amount: st.value, currency: cur() },
    }, function (m) {
      if (settled) return;
      if (m.closed) return lost("closed");
      if (m.error) {
        if (bought) return lost("error");
        finish();
        return result(T(m.error.message || "Deriv refused the trade."), "bad");
      }
      if (m.msg_type === "buy" && m.buy) {
        bought = m.buy;
        if (m.subscription) subId = m.subscription.id;
        result(fill(T("Bought {side} on {market} — waiting for the tick…"), { side: sideName(pick.side), market: pick.m.name }), "wait");
      } else if (m.msg_type === "proposal_open_contract" && m.proposal_open_contract) {
        var poc = m.proposal_open_contract;
        if (m.subscription && !subId) subId = m.subscription.id;
        if (poc.is_sold) settle(poc);
      }
    });
    if (!handle) { clearTimeout(guard); trading = false; paintTradeButton(); result(T("Not connected to Deriv yet. Try again in a moment."), "bad"); }
  }

  /* ── wiring ────────────────────────────────────────────────────────── */

  function show() {
    var on = !!D.current() && !$("acct").hidden;
    $("scan").hidden = !on;
    $("scanCur").textContent = cur();
    paintTradeButton();
  }

  var saved = Number(store.get(STAKE_KEY));
  $("scanStake").value = (saved >= MIN_STAKE ? saved : MIN_STAKE).toFixed(2);
  var savedTicks = Number(store.get(TICKS_KEY));
  if (savedTicks >= 1 && savedTicks <= 10) $("scanTicks").value = String(savedTicks);
  $("scanTicks").addEventListener("change", function () { store.set(TICKS_KEY, $("scanTicks").value); });
  $("scanStake").addEventListener("change", function () {
    var st = readStake();
    if (!st.error) { $("scanStake").value = st.value.toFixed(2); store.set(STAKE_KEY, String(st.value)); }
  });
  $("scanGo").addEventListener("click", scan);
  $("scanTrade").addEventListener("click", trade);
  global.addEventListener("shalo:account", show);
  global.addEventListener("langchange", function () { if (best) { paintBest(); paintAll(best.picks); } paintTradeButton(); paintTally(); });
  show();
})(window);
