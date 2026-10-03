/**
 * SHALOBOT — "Get started" on the landing page.
 *
 * Every Get started button carries data-deriv-connect and an href of /trading,
 * so without this script it still lands on the page that offers the same
 * choice. With it, the choice opens right here:
 *
 *   I have a Deriv account  → /api/deriv/start → Deriv's sign-in → /trading
 *   I'm new to Deriv        → the free sign-up (button, or the QR for a phone),
 *                             then connect it the same way
 *
 * Somebody who has connected once never sees this again: the head of the
 * landing page sends them straight to /trading.
 */

(function () {
  "use strict";

  var root = document.getElementById("dcRoot");
  if (!root) return;
  var choices = document.getElementById("dcChoices");
  var pane = document.getElementById("dcNewPane");
  var lastFocus = null;

  function open() {
    lastFocus = document.activeElement;
    choices.hidden = false;
    pane.hidden = true;
    root.hidden = false;
    document.documentElement.style.overflow = "hidden";
    var first = document.getElementById("dcHave");
    if (first) first.focus();
  }
  function close() {
    root.hidden = true;
    document.documentElement.style.overflow = "";
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  document.addEventListener("click", function (e) {
    var go = e.target.closest("[data-deriv-connect]");
    if (go) { e.preventDefault(); open(); return; }
    if (e.target.closest("[data-dc-close]")) close();
  });

  document.getElementById("dcNew").addEventListener("click", function () {
    choices.hidden = true;
    pane.hidden = false;
    var c = document.getElementById("dcCreate");
    if (c) c.focus();
  });
  document.getElementById("dcBack").addEventListener("click", function () {
    pane.hidden = true;
    choices.hidden = false;
    document.getElementById("dcNew").focus();
  });

  document.addEventListener("keydown", function (e) {
    if (root.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    // Keep Tab inside the sheet while it is open.
    var f = Array.prototype.filter.call(
      root.querySelectorAll("a[href], button:not([disabled])"),
      function (el) { return el.offsetParent !== null; }
    );
    if (!f.length) return;
    var i = f.indexOf(document.activeElement);
    if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  });

  // A link to #connect opens the choice too (e.g. from a social post).
  if (location.hash === "#connect") open();
})();
