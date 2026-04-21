// Engine D — Sweep Reclaim v2
//
// Rebuilt from scratch. Simple, local, diagnosable.
//
// LONG: find swing low in recent history, current candle wicks below it but closes above → LONG
// SHORT: find swing high in recent history, current candle wicks above it but closes below → SHORT
//
// No BOS gate. No distant structural targets. Sweep+reclaim close IS the signal.
// Always saves scan row with full diagnostic info for both paths.

export const ENGINE_D = {
  id: 'D',
  name: 'Engine D',
  fullName: 'Sweep Reclaim',
  color: '#f97316'
};

export function runEngineD(candles) {
  const n = candles.length;

  // Always export both paths for diagnostics
  const diag = {
    fired: false, near_miss: false, reject_code: null,
    side_candidate: null, confidence: 0, sl_distance: null,

    // LONG path
    d_long_stage:        'init',
    d_long_reject:       null,
    d_long_swing_level:  null,
    d_long_sweep_size:   null,

    // SHORT path
    d_short_stage:       'init',
    d_short_reject:      null,
    d_short_swing_level: null,
    d_short_sweep_size:  null,

    // Shared
    d_swing_level:              null,
    d_sweep_direction:          null,
    d_sweep_size_pct:           null,
    d_close_back_inside_flag:   null,
    d_bos_level:                null,
    d_bos_confirmed_flag:       0,
    d_bars_from_sweep_to_bos:   null,
    d_stop_distance:            null,
    d_same_zone_cooldown_block: 0,
    // Quality scoring
    d_quality_score:      null,
    d_qs_sweep_precision: null,
    d_qs_reclaim_str:     null,
    d_qs_wick_efficiency: null,
    d_qs_entry_recovery:  null,
    d_qs_swing_clarity:   null,
    signal: null
  };

  // Always force scan row to save — critical for diagnosis
  diag.near_miss  = true;
  diag.confidence = 55;

  if (n < 30) {
    diag.reject_code       = 'NO_DATA';
    diag.d_long_stage      = 'no_data';
    diag.d_short_stage     = 'no_data';
    return diag;
  }

  const curr = candles[n - 1];
  const atr  = calcATR(candles.slice(n - 20));

  // ── LONG path ─────────────────────────────────────────────────────────────
  // Step 1: swing low = lowest low in candles[n-24, n-4] (skip last 3, they're too recent)
  const longWindow = candles.slice(n - 24, n - 3);
  const swingLow   = Math.min(...longWindow.map(c => c.low));
  diag.d_long_swing_level = Math.round(swingLow);
  diag.d_long_stage       = 'swing_found';

  // Step 2: current candle wicks below swing low AND closes back above it
  const longSwept   = curr.low  < swingLow;
  const longReclaim = curr.close > swingLow;

  if (!longSwept) {
    diag.d_long_stage  = 'no_sweep';
    diag.d_long_reject = 'LOW_ABOVE_SWING';
  } else if (!longReclaim) {
    diag.d_long_stage  = 'swept_no_reclaim';
    diag.d_long_reject = 'CLOSE_BELOW_SWING';
    diag.near_miss     = true; // wick crossed but didn't close back — near miss
    diag.d_long_sweep_size = Math.round(swingLow - curr.low);
  } else {
    // Valid LONG sweep reclaim
    const sweepSize    = swingLow - curr.low;
    const sweepPct     = (sweepSize / swingLow) * 100;
    diag.d_long_stage  = 'fired';
    diag.d_long_sweep_size = Math.round(sweepSize);

    const sl     = curr.low - Math.max(atr * 0.2, 3);
    const slDist = curr.close - sl;

    if (slDist < 3) {
      diag.d_long_stage  = 'sl_too_tight';
      diag.d_long_reject = 'SL_TOO_TIGHT';
    } else if (slDist > 70) {
      diag.d_long_stage  = 'sl_too_wide';
      diag.d_long_reject = 'SL_TOO_WIDE';
    } else {
      const tp = curr.close + slDist * 2;

      // Quality score — v45: hard threshold >= 66
      const qsLong = calcQualityScore({
        sweepSize, sweepPct, swingLevel: swingLow,
        candleRange: curr.high - curr.low,
        close: curr.close, slDist, atr,
        window: longWindow, side: 'LONG'
      });

      // Always export score for diagnostics
      diag.d_quality_score      = qsLong.total;
      diag.d_qs_sweep_precision = qsLong.sweepPrecision;
      diag.d_qs_reclaim_str     = qsLong.reclaimStr;
      diag.d_qs_wick_efficiency = qsLong.wickEfficiency;
      diag.d_qs_entry_recovery  = qsLong.entryRecovery;
      diag.d_qs_swing_clarity   = qsLong.swingClarity;

      if (qsLong.total < 72) {
        diag.d_long_stage  = 'low_quality';
        diag.d_long_reject = 'SCORE_BELOW_THRESHOLD';
        diag.near_miss     = true;
      } else {
        diag.fired                    = true;
        diag.near_miss                = false;
        diag.reject_code              = null;
        diag.side_candidate           = 'LONG';
        diag.d_sweep_direction        = 'sell_side';
        diag.d_swing_level            = Math.round(swingLow);
        diag.d_sweep_size_pct         = Math.round(sweepPct * 100) / 100;
        diag.d_close_back_inside_flag = 1;
        diag.d_bos_confirmed_flag     = 0;
        diag.d_bars_from_sweep_to_bos = 0;
        diag.d_stop_distance          = Math.round(slDist);
        diag.sl_distance              = Math.round(slDist);
        diag.confidence               = calcConfidence(sweepPct, slDist, atr);
        diag.signal = {
          signal:           'LONG',
          entry_price:      curr.close,
          stop_loss:        sl,
          take_profit:      tp,
          risk_reward:      '2.0',
          confidence:       diag.confidence,
          setup_type:       'Sweep Reclaim',
          market_condition: `sell-side sweep of swing low ${Math.round(swingLow)}, reclaimed on close`,
          reason:           `Wick ${Math.round(sweepSize)}pts below swing low, closed back above. SL ${Math.round(slDist)}pts. Quality=${qsLong.total}`
        };
        return diag;
      }
    }
  }

  // ── SHORT path ────────────────────────────────────────────────────────────
  const shortWindow = candles.slice(n - 24, n - 3);
  const swingHigh   = Math.max(...shortWindow.map(c => c.high));
  diag.d_short_swing_level = Math.round(swingHigh);
  diag.d_short_stage       = 'swing_found';

  const shortSwept   = curr.high  > swingHigh;
  const shortReclaim = curr.close < swingHigh;

  if (!shortSwept) {
    diag.d_short_stage  = 'no_sweep';
    diag.d_short_reject = 'HIGH_BELOW_SWING';
  } else if (!shortReclaim) {
    diag.d_short_stage  = 'swept_no_reclaim';
    diag.d_short_reject = 'CLOSE_ABOVE_SWING';
    diag.near_miss      = true;
    diag.d_short_sweep_size = Math.round(curr.high - swingHigh);
  } else {
    const sweepSize     = curr.high - swingHigh;
    const sweepPct      = (sweepSize / swingHigh) * 100;
    diag.d_short_stage  = 'fired';
    diag.d_short_sweep_size = Math.round(sweepSize);

    const sl     = curr.high + Math.max(atr * 0.2, 3);
    const slDist = sl - curr.close;

    if (slDist < 3) {
      diag.d_short_stage  = 'sl_too_tight';
      diag.d_short_reject = 'SL_TOO_TIGHT';
    } else if (slDist > 70) {
      diag.d_short_stage  = 'sl_too_wide';
      diag.d_short_reject = 'SL_TOO_WIDE';
    } else {
      const tp = curr.close - slDist * 2;

      // Quality score — v45: hard threshold >= 66
      const qsShort = calcQualityScore({
        sweepSize, sweepPct, swingLevel: swingHigh,
        candleRange: curr.high - curr.low,
        close: curr.close, slDist, atr,
        window: shortWindow, side: 'SHORT'
      });

      // Always export score for diagnostics
      diag.d_quality_score      = qsShort.total;
      diag.d_qs_sweep_precision = qsShort.sweepPrecision;
      diag.d_qs_reclaim_str     = qsShort.reclaimStr;
      diag.d_qs_wick_efficiency = qsShort.wickEfficiency;
      diag.d_qs_entry_recovery  = qsShort.entryRecovery;
      diag.d_qs_swing_clarity   = qsShort.swingClarity;

      if (qsShort.total < 72) {
        diag.d_short_stage  = 'low_quality';
        diag.d_short_reject = 'SCORE_BELOW_THRESHOLD';
        diag.near_miss      = true;
      } else {
        diag.fired                    = true;
        diag.near_miss                = false;
        diag.reject_code              = null;
        diag.side_candidate           = 'SHORT';
        diag.d_sweep_direction        = 'buy_side';
        diag.d_swing_level            = Math.round(swingHigh);
        diag.d_sweep_size_pct         = Math.round(sweepPct * 100) / 100;
        diag.d_close_back_inside_flag = 1;
        diag.d_bos_confirmed_flag     = 0;
        diag.d_bars_from_sweep_to_bos = 0;
        diag.d_stop_distance          = Math.round(slDist);
        diag.sl_distance              = Math.round(slDist);
        diag.confidence               = calcConfidence(sweepPct, slDist, atr);
        diag.signal = {
          signal:           'SHORT',
          entry_price:      curr.close,
          stop_loss:        sl,
          take_profit:      tp,
          risk_reward:      '2.0',
          confidence:       diag.confidence,
          setup_type:       'Sweep Reclaim',
          market_condition: `buy-side sweep of swing high ${Math.round(swingHigh)}, rejected on close`,
          reason:           `Wick ${Math.round(sweepSize)}pts above swing high, closed back below. SL ${Math.round(slDist)}pts. Quality=${qsShort.total}`
        };
        return diag;
      }
    }
  }

  // Neither side fired
  if (!diag.reject_code) diag.reject_code = 'NO_SETUP';
  return diag;
}

function calcQualityScore({ sweepSize, sweepPct, swingLevel, candleRange, close, slDist, atr, window, side }) {
  // All components calibrated from 1Y replay data.
  // Key finding: precision and restraint = better outcomes.
  // Stronger reclaims, bigger wicks, and deeper recovery all HURT WR.

  // 1. Sweep precision (25pts): smaller sweep = more surgical, better WR
  //    Data: <0.1% → +0.59 R/trade, >0.3% → +0.13, >0.5% → -0.33
  const sweepPrecision = Math.round(
    sweepPct <= 0.05 ? 25 :
    sweepPct <= 0.1  ? 22 :
    sweepPct <= 0.2  ? 16 :
    sweepPct <= 0.3  ? 10 :
    sweepPct <= 0.5  ? 5  : 0
  );

  // 2. Reclaim restraint (25pts): INVERTED — weaker close-back = better
  //    Data: score=3(weak) → 59% WR +0.77, score=25(strong) → 44% WR +0.33
  //    Interpretation: precise stop hunt with minimal momentum = cleaner setup
  const reclaimRaw = candleRange > 0
    ? (side === 'LONG' ? (close - swingLevel) : (swingLevel - close)) / candleRange
    : 0;
  const reclaimRestraint = Math.round(
    reclaimRaw < 0.1  ? 25 :
    reclaimRaw < 0.25 ? 20 :
    reclaimRaw < 0.4  ? 13 :
    reclaimRaw < 0.6  ? 7  : 3
  );

  // 3. Wick restraint (20pts): INVERTED — smaller wick ratio = better
  //    Data: score=2(small wick) → 59% WR +0.76, score=20(big wick) → 46% WR +0.39
  //    Interpretation: sweep dominated by a tight, purposeful wick, not a wide momentum bar
  const wickRatio = candleRange > 0 ? sweepSize / candleRange : 0;
  const wickRestraint = Math.round(
    wickRatio < 0.1  ? 20 :
    wickRatio < 0.2  ? 16 :
    wickRatio < 0.35 ? 11 :
    wickRatio < 0.5  ? 6  : 2
  );

  // 4. Entry proximity (15pts): INVERTED — close near swing level = better
  //    Data: score=3(close to swing) → 61% WR +0.83, score=15(far) → 46% WR +0.39
  //    Interpretation: entry right at the swept level = tight, high-conviction entry
  const recoveryRaw = atr > 0
    ? (side === 'LONG' ? (close - swingLevel) : (swingLevel - close)) / atr
    : 0;
  const entryProximity = Math.round(
    recoveryRaw < 0.1  ? 15 :
    recoveryRaw < 0.25 ? 12 :
    recoveryRaw < 0.4  ? 7  : 3
  );

  // 5. Swing isolation (15pts): INVERTED — less distinct swing = better
  //    Data: lower clarity scores had slightly better outcomes
  //    Interpretation: the best sweeps happen at modest, unobvious swing levels
  //    not at obvious "everyone can see it" extremes that get front-run
  const extremes = side === 'LONG'
    ? window.map(c => c.low).sort((a, b) => a - b)
    : window.map(c => c.high).sort((a, b) => b - a);
  const gap = Math.abs(extremes[1] - extremes[0]);
  const gapPct = swingLevel > 0 ? (gap / swingLevel) * 100 : 0;
  const swingIsolation = Math.round(
    gapPct < 0.03 ? 15 :
    gapPct < 0.08 ? 12 :
    gapPct < 0.15 ? 8  : 4
  );

  const total = sweepPrecision + reclaimRestraint + wickRestraint + entryProximity + swingIsolation;
  return {
    total,
    sweepPrecision,
    reclaimStr:     reclaimRestraint,
    wickEfficiency: wickRestraint,
    entryRecovery:  entryProximity,
    swingClarity:   swingIsolation
  };
}

function calcConfidence(sweepPct, slDist, atr) {
  let score = 60;
  if (sweepPct < 0.15) score += 15; // tight precise sweep
  if (slDist < atr * 0.6) score += 10; // tight SL relative to volatility
  return Math.min(score, 90);
}

function calcATR(candles, period = 14) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const p = candles[i - 1];
    return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  });
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}
