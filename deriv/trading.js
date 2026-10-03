/**
 * SHALOBOT — /trading: the Deriv connection, and the live balance.
 *
 * What happens when the page opens:
 *
 *   1. Back from Deriv?  The address carries ?code&state (or ?error&state).
 *      They go straight to /api/deriv/callback — the server holds the PKCE
 *      verifier and does the exchange — and come out of the address bar and
 *      history at once: a code is single use and nobody should be able to
 *      copy it out of a screenshot.
 *   2. /api/deriv/session?otp=1 says whether this browser is connected and
 *      hands back every account with its balance AND a one-time WebSocket URL
 *      for each, so the live feeds open in the same moment the page paints.
 *   3. One socket per account (Deriv authorises a socket for exactly one
 *      account), each subscribed to balance. Demo and real are both live, so
 *      switching is instant and both figures are always current.
 *
 * Staying connected, which is the whole point of the page:
 *
 *   - a ping every 20 s keeps proxies from closing a quiet socket and proves
 *     the line is alive; a socket that has said nothing for 50 s is treated as
 *     dead even if the browser still calls it open (a phone that slept, a
 *     network that changed under it) and is replaced;
 *   - every reopen asks the server for a NEW one-time URL (single use, 120 s)
 *     and backs off 0.5 s, 1 s, 2 s … up to 30 s, with jitter so a Deriv blip
 *     does not bring every open tab back in the same instant;
 *   - coming back online, or back to the tab, reopens anything not live at
 *     once instead of waiting out a backoff the browser froze;
 *   - while a feed is down the balance is still fetched over REST every 15 s,
 *     so the figure in the header is never older than that.
 *
 * The 30-day token is renewed before it lapses with a prompt=none round trip
 * to Deriv — no screen at all for somebody still signed in there. If Deriv
 * has to ask, a renewal that was only early is dropped (the current token
 * still has days left); a token that has actually lapsed goes to Deriv's
 * sign-in, and that is the only time anybody sees it again.
 */

(function (global) {
  "use strict";

  var FLAG = "shalo_deriv";            // localStorage: this browser has connected
  var PICK = "shalo_deriv_pick";       // localStorage: the account last shown
  var RENEW_AT = "shalo_deriv_renew";  // localStorage: when an early renewal was last tried
  var LAST = "shalo_deriv_last";       // localStorage: the last balances seen — figures only, never a token
  var SILENT = "shalo_deriv_silent";   // sessionStorage: { at, soft } for the round trip in flight

  var PING_MS = 20000;
  var STALE_MS = 50000;
  var POLL_MS = 15000;

  var $ = function (id) { return document.getElementById(id); };
  var T = function (s) { return typeof global.t === "function" ? global.t(s) : s; };

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  var tab = {
    get: function (k) { try { return JSON.parse(sessionStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { sessionStorage.removeItem(k); } catch (e) {} },
  };

  /* ── talking to our own server ─────────────────────────────────────── */

  /** JSON for any HTTP status — the endpoints answer errors in JSON too and
   *  the status is part of the answer. Rejects only when nothing came back. */
  function call(method, url, body) {
    return fetch(url, {
      method: method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        j = j || {};
        j._status = res.status;
        return j;
      });
    });
  }

  /* ── the states the page shows before there are balances ───────────── */

  /* Once the chip is on screen — from the last visit's figures or live ones —
     a check running behind it does not need a spinner in front of it. */
  var painted = false;

  function showBusy(text) {
    if (painted) return;
    $("tState").hidden = false;
    $("tBusy").hidden = false;
    $("tConnect").hidden = true;
    $("tNote").hidden = true;
    $("tBusyText").textContent = T(text || "Connecting to Deriv…");
  }
  function showConnect(message) {
    $("tState").hidden = false;
    $("tBusy").hidden = true;
    $("tNote").hidden = true;
    $("tConnect").hidden = false;
    $("tConnectMsg").textContent = T(message || "Sign in on Deriv's own page and come straight back. Shalobot never sees your password.");
    $("acct").hidden = true;
    painted = false;
  }
  function showNote(text) {
    painted = false;
    $("acct").hidden = true;
    $("tState").hidden = false;
    $("tBusy").hidden = true;
    $("tConnect").hidden = true;
    $("tNote").hidden = false;
    $("tNoteText").textContent = T(text);
  }
  function clearState() { $("tState").hidden = true; }

  /* ── renewing the token ────────────────────────────────────────────── */

  /** To Deriv with prompt=none. `soft` means the current token still works:
   *  if Deriv would have to ask, the renewal is simply dropped. Guarded so a
   *  refusal can never become a redirect loop. */
  function silentRenew(soft) {
    var last = tab.get(SILENT);
    if (last && Date.now() - last.at < 3 * 60 * 1000) return false;
    tab.set(SILENT, { at: Date.now(), soft: !!soft });
    if (soft) store.set(RENEW_AT, String(Date.now()));
    showBusy("Keeping you connected…");
    global.location.replace("/api/deriv/start?mode=silent");
    return true;
  }
  function renewDue() {
    var last = Number(store.get(RENEW_AT) || 0);
    return Date.now() - last > 12 * 3600 * 1000;
  }
  function login() { global.location.href = "/api/deriv/start"; }

  /* ── 1. back from Deriv ────────────────────────────────────────────── */

  function finishSignIn(q) {
    showBusy("Finishing the sign-in…");
    var body = { state: q.get("state") || "" };
    if (q.get("code")) body.code = q.get("code");
    else { body.error = q.get("error") || "error"; body.error_description = q.get("error_description") || ""; }
    try { history.replaceState(null, "", "/trading"); } catch (e) {}

    var flight = tab.get(SILENT);
    tab.del(SILENT);

    return call("POST", "/api/deriv/callback", body).then(function (r) {
      if (r.ok) {
        store.set(FLAG, "1");
        store.set(RENEW_AT, String(Date.now()));
        return boot();
      }
      var askedToInteract = /login_required|consent_required|interaction_required|account_selection_required/.test(r.error || "");
      if (r.mode === "silent" && askedToInteract) {
        // An early renewal Deriv would need to ask about: keep the token we have.
        if (flight && flight.soft) return boot();
        return login();
      }
      if (r.error === "access_denied") return showConnect("You chose not to connect. Connect whenever you are ready.");
      return showConnect(r.message || "Deriv could not finish the sign-in. Please connect again.");
    }, function () {
      showConnect("Could not reach Shalobot. Check your connection and try again.");
    });
  }

  /* ── 2. the session ────────────────────────────────────────────────── */

  var bootTries = 0;
  function boot() {
    showBusy();
    return call("GET", "/api/deriv/session?otp=1").then(function (r) {
      if (r._status === 503 || r._status >= 500) return bootLater();
      bootTries = 0;
      if (r.connected) {
        store.set(FLAG, "1");
        if (r.renewSoon && renewDue() && silentRenew(true)) return;
        return start(r);
      }
      // Never connected here: the door. Connected before: renew without a screen.
      if (r.reason === "expired" || store.get(FLAG) === "1") {
        if (silentRenew(false)) return;
        return showConnect("Please sign in to Deriv again to carry on.");
      }
      return showConnect();
    }, bootLater);
  }
  function bootLater() {
    bootTries++;
    showBusy("Deriv is not answering yet — trying again…");
    setTimeout(boot, Math.min(30000, 1000 * Math.pow(2, bootTries)) * (0.75 + Math.random() * 0.5));
  }

  /* ── 3. accounts and their live feeds ──────────────────────────────── */

  var accounts = [];      // { id, type, currency, balance, status }
  var feeds = {};         // id → Feed
  var picked = null;      // the id shown in the chip

  function start(r) {
    accounts = (r.accounts || []).map(function (a) {
      return { id: a.id, type: a.type === "real" ? "real" : "demo", currency: a.currency || "", balance: a.balance, status: a.status || "active", at: Date.now() };
    });

    if (!accounts.length) {
      $("acct").hidden = true;
      return showNote(r.migration === "pending"
        ? "Deriv is upgrading your account. Your balances appear here as soon as it is done — keep this page open."
        : "This Deriv login has no trading accounts yet. Open one on Deriv, then come back here.");
    }

    var saved = store.get(PICK);
    var active = accounts.filter(function (a) { return a.status === "active"; });
    var byId = function (id) { return accounts.filter(function (a) { return a.id === id; })[0]; };
    picked = (saved && byId(saved) && saved) ||
      ((active.filter(function (a) { return a.type === "real"; })[0] || active[0] || accounts[0]).id);

    clearState();
    $("acct").hidden = false;
    painted = true;
    paint();

    (r.accounts || []).forEach(function (a) {
      if (a.status !== "active") return;
      var f = feeds[a.id] || (feeds[a.id] = new Feed(a.id));
      if (a.ws) f.open(a.ws); else f.retry();
    });
    startPolling();
  }

  function account(id) { return accounts.filter(function (a) { return a.id === id; })[0] || null; }

  /* ── money ─────────────────────────────────────────────────────────── */

  var CRYPTO = /^(BTC|ETH|LTC|USDT|USDC|EUSDT|TUSDT|UST|XRP|BCH|TRX|DOGE)$/i;
  function money(v, cur) {
    if (v == null || !isFinite(v)) return "—";
    var max = CRYPTO.test(cur || "") ? 8 : 2;
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency", currency: cur || "USD", currencyDisplay: "narrowSymbol",
        minimumFractionDigits: 2, maximumFractionDigits: max,
      }).format(v);
    } catch (e) {
      return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: max }) + " " + (cur || "");
    }
  }

  /* ── painting ──────────────────────────────────────────────────────── */

  var CHECK = '<svg class="tbal-row-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };

  var savedAt = 0, saveLater = 0;
  function saveLast() {
    var wait = 2000 - (Date.now() - savedAt);
    if (wait > 0) {                       // at most every 2 s, but never dropping the last figure
      if (!saveLater) saveLater = setTimeout(function () { saveLater = 0; saveLast(); }, wait);
      return;
    }
    savedAt = Date.now();
    store.set(LAST, JSON.stringify(accounts.map(function (a) {
      return { id: a.id, type: a.type, currency: a.currency, balance: a.balance, status: a.status };
    })));
  }

  /** The figures from last time, on screen before any request has gone out.
   *  The dot stays grey until Deriv itself has spoken on this visit. */
  function paintLast() {
    if (store.get(FLAG) !== "1") return;
    var list = null;
    try { list = JSON.parse(store.get(LAST) || "null"); } catch (e) { list = null; }
    if (!Array.isArray(list) || !list.length) return;
    accounts = list.filter(function (a) { return a && a.id; }).map(function (a) {
      return { id: String(a.id), type: a.type === "real" ? "real" : "demo", currency: a.currency || "", balance: a.balance, status: a.status || "active", at: 0 };
    });
    if (!accounts.length) return;
    var saved = store.get(PICK);
    picked = (saved && account(saved) && saved) ||
      ((accounts.filter(function (a) { return a.type === "real" && a.status === "active"; })[0] || accounts[0]).id);
    $("acct").hidden = false;
    painted = true;
    paint();
  }

  function paint() {
    var a = account(picked);
    if (!a) return;
    saveLast();
    var box = $("acct");
    var f = feeds[a.id];
    box.classList.toggle("is-real", a.type === "real");
    box.classList.toggle("is-demo", a.type !== "real");
    box.classList.toggle("is-live", !!(f && f.live));
    box.classList.toggle("is-wait", !!(f && !f.live && f.started));
    $("acctKind").textContent = a.type === "real" ? T("Real") : T("Demo");
    $("acctAmt").textContent = money(a.balance, a.currency);
    $("acctBtn").setAttribute("aria-label", (a.type === "real" ? T("Real") : T("Demo")) + " " + money(a.balance, a.currency));
    if (!$("acctMenu").hidden) paintMenu();
  }

  function paintMenu() {
    var order = accounts.slice().sort(function (x, y) {
      if (x.type !== y.type) return x.type === "real" ? -1 : 1;
      return (y.balance || 0) - (x.balance || 0);
    });
    var html = order.map(function (a) {
      var real = a.type === "real";
      return '<button type="button" role="menuitemradio" class="tbal-row ' + (real ? "is-real" : "is-demo") + '" data-id="' + esc(a.id) + '"' +
        ' aria-checked="' + (a.id === picked) + '"' + (a.status !== "active" ? " disabled" : "") + ">" +
        CHECK +
        '<span class="tbal-row-t"><span class="tbal-row-k">' + esc(real ? T("Real account") : T("Demo account")) + "</span>" +
        '<span class="tbal-row-id" translate="no">' + esc(a.id) + (a.status !== "active" ? " · " + esc(T("inactive")) : "") + "</span></span>" +
        '<span class="tbal-row-v" translate="no">' + esc(money(a.balance, a.currency)) + "</span></button>";
    }).join("");
    if (!order.some(function (a) { return a.type === "real"; })) {
      html += '<p class="tbal-empty">' + esc(T("No real account on this Deriv login yet.")) + "</p>";
    }
    $("acctList").innerHTML = html;
  }

  /* ── the switcher ──────────────────────────────────────────────────── */

  function openMenu(open) {
    var menu = $("acctMenu");
    menu.hidden = !open;
    $("acctBtn").setAttribute("aria-expanded", String(open));
    if (open) {
      paintMenu();
      var on = menu.querySelector('[aria-checked="true"]');
      if (on) on.focus();
    }
  }

  function bindSwitcher() {
    /* The chip's click is left to bubble, so the language list beside it hears
       it and closes; any click outside the chip and its list closes the list,
       seen in the capture phase because the language button stops its own. */
    $("acctBtn").addEventListener("click", function () {
      openMenu($("acctMenu").hidden);
    });
    document.addEventListener("click", function (e) {
      if (!$("acctMenu").hidden && !e.target.closest("#acct")) openMenu(false);
    }, true);
    $("acctMenu").addEventListener("click", function (e) {
      var row = e.target.closest(".tbal-row");
      if (row && !row.disabled) {
        picked = row.getAttribute("data-id");
        store.set(PICK, picked);
        openMenu(false);
        paint();
        $("acctBtn").focus();
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !$("acctMenu").hidden) { openMenu(false); $("acctBtn").focus(); }
    });
    $("acctOut").addEventListener("click", function () {
      $("acctOut").disabled = true;
      Object.keys(feeds).forEach(function (id) { feeds[id].stop(); });
      call("POST", "/api/deriv/logout").then(done, done);
      function done() {
        store.del(FLAG); store.del(PICK); store.del(RENEW_AT); store.del(LAST);
        global.location.replace("/");
      }
    });
  }

  /* ── one live feed per account ─────────────────────────────────────── */

  function Feed(id) {
    this.id = id;
    this.ws = null;
    this.live = false;       // a balance has arrived on the current socket
    this.started = false;    // has ever tried to connect
    this.tries = 0;
    this.last = 0;           // the last message of any kind
    this.timer = 0;
    this.pinger = 0;
    this.stopped = false;
  }

  Feed.prototype.open = function (url) {
    var self = this;
    this.close();
    this.started = true;
    var ws;
    try { ws = new WebSocket(url); } catch (e) { return this.retry(); }
    this.ws = ws;

    // A socket that never opens is a socket that failed; do not wait on it.
    var guard = setTimeout(function () { if (ws.readyState !== 1) { try { ws.close(); } catch (e) {} } }, 12000);

    ws.onopen = function () {
      clearTimeout(guard);
      self.last = Date.now();
      ws.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 1 }));
      self.pinger = setInterval(function () { self.beat(); }, PING_MS);
    };
    ws.onmessage = function (ev) {
      self.last = Date.now();
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.error) {
        // A refused subscription means this socket cannot serve a balance:
        // replace it rather than sit on a feed that will never speak.
        if (m.msg_type === "balance") self.drop();
        return;
      }
      if (m.msg_type === "balance" && m.balance) {
        var a = account(self.id);
        if (a) {
          a.balance = Number(m.balance.balance);
          if (m.balance.currency) a.currency = m.balance.currency;
          a.at = Date.now();
        }
        self.live = true;
        self.tries = 0;
        paint();
      }
    };
    ws.onclose = function () {
      clearTimeout(guard);
      if (self.ws !== ws) return;          // an old socket we already replaced
      self.ws = null;
      self.live = false;
      clearInterval(self.pinger);
      paint();
      if (!self.stopped) self.retry();
    };
    ws.onerror = function () { /* onclose follows and handles it */ };
  };

  Feed.prototype.beat = function () {
    if (!this.ws || this.ws.readyState !== 1) return;
    if (Date.now() - this.last > STALE_MS) return this.drop();
    try { this.ws.send(JSON.stringify({ ping: 1 })); } catch (e) { this.drop(); }
  };

  /** Close the current socket without counting it as a failure of the line. */
  Feed.prototype.close = function () {
    clearInterval(this.pinger);
    clearTimeout(this.timer);
    var ws = this.ws;
    this.ws = null;
    this.live = false;
    if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} }
  };

  /** Throw away a socket that has gone quiet or bad, and open another now. */
  Feed.prototype.drop = function () { this.close(); this.retry(true); };

  Feed.prototype.stop = function () { this.stopped = true; this.close(); };

  Feed.prototype.retry = function (now) {
    var self = this;
    if (this.stopped) return;
    clearTimeout(this.timer);
    var wait = now ? 0 : Math.min(30000, 500 * Math.pow(2, this.tries)) * (0.75 + Math.random() * 0.5);
    this.tries = Math.min(this.tries + 1, 10);
    paint();
    this.timer = setTimeout(function () {
      if (self.stopped) return;
      if (navigator.onLine === false) return;          // "online" brings it back
      call("POST", "/api/deriv/otp", { account: self.id }).then(function (r) {
        if (self.stopped) return;
        if (r.url) return self.open(r.url);
        if (r._status === 401) return expired();
        self.retry();
      }, function () { self.retry(); });
    }, wait);
  };

  /** Reopen anything that is not live, at once — after the network or the
   *  tab comes back, a backoff timer the browser froze is not worth waiting out. */
  function revive() {
    Object.keys(feeds).forEach(function (id) {
      var f = feeds[id];
      if (f.stopped) return;
      var stale = Date.now() - f.last > STALE_MS;
      if (!f.ws || f.ws.readyState > 1 || stale) { f.close(); f.tries = 0; f.retry(true); }
    });
  }

  var gone = false;
  function expired() {
    if (gone) return;
    gone = true;
    Object.keys(feeds).forEach(function (id) { feeds[id].stop(); });
    if (!silentRenew(false)) showConnect("Please sign in to Deriv again to carry on.");
  }

  /* ── the REST safety net ───────────────────────────────────────────── */

  var polling = 0;
  function startPolling() {
    if (polling) return;
    polling = setInterval(function () {
      if (document.visibilityState === "hidden") return;
      var a = account(picked);
      var f = a && feeds[a.id];
      if (f && f.live) return;                          // the socket is doing the job
      call("GET", "/api/deriv/session").then(function (r) {
        if (r.connected === false) return expired();
        (r.accounts || []).forEach(function (n) {
          var o = account(n.id);
          var nf = feeds[n.id];
          if (o && !(nf && nf.live) && n.balance != null) { o.balance = n.balance; o.currency = n.currency || o.currency; o.at = Date.now(); }
        });
        paint();
      }, function () {});
    }, POLL_MS);
  }

  /* ── go ────────────────────────────────────────────────────────────── */

  bindSwitcher();
  global.addEventListener("online", revive);
  global.addEventListener("offline", function () { paint(); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") revive(); });
  global.addEventListener("pageshow", function (e) { if (e.persisted) revive(); });
  global.addEventListener("langchange", function () { paint(); });

  var q = new URLSearchParams(global.location.search);
  if (q.get("state") && (q.get("code") || q.get("error"))) finishSignIn(q);
  else { paintLast(); boot(); }

  // For debugging in the console: the live state, never a token (there is none here).
  global.ShaloDeriv = { accounts: function () { return accounts; }, feeds: feeds, revive: revive };
})(window);
