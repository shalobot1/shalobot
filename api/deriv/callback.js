/**
 * Back from Deriv: the page at /trading posts what it found in its address —
 * { code, state } after an approval, { error, state } after a refusal — and
 * this finishes the sign-in on the server.
 *
 *   1. The flow cookie set by /api/deriv/start must be there and fresh, and its
 *      state must equal the one Deriv returned. That check is what stops a link
 *      somebody else crafted from planting their account in this browser.
 *   2. The code is exchanged here, with the verifier only this server holds.
 *   3. The token is used once at once — the account list — so a bad grant is
 *      found now rather than on the next page.
 *   4. The token goes into the sealed session cookie and nowhere else.
 *
 * The flow cookie is dropped on every path out: a code is single use, and so
 * is everything that was made to redeem it.
 */

const {
  readCookies, unseal, dropCookie, writeSession, readBody, json, sameOrigin,
  exchange, accounts, migrationStatus, FLOW_COOKIE, FLOW_MAX_AGE,
} = require("../_lib/deriv");

module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
  if (!sameOrigin(req)) return json(res, 403, { error: "Not from this site." });

  const body = await readBody(req);
  const state = String(body.state || "");

  let flow = null;
  try { flow = unseal(readCookies(req)[FLOW_COOKIE]); }
  catch (e) { console.error("[deriv/callback]", e.message); return json(res, 500, { ok: false, error: "not_configured" }); }
  dropCookie(res, FLOW_COOKIE);

  if (!flow || !flow.s || Date.now() - Number(flow.at || 0) > FLOW_MAX_AGE * 1000) {
    return json(res, 400, { ok: false, error: "flow_expired", message: "That sign-in took too long. Please connect again." });
  }
  if (!state || state !== flow.s) {
    return json(res, 400, { ok: false, error: "state_mismatch", message: "Could not verify that sign-in. Please connect again." });
  }

  /* Deriv said no. Say which flow it was, so the page knows a refused silent
     renewal means "show the sign-in", while a refused sign-in means "they said no". */
  if (body.error) {
    return json(res, 200, {
      ok: false,
      error: String(body.error).slice(0, 60),
      message: String(body.error_description || "").slice(0, 300),
      mode: flow.m,
    });
  }

  const code = String(body.code || "");
  if (!code || code.length > 512) return json(res, 400, { ok: false, error: "no_code", mode: flow.m });

  let tok;
  try { tok = await exchange(code, flow.v); }
  catch (e) {
    console.error("[deriv/callback] exchange", e.status, e.code, e.message);
    return json(res, 400, { ok: false, error: e.code || "exchange_failed", message: e.message, mode: flow.m });
  }

  let list;
  try { list = await accounts(tok.access_token); }
  catch (e) {
    console.error("[deriv/callback] accounts", e.status, e.message);
    // The grant is good; the account list is only late. Keep the session.
    if (e.status === 401 || e.status === 403) {
      return json(res, 400, { ok: false, error: "rejected", message: "Deriv did not accept that sign-in. Please connect again.", mode: flow.m });
    }
    list = null;
  }

  const expiresAt = writeSession(res, tok.access_token, tok.expires_in);
  const out = { ok: true, expiresAt, accounts: list };
  if (list && !list.length) out.migration = await migrationStatus(tok.access_token);
  return json(res, 200, out);
};
