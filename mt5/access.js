/**
 * SHALOBOT — the access sheet on the MT5 page.
 *
 * The EA is free but not public. One form asks for the Deriv ID that proves
 * somebody is in our community, plus a name and an email; that lands in
 * Telegram through the support pipe, and the answer — a download code, or a
 * reason and the partner ID to give Deriv — comes back into the support
 * bubble on this page. The code unlocks the file, on this browser only.
 *
 * Three phases. `form`: the fields. `sent`: the fields fold into one line
 * and the code field opens, because that is now the only thing to do here.
 * `done`: the file is in their downloads. Name and email are remembered in
 * this browser, so a second visit only ever types the ID.
 */
(function () {
  "use strict";

  var T = function (s, vars) {
    var out = (typeof window.t === "function") ? window.t(s) : s;
    if (vars) for (var k in vars) out = out.split("{" + k + "}").join(String(vars[k]));
    return out;
  };
  var $ = function (id) { return document.getElementById(id); };
  var get = function (k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } };
  var set = function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} };
  var isEmail = function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || "").trim()); };

  var NAME_KEY = "shalo_support_name";
  var MAIL_KEY = "shalo_support_email";
  var ID_KEY = "shalo_support_id";
  var SENT_KEY = "shalo_ea_sent";     // the ID a request went out for, so a reload keeps the sent state
  var SENDS_KEY = "shalo_ea_sends";   // how many times since we last answered, and when
  var THREAD_KEY = "shalo_support_thread";
  var MAX_SENDS = 3;

  /* ── how many more times they may send ──────────────────────────────────
     A mistake in the ID is fixed by editing and sending again; a script
     hammering the form is not. Three sends, then a wait for our answer —
     and any reply from us in the support thread, arriving after the last
     send, resets the count. The thread is what the bubble keeps in this
     browser, so this needs no extra call. */
  function sends() {
    try { var v = JSON.parse(get(SENDS_KEY) || "null"); if (v && typeof v.n === "number") return v; } catch (e) {}
    return { n: 0, at: "" };
  }
  function repliedSince(iso) {
    if (!iso) return false;
    try {
      var thread = JSON.parse(get(THREAD_KEY) || "[]");
      return thread.some(function (l) { return l && l.from === "us" && !l.system && String(l.at || "") > iso; });
    } catch (e) { return false; }
  }
  function sendsLeft() {
    var v = sends();
    if (v.n > 0 && repliedSince(v.at)) { v = { n: 0, at: "" }; set(SENDS_KEY, JSON.stringify(v)); }
    return Math.max(0, MAX_SENDS - v.n);
  }
  function countSend() {
    var v = sends();
    set(SENDS_KEY, JSON.stringify({ n: v.n + 1, at: new Date().toISOString() }));
  }

  /** The same browser id the support bubble uses — the code is bound to it. */
  function visitorId() {
    if (window.SHALO_SUPPORT_ID) return window.SHALO_SUPPORT_ID;
    var id = get(ID_KEY);
    if (/^[0-9A-F]{8}$/.test(id)) return id;
    var b = new Uint8Array(4);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(b) : b.forEach(function (_, i) { b[i] = Math.random() * 256; });
    id = Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("").toUpperCase();
    set(ID_KEY, id);
    return id;
  }

  var root = $("eaRoot");
  if (!root) return;

  var phase = "form";   // form | sent | done
  var busy = false;
  var codeOpen = false;

  function showErr(msg) {
    if (msg && typeof window.tm === "function") msg = window.tm(msg);
    var e = $("eaErr");
    e.textContent = msg || "";
    e.hidden = !msg;
  }
  function formOk() {
    return $("eaId").value.trim().length > 0 && $("eaName").value.trim().length > 1 && isEmail($("eaMail").value);
  }

  function paint() {
    var sent = phase === "sent";
    $("eaForm").hidden = phase === "done";
    $("eaDone").hidden = phase !== "done";
    $("eaFields").hidden = sent;
    $("eaSummary").hidden = !sent;
    $("eaSent").hidden = !sent;
    $("eaHaveCode").hidden = sent || codeOpen;
    $("eaCodeField").hidden = !(sent || codeOpen);
    var left = sendsLeft();
    $("eaSend").disabled = !formOk() || busy || left === 0;
    $("eaLimit").hidden = left > 0;
    $("eaRedeem").disabled = !$("eaCode").value.trim() || busy;
    if (sent) {
      $("eaSumId").textContent = $("eaId").value.trim();
      $("eaSumWho").textContent = $("eaName").value.trim() + " · " + $("eaMail").value.trim();
    }
    Array.prototype.forEach.call($("eaTrack").children, function (li) {
      var k = li.getAttribute("data-k");
      var idx = ["form", "sent", "done"].indexOf(k), cur = ["form", "sent", "done"].indexOf(phase);
      li.classList.toggle("on", idx === cur);
      li.classList.toggle("past", idx < cur);
    });
  }

  function open() {
    if (!$("eaName").value) $("eaName").value = get(NAME_KEY);
    if (!$("eaMail").value) $("eaMail").value = get(MAIL_KEY);
    // A request already sent from this browser stays sent across a reload —
    // the code is on its way and the form has nothing to add.
    var sentFor = get(SENT_KEY);
    if (sentFor && phase === "form") { $("eaId").value = sentFor; phase = "sent"; }
    root.hidden = false;
    document.body.classList.add("ea-open");
    paint();
    setTimeout(function () { (phase === "sent" ? $("eaCode") : $("eaId")).focus(); }, 80);
  }
  function close() {
    root.hidden = true;
    document.body.classList.remove("ea-open");
  }

  function send() {
    if (busy || !formOk() || sendsLeft() === 0) return;
    busy = true; showErr(null); paint();
    var id = $("eaId").value.trim(), name = $("eaName").value.trim(), email = $("eaMail").value.trim();

    fetch("/api/mt5/ea-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitorId: visitorId(), mt5Login: id, name: name, email: email, page: location.pathname }),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) throw new Error(x.j.error || T("Could not send that. Try again in a moment."));
        set(NAME_KEY, name); set(MAIL_KEY, email); set(SENT_KEY, id);
        countSend();
        phase = "sent";
        openWait();
        /* The bubble opens onto THIS conversation, with the request already in
           it, rather than onto an empty window. The answer lands there. */
        if (window.SHALO_SUPPORT_ASK) {
          window.SHALO_SUPPORT_ASK({
            name: name, email: email,
            text: T(x.j.already ? "Asked for the Shalobot EA again — MT5 ID {id}." : "Requested the Shalobot EA — MT5 ID {id}.", { id: id }),
          });
        }
      })
      .catch(function (e) { showErr((e && e.message) || T("Could not send that.")); })
      .then(function () { busy = false; paint(); });
  }

  function redeem() {
    var code = $("eaCode").value.trim();
    if (busy || !code) return;
    busy = true; showErr(null); paint();

    fetch("/api/mt5/ea-download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code, visitorId: visitorId() }),
    })
      .then(function (r) {
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || T("That code was not accepted.")); });
        return r.blob();
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url; a.download = "ShalobotMT5.mq5";
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        phase = "done";
      })
      .catch(function (e) { showErr((e && e.message) || T("That code was not accepted.")); })
      .then(function () { busy = false; paint(); });
  }

  /* ── wiring ─────────────────────────────────────────────────────────── */
  $("get-ea").addEventListener("click", open);
  $("eaClose").addEventListener("click", close);

  /* The wait card: opened by a successful send, and again from the note. */
  function openWait() { $("waitRoot").hidden = false; }
  function closeWait() { $("waitRoot").hidden = true; }
  $("eaWaitOpen").addEventListener("click", openWait);
  $("waitClose").addEventListener("click", closeWait);
  $("waitDone").addEventListener("click", closeWait);
  $("waitRoot").addEventListener("click", function (e) { if (e.target === $("waitRoot")) closeWait(); });
  $("eaDoneClose").addEventListener("click", close);
  root.addEventListener("mousedown", function (e) { if (e.target === root) close(); });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!$("waitRoot").hidden) closeWait(); else if (!root.hidden) close();
  });
  ["eaId", "eaName", "eaMail", "eaCode"].forEach(function (id) { $(id).addEventListener("input", paint); });
  $("eaSend").addEventListener("click", send);
  $("eaRedeem").addEventListener("click", redeem);
  $("eaCode").addEventListener("keydown", function (e) { if (e.key === "Enter") redeem(); });
  $("eaMail").addEventListener("keydown", function (e) { if (e.key === "Enter") send(); });
  $("eaHaveCode").addEventListener("click", function () { codeOpen = true; paint(); $("eaCode").focus(); });
  $("eaEdit").addEventListener("click", function () { phase = "form"; set(SENT_KEY, ""); paint(); $("eaId").focus(); });

  // Our reply landing in the bubble is what unlocks sending again.
  window.addEventListener("shalo:support-reply", function () { if (!root.hidden) paint(); });

  // /mt5.html#get opens straight onto the sheet, for links that promise the file.
  if (location.hash === "#get") open();
})();
