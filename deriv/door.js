/**
 * SHALOBOT — the "o".
 *
 * A mode the page does not advertise. Three clicks on the "o" of Shalobot in
 * the header open a bare field; the right phrase turns the mode on and is
 * remembered on that device for good. From then on the same three clicks
 * switch it on and off, and the only thing the screen says about it is a
 * one-second flash on the word (and a buzz on a phone that offers one). On a
 * phone, where the header shows only the mark, the mark is the "o".
 *
 * With the mode on, /trading is the same page with the same scripts — only
 * Deriv underneath is swapped for deriv/sim.js, written in here before
 * trading.js runs. Switching reloads the page, because a live connection
 * cannot be swapped under itself; a bot that is running has to be stopped
 * first, and until then the three clicks do nothing.
 *
 * The demo account. People trade on real accounts, so the page keeps a demo
 * account out of sight (trading.js). On a device that has been through the
 * door, three clicks on the balance chip show it in the list for this visit,
 * and three more hide it again — in the simulation as on the real page. In
 * the simulation the chip's green dot is the way to the setup card instead.
 *
 * Three clicks are counted here, not read from the click event: iPhone
 * Safari reports every tap as a first click (detail 1), so waiting for a
 * third never ended on an iPhone. The places that listen for them also turn
 * off double-tap zoom (trading.css), which would otherwise eat a quick tap.
 *
 * The field opens the door the moment the phrase is in it — no Enter needed.
 * A phone keyboard's Done closes the field without an Enter, some keyboards
 * never send one, and a password field draws the browser's password manager
 * in to take the focus away; any of those used to leave the phrase typed and
 * the door shut. So it is a masked text field (not a password field) in a
 * form of its own, checked on every keystroke, on Go, and on the way out.
 *
 * The phrase is compared as a hash so it is not sitting in the file as a
 * readable word. That keeps the door shut against somebody idly poking at the
 * page; it is not security, and nothing behind it is treated as if it were.
 * The keys read like interface preferences on purpose.
 */

(function (global) {
  "use strict";

  var K_KNOWN = "shalo_ui_k";  // this device has passed the phrase, once, ever
  var K_ON = "shalo_ui_m";     // the mode is on
  var K_WHO = "shalo_ui_a";    // the Deriv account ids connected when it was opened here

  /* djb2: small, synchronous, decided in the same tick as the key press. */
  var PHRASE = 2088338501;
  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h;
  }

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function put(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function drop(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function known() { return get(K_KNOWN) === "1"; }
  /** Only on a device that has been let in — a stale flag alone is never enough. */
  function on() { return known() && get(K_ON) === "1"; }

  // Before anything else on the page runs: with the mode on, Deriv is the simulator.
  if (on()) document.write('<link rel="stylesheet" href="/deriv/sim.css" /><script src="/deriv/sim.js"><\/script>');

  /** Calls fn on the n-th click or tap on el, each within GAP ms of the last. */
  var GAP = 600;
  function taps(el, n, fn) {
    var count = 0, last = 0;
    el.addEventListener("click", function (e) {
      var now = Date.now();
      count = now - last <= GAP ? count + 1 : 1;
      last = now;
      if (count >= n) { count = 0; fn(e); }
    });
  }
  global.ShaloTaps = taps;   // sim.js counts the green dot's the same way

  function running() {
    try { var r = global.ShaloBot && global.ShaloBot.run(); return !!(r && r.active); } catch (e) { return false; }
  }

  /** One second on the word, a buzz where there is one. */
  function signal(el) {
    try { if (navigator.vibrate) navigator.vibrate(1000); } catch (e) {}
    if (!el) return;
    el.classList.remove("lit");
    void el.offsetWidth;
    el.classList.add("lit");
    global.setTimeout(function () { el.classList.remove("lit"); }, 1000);
  }

  function noteAccounts() {
    var list = [];
    try { list = (global.ShaloDeriv && global.ShaloDeriv.accounts()) || []; } catch (e) {}
    var seen = [];
    try { seen = JSON.parse(get(K_WHO) || "[]") || []; } catch (e) { seen = []; }
    list.forEach(function (a) { if (a.id && seen.indexOf(a.id) < 0) seen.push(a.id); });
    put(K_WHO, JSON.stringify(seen));
  }

  function wire() {
    var name = document.querySelector(".tnav .brand-name");
    var door = name && name.querySelector(".door");
    var mark = document.querySelector(".tnav .brand-mark");
    if (!door) return;

    /* The field the first visit asks for: no label, no placeholder, the page's
       own input colours, under the name so nothing in the header moves. Masked
       by CSS where the browser can (trading.css); a password field only where
       it cannot. */
    var box = document.createElement("form");
    box.className = "door-box";
    box.hidden = true;
    box.setAttribute("autocomplete", "off");
    var key = document.createElement("input");
    key.className = "door-key";
    var masks = !!(global.CSS && CSS.supports && CSS.supports("-webkit-text-security", "disc"));
    key.type = masks ? "text" : "password";
    key.name = "k" + Math.random().toString(36).slice(2, 8);   // nothing for autofill to recognise
    key.autocomplete = "off";
    key.setAttribute("autocapitalize", "off");
    key.setAttribute("autocorrect", "off");
    key.setAttribute("enterkeyhint", "go");
    key.setAttribute("data-1p-ignore", "");
    key.setAttribute("data-lpignore", "true");
    key.spellcheck = false;
    box.appendChild(key);
    document.querySelector(".tnav .brand").insertAdjacentElement("afterend", box);
    function hideKey() { key.value = ""; box.hidden = true; }

    /** The phrase as a phone types it: a capital the keyboard added, a space after. */
    function isPhrase(v) {
      v = String(v || "").trim();
      return hash(v) === PHRASE || hash(v.toLowerCase()) === PHRASE;
    }
    function letIn() {
      hideKey();
      put(K_KNOWN, "1");
      noteAccounts();
      flip(true);                          // the phrase means "on" — never a toggle: a flag left over from before must not turn it off
    }

    /** Switch the mode (on: true / false; nothing given: the other way) and reload. */
    function flip(to) {
      if (to === undefined) to = !on();
      if (to) put(K_ON, "1"); else drop(K_ON);
      signal(name);
      global.setTimeout(function () { global.location.reload(); }, 1000);
    }

    function knock() {
      if (running()) return;
      if (!known()) { box.hidden = false; key.focus(); return; }
      flip();
    }
    // The brand is a link: no click on the door ever navigates.
    door.addEventListener("click", function (e) { e.preventDefault(); });
    taps(door, 3, knock);
    if (mark) {
      var markIsDoor = function () { return global.getComputedStyle(name).display === "none"; };   // no name: the mark is the door
      mark.addEventListener("click", function (e) { if (markIsDoor()) e.preventDefault(); });
      taps(mark, 3, function () { if (markIsDoor()) knock(); });
    }

    key.addEventListener("input", function () { if (isPhrase(key.value)) letIn(); });
    key.addEventListener("keydown", function (e) { if (e.key === "Escape") hideKey(); });
    // Go / Enter: the phrase opens; anything else empties the box and nothing else happens.
    box.addEventListener("submit", function (e) {
      e.preventDefault();
      if (isPhrase(key.value)) letIn(); else key.value = "";
    });
    // Leaving the field (Done, a tap elsewhere) closes it — after one last look.
    key.addEventListener("blur", function () {
      if (box.hidden) return;
      if (isPhrase(key.value)) letIn(); else hideKey();
    });

    var chip = document.getElementById("acctBtn");
    if (chip) taps(chip, 3, function () {
      if (!known() || running()) return;
      var D = global.ShaloDeriv;
      if (!D || !D.demo) return;
      D.demo(!D.demo());                   // the list is open after the third click: it shows the change
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})(window);
