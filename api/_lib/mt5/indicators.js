/**
 * EVIE MT5 — the indicators. Pure functions, no dependencies.
 *
 * Every one takes a chronological array of candles (oldest first) and answers
 * for the LATEST bar. Thresholds everywhere else are expressed in ATRs or
 * percentages rather than pips, which is the only reason the same code is
 * correct on a five-decimal currency pair and on a two-decimal synthetic index.
 */

const closes = (c) => c.map((x) => x.c);

/** Simple moving average of the last `n` values. */
function sma(v, n) {
  if (v.length < n) return NaN;
  let s = 0;
  for (let i = v.length - n; i < v.length; i++) s += v[i];
  return s / n;
}

/** Exponential moving average, as a series the same length as its input. */
function emaSeries(v, n) {
  const out = [];
  if (!v.length) return out;
  const k = 2 / (n + 1);
  let prev = v[0];
  for (let i = 0; i < v.length; i++) {
    prev = i === 0 ? v[0] : v[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

const ema = (v, n) => {
  const s = emaSeries(v, n);
  return s.length ? s[s.length - 1] : NaN;
};

function stdev(v, n) {
  if (v.length < n) return NaN;
  const slice = v.slice(v.length - n);
  const m = slice.reduce((a, b) => a + b, 0) / n;
  const varr = slice.reduce((a, b) => a + (b - m) * (b - m), 0) / n;
  return Math.sqrt(varr);
}

function trueRanges(c) {
  const tr = [];
  for (let i = 0; i < c.length; i++) {
    if (i === 0) { tr.push(c[i].h - c[i].l); continue; }
    const p = c[i - 1].c;
    tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - p), Math.abs(c[i].l - p)));
  }
  return tr;
}

/** Wilder's ATR — the yardstick everything else is measured in. */
function atr(c, n = 14) {
  if (c.length < n + 1) return NaN;
  const tr = trueRanges(c);
  let a = tr.slice(1, n + 1).reduce((x, y) => x + y, 0) / n;
  for (let i = n + 1; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}

/** Wilder's ADX, 0..100 — how strong a trend is, saying nothing about which way. */
function adx(c, n = 14) {
  if (c.length < 2 * n + 1) return NaN;
  const plusDM = [0], minusDM = [0], tr = [0];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].h - c[i - 1].h;
    const down = c[i - 1].l - c[i].l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    const p = c[i - 1].c;
    tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - p), Math.abs(c[i].l - p)));
  }
  const wilder = (v) => {
    const out = [];
    let s = 0;
    for (let i = 1; i <= n; i++) s += v[i] || 0;
    out[n] = s;
    for (let i = n + 1; i < v.length; i++) out[i] = out[i - 1] - out[i - 1] / n + v[i];
    return out;
  };
  const trS = wilder(tr), pS = wilder(plusDM), mS = wilder(minusDM);
  const dx = [];
  for (let i = n; i < c.length; i++) {
    if (!trS[i]) { dx.push(0); continue; }
    const pdi = 100 * (pS[i] / trS[i]);
    const mdi = 100 * (mS[i] / trS[i]);
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum);
  }
  if (dx.length < n) return NaN;
  let adxVal = dx.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < dx.length; i++) adxVal = (adxVal * (n - 1) + dx[i]) / n;
  return adxVal;
}

/** Choppiness, 0..100 — high means the market is going nowhere in a wide box. */
function choppiness(c, n = 14) {
  if (c.length < n + 1) return NaN;
  const tr = trueRanges(c);
  const slice = c.slice(c.length - n);
  const atrSum = tr.slice(tr.length - n).reduce((a, b) => a + b, 0);
  const hh = Math.max(...slice.map((x) => x.h));
  const ll = Math.min(...slice.map((x) => x.l));
  const range = hh - ll;
  if (range <= 0 || atrSum <= 0) return 50;
  return (100 * Math.log10(atrSum / range)) / Math.log10(n);
}

/** Highest high and lowest low of the last `n` bars, the current one excluded. */
function donchian(c, n) {
  const s = c.slice(Math.max(0, c.length - 1 - n), c.length - 1);
  return { hi: Math.max(...s.map((x) => x.h)), lo: Math.min(...s.map((x) => x.l)) };
}

/** Keltner channel — an EMA with ATR shoulders. */
function keltner(c, n = 20, mult = 2) {
  const mid = ema(closes(c), n);
  const a = atr(c, n);
  return { mid, upper: mid + mult * a, lower: mid - mult * a };
}

/** Bollinger bands. */
function bollinger(c, n = 20, mult = 2) {
  const v = closes(c);
  const mid = sma(v, n);
  const sd = stdev(v, n);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

/** Wilder's RSI — seeded on the first n changes, then smoothed over the rest. */
function rsi(c, n = 14) {
  const v = closes(c);
  if (v.length < n + 1) return NaN;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = v[i] - v[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / n, al = loss / n;
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    ag = (ag * (n - 1) + (d > 0 ? d : 0)) / n;
    al = (al * (n - 1) + (d < 0 ? -d : 0)) / n;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

/** How many standard deviations the latest close sits from its own mean. */
function zScore(c, n = 20) {
  const v = closes(c);
  const m = sma(v, n);
  const sd = stdev(v, n);
  if (!sd) return 0;
  return (v[v.length - 1] - m) / sd;
}

module.exports = {
  closes, sma, emaSeries, ema, stdev, atr, adx, choppiness, donchian, keltner, bollinger, rsi, zScore,
};
