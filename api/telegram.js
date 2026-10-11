/**
 * The support bot, and the way back to the person who asked.
 *
 * Support messages arrive in Telegram. To answer one, swipe-reply to it: the
 * reply is delivered to that visitor in the support bubble on the site, usually
 * within seconds. Telegram tells us which message was replied to, and that id
 * is what identifies the visitor — so the swipe is not a nicety, it IS the
 * addressing. A message typed into the chat without replying to anything has no
 * recipient, and the bot says so rather than swallowing it.
 *
 * Telegram posts here from the open internet, so the shared secret it was
 * registered with is checked on every call, and only the owner's own chat is
 * listened to at all — its messages, and the buttons under the bot's own.
 */

const {
  readBody, json, supportVisitorFor, supportVisitorById, recordSupportReply, supportHistory, listPeople,
  unansweredChats, closeSupportChat, isBanned, banPerson, unbanPerson, listBans, clearBans,
} = require("./_lib/db");
const { saveTelegramFile } = require("./_lib/files");
const {
  requestForTelegramMessage, requestForVisitor, waitingPeople, requestForKey, eaStandingFor, approveRequest, declineRequest,
  markAnswered, markAnsweredByEmail, declineCount, codeMessage, depositMessage, MISTAKE_LINE, PARTNER_ID, DERIV_PROFILE, DERIV_SIGNUP, EXAMPLE_CLIENT_ID,
} = require("./_lib/ea");

const API = "https://api.telegram.org";
let lastRefusal = "";

/** One Bot API call: its result, or null. Telegram answers "too many" with how
 *  long to wait — the waiting list is many messages in a row — and a short
 *  wait is honoured once. */
async function tg(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${API}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => null);
      if (j && j.ok) return j.result;
      const wait = j && j.parameters && j.parameters.retry_after;
      if (attempt === 0 && wait && wait <= 8) { await new Promise((done) => setTimeout(done, wait * 1000 + 250)); continue; }
      lastRefusal = String((j && j.description) || r.status);
      console.error(`[shalo] telegram ${method} refused:`, lastRefusal);
      return null;
    } catch (e) {
      lastRefusal = String(e);
      console.error(`[shalo] telegram ${method} failed:`, e);
      return null;
    }
  }
  return null;
}

/** A message to the owner — as a reply when there is something to reply to.
 *  Returns the message sent, or null. Words Telegram cannot read as HTML (a
 *  stray "<" in somebody's name) go again as plain text rather than not at all. */
async function say(chatId, text, replyTo, extra) {
  const payload = Object.assign({ chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }, extra);
  if (replyTo) payload.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  const sent = await tg("sendMessage", payload);
  if (sent || !/parse entities/i.test(lastRefusal)) return sent;
  delete payload.parse_mode;
  payload.text = String(text).replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return tg("sendMessage", payload);
}

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const countryName = (iso) => { try { return new Intl.DisplayNames(["en"], { type: "region" }).of(iso) || iso; } catch (e) { return iso; } };
const prettyPhone = (p) => String(p || "").replace(/^(\+\d{1,3})(\d{3})(\d{3})(\d+)$/, "$1 $2 $3 $4");
const CHANNEL = { whatsapp: "WhatsApp", telegram: "Telegram" };

/** "18 Sep 14:41 UTC · 3 days ago" — when it was sent, and how long it has waited. */
function when(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return "";
  const stamp = d.toISOString().replace("T", " ").slice(5, 16).replace(/^(\d\d)-(\d\d)/, (m, mo, da) => `${da} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+mo - 1]}`) + " UTC";
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  const ago = mins < 2 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 2880 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} days ago`;
  return `${stamp} · ${ago}`;
}
/** "18 Sep 14:41" — a time inside a list, where the UTC and the age would be noise. */
const stamp = (iso) => when(iso).split(" UTC")[0];
/** At most n characters of somebody's words. */
const clip = (s, n) => {
  const t = String(s || "").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

/* ── the waiting list ────────────────────────────────────────────────────────
 * Everyone still owed something, one entry per person: an EA request waiting
 * for a decision, messages with no reply after them — a question, "I have
 * downloaded it", a screenshot — or both. Longest waiting first.
 *
 * Each entry is its own message, sent as a reply to that person's NEWEST
 * message in this chat: tapping the quote jumps there, and scrolling up from
 * it is the whole conversation. 📜 History puts all of it in one place. The
 * buttons under it act on that person and ask before anything is sent;
 * swipe-replying to the entry answers them like any of their own messages.
 * Telegram stops at 4096 characters and a burst of messages gets throttled,
 * so the list comes a page at a time. */

const PAGE = 8;
const BUTTON_ID = /^[A-Za-z0-9_-]{1,40}$/;

async function everyoneWaiting() {
  const [requests, chats, bans] = await Promise.all([waitingPeople(), unansweredChats(), listBans(1000)]);
  // Banned people stay off it: nothing of theirs reaches here any more.
  const banned = new Set();
  for (const b of bans) if (b.active) { if (b.visitorId) banned.add(b.visitorId); if (b.email) banned.add(b.email.toLowerCase()); }

  const by = new Map();
  const of = (id) => by.get(id) || by.set(id, { visitorId: id, ea: null, chat: null, standing: null }).get(id);
  for (const r of requests) of(r.visitorId || String(r.id)).ea = r;
  for (const c of chats) of(c.visitorId).chat = c;
  const people = [...by.values()].filter((p) => {
    const email = String((p.ea && p.ea.email) || (p.chat && p.chat.email) || "").toLowerCase();
    return !banned.has(p.visitorId) && !(email && banned.has(email));
  });

  // Somebody who only wrote in is shown beside their EA request, if they ever sent one.
  const standing = await eaStandingFor(people.filter((p) => !p.ea).map((p) => p.visitorId));
  for (const p of people) {
    const ea = p.ea, chat = p.chat;
    p.standing = ea ? null : standing.get(p.visitorId) || null;
    const any = ea || (p.standing && (p.standing.pending || p.standing.approved || p.standing.latest)) || {};
    p.request = any;
    p.name = any.name || (chat && chat.name) || "";
    p.email = any.email || (chat && chat.email) || "";
    p.since = [ea && (ea.firstAt || ea.createdAt), chat && chat.firstAt].filter(Boolean).sort()[0] || "";
    // Their newest message in this chat, wherever it came from: the jump.
    const eaAt = ea ? String(ea.createdAt || "") : "", chatAt = chat ? String(chat.lastAt || "") : "";
    p.jump = (chat && chat.tgMessageId && chatAt >= eaAt ? chat.tgMessageId : null) || (ea && ea.tgMessageId) || (chat && chat.tgMessageId) || null;
  }
  return people.sort((a, b) => String(a.since).localeCompare(String(b.since)));
}

/** Can a decision still be made — an open request, or a declined one to think again about? */
const decidable = (p) => !!(p.ea || (p.standing && !p.standing.approved && (p.standing.pending || (p.standing.latest && p.standing.latest.status === "declined"))));

function eaLine(p) {
  if (p.ea) return `🧾 <b>EA request — waiting for your decision</b>${p.ea.requests > 1 ? ` · sent ${p.ea.requests} times, one decision settles all` : ""}`;
  const s = p.standing;
  if (!s) return "";
  if (s.approved) return `🧾 EA approved ${stamp(s.approved.decidedAt)} · code <code>${esc(s.approved.code)}</code>`;
  if (s.pending) return `🧾 <b>EA request still open</b> — ${s.pending.answeredAt ? `answered ${stamp(s.pending.answeredAt)}, ` : ""}no decision yet`;
  if (s.latest && s.latest.status === "declined") return `🧾 EA request declined ${stamp(s.latest.decidedAt)}`;
  return "";
}

function entryText(p, n, total) {
  const r = p.request, chat = p.chat;
  const lines = [
    `<b>${n}/${total} · ${esc(p.name || "(no name)")}</b>`,
    `✉️ ${esc(p.email || "(no email)")}${p.ea && p.ea.otherEmails.length ? ` (also sent as ${p.ea.otherEmails.map(esc).join(", ")})` : ""}`,
    r.phone ? `📱 ${esc(prettyPhone(r.phone))}${CHANNEL[r.contact] ? ` · ${CHANNEL[r.contact]}` : ""}` : "",
    r.country ? `🌍 ${esc(countryName(r.country))} (${esc(r.country)})` : "",
    eaLine(p),
  ];
  if (chat) {
    const shown = chat.messages.slice(-5), more = chat.messages.length - shown.length;
    lines.push(`💬 <b>${chat.messages.length === 1 ? "1 message" : `${chat.messages.length} messages`} with no reply</b>`);
    lines.push(`<blockquote expandable>${[
      more ? `<i>…${more} earlier — 📜 History has them</i>` : "",
      ...shown.map((m) => `<b>${stamp(m.at)}</b> ${esc(clip(m.body, 400))}`),
    ].filter(Boolean).join("\n")}</blockquote>`);
  }
  lines.push(`🕒 Waiting since ${when(p.since)}`);
  lines.push(`🆔 <code>${esc(p.visitorId)}</code>`);
  return lines.filter(Boolean).join("\n");
}

/** The buttons under an entry. `done` replaces the decision row once one is made.
 *  ":0" on the data marks an entry with no decision to make, so "‹ Back" knows. */
function entryKeys(id, decide, done) {
  const tail = decide ? "" : ":0";
  const rows = [];
  if (done) rows.push([{ text: done, callback_data: "wq:z" }]);
  else if (decide) rows.push([
    { text: "✅ Approve", callback_data: `wq:a:${id}` },
    { text: "💳 Deposit", callback_data: `wq:p:${id}` },
    { text: "✖️ Decline", callback_data: `wq:d:${id}` },
  ]);
  rows.push([
    { text: "✍️ Reply", callback_data: `wq:r:${id}${tail}` },
    { text: "📜 History", callback_data: `wq:h:${id}${tail}` },
    ...(done ? [] : [{ text: "✔️ Done", callback_data: `wq:x:${id}${tail}` }]),
  ]);
  rows.push([{ text: "📋 Copy ID", copy_text: { text: id } }]);
  return { inline_keyboard: rows };
}

async function sayWaiting(chatId, replyTo, lead, from) {
  const people = await everyoneWaiting();
  if (!people.length) {
    await say(chatId, `${lead ? lead + "\n\n" : ""}✅ <b>Nobody is waiting.</b> Every EA request has a decision and every message has a reply.`, replyTo);
    return;
  }
  const start = Math.min(Math.max(0, from || 0), Math.floor((people.length - 1) / PAGE) * PAGE);
  const page = people.slice(start, start + PAGE);
  if (start === 0) {
    const decide = people.filter((p) => p.ea).length, chats = people.filter((p) => p.chat).length;
    const first = people[0].visitorId;
    await say(chatId, [
      lead ? lead + "\n" : null,
      `📋 <b>Waiting — ${people.length} ${people.length === 1 ? "person" : "people"}</b>, longest waiting first`,
      `🧾 ${decide} EA request${decide === 1 ? "" : "s"} to decide · 💬 ${chats} with messages not answered`,
      "",
      "Each one follows as its own message, quoting their newest message: <b>tap the quote</b> to jump there and scroll up for the whole conversation, or tap 📜 History.",
      "Swipe-reply to an entry, or tap ✍️ Reply, to answer them. ✅ Approve, 💳 Deposit, ✖️ Decline and ✔️ Done (off the list, no reply) each ask before they act.",
      `The commands still work: <code>/approve ${esc(first)}</code>, <code>/decline ${esc(first)} your reason</code>, <code>/deposit ${esc(first)}</code>.`,
    ].filter((line) => line !== null).join("\n"), replyTo);
  } else {
    await say(chatId, `📋 <b>Waiting — ${start + 1}–${start + page.length} of ${people.length}</b>`, replyTo, { disable_notification: true });
  }
  for (let i = 0; i < page.length; i++) {
    const p = page[i];
    await say(chatId, entryText(p, start + i + 1, people.length), p.jump,
      Object.assign({ disable_notification: true }, BUTTON_ID.test(p.visitorId) ? { reply_markup: entryKeys(p.visitorId, decidable(p)) } : {}));
  }
  const next = start + PAGE;
  if (next < people.length) {
    await say(chatId, `Showing ${start + 1}–${start + page.length} of ${people.length}.`, null, {
      disable_notification: true,
      reply_markup: { inline_keyboard: [[{ text: `Next ${Math.min(PAGE, people.length - next)} ›`, callback_data: `wq:n:${next}` }]] },
    });
  } else if (start > 0) {
    await say(chatId, `That is everyone — ${people.length} people.`, null, { disable_notification: true });
  }
}

/** 📜 The whole conversation with one person, both sides, oldest first. */
async function sayHistory(chatId, id, replyTo) {
  const LIMIT = 150;
  const [thread, who] = await Promise.all([supportHistory(id, LIMIT), supportVisitorById(id)]);
  if (!thread.length) {
    await say(chatId, `Nothing is on record for <code>${esc(id)}</code>.`, replyTo, { disable_notification: true });
    return;
  }
  const head = `📜 <b>Everything with ${esc((who && who.email) || id)}</b> — ${thread.length === LIMIT ? `the last ${LIMIT}` : thread.length} message${thread.length === 1 ? "" : "s"}, oldest first`;
  const items = thread.map((x) => `${x.from === "us" ? "↩️ <b>You</b>" : "💬 <b>Them</b>"} · ${stamp(x.at)}\n${esc(clip(x.body, 1200))}`);
  const chunks = [];
  let cur = [], size = 0;
  for (const it of items) {
    if (cur.length && size + it.length > 3400) { chunks.push(cur); cur = []; size = 0; }
    cur.push(it); size += it.length + 2;
  }
  chunks.push(cur);
  for (let i = 0; i < chunks.length; i++) {
    await say(chatId, [
      i === 0 ? head : `📜 <i>continued, ${i + 1} of ${chunks.length}</i>`,
      `<blockquote expandable>${chunks[i].join("\n\n")}</blockquote>`,
      i === chunks.length - 1 ? `🆔 <code>${esc(id)}</code> — swipe-reply here to answer them.` : "",
    ].filter(Boolean).join("\n"), i === 0 ? replyTo : null, { disable_notification: true });
  }
}

/** A button under a waiting-list entry. Decisions run exactly as the typed
 *  command with the person's ID would, so there is one way of doing each. */
async function onButton(cq) {
  const chatId = cq.message.chat.id, mid = cq.message.message_id;
  const [tag, act, id, flag] = String(cq.data || "").split(":");
  const decide = flag !== "0", tail = decide ? "" : ":0";
  const keys = (markup) => tg("editMessageReplyMarkup", { chat_id: chatId, message_id: mid, reply_markup: markup });
  let toast = "";
  try {
    if (tag !== "wq") return;
    if (act === "z") { toast = "Already done."; return; }
    if (act === "n") {
      await keys({ inline_keyboard: [] });
      await sayWaiting(chatId, null, "", Number(id) || 0);
      return;
    }
    if (!BUTTON_ID.test(id || "")) return;

    const ASK = {
      a: "✅ Yes — approve and send the code",
      p: "💳 Yes — ask them to deposit first",
      d: "✖️ Yes — decline (no reason given)",
      x: "✔️ Yes — off the list, nothing sent",
    };
    if (ASK[act]) {
      await keys({ inline_keyboard: [
        [{ text: ASK[act], callback_data: `wq:${act.toUpperCase()}:${id}${tail}` }],
        [{ text: "‹ Back", callback_data: `wq:b:${id}${tail}` }],
      ] });
      toast = act === "x" ? "Take them off the list without replying? Tap to confirm." : "Tap again to confirm.";
      return;
    }
    if (act === "b") { await keys(entryKeys(id, decide)); return; }

    if (act === "A" || act === "P" || act === "D") {
      const verb = { A: "approve", P: "deposit", D: "decline" }[act];
      const result = await onMessage({ message_id: mid, chat: cq.message.chat, text: `/${verb} ${id}` });
      const DONE = { approved: "✅ Approved — code sent", deposit: "💳 Asked to deposit first", declined: "✖️ Declined — they were told" };
      if (DONE[result]) { await keys(entryKeys(id, false, DONE[result])); toast = DONE[result]; }
      else { await keys(entryKeys(id, decide)); toast = "Nothing went through — see the message below."; }
      return;
    }
    if (act === "X") {
      await closeSupportChat(id);
      await markAnswered(id);
      await keys(entryKeys(id, false, "✔️ Off the list — nothing sent"));
      toast = "Off the list. Nothing was sent; their next message brings them back.";
      return;
    }
    if (act === "r") {
      const who = await supportVisitorById(id);
      if (!who) { toast = "They have no support chat on the site to answer into."; return; }
      await say(chatId, [
        `✍️ <b>Your answer to ${esc(who.email || id)}</b> — reply to THIS message with it: text, a photo or a document. It appears in their support window on the site.`,
        `🆔 <code>${esc(id)}</code>`,
      ].join("\n"), mid, { reply_markup: { force_reply: true, input_field_placeholder: "Your answer…" } });
      toast = "Type your answer as the reply.";
      return;
    }
    if (act === "h") { await sayHistory(chatId, id, mid); return; }
  } finally {
    await tg("answerCallbackQuery", Object.assign({ callback_query_id: cq.id }, toast ? { text: toast } : {}));
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  // 200, not 401: a wrong caller should learn nothing, and Telegram must not
  // start retrying a delivery that was never ours.
  if (!secret || req.headers["x-telegram-bot-api-secret-token"] !== secret) return json(res, 200, { ok: true });

  const update = await readBody(req);
  const owner = process.env.TELEGRAM_CHAT_ID;

  // A button under one of the bot's own messages — in the owner's chat only.
  const cq = update && update.callback_query;
  if (cq) {
    if (cq.message && cq.message.chat && String(cq.message.chat.id) === owner) {
      try { await onButton(cq); } catch (e) { console.error("[shalo] button failed:", e); }
    }
    return json(res, 200, { ok: true });
  }

  const msg = (update && update.message) || null;
  const chatId = msg && msg.chat ? msg.chat.id : null;
  if (typeof chatId !== "number") return json(res, 200, { ok: true });
  // A stranger who finds the bot is not someone we want putting words in front
  // of our visitors.
  if (String(chatId) !== owner) return json(res, 200, { ok: true });

  // Answered 200 whatever happens: a failure Telegram retried would run twice.
  try { await onMessage(msg); } catch (e) { console.error("[shalo] update failed:", e); }
  return json(res, 200, { ok: true });
};

/** One message from the owner. Returns what a decision did ("approved",
 *  "deposit", "declined"), for the button that asked for it. */
async function onMessage(msg) {
  const chatId = msg.chat.id;
  // A photo or a document arrives with `caption` instead of `text`.
  const text = String(msg.text || msg.caption || "").trim();
  const repliedTo = msg.reply_to_message && msg.reply_to_message.message_id;

  /* Who a swipe-reply is for. The visitor's own message (words or picture)
     is the normal target. But a thread on a phone quickly fills with the
     bot's own lines — "Delivered to 3A8ACC6A", a waiting-list entry, the
     original header with its "Person:" id — and swiping on one of those is a
     reasonable thing to do mid-conversation. Every bot message about a person
     carries their id, after 🆔 where there is one, so it is read back out. */
  async function personBehind(replied) {
    if (!replied) return null;
    const direct = await supportVisitorFor(replied.message_id);
    if (direct) return direct;
    if (!(replied.from && replied.from.is_bot)) return null;
    const said = String(replied.text || replied.caption || "");
    const m = /🆔\s*(?:Person:\s*)?([0-9A-F]{8})\b/.exec(said) || /\b([0-9A-F]{8})\b/.exec(said);
    return m ? supportVisitorById(m[1]) : null;
  }

  // ── the waiting list on its own — "/waiting 2" is its second page ──
  const wait = /^\/(waiting|pending|list)(?:@[A-Za-z0-9_]+)?\b(?:\s+(\d+))?/i.exec(text);
  if (wait) {
    await sayWaiting(chatId, msg.message_id, "", wait[2] ? (Number(wait[2]) - 1) * PAGE : 0);
    return;
  }

  // ── a decision on an EA access request ──
  //
  // Two ways to address it: swipe-reply to any message from that person, or
  // put their ID after the command — the ID shown in the request and in the
  // waiting list. The bare command, with nothing to point at anyone, shows
  // the waiting list instead of guessing: it lists everyone still owed a
  // decision, each with an ID to copy, and approving the wrong person cannot
  // be taken back.
  const cmd = /^\/(approve|decline|deposit)(?:@[A-Za-z0-9_]+)?\b/i.exec(text);
  if (cmd) {
    const isApprove = /^approve$/i.test(cmd[1]);
    const isDeposit = /^deposit$/i.test(cmd[1]);
    const verb = cmd[1].toLowerCase();
    let reason = text.slice(cmd[0].length).trim();
    let reqst = null;

    if (repliedTo) {
      reqst = await requestForTelegramMessage(repliedTo);
      // The message replied to is usually NOT the request message once a
      // conversation has run on. Same person either way — use their request.
      if (!reqst) {
        const who = await personBehind(msg.reply_to_message);
        if (who) reqst = await requestForVisitor(who.visitorId);
      }
    } else {
      const named = reason.match(/^(\S{4,64})\b/);
      if (!named) {
        await sayWaiting(chatId, msg.message_id);
        return;
      }
      reqst = await requestForKey(named[1]);
      if (!reqst) {
        // A word that is nobody — a reason typed without an ID, or a typo in
        // one. The list is the answer either way: pick the ID from it.
        await sayWaiting(chatId, msg.message_id, `<code>${esc(named[1])}</code> matches nobody, so nothing was ${verb === "approve" ? "approved" : verb === "decline" ? "declined" : "sent"}. Put the person's ID right after <code>/${verb}</code>:`);
        return;
      }
      reason = reason.slice(named[0].length).trim();
    }

    if (!reqst) {
      const who = repliedTo ? await personBehind(msg.reply_to_message) : null;
      await say(chatId, who
        ? [
            `${who.email || "This person"} has never sent the EA form, so there is no request to ${isApprove ? "approve" : "decline"}.`,
            "",
            "Ask them to open the MT5 page and fill in the request — then it lands here and this command works.",
            "",
            "They are reachable meanwhile: anything you type here WITHOUT a slash goes to them as a normal reply.",
          ].join("\n")
        : "That is not an EA access request, so there is nothing to approve. Swipe-reply to the request itself, or to anything that person sent.",
        msg.message_id);
      return;
    }

    // A decision is about the person, so it settles every open row of theirs.
    const alsoSettled = await markAnswered(reqst.visitorId);

    /* Under us, but not funded: neither approved nor declined. They are told
       to deposit — any amount, with the bonus — and the request leaves the
       waiting list until they reply; a swipe-reply /approve on that reply
       still finds it, because its status is untouched. */
    if (isDeposit) {
      const told = await recordSupportReply(reqst.visitorId, depositMessage(reqst.email));
      await say(chatId, told
        ? `💳 ${reqst.name} (${reqst.email}) has been asked to deposit first. Their request waits — swipe-reply /approve when they come back funded.`
        : `⚠️ Could not deliver the deposit message — tell ${reqst.email} yourself.`,
        msg.message_id);
      return told ? "deposit" : null;
    }

    if (isApprove) {
      const code = await approveRequest(reqst.id);
      if (!code) {
        await say(chatId, "⚠️ Could not issue a code just now. Nothing was sent — try again in a moment.", msg.message_id);
        return null;
      }
      const delivered = await recordSupportReply(reqst.visitorId, codeMessage(code, reqst.mt5Login,
        `Your Headway account (${reqst.email}) is confirmed under our community — here is your download code:`));
      await say(chatId, delivered
        ? `✅ Approved. Code <code>${code}</code> sent to ${reqst.name} (${reqst.email}${reqst.phone ? `, ${reqst.phone}` : ""}).${alsoSettled > 1 ? ` Their ${alsoSettled - 1} other open request${alsoSettled === 2 ? "" : "s"} left the waiting list with it.` : ""}`
        : `⚠️ Code <code>${code}</code> was issued but could not be delivered. Send it to ${reqst.email} yourself.`,
        msg.message_id);
      return delivered ? "approved" : null;
    }

    await declineRequest(reqst.id);
    const times = await declineCount(reqst.visitorId);
    // A repeat decline is not the first one said again. The first is two
    // messages — check the login, then how to be moved under us — and in one
    // bubble they read as the same thing. The repeat is one short message:
    // they already know to check.
    let first, second = true;
    if (times > 1) {
      first = await recordSupportReply(reqst.visitorId, [
        `We checked again and your Headway account — ${reqst.name} (${reqst.email}) — is still not showing under our partner group.`,
        reason, "",
        "Headway has to attach it — we cannot do it from our side. Ask Headway support to move your account under our Partner ID, or open a new account through our link, which places it under us automatically:",
        "",
        `Partner ID: ${PARTNER_ID}`,
        `Sign-up link: ${DERIV_SIGNUP}`,
        "",
        "Reply here once it is done and we will check again.",
        "",
        MISTAKE_LINE,
      ].filter((line, i) => i !== 1 || line !== "").join("\n"));
    } else {
      first = await recordSupportReply(reqst.visitorId, [
        `We could not find a Headway account for ${reqst.name} (${reqst.email}) under our partner group, so we cannot send a code yet.`,
        reason, "",
        "First, check that the name and email you sent are exactly the ones registered at Headway — if they differ, reply here with the right ones:",
      ].filter((line, i) => i !== 1 || line !== "").join("\n"));
      second = await recordSupportReply(reqst.visitorId, [
        "If they were already right, then your account is not under us yet — and only Headway can move it.",
        "",
        "Ask Headway support to attach your account to our Partner ID:",
        PARTNER_ID, "",
        "That is OUR Partner ID, not yours — give them that one.",
        "",
        `Or open a new Headway account through our link, which places it under us automatically: ${DERIV_SIGNUP}`,
        "",
        "Reply here once it is done and we will check again.",
        "",
        MISTAKE_LINE,
      ].join("\n"));
    }

    await say(chatId, (first && second)
      ? `Declined. ${reqst.name} (${reqst.email}) has been told, with the Partner ID and sign-up link.${times > 1 ? ` This is decline #${times} for them — they got the follow-up wording, not the first one again.` : ""}${alsoSettled > 1 ? ` Their ${alsoSettled - 1} other open request${alsoSettled === 2 ? "" : "s"} left the waiting list with it.` : ""}`
      : `Declined, but the message could not be delivered — tell ${reqst.email} yourself.`,
      msg.message_id);
    return (first && second) ? "declined" : null;
  }

  /* Telegram gives several sizes of a photo, smallest first; the last is the
     full one. A document keeps its own name and mime type. */
  const photoId = msg.photo && msg.photo.length ? msg.photo[msg.photo.length - 1].file_id : null;
  const docId = msg.document && msg.document.file_id;
  const hasFile = !!(photoId || docId);

  // ── a reply to a support message: deliver it, with whatever came attached ──
  if (repliedTo && (text || hasFile) && text[0] !== "/") {
    const who = await personBehind(msg.reply_to_message);

    if (!who) {
      await say(chatId, "That is not a support message, so there is nobody to send it to. Swipe-reply to the message from the person you want to answer.", msg.message_id);
      return;
    }

    /* Fetched and re-hosted before the message is recorded, because a link to
       Telegram's own copy carries our bot token in the URL. A file that would
       not store must not take the words down with it. */
    let file = null;
    if (photoId) file = await saveTelegramFile(photoId, "screenshot.jpg", "image/jpeg");
    else if (docId) file = await saveTelegramFile(docId, msg.document.file_name || "file", msg.document.mime_type);
    const fileFailed = hasFile && !file;

    const stored = (text || file) ? await recordSupportReply(who.visitorId, text, file) : false;
    // Answering somebody IS dealing with them: their EA request leaves the
    // waiting list. It decides nothing — /approve and /decline still work.
    const cleared = stored ? await markAnswered(who.visitorId) : 0;
    await say(
      chatId,
      stored
        ? [
            `✅ Delivered to <code>${who.visitorId}</code>. They will see it in the support window on the site${who.email ? ` — ${who.email}` : ""}.`,
            file ? `📎 ${file.name} went with it.` : "",
            fileFailed ? "⚠️ The attachment could not be stored, so only your text went. Try sending the file again." : "",
            cleared ? "Their EA request is off the waiting list — you have answered them. <code>/approve</code> or <code>/decline</code> still work on it from any message of theirs." : "",
          ].filter(Boolean).join("\n")
        : fileFailed && !text
          ? "⚠️ That attachment could not be stored, so nothing was sent. Try again in a moment."
          : "⚠️ Could not deliver that just now. Nothing was sent — try again in a moment.",
      msg.message_id,
    );
    return;
  }

  // ── the door: /ban, /unban ──
  //
  // Swipe-reply to somebody's message to act on THEM, or name an email. The
  // swipe-reply is the safer of the two, because it cannot land on the wrong
  // person.
  const doorCmd = /^\/(ban|unban)(?:@[A-Za-z0-9_]+)?\b/i.exec(text);
  if (doorCmd) {
    const banning = /^ban$/i.test(doorCmd[1]);
    const rest = text.slice(doorCmd[0].length).trim();
    let visitorId = null, email = null, reason = rest;

    if (repliedTo) {
      const who = await personBehind(msg.reply_to_message);
      if (!who) {
        await say(chatId, `That is not a support message, so there is nobody to act on. Swipe-reply to a message from the person you mean, or send <code>/${banning ? "ban" : "unban"} their@email</code>.`, msg.message_id);
        return;
      }
      visitorId = who.visitorId; email = who.email;
    } else {
      const named = rest.match(/^(\S+@\S+\.\S+|[A-Za-z0-9-]{6,})\b/);
      if (!named) {
        await say(chatId, `Say who. Swipe-reply to their message, or send <code>/${banning ? "ban" : "unban"} their@email</code>.`, msg.message_id);
        return;
      }
      if (named[1].includes("@")) email = named[1]; else visitorId = named[1];
      reason = rest.slice(named[0].length).trim();
    }

    if (banning) {
      const done = await banPerson({ visitorId, email, reason: reason || null });
      // Somebody shown the door is not somebody you still owe a decision.
      if (done && done.visitorId) await markAnswered(done.visitorId);
      else if (done && done.email) await markAnsweredByEmail(done.email);
      await say(chatId, done
        ? [
            `Banned ${done.email || done.visitorId}.`,
            done.reason ? `Reason: ${done.reason}` : "",
            "",
            "Their messages and EA requests stop reaching you. Nothing tells them so — the window just goes quiet.",
            `Undo with <code>/unban ${done.email || done.visitorId}</code>.`,
          ].filter(Boolean).join("\n")
        : "Could not record that ban.", msg.message_id);
      return;
    }

    const key = email || visitorId || "";
    const lifted = await unbanPerson(key);
    await say(chatId, lifted
      ? `Unbanned ${lifted.email || lifted.visitorId}. They can write in again. The row stays in <code>/bans</code> so the history is not lost.`
      : `No active ban found for <code>${key}</code>.`, msg.message_id);
    return;
  }

  // ── the list, and emptying it ──
  if (/^\/bans\b/i.test(text)) {
    const arg = text.replace(/^\/bans(?:@[A-Za-z0-9_]+)?/i, "").trim().toLowerCase();
    if (arg === "clear" || arg === "clear lifted" || arg === "clear all") {
      const which = arg === "clear all" ? "all" : "lifted";
      const gone = await clearBans(which);
      await say(chatId, which === "all"
        ? `Cleared the whole list — ${gone} row${gone === 1 ? "" : "s"} deleted. Everyone who was banned is unbanned.`
        : `Cleared ${gone} lifted ban${gone === 1 ? "" : "s"}. Active bans are untouched — <code>/bans clear all</code> removes those too.`, msg.message_id);
      return;
    }
    const rows = await listBans(40);
    if (!rows.length) {
      await say(chatId, "Nobody is banned, and nobody has been.", msg.message_id);
      return;
    }
    const live = rows.filter((r) => r.active);
    await say(chatId, [
      `<b>Bans</b> — ${live.length} active of ${rows.length}`,
      "",
      ...rows.slice(0, 25).map((r) => {
        const who = r.email || r.visitorId || "?";
        const day = String(r.bannedAt).slice(0, 10);
        return r.active
          ? `⛔ <code>${who}</code> — ${day}${r.reason ? ` — ${r.reason}` : ""}`
          : `✓ <code>${who}</code> — banned ${day}, lifted ${String(r.unbannedAt || "").slice(0, 10)}`;
      }),
      rows.length > 25 ? `\n…and ${rows.length - 25} more.` : "",
      "",
      "<code>/bans clear</code> removes the lifted ones, <code>/bans clear all</code> empties it entirely.",
    ].filter(Boolean).join("\n"), msg.message_id);
    return;
  }

  // ── who has written in ──
  if (/^\/users\b/i.test(text)) {
    const people = await listPeople(40);
    if (!people.length) {
      await say(chatId, "Nobody has written in yet.", msg.message_id);
      return;
    }
    // Banned people are marked rather than hidden.
    const marks = await Promise.all(people.map((u) => isBanned(u.visitorId, u.email)));
    await say(chatId, [
      `<b>People</b> — ${people.length}`,
      "",
      ...people.slice(0, 30).map((u, i) => {
        const when = String(u.last).slice(0, 10), since = String(u.first).slice(0, 10);
        return [
          `${marks[i] ? "⛔ " : ""}<b>${u.name || "(no name)"}</b>`,
          `  ${u.email || "(no email)"}`,
          `  ${since === when ? when : `${since} → ${when}`} · ${u.messages} msg${u.messages === 1 ? "" : "s"}`,
        ].join("\n");
      }),
      people.length > 30 ? `\n…and ${people.length - 30} more.` : "",
    ].filter(Boolean).join("\n"), msg.message_id);
    return;
  }

  // ── commands and stray messages ──
  if (/^\/start\b/.test(text)) {
    await say(chatId, [
      "<b>Shalobot support is connected.</b>",
      "",
      "Messages from the support bubble on shalobot.com arrive here.",
      "",
      "<b>To answer someone, swipe-reply to their message.</b> Your reply appears in their support window on the site within seconds.",
      "",
      "Typing here without replying to a message sends it nowhere — there is no way to tell who it was meant for.",
      "",
      "<b>MT5 EA requests:</b> swipe-reply to the request with <code>/approve</code> to issue a download code, <code>/decline your reason</code> to turn it down, or <code>/deposit</code> when the account is under us but not funded yet. Without a reply, the same commands need the person's ID — the one shown in the request: <code>/approve 3A8ACC6A</code>.",
      "",
      "<b>The waiting list:</b> <code>/waiting</code> lists everyone still owed something — an EA request to decide, messages with no reply yet (a question, a screenshot, anything they wrote), or both — longest waiting first, one message each with what they said. Each one quotes their newest message: tap the quote to jump there and scroll up for the whole conversation, or tap 📜 History. Its buttons approve, ask for a deposit or decline (each asks first), ✍️ Reply answers them, ✔️ Done takes them off the list without a reply. <code>/approve</code>, <code>/decline</code> or <code>/deposit</code> on their own show the same list.",
      "",
      "<b>Screenshots and files:</b> swipe-reply with a photo or a document and it appears in their support window. People can send you both as well.",
      "",
      "<b>Keeping people out:</b> swipe-reply and send <code>/ban</code> (add a reason if you want one recorded), or <code>/ban their@email</code>. Their messages stop reaching you and they are told nothing. <code>/unban</code> lifts it. <code>/bans</code> is the list, <code>/bans clear</code> tidies the lifted ones and <code>/bans clear all</code> empties it.",
      "",
      "<b>Who has written in:</b> <code>/users</code> — names, emails and dates, banned ones marked.",
    ].join("\n"));
  } else if (/^\/(help|status)\b/.test(text)) {
    await say(chatId, "Swipe-reply to a support message to answer it — text, a photo or a document. /waiting lists everyone owed an answer or a decision, with what they said and buttons to approve, ask for a deposit, decline, reply, read the whole history or close. For an MT5 EA request you can also swipe-reply with /approve, /decline reason or /deposit, or send /approve ID. /ban and /unban control who gets through, /bans is that list, /users is everyone who has written in. A message with no reply attached has no recipient.");
  } else if (hasFile) {
    await say(chatId, "That file went nowhere — I could not tell who it was for. <b>Swipe-reply</b> with it to the message from the person you are answering, and it will appear in their support window.");
  } else {
    await say(chatId, "Nothing was sent — I could not tell who that was for. <b>Swipe-reply</b> to someone's support message to answer them.");
  }
}
