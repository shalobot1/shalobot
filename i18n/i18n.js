/**
 * SHALOBOT — the language layer.
 *
 * English is the source of truth and lives in the pages themselves. This file
 * swaps it for Spanish, French or Portuguese at runtime, from a dictionary
 * keyed by the English text — so the markup never has to change to gain a
 * language, and a page that has no entry for a line simply shows the English.
 *
 * WHAT IT TRANSLATES. Every element whose content is text and inline markup
 * only — a sentence with a <b> or a <code> in it is one key, not three
 * fragments, so it is translated as a sentence. Then the attributes people
 * read: placeholder, title, aria-label, alt, and the meta description. Then
 * anything added to the page later, through a MutationObserver: the support
 * bubble, a modal, a signal card.
 *
 * WHICH LANGUAGE. The one chosen last, if any; else the browser's own, when
 * it is Spanish, French or Portuguese; else — for a browser that only speaks
 * English — the language of the country the visitor is in, from a one-line
 * endpoint that reads the request's country (Vercel stamps it on every
 * request); else English. The choice is kept in this browser and set on
 * <html lang>, so screen readers and spell-checkers follow it too.
 *
 * THE SWITCHER. A flag-and-code button that opens a menu of four flags. Drawn
 * as inline SVG rather than emoji, because emoji flags render as two letters
 * on Windows. It mounts into [data-lang-switch] when a page provides one, else
 * into the first <header>, else floats at the top-right. A page with
 * data-no-lang-switch on <html> gets the translation but no switch.
 *
 * Text a script builds with variables in it — "3 signals", "updated 12:07" —
 * cannot be matched whole. Those call window.t("…") with an English template
 * whose placeholders survive translation: t("updated {time}") → "actualizado
 * {time}", and the caller fills the braces.
 */
(function () {
  "use strict";

  var LANGS = {
    en: { name: "English",   flag: "gb" },
    es: { name: "Español",   flag: "es" },
    fr: { name: "Français",  flag: "fr" },
    pt: { name: "Português", flag: "br" },
  };
  var KEY = "shalo_lang";
  var BASE = (document.currentScript && document.currentScript.src.replace(/\/[^/]*$/, "/")) || "/i18n/";

  /* ── flags, as small SVGs ─────────────────────────────────────────────── */
  var FLAGS = {
    gb: '<svg viewBox="0 0 60 40"><clipPath id="gbc"><rect width="60" height="40" rx="4"/></clipPath><g clip-path="url(#gbc)"><rect width="60" height="40" fill="#012169"/><path d="M0 0L60 40M60 0L0 40" stroke="#fff" stroke-width="8"/><path d="M0 0L60 40M60 0L0 40" stroke="#C8102E" stroke-width="3"/><path d="M30 0v40M0 20h60" stroke="#fff" stroke-width="12"/><path d="M30 0v40M0 20h60" stroke="#C8102E" stroke-width="6"/></g></svg>',
    es: '<svg viewBox="0 0 60 40"><rect width="60" height="40" rx="4" fill="#AA151B"/><rect y="10" width="60" height="20" fill="#F1BF00"/></svg>',
    fr: '<svg viewBox="0 0 60 40"><clipPath id="frc"><rect width="60" height="40" rx="4"/></clipPath><g clip-path="url(#frc)"><rect width="20" height="40" fill="#002654"/><rect x="20" width="20" height="40" fill="#fff"/><rect x="40" width="20" height="40" fill="#CE1126"/></g></svg>',
    br: '<svg viewBox="0 0 60 40"><rect width="60" height="40" rx="4" fill="#009C3B"/><path d="M30 5L54 20L30 35L6 20Z" fill="#FFDF00"/><circle cx="30" cy="20" r="9" fill="#002776"/><path d="M22 18c5-2 11-1 16 3" stroke="#fff" stroke-width="1.6" fill="none"/></svg>',
  };

  var dict = null;      // the current language's dictionary, or null for English
  var lang = "en";
  var originals = new WeakMap(); // element → its English innerHTML, so switching back is exact
  var attrOriginals = new WeakMap();

  /* ── choosing ─────────────────────────────────────────────────────────── */
  /** The saved choice, else the browser's own non-English language. Returns
   *  null when neither decides — the caller then asks where the visitor is. */
  function detect() {
    try { var saved = localStorage.getItem(KEY); if (saved && LANGS[saved]) return saved; } catch (e) {}
    var wants = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"]);
    for (var i = 0; i < wants.length; i++) {
      var code = String(wants[i] || "").slice(0, 2).toLowerCase();
      if (code !== "en" && LANGS[code]) return code;
    }
    return null;
  }

  /* The countries where one of our languages is the everyday one. A browser
     left on English in São Paulo or Bogotá is common; the switcher is one tap
     away for anyone who would rather read English. */
  var COUNTRY_LANG = {
    es: "AR BO CL CO CR CU DO EC ES GQ GT HN MX NI PA PE PR PY SV UY VE",
    fr: "FR BE MC LU CH SN CI CM ML BF NE TG BJ GA CG CD MG GN HT DJ KM TD CF RW BI",
    pt: "BR PT AO MZ CV GW ST TL",
  };
  function langForCountry(cc) {
    cc = String(cc || "").toUpperCase();
    for (var l in COUNTRY_LANG) if ((" " + COUNTRY_LANG[l] + " ").indexOf(" " + cc + " ") !== -1) return l;
    return null;
  }
  /** Where the visitor is, from /api/geo — asked once per session. */
  function detectByPlace(cb) {
    var cached = null;
    try { cached = sessionStorage.getItem("shalo_geo"); } catch (e) {}
    if (cached) return cb(langForCountry(cached));
    var done = false, timer = setTimeout(function () { if (!done) { done = true; cb(null); } }, 1500);
    fetch("/api/geo", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (j) {
      var cc = (j && j.country) || "";
      try { sessionStorage.setItem("shalo_geo", cc || "-"); } catch (e) {}
      if (!done) { done = true; clearTimeout(timer); cb(langForCountry(cc)); }
    }).catch(function () { if (!done) { done = true; clearTimeout(timer); cb(null); } });
  }

  /* ── keys ─────────────────────────────────────────────────────────────── */
  var INLINE = { A: 1, B: 1, STRONG: 1, EM: 1, I: 1, CODE: 1, SPAN: 1, SMALL: 1, KBD: 1, SUP: 1, SUB: 1, BR: 1, U: 1, S: 1, MARK: 1, ABBR: 1, TIME: 1 };
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, SVG: 1, PRE: 1, CODE: 1, INPUT: 1, SELECT: 1, OPTION: 1 };

  /** True when everything inside is text or inline elements — one sentence.
   *  An inline child counts only if it is itself words: it has text, no id (an
   *  id marks a slot a script fills), and no icon or block inside. Otherwise
   *  the element is structure, and its children are looked at one by one. */
  function isLeaf(el) {
    var hasText = false;
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) { if (n.nodeValue.trim()) hasText = true; continue; }
      if (n.nodeType !== 1) continue;
      if (!INLINE[n.tagName]) return false;
      if (n.tagName === "BR") continue;
      if (n.getAttribute("data-i18n-skip") !== null) return false;
      // An empty span is decoration — a dot, a spacer — and rides along inside
      // the key. An empty span WITH an id is a slot a script will fill, and
      // nothing that contains one is a sentence.
      if (!n.textContent.trim()) { if (n.firstElementChild || n.id) return false; continue; }
      if (n.querySelector && n.querySelector("svg,img,div,p,ul,ol,li,section,table,h1,h2,h3,h4,button,form,[id]")) return false;
    }
    return hasText;
  }

  var norm = function (s) { return s.replace(/\s+/g, " ").trim(); };

  /** Translate one element if it is a leaf with an entry. Returns true when it
   *  did, so the caller does not descend into what is now translated markup. */
  function translateElement(el) {
    if (!dict) return false;
    if (SKIP[el.tagName] || el.closest("[data-i18n-skip],[translate=no],.notranslate")) return false;
    if (!isLeaf(el)) return false;
    var src = originals.has(el) ? originals.get(el) : el.innerHTML;
    var key = norm(src);
    if (!key || !/[A-Za-z]{2,}/.test(key)) return false;
    var out = dict[key];
    if (out == null) {
      // A plain-text leaf may be keyed on its text alone — but only when it IS
      // plain text; writing textContent over inline children would delete them.
      if (el.firstElementChild) return false;
      var t = norm(el.textContent);
      if (t !== key) out = dict[t];
      if (out == null) return false;
      if (!originals.has(el)) originals.set(el, el.innerHTML);
      el.textContent = out;
      return true;
    }
    if (!originals.has(el)) originals.set(el, el.innerHTML);
    el.innerHTML = out;
    return true;
  }

  var ATTRS = ["placeholder", "title", "aria-label", "alt", "data-tip"];
  function translateAttrs(el) {
    if (!dict) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!el.hasAttribute(a)) continue;
      var store = attrOriginals.get(el) || {};
      var src = store[a] != null ? store[a] : el.getAttribute(a);
      var out = dict[norm(src)];
      if (out == null) continue;
      if (store[a] == null) { store[a] = src; attrOriginals.set(el, store); }
      el.setAttribute(a, out);
    }
  }

  function restoreAll() {
    var all = document.body.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && textOriginals.has(n)) n.nodeValue = textOriginals.get(n);
      if (originals.has(el)) el.innerHTML = originals.get(el);
      var st = attrOriginals.get(el);
      if (st) for (var a in st) el.setAttribute(a, st[a]);
    }
    var md = document.querySelector('meta[name="description"]');
    if (md && md.__orig) md.setAttribute("content", md.__orig);
    if (document.__origTitle) document.title = document.__origTitle;
  }

  /* Top down, and stop at the first match: a sentence with a <b> in it is
     matched as the whole sentence, and its <b> is never looked at on its own —
     which would have broken the parent's key before the parent was tried. */
  /* A text node sitting beside an icon or a block — "Download" next to an
     <svg>, a label before a <div> — is never inside a leaf. Those are matched
     on their own text, and only the text is replaced. */
  var textOriginals = new WeakMap();
  function translateTextNodes(el) {
    if (SKIP[el.tagName]) return;
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType !== 3) continue;
      var src = textOriginals.has(n) ? textOriginals.get(n) : n.nodeValue;
      var key = norm(src);
      if (!key || !/[A-Za-z]{2,}/.test(key)) continue;
      var out = dict[key];
      if (out == null) continue;
      if (!textOriginals.has(n)) textOriginals.set(n, src);
      // keep the whitespace that framed the English
      n.nodeValue = src.replace(/^(\s*)[\s\S]*?(\s*)$/, "$1" + out.replace(/\$/g, "$$$$") + "$2");
    }
  }

  function translateTree(root) {
    if (!dict || !root || root.nodeType !== 1) return;
    translateAttrs(root);
    if (translateElement(root)) return;
    if (!el_closest_skip(root)) translateTextNodes(root);
    for (var c = root.firstElementChild; c; c = c.nextElementSibling) translateTree(c);
  }
  function el_closest_skip(el) { return !!(el.closest && el.closest("[data-i18n-skip],[translate=no],.notranslate")); }

  function translateHead() {
    if (!dict) return;
    if (!document.__origTitle) document.__origTitle = document.title;
    var t = dict[norm(document.__origTitle)];
    if (t) document.title = t;
    var md = document.querySelector('meta[name="description"]');
    if (md) {
      if (!md.__orig) md.__orig = md.getAttribute("content");
      var d = dict[norm(md.__orig)];
      if (d) md.setAttribute("content", d);
    }
  }

  /* ── the observer: what arrives later gets the same treatment ─────────── */
  var observing = false;
  var quiet = false; // our own writes must not re-trigger us
  var mo = null;
  /* Records for our own writes are queued and delivered AFTER the quiet flag
     is back down, so the flag alone does not keep them out. They are taken off
     the queue and dropped the moment we finish writing. Without this, the
     observer saw its own translation as "a script rewrote this", forgot the
     English it had stored, and the second switch had nothing to restore. */
  function dropOwnRecords() { if (mo) mo.takeRecords(); }
  function observe() {
    if (observing || !window.MutationObserver) return;
    observing = true;
    mo = new MutationObserver(function (muts) {
      if (quiet || !dict) return;
      quiet = true;
      try {
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === "childList") {
            // A script rewrote this element (textContent = …): whatever it put
            // there is the new English source, so the remembered one is dropped
            // FIRST — translating it below stores the new one.
            if (m.target && m.target.nodeType === 1) originals.delete(m.target);
            var handled = false;
            for (var j = 0; j < m.addedNodes.length; j++) {
              var n = m.addedNodes[j];
              if (n.nodeType === 1) translateTree(n);
              else if (n.nodeType === 3 && n.parentElement && !handled) { handled = translateElement(n.parentElement) || handled; if (!handled) translateTextNodes(n.parentElement); }
            }
            if (!handled && m.target && m.target.nodeType === 1 && !m.addedNodes.length) translateElement(m.target);
          } else if (m.type === "characterData" && m.target.parentElement) {
            var p = m.target.parentElement;
            originals.delete(p); // the script rewrote it; the new text is the new source
            translateElement(p);
          } else if (m.type === "attributes") {
            var st = attrOriginals.get(m.target);
            if (st) delete st[m.attributeName];
            translateAttrs(m.target);
          }
        }
      } finally { dropOwnRecords(); quiet = false; }
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  /* ── loading + applying ───────────────────────────────────────────────── */
  var cache = {};
  function load(code) {
    if (code === "en") return Promise.resolve(null);
    if (cache[code]) return Promise.resolve(cache[code]);
    return fetch(BASE + code + ".json", { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { cache[code] = d || {}; return cache[code]; })
      .catch(function () { return {}; });
  }

  function apply(code, remember) {
    if (!LANGS[code]) code = "en";
    if (remember) { try { localStorage.setItem(KEY, code); } catch (e) {} }
    return load(code).then(function (d) {
      quiet = true;
      try {
        if (dict) restoreAll();
        lang = code;
        dict = d;
        document.documentElement.lang = code === "pt" ? "pt-BR" : code;
        if (dict) { translateHead(); translateTree(document.body); }
      } finally { dropOwnRecords(); quiet = false; }
      paintSwitch();
      observe();
      try { window.dispatchEvent(new CustomEvent("langchange", { detail: { lang: code } })); } catch (e) {}
    });
  }

  /** For scripts: an English template in, the translation out (or the English). */
  window.t = function (s) {
    if (!dict) return s;
    var out = dict[norm(s)];
    return out == null ? s : out;
  };
  window.i18n = { get lang() { return lang; }, set: function (c) { return apply(c, true); }, langs: LANGS };

  /* ── the switcher ─────────────────────────────────────────────────────── */
  /* Its own styles, injected once, so adding a language to a page is one
     script tag and nothing else. Every colour has a fallback for pages that
     define no tokens. */
  var CSS =
    ".lang-mount--header{margin-left:auto;display:flex;align-items:center}" +
    ".lang-mount--group{display:flex;align-items:center}" +
    ".lang-mount--float{position:fixed;top:12px;right:12px;z-index:90}" +
    ".lang{position:relative;font-family:inherit}" +
    ".lang-btn{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 10px 0 8px;border-radius:999px;border:1px solid var(--border,var(--line,rgba(127,127,127,.35)));background:var(--panel,rgba(127,127,127,.08));color:inherit;font:inherit;font-size:12px;font-weight:700;letter-spacing:.04em;cursor:pointer;transition:background .15s,border-color .15s}" +
    ".lang-btn:hover{border-color:var(--accent,#0d8ecf)}" +
    ".lang-flag{display:inline-flex;width:21px;height:14px;border-radius:3px;overflow:hidden;box-shadow:0 0 0 1px rgba(0,0,0,.18)}" +
    ".lang-flag svg{width:100%;height:100%;display:block}" +
    ".lang-caret{opacity:.6;transition:transform .15s}" +
    ".lang.is-open .lang-caret{transform:rotate(180deg)}" +
    ".lang-menu{position:absolute;right:0;top:calc(100% + 6px);min-width:168px;padding:6px;border-radius:14px;border:1px solid var(--border,var(--line,rgba(127,127,127,.35)));background:var(--panel-solid,var(--panel-2,var(--raise,#1c1f2b)));box-shadow:0 16px 40px rgba(0,0,0,.35);display:none;z-index:200}" +
    ".lang.is-open .lang-menu{display:grid;gap:2px}" +
    ".lang-opt{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border:0;border-radius:9px;background:transparent;color:inherit;font:inherit;font-size:13px;font-weight:600;text-align:left;cursor:pointer}" +
    ".lang-opt:hover{background:rgba(127,127,127,.14)}" +
    ".lang-opt.is-on{color:var(--accent,#0d8ecf)}" +
    ".lang-opt.is-on::after{content:'';margin-left:auto;width:6px;height:6px;border-radius:999px;background:currentColor}" +
    "@media(max-width:640px){.lang-btn{height:32px;padding:0 8px 0 7px}.lang-code{display:none}}";
  (function () {
    var st = document.createElement("style"); st.id = "lang-css"; st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  })();

  var mount = null, menuOpen = false;
  /* A page can carry the language without offering the switch: the terminal
     is a copy of the MT5 screen, and MT5 has no flag in its top bar. The
     choice made anywhere else on the site still applies there. */
  var NO_SWITCH = document.documentElement.hasAttribute("data-no-lang-switch");
  function paintSwitch() {
    if (NO_SWITCH) return;
    if (!mount) {
      mount = document.querySelector("[data-lang-switch]");
      if (!mount) {
        mount = document.createElement("div");
        /* The action group at the right of the nav, when the page has one, so
           the switch sits beside the buttons already there — first among them.
           Else the header itself; else floating. */
        var group = document.querySelector(".nav-cta, .perch, .top-cta, .nav-actions, .nav-end, .header-end, .tm-bar-end, .top-end");
        var hdr = document.querySelector("header");
        if (group) { mount.className = "lang-mount lang-mount--group"; group.insertBefore(mount, group.firstChild); }
        else if (hdr) { mount.className = "lang-mount lang-mount--header"; hdr.appendChild(mount); }
        else { mount.className = "lang-mount lang-mount--float"; document.body.appendChild(mount); }
      }
    }
    var cur = LANGS[lang];
    mount.innerHTML =
      '<div class="lang' + (menuOpen ? " is-open" : "") + '">' +
        '<button type="button" class="lang-btn" aria-haspopup="listbox" aria-expanded="' + menuOpen + '" aria-label="' + cur.name + '" title="' + cur.name + '">' +
          '<span class="lang-flag">' + FLAGS[cur.flag] + "</span>" +
          '<span class="lang-code">' + lang.toUpperCase() + "</span>" +
          '<svg class="lang-caret" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>' +
        "</button>" +
        '<div class="lang-menu" role="listbox">' +
          Object.keys(LANGS).map(function (c) {
            return '<button type="button" role="option" aria-selected="' + (c === lang) + '" class="lang-opt' + (c === lang ? " is-on" : "") + '" data-lang="' + c + '">' +
              '<span class="lang-flag">' + FLAGS[LANGS[c].flag] + "</span><span>" + LANGS[c].name + "</span></button>";
          }).join("") +
        "</div>" +
      "</div>";
    mount.querySelector(".lang-btn").onclick = function (e) { e.stopPropagation(); menuOpen = !menuOpen; paintSwitch(); };
    Array.prototype.forEach.call(mount.querySelectorAll(".lang-opt"), function (b) {
      b.onclick = function (e) { e.stopPropagation(); menuOpen = false; apply(b.getAttribute("data-lang"), true); };
    });
  }
  document.addEventListener("click", function () { if (menuOpen) { menuOpen = false; paintSwitch(); } });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && menuOpen) { menuOpen = false; paintSwitch(); } });

  /* ── go ───────────────────────────────────────────────────────────────── */
  function start() {
    var first = detect();
    if (first) return apply(first, false);
    // Nothing decided by choice or browser: English now, and the country may
    // still say otherwise a moment later.
    lang = "en"; dict = null; document.documentElement.lang = "en"; paintSwitch(); observe();
    detectByPlace(function (code) {
      var chosen = null; try { chosen = localStorage.getItem(KEY); } catch (e) {}
      if (code && !chosen && lang === "en") apply(code, false);
    });
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
