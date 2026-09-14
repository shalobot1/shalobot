/**
 * "Has anyone answered me?"
 *
 * The support bubble asks this on a timer while it is open. It is public and
 * unauthenticated, because a visitor has no account — the id their own browser
 * minted is the whole key.
 *
 * That means the id is guessable in principle, so the endpoint is built to be
 * useless to a guesser: it returns only replies addressed to the exact id asked
 * for, the ids are random 32-bit hex, and there is nothing here to enumerate —
 * a wrong guess returns an empty list, indistinguishable from a real visitor
 * with nothing waiting.
 *
 * It lives beside api/support.js rather than under it: on Vercel a file and a
 * folder of the same name fight over the route, and a support endpoint is the
 * last place to be clever.
 */

const { json, collectSupportReplies, recentSupportReplies } = require("./_lib/db");

const ID = /^[0-9A-F]{8}$/;

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed." });

  const url = new URL(req.url, "http://localhost");
  const visitorId = String(url.searchParams.get("visitorId") || "").toUpperCase();
  if (!ID.test(visitorId)) return json(res, 200, { replies: [] });

  /* ?recent=1 asks again for what has already been delivered, marking nothing.
     The widget calls it when the bubble opens and merges the answer over what
     it has stored by id — how a line saved before attachments existed gets its
     picture, and how anything lost from localStorage comes back. */
  if (url.searchParams.get("recent") === "1") {
    const recent = await recentSupportReplies(visitorId);
    res.setHeader("Cache-Control", "no-store");
    return json(res, 200, { replies: recent });
  }

  const replies = await collectSupportReplies(visitorId);
  res.setHeader("Cache-Control", "no-store");
  return json(res, 200, { replies });
};
