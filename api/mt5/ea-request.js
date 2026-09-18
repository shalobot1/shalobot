/**
 * SOMEBODY ASKING FOR THE EVIE MT5 EA.
 *
 * The form on the bot's page collects the name and email as registered at
 * Headway, a phone number and the channel to reach it on (WhatsApp/Telegram).
 * This records it, then posts it into Telegram THROUGH THE SUPPORT PIPE rather
 * than as its own kind of notification — so it arrives in the same chat as
 * everything else, carries the conversation this person has already had, and
 * is answered the same way: /approve or /decline, handled in the webhook.
 * Everything the person sees afterwards happens in the support bubble.
 *
 * Whatever they paste is taken as the ID. Client IDs are not all one shape,
 * and an ID guessed at by a regex is an ID refused from somebody holding the
 * real thing. A wrong one simply gets declined, which is a reply, not a wall.
 */

const { readBody, json, recordSupportInbound, supportHistory, isBanned } = require("../_lib/db");
const { createRequest, attachTelegramMessage, recentRequestCount, approvedCodeFor, approvedMatch, approveRequest, codeMessage, PARTNER_ID } = require("../_lib/ea");
const { recordSupportReply } = require("../_lib/db");

const API = "https://api.telegram.org";
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || "").trim());
const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max).replace(/\s+/g, " ") : "");
const CHANNELS = { whatsapp: "WhatsApp", telegram: "Telegram" };
/** +254 712 345 678 — readable on a phone screen. */
const prettyPhone = (p) => String(p || "").replace(/^(\+\d{1,3})(\d{3})(\d{3})(\d+)$/, "$1 $2 $3 $4");
/** A tap-to-chat link for the channel they chose. */
const chatLink = (phone, contact) => contact === "telegram" ? `https://t.me/${phone}` : `https://wa.me/${String(phone).replace(/\D/g, "")}`;
const countryName = (iso) => { try { return new Intl.DisplayNames(["en"], { type: "region" }).of(iso); } catch (e) { return iso; } };

function renderHistory(history) {
  if (!history || !history.length) return "";
  const lines = history.slice(-6).map((h) => `${h.from === "us" ? "↩︎ us" : "› them"}: ${esc(String(h.body || "").slice(0, 160))}`);
  return `<b>─── Conversation so far (${history.length}) ───</b>\n${lines.join("\n")}`;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });

  const body = await readBody(req);
  const visitorId = clean(body.visitorId, 64);
  const name = clean(body.name, 80);
  const email = clean(body.email, 160).toLowerCase();
  const phone = clean(body.phone, 20).replace(/[^\d+]/g, "");
  const contact = clean(body.contact, 12).toLowerCase();
  const country = clean(body.country, 2).toUpperCase();
  const lang = clean(body.lang, 8).toLowerCase();
  const page = clean(body.page, 200);
  // The ID column stays filled so older rows and newer ones read the same way.
  const mt5Login = phone;

  if (!visitorId) return json(res, 400, { error: "Reload the page and try again." });
  if (name.length < 2) return json(res, 422, { error: "Please give us your full name as registered at Headway." });
  if (!isEmail(email)) return json(res, 422, { error: "That email does not look right." });
  // The name and email are what gets checked; the phone and the channel are how
  // we guide them afterwards, welcome but not required.
  if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) return json(res, 422, { error: "That phone number does not look right — choose the country and type the number." });
  if (contact && !CHANNELS[contact]) return json(res, 422, { error: "Choose WhatsApp or Telegram so we know where to reach you." });
  const via = CHANNELS[contact] || "";
  const reach = phone ? `${phone}${via ? ` on ${via}` : ""}` : "no phone given";

  /* Barred people are turned away before anything is recorded or sent, so a
     ban is quiet: nothing reaches Telegram and no row accumulates. */
  if (await isBanned(visitorId, email)) {
    return json(res, 403, { error: "We cannot take this request. If you think that is a mistake, reach us through the website." });
  }

  /* ALREADY APPROVED, WITH DOWNLOADS LEFT — send the code back, do not queue
     them again. The form has no memory of having been answered; a returning
     visitor fills it in a second time, and that used to put somebody approved
     an hour ago back in the decision queue. They hold a live code: they need
     to be told it again. A spent code falls through to the re-approval. */
  const already = await approvedCodeFor(visitorId);
  if (already && already.usesLeft > 0) {
    await recordSupportReply(visitorId, codeMessage(already.code, already.mt5Login,
      `You are already approved — here is your code again. It has ${already.usesLeft} download${already.usesLeft === 1 ? "" : "s"} left:`));
    return json(res, 200, { ok: true, already: true });
  }

  /* A brake rather than a rule: somebody who mistypes their ID twice should be
     able to fix it, somebody scripting the form should not get far. */
  if ((await recentRequestCount(visitorId)) >= 5) {
    return json(res, 429, { error: "You have sent several requests already. Give us a little time to look at the first one." });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    console.error("[ea] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set");
    return json(res, 502, { error: "We could not reach the team just now. Please try again in a few minutes." });
  }

  /* APPROVED BEFORE WITH THIS EXACT EMAIL AND ID — on any browser. A spent
     code, or a new device: the same two facts that were checked the first
     time are checked again, by machine, and a fresh code is issued to THIS
     browser at once. The owner is told, with everything needed to /ban if it
     looks wrong, but is not asked. */
  const match = await approvedMatch(email, phone, name);
  if (match) {
    const newId = await createRequest({ visitorId, mt5Login, name, email, page, phone, contact, country });
    const code = newId ? await approveRequest(newId) : null;
    if (code) {
      const why = already ? "your previous code was used up" : "you are on a new browser";
      await recordSupportInbound({ visitorId, body: `Asked for the Shalobot EA again — ${email}, ${reach}`, email, name, source: "MT5 EA access", page });
      await recordSupportReply(visitorId, codeMessage(code, mt5Login,
        `Approved again automatically — same email and phone as before, and ${why}. Here is your new code:`));
      await fetch(`${API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chat, parse_mode: "HTML", disable_web_page_prshalow: true,
          text: [
            "<b>MT5 EA access · Shalobot — approved automatically</b>",
            `<b>Name:</b> ${esc(name)} · <b>Email:</b> <a href="mailto:${esc(email)}">${esc(email)}</a>`,
            phone ? `<b>Phone:</b> <code>${esc(prettyPhone(phone))}</code>${via ? ` · <b>${via}:</b> <a href="${chatLink(phone, contact)}">open chat</a>` : ""}` : "<b>Phone:</b> not given",
            `<b>Person:</b> <code>${esc(visitorId)}</code>`,
            "",
            `Same email and phone as an earlier approval (${why}), so code <code>${code}</code> was issued without asking.`,
            "",
            "If that is not right, swipe-reply <code>/ban</code> — the code stops working with it.",
          ].join("\n"),
        }),
      }).catch((e) => console.error("[ea] telegram unreachable (auto):", e));
      return json(res, 200, { ok: true, already: true, auto: true });
    }
  }

  const id = await createRequest({ visitorId, mt5Login, name, email, page, phone, contact, country });
  const history = await supportHistory(visitorId);

  /* Written the way it needs to be read on a phone: the two facts to check
     against the partner list first, then how to reach the person, then the
     two commands last, because that is the reply. */
  const when = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const header = [
    "<b>🤖 MT5 EA access · Shalobot (Headway)</b>",
    "",
    `<b>👤 Name:</b> ${esc(name)}`,
    `<b>✉️ Email:</b> <a href="mailto:${esc(email)}">${esc(email)}</a>`,
    phone ? `<b>📱 Phone:</b> <code>${esc(prettyPhone(phone))}</code>` : "<b>📱 Phone:</b> not given",
    phone && via ? `<b>💬 Contact on:</b> ${via} — <a href="${chatLink(phone, contact)}">open chat</a>` : (phone ? "<b>💬 Contact on:</b> not chosen" : ""),
    country ? `<b>🌍 Country:</b> ${esc(countryName(country))} (${esc(country)})${lang ? ` · <b>Language:</b> ${esc(lang)}` : ""}` : (lang ? `<b>🌍 Language:</b> ${esc(lang)}` : ""),
    `<b>🕒 Sent:</b> ${when}`,
    page ? `<b>🔗 Page:</b> ${esc(page)}` : "",
    `<b>🆔 Person:</b> <code>${esc(visitorId)}</code>`,
  ].filter(Boolean).join("\n");

  const request = [
    `<b>✅ To check:</b> the name and email above under Headway Partner ID <code>${PARTNER_ID}</code>.`,
    "",
    id
      ? "Swipe-reply /approve to send them a code, or /decline &lt;reason&gt; to say no."
      : "⚠️ This one could NOT be recorded, so /approve has nothing to issue a code against — the shalo_ea_requests table is missing. Apply the migration, then ask them to send the form again.",
  ].join("\n");

  let tgId = null;
  try {
    const r = await fetch(`${API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text: [header, renderHistory(history), request].filter(Boolean).join("\n\n"),
        parse_mode: "HTML",
        disable_web_page_prshalow: true,
      }),
    });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      tgId = j && j.result && typeof j.result.message_id === "number" ? j.result.message_id : null;
    } else {
      console.error("[ea] telegram refused:", r.status, await r.text().catch(() => ""));
    }
  } catch (e) {
    console.error("[ea] telegram unreachable:", e);
  }

  /* Recorded as an inbound support message too, so it sits in this person's
     thread: the code arrives as a reply to it, and the next time they write in
     about anything the whole exchange is attached. */
  await recordSupportInbound({
    visitorId,
    body: `Asked for the Shalobot EA — ${email}, ${reach}`,
    tgMessageId: tgId,
    email,
    name,
    source: "MT5 EA access",
    page,
  });

  if (id && typeof tgId === "number" && tgId > 0) await attachTelegramMessage(id, tgId);

  /* Telegram being down does not lose the request — it is recorded and can be
     approved by hand. Saying "sent" when nothing was sent would be the worse
     failure, so the caller is told plainly. */
  if (tgId === null) {
    return json(res, 502, { error: "We could not reach the team just now. Your details are saved — please try again in a few minutes." });
  }

  return json(res, 200, { ok: true });
};
