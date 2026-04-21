export const ENGINE_C = {
  id: 'C',
  name: 'Engine C',
  fullName: 'Jump & Reversal',
  color: '#f59e0b'
};

export function runEngineC(candles) {
  const n = candles.length;
  const diag = {
    fired: false, near_miss: false, reject_code: null,
    side_candidate: null, confidence: 0, sl_distance: null,
    c_climax_body_atr: null, c_wick_body_ratio: null, c_structure_reentry_flag: null,
    signal: null
  };

  if (n < 24) { diag.reject_code = 'NO_DATA'; return diag; }

  const atr     = calcATR(candles.slice(n - 20));
  const exhaust = candles[n - 2];
  const conf    = candles[n - 1];
  const prev1   = candles[n - 3];
  const prev2   = candles[n - 4];

  const body      = Math.abs(exhaust.close - exhaust.open);
  const upperWick = exhaust.high - Math.max(exhaust.close, exhaust.open);
  const lowerWick = Math.min(exhaust.close, exhaust.open) - exhaust.low;
  const jumpedUp  = exhaust.close > exhaust.open;
  const wickRatio = jumpedUp ? upperWick / body : lowerWick / body;

  diag.c_climax_body_atr = Math.round((body / atr) * 100);
  diag.c_wick_body_ratio  = Math.round(wickRatio * 100);
  diag.side_candidate = jumpedUp ? 'SHORT' : 'LONG';

  let score = 0;

  // Check 1: body size (25pts)
  if (body >= atr * 1.0 && body <= atr * 4.0) score += 25;
  else { diag.reject_code = body < atr * 1.0 ? 'BODY_SMALL' : 'BODY_HUGE'; }

  // Check 2: wick ratio (25pts)
  if (wickRatio >= 0.42 && wickRatio <= 2.0) score += 25;
  else if (!diag.reject_code) diag.reject_code = wickRatio < 0.42 ? 'WICK_LOW' : 'WICK_HIGH';

  // Check 3: prior candles confirm trend (20pts)
  const prev1Dir  = prev1.close > prev1.open;
  const prev2Dir  = prev2.close > prev2.open;
  const prev1Body = Math.abs(prev1.close - prev1.open);
  const prev2Body = Math.abs(prev2.close - prev2.open);
  const priorsOk  = jumpedUp ? (prev1Dir && prev2Dir) : (!prev1Dir && !prev2Dir);
  const prevHasMass = prev1Body >= atr * 0.25 || prev2Body >= atr * 0.25;
  if (priorsOk && prevHasMass) score += 20;
  else if (!diag.reject_code) diag.reject_code = 'PREV_FAIL';

  // Check 4: climax is larger than priors (10pts)
  const avgPrevBody = (prev1Body + prev2Body) / 2;
  if (body >= avgPrevBody * 0.7) score += 10;
  else if (!diag.reject_code) diag.reject_code = 'NO_CLIMAX';

  diag.confidence = score;

  // Check 5: confirmation direction (10pts)
  const confBullish = conf.close > conf.open;
  const confDirOk   = jumpedUp ? !confBullish : confBullish;
  const confBody    = Math.abs(conf.close - conf.open);
  if (confDirOk && confBody >= atr * 0.2) score += 10;
  else if (!diag.reject_code) diag.reject_code = !confDirOk ? 'CONF_DIR' : 'CONF_WEAK';

  // Check 6: structural reentry (10pts)
  const exhaustBodyHigh = Math.max(exhaust.open, exhaust.close);
  const exhaustBodyLow  = Math.min(exhaust.open, exhaust.close);
  const reentryOk = jumpedUp ? conf.close <= exhaustBodyHigh : conf.close >= exhaustBodyLow;
  diag.c_structure_reentry_flag = reentryOk ? 1 : 0;
  if (reentryOk) score += 10;
  else if (!diag.reject_code) diag.reject_code = 'STRUCT_FAIL';

  diag.confidence = score;

  const entry  = conf.close;
  const sl     = jumpedUp ? exhaust.high + atr * 0.15 : exhaust.low - atr * 0.15;
  const slDist = Math.abs(entry - sl);
  diag.sl_distance = Math.round(slDist);

  if (slDist < 5 && !diag.reject_code)  diag.reject_code = 'SL_SMALL';
  if (slDist > 14 && !diag.reject_code) diag.reject_code = 'SL_WIDE';

  const allPassed = score >= 95 && slDist >= 5 && slDist <= 14;
  diag.near_miss = !allPassed && score >= 70;

  if (!allPassed) return diag;

  const dir = jumpedUp ? 'SHORT' : 'LONG';
  const tp  = dir === 'LONG' ? entry + slDist * 2 : entry - slDist * 2;
  diag.fired = true;
  diag.near_miss = false;
  diag.reject_code = null;
  diag.signal = {
    signal: dir, entry_price: entry, stop_loss: sl, take_profit: tp,
    risk_reward: '2.0', confidence: score,
    setup_type: 'Jump & Reversal (confirmed)', market_condition: jumpedUp ? 'bull exhaustion' : 'bear exhaustion',
    reason: `${jumpedUp ? 'Bull' : 'Bear'} climax ${body.toFixed(0)} pts (${(body/atr*100).toFixed(0)}% ATR). Wick ${(wickRatio*100).toFixed(0)}%. Reentry confirmed. SL dist ${slDist.toFixed(0)}.`
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


