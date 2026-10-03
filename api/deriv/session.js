/**
 * "Am I connected, and what is in my accounts?"
 *
 *   GET /api/deriv/session         → accounts with their balances
 *   GET /api/deriv/session?otp=1   → the same, plus a ready WebSocket URL for
 *                                    every active account, so the page opens
 *                                    its live balance feeds in one round trip
 *
 * Answers, all 200 so the page reads one shape:
 *   { connected: false, reason: "none" }      never connected in this browser
 *   { connected: false, reason: "expired" }   the 30-day token has lapsed or
 *                                             was revoked at Deriv — the page
 *                                             renews it silently
 *   { connected: true, expiresAt, renewSoon, accounts: [...] }
 * and 503 when Deriv itself is not answering — the session is kept, because a
 * Deriv outage is not a reason to forget anybody.
 */

const { readSession, dropCookie, json, accounts, otp, migrationStatus, SESSION_COOKIE, RENEW_BEFORE_MS } = require("../_lib/deriv");

module.exports = async (req, res) => {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed." });

  let s;
  try { s = readSession(req); }
  catch (e) { console.error("[deriv/session]", e.message); return json(res, 500, { error: "not_configured" }); }
  if (!s) return json(res, 200, { connected: false, reason: "none" });

  if (Number(s.e) <= Date.now()) {
    dropCookie(res, SESSION_COOKIE);
    return json(res, 200, { connected: false, reason: "expired" });
  }

  let list;
  try { list = await accounts(s.t); }
  catch (e) {
    if (e.status === 401 || e.status === 403) {
      dropCookie(res, SESSION_COOKIE);
      return json(res, 200, { connected: false, reason: "expired" });
    }
    console.error("[deriv/session] accounts", e.status, e.message);
    return json(res, 503, { error: "deriv_unavailable", message: "Deriv is not answering right now." });
  }

  const wantOtp = new URL(req.url, "http://localhost").searchParams.get("otp") === "1";
  if (wantOtp) {
    await Promise.all(list.map(async (a) => {
      if (a.status !== "active") return;
      try { a.ws = await otp(s.t, a.id); }
      catch (e) { a.wsError = e.message; }
    }));
  }

  const out = {
    connected: true,
    expiresAt: Number(s.e),
    renewSoon: Number(s.e) - Date.now() < RENEW_BEFORE_MS,
    accounts: list,
  };
  if (!list.length) out.migration = await migrationStatus(s.t);
  return json(res, 200, out);
};
