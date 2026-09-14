/**
 * EVIE MT5 — where the candles come from.
 *
 * Straight from Deriv, over their public market-data socket. Market data needs
 * no token and no account, which is why this page works for somebody who has
 * never connected one.
 *
 * Every symbol goes down a SINGLE socket. Deriv answers each request with the
 * `req_id` it was asked with, so one connection can carry the whole basket at
 * once and the replies still sort themselves out. Opening the socket costs
 * about a second; the thirty-odd histories that follow cost under two more.
 * Doing it a symbol at a time, or a category at a time, would spend that first
 * second over and over for nothing.
 *
 * This runs in Node, where WebSocket has been part of the language runtime
 * since Node 22 — so there is no dependency here, and nothing to install.
 */

const WS_URL = "wss://ws.derivws.com/websockets/v3?app_id=1089";

const toCandle = (c) => ({ t: c.epoch, o: +c.open, h: +c.high, l: +c.low, c: +c.close });

/**
 * Fetch candles for many symbols over one connection.
 *
 * Resolves with whatever arrived. A symbol Deriv refuses, or one that is simply
 * slow, comes back missing rather than taking the whole basket down with it —
 * one unavailable market must not cost the page every other market.
 *
 * @param {string[]} symbols  Deriv WS symbols, e.g. ["frxEURUSD", "R_75"]
 * @param {number} granularity  seconds per candle (300 = M5)
 * @param {number} count  bars per symbol
 */
function fetchCandlesBatch(symbols, granularity = 300, count = 250, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const out = new Map();
    if (!symbols.length) return resolve(out);
    if (typeof WebSocket !== "function") {
      console.error("[shalo mt5] no WebSocket in this runtime — needs Node 22 or newer");
      return resolve(out);
    }

    let ws;
    try { ws = new WebSocket(WS_URL); }
    catch (e) { console.error("[shalo mt5] could not open the Deriv socket:", e); return resolve(out); }

    const idToSymbol = new Map();
    let pending = symbols.length;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (e) { /* already closing */ }
      resolve(out);
    };
    const timer = setTimeout(finish, timeoutMs);

    ws.onopen = () => {
      symbols.forEach((sym, i) => {
        const req_id = i + 1;
        idToSymbol.set(req_id, sym);
        ws.send(JSON.stringify({
          ticks_history: sym, end: "latest", count, style: "candles", granularity, req_id,
        }));
      });
    };

    ws.onmessage = (ev) => {
      let d;
      try { d = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); }
      catch (e) { return; }
      const sym = d.req_id != null ? idToSymbol.get(d.req_id) : undefined;
      if (d.msg_type !== "candles" && !d.error) return;
      if (sym) out.set(sym, d.error ? [] : (d.candles || []).map(toCandle));
      if (--pending <= 0) finish();
    };

    ws.onerror = () => finish();
    ws.onclose = () => finish();
  });
}

module.exports = { fetchCandlesBatch };
