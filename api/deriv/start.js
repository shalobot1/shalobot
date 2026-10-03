/**
 * The way out to Deriv's sign-in.
 *
 *   /api/deriv/start              → Deriv's login and consent page
 *   /api/deriv/start?mode=silent  → prompt=none: no screen at all for somebody
 *                                   who approved before and is still signed in
 *                                   at Deriv; Deriv sends back an error instead
 *                                   when it would have to ask, and the page then
 *                                   comes back here without mode=silent.
 *
 * The PKCE verifier and the state are made here and kept in a sealed, HttpOnly
 * cookie for fifteen minutes — the length of one sign-in — so the verifier
 * never passes through the page at all. The callback reads them back.
 */

const { pkce, authorizeUrl, seal, addCookie, json, FLOW_COOKIE, FLOW_MAX_AGE } = require("../_lib/deriv");

module.exports = async (req, res) => {
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed." });

  const url = new URL(req.url, "http://localhost");
  const silent = url.searchParams.get("mode") === "silent";

  let flow;
  try {
    const p = pkce();
    flow = { p, sealed: seal({ v: p.verifier, s: p.state, m: silent ? "silent" : "login", at: Date.now() }) };
  } catch (e) {
    console.error("[deriv/start]", e.message);
    return json(res, 500, { error: "Sign-in is not available right now." });
  }

  addCookie(res, FLOW_COOKIE, flow.sealed, FLOW_MAX_AGE);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.statusCode = 302;
  res.setHeader("Location", authorizeUrl({ challenge: flow.p.challenge, state: flow.p.state, prompt: silent ? "none" : "" }));
  res.end();
};
