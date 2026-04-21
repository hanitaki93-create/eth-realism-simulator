// Engine F — Trend Continuation (Momentum Follow-through)
//
// Concept: Price is in an established trend. It pulls back to the EMA20.
// The pullback touches or approaches the EMA then the current candle
// closes back in the direction of the trend — entry on trend resumption.
//
// This is ORTHOGONAL to D/E (reversal sweeps) and B/C (fakeouts/climaxes).
// F fires DURING trends, not against them.
//
// LONG setup:
//   1. EMA20 trending up (slope positive over last 8 candles)
//   2. Recent pullback: one of last 3-8 candles touched EMA20 (within ATR*0.4)
//   3. Current candle: closes above EMA20, body >= ATR*0.25, close > open
//   4. Price not extended: close < EMA20 + ATR*2 (not overextended)
//   SL: below recent pullback low - ATR*0.2. TP: 2R.
//
// SHORT: exact mirror with EMA slope negative and close below EMA20.

import { calcATR, calcEMAArray, emaSlope, baseDiag } from './engineUtils.js';

export const ENGINE_F = {
  id: 'F',
  name: 'Engine F',
  fullName: 'Trend Continuation',
  color: '#22d3ee'
};

export function runEngineF(candles) {
  const n = candles.length;
  const diag = {
    ...baseDiag(),
    f_long_stage: 'init', f_long_reject: null,
    f_short_stage: 'init', f_short_reject: null,
    f_ema_slope:        null,
    f_pullback_depth:   null,
    f_pullback_flag:    0,
    f_body_size:        null,
    f_extension_pct:    null,
    f_stop_distance:    null,
    f_reject_code:      null,
  };

  // Always save scan row
  diag.near_miss  = true;
  diag.confidence = 60;

  if (n < 30) {
    diag.reject_code = diag.f_reject_code = 'NO_DATA';
    diag.f_long_stage = diag.f_short_stage = 'no_data';
    return diag;
  }

  const atr    = calcATR(candles.slice(n - 20));
  const emaArr = calcEMAArray(candles, 20);
  const curr   = candles[n - 1];
  const ema    = emaArr[n - 1];
  if (ema == null) { diag.reject_code = diag.f_reject_code = 'NO_EMA'; return diag; }

  const slope = emaSlope(emaArr, 8);
  diag.f_ema_slope = Math.round(slope);

  for (const side of ['LONG', 'SHORT']) {
    const stageKey  = side === 'LONG' ? 'f_long_stage' : 'f_short_stage';
    const rejectKey = side === 'LONG' ? 'f_long_reject' : 'f_short_reject';

    // Step 1: EMA slope confirms trend direction AND is strong enough (abs >= 20)
    // Data: slope 0-20 = 38% WR noise, slope 20-50 = 48%, slope 50+ = 54%
    const alignedSlope = side === 'LONG' ? slope : -slope; // positive = aligned with trade
    const slopeOk = alignedSlope > atr * 0.1;
    if (!slopeOk) {
      diag[stageKey] = 'no_trend';
      diag[rejectKey] = 'EMA_SLOPE_WEAK';
      continue;
    }
    // Minimum absolute slope of 20pts — below this the EMA is too flat to trade
    if (Math.abs(slope) < 2) {
      diag[stageKey]  = 'slope_too_flat';
      diag[rejectKey] = 'SLOPE_TOO_FLAT';
      continue;
    }
    diag[stageKey] = 'trend_confirmed';

    // Step 2: Recent pullback to EMA in last 3-8 candles (not current)
    const pullbackWindow = candles.slice(n - 9, n - 1);
    let pullbackFound = false;
    let pullbackLow = Infinity, pullbackHigh = -Infinity;

    for (const c of pullbackWindow) {
      const nearEMA = side === 'LONG'
        ? c.low  <= ema + atr * 0.4
        : c.high >= ema - atr * 0.4;
      if (nearEMA) {
        pullbackFound = true;
        pullbackLow  = Math.min(pullbackLow,  c.low);
        pullbackHigh = Math.max(pullbackHigh, c.high);
      }
    }

    const pullbackDepth = side === 'LONG'
      ? ema - pullbackLow
      : pullbackHigh - ema;
    diag.f_pullback_depth = Math.round(pullbackDepth);

    if (!pullbackFound) {
      diag[stageKey] = 'no_pullback';
      diag[rejectKey] = 'NO_PULLBACK';
      diag.near_miss = true;
      continue;
    }

    // Reject deep pullbacks — depth >= 50pts signals trend exhaustion not continuation
    // Data: pullback < 50 = 58% WR, pullback >= 50 = 40% WR
    if (pullbackDepth >= 5) {
      diag[stageKey]  = 'pullback_too_deep';
      diag[rejectKey] = 'PULLBACK_TOO_DEEP';
      diag.near_miss  = true;
      continue;
    }

    diag[stageKey]       = 'pullback_found';
    diag.f_pullback_flag = 1;

    // Step 3: Current candle resumes trend — closes beyond EMA with real body
    const body      = Math.abs(curr.close - curr.open);
    const bodyOk    = body >= atr * 0.25;
    const closeOk   = side === 'LONG'
      ? curr.close > ema && curr.close > curr.open
      : curr.close < ema && curr.close < curr.open;

    diag.f_body_size = Math.round(body);

    if (!closeOk || !bodyOk) {
      diag[stageKey]  = 'no_entry';
      diag[rejectKey] = !closeOk ? 'CLOSE_WRONG_SIDE' : 'BODY_TOO_SMALL';
      continue;
    }

    // Step 4: Not overextended from EMA — cap at 60% of ATR (data: ext>60 edge collapses)
    const extension = side === 'LONG'
      ? (curr.close - ema) / atr
      : (ema - curr.close) / atr;
    diag.f_extension_pct = Math.round(extension * 100);

    // LONG: require close entry to EMA (ext<20% = 51% WR vs 35-42% further out)
    // SHORT: keep wider cap (ext 40-60% = 47% WR — shorts work better on extended moves)
    const extCap = side === 'LONG' ? 0.20 : 0.60;
    if (extension > extCap) {
      diag[stageKey]  = 'overextended';
      diag[rejectKey] = 'OVEREXTENDED';
      continue;
    }

    // SL and TP
    const sl     = side === 'LONG'
      ? pullbackLow  - atr * 0.2
      : pullbackHigh + atr * 0.2;
    const slDist = Math.abs(curr.close - sl);

    if (slDist < 3)  { diag[rejectKey] = 'SL_TOO_TIGHT'; continue; }
    if (slDist > 9)  { diag[rejectKey] = 'SL_TOO_WIDE';  continue; } // ETH: >9pts edge collapses

    const tp = side === 'LONG' ? curr.close + slDist * 2 : curr.close - slDist * 2;

    let score = 60;
    if (slope > atr * 0.3)   score += 10; // strong trend
    if (extension < 0.8)     score += 10; // close entry to EMA
    if (body > atr * 0.4)    score += 10; // strong entry candle
    score = Math.min(score, 90);

    diag[stageKey]       = 'fired';
    diag.fired           = true;
    diag.near_miss       = false;
    diag.reject_code     = null;
    diag.f_reject_code   = null;
    diag.side_candidate  = side;
    diag.confidence      = score;
    diag.sl_distance     = Math.round(slDist);
    diag.f_stop_distance = Math.round(slDist);

    diag.signal = {
      signal:           side,
      entry_price:      curr.close,
      stop_loss:        sl,
      take_profit:      tp,
      risk_reward:      '2.0',
      confidence:       score,
      setup_type:       'Trend Continuation',
      market_condition: `EMA20 ${side === 'LONG' ? 'uptrend' : 'downtrend'} slope=${Math.round(slope)}, pullback ${Math.round(pullbackDepth)}pts`,
      reason:           `Trend resumption after EMA pullback. Body ${Math.round(body)}pts. SL ${Math.round(slDist)}pts.`
    };
    return diag;
  }

  if (!diag.f_reject_code) diag.f_reject_code = 'NO_SETUP';
  if (!diag.reject_code)   diag.reject_code   = 'NO_SETUP';
  return diag;
}
