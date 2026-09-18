/**
 * SHALOBOT — the access sheet on the MT5 page.
 *
 * The EA is free but not public. One form asks for the name and email
 * registered at Headway — that is what proves somebody is in our community —
 * plus a phone number and the channel to guide them on; that lands in
 * Telegram through the support pipe, and the answer — a download code, or a
 * reason and the partner ID to give Headway — comes back into the support
 * bubble on this page. The code unlocks the file, on this browser only.
 *
 * Three phases. `form`: the fields. `sent`: the fields fold into one line
 * and the code field opens, because that is now the only thing to do here.
 * `done`: the file is in their downloads. Name and email are remembered in
 * this browser, so a second visit only ever checks them.
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
  var SENT_KEY = "shalo_ea_sent";     // the phone a request went out for, so a reload keeps the sent state
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
  /* ── phone: country code + number, and the channel ───────────────────────
     The country is DETECTED, never demanded: the edge tells us where the
     request came from (/api/geo), the browser's locale is the fallback, and a
     choice made here is remembered and wins over both next time. The list is
     every country, searchable by name (in the visitor's language), by ISO code
     or by calling code. Nothing is forced — the person types the number they
     want to be reached on. */
  var CC_KEY = "shalo_cc", PHONE_KEY = "shalo_phone", CHAN_KEY = "shalo_contact";
  var COUNTRIES = window.DIAL_COUNTRIES || [];
  var cc = null;                                    // the chosen [iso, name, dial]
  var chan = get(CHAN_KEY) === "telegram" ? "telegram" : (get(CHAN_KEY) === "whatsapp" ? "whatsapp" : "");
  var namesOf = null;
  try { namesOf = new Intl.DisplayNames([document.documentElement.lang || "en"], { type: "region" }); } catch (e) { namesOf = null; }
  function countryName(c) {
    if (namesOf) { try { var n = namesOf.of(c[0]); if (n && n !== c[0]) return n; } catch (e) {} }
    return c[1];
  }
  // Windows has no flag glyphs, so the ISO code stands in for the flag there.
  var NO_FLAGS = /Win/.test(navigator.platform || "");
  function flagHtml(iso) {
    if (NO_FLAGS) return '<span class="cc-flag iso">' + iso + "</span>";
    var f = iso.replace(/./g, function (ch) { return String.fromCodePoint(127397 + ch.charCodeAt(0)); });
    return '<span class="cc-flag">' + f + "</span>";
  }
  function findCountry(iso) {
    iso = String(iso || "").toUpperCase();
    for (var i = 0; i < COUNTRIES.length; i++) if (COUNTRIES[i][0] === iso) return COUNTRIES[i];
    return null;
  }
  function setCountry(c, remember) {
    if (!c) return;
    cc = c;
    $("ccFlag").outerHTML = flagHtml(c[0]).replace('class="cc-flag', 'id="ccFlag" class="cc-flag');
    $("ccCode").textContent = "+" + c[2];
    $("ccBtn").setAttribute("aria-label", countryName(c) + " +" + c[2]);
    if (remember) set(CC_KEY, c[0]);
    paint();
  }
  function detectCountry() {
    var saved = findCountry(get(CC_KEY));
    if (saved) { setCountry(saved, false); return; }
    var loc = (navigator.language || "").split("-")[1];
    var fromLocale = loc && loc.length === 2 ? findCountry(loc) : null;
    if (fromLocale) setCountry(fromLocale, false);
    fetch("/api/geo", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var g = j && findCountry(j.country);
        // The edge knows where the request came from; the locale only guesses.
        if (g && !get(CC_KEY)) setCountry(g, false);
        else if (!cc && fromLocale) setCountry(fromLocale, false);
      })
      .catch(function () { if (!cc && fromLocale) setCountry(fromLocale, false); });
  }
  function renderList(q) {
    q = (q || "").trim().toLowerCase().replace(/^\+/, "");
    var list = $("ccList"), html = "", n = 0;
    var rows = COUNTRIES.map(function (c) { return { c: c, n: countryName(c) }; })
      .sort(function (a, b) { return a.n.localeCompare(b.n); });
    // Words that START with the query first (ni → Niger, Nigeria, Nicaragua);
    // anything merely containing it only when nothing starts with it.
    var starts = function (name) { return (" " + name.toLowerCase()).indexOf(" " + q) >= 0; };
    var hit = function (r) { return !q || starts(r.n) || starts(r.c[1]) || r.c[0].toLowerCase() === q || r.c[2].indexOf(q) === 0; };
    var loose = function (r) { return r.n.toLowerCase().indexOf(q) >= 0 || r.c[1].toLowerCase().indexOf(q) >= 0; };
    var shown = rows.filter(hit);
    if (q && !shown.length) shown = rows.filter(loose);
    for (var i = 0; i < shown.length; i++) {
      var c = shown[i].c, name = shown[i].n;
      n++;
      html += '<li><button type="button" class="cc-item' + (cc && cc[0] === c[0] ? " is-active" : "") + '" data-iso="' + c[0] + '" role="option">'
        + flagHtml(c[0]) + '<span class="cc-name">' + name.replace(/</g, "&lt;") + '</span><span class="cc-dial">+' + c[2] + "</span></button></li>";
    }
    list.innerHTML = n ? html : '<li class="cc-empty">' + T("No country matches that.") + "</li>";
  }
  function openCc() {
    $("ccPop").hidden = false; $("ccBtn").setAttribute("aria-expanded", "true");
    $("ccSearch").value = ""; renderList("");
    setTimeout(function () { $("ccSearch").focus(); var a = $("ccList").querySelector(".is-active"); if (a) a.scrollIntoView({ block: "center" }); }, 20);
  }
  function closeCc() { $("ccPop").hidden = true; $("ccBtn").setAttribute("aria-expanded", "false"); }
  $("ccBtn").onclick = function () { if ($("ccPop").hidden) openCc(); else closeCc(); };
  $("ccSearch").addEventListener("input", function () { renderList($("ccSearch").value); });
  $("ccSearch").addEventListener("keydown", function (e) {
    if (e.key === "Escape") { closeCc(); $("eaPhone").focus(); e.stopPropagation(); }
    if (e.key === "Enter") { var f = $("ccList").querySelector(".cc-item"); if (f) f.click(); }
  });
  $("ccList").addEventListener("click", function (e) {
    var b = e.target.closest("[data-iso]"); if (!b) return;
    setCountry(findCountry(b.getAttribute("data-iso")), true); closeCc(); $("eaPhone").focus();
  });
  document.addEventListener("mousedown", function (e) { if (!$("ccPop").hidden && !$("phoneWrap").contains(e.target)) closeCc(); });
  // A number pasted with its own +code decides the country itself.
  $("eaPhone").addEventListener("input", function () {
    var v = $("eaPhone").value.replace(/[^\d+]/g, "");
    if (v.charAt(0) === "+") {
      var best = null;
      for (var i = 0; i < COUNTRIES.length; i++) {
        var d = COUNTRIES[i][2];
        if (v.slice(1, 1 + d.length) === d && (!best || d.length > best[2].length) && (d !== "1" || !best)) best = COUNTRIES[i];
      }
      if (best && best[2] !== "1") { setCountry(best, true); $("eaPhone").value = v.slice(1 + best[2].length); }
    }
  });
  /* The number in E.164: the country's code, then the digits typed, minus a
     leading trunk zero — "0712…" in Kenya is "+254712…". */
  function phoneE164() {
    if (!cc) return "";
    var digits = $("eaPhone").value.replace(/\D/g, "");
    if (digits.charAt(0) === "0" && cc[2] !== "1") digits = digits.replace(/^0+/, "");
    if (digits.length < 6 || digits.length + cc[2].length > 15) return "";
    return "+" + cc[2] + digits;
  }
  function paintChan() {
    Array.prototype.forEach.call(document.querySelectorAll(".chan-b"), function (b) {
      b.setAttribute("aria-checked", b.getAttribute("data-chan") === chan ? "true" : "false");
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll(".chan-b"), function (b) {
    b.onclick = function () { chan = b.getAttribute("data-chan"); set(CHAN_KEY, chan); paintChan(); paint(); };
  });
  paintChan();
  detectCountry();

  // The name and email are what gets checked, so they are what unlocks the
  // button. A phone, if typed, has to be a phone; the channel is optional.
  function formOk() {
    return $("eaName").value.trim().length > 1 && isEmail($("eaMail").value)
      && ($("eaPhone").value.replace(/\D/g, "") === "" || phoneE164() !== "");
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
      var ph = phoneE164() || get(SENT_KEY);
      $("eaSumId").textContent = ph ? ph + (chan === "telegram" ? " · Telegram" : (chan === "whatsapp" ? " · WhatsApp" : "")) : T("No phone given");
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
    if (!$("eaPhone").value) $("eaPhone").value = get(PHONE_KEY);
    // A request already sent from this browser stays sent across a reload —
    // the code is on its way and the form has nothing to add.
    var sentFor = get(SENT_KEY);
    if (sentFor && phase === "form") phase = "sent";   // "-" when it went out without a phone
    root.hidden = false;
    document.body.classList.add("ea-open");
    paint();
    setTimeout(function () { (phase === "sent" ? $("eaCode") : $("eaName")).focus(); }, 80);
  }
  function close() {
    root.hidden = true;
    document.body.classList.remove("ea-open");
  }

  function send() {
    if (busy || !formOk() || sendsLeft() === 0) return;
    busy = true; showErr(null); paint();
    var id = phoneE164(), name = $("eaName").value.trim(), email = $("eaMail").value.trim();

    fetch("/api/mt5/ea-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visitorId: visitorId(), name: name, email: email, phone: id, country: cc ? cc[0] : "", contact: chan,
        lang: document.documentElement.lang || "", page: location.pathname,
      }),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) throw new Error(x.j.error || T("Could not send that. Try again in a moment."));
        set(NAME_KEY, name); set(MAIL_KEY, email); set(SENT_KEY, id || "-"); set(PHONE_KEY, $("eaPhone").value.trim());
        countSend();
        phase = "sent";
        openWait();
        /* The bubble opens onto THIS conversation, with the request already in
           it, rather than onto an empty window. The answer lands there. */
        if (window.SHALO_SUPPORT_ASK) {
          window.SHALO_SUPPORT_ASK({
            name: name, email: email,
            text: id
              ? T(x.j.already ? "Asked for the Shalobot EA again — {email}, {phone} on {channel}." : "Requested the Shalobot EA — {email}, {phone} on {channel}.", { email: email, phone: id, channel: chan === "telegram" ? "Telegram" : (chan === "whatsapp" ? "WhatsApp" : "—") })
              : T(x.j.already ? "Asked for the Shalobot EA again — {email}." : "Requested the Shalobot EA — {email}.", { email: email }),
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
  ["eaName", "eaMail", "eaPhone", "eaCode"].forEach(function (id) { $(id).addEventListener("input", paint); });
  $("eaSend").addEventListener("click", send);
  $("eaRedeem").addEventListener("click", redeem);
  $("eaCode").addEventListener("keydown", function (e) { if (e.key === "Enter") redeem(); });
  $("eaMail").addEventListener("keydown", function (e) { if (e.key === "Enter") send(); });
  $("eaHaveCode").addEventListener("click", function () { codeOpen = true; paint(); $("eaCode").focus(); });
  $("eaEdit").addEventListener("click", function () { phase = "form"; set(SENT_KEY, ""); paint(); $("eaName").focus(); });

  /* "I have downloaded the EA": one tap sends the words to support, with the
     whole thread and our record of whether this browser was ever approved. */
  var dl = $("downloadedBtn");
  if (dl) dl.addEventListener("click", function () {
    if (window.SHALO_SUPPORT_SEND) {
      window.SHALO_SUPPORT_SEND({
        text: T("I have downloaded the EA — please guide me on how to set it up and use it the right way."),
        kind: "ea-downloaded",
      });
    }
  });

  // Our reply landing in the bubble is what unlocks sending again.
  window.addEventListener("shalo:support-reply", function () { if (!root.hidden) paint(); });

  // /mt5.html#get opens straight onto the sheet, for links that promise the file.
  if (location.hash === "#get") open();
})();
