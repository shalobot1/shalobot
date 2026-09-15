/**
 * SHALOBOT — the service worker.
 *
 * Fresh first, fast always.
 *
 * The old worker cached nothing: it existed only because Chrome will not offer
 * to install a site without a fetch handler. The reasoning was sound — a stale
 * shell talking to the broker with settings the user cannot see is the one failure
 * that matters — but the cost showed up on the launch screen. With nothing
 * cached, opening the installed app meant downloading the whole page over
 * whatever network the phone had before a single pixel could be painted, and
 * on a slow one Android gave up and called it "not responding".
 *
 * So: every request still goes to the network FIRST, and a fast connection
 * gets exactly what it got before — the latest build, nothing served from a
 * cache. What changes is what happens when the network is slow. After a short
 * wait the cached copy is served instead, so the app paints in a couple of
 * seconds rather than never, and the fresh copy — when it does arrive — is
 * stored for next time. One session on the previous build, on a bad
 * connection, beats a launch screen that hangs.
 *
 * The shell is put in the cache at install, so even the first launch after
 * installing has something to fall back on. Images and icons are cache-first:
 * they do not change, and refetching a logo on every launch is waste. Nothing
 * under /api is ever cached, and neither is any other origin.
 */

const VERSION = "shalo-shell-v7";
const NET_TIMEOUT_MS = 2500;

/* What the launch screen is waiting on. The start page and everything it
   needs to paint; the other pages are cached as they are visited. */
const SHELL = [
  "/",
  "/",
  "/dashboard",
  "/styles.css",
  "/landing.css",
  "/mt5/mt5.css",
  "/mt5/mt5.js",
  "/mt5/access.js",
  "/theme.js",
  "/i18n/i18n.js",
  "/install.js",
  "/support.js",
  "/support.css",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // One missing file must not fail the whole install, so each is added on its own.
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isStatic = (url) => /\.(png|jpe?g|webp|gif|svg|ico|woff2?|ttf)$/i.test(url.pathname);
const cacheable = (res) => res && res.ok && res.type === "basic";

/** Race the network against a timer. Resolves with the response, or null when
 *  the timer wins — the fetch itself keeps running so a late answer can still
 *  be cached for next time (see the fetch handler). */
function withTimeout(promise) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), NET_TIMEOUT_MS);
    promise.then((res) => { clearTimeout(t); resolve(res); }, () => { clearTimeout(t); resolve(null); });
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  /* Icons, logos, fonts: served from cache when there, fetched and stored when not. */
  if (isStatic(url)) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (cacheable(res)) caches.open(VERSION).then((c) => c.put(req, res.clone()));
        return res;
      })),
    );
    return;
  }

  /* Pages, scripts, styles: network first, cache after the timeout. The cache
     key ignores the query string so /home.html?x still finds the /home.html
     shell — the page reads its own query once it is running. */
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    /* The fetch is started once and stored whenever it lands — even after the
       timer has already handed the cached copy to the page. That late answer is
       what the NEXT launch paints from, so a slow network still converges on
       the current build rather than freezing on an old one. */
    const net = fetch(req).then((res) => {
      if (cacheable(res)) cache.put(req, res.clone());
      return res;
    });
    net.catch(() => {});
    const fresh = await withTimeout(net);
    if (fresh) return fresh;
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    /* Nothing cached and the network is gone: let the browser show its own
       offline page rather than inventing one. */
    return fetch(req);
  })());
});
