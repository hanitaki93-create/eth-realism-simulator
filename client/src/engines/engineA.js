export const ENGINE_A = {
  id: 'A',
  name: 'Engine A',
  fullName: 'Compression / Expansion Continuation',
  color: '#a78bfa'
};

export function runEngineA(candles) {
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

  // Check 1: compression range (25pts)
  if (compRange >= atr * 1.5 && compRange <= atr * 4.5) score += 25;
  else { diag.reject_code = compRange < atr * 1.5 ? 'NO_COMP' : 'COMP_WIDE'; }

  // Check 2: avg candle size (20pts)
  if (avgRange <= atr * 1.0) score += 20;
  else if (!diag.reject_code) diag.reject_code = 'COMP_NOISY';

  // Check 3: flatness (20pts)
  const firstMid  = zone.slice(0, 10).map(c => (c.high + c.low) / 2).reduce((a, b) => a + b, 0) / 10;
  const secondMid = zone.slice(10).map(c => (c.high + c.low) / 2).reduce((a, b) => a + b, 0) / zone.slice(10).length;
  const tiltScore = Math.abs(firstMid - secondMid);
  diag.a_trend_bias_score = Math.round(tiltScore);
  if (tiltScore <= atr * 0.7) score += 20;
  else if (!diag.reject_code) diag.reject_code = 'COMP_TILTED';

  const body = Math.abs(last.close - last.open);
  const dir  = last.close > last.open ? 'LONG' : 'SHORT';
  diag.side_candidate = dir;
  diag.a_breakout_strength = Math.round((body / atr) * 100);

  // Check 4: body strength (15pts)
  if (body >= atr * 0.9 && body <= atr * 3.5) score += 15;
  else if (!diag.reject_code) diag.reject_code = body < atr * 0.9 ? 'BODY_WEAK' : 'BODY_STRONG';

  // LONG only gate
  if (dir === 'SHORT') { diag.reject_code = 'SHORT_BLOCKED'; diag.confidence = score; return diag; }

  // Check 5: boundary cleared (10pts)
  if (last.close >= compHigh * 0.9998) score += 10;
  else if (!diag.reject_code) diag.reject_code = 'NO_CLEAR';

  // Check 6: wick clean (5pts)
  const upperWick = last.high - Math.max(last.close, last.open);
  if (upperWick <= body * 0.55) score += 5;
  else if (!diag.reject_code) diag.reject_code = 'WICK_LARGE';

  // Check 7: prior candle (5pts)
  const prevBody = Math.abs(prev.close - prev.open);
  const prevDir  = prev.close > prev.open ? 'LONG' : 'SHORT';
  if (prevDir === dir || prevBody <= atr * 0.7) score += 5;
  else if (!diag.reject_code) diag.reject_code = 'PREV_OPP';

  diag.confidence = score;

  const entry  = last.close;
  const sl     = compLow - atr * 0.15;
  const slDist = Math.abs(entry - sl);
  diag.sl_distance = Math.round(slDist);

  if (slDist > 150 && !diag.reject_code) diag.reject_code = 'SL_WIDE';

  const allPassed = score >= 95 && slDist <= 150 && dir === 'LONG';
  diag.near_miss = !allPassed && score >= 65;

  if (!allPassed) return diag;

  const tp = entry + slDist * 2;
  diag.fired = true;
  diag.near_miss = false;
  diag.reject_code = null;
  diag.signal = {
    signal: 'LONG', entry_price: entry, stop_loss: sl, take_profit: tp,
    risk_reward: '2.0', confidence: score,
    setup_type: 'Comp/Exp Continuation', market_condition: 'compression breakout (LONG only)',
    reason: `Flat compression ${compRange.toFixed(0)} pts (${(compRange/atr).toFixed(1)}x ATR). Body ${body.toFixed(0)} pts (${(body/atr*100).toFixed(0)}% ATR). SL dist ${slDist.toFixed(0)}.`
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
