/**
 * A fresh WebSocket URL for one account — what the page asks for each time a
 * live feed has to be reopened. Deriv's OTP is single use and lives 120
 * seconds, so a reconnect can never reuse the URL it started with.
 *
 *   POST /api/deriv/otp  { account: "ROT92069207" }  →  { url: "wss://…?otp=…" }
 *   401 { connected: false, reason: "expired" } when the token is gone.
 */

const { readSession, dropCookie, readBody, json, sameOrigin, otp, SESSION_COOKIE } = require("../_lib/deriv");

module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
  if (!sameOrigin(req)) return json(res, 403, { error: "Not from this site." });

  let s;
  try { s = readSession(req); }
  catch (e) { console.error("[deriv/otp]", e.message); return json(res, 500, { error: "not_configured" }); }
  if (!s || Number(s.e) <= Date.now()) {
    if (s) dropCookie(res, SESSION_COOKIE);
    return json(res, 401, { connected: false, reason: s ? "expired" : "none" });
  }

  const body = await readBody(req);
  try {
    const url = await otp(s.t, String(body.account || ""));
    return json(res, 200, { url });
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      dropCookie(res, SESSION_COOKIE);
      return json(res, 401, { connected: false, reason: "expired" });
    }
    if (e.status === 400) return json(res, 400, { error: e.message });
    console.error("[deriv/otp]", e.status, e.message);
    return json(res, 503, { error: "deriv_unavailable", message: e.message });
  }
};
