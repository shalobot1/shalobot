/**
 * SHALOBOT — the MT5 dashboard is for a connected Deriv account.
 *
 * Runs at the edge before /dashboard is served. The Deriv session is one
 * cookie the page cannot read (__Host-shalo_deriv: HttpOnly, AES-256-GCM
 * under SHALO_SESSION_KEY — api/_lib/deriv.js seals it, iv | tag | body in
 * base64url). It must open with our key and hold a token; anything else — no
 * cookie, a cookie from elsewhere, one tampered with or cut short — goes to
 * the landing page, where connecting starts.
 *
 * Fast: one local decrypt, no call to Deriv, no round trip in the page.
 * Secure: decided on the server from a cookie nobody can forge without the
 * key. A lapsed token still counts as connected here — /trading renews it
 * silently (prompt=none) — so nobody connected is ever sent away.
 *
 * Nothing here reads, renews or changes the connection itself.
 */

export const config = { matcher: ["/dashboard", "/dashboard.html"] };

const COOKIE = "__Host-shalo_deriv";
let keyOnce = null;

function bytes(b64url) {
  const s = String(b64url).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function cookie(header, name) {
  const parts = String(header || "").split(";");
  for (let i = 0; i < parts.length; i++) {
    const at = parts[i].indexOf("=");
    if (at > 0 && parts[i].slice(0, at).trim() === name) return parts[i].slice(at + 1).trim();
  }
  return "";
}

/** The session key, imported once per instance; null when it is not configured. */
function sessionKey() {
  if (!keyOnce) {
    const raw = bytes(process.env.SHALO_SESSION_KEY || "");
    keyOnce = raw.length === 32
      ? crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"])
      : Promise.resolve(null);
  }
  return keyOnce;
}

/** true / false for the cookie; null when the key itself is missing (a setup fault). */
async function connected(cookieHeader) {
  const key = await sessionKey();
  if (!key) return null;
  const sealed = cookie(cookieHeader, COOKIE);
  if (!sealed) return false;
  try {
    const raw = bytes(sealed);
    if (raw.length < 29) return false;
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), body = raw.subarray(28);
    const data = new Uint8Array(body.length + 16);   // Web Crypto wants the tag after the body
    data.set(body);
    data.set(tag, body.length);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, data);
    const s = JSON.parse(new TextDecoder().decode(plain));
    return !!(s && typeof s.t === "string" && s.t);
  } catch (e) {
    return false;
  }
}

export default async function middleware(request) {
  const ok = await connected(request.headers.get("cookie"));
  // A missing key is our fault, not the visitor's: let the page through rather than lock everyone out.
  if (ok !== false) {
    if (ok === null) console.error("[middleware] SHALO_SESSION_KEY is not set; /dashboard served unchecked");
    return new Response(null, { headers: { "x-middleware-next": "1" } });
  }
  return new Response(null, {
    status: 307,
    headers: { Location: new URL("/", request.url).toString(), "Cache-Control": "no-store" },
  });
}
