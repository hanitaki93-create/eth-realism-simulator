import { runEngineB } from './engines/engineB.js';
import { runEngineC } from './engines/engineC.js';
import { runEngineD } from './engines/engineD.js';
import { runEngineE } from './engines/engineE.js';
import { runEngineF } from './engines/engineF.js';

export const ENGINE_RUNNERS = { B: runEngineB, C: runEngineC, D: runEngineD, E: runEngineE, F: runEngineF };

export const DEFAULT_CONFIG = {
  symbol: 'ETHUSDT',
  interval: '5m',
  startingBalance: 10000,
  selectedYears: [2022],

  // Risk/accounting
  riskMode: 'fixed', // fixed | pct
  fixedRisk: 200,
  riskPct: 2,
  riskCap: 1000,
  compounding: 'per_trade', // none | per_trade | daily | monthly | quarterly
  oneWayMode: true,
  allowStacking: false,

  // Signal/execution
  tpRMultiple: 2,
  entryMode: 'maker_gtx', // maker_gtx | taker_market
  makerEntryFillStyle: 'neutral_prob', // neutral_prob | touch_gated | hybrid
  executionModel: 'B', // A | B | C | custom
  fillProbA: 1.0,
  fillProbB: 0.88,
  fillProbC: 0.72,
  fillProbOverride: null,
  entryTimeoutCandles: 2, // internal pending/confirmation delay before order placement
  makerEntryTimeoutCandles: 2, // maker order lifespan after placement
  maxHoldCandles: 288,
  randomSeed: 42,

  // TP exit behavior
  tpMode: 'maker_limit', // market | maker_limit | maker_then_market
  tpMakerFillProb: 0.995,
  tpFallbackCandles: 0,

  // Fees
  feeMakerBps: 2,
  feeTakerBps: 5,

  // Slippage
  slippageMode: 'dynamic', // manual | preset | dynamic
  slippagePreset: 'realistic', // baseline | realistic | stress, only used when slippageMode=preset
  slippageManualPts: { entry: 0, tp: 0.15, sl: 0.26 },
  slippageDynamicBasePts: { entry: 0, tp: 0.15, sl: 0.26 },

  engines: { B: false, C: false, D: true, E: true, F: false },
};

const PRESET_SLIPPAGE = {
  baseline: { entry: 0, tp: 0.08, sl: 0.14 },
  realistic: { entry: 0, tp: 0.15, sl: 0.26 },
  stress: { entry: 0.02, tp: 0.28, sl: 0.48 },
};

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function fmtNum(n, d = 2) { return Number.isFinite(Number(n)) ? +Number(n).toFixed(d) : 0; }
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function monthKey(ts) { const d = new Date(ts); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`; }
function quarterKey(ts) { const d = new Date(ts); return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth()/3)+1}`; }
function isLong(side) { return side === 'LONG'; }
function priceTouched(side, price, candle) { return isLong(side) ? candle.low <= price : candle.high >= price; }
function hitSL(side, sl, candle) { return isLong(side) ? candle.low <= sl : candle.high >= sl; }
function hitTP(side, tp, candle) { return isLong(side) ? candle.high >= tp : candle.low <= tp; }

function makeRng(seed) {
  let s = Number(seed) || 1;
  s = (s >>> 0) || 1;
  return function rand() {
    // LCG; deterministic, enough for simulator repeatability.
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function normalizeConfig(config = {}) {
  const merged = deepClone({
    ...DEFAULT_CONFIG,
    ...config,
    engines: { ...DEFAULT_CONFIG.engines, ...(config.engines || {}) },
  });

  // Backward compatibility with older patched bundles.
  if (config.slippageBasePts && !config.slippageManualPts) merged.slippageManualPts = { ...DEFAULT_CONFIG.slippageManualPts, ...config.slippageBasePts };
  if (config.slippageBasePts && !config.slippageDynamicBasePts) merged.slippageDynamicBasePts = { ...DEFAULT_CONFIG.slippageDynamicBasePts, ...config.slippageBasePts };
  if (config.tpMode === 'limit') merged.tpMode = 'maker_limit';
  if (!['neutral_prob', 'touch_gated', 'hybrid'].includes(merged.makerEntryFillStyle)) merged.makerEntryFillStyle = DEFAULT_CONFIG.makerEntryFillStyle;

  merged.tpRMultiple = Math.max(0.1, Number(merged.tpRMultiple) || DEFAULT_CONFIG.tpRMultiple);
  merged.entryTimeoutCandles = Math.max(0, Math.floor(Number(merged.entryTimeoutCandles) || 0));
  merged.makerEntryTimeoutCandles = Math.max(0, Math.floor(Number(merged.makerEntryTimeoutCandles) || 0));
  merged.maxHoldCandles = Math.max(1, Math.floor(Number(merged.maxHoldCandles) || DEFAULT_CONFIG.maxHoldCandles));
  merged.feeMakerBps = Math.max(0, Number(merged.feeMakerBps) || 0);
  merged.feeTakerBps = Math.max(0, Number(merged.feeTakerBps) || 0);
  merged.tpMakerFillProb = clamp(Number(merged.tpMakerFillProb) || 0, 0, 1);
  merged.tpFallbackCandles = Math.max(0, Math.floor(Number(merged.tpFallbackCandles) || 0));
  merged.fillProbA = clamp(Number(merged.fillProbA), 0, 1);
  merged.fillProbB = clamp(Number(merged.fillProbB), 0, 1);
  merged.fillProbC = clamp(Number(merged.fillProbC), 0, 1);
  if (merged.fillProbOverride !== null && merged.fillProbOverride !== '') merged.fillProbOverride = clamp(Number(merged.fillProbOverride), 0, 1);
  else merged.fillProbOverride = null;

  return merged;
}

function getSlippageBase(type, cfg) {
  if (cfg.slippageMode === 'preset') return PRESET_SLIPPAGE[cfg.slippagePreset]?.[type] ?? PRESET_SLIPPAGE.realistic[type] ?? 0;
  if (cfg.slippageMode === 'manual') return cfg.slippageManualPts?.[type] ?? 0;
  return cfg.slippageDynamicBasePts?.[type] ?? 0;
}

function slippageFor(type, cfg, candle) {
  const base = Number(getSlippageBase(type, cfg)) || 0;
  if (cfg.slippageMode !== 'dynamic') return fmtNum(base, 4);

  const range = Math.max(0, (candle?.high ?? 0) - (candle?.low ?? 0));
  const volatilityBump = range > 25 ? 1.75 : range > 15 ? 1.5 : range > 8 ? 1.2 : 1;
  return fmtNum(base * volatilityBump, 4);
}

function getRiskDollar(balance, cfg) {
  const baseBalance = Math.max(0, Number(balance) || 0);
  const raw = cfg.riskMode === 'pct' ? baseBalance * ((Number(cfg.riskPct) || 0) / 100) : Number(cfg.fixedRisk) || 0;
  const capped = cfg.riskCap ? Math.min(raw, Number(cfg.riskCap) || raw) : raw;
  return Math.max(0, capped);
}

function applyCompounding(balanceState, trade, cfg, ts) {
  const d = new Date(ts);
  const bucket = cfg.compounding === 'daily' ? d.toISOString().slice(0,10)
    : cfg.compounding === 'monthly' ? monthKey(ts)
    : cfg.compounding === 'quarterly' ? quarterKey(ts)
    : null;

  if (cfg.compounding === 'none') return;
  if (cfg.compounding === 'per_trade') {
    balanceState.balance += trade.pnlUsd;
    return;
  }
  if (bucket && balanceState.pendingBucket !== bucket) {
    if (balanceState.pendingPnl !== 0) balanceState.balance += balanceState.pendingPnl;
    balanceState.pendingPnl = 0;
    balanceState.pendingBucket = bucket;
  }
  balanceState.pendingPnl += trade.pnlUsd;
}

function finalizeCompounding(balanceState) {
  if (balanceState.pendingPnl) balanceState.balance += balanceState.pendingPnl;
  balanceState.pendingPnl = 0;
}

function buildSignal(diag, engineId, candle, cfg) {
  if (!diag?.fired || !diag.signal) return null;
  const s = diag.signal;
  const entry = Number(s.entry_price);
  const sl = Number(s.stop_loss);
  const rawTp = Number(s.take_profit);
  const side = s.signal;
  const slDistance = Math.abs(entry - sl);
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || slDistance <= 0 || !['LONG', 'SHORT'].includes(side)) return null;

  const executionTp = isLong(side)
    ? entry + slDistance * cfg.tpRMultiple
    : entry - slDistance * cfg.tpRMultiple;

  return {
    engine: engineId,
    side,
    signalTime: candle.closeTime,
    entry,
    sl,
    rawTp: Number.isFinite(rawTp) ? rawTp : null,
    tp: executionTp,
    executionTp,
    tpRMultiple: cfg.tpRMultiple,
    setupType: s.setup_type || engineId,
    confidence: Number(s.confidence ?? diag.confidence ?? 0),
    slDistance,
  };
}

function resolveTheoreticalOutcome(signal, candles, activeFromIdx, cfg) {
  const maxIdx = Math.min(candles.length - 1, activeFromIdx + cfg.maxHoldCandles);
  for (let j = activeFromIdx; j <= maxIdx; j++) {
    const c = candles[j];
    if (!c) continue;
    const slHit = hitSL(signal.side, signal.sl, c);
    const tpHit = hitTP(signal.side, signal.tp, c);
    if (!slHit && !tpHit) continue;

    let status = tpHit && !slHit ? 'TP' : slHit && !tpHit ? 'SL' : 'BOTH';
    if (status === 'BOTH') {
      const distToTP = Math.abs(c.open - signal.tp);
      const distToSL = Math.abs(c.open - signal.sl);
      status = distToTP <= distToSL ? 'TP' : 'SL';
    }
    const grossR = status === 'TP' ? Math.abs(signal.tp - signal.entry) / signal.slDistance : -1;
    return { status, settleIdx: j, exitRefPrice: status === 'TP' ? signal.tp : signal.sl, expectedGrossR: fmtNum(grossR, 4) };
  }

  const last = candles[maxIdx] || candles[candles.length - 1];
  const move = isLong(signal.side) ? (last.close - signal.entry) : (signal.entry - last.close);
  return { status: 'TIMEOUT', settleIdx: maxIdx, exitRefPrice: last.close, expectedGrossR: fmtNum(move / signal.slDistance, 4) };
}

function hasAnyOpen(pendingByEngine, activeByEngine) {
  return Object.values(pendingByEngine).some(Boolean) || Object.values(activeByEngine).some(Boolean);
}

function passOneBuildLedger(candles, cfg) {
  const enabledEngineIds = Object.entries(cfg.engines).filter(([, v]) => v).map(([k]) => k);
  const engineStats = Object.fromEntries(enabledEngineIds.map(id => [id, {
    raw: 0, blocked: 0, pending: 0, cancelled: 0, activated: 0, settled: 0,
    signalWins: 0, signalLosses: 0, signalGrossR: 0,
    filled: 0, missed: 0, missedNoTouch: 0, missedProb: 0,
    executedGrossR: 0, executedNetR: 0, feeR: 0,
  }]));

  const pendingByEngine = {};
  const activeByEngine = {};
  const settledSignals = [];

  for (let i = 80; i < candles.length; i++) {
    const candle = candles[i];

    // Pending confirmation/cancellation phase. This is signal logic only, not exchange execution.
    for (const engineId of enabledEngineIds) {
      const pending = pendingByEngine[engineId];
      if (!pending) continue;

      const slHit = hitSL(pending.side, pending.sl, candle);
      if (slHit) {
        pending.cancelIdx = i;
        engineStats[engineId].cancelled += 1;
        pendingByEngine[engineId] = null;
        continue;
      }

      if (i >= pending.activeFromIdx) {
        engineStats[engineId].activated += 1;
        activeByEngine[engineId] = pending;
        pendingByEngine[engineId] = null;
      }
    }

    // Virtual settlement only to control signal overlap and create a pure signal ledger.
    for (const engineId of enabledEngineIds) {
      const sig = activeByEngine[engineId];
      if (!sig) continue;
      const outcome = resolveTheoreticalOutcome(sig, candles, i, cfg);
      if (!outcome || outcome.settleIdx !== i) continue;
      sig.outcome = outcome.status;
      sig.theoreticalSettleIdx = i;
      sig.theoreticalExitRefPrice = outcome.exitRefPrice;
      sig.expectedGrossR = outcome.expectedGrossR;
      settledSignals.push(sig);
      engineStats[engineId].settled += 1;
      if (sig.expectedGrossR > 0) engineStats[engineId].signalWins += 1; else engineStats[engineId].signalLosses += 1;
      engineStats[engineId].signalGrossR += sig.expectedGrossR;
      activeByEngine[engineId] = null;
    }

    const slice = candles.slice(0, i + 1);
    for (const engineId of enabledEngineIds) {
      const diag = ENGINE_RUNNERS[engineId]?.(slice);
      if (!diag?.fired) continue;
      engineStats[engineId].raw += 1;

      const sameEngineOpen = !!pendingByEngine[engineId] || !!activeByEngine[engineId];
      const globalOpen = cfg.oneWayMode && !cfg.allowStacking && hasAnyOpen(pendingByEngine, activeByEngine);
      if (sameEngineOpen || globalOpen) {
        engineStats[engineId].blocked += 1;
        continue;
      }

      const signal = buildSignal(diag, engineId, candle, cfg);
      if (!signal) continue;

      signal.signalIdx = i;
      signal.activeFromIdx = i + Math.max(0, cfg.entryTimeoutCandles || 0);
      pendingByEngine[engineId] = signal;
      engineStats[engineId].pending += 1;
    }
  }

  return { signals: settledSignals, engineStats };
}

function baseEntryFillProbability(cfg) {
  if (cfg.fillProbOverride !== null && cfg.fillProbOverride !== undefined) return cfg.fillProbOverride;
  if (cfg.executionModel === 'A') return cfg.fillProbA;
  if (cfg.executionModel === 'C') return cfg.fillProbC;
  return cfg.fillProbB;
}

function fillProbabilityForTouch(signal, candle, cfg) {
  const base = baseEntryFillProbability(cfg);
  if (cfg.entryMode === 'taker_market') return 1;
  const penetration = isLong(signal.side)
    ? Math.max(0, signal.entry - candle.low)
    : Math.max(0, candle.high - signal.entry);
  const penetrationBonus = clamp((penetration / Math.max(signal.slDistance, 0.0001)) * 0.08, 0, 0.08);
  return clamp(base + penetrationBonus, 0, 1);
}

function tryFillEntry(signal, candles, cfg, rand) {
  const start = Math.min(candles.length - 1, signal.activeFromIdx);
  const end = Math.min(candles.length - 1, start + cfg.makerEntryTimeoutCandles);
  const baseProb = baseEntryFillProbability(cfg);

  if (cfg.entryMode === 'taker_market') {
    return { filled: true, fillIdx: start, fillProb: 1, touchedEntry: true, entryFillReason: 'TAKER_MARKET', makerEntryFillStyle: 'taker' };
  }

  // 70/95 default: neutral probabilistic GTX.
  // Reason: available OHLC candles cannot observe queue position or bid/ask posting. A strict
  // no-touch gate created severe selection bias by missing mostly winner signals. Neutral mode
  // tests execution drag without allowing execution to choose winners/losers by candle path.
  if (cfg.makerEntryFillStyle === 'neutral_prob') {
    const filled = rand() <= baseProb;
    return {
      filled,
      fillIdx: filled ? start : null,
      fillProb: baseProb,
      touchedEntry: true,
      entryFillReason: filled ? 'MAKER_NEUTRAL_FILLED' : 'MAKER_NEUTRAL_MISSED',
      makerEntryFillStyle: cfg.makerEntryFillStyle,
    };
  }

  // Hybrid: first allow near-immediate maker posting fill using the neutral probability;
  // only if it fails do we look for a touch within timeout. This is less biased than strict touch.
  if (cfg.makerEntryFillStyle === 'hybrid') {
    if (rand() <= baseProb) {
      return { filled: true, fillIdx: start, fillProb: baseProb, touchedEntry: true, entryFillReason: 'MAKER_HYBRID_IMMEDIATE_FILLED', makerEntryFillStyle: cfg.makerEntryFillStyle };
    }
  }

  // Strict touch-gated GTX is retained only as a stress/audit option.
  let touched = false;
  let lastFillProb = baseProb;

  for (let i = start; i <= end; i++) {
    const c = candles[i];
    if (!c || !priceTouched(signal.side, signal.entry, c)) continue;
    touched = true;
    lastFillProb = fillProbabilityForTouch(signal, c, cfg);
    if (rand() <= lastFillProb) {
      return { filled: true, fillIdx: i, fillProb: lastFillProb, touchedEntry: true, entryFillReason: cfg.makerEntryFillStyle === 'hybrid' ? 'MAKER_HYBRID_TOUCH_FILLED' : 'MAKER_TOUCH_FILLED', makerEntryFillStyle: cfg.makerEntryFillStyle };
    }
  }

  const reason = touched ? 'MAKER_TOUCH_NOT_FILLED' : 'MAKER_NO_TOUCH';
  return {
    filled: false,
    fillIdx: null,
    fillProb: lastFillProb,
    touchedEntry: touched,
    entryFillReason: cfg.makerEntryFillStyle === 'hybrid' ? `MAKER_HYBRID_${reason}` : reason,
    makerEntryFillStyle: cfg.makerEntryFillStyle,
  };
}

function feeFor(notional, isMaker, cfg) {
  return Math.abs(notional) * ((isMaker ? cfg.feeMakerBps : cfg.feeTakerBps) / 10000);
}

function exitPriceWithSlippage(signal, basePrice, type, cfg, candle) {
  const slip = slippageFor(type, cfg, candle);
  if (type === 'tp') return { price: isLong(signal.side) ? basePrice - slip : basePrice + slip, slip };
  if (type === 'sl') return { price: isLong(signal.side) ? basePrice - slip : basePrice + slip, slip };
  return { price: basePrice, slip: 0 };
}

function resolveExecutedExit(signal, candles, fillIdx, cfg, rand) {
  const maxIdx = Math.min(candles.length - 1, fillIdx + cfg.maxHoldCandles);
  let tpMakerAttempts = 0;
  let tpMakerFails = 0;

  for (let j = fillIdx; j <= maxIdx; j++) {
    const c = candles[j];
    if (!c) continue;
    const slHit = hitSL(signal.side, signal.sl, c);
    const tpHit = hitTP(signal.side, signal.tp, c);
    if (!slHit && !tpHit) continue;

    let first = tpHit && !slHit ? 'TP' : slHit && !tpHit ? 'SL' : 'BOTH';
    if (first === 'BOTH') {
      const distToTP = Math.abs(c.open - signal.tp);
      const distToSL = Math.abs(c.open - signal.sl);
      first = distToTP <= distToSL ? 'TP' : 'SL';
    }

    if (first === 'SL') {
      const { price, slip } = exitPriceWithSlippage(signal, signal.sl, 'sl', cfg, c);
      return { status: 'SL', exitIdx: j, exitPrice: price, exitRefPrice: signal.sl, exitMaker: false, tpSlip: 0, slSlip: slip, tpExitMode: 'sl_taker', tpMakerAttempts, tpMakerFails, tpFallbackUsed: false };
    }

    if (first === 'TP') {
      if (cfg.tpMode === 'market') {
        const { price, slip } = exitPriceWithSlippage(signal, signal.tp, 'tp', cfg, c);
        return { status: 'TP', exitIdx: j, exitPrice: price, exitRefPrice: signal.tp, exitMaker: false, tpSlip: slip, slSlip: 0, tpExitMode: 'tp_market_taker', tpMakerAttempts, tpMakerFails, tpFallbackUsed: false };
      }

      tpMakerAttempts += 1;
      const makerFilled = rand() <= cfg.tpMakerFillProb;
      if (makerFilled) {
        return { status: 'TP', exitIdx: j, exitPrice: signal.tp, exitRefPrice: signal.tp, exitMaker: true, tpSlip: 0, slSlip: 0, tpExitMode: 'tp_maker_limit', tpMakerAttempts, tpMakerFails, tpFallbackUsed: false };
      }

      tpMakerFails += 1;
      if (cfg.tpMode === 'maker_then_market') {
        const fallbackIdx = Math.min(maxIdx, j + cfg.tpFallbackCandles);
        const fallbackCandle = candles[fallbackIdx] || c;
        const { price, slip } = exitPriceWithSlippage(signal, signal.tp, 'tp', cfg, fallbackCandle);
        return { status: 'TP', exitIdx: fallbackIdx, exitPrice: price, exitRefPrice: signal.tp, exitMaker: false, tpSlip: slip, slSlip: 0, tpExitMode: 'tp_maker_failed_taker_fallback', tpMakerAttempts, tpMakerFails, tpFallbackUsed: true };
      }

      // maker_limit mode: failed TP touch stays open. If the same candle also hit SL, respect that risk.
      if (slHit) {
        const { price, slip } = exitPriceWithSlippage(signal, signal.sl, 'sl', cfg, c);
        return { status: 'SL', exitIdx: j, exitPrice: price, exitRefPrice: signal.sl, exitMaker: false, tpSlip: 0, slSlip: slip, tpExitMode: 'tp_maker_failed_then_sl_same_candle', tpMakerAttempts, tpMakerFails, tpFallbackUsed: false };
      }
    }
  }

  const last = candles[maxIdx] || candles[candles.length - 1];
  return { status: 'TIMEOUT', exitIdx: maxIdx, exitPrice: last.close, exitRefPrice: last.close, exitMaker: false, tpSlip: 0, slSlip: 0, tpExitMode: 'timeout_taker_close', tpMakerAttempts, tpMakerFails, tpFallbackUsed: false };
}

function passTwoExecution(signals, candles, cfg) {
  const balanceState = { balance: cfg.startingBalance, pendingPnl: 0, pendingBucket: null };
  const executed = [];
  const missed = [];
  const rand = makeRng(cfg.randomSeed);

  for (const sig of [...signals].sort((a, b) => a.signalIdx - b.signalIdx)) {
    const entryAttempt = tryFillEntry(sig, candles, cfg, rand);
    if (!entryAttempt.filled) {
      missed.push({ ...sig, ...entryAttempt, missedReason: entryAttempt.entryFillReason });
      continue;
    }

    const riskUsd = getRiskDollar(balanceState.balance, cfg);
    if (riskUsd <= 0) {
      missed.push({ ...sig, ...entryAttempt, missedReason: 'NO_RISK_CAPITAL' });
      continue;
    }

    const qty = riskUsd / sig.slDistance;
    const entryCandle = candles[entryAttempt.fillIdx] || candles[sig.signalIdx];
    let entrySlip = 0;
    let entryPrice = sig.entry;
    const entryMaker = cfg.entryMode === 'maker_gtx';
    if (!entryMaker) {
      entrySlip = slippageFor('entry', cfg, entryCandle);
      entryPrice = isLong(sig.side) ? sig.entry + entrySlip : sig.entry - entrySlip;
    }

    const exit = resolveExecutedExit(sig, candles, entryAttempt.fillIdx, cfg, rand);
    const grossPnl = isLong(sig.side) ? (exit.exitPrice - entryPrice) * qty : (entryPrice - exit.exitPrice) * qty;
    const entryNotional = Math.abs(entryPrice * qty);
    const exitNotional = Math.abs(exit.exitPrice * qty);
    const entryFeeUsd = feeFor(entryNotional, entryMaker, cfg);
    const exitFeeUsd = feeFor(exitNotional, exit.exitMaker, cfg);
    const totalFeeUsd = entryFeeUsd + exitFeeUsd;
    const pnlUsd = grossPnl - totalFeeUsd;
    const grossRBeforeFees = grossPnl / riskUsd;
    const feeR = totalFeeUsd / riskUsd;
    const pnlR = pnlUsd / riskUsd;

    const trade = {
      ...sig,
      status: exit.status,
      fillIdx: entryAttempt.fillIdx,
      settleIdx: exit.exitIdx,
      riskUsd: fmtNum(riskUsd, 2),
      qty: fmtNum(qty, 6),
      entry: fmtNum(entryPrice, 4),
      exit: fmtNum(exit.exitPrice, 4),
      exitRefPrice: fmtNum(exit.exitRefPrice, 4),
      grossPnl: fmtNum(grossPnl, 2),
      pnlUsd: fmtNum(pnlUsd, 2),
      grossRBeforeFees: fmtNum(grossRBeforeFees, 4),
      feeR: fmtNum(feeR, 4),
      pnlR: fmtNum(pnlR, 4),
      entryFeeUsd: fmtNum(entryFeeUsd, 2),
      exitFeeUsd: fmtNum(exitFeeUsd, 2),
      totalFeeUsd: fmtNum(totalFeeUsd, 2),
      entryNotional: fmtNum(entryNotional, 2),
      exitNotional: fmtNum(exitNotional, 2),
      totalTurnover: fmtNum(entryNotional + exitNotional, 2),
      entrySlip: fmtNum(entrySlip, 4),
      tpSlip: fmtNum(exit.tpSlip, 4),
      slSlip: fmtNum(exit.slSlip, 4),
      fillProb: fmtNum(entryAttempt.fillProb, 4),
      makerEntryFillStyle: entryAttempt.makerEntryFillStyle || cfg.makerEntryFillStyle,
      touchedEntry: entryAttempt.touchedEntry,
      entryFillReason: entryAttempt.entryFillReason,
      entryFeeType: entryMaker ? 'maker' : 'taker',
      exitFeeType: exit.exitMaker ? 'maker' : 'taker',
      tpExitMode: exit.tpExitMode,
      tpMakerAttempts: exit.tpMakerAttempts,
      tpMakerFails: exit.tpMakerFails,
      tpFallbackUsed: exit.tpFallbackUsed,
      slippageModeUsed: cfg.slippageMode,
    };

    executed.push(trade);
    applyCompounding(balanceState, trade, cfg, candles[trade.settleIdx]?.closeTime || sig.signalTime);
  }

  finalizeCompounding(balanceState);
  return { executed, missed, endBalance: fmtNum(balanceState.balance, 2) };
}

function summarizeByEngine(cfg, pass1, pass2) {
  const enabledEngineIds = Object.entries(cfg.engines).filter(([, v]) => v).map(([k]) => k);
  const engineStats = Object.fromEntries(enabledEngineIds.map(id => [id, {
    ...pass1.engineStats[id],
    signalGrossR: fmtNum(pass1.engineStats[id]?.signalGrossR || 0, 4),
    executedGrossR: 0,
    executedNetR: 0,
    feeR: 0,
    filled: 0,
    missed: 0,
    missedNoTouch: 0,
    missedProb: 0,
    wins: 0,
    losses: 0,
  }]));

  for (const t of pass2.executed) {
    const s = engineStats[t.engine];
    if (!s) continue;
    s.filled += 1;
    s.executedGrossR += t.grossRBeforeFees;
    s.executedNetR += t.pnlR;
    s.feeR += t.feeR;
    if (t.pnlR > 0) s.wins += 1; else s.losses += 1;
  }
  for (const m of pass2.missed) {
    const s = engineStats[m.engine];
    if (!s) continue;
    s.missed += 1;
    if ((m.missedReason || '').includes('NO_TOUCH')) s.missedNoTouch += 1;
    if ((m.missedReason || '').includes('NOT_FILLED') || (m.missedReason || '').includes('NEUTRAL_MISSED')) s.missedProb += 1;
  }

  for (const s of Object.values(engineStats)) {
    s.executedGrossR = fmtNum(s.executedGrossR, 4);
    s.executedNetR = fmtNum(s.executedNetR, 4);
    s.feeR = fmtNum(s.feeR, 4);
  }
  return engineStats;
}

export function simulateScenario(candles, config) {
  const cfg = normalizeConfig(config);
  const startBalance = config.startingBalance ?? cfg.startingBalance ?? 10000;
  cfg.startingBalance = startBalance;

  const pass1 = passOneBuildLedger(candles, cfg);
  const pass2 = passTwoExecution(pass1.signals, candles, cfg);
  const engineStats = summarizeByEngine(cfg, pass1, pass2);

  const results = [...pass2.executed].sort((a, b) => a.settleIdx - b.settleIdx);
  const wins = results.filter(t => t.pnlR > 0).length;
  const losses = results.filter(t => t.pnlR <= 0).length;
  const totalFeeUsd = results.reduce((a, t) => a + t.totalFeeUsd, 0);
  const netR = results.reduce((a, t) => a + t.pnlR, 0);
  const grossR = results.reduce((a, t) => a + t.grossRBeforeFees, 0);
  const feeR = results.reduce((a, t) => a + t.feeR, 0);
  const totalTurnover = results.reduce((a, t) => a + t.totalTurnover, 0);

  const signalWinRate = pass1.signals.length ? pass1.signals.filter(s => s.expectedGrossR > 0).length / pass1.signals.length : 0;
  const filledWinRate = results.length ? wins / results.length : 0;
  const missedWinners = pass2.missed.filter(s => s.expectedGrossR > 0).length;
  const missedLosers = pass2.missed.filter(s => s.expectedGrossR <= 0).length;
  const tpMakerCount = results.filter(t => t.status === 'TP' && t.exitFeeType === 'maker').length;
  const tpTakerCount = results.filter(t => t.status === 'TP' && t.exitFeeType === 'taker').length;
  const tpFallbackCount = results.filter(t => t.tpFallbackUsed).length;
  const missedNoTouch = pass2.missed.filter(m => (m.missedReason || '').includes('NO_TOUCH')).length;
  const missedProb = pass2.missed.filter(m => (m.missedReason || '').includes('NOT_FILLED') || (m.missedReason || '').includes('NEUTRAL_MISSED')).length;

  const feeRSamples = results.map(t => t.feeR);
  const slSamples = results.map(t => t.slDistance);
  const notionalSamples = results.map(t => t.entryNotional);
  const maxRiskUsed = results.length ? Math.max(...results.map(t => t.riskUsd)) : 0;

  return {
    results,
    missedSignals: pass2.missed,
    signalLedger: pass1.signals,
    engineStats,
    summary: {
      trades: results.length,
      wins,
      losses,
      winRate: results.length ? wins / results.length : 0,
      signalCount: pass1.signals.length,
      filledCount: results.length,
      missedCount: pass2.missed.length,
      missedNoTouch,
      missedProb,
      signalWinRate,
      filledWinRate,
      biasRatio: signalWinRate > 0 ? filledWinRate / signalWinRate : 0,
      missedWinners,
      missedLosers,
      grossR: fmtNum(grossR, 4),
      feeR: fmtNum(feeR, 4),
      netR: fmtNum(netR, 4),
      avgR: fmtNum(results.length ? netR / results.length : 0, 4),
      startBalance: fmtNum(startBalance, 2),
      endBalance: pass2.endBalance,
      totalFeeUsd: fmtNum(totalFeeUsd, 2),
      totalTurnover: fmtNum(totalTurnover, 2),
      feeTurnoverPct: totalTurnover > 0 ? fmtNum((totalFeeUsd / totalTurnover) * 100, 4) : 0,
      roundTripFeeOneWayPct: totalTurnover > 0 ? fmtNum((totalFeeUsd / (totalTurnover / 2)) * 100, 4) : 0,
      avgFeePerTrade: fmtNum(avg(results.map(t => t.totalFeeUsd)), 2),
      avgTurnoverPerTrade: fmtNum(avg(results.map(t => t.totalTurnover)), 2),
      avgFeeR: fmtNum(avg(feeRSamples), 4),
      medianFeeR: fmtNum(median(feeRSamples), 4),
      avgSLDistance: fmtNum(avg(slSamples), 4),
      medianSLDistance: fmtNum(median(slSamples), 4),
      avgNotional: fmtNum(avg(notionalSamples), 2),
      medianNotional: fmtNum(median(notionalSamples), 2),
      avgEntrySlip: fmtNum(avg(results.map(t => t.entrySlip || 0)), 4),
      avgSLSlip: fmtNum(avg(results.map(t => t.slSlip || 0)), 4),
      avgTPSlip: fmtNum(avg(results.map(t => t.tpSlip || 0)), 4),
      maxRiskUsed: fmtNum(maxRiskUsed, 2),
      makerEntries: results.filter(t => t.entryFeeType === 'maker').length,
      takerEntries: results.filter(t => t.entryFeeType === 'taker').length,
      tpMakerCount,
      tpTakerCount,
      tpFallbackCount,
    },
    actualConfig: cfg,
  };
}
