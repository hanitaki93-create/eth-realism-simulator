// Engine G — Compression Breakout Expansion
//
// Concept: Price compresses into a tight range (low ATR, candles contracting).
// Then breaks out with a real expansion candle. Entry on the breakout close.
//
// Orthogonal to all existing engines:
// - D/E: reversal sweeps   → G: directional breakout
// - B: fakeout reversal    → G: breakout confirmation (opposite)
// - C: climax reversal     → G: momentum initiation
// - F: trend continuation  → G: fires at START of a move, not mid-trend
//
// LONG setup:
//   1. Compression: last 8-15 candles have ATR < base_ATR * 0.7 (contracting volatility)
//   2. Compression range: high-low of compression zone is < base_ATR * 3
//   3. Breakout: current candle closes ABOVE compression zone high
//   4. Expansion: current candle body >= ATR * 0.4 (real move, not noise)
//   5. SL: below compression zone low - ATR*0.15. TP: 2R.
//
// SHORT: mirror — closes below compression zone low.

import { calcATR, baseDiag } from './engineUtils.js';

export const ENGINE_G = {
  id: 'G',
  name: 'Engine G',
  fullName: 'Compression Breakout',
  color: '#f59e0b'
};

export function runEngineG(candles) {
  const n = candles.length;
  const diag = {
    ...baseDiag(),
    g_long_stage: 'init', g_long_reject: null,
    g_short_stage: 'init', g_short_reject: null,
    g_compression_atr_ratio: null,
    g_compression_range:     null,
    g_breakout_flag:         0,
    g_body_size:             null,
    g_comp_zone_high:        null,
    g_comp_zone_low:         null,
    g_stop_distance:         null,
    g_reject_code:           null,
  };

  // Always save scan row
  diag.near_miss  = true;
  diag.confidence = 60;

  if (n < 35) {
    diag.reject_code = diag.g_reject_code = 'NO_DATA';
    diag.g_long_stage = diag.g_short_stage = 'no_data';
    return diag;
  }

  // Base ATR from older window (before compression)
  const baseATR = calcATR(candles.slice(n - 35, n - 10));
  const curr    = candles[n - 1];

  // Compression window: last 8-15 candles (not current)
  const COMP_MIN = 8;
  const COMP_MAX = 15;

  // Find best compression window
  let bestWindow = null;
  let bestRatio  = 1.0;

  for (let wLen = COMP_MIN; wLen <= COMP_MAX; wLen++) {
    const window = candles.slice(n - 1 - wLen, n - 1);
    const compATR = calcATR(window);
    const ratio   = compATR / baseATR;
    if (ratio < bestRatio) {
      bestRatio  = ratio;
      bestWindow = window;
    }
  }

  diag.g_compression_atr_ratio = Math.round(bestRatio * 100) / 100;

  // Must be genuinely compressed
  if (bestRatio > 0.72 || !bestWindow) {
    diag.g_long_stage   = 'no_compression';
    diag.g_short_stage  = 'no_compression';
    diag.g_reject_code  = 'NOT_COMPRESSED';
    diag.reject_code    = 'NOT_COMPRESSED';
    return diag;
  }

  const zoneHigh = Math.max(...bestWindow.map(c => c.high));
  const zoneLow  = Math.min(...bestWindow.map(c => c.low));
  const zoneRange = zoneHigh - zoneLow;

  diag.g_compression_range = Math.round(zoneRange);
  diag.g_comp_zone_high    = Math.round(zoneHigh);
  diag.g_comp_zone_low     = Math.round(zoneLow);

  // Zone must be tight
  if (zoneRange > baseATR * 3.5) {
    diag.g_long_stage  = 'zone_too_wide';
    diag.g_short_stage = 'zone_too_wide';
    diag.g_reject_code = 'ZONE_TOO_WIDE';
    diag.reject_code   = 'ZONE_TOO_WIDE';
    return diag;
  }

  const body    = Math.abs(curr.close - curr.open);
  const currATR = calcATR(candles.slice(n - 20));
  diag.g_body_size = Math.round(body);

  for (const side of ['LONG', 'SHORT']) {
    const stageKey  = side === 'LONG' ? 'g_long_stage' : 'g_short_stage';
    const rejectKey = side === 'LONG' ? 'g_long_reject' : 'g_short_reject';

    // LONG blocked — 3Y data: LONG 32.5% WR ~0R, upside compression breakouts are structural fakeouts on 5M BTC
    if (side === 'LONG') {
      diag[stageKey]  = 'long_blocked';
      diag[rejectKey] = 'LONG_BLOCKED';
      continue;
    }

    // Breakout: current candle closes beyond zone
    const breakout = side === 'LONG'
      ? curr.close > zoneHigh && curr.close > curr.open
      : curr.close < zoneLow  && curr.close < curr.open;

    if (!breakout) {
      // Near miss: within ATR*0.3 of zone edge
      const gap = side === 'LONG'
        ? zoneHigh - curr.high
        : curr.low - zoneLow;
      if (gap < currATR * 0.3) diag.near_miss = true;
      diag[stageKey]  = 'no_breakout';
      diag[rejectKey] = 'NO_BREAKOUT';
      continue;
    }

    // Real body required — not a wick poke
    if (body < currATR * 0.35) {
      diag[stageKey]  = 'weak_body';
      diag[rejectKey] = 'BODY_TOO_SMALL';
      continue;
    }

    // SL and TP
    const sl     = side === 'LONG'
      ? zoneLow  - currATR * 0.15
      : zoneHigh + currATR * 0.15;
    const slDist = Math.abs(curr.close - sl);

    if (slDist < 3)  { diag[rejectKey] = 'SL_TOO_TIGHT'; continue; }
    if (slDist > 7) { diag[rejectKey] = 'SL_TOO_WIDE';  continue; } // data: SL>7 WR drops to 35%+0.06

    const tp = side === 'LONG' ? curr.close + slDist * 2 : curr.close - slDist * 2;

    let score = 60;
    if (bestRatio < 0.5)          score += 15; // very tight compression
    else if (bestRatio < 0.65)    score += 8;
    if (body > currATR * 0.6)     score += 10; // strong expansion candle
    if (zoneRange < baseATR * 2)  score += 10; // tight zone
    score = Math.min(score, 92);

    diag[stageKey]       = 'fired';
    diag.g_breakout_flag = 1;
    diag.fired           = true;
    diag.near_miss       = false;
    diag.reject_code     = null;
    diag.g_reject_code   = null;
    diag.side_candidate  = side;
    diag.confidence      = score;
    diag.sl_distance     = Math.round(slDist);
    diag.g_stop_distance = Math.round(slDist);

    diag.signal = {
      signal:           side,
      entry_price:      curr.close,
      stop_loss:        sl,
      take_profit:      tp,
      risk_reward:      '2.0',
      confidence:       score,
      setup_type:       'Compression Breakout',
      market_condition: `ATR compressed to ${Math.round(bestRatio*100)}% of baseline. Zone ${Math.round(zoneLow)}-${Math.round(zoneHigh)} (${Math.round(zoneRange)}pts)`,
      reason:           `Compression ratio ${Math.round(bestRatio*100)}%, breakout body ${Math.round(body)}pts. SL ${Math.round(slDist)}pts.`
    };
    return diag;
  }

  if (!diag.g_reject_code) diag.g_reject_code = 'NO_SETUP';
  if (!diag.reject_code)   diag.reject_code   = 'NO_SETUP';
  return diag;
}
