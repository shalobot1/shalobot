/**
 * The Shalobot EA, to somebody holding a code that was issued to them.
 *
 * The file does not sit under the site root, because a file there is a link
 * anybody can share, and gating the BUTTON would change nothing at all. It is
 * bundled beside this function (vercel.json includeFiles) and this route is the
 * only way to it.
 *
 * The code is checked against the browser that asked for it, not just against
 * the list of valid codes: an approved code that worked for whoever it was
 * forwarded to would put the file back where it started within a week.
 */

const fs = require("fs");
const path = require("path");
const { readBody, json, isBanned } = require("../_lib/db");
const { checkCode, EA_FILE } = require("../_lib/ea");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });

  const body = await readBody(req);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const visitorId = typeof body.visitorId === "string" ? body.visitorId.trim() : "";

  if (!code || !visitorId) return json(res, 400, { error: "Enter the code you were sent." });

  /* A ban ends the code with it. Same words as an unknown code, on purpose. */
  if (await isBanned(visitorId, null)) return json(res, 403, { error: "That code was not recognised. Check it and try again." });

  const check = await checkCode(code, visitorId);
  if (!check.ok) {
    if (check.why === "unavailable") return json(res, 503, { error: "We could not check that code just now. Try again in a moment." });
    if (check.why === "not-yours") {
      return json(res, 403, { error: "That code was issued to a different browser. Open the support window on the device you asked from, or ask us for a new one." });
    }
    if (check.why === "exhausted") {
      return json(res, 403, { error: "That code has been used three times. Send the request again with the same email and ID and a new one is issued straight away." });
    }
    return json(res, 403, { error: "That code was not recognised. Check it and try again." });
  }

  let bytes;
  try {
    bytes = fs.readFileSync(path.join(__dirname, "..", "_files", EA_FILE));
  } catch (e) {
    console.error("[ea] file read failed:", e);
    return json(res, 500, { error: "The file is temporarily unavailable." });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${EA_FILE}"`);
  res.setHeader("Cache-Control", "no-store");
  res.end(bytes);
};
