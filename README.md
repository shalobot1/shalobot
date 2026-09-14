# Shalobot

Free MT5 trading bots that trade for you — on your own Headway MetaTrader 5 account.

A static site on Vercel with a handful of serverless functions under `api/`. No build step, no framework.

## What is here

| Path | What it does |
|---|---|
| `index.html` | The landing page. **Get started** → the dashboard. |
| `dashboard.html` | Install steps, risk profiles, live signals, and the access sheet that issues the EA. |
| `api/mt5/signals.js` | The signal engine (`api/_lib/mt5/*`) — forex, metals, crypto on the 5-minute bar. Served as JSON to the page and as CSV to the EA. |
| `api/mt5/ea-request.js` | Somebody asking for the EA: MT5 login + name + email → Telegram, through the support pipe. |
| `api/mt5/ea-download.js` | The only route to the `.mq5`, which lives in `api/_files/` — outside the web root — and needs a code issued to *this* browser. Three downloads per code. |
| `api/support.js`, `api/support-replies.js` | The support bubble → Telegram, and the replies back. |
| `api/telegram.js` | The bot's webhook: swipe-reply to answer, `/approve`, `/decline`, `/ban`, `/unban`, `/bans`, `/users`. |
| `supabase/migrations/` | The schema. RLS on, no policies — nothing is reachable from a browser. |

## Environment (Vercel → Settings → Environment Variables)

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_WEBHOOK_SECRET
```

Local copies live in `.env` (gitignored). `.env.example` lists the names.

## Broker

Headway. Sign-up through our partner link places an account under partner code `8abf6d`, which is what an EA request is checked against.
