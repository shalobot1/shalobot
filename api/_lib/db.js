/**
 * SHALOBOT — the only thing that touches the database.
 *
 * shalobot.com is a static site, so there is no server to hide a secret in
 * — except here. These functions run on Vercel with the Supabase service role
 * key, and the tables they read have RLS on with no policies, so this file is
 * the entire surface between a browser and the data. Nothing is trusted that
 * arrives in a request body except after it has been through `trim` and a
 * check below.
 *
 * No dependencies on purpose. PostgREST is a REST API and `fetch` is built in;
 * pulling in a client library would mean a build step on a site that does not
 * have one.
 */

const URL_BASE = process.env.SUPABASE_URL || "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

/** Configured or not — checked once per request so failures are legible. */
function configured() {
  return !!(URL_BASE && KEY);
}

const headers = (extra) => ({
  apikey: KEY,
  Authorization: "Bearer " + KEY,
  "Content-Type": "application/json",
  ...extra,
});

/** One PostgREST call. Returns { ok, status, data, error }. */
async function rest(path, init = {}) {
  const res = await fetch(URL_BASE + "/rest/v1/" + path, {
    ...init,
    headers: headers(init.headers),
    cache: "no-store",
  });

  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }

  if (!res.ok) return { ok: false, status: res.status, data: null, error: body || { message: text } };
  return { ok: true, status: res.status, data: body, error: null };
}

const select = (table, query) => rest(`${table}?${query}`, { method: "GET" });

const insert = (table, row, prefer = "return=representation") =>
  rest(table, { method: "POST", headers: { Prefer: prefer }, body: JSON.stringify(row) });

const update = (table, query, patch) =>
  rest(`${table}?${query}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });

/* ── request plumbing ────────────────────────────────────────────────────── */

/** Vercel parses JSON bodies, but not always — be certain either way. */
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

const json = (res, status, body) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).send(JSON.stringify(body));
};

/* ── support threads ──────────────────────────────────────────────────────
 * The join between a visitor and the Telegram message their question became.
 * There is no account behind a support conversation: the only thing naming the
 * person is the random id their own browser minted, and the only thing tying
 * the owner's answer to them is the id of the message they replied to.
 *
 * Every one of these degrades quietly. Support is what people reach for when
 * something is already broken, so a database that is unreachable must never
 * turn the support form into a second failure — the message still reaches
 * Telegram, the reply just cannot be routed back on its own.
 */

const SUPPORT = "shalo_support_messages";

async function recordSupportInbound(m) {
  if (!m.visitorId || !configured()) return;
  const r = await insert(SUPPORT, {
    visitor_id: m.visitorId,
    direction: "in",
    body: String(m.body || "").slice(0, 4000),
    tg_message_id: m.tgMessageId || null,
    tg_file_message_id: m.tgFileMessageId || null,
    email: m.email || null,
    name: m.name || null,
    source: m.source || null,
    page: m.page || null,
  });
  if (!r.ok) console.error("[shalo] could not record inbound support:", r.error);
}

/** Which visitor does this Telegram message belong to? Null when the owner
 *  replied to something that was never a support message — a normal thing to
 *  do, not an error. The screenshot a visitor attached arrives as its own
 *  Telegram message under their words, and swiping on the picture is at least
 *  as natural as swiping on the text, so both ids lead here. */
async function supportVisitorFor(tgMessageId) {
  if (!configured()) return null;
  const id = encodeURIComponent(tgMessageId);
  const r = await select(SUPPORT, `select=visitor_id,email&or=(tg_message_id.eq.${id},tg_file_message_id.eq.${id})&limit=1`);
  if (!r.ok) { console.error("[shalo] support reply lookup failed:", r.error); return null; }
  const row = r.data && r.data[0];
  return row ? { visitorId: row.visitor_id, email: row.email || null } : null;
}

/** The person behind a visitor id, if anyone has ever written in under it.
 *  Used when the owner swipes on one of the BOT's own messages — a delivery
 *  receipt names the id, and that is enough to keep the conversation going. */
async function supportVisitorById(visitorId) {
  if (!configured() || !/^[0-9A-F]{8}$/.test(visitorId || "")) return null;
  const r = await select(SUPPORT, `select=visitor_id,email&visitor_id=eq.${visitorId}&direction=eq.in&order=created_at.desc&limit=1`);
  if (!r.ok) { console.error("[shalo] visitor lookup failed:", r.error); return null; }
  const row = r.data && r.data[0];
  return row ? { visitorId: row.visitor_id, email: row.email || null } : null;
}

/** Park the owner's reply for the visitor to collect. A file with no words is
 *  a complete answer, so the text may be empty. */
async function recordSupportReply(visitorId, body, attachment) {
  if (!configured()) return false;
  const r = await insert(SUPPORT, {
    visitor_id: visitorId,
    direction: "out",
    body: String(body || "").slice(0, 4000),
    attachment_url: (attachment && attachment.url) || null,
    attachment_name: (attachment && attachment.name) || null,
    attachment_type: (attachment && attachment.type) || null,
  });
  if (!r.ok) console.error("[shalo] could not record support reply:", r.error);
  return r.ok;
}

const REPLY_FIELDS = "id,body,created_at,attachment_url,attachment_name,attachment_type";
const replyRow = (x) => ({
  id: x.id, body: x.body, createdAt: x.created_at,
  attachment: x.attachment_url
    ? { url: x.attachment_url, name: x.attachment_name || "file", type: x.attachment_type || "application/octet-stream" }
    : null,
});

/** Everything waiting for this visitor, oldest first, marked as collected.
 *  Marking happens here rather than on a second call because the bubble has
 *  already drawn them by the time it could confirm, and showing an answer twice
 *  is worse than an optimistic delivery receipt. */
async function collectSupportReplies(visitorId) {
  if (!visitorId || !configured()) return [];
  const r = await select(
    SUPPORT,
    `select=${REPLY_FIELDS}&visitor_id=eq.${encodeURIComponent(visitorId)}&direction=eq.out&seen_at=is.null&order=created_at.asc&limit=20`,
  );
  if (!r.ok) { console.error("[shalo] collect failed:", r.error); return []; }
  const rows = r.data || [];
  if (!rows.length) return [];

  const ids = rows.map((x) => x.id).join(",");
  const marked = await update(SUPPORT, `id=in.(${ids})`, { seen_at: new Date().toISOString() });
  if (!marked.ok) console.error("[shalo] could not mark seen:", marked.error);

  return rows.map(replyRow);
}

/** The last few replies to this person, WITHOUT marking anything seen.
 *  Idempotent; the widget merges what comes back over what it has, by id. */
async function recentSupportReplies(visitorId, limit) {
  if (!visitorId || !configured()) return [];
  const r = await select(
    SUPPORT,
    `select=${REPLY_FIELDS}&visitor_id=eq.${encodeURIComponent(visitorId)}&direction=eq.out&order=created_at.desc&limit=${limit || 20}`,
  );
  if (!r.ok) { console.error("[shalo] recent replies failed:", r.error); return []; }
  return (r.data || []).map(replyRow).reverse();
}

/** What has already been said to this person, oldest first — attached to
 *  their next message so the answer can be written without remembering them. */
async function supportHistory(visitorId, limit) {
  if (!visitorId || !configured()) return [];
  const r = await select(
    SUPPORT,
    `select=direction,body,created_at&visitor_id=eq.${encodeURIComponent(visitorId)}&order=created_at.desc&limit=${limit || 10}`,
  );
  if (!r.ok) { console.error("[shalo] support history failed:", r.error); return []; }
  return (r.data || []).reverse().map((x) => ({ from: x.direction === "out" ? "us" : "them", body: x.body, at: x.created_at }));
}

/** Everyone who has ever written in, newest activity first — derived from the
 *  inbound rows rather than kept as a second table that could drift. */
async function listPeople(limit) {
  if (!configured()) return [];
  const r = await select(SUPPORT, `select=visitor_id,name,email,created_at&direction=eq.in&order=created_at.desc&limit=1000`);
  if (!r.ok) { console.error("[shalo] people list failed:", r.error); return []; }
  const by = new Map();
  for (const x of r.data || []) {
    if (!x.visitor_id) continue;
    const seen = by.get(x.visitor_id);
    if (!seen) { by.set(x.visitor_id, { visitorId: x.visitor_id, name: x.name || null, email: x.email || null, first: x.created_at, last: x.created_at, messages: 1 }); continue; }
    seen.messages += 1;
    seen.first = x.created_at;                 // rows arrive newest first
    seen.name = seen.name || x.name || null;
    seen.email = seen.email || x.email || null;
  }
  return [...by.values()].sort((a, b) => b.last.localeCompare(a.last)).slice(0, limit || 40);
}

/* ── the door ──────────────────────────────────────────────────────────────
 * Matched on either the browser id or the email, because neither survives on
 * its own. Every check FAILS OPEN: a database that cannot be reached means
 * nobody is treated as banned. */

const BANS = "shalo_support_bans";
const banRow = (d) => ({
  id: d.id, visitorId: d.visitor_id || null, email: d.email || null, name: d.name || null, reason: d.reason || null,
  active: !!d.active, bannedAt: d.banned_at, unbannedAt: d.unbanned_at || null,
});
const banOr = (visitorId, email) => {
  const ors = [];
  if (visitorId) ors.push(`visitor_id.eq.${encodeURIComponent(visitorId)}`);
  if (email) ors.push(`email.ilike.${encodeURIComponent(email)}`);
  return ors.join(",");
};

async function isBanned(visitorId, email) {
  if (!configured() || (!visitorId && !email)) return false;
  const r = await select(BANS, `select=id&active=is.true&or=(${banOr(visitorId, email)})&limit=1`);
  if (!r.ok) { console.error("[shalo] ban check failed:", r.error); return false; }
  return (r.data || []).length > 0;
}

async function findBan(visitorId, email, onlyActive) {
  if (!configured() || (!visitorId && !email)) return null;
  const r = await select(BANS, `select=*&or=(${banOr(visitorId, email)})${onlyActive ? "&active=is.true" : ""}&order=banned_at.desc&limit=1`);
  if (!r.ok) { console.error("[shalo] ban lookup failed:", r.error); return null; }
  return r.data && r.data[0] ? banRow(r.data[0]) : null;
}

/** Re-banning somebody already banned refreshes the row rather than stacking a second. */
async function banPerson(p) {
  if (!configured() || (!p.visitorId && !p.email)) return null;
  const existing = await findBan(p.visitorId, p.email, true);
  if (existing) {
    const r = await update(BANS, `id=eq.${existing.id}`, {
      active: true, unbanned_at: null,
      reason: p.reason || existing.reason, name: p.name || existing.name,
      email: p.email || existing.email, visitor_id: p.visitorId || existing.visitorId,
    });
    return r.ok && r.data && r.data[0] ? banRow(r.data[0]) : null;
  }
  const r = await insert(BANS, { visitor_id: p.visitorId || null, email: p.email || null, name: p.name || null, reason: p.reason || null });
  if (!r.ok) { console.error("[shalo] ban insert failed:", r.error); return null; }
  return r.data && r.data[0] ? banRow(r.data[0]) : null;
}

/** The row stays — `active` goes false and the date is stamped. */
async function unbanPerson(key) {
  const found = await findBan(key, key, true);
  if (!found) return null;
  const r = await update(BANS, `id=eq.${found.id}`, { active: false, unbanned_at: new Date().toISOString() });
  return r.ok && r.data && r.data[0] ? banRow(r.data[0]) : null;
}

async function listBans(limit) {
  if (!configured()) return [];
  const r = await select(BANS, `select=*&order=banned_at.desc&limit=${limit || 50}`);
  if (!r.ok) { console.error("[shalo] ban list failed:", r.error); return []; }
  return (r.data || []).map(banRow);
}

/** "lifted" removes only rows already unbanned; "all" removes everything. */
async function clearBans(which) {
  if (!configured()) return 0;
  const r = await rest(`${BANS}?${which === "all" ? "id=not.is.null" : "active=is.false"}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
  if (!r.ok) { console.error("[shalo] ban clear failed:", r.error); return 0; }
  return (r.data || []).length;
}

module.exports = {
  configured, rest, select, insert, update, readBody, json,
  recordSupportInbound, supportVisitorFor, supportVisitorById, recordSupportReply, collectSupportReplies, recentSupportReplies, supportHistory, listPeople,
  isBanned, findBan, banPerson, unbanPerson, listBans, clearBans,
};
