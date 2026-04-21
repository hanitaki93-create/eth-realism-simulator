// Shared utilities for Engine F and G
// Centralised to avoid duplication and drift

export function calcATR(candles, period = 14) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const p = candles[i - 1];
    return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  });
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

export function calcEMA(candles, period) {
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) ema = candles[i].close * k + ema * (1 - k);
  return ema;
}

// EMA array — returns full array of EMA values (one per candle after warmup)
export function calcEMAArray(candles, period) {
  const k = 2 / (period + 1);
  const result = new Array(candles.length).fill(null);
  let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  result[period - 1] = ema;
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

// Slope of EMA over last N candles (positive = uptrend, negative = downtrend)
export function emaSlope(emaArray, lookback = 5) {
  const n = emaArray.length;
  const now = emaArray[n - 1];
  const past = emaArray[n - 1 - lookback];
  if (now == null || past == null) return 0;
  return now - past;
}

// Simple base diag object shared across engines
export function baseDiag() {
  return {
    fired: false, near_miss: false, reject_code: null,
    side_candidate: null, confidence: 0, sl_distance: null,
    signal: null
  };
}
