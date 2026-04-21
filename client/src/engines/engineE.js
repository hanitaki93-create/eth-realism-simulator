// Engine E — Liquidity Sweep + Reclaim + Local Confirmation v2
//
// LONG:
//   1. Swing low in candles[n-65, n-20] — established, not too recent
//   2. Sweep in candles[n-19, n-5] — wick below swing, closes back above
//   3. Confirm level = highest high of 3 candles after sweep
//   4. Any candle from confirm window onward closes above confirm level → fire
//   5. E_ACTIVE dedup prevents spam (one active trade at a time)
//
// SHORT: exact mirror

export const ENGINE_E = {
  id: 'E',
  name: 'Engine E',
  fullName: 'Sweep Reclaim + Confirm',
  color: '#a855f7'
};

export function runEngineE(candles) {
  const n = candles.length;

  const diag = {
    fired: false, near_miss: false, reject_code: null,
    side_candidate: null, confidence: 0, sl_distance: null,
    e_long_stage:   'init', e_long_reject:  null,
    e_short_stage:  'init', e_short_reject: null,
    e_swing_level:              null,
    e_swing_direction:          null,
    e_sweep_detected:           0,
    e_sweep_size_pct:           null,
    e_reclaim_flag:             0,
    e_confirm_level:            null,
    e_confirm_flag:             0,
    e_bars_from_sweep_to_confirm: null,
    e_stop_distance:            null,
    e_cooldown_block:           0,
    e_reject_code:              null,
    signal: null
  };

  // Force scan row to always save
  diag.near_miss  = true;
  diag.confidence = 60;

  if (n < 30) {
    diag.reject_code   = 'NO_DATA';
    diag.e_reject_code = 'NO_DATA';
    diag.e_long_stage  = 'no_data';
    diag.e_short_stage = 'no_data';
    return diag;
  }

  const curr = candles[n - 1];
  const atr  = calcATR(candles.slice(n - 20));

  for (const side of ['LONG', 'SHORT']) {
    const r = checkSetup(candles, n, atr, side);

    if (side === 'LONG') { diag.e_long_stage  = r.stage; diag.e_long_reject  = r.reject_code; }
    else                 { diag.e_short_stage = r.stage; diag.e_short_reject = r.reject_code; }

    if (r.near_miss && !diag.fired) {
      diag.near_miss         = true;
      diag.e_reject_code     = r.reject_code;
      diag.e_swing_level     = r.swing_level ? Math.round(r.swing_level) : null;
      diag.e_swing_direction = side === 'LONG' ? 'sell_side' : 'buy_side';
      diag.side_candidate    = side;
    }

    if (!r.fired) continue;

    const entry  = curr.close;
    const sl     = side === 'LONG'
      ? r.sweep_extreme - Math.max(atr * 0.2, 3)
      : r.sweep_extreme + Math.max(atr * 0.2, 3);
    const slDist = Math.abs(entry - sl);

    if (slDist < 3)  { diag.e_reject_code = 'SL_TOO_TIGHT'; continue; }
    if (slDist > 8)  { diag.e_reject_code = 'SL_TOO_WIDE_E'; continue; } // ETH: SL>8 = 32-35% WR, below breakeven
    if (slDist > 70) { diag.e_reject_code = 'SL_TOO_WIDE';  continue; }

    // Minimum sweep size — small sweeps (<0.1%) are weak; larger sweeps carry the edge
    if (r.sweep_size_pct < 0.1) { diag.e_reject_code = 'SWEEP_TOO_SMALL'; continue; }

    const tp = side === 'LONG' ? entry + slDist * 2 : entry - slDist * 2;

    let score = 60;
    if (r.sweep_size_pct < 0.1)              score += 15;
    else if (r.sweep_size_pct < 0.25)        score += 8;
    if (r.bars_sweep_to_confirm <= 4)        score += 15;
    else if (r.bars_sweep_to_confirm <= 8)   score += 8;
    score = Math.min(score, 95);

    diag.fired                        = true;
    diag.near_miss                    = false;
    diag.reject_code                  = null;
    diag.e_reject_code                = null;
    diag.side_candidate               = side;
    diag.confidence                   = score;
    diag.sl_distance                  = Math.round(slDist);
    diag.e_swing_level                = Math.round(r.swing_level);
    diag.e_swing_direction            = side === 'LONG' ? 'sell_side' : 'buy_side';
    diag.e_sweep_detected             = 1;
    diag.e_sweep_size_pct             = r.sweep_size_pct;
    diag.e_reclaim_flag               = 1;
    diag.e_confirm_level              = Math.round(r.confirm_level);
    diag.e_confirm_flag               = 1;
    diag.e_bars_from_sweep_to_confirm = r.bars_sweep_to_confirm;
    diag.e_stop_distance              = Math.round(slDist);

    diag.signal = {
      signal:           side,
      entry_price:      entry,
      stop_loss:        sl,
      take_profit:      tp,
      risk_reward:      '2.0',
      confidence:       score,
      setup_type:       'Sweep Reclaim + Confirm',
      market_condition: `${side === 'LONG' ? 'sell-side' : 'buy-side'} sweep of ${r.swing_level.toFixed(0)}, confirmed at ${r.confirm_level.toFixed(0)}`,
      reason:           `Sweep ${r.sweep_size_pct.toFixed(2)}% through swing, confirmed in ${r.bars_sweep_to_confirm}c. SL ${Math.round(slDist)}pts.`
    };
    return diag;
  }

  if (!diag.e_reject_code) diag.e_reject_code = 'NO_SETUP';
  if (!diag.reject_code)   diag.reject_code   = 'NO_SETUP';
  return diag;
}

function checkSetup(candles, n, atr, side) {
  const r = {
    fired: false, near_miss: false, stage: 'init', reject_code: null,
    swing_level: null, sweep_extreme: null, sweep_size_pct: null,
    confirm_level: null, bars_sweep_to_confirm: null
  };

  // ── STEP 1: Swing in [n-65, n-20] — established, not bleeding into sweep zone
  const SW = 4;
  let swingIdx = -1, swingLevel = null;

  for (let i = n - 20; i >= n - 65 + SW; i--) {
    let ok = true;
    for (let j = i - SW; j <= i + SW; j++) {
      if (j === i) continue;
      if (j < 0 || j >= n) { ok = false; break; }
      if (side === 'LONG'  && candles[j].low  <= candles[i].low)  { ok = false; break; }
      if (side === 'SHORT' && candles[j].high >= candles[i].high) { ok = false; break; }
    }
    if (ok) {
      swingIdx   = i;
      swingLevel = side === 'LONG' ? candles[i].low : candles[i].high;
      break;
    }
  }

  if (swingIdx === -1) { r.stage = 'no_swing'; r.reject_code = 'NO_SWING'; return r; }
  r.swing_level = swingLevel;
  r.stage = 'swing_found';

  // ── STEP 2: Sweep in [n-19, n-5] — recent but not bleeding into confirm zone
  let sweepIdx = -1, sweepExtreme = null;

  for (let i = n - 5; i >= n - 19; i--) {
    const c = candles[i];
    if (side === 'LONG'  && c.low  < swingLevel && c.close > swingLevel) {
      sweepIdx = i; sweepExtreme = c.low;  break;
    }
    if (side === 'SHORT' && c.high > swingLevel && c.close < swingLevel) {
      sweepIdx = i; sweepExtreme = c.high; break;
    }
  }

  if (sweepIdx === -1) {
    for (let i = n - 5; i >= n - 19; i--) {
      const c = candles[i];
      if (side === 'LONG'  && c.low  < swingLevel + atr * 0.2) { r.near_miss = true; break; }
      if (side === 'SHORT' && c.high > swingLevel - atr * 0.2) { r.near_miss = true; break; }
    }
    r.stage = 'no_sweep'; r.reject_code = 'NO_SWEEP'; return r;
  }

  r.sweep_extreme  = sweepExtreme;
  r.sweep_size_pct = Math.round(Math.abs(sweepExtreme - swingLevel) / swingLevel * 10000) / 100;
  r.stage = 'sweep_found';

  // ── STEP 3: Confirm level = open of the sweep candle ────────────────────
  // Closing back above sweep candle open (LONG) means the entire sweep was rejected
  // Much cleaner than breaking a post-sweep high which can be momentum continuation
  const confirmLevel = candles[sweepIdx].open;
  r.confirm_level = confirmLevel;
  r.stage = 'confirm_level_set';

  // ── STEP 4: Any candle after sweep closes beyond confirm level ────────────
  // No CONFIRM_PASSED gate — E_ACTIVE dedup prevents spam
  let confirmIdx = -1;
  for (let i = sweepIdx + 1; i <= n - 1; i++) {
    if (side === 'LONG'  && candles[i].close > confirmLevel) { confirmIdx = i; break; }
    if (side === 'SHORT' && candles[i].close < confirmLevel) { confirmIdx = i; break; }
  }

  if (confirmIdx === -1) {
    const gap = side === 'LONG'
      ? confirmLevel - candles[n - 1].high
      : candles[n - 1].low - confirmLevel;
    if (gap < atr * 0.3) r.near_miss = true;
    r.stage = 'no_confirm'; r.reject_code = 'NO_CONFIRM'; return r;
  }

  r.bars_sweep_to_confirm = confirmIdx - sweepIdx;

  // Window check — confirm must happen within 15 candles of sweep
  if (r.bars_sweep_to_confirm > 15) {
    r.stage = 'confirm_too_late'; r.reject_code = 'CONFIRM_TOO_LATE'; return r;
  }

  r.stage = 'fired';
  r.fired = true;
  return r;
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
