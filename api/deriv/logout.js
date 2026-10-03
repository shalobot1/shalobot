/**
 * Disconnect: this browser forgets the Deriv session. The approval itself
 * stays on the person's Deriv account until they remove "Shalo Bot" there,
 * which is theirs to do — and is why connecting again is one click.
 */

const { dropCookie, json, sameOrigin, SESSION_COOKIE, FLOW_COOKIE } = require("../_lib/deriv");

module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
  if (!sameOrigin(req)) return json(res, 403, { error: "Not from this site." });
  dropCookie(res, SESSION_COOKIE);
  dropCookie(res, FLOW_COOKIE);
  return json(res, 200, { ok: true });
};
