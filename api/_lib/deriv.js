/**
 * SHALOBOT — the Deriv connection, server side.
 *
 * The app is "Shalo Bot" on developers.deriv.com: an OAuth 2.0 client with a
 * 21-character id, the trade scope only, and one registered redirect URL,
 * https://www.shalobot.com/trading. Everything here follows the current API
 * (auth.deriv.com + api.derivws.com), not the retired ws.binaryws.com one.
 *
 * Why the server is involved at all, when the PKCE flow could run in the page:
 * Deriv's own guide says the code-for-token exchange happens on the backend and
 * the token is stored on the server, never in front-end code. So the browser
 * never sees the access token. It lives in one cookie the page cannot read
 * (HttpOnly), sealed with AES-256-GCM under SHALO_SESSION_KEY, and only these
 * functions open it. The page is handed balances and one-time WebSocket URLs —
 * never the token they were made with.
 *
 * What was measured on 2026-10-03 with this exact client, and what the design
 * rests on:
 *   - the token response is { access_token: "ory_at_…", expires_in: 2591999,
 *     scope: "trade", token_type: "bearer" } — 30 days, and NO refresh token;
 *   - asking for offline_access is refused ("The OAuth 2.0 Client is not
 *     allowed to request scope 'offline_access'"), so refresh tokens are not
 *     on offer;
 *   - prompt=none returns a fresh code with no screen at all for someone who
 *     approved before and is still signed in at Deriv.
 * So "remembered for ever" is: a 30-day token in a 400-day cookie, renewed by
 * a silent prompt=none round trip before it lapses. Only somebody who has also
 * signed out of Deriv itself ever sees a Deriv screen again.
 */

const crypto = require("crypto");

const CLIENT_ID = "34zuuql3xOppld0QZU9dc";
const AUTH_URL = "https://auth.deriv.com/oauth2/auth";
const TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const API = "https://api.derivws.com";

/* Byte for byte what is registered on the app. Deriv rejects anything else —
   a trailing slash, the bare host — so this is a constant, not derived from
   whichever host served the request. */
const REDIRECT_URI = "https://www.shalobot.com/trading";
const SCOPE = "trade";

/* __Host- cookies must be Secure, Path=/ and carry no Domain: the browser
   refuses to let a subdomain or a plain-http page set or overwrite them. */
const SESSION_COOKIE = "__Host-shalo_deriv";
const FLOW_COOKIE = "__Host-shalo_oauth";
const SESSION_MAX_AGE = 400 * 24 * 3600;   // the longest any browser keeps a cookie
const FLOW_MAX_AGE = 15 * 60;              // one sign-in round trip, with room to type a password
const RENEW_BEFORE_MS = 5 * 24 * 3600 * 1000;

/* ── sealing ─────────────────────────────────────────────────────────────── */

function key() {
  const raw = process.env.SHALO_SESSION_KEY || "";
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) {
    const e = new Error("SHALO_SESSION_KEY is missing or not 32 bytes of base64.");
    e.config = true;
    throw e;
  }
  return k;
}

const b64u = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return b64u(Buffer.concat([iv, c.getAuthTag(), body]));
}

/** The object, or null for anything tampered with, truncated or sealed under another key. */
function unseal(str) {
  if (!str) return null;
  try {
    const raw = unb64u(str);
    if (raw.length < 29) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const out = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
    return JSON.parse(out.toString("utf8"));
  } catch (e) {
    if (e.config) throw e;
    return null;
  }
}

/* ── cookies ─────────────────────────────────────────────────────────────── */

function readCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i < 0) return;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

/** Queue a Set-Cookie without clobbering one already queued on this response. */
function addCookie(res, name, value, maxAge) {
  const line = `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
  const prev = res.getHeader("Set-Cookie");
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(line);
  res.setHeader("Set-Cookie", list);
}
const dropCookie = (res, name) => addCookie(res, name, "", 0);

function readSession(req) {
  const s = unseal(readCookies(req)[SESSION_COOKIE]);
  return s && typeof s.t === "string" && s.t ? s : null;
}
function writeSession(res, token, expiresIn) {
  const now = Date.now();
  const e = now + Math.max(60, Number(expiresIn) || 3600) * 1000;
  addCookie(res, SESSION_COOKIE, seal({ t: token, e, c: now }), SESSION_MAX_AGE);
  return e;
}

/* ── plumbing ────────────────────────────────────────────────────────────── */

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

function json(res, status, body) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).send(JSON.stringify(body));
}

/** A state-changing call must come from our own pages. SameSite=Lax already
 *  keeps the cookie off a cross-site POST; this says no before any work. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetches may omit it; the cookie rule still holds
  try {
    const host = new URL(origin).host;
    return host === req.headers.host || host === "www.shalobot.com";
  } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One call to Deriv's REST API, ridden through the failures that mean "later":
 * a network that did not answer, 429, and the 5xx family. Never a 4xx — 401
 * and 403 are answers, not hiccups. Three tries inside about two seconds, so a
 * page never waits on a dead endpoint for long.
 */
async function deriv(method, path, token, body) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(250 * Math.pow(2, attempt) + Math.floor(Math.random() * 150));
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: Object.assign(
          { Authorization: "Bearer " + token, Accept: "application/json" },
          body ? { "Content-Type": "application/json" } : {}
        ),
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      lastErr = Object.assign(new Error("Could not reach Deriv."), { status: 0, transient: true });
      continue;
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (res.ok) return data;
    const msg = (data && data.errors && data.errors[0] && data.errors[0].message) ||
      (data && (data.message || data.error)) || `Deriv answered ${res.status}.`;
    const err = Object.assign(new Error(String(msg)), {
      status: res.status,
      code: data && data.errors && data.errors[0] && data.errors[0].code,
      transient: res.status === 429 || res.status >= 500,
    });
    if (!err.transient) throw err;
    lastErr = err;
  }
  throw lastErr;
}

/* ── OAuth ───────────────────────────────────────────────────────────────── */

function pkce() {
  const verifier = b64u(crypto.randomBytes(48));                     // 64 chars, inside 43–128
  const challenge = b64u(crypto.createHash("sha256").update(verifier).digest());
  const state = crypto.randomBytes(16).toString("hex");
  return { verifier, challenge, state };
}

function authorizeUrl({ challenge, state, prompt }) {
  const u = new URL(AUTH_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (prompt) u.searchParams.set("prompt", prompt);
  return u.toString();
}

/** The authorization code for a token. Single use and short lived, so one try
 *  and a clear answer — retrying a spent code only turns one error into two. */
async function exchange(code, verifier) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw Object.assign(new Error("Could not reach Deriv to finish signing in."), { status: 0 });
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data || !data.access_token) {
    const why = (data && (data.error_description || data.error)) || `Deriv answered ${res.status}.`;
    throw Object.assign(new Error(String(why)), { status: res.status, code: data && data.error });
  }
  return data;
}

/* ── what is in the account ──────────────────────────────────────────────── */

const num = (v) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Every options account, real and demo. Deriv sends balance as a string here
 *  ("0.33") although the schema says number, so it is read either way. */
async function accounts(token) {
  const d = await deriv("GET", "/trading/v1/options/accounts", token);
  return (Array.isArray(d && d.data) ? d.data : [])
    .filter((a) => a && a.account_id)
    .map((a) => ({
      id: String(a.account_id),
      type: a.account_type === "real" ? "real" : "demo",
      currency: String(a.currency || ""),
      balance: num(a.balance),
      status: String(a.status || "active"),
    }));
}

const ACCOUNT_ID = /^[A-Z]{2,6}[0-9]{3,15}$/;
const WS_PREFIX = "wss://api.derivws.com/trading/v1/options/ws/";

/** A ready-to-open WebSocket URL for one account. The OTP inside it is good
 *  for 120 seconds and one connection. Which account is asked for decides
 *  demo or real: there is no other switch. */
async function otp(token, accountId) {
  if (!ACCOUNT_ID.test(accountId)) throw Object.assign(new Error("Not an account id."), { status: 400 });
  const d = await deriv("POST", `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`, token);
  const url = d && d.data && d.data.url;
  if (typeof url !== "string" || url.indexOf(WS_PREFIX) !== 0) {
    throw Object.assign(new Error("Deriv did not return a trading socket."), { status: 502 });
  }
  return url;
}

async function migrationStatus(token) {
  try {
    const d = await deriv("GET", "/trading/v1/options/legacy/migration-status", token);
    return (d && d.status) || "";
  } catch { return ""; }
}

module.exports = {
  CLIENT_ID, REDIRECT_URI, SESSION_COOKIE, FLOW_COOKIE, FLOW_MAX_AGE, RENEW_BEFORE_MS,
  seal, unseal, readCookies, addCookie, dropCookie, readSession, writeSession,
  readBody, json, sameOrigin, pkce, authorizeUrl, exchange, accounts, otp, migrationStatus,
};
