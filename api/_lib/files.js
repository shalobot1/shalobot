/**
 * SUPPORT ATTACHMENTS — getting a file from Telegram to the person on the site.
 *
 * Telegram never hands over the file itself, only an id. Fetching it is two
 * calls: getFile turns the id into a path, then the path is downloaded from the
 * file host with the bot token in the URL. That token is the only thing
 * guarding it, which is exactly why the download is re-hosted here rather than
 * linked: a link to Telegram's copy is a link with our bot token in it, handed
 * to whoever opens the support window.
 *
 * The re-hosted name is random. The sender's own filename is kept as a label,
 * not as a path — a name that reaches the storage key can collide, escape its
 * folder, or be guessed.
 */

const { randomBytes } = require("crypto");

const BUCKET = "support-files";
const API = "https://api.telegram.org";
/** 10MB — the smaller of Telegram's bot-download ceiling and any sane screenshot. */
const MAX_BYTES = 10 * 1024 * 1024;

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf", "text/plain": "txt", "text/csv": "csv", "application/json": "json" };

/** Put bytes in the bucket and return { url, name, type }, or null. Never throws:
 *  an attachment that cannot be stored must not take the message down with it. */
async function storeFile(bytes, name, type) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  if (bytes.length > MAX_BYTES) { console.error("[shalo files] too large:", bytes.length); return null; }

  const ext = EXT[type] || ((String(name).match(/\.([A-Za-z0-9]{1,8})$/) || [])[1] || "bin").toLowerCase();
  const path = `${new Date().toISOString().slice(0, 10)}/${randomBytes(12).toString("hex")}.${ext}`;

  const r = await fetch(`${base}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": type || "application/octet-stream", "x-upsert": "false" },
    body: bytes,
  });
  if (!r.ok) { console.error("[shalo files] upload failed:", r.status, await r.text().catch(() => "")); return null; }

  return { url: `${base}/storage/v1/object/public/${BUCKET}/${path}`, name: String(name || `file.${ext}`).slice(0, 120), type: type || "application/octet-stream" };
}

/** Fetch a file the owner sent in Telegram and re-host it. Photos have no
 *  filename of their own — Telegram re-encodes them — so one is invented. */
async function saveTelegramFile(fileId, fallbackName, declaredType) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const meta = await fetch(`${API}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`).then((r) => r.json());
    const path = meta && meta.result && meta.result.file_path;
    if (!meta || !meta.ok || !path) { console.error("[shalo files] getFile gave no path"); return null; }
    if ((meta.result.file_size || 0) > MAX_BYTES) { console.error("[shalo files] telegram file too large"); return null; }

    const res = await fetch(`${API}/file/bot${token}/${path}`);
    if (!res.ok) { console.error("[shalo files] download failed:", res.status); return null; }
    const bytes = Buffer.from(await res.arrayBuffer());
    const type = declaredType || res.headers.get("content-type") || guessType(path);
    return storeFile(bytes, fallbackName || path.split("/").pop() || "file", type);
  } catch (e) {
    console.error("[shalo files] telegram fetch threw:", e);
    return null;
  }
}

function guessType(path) {
  const ext = ((String(path).match(/\.([A-Za-z0-9]{1,8})$/) || [])[1] || "").toLowerCase();
  for (const [type, e] of Object.entries(EXT)) if (e === ext) return type;
  return "application/octet-stream";
}

module.exports = { storeFile, saveTelegramFile, MAX_BYTES };
