/**
 * EVIE MT5 — the market registry.
 *
 * `ws` is the symbol Deriv's feed answers to, which is where the candles come
 * from. `mt5` is what the same instrument is called inside a MetaTrader 5
 * terminal, which is what the Expert Advisor actually places an order on. They
 * are rarely the same string, so both are carried.
 *
 * `corr` groups instruments that move together. Long EUR/USD, GBP/USD and
 * AUD/USD is one bet on the dollar wearing three hats, and the risk governor
 * uses this to refuse to take it three times.
 */

/* Deriv quotes a pip; the number of decimals follows from it. */
const digitsFromPip = (pip) => Math.max(0, Math.round(-Math.log10(pip)));

const def = (ws, mt5, name, category, pip, session, corr, trendOnly = false) => ({
  ws, mt5, name, category, pip, digits: digitsFromPip(pip), session, corr, trendOnly,
});

/* ── FOREX (24/5) ─────────────────────────────────────────────────────────
   The pairs where the spread is a small fraction of a normal stop. The
   expensive minors are absent on purpose: on a strategy that takes its stop
   from ATR, a three-pip spread is a tax large enough to sink an edge that
   would otherwise hold. */
const FOREX = [
  def("frxEURUSD", "EURUSD", "EUR/USD", "forex", 0.00001, "24/5", "USD"),
  def("frxGBPUSD", "GBPUSD", "GBP/USD", "forex", 0.00001, "24/5", "USD"),
  def("frxAUDUSD", "AUDUSD", "AUD/USD", "forex", 0.00001, "24/5", "AUD-USD"),
  def("frxUSDCAD", "USDCAD", "USD/CAD", "forex", 0.00001, "24/5", "USD-CAD"),
  def("frxUSDCHF", "USDCHF", "USD/CHF", "forex", 0.00001, "24/5", "USD-CHF"),
  def("frxUSDJPY", "USDJPY", "USD/JPY", "forex", 0.001, "24/5", "JPY"),
  def("frxEURJPY", "EURJPY", "EUR/JPY", "forex", 0.001, "24/5", "JPY"),
  def("frxGBPJPY", "GBPJPY", "GBP/JPY", "forex", 0.001, "24/5", "JPY"),
  def("frxAUDJPY", "AUDJPY", "AUD/JPY", "forex", 0.001, "24/5", "JPY"),
  def("frxEURGBP", "EURGBP", "EUR/GBP", "forex", 0.00001, "24/5", "EUR-GBP"),
  def("frxEURAUD", "EURAUD", "EUR/AUD", "forex", 0.00001, "24/5", "AUD"),
  def("frxEURCAD", "EURCAD", "EUR/CAD", "forex", 0.00001, "24/5", "CAD"),
  def("frxEURCHF", "EURCHF", "EUR/CHF", "forex", 0.00001, "24/5", "CHF"),
  def("frxGBPAUD", "GBPAUD", "GBP/AUD", "forex", 0.00001, "24/5", "AUD"),
  def("frxAUDCAD", "AUDCAD", "AUD/CAD", "forex", 0.00001, "24/5", "AUD"),
  def("frxAUDCHF", "AUDCHF", "AUD/CHF", "forex", 0.00001, "24/5", "CHF"),
  def("frxAUDNZD", "AUDNZD", "AUD/NZD", "forex", 0.00001, "24/5", "AUD-NZD"),
  def("frxEURNZD", "EURNZD", "EUR/NZD", "forex", 0.00001, "24/5", "NZD"),
  def("frxGBPCAD", "GBPCAD", "GBP/CAD", "forex", 0.00001, "24/5", "CAD"),
  def("frxGBPCHF", "GBPCHF", "GBP/CHF", "forex", 0.00001, "24/5", "CHF"),
  def("frxGBPNZD", "GBPNZD", "GBP/NZD", "forex", 0.00001, "24/5", "NZD"),
  def("frxNZDUSD", "NZDUSD", "NZD/USD", "forex", 0.00001, "24/5", "USD-NZD"),
  def("frxNZDJPY", "NZDJPY", "NZD/JPY", "forex", 0.001, "24/5", "JPY"),
];

/* ── VOLATILITY (24/7) ────────────────────────────────────────────────────
   Deriv's synthetics: constant-volatility random walks that never close, so
   the bot keeps working through the night and the weekend. */
const VOLATILITY = [
  def("R_10", "Volatility 10 Index", "Volatility 10", "volatility", 0.001, "24/7", "vol-10"),
  def("R_25", "Volatility 25 Index", "Volatility 25", "volatility", 0.001, "24/7", "vol-25"),
  def("R_50", "Volatility 50 Index", "Volatility 50", "volatility", 0.0001, "24/7", "vol-50"),
  def("R_75", "Volatility 75 Index", "Volatility 75", "volatility", 0.0001, "24/7", "vol-75"),
  def("R_100", "Volatility 100 Index", "Volatility 100", "volatility", 0.01, "24/7", "vol-100"),
  def("1HZ10V", "Volatility 10 (1s) Index", "Volatility 10 (1s)", "volatility", 0.01, "24/7", "vol-10"),
  def("1HZ25V", "Volatility 25 (1s) Index", "Volatility 25 (1s)", "volatility", 0.01, "24/7", "vol-25"),
  def("1HZ50V", "Volatility 50 (1s) Index", "Volatility 50 (1s)", "volatility", 0.01, "24/7", "vol-50"),
  def("1HZ75V", "Volatility 75 (1s) Index", "Volatility 75 (1s)", "volatility", 0.01, "24/7", "vol-75"),
  def("1HZ100V", "Volatility 100 (1s) Index", "Volatility 100 (1s)", "volatility", 0.01, "24/7", "vol-100"),
];

/* Crash and Boom are asymmetric — the spike only ever goes one way, so they
   must never be faded. Registered, not yet traded. */
const CRASH_BOOM = [
  def("BOOM500", "Boom 500 Index", "Boom 500", "crash_boom", 0.001, "24/7", "boom", true),
  def("BOOM1000", "Boom 1000 Index", "Boom 1000", "crash_boom", 0.001, "24/7", "boom", true),
  def("CRASH500", "Crash 500 Index", "Crash 500", "crash_boom", 0.001, "24/7", "crash", true),
  def("CRASH1000", "Crash 1000 Index", "Crash 1000", "crash_boom", 0.001, "24/7", "crash", true),
];

const STEP = [def("stpRNG", "Step Index", "Step Index 100", "step", 0.1, "24/7", "step")];

const METALS = [
  def("frxXAUUSD", "XAUUSD", "Gold/USD", "metals", 0.01, "24/5", "metal-gold"),
  def("frxXAGUSD", "XAGUSD", "Silver/USD", "metals", 0.0001, "24/5", "metal-silver"),
];

const CRYPTO = [
  def("cryBTCUSD", "BTCUSD", "BTC/USD", "crypto", 0.001, "24/7", "crypto-btc"),
  def("cryETHUSD", "ETHUSD", "ETH/USD", "crypto", 0.00001, "24/7", "crypto-eth"),
];

const ALL_MARKETS = [...FOREX, ...VOLATILITY, ...CRASH_BOOM, ...STEP, ...METALS, ...CRYPTO];

/** The categories the engine actually trades today. The rest are registered so
 *  they can be switched on without touching anything else. */
const LIVE_CATEGORIES = ["forex", "metals", "crypto"];

const marketsByCategory = (c) => ALL_MARKETS.filter((m) => m.category === c);

module.exports = { FOREX, VOLATILITY, ALL_MARKETS, LIVE_CATEGORIES, marketsByCategory };
