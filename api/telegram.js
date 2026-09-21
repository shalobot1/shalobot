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
 * listened to at all.
 */

const {
  readBody, json, supportVisitorFor, supportVisitorById, recordSupportReply, listPeople,
  isBanned, banPerson, unbanPerson, listBans, clearBans,
} = require("./_lib/db");
const { saveTelegramFile } = require("./_lib/files");
const {
  requestForTelegramMessage, requestForVisitor, waitingPeople, requestForKey, approveRequest, declineRequest,
  markAnswered, markAnsweredByEmail, declineCount, codeMessage, depositMessage, MISTAKE_LINE, PARTNER_ID, DERIV_PROFILE, DERIV_SIGNUP, EXAMPLE_CLIENT_ID,
} = require("./_lib/ea");

const API = "https://api.telegram.org";

async function say(chatId, text, replyTo) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const payload = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_prshalow: true };
  if (replyTo) { payload.reply_to_message_id = replyTo; payload.allow_sending_without_reply = true; }
  await fetch(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => { /* nothing useful to do about it here */ });
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

/**
 * THE WAITING LIST — everyone still owed a decision, one entry per person,
 * each with the ID that addresses them. Tap the ID in Telegram and it is
 * copied; the command with that ID after it reaches exactly that person, in
 * the support window of the browser they asked from. Long lists go out in
 * several messages, because Telegram stops at 4096 characters.
 */
async function sayWaiting(chatId, replyTo, lead) {
  const people = await waitingPeople();
  if (!people.length) {
    await say(chatId, `${lead ? lead + "\n\n" : ""}Nothing is waiting for a decision right now. Everyone who asked has been answered.`, replyTo);
    return;
  }
  const entries = people.map((p, i) => [
    `${i + 1}. <b>${esc(p.name || "(no name)")}</b>`,
    `   ✉️ ${esc(p.email || "(no email)")}${p.otherEmails.length ? ` (also sent as ${p.otherEmails.map(esc).join(", ")})` : ""}`,
    `   📱 ${p.phone ? `${esc(prettyPhone(p.phone))}${CHANNEL[p.contact] ? ` · ${CHANNEL[p.contact]}` : ""}` : "no phone given"}`,
    p.country ? `   🌍 ${esc(countryName(p.country))} (${esc(p.country)})` : "",
    `   🕒 ${when(p.firstAt || p.createdAt)}${p.requests > 1 ? ` · asked ${p.requests} times, last ${when(p.createdAt).split(" · ")[1] || ""} — one decision settles all` : ""}`,
    `   🆔 <code>${esc(p.visitorId)}</code>`,
  ].filter(Boolean).join("\n"));

  const head = `${lead ? lead + "\n\n" : ""}📋 <b>Waiting for a decision — ${people.length} ${people.length === 1 ? "person" : "people"}</b> — longest waiting first`;
  const foot = [
    "Tap an ID to copy it, then send the command with it:",
    `<code>/approve ${esc(people[0].visitorId)}</code> — send the code`,
    `<code>/decline ${esc(people[0].visitorId)} your reason</code> — turn it down`,
    `<code>/deposit ${esc(people[0].visitorId)}</code> — under us, but not funded yet`,
    "",
    "Swipe-replying to any message from that person still works too.",
  ].join("\n");

  const LIMIT = 3800;
  const chunks = [];
  let cur = head;
  for (const e of entries) {
    if ((cur + "\n\n" + e).length > LIMIT) { chunks.push(cur); cur = e; }
    else cur += "\n\n" + e;
  }
  if ((cur + "\n\n" + foot).length > LIMIT) { chunks.push(cur); cur = foot; }
  else cur += "\n\n" + foot;
  chunks.push(cur);
  for (let i = 0; i < chunks.length; i++) await say(chatId, chunks[i], i === 0 ? replyTo : undefined);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  // 200, not 401: a wrong caller should learn nothing, and Telegram must not
  // start retrying a delivery that was never ours.
  if (!secret || req.headers["x-telegram-bot-api-secret-token"] !== secret) return json(res, 200, { ok: true });

  const update = await readBody(req);
  const msg = (update && update.message) || null;
  const chatId = msg && msg.chat ? msg.chat.id : null;
  // A photo or a document arrives with `caption` instead of `text`.
  const text = String((msg && (msg.text || msg.caption)) || "").trim();

  if (typeof chatId !== "number") return json(res, 200, { ok: true });
  // A stranger who finds the bot is not someone we want putting words in front
  // of our visitors.
  if (String(chatId) !== process.env.TELEGRAM_CHAT_ID) return json(res, 200, { ok: true });

  const repliedTo = msg.reply_to_message && msg.reply_to_message.message_id;

  /* Who a swipe-reply is for. The visitor's own message (words or picture)
     is the normal target. But a thread on a phone quickly fills with the
     bot's own lines — "Delivered to 3A8ACC6A", the original header with its
     "Person:" id — and swiping on one of those is a reasonable thing to do
     mid-conversation. Every bot message about a person carries their id, so
     it is read back out. */
  async function personBehind(replied) {
    if (!replied) return null;
    const direct = await supportVisitorFor(replied.message_id);
    if (direct) return direct;
    if (!(replied.from && replied.from.is_bot)) return null;
    const m = /\b([0-9A-F]{8})\b/.exec(String(replied.text || replied.caption || ""));
    return m ? supportVisitorById(m[1]) : null;
  }

  // ── the waiting list on its own ──
  if (/^\/(waiting|pending|list)(?:@[A-Za-z0-9_]+)?\b/i.test(text)) {
    await sayWaiting(chatId, msg.message_id);
    return json(res, 200, { ok: true });
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
        return json(res, 200, { ok: true });
      }
      reqst = await requestForKey(named[1]);
      if (!reqst) {
        // A word that is nobody — a reason typed without an ID, or a typo in
        // one. The list is the answer either way: pick the ID from it.
        await sayWaiting(chatId, msg.message_id, `<code>${esc(named[1])}</code> matches nobody, so nothing was ${verb === "approve" ? "approved" : verb === "decline" ? "declined" : "sent"}. Put the person's ID right after <code>/${verb}</code>:`);
        return json(res, 200, { ok: true });
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
      return json(res, 200, { ok: true });
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
      return json(res, 200, { ok: true });
    }

    if (isApprove) {
      const code = await approveRequest(reqst.id);
      if (!code) {
        await say(chatId, "⚠️ Could not issue a code just now. Nothing was sent — try again in a moment.", msg.message_id);
        return json(res, 200, { ok: true });
      }
      const delivered = await recordSupportReply(reqst.visitorId, codeMessage(code, reqst.mt5Login,
        `Your Headway account (${reqst.email}) is confirmed under our community — here is your download code:`));
      await say(chatId, delivered
        ? `✅ Approved. Code <code>${code}</code> sent to ${reqst.name} (${reqst.email}${reqst.phone ? `, ${reqst.phone}` : ""}).${alsoSettled > 1 ? ` Their ${alsoSettled - 1} other open request${alsoSettled === 2 ? "" : "s"} left the waiting list with it.` : ""}`
        : `⚠️ Code <code>${code}</code> was issued but could not be delivered. Send it to ${reqst.email} yourself.`,
        msg.message_id);
      return json(res, 200, { ok: true });
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
    return json(res, 200, { ok: true });
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
      return json(res, 200, { ok: true });
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
    return json(res, 200, { ok: true });
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
        return json(res, 200, { ok: true });
      }
      visitorId = who.visitorId; email = who.email;
    } else {
      const named = rest.match(/^(\S+@\S+\.\S+|[A-Za-z0-9-]{6,})\b/);
      if (!named) {
        await say(chatId, `Say who. Swipe-reply to their message, or send <code>/${banning ? "ban" : "unban"} their@email</code>.`, msg.message_id);
        return json(res, 200, { ok: true });
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
      return json(res, 200, { ok: true });
    }

    const key = email || visitorId || "";
    const lifted = await unbanPerson(key);
    await say(chatId, lifted
      ? `Unbanned ${lifted.email || lifted.visitorId}. They can write in again. The row stays in <code>/bans</code> so the history is not lost.`
      : `No active ban found for <code>${key}</code>.`, msg.message_id);
    return json(res, 200, { ok: true });
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
      return json(res, 200, { ok: true });
    }
    const rows = await listBans(40);
    if (!rows.length) {
      await say(chatId, "Nobody is banned, and nobody has been.", msg.message_id);
      return json(res, 200, { ok: true });
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
    return json(res, 200, { ok: true });
  }

  // ── who has written in ──
  if (/^\/users\b/i.test(text)) {
    const people = await listPeople(40);
    if (!people.length) {
      await say(chatId, "Nobody has written in yet.", msg.message_id);
      return json(res, 200, { ok: true });
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
    return json(res, 200, { ok: true });
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
      "<b>The waiting list:</b> send <code>/approve</code>, <code>/decline</code>, <code>/deposit</code> or <code>/waiting</code> on its own and everyone still owed a decision is listed — name, email, phone, when they asked — each with an ID you tap to copy. Anybody already approved or already answered is not listed.",
      "",
      "<b>Screenshots and files:</b> swipe-reply with a photo or a document and it appears in their support window. People can send you both as well.",
      "",
      "<b>Keeping people out:</b> swipe-reply and send <code>/ban</code> (add a reason if you want one recorded), or <code>/ban their@email</code>. Their messages stop reaching you and they are told nothing. <code>/unban</code> lifts it. <code>/bans</code> is the list, <code>/bans clear</code> tidies the lifted ones and <code>/bans clear all</code> empties it.",
      "",
      "<b>Who has written in:</b> <code>/users</code> — names, emails and dates, banned ones marked.",
    ].join("\n"));
  } else if (/^\/(help|status)\b/.test(text)) {
    await say(chatId, "Swipe-reply to a support message to answer it — text, a photo or a document. For an MT5 EA request swipe-reply with /approve, /decline reason or /deposit — or send the command on its own to see everyone waiting, each with an ID to copy, then /approve ID. /ban and /unban control who gets through, /bans is that list, /users is everyone who has written in. A message with no reply attached has no recipient.");
  } else if (hasFile) {
    await say(chatId, "That file went nowhere — I could not tell who it was for. <b>Swipe-reply</b> with it to the message from the person you are answering, and it will appear in their support window.");
  } else {
    await say(chatId, "Nothing was sent — I could not tell who that was for. <b>Swipe-reply</b> to someone's support message to answer them.");
  }

  return json(res, 200, { ok: true });
};
