// Engine A3 — Tilted Compression Continuation (LONG only)
//
// Research basis: COMP_TILTED near-miss forward-price study
// Two independent models (Claude + ChatGPT) confirmed:
//   - Raw COMP_TILTED: 39% WR — too weak
//   - With sl_distance 400-600: 43-45% WR
//   - With confidence 65-70: 48% WR
//   - With 20-candle return < 0: 53-62% WR (+0.58-0.86R avg)
//
// Quarterly stability confirmed: Q4 2025 = 56% WR (doesn't collapse like B/C)
// Zero overlap with A1 by construction (A3 requires tilt, A1 rejects tilt)
//
// What this engine detects:
//   Compression zones that are SLIGHTLY trending (not flat) — price has been
//   drifting in one direction during the compression, then breaks out LONG.
//   The 20-candle net-down condition ensures we're buying into a pullback
//   within the broader context — compression-while-dipping → breakout.
//
// Tracked as 'A3' — never mixed with A1 stats until independently validated.
// Uses 2-candle pending confirmation (like B and C) since this is a new engine.

export const ENGINE_A3 = {
  id: 'A3',
  name: 'Engine A3',
  fullName: 'Tilted Compression Continuation',
  color: '#34d399'  // green — distinct from A1 purple and A2 pink
};

export function runEngineA3(candles) {
  const n = candles.length;
  const diag = {
    fired: false, near_miss: false, reject_code: null,
    side_candidate: null, confidence: 0, sl_distance: null,
    a_compression_size: null, a_breakout_strength: null, a_trend_bias_score: null,
    signal: null
  };

  if (n < 35) { diag.reject_code = 'NO_DATA'; return diag; }

  const last = candles[n - 1];
  const prev = candles[n - 2];
  const atr  = calcATR(candles.slice(n - 20));

  // Compression zone — identical window to A1
  const zone   = candles.slice(n - 22, n - 2);
  const highs  = zone.map(c => c.high);
  const lows   = zone.map(c => c.low);
  const ranges = zone.map(c => c.high - c.low);
  const compHigh  = Math.max(...highs);
  const compLow   = Math.min(...lows);
  const compRange = compHigh - compLow;
  const avgRange  = ranges.reduce((a, b) => a + b, 0) / ranges.length;

  diag.a_compression_size = Math.round(compRange);

  let score = 0;

  // Check 1: compression range (25pts) — identical to A1
  if (compRange >= atr * 1.5 && compRange <= atr * 4.5) score += 25;
  else { diag.reject_code = compRange < atr * 1.5 ? 'NO_COMP' : 'COMP_WIDE'; }

  // Check 2: avg candle size (20pts) — identical to A1
  if (avgRange <= atr * 1.0) score += 20;
  else if (!diag.reject_code) diag.reject_code = 'COMP_NOISY';

  // Check 3: TILT REQUIRED (0pts — this is what distinguishes A3 from A1)
  // A1 requires tiltScore <= atr * 0.7 (flat)
  // A3 requires tiltScore > atr * 0.7 AND <= atr * 2.0 (tilted but not extreme)
  const firstMid  = zone.slice(0, 10).map(c => (c.high + c.low) / 2).reduce((a, b) => a + b, 0) / 10;
  const secondMid = zone.slice(10).map(c => (c.high + c.low) / 2).reduce((a, b) => a + b, 0) / zone.slice(10).length;
  const tiltScore = Math.abs(firstMid - secondMid);
  diag.a_trend_bias_score = Math.round(tiltScore);

  // Must be tilted (A1 would have fired on this candle if flat)
  if (tiltScore <= atr * 0.7) {
    diag.reject_code = 'TOO_FLAT';  // A1 should handle this
    diag.confidence = score;
    return diag;
  }
  if (tiltScore > atr * 2.0) {
    diag.reject_code = 'TILT_EXTREME';  // too tilted — trending, not compressing
    diag.confidence = score;
    return diag;
  }
  // No points added for tilt — it's a qualifying condition, not a quality score

  const body = Math.abs(last.close - last.open);
  const dir  = last.close > last.open ? 'LONG' : 'SHORT';
  diag.side_candidate = dir;
  diag.a_breakout_strength = Math.round((body / atr) * 100);

  // Check 4: body strength (15pts) — identical to A1
  if (body >= atr * 0.9 && body <= atr * 3.5) score += 15;
  else if (!diag.reject_code) diag.reject_code = body < atr * 0.9 ? 'BODY_WEAK' : 'BODY_STRONG';

  // LONG only gate
  if (dir === 'SHORT') { diag.reject_code = 'SHORT_BLOCKED'; diag.confidence = score; return diag; }

  // Check 5: boundary cleared (10pts) — identical to A1
  if (last.close >= compHigh * 0.9998) score += 10;
  else if (!diag.reject_code) diag.reject_code = 'NO_CLEAR';

  // Check 6: wick clean (5pts) — identical to A1
  const upperWick = last.high - Math.max(last.close, last.open);
  if (upperWick <= body * 0.55) score += 5;
  else if (!diag.reject_code) diag.reject_code = 'WICK_LARGE';

  // Check 7: prior candle (5pts) — identical to A1
  const prevBody = Math.abs(prev.close - prev.open);
  const prevDir  = prev.close > prev.open ? 'LONG' : 'SHORT';
  if (prevDir === dir || prevBody <= atr * 0.7) score += 5;
  else if (!diag.reject_code) diag.reject_code = 'PREV_OPP';

  // Max possible score: 25+20+15+10+5+5 = 80 (no flatness bonus)
  // Research sweet spot: 65-70 = 3-4 of the remaining checks passed cleanly
  diag.confidence = score;

  // SL calculation — same as A1
  const entry  = last.close;
  const sl     = compLow - atr * 0.15;
  const slDist = Math.abs(entry - sl);
  diag.sl_distance = Math.round(slDist);

  // === A3-SPECIFIC GATE 1: SL distance must be 540-600pts ===
  // v24 calibration on 68 signals: SL 400-540 = 26% WR (-12R), SL 541-600 = 64% WR (+13R)
  // 38pp gap — dead zone below 540 removed entirely
  if (slDist <= 540) { diag.reject_code = 'SL_TOO_TIGHT'; diag.confidence = score; return diag; }
  if (slDist > 600)  { diag.reject_code = 'SL_TOO_WIDE';  diag.confidence = score; return diag; }

  // === A3-SPECIFIC GATE 2: Confidence must be 65-70 ===
  // Higher confidence paradoxically performed worse in research
  // (high conf on COMP_TILTED = zone was almost flat → borderline case)
  // 65-70 = compression valid, candles quiet, body strong, boundary clear
  if (score < 65 || score > 70) {
    diag.reject_code = score < 65 ? 'CONF_LOW' : 'CONF_HIGH';
    diag.near_miss = score >= 60 && score <= 75;  // near-miss bracket
    return diag;
  }

  // === A3-SPECIFIC GATE 3: 20-candle return must be negative ===
  // Price must be net-down over last 20 candles at entry time
  // This ensures we're buying into a pullback, not chasing a rally
  const price20ago = candles[n - 21]?.close;
  const ret20 = price20ago ? (last.close - price20ago) / price20ago * 100 : 0;
  if (!price20ago || ret20 >= 0) {
    diag.reject_code = 'TREND_UP';  // net up over 20 candles — skip
    diag.near_miss = ret20 < 1;    // near-miss if barely positive
    return diag;
  }

  // All gates passed
  const tp = entry + slDist * 2;
  diag.fired = true;
  diag.near_miss = false;
  diag.reject_code = null;
  // Export a3_sl_band for calibration monitoring
  // v24 data: SL 541-600 = 64% WR, below = 26% WR
  // Flag only — not blocking on trailing WR yet (n=11 too small for hard block)
  diag.a3_sl_band = slDist > 570 ? 'high' : 'mid';

  diag.signal = {
    signal: 'LONG', entry_price: entry, stop_loss: sl, take_profit: tp,
    risk_reward: '2.0', confidence: score,
    setup_type: 'Tilted Comp Continuation', market_condition: `compression breakout (tilted, ret20=${ret20.toFixed(1)}%)`,
    reason: `Tilted compression ${compRange.toFixed(0)}pts tilt=${tiltScore.toFixed(0)} sl=${slDist.toFixed(0)} conf=${score} ret20=${ret20.toFixed(1)}%. A3 v25 (SL 541-600).`
  };
  return diag;
}

function calcATR(candles, period = 14) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}
