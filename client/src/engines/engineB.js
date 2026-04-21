export const ENGINE_B = {
  id: 'B',
  name: 'Engine B',
  fullName: 'Failed Breakout / Reversal',
  color: '#14b8a6'
};

export function runEngineB(candles) {
  const n = candles.length;
  const diag = {
    fired: false, near_miss: false, reject_code: null,
    side_candidate: null, confidence: 0, sl_distance: null,
    b_wick_size: null, b_return_pct_wick: null, b_reclaim_strength: null,
    signal: null
  };

  if (n < 25) { diag.reject_code = 'NO_DATA'; return diag; }

  const lookback  = candles.slice(n - 22, n - 2);
  const rangeHigh = Math.max(...lookback.map(c => c.high));
  const rangeLow  = Math.min(...lookback.map(c => c.low));
  const rangeSize = rangeHigh - rangeLow;
  const atr       = calcATR(candles.slice(n - 20));

  let score = 0;

  // Check 1: range size (20pts)
  if (rangeSize >= atr * 1.8) score += 20;
  else { diag.reject_code = 'RANGE_SMALL'; diag.confidence = score; return diag; }

  const breakCandle = candles[n - 2];
  const confCandle  = candles[n - 1];

  const brokeUp   = breakCandle.high > rangeHigh && confCandle.close < rangeHigh;
  const brokeDown = breakCandle.low  < rangeLow  && confCandle.close > rangeLow;

  if (!brokeUp && !brokeDown) { diag.reject_code = 'NO_BREAK'; diag.confidence = score; return diag; }

  const dir = brokeDown ? 'LONG' : 'SHORT';
  diag.side_candidate = dir;

  // SHORT blocked — data: SHORT 33% WR +0.01 R/tr vs LONG 41% WR +0.24 R/tr (ETH-V1 4Y)
  if (dir === 'SHORT') { diag.reject_code = 'B_SHORT_BLOCKED'; return diag; }
  score += 15;

  const wickSize = brokeUp ? breakCandle.high - rangeHigh : rangeLow - breakCandle.low;
  diag.b_wick_size = Math.round(wickSize);

  // Check 2: wick size (20pts)
  if (wickSize >= atr * 0.7 && wickSize <= atr * 3.0) score += 20;
  else { diag.reject_code = wickSize < atr * 0.7 ? 'WICK_SMALL' : 'WICK_LARGE'; }

  const returnDepth = brokeUp ? rangeHigh - confCandle.close : confCandle.close - rangeLow;
  const retPct = returnDepth / wickSize;
  diag.b_return_pct_wick = Math.round(retPct * 100);

  // Check 3: return depth 40-100% of wick (20pts)
  if (retPct >= 0.4 && retPct <= 1.0) score += 20;
  else if (!diag.reject_code) diag.reject_code = retPct < 0.4 ? 'RET_SHALLOW' : 'RET_DEEP';

  const confBody    = Math.abs(confCandle.close - confCandle.open);
  const confBullish = confCandle.close > confCandle.open;
  const confOk      = (brokeUp && !confBullish) || (brokeDown && confBullish);
  diag.b_reclaim_strength = Math.round(confBody);
  diag.b_reclaim_atr_pct  = Math.round((confBody / atr) * 100); // reclaim as % of ATR — regime-neutral

  // Check 4: conf candle direction (15pts)
  if (confOk && confBody >= atr * 0.25) score += 15;
  else if (!diag.reject_code) diag.reject_code = !confOk ? 'CONF_DIR' : 'CONF_WEAK';

  // Check 5: break candle not too large (10pts)
  const breakBody = Math.abs(breakCandle.close - breakCandle.open);
  if (breakBody <= atr * 3.5) score += 10;

  diag.confidence = score;

  const entry  = confCandle.close;
  const sl     = dir === 'LONG' ? breakCandle.low - atr * 0.15 : breakCandle.high + atr * 0.15;
  const slDist = Math.abs(entry - sl);
  diag.sl_distance = Math.round(slDist);

  if (slDist < 7 && !diag.reject_code)  diag.reject_code = 'SL_SMALL';
  if (slDist > 17 && !diag.reject_code) diag.reject_code = 'SL_WIDE';

  const allPassed = score >= 85 && slDist >= 7 && slDist <= 17 && confOk && confBody >= atr * 0.25;
  diag.near_miss = !allPassed && score >= 60;

  if (!allPassed) return diag;

  const tp = dir === 'LONG' ? entry + slDist * 2 : entry - slDist * 2;
  diag.fired = true;
  diag.near_miss = false;
  diag.reject_code = null;
  diag.signal = {
    signal: dir, entry_price: entry, stop_loss: sl, take_profit: tp,
    risk_reward: '2.0', confidence: score,
    setup_type: 'Failed Breakout Rev', market_condition: brokeUp ? 'bull fakeout' : 'bear fakeout',
    reason: `${brokeUp ? 'Bull' : 'Bear'} fakeout. Wick ${wickSize.toFixed(0)} pts. Return ${retPct*100 .toFixed(0)}% of wick. Conf body ${confBody.toFixed(0)} pts. SL dist ${slDist.toFixed(0)}.`
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


