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
  yearSelectionMode: 'single',

  // Risk/accounting
  riskMode: 'fixed', // fixed | pct
  fixedRisk: 200,
  riskPct: 2,
  riskCap: 1000,
  selectedLeverage: 20,
  leverageCheckLevels: [10, 15, 20],
  enforceEquityFloor: true,
  enforceLeverageLimit: false,
  positionSizingBasis: 'signal_entry', // signal_entry | actual_entry
  compounding: 'per_trade', // none | per_trade | daily | monthly | quarterly
  oneWayMode: true,
  allowStacking: false,

  // Signal/execution
  tpRMultiple: 2,
  entryMode: 'maker_gtx', // maker_gtx | normal_limit | normal_limit_then_market | taker_market
  makerEntryFillStyle: 'candle_live_proxy', // legacy field kept; GTX/limit entries now use candle-based live proxy
  // Per-engine execution lets D and E be tested with different live-style entries.
  // maker_gtx_then_taker = post-only/maker first; only if simulated GTX crossing-rejects, enter market.
  // maker_gtx_then_market = maker attempt first; if simulated GTX rejects OR passively misses/no-touches, enter market as a broad stress/rescue model.
  engineEntryMode: { B: 'maker_gtx', C: 'maker_gtx', D: 'normal_limit_then_market', E: 'maker_gtx', F: 'maker_gtx' },
  marketEntrySlMultiplier: 1, // applies only to taker/market/fallback entries; 1 = off
  engineMakerEntryFillStyle: { B: 'candle_live_proxy', C: 'candle_live_proxy', D: 'candle_live_proxy', E: 'candle_live_proxy', F: 'candle_live_proxy' },
  engineFillProbOverride: { B: null, C: null, D: null, E: null, F: null },
  // OHLC cannot know queue position. This is a calibration haircut applied only after candle logic says a maker fill was possible.
  makerCandidateFillProb: 0.5,
  engineMakerCandidateFillProb: { B: null, C: null, D: null, E: null, F: null },
  gtxRejectBufferPts: 0.01, // one tick buffer for candle-based entry classification
  sameCandleRule: 'path_heuristic', // path_heuristic | sl_first | tp_first
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
  tpFallbackSeconds: 45, // UI/log only; 5m OHLC cannot observe seconds, so 0 candles = same-candle proxy

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

function resolveSameCandleBoth(side, candle, cfg) {
  const rule = cfg.sameCandleRule || 'path_heuristic';
  if (rule === 'tp_first') return { first: 'TP', resolutionRuleUsed: 'same_candle_tp_first' };
  if (rule === 'sl_first') return { first: 'SL', resolutionRuleUsed: 'same_candle_sl_first' };
  const bullish = Number(candle.close) > Number(candle.open);
  const bearish = Number(candle.close) < Number(candle.open);
  if (bullish) return isLong(side) ? { first: 'SL', resolutionRuleUsed: 'same_candle_path_bull_low_first' } : { first: 'TP', resolutionRuleUsed: 'same_candle_path_bull_low_first' };
  if (bearish) return isLong(side) ? { first: 'TP', resolutionRuleUsed: 'same_candle_path_bear_high_first' } : { first: 'SL', resolutionRuleUsed: 'same_candle_path_bear_high_first' };
  return { first: 'SL', resolutionRuleUsed: 'same_candle_path_doji_conservative_sl' };
}

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
    engineEntryMode: { ...DEFAULT_CONFIG.engineEntryMode, ...(config.engineEntryMode || {}) },
    engineMakerEntryFillStyle: { ...DEFAULT_CONFIG.engineMakerEntryFillStyle, ...(config.engineMakerEntryFillStyle || {}) },
    engineFillProbOverride: { ...DEFAULT_CONFIG.engineFillProbOverride, ...(config.engineFillProbOverride || {}) },
    engineMakerCandidateFillProb: { ...DEFAULT_CONFIG.engineMakerCandidateFillProb, ...(config.engineMakerCandidateFillProb || {}) },
  });

  // Backward compatibility with older patched bundles.
  if (config.slippageBasePts && !config.slippageManualPts) merged.slippageManualPts = { ...DEFAULT_CONFIG.slippageManualPts, ...config.slippageBasePts };
  if (config.slippageBasePts && !config.slippageDynamicBasePts) merged.slippageDynamicBasePts = { ...DEFAULT_CONFIG.slippageDynamicBasePts, ...config.slippageBasePts };
  if (config.tpMode === 'limit') merged.tpMode = 'maker_limit';
  const legacyEntryMap = { maker_gtx_then_taker: 'normal_limit_then_market', maker_gtx_then_market: 'normal_limit_then_market' };
  if (legacyEntryMap[merged.entryMode]) merged.entryMode = legacyEntryMap[merged.entryMode];
  if (['neutral_prob', 'touch_gated', 'hybrid', 'latency_open'].includes(merged.makerEntryFillStyle)) merged.makerEntryFillStyle = 'candle_live_proxy';
  if (merged.makerEntryFillStyle !== 'candle_live_proxy') merged.makerEntryFillStyle = DEFAULT_CONFIG.makerEntryFillStyle;
  const validEntryModes = ['maker_gtx', 'taker_market', 'normal_limit', 'normal_limit_then_market'];
  const validFillStyles = ['candle_live_proxy'];
  for (const id of Object.keys(merged.engineEntryMode || {})) {
    if (legacyEntryMap[merged.engineEntryMode[id]]) merged.engineEntryMode[id] = legacyEntryMap[merged.engineEntryMode[id]];
    if (!validEntryModes.includes(merged.engineEntryMode[id])) merged.engineEntryMode[id] = merged.entryMode;
  }
  for (const id of Object.keys(merged.engineMakerEntryFillStyle || {})) {
    if (!validFillStyles.includes(merged.engineMakerEntryFillStyle[id])) merged.engineMakerEntryFillStyle[id] = merged.makerEntryFillStyle;
  }
  merged.gtxRejectBufferPts = Math.max(0, Number(merged.gtxRejectBufferPts) || 0);
  merged.makerCandidateFillProb = clamp(Number(merged.makerCandidateFillProb ?? DEFAULT_CONFIG.makerCandidateFillProb), 0, 1);
  for (const id of Object.keys(merged.engineMakerCandidateFillProb || {})) {
    const v = merged.engineMakerCandidateFillProb[id];
    merged.engineMakerCandidateFillProb[id] = (v === null || v === '' || v === undefined) ? null : clamp(Number(v), 0, 1);
  }
  if (!['path_heuristic','sl_first','tp_first'].includes(merged.sameCandleRule)) merged.sameCandleRule = DEFAULT_CONFIG.sameCandleRule;
  merged.selectedLeverage = Math.max(1, Number(merged.selectedLeverage) || DEFAULT_CONFIG.selectedLeverage);
  merged.enforceEquityFloor = merged.enforceEquityFloor !== false;
  merged.enforceLeverageLimit = !!merged.enforceLeverageLimit;
  if (!['signal_entry','actual_entry'].includes(merged.positionSizingBasis)) merged.positionSizingBasis = DEFAULT_CONFIG.positionSizingBasis;
  merged.marketEntrySlMultiplier = Math.max(1, Number(merged.marketEntrySlMultiplier) || 1);
  merged.leverageCheckLevels = Array.isArray(merged.leverageCheckLevels) && merged.leverageCheckLevels.length ? merged.leverageCheckLevels.map(v => Math.max(1, Number(v) || 1)) : DEFAULT_CONFIG.leverageCheckLevels;

  merged.tpRMultiple = Math.max(0.1, Number(merged.tpRMultiple) || DEFAULT_CONFIG.tpRMultiple);
  merged.entryTimeoutCandles = Math.max(0, Math.floor(Number(merged.entryTimeoutCandles) || 0));
  merged.makerEntryTimeoutCandles = Math.max(0, Math.floor(Number(merged.makerEntryTimeoutCandles) || 0));
  merged.maxHoldCandles = Math.max(1, Math.floor(Number(merged.maxHoldCandles) || DEFAULT_CONFIG.maxHoldCandles));
  merged.feeMakerBps = Math.max(0, Number(merged.feeMakerBps) || 0);
  merged.feeTakerBps = Math.max(0, Number(merged.feeTakerBps) || 0);
  merged.tpMakerFillProb = clamp(Number(merged.tpMakerFillProb) || 0, 0, 1);
  merged.tpFallbackCandles = Math.max(0, Math.floor(Number(merged.tpFallbackCandles) || 0));
  merged.tpFallbackSeconds = Math.max(0, Number(merged.tpFallbackSeconds) || 0);
  merged.fillProbA = clamp(Number(merged.fillProbA), 0, 1);
  merged.fillProbB = clamp(Number(merged.fillProbB), 0, 1);
  merged.fillProbC = clamp(Number(merged.fillProbC), 0, 1);
  if (merged.fillProbOverride !== null && merged.fillProbOverride !== '') merged.fillProbOverride = clamp(Number(merged.fillProbOverride), 0, 1);
  else merged.fillProbOverride = null;
  for (const id of Object.keys(merged.engineFillProbOverride || {})) {
    const v = merged.engineFillProbOverride[id];
    merged.engineFillProbOverride[id] = (v === null || v === '' || v === undefined) ? null : clamp(Number(v), 0, 1);
  }

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

function applyTradeAccounting(balanceState, trade, cfg, ts) {
  // Always apply realized PnL to real account balance.
  // Compounding only controls the sizing balance used for future risk calculations.
  const pnl = Number(trade.pnlUsd) || 0;
  balanceState.realizedBalance += pnl;

  const d = new Date(ts);
  const bucket = cfg.compounding === 'daily' ? d.toISOString().slice(0,10)
    : cfg.compounding === 'monthly' ? monthKey(ts)
    : cfg.compounding === 'quarterly' ? quarterKey(ts)
    : null;

  if (cfg.riskMode !== 'pct') return;
  if (cfg.compounding === 'none') return;
  if (cfg.compounding === 'per_trade') {
    balanceState.sizingBalance += pnl;
    return;
  }
  if (bucket && balanceState.pendingBucket !== bucket) {
    if (balanceState.pendingPnl !== 0) balanceState.sizingBalance += balanceState.pendingPnl;
    balanceState.pendingPnl = 0;
    balanceState.pendingBucket = bucket;
  }
  if (bucket) balanceState.pendingPnl += pnl;
}

function finalizeTradeAccounting(balanceState, cfg) {
  if (cfg.riskMode === 'pct' && cfg.compounding !== 'none' && cfg.compounding !== 'per_trade' && balanceState.pendingPnl) {
    balanceState.sizingBalance += balanceState.pendingPnl;
  }
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
    let sameCandleTpSl = false;
    let resolutionRuleUsed = null;
    if (status === 'BOTH') {
      sameCandleTpSl = true;
      const resolved = resolveSameCandleBoth(signal.side, c, cfg);
      status = resolved.first;
      resolutionRuleUsed = resolved.resolutionRuleUsed;
    }
    const grossR = status === 'TP' ? Math.abs(signal.tp - signal.entry) / signal.slDistance : -1;
    return { status, settleIdx: j, exitRefPrice: status === 'TP' ? signal.tp : signal.sl, expectedGrossR: fmtNum(grossR, 4), sameCandleTpSl, resolutionRuleUsed };
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
      sig.theoreticalSameCandleTpSl = !!outcome.sameCandleTpSl;
      sig.theoreticalResolutionRuleUsed = outcome.resolutionRuleUsed || null;
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

function engineEntryMode(signal, cfg) {
  return cfg.engineEntryMode?.[signal.engine] || cfg.entryMode || 'maker_gtx';
}

function engineMakerFillStyle(signal, cfg) {
  return cfg.engineMakerEntryFillStyle?.[signal.engine] || cfg.makerEntryFillStyle || 'neutral_prob';
}

function baseEntryFillProbability(cfg, engineId = null) {
  const perEngine = engineId ? cfg.engineFillProbOverride?.[engineId] : null;
  if (perEngine !== null && perEngine !== undefined) return perEngine;
  if (cfg.fillProbOverride !== null && cfg.fillProbOverride !== undefined) return cfg.fillProbOverride;
  if (cfg.executionModel === 'A') return cfg.fillProbA;
  if (cfg.executionModel === 'C') return cfg.fillProbC;
  return cfg.fillProbB;
}

function fillProbabilityForTouch(signal, candle, cfg) {
  const base = baseEntryFillProbability(cfg, signal.engine);
  if (engineEntryMode(signal, cfg) === 'taker_market') return 1;
  const penetration = isLong(signal.side)
    ? Math.max(0, signal.entry - candle.low)
    : Math.max(0, candle.high - signal.entry);
  const penetrationBonus = clamp((penetration / Math.max(signal.slDistance, 0.0001)) * 0.08, 0, 0.08);
  return clamp(base + penetrationBonus, 0, 1);
}

function marketReferencePrice(signal, candle) {
  // Best OHLC-only proxy for bot receiving the signal after the signal candle closes.
  // If the active candle is the next candle, its open is the closest available price.
  return Number.isFinite(candle?.open) ? candle.open : signal.entry;
}

function gtxLatencyDecision(signal, refPrice, cfg) {
  // OHLC-only proxy for post-only/GTX order behavior after the signal candle closes.
  // IMPORTANT: this is deterministic price-movement logic, not a win/loss filter and not the 88% probability model.
  // For a LONG buy limit at signal.entry:
  //   price above entry => the order is passive but likely missed/chasing a winner (not rejected)
  //   price below entry => the buy limit may cross the ask and be rejected as taker-making
  // For a SHORT sell limit, mirror the logic.
  const movedTowardTp = isLong(signal.side) ? refPrice - signal.entry : signal.entry - refPrice;
  const absMoved = Math.abs(movedTowardTp);
  const buffer = Number(cfg.gtxRejectBufferPts) || 0;
  if (movedTowardTp > buffer) {
    return {
      outcome: 'PASSIVE_MISS_TOWARD_TP',
      accepted: true,
      filledMaker: false,
      rejected: false,
      direction: 'toward_tp',
      movedPts: absMoved,
    };
  }
  if (movedTowardTp < -buffer) {
    return {
      outcome: 'GTX_REJECTED_CROSSING_TOWARD_SL',
      accepted: false,
      filledMaker: false,
      rejected: true,
      direction: 'toward_sl',
      movedPts: absMoved,
    };
  }
  return {
    outcome: 'GTX_ACCEPTED_NEAR_ENTRY_FILLED_MAKER',
    accepted: true,
    filledMaker: true,
    rejected: false,
    direction: 'near_entry',
    movedPts: absMoved,
  };
}

function normalLimitDecision(signal, refPrice, cfg) {
  // Normal limit is not post-only. If the limit would cross at placement, it fills as taker.
  // Otherwise it rests as maker and may fill on return/touch within timeout.
  const movedTowardTp = isLong(signal.side) ? refPrice - signal.entry : signal.entry - refPrice;
  const buffer = Number(cfg.gtxRejectBufferPts) || 0;
  if (movedTowardTp < -buffer) {
    return { outcome: 'NORMAL_LIMIT_CROSSED_TAKER', crosses: true, rests: false, direction: 'toward_sl', movedPts: Math.abs(movedTowardTp) };
  }
  return { outcome: 'NORMAL_LIMIT_RESTING_MAKER', crosses: false, rests: true, direction: movedTowardTp > buffer ? 'toward_tp' : 'near_entry', movedPts: Math.abs(movedTowardTp) };
}

function entryMoveTowardTp(signal, price) {
  return isLong(signal.side) ? price - signal.entry : signal.entry - price;
}

function entryCrossesAsTaker(signal, refPrice, cfg) {
  const buffer = Number(cfg.gtxRejectBufferPts) || 0;
  return entryMoveTowardTp(signal, refPrice) < -buffer;
}

function entryPassiveAway(signal, refPrice, cfg) {
  const buffer = Number(cfg.gtxRejectBufferPts) || 0;
  return entryMoveTowardTp(signal, refPrice) > buffer;
}

function makeEntryResult(base) {
  return {
    fillProb: 1,
    makerEntryFillStyle: 'candle_live_proxy',
    gtxDecisionModel: 'candle_live_proxy',
    gtxRejectDirection: base.gtxRejectDirection ?? null,
    gtxRejectMovedPts: base.gtxRejectMovedPts ?? 0,
    gtxRejected: !!base.gtxRejected,
    gtxPassiveMissTowardTP: !!base.gtxPassiveMissTowardTP,
    takerFallbackUsed: !!base.takerFallbackUsed,
    makerAttemptFailedBeforeFallback: !!base.makerAttemptFailedBeforeFallback,
    ...base,
  };
}

function tryFillEntry(signal, candles, cfg, rand) {
  const start = Math.min(candles.length - 1, signal.activeFromIdx);
  const end = Math.min(candles.length - 1, start + cfg.makerEntryTimeoutCandles);
  const mode = engineEntryMode(signal, cfg);
  const activeCandle = candles[start] || candles[signal.signalIdx];
  const refPrice = marketReferencePrice(signal, activeCandle);
  const movedTowardTp = entryMoveTowardTp(signal, refPrice);
  const movedPts = Math.abs(movedTowardTp);
  const crosses = entryCrossesAsTaker(signal, refPrice, cfg);
  const makerProb = makerCandidateProbability(cfg, signal.engine);

  const marketFallback = (reason, idx = start, extra = {}) => {
    const fillIdx = Math.min(candles.length - 1, Math.max(0, idx));
    const c = candles[fillIdx] || activeCandle;
    return makeEntryResult({
      filled: true,
      fillIdx,
      touchedEntry: !!extra.touchedEntry,
      entryFillReason: reason,
      actualEntryMode: extra.actualEntryMode || 'market_fallback_after_limit_attempt',
      entryBasePrice: extra.entryBasePrice ?? marketReferencePrice(signal, c),
      gtxOutcome: extra.gtxOutcome || reason,
      fillProb: 1,
      takerFallbackUsed: true,
      makerAttemptFailedBeforeFallback: true,
      ...extra,
    });
  };

  const makerCandidate = (reason, idx, extra = {}) => {
    const fillIdx = Math.min(candles.length - 1, Math.max(0, idx));
    const filledByQueue = rand() <= makerProb;
    const base = {
      fillIdx,
      touchedEntry: true,
      entryBasePrice: signal.entry,
      fillProb: makerProb,
      makerCandidate: true,
      makerCandidateFailed: !filledByQueue,
      makerCandidateReason: reason,
      ...extra,
    };
    if (filledByQueue) {
      return makeEntryResult({
        ...base,
        filled: true,
        entryFillReason: reason,
        actualEntryMode: extra.actualEntryMode || (mode === 'maker_gtx' ? 'maker_gtx' : 'normal_limit_maker'),
        gtxOutcome: extra.gtxOutcome || reason,
      });
    }
    return makeEntryResult({
      ...base,
      filled: false,
      entryFillReason: `${reason}_QUEUE_NOT_FILLED`,
      actualEntryMode: extra.actualEntryMode || mode,
      gtxOutcome: `${extra.gtxOutcome || reason}_QUEUE_NOT_FILLED`,
    });
  };

  const firstReturnTouchIdx = () => {
    for (let i = start; i <= end; i++) {
      const c = candles[i];
      if (!c || !priceTouched(signal.side, signal.entry, c)) continue;
      return i;
    }
    return null;
  };

  if (mode === 'taker_market') {
    return makeEntryResult({ filled: true, fillIdx: start, touchedEntry: true, entryFillReason: 'TAKER_MARKET', actualEntryMode: 'taker_market', entryBasePrice: refPrice, gtxOutcome: 'TAKER_MARKET', fillProb: 1 });
  }

  if (mode === 'normal_limit' || mode === 'normal_limit_then_market') {
    // Normal limit can fill taker if it crosses at placement. This is not GTX/post-only.
    if (crosses) return makeEntryResult({ filled: true, fillIdx: start, touchedEntry: true, entryFillReason: 'NORMAL_LIMIT_CROSSED_TAKER', actualEntryMode: 'normal_limit_taker_cross', entryBasePrice: refPrice, gtxOutcome: 'NORMAL_LIMIT_CROSSED_TAKER', gtxRejectDirection: 'toward_sl', gtxRejectMovedPts: movedPts, fillProb: 1 });

    const touchIdx = firstReturnTouchIdx();
    if (touchIdx !== null) {
      const candidate = makerCandidate(touchIdx === start ? 'NORMAL_LIMIT_NEAR_OR_TOUCH_MAKER_CANDIDATE' : 'NORMAL_LIMIT_RETURN_TOUCH_MAKER_CANDIDATE', touchIdx, { actualEntryMode: 'normal_limit_maker' });
      if (candidate.filled) return candidate;
      if (mode === 'normal_limit_then_market') return marketFallback('NORMAL_LIMIT_MAKER_CANDIDATE_FAILED_MARKET_FALLBACK', end, { touchedEntry: true, actualEntryMode: 'normal_limit_market_fallback', entryBasePrice: marketReferencePrice(signal, candles[end] || activeCandle), gtxOutcome: candidate.gtxOutcome, fillProb: makerProb, makerCandidate: true, makerCandidateFailed: true });
      return { ...candidate, missedReason: candidate.entryFillReason };
    }

    if (mode === 'normal_limit_then_market') return marketFallback('NORMAL_LIMIT_NO_TOUCH_MARKET_FALLBACK', end, { touchedEntry: false, actualEntryMode: 'normal_limit_market_fallback', entryBasePrice: marketReferencePrice(signal, candles[end] || activeCandle), gtxOutcome: 'NORMAL_LIMIT_NO_TOUCH', gtxPassiveMissTowardTP: movedTowardTp > 0, gtxRejectDirection: movedTowardTp > 0 ? 'toward_tp' : 'no_touch', gtxRejectMovedPts: movedPts });
    return makeEntryResult({ filled: false, fillIdx: null, touchedEntry: false, entryFillReason: 'NORMAL_LIMIT_NO_TOUCH_CANCELLED', actualEntryMode: 'normal_limit', entryBasePrice: refPrice, gtxOutcome: 'NORMAL_LIMIT_NO_TOUCH', gtxPassiveMissTowardTP: movedTowardTp > 0, gtxRejectDirection: movedTowardTp > 0 ? 'toward_tp' : 'no_touch', gtxRejectMovedPts: movedPts, fillProb: makerProb });
  }

  if (mode === 'maker_gtx') {
    // GTX/post-only can only be maker. If it would cross at placement, exchange rejects it.
    if (crosses) return makeEntryResult({ filled: false, fillIdx: null, touchedEntry: false, entryFillReason: 'GTX_REJECTED_CROSSING', actualEntryMode: 'maker_gtx', entryBasePrice: refPrice, gtxOutcome: 'GTX_REJECTED_CROSSING', gtxRejected: true, gtxRejectDirection: 'toward_sl', gtxRejectMovedPts: movedPts, fillProb: makerProb });

    const touchIdx = firstReturnTouchIdx();
    if (touchIdx !== null) {
      const candidate = makerCandidate(touchIdx === start ? 'GTX_NEAR_OR_TOUCH_MAKER_CANDIDATE' : 'GTX_RETURN_TOUCH_MAKER_CANDIDATE', touchIdx, { actualEntryMode: 'maker_gtx' });
      if (candidate.filled) return candidate;
      return { ...candidate, filled: false, fillIdx: null, touchedEntry: true, gtxPassiveMissTowardTP: movedTowardTp > 0, gtxRejectDirection: movedTowardTp > 0 ? 'toward_tp' : 'queue_not_filled', gtxRejectMovedPts: movedPts };
    }

    return makeEntryResult({ filled: false, fillIdx: null, touchedEntry: false, entryFillReason: 'GTX_NO_TOUCH_MISSED', actualEntryMode: 'maker_gtx', entryBasePrice: refPrice, gtxOutcome: 'GTX_NO_TOUCH', gtxPassiveMissTowardTP: movedTowardTp > 0, gtxRejectDirection: movedTowardTp > 0 ? 'toward_tp' : 'no_touch', gtxRejectMovedPts: movedPts, fillProb: makerProb });
  }

  return makeEntryResult({ filled: false, fillIdx: null, touchedEntry: false, entryFillReason: 'UNKNOWN_ENTRY_MODE', actualEntryMode: mode, entryBasePrice: refPrice, gtxOutcome: 'UNKNOWN_ENTRY_MODE', fillProb: makerProb });
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
    const sameCandleTpSl = first === 'BOTH';
    let resolutionRuleUsed = null;
    if (sameCandleTpSl) {
      const resolved = resolveSameCandleBoth(signal.side, c, cfg);
      first = resolved.first;
      resolutionRuleUsed = resolved.resolutionRuleUsed;
    }

    if (first === 'SL') {
      const { price, slip } = exitPriceWithSlippage(signal, signal.sl, 'sl', cfg, c);
      return { status: 'SL', exitIdx: j, exitPrice: price, exitRefPrice: signal.sl, exitMaker: false, tpSlip: 0, slSlip: slip, tpExitMode: 'sl_taker', tpMakerAttempts, tpMakerFails, tpFallbackUsed: false, sameCandleTpSl, resolutionRuleUsed };
    }

    if (first === 'TP') {
      if (cfg.tpMode === 'market') {
        const { price, slip } = exitPriceWithSlippage(signal, signal.tp, 'tp', cfg, c);
        return { status: 'TP', exitIdx: j, exitPrice: price, exitRefPrice: signal.tp, exitMaker: false, tpSlip: slip, slSlip: 0, tpExitMode: 'tp_market_taker', tpMakerAttempts, tpMakerFails, tpFallbackUsed: false, sameCandleTpSl, resolutionRuleUsed };
      }

      tpMakerAttempts += 1;
      const makerFilled = rand() <= cfg.tpMakerFillProb;
      if (makerFilled) {
        return { status: 'TP', exitIdx: j, exitPrice: signal.tp, exitRefPrice: signal.tp, exitMaker: true, tpSlip: 0, slSlip: 0, tpExitMode: 'tp_maker_limit', tpMakerAttempts, tpMakerFails, tpFallbackUsed: false, sameCandleTpSl, resolutionRuleUsed };
      }

      tpMakerFails += 1;
      if (cfg.tpMode === 'maker_then_market') {
        const fallbackIdx = Math.min(maxIdx, j + cfg.tpFallbackCandles);
        const fallbackCandle = candles[fallbackIdx] || c;
        const { price, slip } = exitPriceWithSlippage(signal, signal.tp, 'tp', cfg, fallbackCandle);
        return { status: 'TP', exitIdx: fallbackIdx, exitPrice: price, exitRefPrice: signal.tp, exitMaker: false, tpSlip: slip, slSlip: 0, tpExitMode: 'tp_maker_failed_taker_fallback', tpMakerAttempts, tpMakerFails, tpFallbackUsed: true, sameCandleTpSl, resolutionRuleUsed };
      }

      // maker_limit mode: failed TP touch stays open. If the same candle also hit SL, respect that risk.
      if (slHit) {
        const { price, slip } = exitPriceWithSlippage(signal, signal.sl, 'sl', cfg, c);
        return { status: 'SL', exitIdx: j, exitPrice: price, exitRefPrice: signal.sl, exitMaker: false, tpSlip: 0, slSlip: slip, tpExitMode: 'tp_maker_failed_then_sl_same_candle', tpMakerAttempts, tpMakerFails, tpFallbackUsed: false, sameCandleTpSl, resolutionRuleUsed };
      }
    }
  }

  const last = candles[maxIdx] || candles[candles.length - 1];
  return { status: 'TIMEOUT', exitIdx: maxIdx, exitPrice: last.close, exitRefPrice: last.close, exitMaker: false, tpSlip: 0, slSlip: 0, tpExitMode: 'timeout_taker_close', tpMakerAttempts, tpMakerFails, tpFallbackUsed: false, sameCandleTpSl: false, resolutionRuleUsed: null };
}

function passTwoExecution(signals, candles, cfg) {
  const balanceState = { realizedBalance: cfg.startingBalance, sizingBalance: cfg.startingBalance, pendingPnl: 0, pendingBucket: null };
  const executed = [];
  const missed = [];
  const rand = makeRng(cfg.randomSeed);

  for (const sig of [...signals].sort((a, b) => a.signalIdx - b.signalIdx)) {
    const entryAttempt = tryFillEntry(sig, candles, cfg, rand);
    if (!entryAttempt.filled) {
      missed.push({ ...sig, ...entryAttempt, missedReason: entryAttempt.entryFillReason });
      continue;
    }

    const balanceBefore = balanceState.realizedBalance;
    const sizingBalanceBefore = balanceState.sizingBalance;
    const riskUsd = getRiskDollar(sizingBalanceBefore, cfg);
    const equityBefore = balanceBefore;
    if (riskUsd <= 0) {
      missed.push({ ...sig, ...entryAttempt, missedReason: 'NO_RISK_CAPITAL' });
      continue;
    }

    if (cfg.enforceEquityFloor && equityBefore < riskUsd) {
      missed.push({ ...sig, ...entryAttempt, missedReason: 'INSUFFICIENT_EQUITY', equityBefore: fmtNum(equityBefore, 2), riskUsd: fmtNum(riskUsd, 2) });
      continue;
    }

    const entryCandle = candles[entryAttempt.fillIdx] || candles[sig.signalIdx];
    let entrySlip = 0;
    let entryPrice = entryAttempt.entryBasePrice ?? sig.entry;
    const actualEntryModeText = String(entryAttempt.actualEntryMode || '');
    const entryMaker = !(actualEntryModeText.includes('taker') || actualEntryModeText.includes('market'));
    if (!entryMaker) {
      entrySlip = slippageFor('entry', cfg, entryCandle);
      entryPrice = isLong(sig.side) ? entryPrice + entrySlip : entryPrice - entrySlip;
    }

    const entryIsMarketLike = !entryMaker;
    const marketEntrySlMultiplier = entryIsMarketLike ? Math.max(1, Number(cfg.marketEntrySlMultiplier) || 1) : 1;
    const baseSlDistanceFromEntry = Math.abs(entryPrice - sig.sl);
    const executionSl = marketEntrySlMultiplier > 1
      ? (isLong(sig.side) ? entryPrice - (baseSlDistanceFromEntry * marketEntrySlMultiplier) : entryPrice + (baseSlDistanceFromEntry * marketEntrySlMultiplier))
      : sig.sl;
    const executionTp = marketEntrySlMultiplier > 1
      ? (isLong(sig.side) ? entryPrice + (Math.abs(entryPrice - executionSl) * cfg.tpRMultiple) : entryPrice - (Math.abs(entryPrice - executionSl) * cfg.tpRMultiple))
      : sig.tp;
    const execSignal = marketEntrySlMultiplier > 1 ? { ...sig, sl: executionSl, tp: executionTp, executionTp } : sig;
    const actualRiskDistance = Math.abs(entryPrice - executionSl);
    const sizingDistance = cfg.positionSizingBasis === 'actual_entry' ? Math.max(actualRiskDistance, 0.0001) : sig.slDistance;
    const qty = riskUsd / sizingDistance;
    const entryNotional = Math.abs(entryPrice * qty);
    const requiredLeverage = equityBefore > 0 ? entryNotional / equityBefore : Infinity;
    const requiredMarginAtSelectedLeverage = entryNotional / cfg.selectedLeverage;
    const leverageFeasibleAtSelected = requiredMarginAtSelectedLeverage <= equityBefore;
    if (cfg.enforceLeverageLimit && !leverageFeasibleAtSelected) {
      missed.push({ ...sig, ...entryAttempt, missedReason: 'LEVERAGE_INFEASIBLE', equityBefore: fmtNum(equityBefore, 2), riskUsd: fmtNum(riskUsd, 2), entryBasePrice: fmtNum(entryAttempt.entryBasePrice ?? sig.entry, 4), entry: fmtNum(entryPrice, 4), qty: fmtNum(qty, 6), entryNotional: fmtNum(entryNotional, 2), requiredLeverage: fmtNum(requiredLeverage, 4), selectedLeverage: cfg.selectedLeverage, requiredMarginAtSelectedLeverage: fmtNum(requiredMarginAtSelectedLeverage, 2) });
      continue;
    }

    const exit = resolveExecutedExit(execSignal, candles, entryAttempt.fillIdx, cfg, rand);
    const grossPnl = isLong(execSignal.side) ? (exit.exitPrice - entryPrice) * qty : (entryPrice - exit.exitPrice) * qty;
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
      equityBefore: fmtNum(equityBefore, 2),
      balanceBefore: fmtNum(balanceBefore, 2),
      sizingBalanceBefore: fmtNum(sizingBalanceBefore, 2),
      riskUsd: fmtNum(riskUsd, 2),
      qty: fmtNum(qty, 6),
      signalEntry: fmtNum(sig.entry, 4),
      entryBasePrice: fmtNum(entryAttempt.entryBasePrice ?? sig.entry, 4),
      entry: fmtNum(entryPrice, 4),
      exit: fmtNum(exit.exitPrice, 4),
      exitRefPrice: fmtNum(exit.exitRefPrice, 4),
      executionSl: fmtNum(executionSl, 4),
      executionTp: fmtNum(executionTp, 4),
      marketEntrySlMultiplier: fmtNum(marketEntrySlMultiplier, 3),
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
      notionalToEquity: fmtNum(equityBefore > 0 ? entryNotional / equityBefore : 0, 4),
      requiredLeverage: fmtNum(requiredLeverage, 4),
      selectedLeverage: cfg.selectedLeverage,
      requiredMarginAtSelectedLeverage: fmtNum(requiredMarginAtSelectedLeverage, 2),
      leverageFeasibleAtSelected,
      totalTurnover: fmtNum(entryNotional + exitNotional, 2),
      entrySlip: fmtNum(entrySlip, 4),
      tpSlip: fmtNum(exit.tpSlip, 4),
      slSlip: fmtNum(exit.slSlip, 4),
      fillProb: fmtNum(entryAttempt.fillProb, 4),
      makerCandidate: !!entryAttempt.makerCandidate,
      makerCandidateFailed: !!entryAttempt.makerCandidateFailed,
      makerCandidateReason: entryAttempt.makerCandidateReason || null,
      makerEntryFillStyle: entryAttempt.makerEntryFillStyle || cfg.makerEntryFillStyle,
      touchedEntry: entryAttempt.touchedEntry,
      entryFillReason: entryAttempt.entryFillReason,
      actualEntryMode: entryAttempt.actualEntryMode,
      gtxDecisionModel: entryAttempt.gtxDecisionModel || null,
      gtxOutcome: entryAttempt.gtxOutcome || null,
      gtxRejected: !!entryAttempt.gtxRejected,
      gtxPassiveMissTowardTP: !!entryAttempt.gtxPassiveMissTowardTP,
      gtxRejectDirection: entryAttempt.gtxRejectDirection,
      gtxRejectMovedPts: fmtNum(entryAttempt.gtxRejectMovedPts || 0, 4),
      takerFallbackEntryUsed: !!entryAttempt.takerFallbackUsed,
      makerAttemptFailedBeforeFallback: !!entryAttempt.makerAttemptFailedBeforeFallback,
      entryFeeType: entryMaker ? 'maker' : 'taker',
      exitFeeType: exit.exitMaker ? 'maker' : 'taker',
      tpExitMode: exit.tpExitMode,
      tpMakerAttempts: exit.tpMakerAttempts,
      tpMakerFails: exit.tpMakerFails,
      tpFallbackUsed: exit.tpFallbackUsed,
      sameCandleTpSl: !!exit.sameCandleTpSl,
      resolutionRuleUsed: exit.resolutionRuleUsed || null,
      theoreticalSameCandleTpSl: !!sig.theoreticalSameCandleTpSl,
      theoreticalResolutionRuleUsed: sig.theoreticalResolutionRuleUsed || null,
      actualRiskDistance: fmtNum(actualRiskDistance, 4),
      sizingDistance: fmtNum(sizingDistance, 4),
      positionSizingBasis: cfg.positionSizingBasis,
      slippageModeUsed: cfg.slippageMode,
    };

    applyTradeAccounting(balanceState, trade, cfg, candles[trade.settleIdx]?.closeTime || sig.signalTime);
    trade.balanceAfter = fmtNum(balanceState.realizedBalance, 2);
    trade.sizingBalanceAfter = fmtNum(balanceState.sizingBalance, 2);
    executed.push(trade);
  }

  finalizeTradeAccounting(balanceState, cfg);
  return { executed, missed, endBalance: fmtNum(balanceState.realizedBalance, 2), sizingEndBalance: fmtNum(balanceState.sizingBalance, 2) };
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
    timeouts: 0,
    netPositiveTrades: 0,
  }]));

  for (const t of pass2.executed) {
    const s = engineStats[t.engine];
    if (!s) continue;
    s.filled += 1;
    s.executedGrossR += t.grossRBeforeFees;
    s.executedNetR += t.pnlR;
    s.feeR += t.feeR;
    if (t.status === 'TP') s.wins += 1; else if (t.status === 'SL') s.losses += 1; else s.timeouts += 1;
    if (t.pnlR > 0) s.netPositiveTrades += 1;
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
  const wins = results.filter(t => t.status === 'TP').length;
  const losses = results.filter(t => t.status === 'SL').length;
  const timeouts = results.filter(t => t.status !== 'TP' && t.status !== 'SL').length;
  const netPositiveTrades = results.filter(t => t.pnlR > 0).length;
  const totalFeeUsd = results.reduce((a, t) => a + t.totalFeeUsd, 0);
  const netR = results.reduce((a, t) => a + t.pnlR, 0);
  const grossR = results.reduce((a, t) => a + t.grossRBeforeFees, 0);
  const feeR = results.reduce((a, t) => a + t.feeR, 0);
  const totalTurnover = results.reduce((a, t) => a + t.totalTurnover, 0);
  const totalPnlUsd = results.reduce((a, t) => a + (Number(t.pnlUsd) || 0), 0);
  const balanceDelta = (Number(pass2.endBalance) || 0) - (Number(startBalance) || 0);
  const pnlRowsReconciliationDiff = totalPnlUsd - results.reduce((a, t) => a + ((Number(t.pnlR) || 0) * (Number(t.riskUsd) || 0)), 0);
  const balanceReconciliationDiff = balanceDelta - totalPnlUsd;

  const signalWinRate = pass1.signals.length ? pass1.signals.filter(s => s.expectedGrossR > 0).length / pass1.signals.length : 0;
  const filledWinRate = results.length ? results.filter(t => t.grossRBeforeFees > 0).length / results.length : 0;
  const missedWinners = pass2.missed.filter(s => s.expectedGrossR > 0).length;
  const missedLosers = pass2.missed.filter(s => s.expectedGrossR <= 0).length;
  const tpMakerCount = results.filter(t => t.status === 'TP' && t.exitFeeType === 'maker').length;
  const tpTakerCount = results.filter(t => t.status === 'TP' && t.exitFeeType === 'taker').length;
  const tpFallbackCount = results.filter(t => t.tpFallbackUsed).length;
  const sameCandleTpSlCount = results.filter(t => t.sameCandleTpSl).length;
  const sameCandleResolvedTP = results.filter(t => t.sameCandleTpSl && t.status === 'TP').length;
  const sameCandleResolvedSL = results.filter(t => t.sameCandleTpSl && t.status === 'SL').length;
  const theoreticalSameCandleTpSlCount = pass1.signals.filter(s => s.theoreticalSameCandleTpSl).length;
  const missedNoTouch = pass2.missed.filter(m => (m.missedReason || '').includes('NO_TOUCH')).length;
  const missedProb = pass2.missed.filter(m => (m.missedReason || '').includes('NOT_FILLED') || (m.missedReason || '').includes('NEUTRAL_MISSED')).length;
  const allEntryRecords = [...pass2.missed, ...results];
  const gtxPassiveMissTowardTP = allEntryRecords.filter(r => r.gtxPassiveMissTowardTP || r.gtxOutcome === 'PASSIVE_MISS_TOWARD_TP').length;
  const gtxRejectedTowardSL = allEntryRecords.filter(r => r.gtxRejected && r.gtxRejectDirection === 'toward_sl').length;
  const gtxAcceptedNearEntry = allEntryRecords.filter(r => String(r.gtxOutcome || '').includes('NEAR_ENTRY_MAKER_FILLED')).length;
  const gtxRejectTowardTP = allEntryRecords.filter(r => r.gtxRejected && r.gtxRejectDirection === 'toward_tp').length; // should normally be zero under corrected latency/open logic
  const gtxRejectTakerFallbackEntries = results.filter(t => t.takerFallbackEntryUsed && String(t.actualEntryMode || '').includes('reject')).length;
  const makerAttemptMarketFallbackEntries = results.filter(t => t.makerAttemptFailedBeforeFallback).length;
  const gtxPassiveMissTowardTPByEngine = Object.fromEntries(Object.keys(engineStats).map(id => [id, allEntryRecords.filter(r => r.engine === id && (r.gtxPassiveMissTowardTP || r.gtxOutcome === 'PASSIVE_MISS_TOWARD_TP')).length]));
  const gtxRejectedTowardSLByEngine = Object.fromEntries(Object.keys(engineStats).map(id => [id, allEntryRecords.filter(r => r.engine === id && r.gtxRejected && r.gtxRejectDirection === 'toward_sl').length]));
  const gtxRejectTowardTPByEngine = Object.fromEntries(Object.keys(engineStats).map(id => [id, allEntryRecords.filter(r => r.engine === id && r.gtxRejected && r.gtxRejectDirection === 'toward_tp').length]));

  const feeRSamples = results.map(t => t.feeR);
  const slSamples = results.map(t => t.slDistance);
  const notionalSamples = results.map(t => t.entryNotional);
  const leverageSamples = results.map(t => t.requiredLeverage || 0);
  const maxRiskUsed = results.length ? Math.max(...results.map(t => t.riskUsd)) : 0;
  const leverageFeasibility = Object.fromEntries((cfg.leverageCheckLevels || []).map(level => [String(level) + 'x', {
    infeasibleTrades: results.filter(t => (t.entryNotional / level) > t.equityBefore).length,
    maxRequiredMargin: fmtNum(results.length ? Math.max(...results.map(t => t.entryNotional / level)) : 0, 2),
  }]));
  const makerCandidateRecords = allEntryRecords.filter(r => r.makerCandidate);
  const makerCandidateFailedRecords = allEntryRecords.filter(r => r.makerCandidateFailed);

  return {
    results,
    missedSignals: pass2.missed,
    signalLedger: pass1.signals,
    engineStats,
    summary: {
      trades: results.length,
      wins,
      losses,
      timeouts,
      netPositiveTrades,
      winRate: results.length ? wins / results.length : 0,
      signalCount: pass1.signals.length,
      filledCount: results.length,
      missedCount: pass2.missed.length,
      missedNoTouch,
      missedProb,
      missedInsufficientEquity: pass2.missed.filter(m => (m.missedReason || '').includes('INSUFFICIENT_EQUITY')).length,
      missedLeverageInfeasible: pass2.missed.filter(m => (m.missedReason || '').includes('LEVERAGE_INFEASIBLE')).length,
      signalWinRate,
      filledWinRate,
      biasRatio: signalWinRate > 0 ? filledWinRate / signalWinRate : 0,
      missedWinners,
      missedLosers,
      grossR: fmtNum(grossR, 4),
      cleanGrossRFromStatus: fmtNum((wins * cfg.tpRMultiple) - losses, 4),
      grossRDiffFromStatusFormula: fmtNum(grossR - ((wins * cfg.tpRMultiple) - losses), 4),
      feeR: fmtNum(feeR, 4),
      netR: fmtNum(netR, 4),
      avgR: fmtNum(results.length ? netR / results.length : 0, 4),
      startBalance: fmtNum(startBalance, 2),
      endBalance: pass2.endBalance,
      sizingEndBalance: pass2.sizingEndBalance,
      totalPnlUsd: fmtNum(totalPnlUsd, 2),
      balanceDelta: fmtNum(balanceDelta, 2),
      balanceReconciliationDiff: fmtNum(balanceReconciliationDiff, 6),
      pnlRowsReconciliationDiff: fmtNum(pnlRowsReconciliationDiff, 6),
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
      avgRequiredLeverage: fmtNum(avg(leverageSamples), 4),
      medianRequiredLeverage: fmtNum(median(leverageSamples), 4),
      maxRequiredLeverage: fmtNum(results.length ? Math.max(...leverageSamples) : 0, 4),
      selectedLeverage: cfg.selectedLeverage,
      infeasibleAtSelectedLeverage: results.filter(t => !t.leverageFeasibleAtSelected).length,
      leverageFeasibility,
      avgEntrySlip: fmtNum(avg(results.map(t => t.entrySlip || 0)), 4),
      avgSLSlip: fmtNum(avg(results.map(t => t.slSlip || 0)), 4),
      avgTPSlip: fmtNum(avg(results.map(t => t.tpSlip || 0)), 4),
      maxRiskUsed: fmtNum(maxRiskUsed, 2),
      normalLimitMakerEntries: results.filter(t => t.actualEntryMode === 'normal_limit_maker').length,
      normalLimitTakerEntries: results.filter(t => t.actualEntryMode === 'normal_limit_taker_cross').length,
      normalLimitMisses: pass2.missed.filter(m => String(m.actualEntryMode || '').includes('normal_limit')).length,
      makerCandidateCount: makerCandidateRecords.length,
      makerCandidateFailedCount: makerCandidateFailedRecords.length,
      makerCandidateFillRate: makerCandidateRecords.length ? (makerCandidateRecords.length - makerCandidateFailedRecords.length) / makerCandidateRecords.length : 0,
      marketSlWidenedTrades: results.filter(t => Number(t.marketEntrySlMultiplier || 1) > 1).length,
      avgMarketSlMultiplier: fmtNum(avg(results.filter(t => Number(t.marketEntrySlMultiplier || 1) > 1).map(t => Number(t.marketEntrySlMultiplier || 1))), 4),
      makerEntries: results.filter(t => t.entryFeeType === 'maker').length,
      takerEntries: results.filter(t => t.entryFeeType === 'taker').length,
      tpMakerCount,
      tpTakerCount,
      tpFallbackCount,
      sameCandleTpSlCount,
      sameCandleResolvedTP,
      sameCandleResolvedSL,
      theoreticalSameCandleTpSlCount,
      sameCandleRule: cfg.sameCandleRule,
      gtxRejectTowardTP,
      gtxPassiveMissTowardTP,
      gtxRejectedTowardSL,
      gtxAcceptedNearEntry,
      gtxRejectTakerFallbackEntries,
      makerAttemptMarketFallbackEntries,
      gtxRejectTowardTPByEngine,
      gtxPassiveMissTowardTPByEngine,
      gtxRejectedTowardSLByEngine,
    },
    actualConfig: cfg,
  };
}
