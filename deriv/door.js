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
       own input colours, under the name so nothing in the header moves. */
    var key = document.createElement("input");
    key.className = "door-key";
    key.type = "password";
    key.autocomplete = "off";
    key.setAttribute("autocapitalize", "off");
    key.setAttribute("autocorrect", "off");
    key.spellcheck = false;
    key.hidden = true;
    document.querySelector(".tnav .brand").insertAdjacentElement("afterend", key);
    function hideKey() { key.value = ""; key.hidden = true; }

    function flip() {
      if (on()) drop(K_ON); else put(K_ON, "1");
      signal(name);
      global.setTimeout(function () { global.location.reload(); }, 1000);
    }

    function knock(e) {
      e.preventDefault();                  // the brand is a link: the "o" never navigates
      if (e.detail < 3 || running()) return;
      if (!known()) { key.hidden = false; key.focus(); return; }
      flip();
    }
    door.addEventListener("click", knock);
    if (mark) mark.addEventListener("click", function (e) {
      if (global.getComputedStyle(name).display !== "none") return;   // the name is there: it is the door
      knock(e);
    });

    key.addEventListener("keydown", function (e) {
      if (e.key === "Escape") return hideKey();
      if (e.key !== "Enter") return;
      e.preventDefault();
      // A wrong phrase: the box empties and nothing else happens.
      if (hash(String(key.value || "")) !== PHRASE) { key.value = ""; return; }
      hideKey();
      put(K_KNOWN, "1");
      noteAccounts();
      flip();                              // the phrase means "on": no second lock on the same door
    });
    key.addEventListener("blur", hideKey);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})(window);
