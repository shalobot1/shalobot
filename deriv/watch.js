/**
 * SHALOBOT — the watch (deriv/watch.js). Every trade type traded on
 * paper, all the time the page is open, exactly as the bot would trade it — and
 * a reading, per type, of how that has been going. Nothing here buys anything,
 * draws anything or talks to Deriv: the bot (deriv/bot.js) hands it the ticks, its
 * own pick, the prices and the user's figures, and paints what it says. The same
 * file serves every site; only the global names differ.
 *
 * ON PAPER, AS FOR REAL. One lane per type (and prediction). A lane with nothing
 * open picks the bot's own trade at that moment — the same scan, the same rule —
 * and "buys" it: the contract starts on that market's next tick and is decided
 * by the tick after, as Deriv's one-tick contracts are; a digit by the exit
 * tick's last digit, Rise/Fall by the move from entry to exit. A win pays what
 * Deriv pays on that market and side, rounded to cents. The stake moves as the
 * user's own would: back to the starting stake after a win, times the Martingale
 * after a loss; for the types that recover (Differs, Over 0–3), a stake the
 * balance cannot pay is won back with the Over/Under the bot itself would use.
 * Sessions end at the take profit, the stop loss or the balance, and the next
 * one starts — the lane never stops.
 *
 * STRAIGHT AWAY. On a page load the last ~1,000 ticks of every market are
 * replayed through every lane before the live ticks take over, so a reading is
 * there in a moment, not after minutes of watching.
 *
 * THE READING. Each type is measured against its own odds, so a loss means what
 * it should for that type: two losses in a row are one chance in a hundred for
 * Differs (90%), six or seven are the same for Even/Odd (50%), forty-odd for
 * Matches (10%). What counts:
 *   - the losing streak now, by how unlikely it is for this type;
 *   - recent streaks, by the same measure, fading as they get older;
 *   - the win rate of the last trades against what this type should win;
 *   - how deep the Martingale had to go, against the balance and stop loss;
 *   - recent sessions that ended at the stop loss or the balance;
 *   - whether enough markets are live and priced for the pick to be a pick.
 * All of it becomes one figure, 0–100, and a state: green, yellow, red. The
 * state moves with a little hysteresis, so it does not flicker on one trade.
 *
 * WHAT IT IS NOT. The digits and ticks of these markets are random (backtested on
 * 400,000 real ticks), so a reading describes what has been happening, never the
 * odds of the next tick. It is used to keep the bot out of the way of conditions
 * that have turned unusual — and to say so with colour, not with promises.
 */
(function (global) {
  "use strict";

  var HIST = 1000;      // ticks kept per market (~16 minutes of a 1-second index)
  var LIVE = 100;       // what the pick reads (the bot's LONG)
  var TIMES = 50;       // the tick times it reads, for speed
  var OUTS = 240;       // paper trades kept per lane
  var SESS = 8;         // finished sessions kept per lane
  var MIN_N = 12;       // trades before a lane shows a reading
  var STALE = 30;       // seconds a position may wait for its market's next tick
  var WINDOW = 40;      // the trades the win rate is read over

  // The reading's shape (tuned on fair random outcomes for every type: see the
  // calibration in the repo's tests). All in natural-log "surprise" units.
  var K = {
    base: 1.45,         // calm conditions read around 80
    zUp: 0.12,          // a win rate above this type's own, per standard deviation (to +2)
    zDown: 1.1,         // a win rate below it, per standard deviation past −0.8
    zFree: 0.8,
    allow: Math.log(20),// a streak with a 1-in-20 chance or better costs nothing...
    slope: 1.1,         // ...and beyond that, this much per unit of surprise
    fade: 30,           // a past streak's weight falls by e every 30 trades
    past: 0.85,         // ...and counts a little less than the streak now
    span: 150,          // and is forgotten after this many trades
    // How deep the Martingale went against the balance, and sessions lost to the stop loss or
    // the balance, are kept but weigh nothing: on a small balance they say "this Martingale is
    // too big for this account" all the time — true, but not a change in conditions, and the
    // streaks behind them are already counted above. (Calibrated: with them, a 50 account
    // read red 30–70% of the time on fair odds; without, 3–9% like every other.)
    depth: 0,
    sess: 0,
    thin: 1.2,          // fewer than 3 markets live for the pick
  };
  var GREEN = 62, YELLOW_UP = 46, RED = 36, GREEN_DOWN = 56;

  var round2 = function (v) { return Math.round(v * 100) / 100; };
  function lastDigit(quote, dec) {
    var s = Number(quote).toFixed(isFinite(dec) && dec >= 0 ? dec : 2);
    return Number(s.charAt(s.length - 1));
  }
  function fixed(q, dec) { return Number(Number(q).toFixed(isFinite(dec) && dec >= 0 ? dec : 2)); }

  /** The chance a side wins: for a digit, the share of the ten digits it wins on;
   *  for a move, half the share of ticks that move at all (a tie loses both). */
  function chanceOf(side, view) {
    if (side.series === "moves") {
      var mv = view.moves, z = 0;
      for (var i = 0; i < mv.length; i++) if (mv[i] === 0) z++;
      return 0.5 * (1 - (mv.length ? z / mv.length : 0));
    }
    var n = 0;
    for (var d = 0; d <= 9; d++) if (side.wins(d)) n++;
    return n / 10;
  }

  /* ── the reading ─────────────────────────────────────────────────────── */

  /** The figure for a lane's paper trades (oldest first: { won, p, d }, d the Martingale's
   *  depth after it — what the streak had cost, against the balance and stop loss) and its
   *  finished sessions ({ r, at }: at = the trade count when it ended; `count` is the count
   *  now). Everything from the past fades with the trades since. Pure. */
  function reading(outs, sessions, count, thin) {
    var n = outs.length;
    if (n < MIN_N) return null;
    count = count || n;
    var w = Math.min(n, WINDOW), wins = 0, exp = 0, varr = 0, pSum = 0;
    for (var i = n - w; i < n; i++) {
      var o = outs[i];
      if (o.won) wins++;
      exp += o.p; varr += o.p * (1 - o.p); pSum += o.p;
    }
    var p = Math.min(0.995, Math.max(0.005, pSum / w)), lq = Math.log(1 - p);
    var z = varr > 0 ? (wins - exp) / Math.sqrt(varr) : 0;
    z = Math.max(-3.5, Math.min(3.5, z));
    var zTerm = z > 0 ? K.zUp * Math.min(2, z) : -K.zDown * Math.max(0, -z - K.zFree);

    // The losing streak now, and the streaks before it (fading).
    var surprise = function (len) { return K.slope * Math.max(0, -len * lq - K.allow); };
    var cur = 0;
    for (var j = n - 1; j >= 0 && !outs[j].won; j--) cur++;
    var penCur = surprise(cur);
    // Each finished streak in the last K.span trades, weighed by how long ago it ended.
    var penPast = 0, run = 0, newest = -1, stop = Math.max(0, n - 1 - cur - K.span);
    for (var k = n - 1 - cur; k >= stop - 1; k--) {
      if (k >= stop && !outs[k].won) { if (!run) newest = k; run++; continue; }
      if (run) penPast = Math.max(penPast, surprise(run) * Math.exp(-((n - 1) - newest) / K.fade));
      run = 0;
    }

    // How deep the Martingale had to go — now, and lately (fading).
    var penDepth = 0;
    for (var d = n - 1, age = 0; d >= 0 && age < K.span; d--, age++) {
      var dv = outs[d].d || 0;
      if (dv > 0.35) penDepth = Math.max(penDepth, K.depth * (dv - 0.35) * Math.exp(-age / K.fade));
    }
    // Sessions lately lost to the stop loss or the balance (fading, more slowly).
    var penSess = 0;
    for (var s = 0; s < sessions.length; s++) {
      if (sessions[s].r === "tp") continue;
      var since = Math.max(0, count - (sessions[s].at || 0));
      if (since < 3 * K.span) penSess += K.sess * Math.exp(-since / (2 * K.fade));
    }
    var raw = K.base + zTerm - penCur - K.past * penPast - penDepth - penSess - (thin ? K.thin : 0);
    return Math.round(1000 / (1 + Math.exp(-raw))) / 10;
  }

  /** The state, moving from the last one with a little hysteresis. */
  function nextState(prev, pct, hold) {
    if (pct == null) return { state: "warm", hold: 0 };
    hold = hold || 0;
    if (pct < RED) return { state: "red", hold: 0 };
    if (prev === "red") return pct >= YELLOW_UP ? (hold + 1 >= 2 ? { state: "yellow", hold: 0 } : { state: "red", hold: hold + 1 }) : { state: "red", hold: 0 };
    if (prev === "green") return pct < GREEN_DOWN ? { state: "yellow", hold: 0 } : { state: "green", hold: 0 };
    if (pct >= GREEN) return hold + 1 >= (prev === "yellow" ? 3 : 1) ? { state: "green", hold: 0 } : { state: prev || "yellow", hold: hold + 1 };
    return { state: "yellow", hold: 0 };
  }

  /* ── the watch ───────────────────────────────────────────────────────── */

  function create(o) {
    var mk = {}, order = [], lanes = {}, started = false, replaying = 0;
    var listeners = [];

    function market(sym, name) {
      var m = mk[sym];
      if (!m) {
        m = mk[sym] = { sym: sym, name: name || sym, dec: 2, ep: [], q: [], view: null, last: 0 };
        order.push(sym);
        m.view = blankView(m);
      }
      if (name) { m.name = name; m.view.name = name; }
      return m;
    }
    function blankView(m) { return { sym: m.sym, name: m.name, dec: m.dec, digits: [], moves: [], times: [], ratio: {}, at: 0 }; }
    /** A view of one market as the pick reads it, moved on by one tick. */
    function step(v, q, prevQ, epoch, dec) {
      v.dec = dec;
      v.digits.push(lastDigit(q, dec));
      if (v.digits.length > LIVE) v.digits.splice(0, v.digits.length - LIVE);
      if (prevQ != null) {
        v.moves.push(Math.sign(fixed(q, dec) - fixed(prevQ, dec)));
        if (v.moves.length > LIVE) v.moves.splice(0, v.moves.length - LIVE);
      }
      v.times.push(epoch);
      if (v.times.length > TIMES) v.times.splice(0, v.times.length - TIMES);
      v.at = epoch * 1000;
      v.lastQ = q;
    }

    /* ── a lane: one type and prediction, traded on paper ── */
    function newLane(spec) {
      return { key: spec.key, spec: spec, pos: null, outs: [], sessions: [], sess: null, pct: null, state: "warm", hold: 0,
        live: false, thin: false, depth: 0, n: 0, decidedAt: 0 };
    }
    function freshSession(L) {
      var st = o.settings(L.spec) || {};
      L.sess = { stake0: st.stake, stake: st.stake, mult: st.mult, tp: st.tp, sl: st.sl, balance: st.balance, min: st.min || 0.35,
        pl: 0, n: 0, owed: 0, deep: 0, peak: 0, dd: 0 };
    }
    /** The settings can change (the user types a figure, a balance moves): the next stake
     *  after a win takes the new starting stake; a session in a streak keeps its own. */
    function refreshSession(L) {
      var st = o.settings(L.spec) || {}, s = L.sess;
      s.mult = st.mult; s.tp = st.tp; s.sl = st.sl; s.balance = st.balance; s.min = st.min || s.min;
      if (!s.owed) { s.stake0 = st.stake; s.stake = st.stake; }
    }

    function views(getView, now) {
      var list = [];
      for (var i = 0; i < order.length; i++) {
        var v = getView(order[i]);
        if (!v) continue;
        v.ratio = o.ratios(order[i]) || {};
        list.push(v);
      }
      return list;
    }

    /** Pick and "buy" at `now` (ms), on the markets as `getView` shows them. */
    function decide(L, getView, epoch) {
      var now = epoch * 1000, s = L.sess;
      if (!s || !(s.stake0 > 0)) { freshSession(L); s = L.sess; }
      if (!(s.stake0 > 0)) return;
      var list = views(getView, now);
      var live = 0;
      for (var i = 0; i < list.length; i++) {
        var v = list[i];
        if (now - v.at > 20000 || v.digits.length < 10) continue;
        for (var k = 0; k < L.spec.prices.length; k++) { var pk = L.spec.prices[k]; if (v.ratio[pk.ct + (pk.barrier != null ? ":" + pk.barrier : "")]) { live++; break; } }
      }
      L.thin = live < 3;
      var pick = o.choose(L.spec, list, now);
      if (!pick) return;
      var rec = null;
      if (s.stake > s.balance + 1e-9) {
        // The Martingale stake is more than the balance: recover as the bot would, else the session ends.
        rec = o.recovers(L.spec) && s.owed > 0 ? recovery(L, pick) : null;
        if (!rec) return endSession(L, "bal");
      }
      var side = rec ? rec.side : pick.side;
      L.pos = { sym: pick.m.sym, side: side, ratio: rec ? rec.ratio : pick.ratio, stake: rec ? rec.stake : s.stake, at: epoch, entry: null,
        p: rec ? rec.p : chanceOf(pick.side, getView(pick.m.sym) || pick.m), rec: !!rec, dec: (getView(pick.m.sym) || {}).dec };
      L.decidedAt = epoch;
    }
    /** The bot's recovery: the likeliest Over n (n from the type's own chance up to 4) whose
     *  stake, sized to win back the streak plus one ordinary win, the balance covers. */
    function recovery(L, pick) {
      var s = L.sess, need = round2(s.owed + Math.max(0, s.stake0 * (pick.ratio - 1)));
      var pType = chanceOf(pick.side, pick.m), from = Math.round(9 - 10 * pType) + 1;
      for (var n = Math.max(0, from); n <= 4; n++) {
        var r = o.recoverRatio(n);
        if (!(r > 1)) continue;
        var stake = Math.max(s.min, Math.ceil(need / (r - 1) * 100) / 100);
        if (stake > s.balance + 1e-9) continue;
        return { stake: stake, ratio: r, p: (9 - n) / 10, side: { key: "over" + n, series: "digits", wins: (function (n) { return function (d) { return d > n; }; })(n) } };
      }
      return null;
    }
    function endSession(L, why) {
      var s = L.sess;
      if (s && s.n) {
        L.sessions.push({ r: why, n: s.n, pl: s.pl, dd: s.dd, at: L.n });
        if (L.sessions.length > SESS) L.sessions.splice(0, L.sessions.length - SESS);
      }
      freshSession(L);
    }
    function settle(L, won) {
      var pos = L.pos, s = L.sess;
      L.pos = null;
      var pl = won ? round2(round2(pos.stake * pos.ratio) - pos.stake) : -pos.stake;
      s.pl = round2(s.pl + pl); s.n++;
      if (won) { s.owed = 0; s.stake = s.stake0; }
      else { s.owed = round2(s.owed + pos.stake); s.stake = round2(s.stake * s.mult); }
      s.deep = Math.max(s.deep, s.owed);
      s.peak = Math.max(s.peak, s.pl);
      s.dd = Math.max(s.dd, s.peak - s.pl);
      var limit = Math.min(s.sl > 0 ? s.sl : Infinity, s.balance > 0 ? s.balance : Infinity);
      var depth = isFinite(limit) && limit > 0 ? s.owed / limit : 0;
      L.depth = depth;
      if (!pos.rec) {
        L.outs.push({ won: won, p: pos.p, d: depth });
        if (L.outs.length > OUTS) L.outs.splice(0, L.outs.length - OUTS);
        L.n++;
      } else if (L.outs.length) {
        // A recovery trade is not the type's own, but the depth it reached is.
        var lo = L.outs[L.outs.length - 1];
        lo.d = Math.max(lo.d || 0, depth);
      }
      if (s.pl >= s.tp - 1e-9) endSession(L, "tp");
      else if (-s.pl >= s.sl - 1e-9) endSession(L, "sl");
      else refreshSession(L);
      evaluate(L);
    }
    function evaluate(L) {
      var pct = reading(L.outs, L.sessions, L.n, L.thin);
      var ns = nextState(L.state, pct, L.hold);
      var changed = ns.state !== L.state || pct !== L.pct;
      L.pct = pct; L.state = ns.state; L.hold = ns.hold;
      if (changed && L.live) emit(L);
    }
    function emit(L) { for (var i = 0; i < listeners.length; i++) { try { listeners[i](L.key, info(L)); } catch (e) {} } }

    /** One tick of one market, for one lane. */
    function laneTick(L, sym, epoch, q, getView) {
      var pos = L.pos;
      if (pos && pos.sym === sym && epoch > pos.at) {
        if (pos.entry == null) { pos.entry = q; pos.entryAt = epoch; return; }
        var won = pos.side.series === "moves"
          ? pos.side.wins(Math.sign(fixed(q, pos.dec) - fixed(pos.entry, pos.dec)))
          : pos.side.wins(lastDigit(q, pos.dec));
        if (o.trace) o.trace(L.key, pos, epoch, q, won);    // (tests)
        settle(L, won);
        decide(L, getView, epoch);
        return;
      }
      if (pos && epoch - pos.at > STALE && (mk[pos.sym] ? epoch - (mk[pos.sym].last || 0) > STALE : true)) L.pos = null;   // its market went quiet: no trade
      if (!L.pos && epoch > L.decidedAt) decide(L, getView, epoch);
    }

    /* ── ticks ── */

    /** A live tick: kept, and traded by every lane that is live (a lane being replayed
     *  meets it in its replay instead). */
    function feed(sym, epoch, quote, dec, name) {
      var m = market(sym, name);
      if (!(epoch > m.last)) return;
      var prev = m.q.length ? m.q[m.q.length - 1] : null;
      m.ep.push(epoch); m.q.push(Number(quote)); m.dec = dec; m.last = epoch;
      if (m.ep.length > HIST && !replaying) { m.ep.splice(0, m.ep.length - HIST); m.q.splice(0, m.q.length - HIST); }
      step(m.view, Number(quote), prev, epoch, dec);
      var get = function (s) { return mk[s] && mk[s].view; };
      for (var k in lanes) if (lanes[k].live) laneTick(lanes[k], sym, epoch, Number(quote), get);
    }
    /** A market's recent history (oldest first), merged by time with what is already here —
     *  it fills a gap as well as the start. Held over while a replay reads the buffers. */
    var loads = [];
    function load(sym, times, prices, dec, name) {
      if (replaying) { loads.push([sym, times, prices, dec, name]); return; }
      var m = market(sym, name), at = {};
      for (var i = 0; i < times.length; i++) at[Number(times[i])] = Number(prices[i]);
      for (var j = 0; j < m.ep.length; j++) at[m.ep[j]] = m.q[j];
      var ep = Object.keys(at).map(Number).sort(function (a, b) { return a - b; }).slice(-HIST);
      m.ep = ep;
      m.q = ep.map(function (e) { return at[e]; });
      m.dec = dec;
      m.last = ep.length ? ep[ep.length - 1] : 0;
      if (!m.view.at) {
        // Nothing live yet: the pick's view starts from the history's last ticks.
        m.view = blankView(m);
        for (var k = Math.max(0, ep.length - LIVE - 1); k < ep.length; k++) step(m.view, m.q[k], k > 0 ? m.q[k - 1] : null, ep[k], dec);
      }
    }

    /** Every tick in the buffers, oldest first, through `targets`; then those lanes go live.
     *  In slices, so a phone's page stays smooth; `sync` for tests. */
    function replay(targets, sync, done) {
      replaying++;
      var cur = {}, vw = {};
      order.forEach(function (s) { cur[s] = 0; vw[s] = blankView(mk[s]); vw[s].name = mk[s].name; });
      var get = function (s) { return vw[s]; };
      targets.forEach(function (L) { L.pos = null; L.outs = []; L.sessions = []; L.sess = null; L.n = 0; L.decidedAt = 0; L.state = "warm"; L.pct = null; L.hold = 0; L.live = false; });
      function next() {
        var best = null, bestE = Infinity;
        for (var i = 0; i < order.length; i++) {
          var s = order[i], m = mk[s];
          if (cur[s] < m.ep.length && m.ep[cur[s]] < bestE) { bestE = m.ep[cur[s]]; best = s; }
        }
        return best;
      }
      function slice() {
        var budget = sync ? Infinity : 2500;
        for (var c = 0; c < budget; c++) {
          var s = next();
          if (s == null) return finish();
          var m = mk[s], i = cur[s]++, q = m.q[i], e = m.ep[i];
          step(vw[s], q, i > 0 ? m.q[i - 1] : null, e, m.dec);
          for (var t = 0; t < targets.length; t++) laneTick(targets[t], s, e, q, get);
        }
        setTimeout(slice, 0);
      }
      function finish() {
        // The replay's views hold the history the live ones may lack: they carry on from here.
        order.forEach(function (s) { if (vw[s].at >= mk[s].view.at) mk[s].view = vw[s]; });
        replaying--;
        if (!replaying) {
          order.forEach(function (s) { var m = mk[s]; if (m.ep.length > HIST) { m.ep.splice(0, m.ep.length - HIST); m.q.splice(0, m.q.length - HIST); } });
          var held = loads; loads = [];
          held.forEach(function (a) { load.apply(null, a); });
        }
        targets.forEach(function (L) { L.live = !!lanes[L.key]; if (L.live) { evaluate(L); emit(L); } });
        if (done) done();
      }
      slice();
    }

    function track(spec) {
      if (lanes[spec.key]) return lanes[spec.key];
      var L = lanes[spec.key] = newLane(spec);
      if (started) replay([L]);
      return L;
    }
    function untrack(key) { delete lanes[key]; }
    /** A lane read again from the start of the buffers (its prices came in late). */
    function rewind(key, sync, done) { var L = lanes[key]; if (L && started) replay([L], sync, done); }
    function start(sync, done) {
      started = true;
      var all = Object.keys(lanes).map(function (k) { return lanes[k]; });
      replay(all, sync, done);
    }
    function info(L) {
      return { key: L.key, state: L.state, pct: L.pct, n: L.n, warm: L.state === "warm" ? Math.min(1, L.n / MIN_N) : 1, thin: L.thin,
        streak: (function () { var c = 0; for (var i = L.outs.length - 1; i >= 0 && !L.outs[i].won; i--) c++; return c; })(),
        sessions: L.sessions.slice(), session: L.sess ? { pl: L.sess.pl, n: L.sess.n, owed: L.sess.owed } : null };
    }
    function state(key) { var L = lanes[key]; return L ? (L.live ? info(L) : { key: key, state: "warm", pct: null, n: 0, warm: 0 }) : null; }

    return {
      feed: feed, load: load, start: start, track: track, untrack: untrack, rewind: rewind, state: state,
      keys: function () { return Object.keys(lanes); }, started: function () { return started; },
      markets: function () { return order.slice(); }, size: function (sym) { return mk[sym] ? mk[sym].ep.length : 0; },
      on: function (f) { listeners.push(f); },
      lane: function (key) { return lanes[key] || null; },   // (tests)
    };
  }

  global.ShaloWatch = { create: create, reading: reading, nextState: nextState, chanceOf: chanceOf, K: K,
    levels: { GREEN: GREEN, RED: RED, YELLOW_UP: YELLOW_UP, GREEN_DOWN: GREEN_DOWN } };
})(typeof window !== "undefined" ? window : globalThis);
