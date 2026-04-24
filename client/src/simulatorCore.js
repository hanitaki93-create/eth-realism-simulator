
import { runEngineB } from './engines/engineB.js';
import { runEngineC } from './engines/engineC.js';
import { runEngineD } from './engines/engineD.js';
import { runEngineE } from './engines/engineE.js';
import { runEngineF } from './engines/engineF.js';

export const ENGINE_RUNNERS = { B: runEngineB, C: runEngineC, D: runEngineD, E: runEngineE, F: runEngineF };

export const EXECUTION_MODELS = {
  A: 1.00, // optimistic
  B: 0.88, // neutral / live-anchor provisional
  C: 0.72, // harsh but still plausible
};

export const DEFAULT_CONFIG = {
  symbol: 'ETHUSDT',
  interval: '5m',
  startingBalance: 10000,
  selectedYears: [],
  riskMode: 'fixed', // fixed | pct
  fixedRisk: 200,
  riskPct: 2,
  riskCap: 1000,
  compounding: 'per_trade', // none | per_trade | daily | monthly | quarterly
  tpRMultiple: 2,
  slMultiplier: 1,
  minSlFloor: 0,
  entryMode: 'maker_gtx', // maker_gtx | taker | maker_taker_fallback
  executionModel: 'B',    // A | B | C, used for maker fill probability
  fillProbOverride: null, // optional numeric override
  entryOffset: 0,
  slippageModel: 'dynamic', // fixed | dynamic | stress
  takerFallbackDelayCandles: 1,
  entryTimeoutCandles: 2,
  makerEntryRejectRate: 0,          // ignored in core two-pass model; kept for UI compatibility
  makerEntryMissAfterTouchRate: 0,  // ignored in core two-pass model; kept for UI compatibility
  tpMode: 'market', // market | limit
  tpFailRate: 0.005,
  feeMakerBps: 2,
  feeTakerBps: 5,
  slippagePreset: 'realistic', // baseline | realistic | stress
  slippageBasePts: { entry: 0, tp: 0.15, sl: 0.26 },
  maxHoldCandles: 288,
  oneWayMode: true,   // not used here; lifecycle is per-engine
  allowStacking: false,
  engines: { B: false, C: false, D: true, E: true, F: false },
  defenseMode: { B: false, C: false, D: false, E: false, F: false },
  regimeDetector: { B: false, C: false, D: false, E: false, F: false },
};

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function finiteNum(x, fallback = 0) { return Number.isFinite(x) ? x : fallback; }
function sideSign(side) { return side === 'LONG' ? 1 : -1; }
function quarterKey(ts) { const d = new Date(ts); return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`; }
function monthKey(ts) { const d = new Date(ts); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }

function hashUnit(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000000) / 1000000;
}

function resolveFillProbability(cfg) {
  if (cfg.fillProbOverride != null && Number.isFinite(Number(cfg.fillProbOverride))) {
    return clamp(Number(cfg.fillProbOverride), 0, 1);
  }
  return EXECUTION_MODELS[cfg.executionModel] ?? EXECUTION_MODELS.B;
}

function getRiskDollar(balance, cfg) {
  const raw = cfg.riskMode === 'pct' ? balance * (cfg.riskPct / 100) : cfg.fixedRisk;
  const cap = cfg.riskCap || raw;
  return Math.max(0, Math.min(raw, cap));
}

function applyCompounding(balanceState, pnlUsd, cfg, ts) {
  const d = new Date(ts);
  const bucket = cfg.compounding === 'daily' ? d.toISOString().slice(0, 10)
    : cfg.compounding === 'monthly' ? monthKey(ts)
    : cfg.compounding === 'quarterly' ? quarterKey(ts)
    : null;

  if (cfg.compounding === 'none') return;
  if (cfg.compounding === 'per_trade') {
    balanceState.balance += pnlUsd;
    return;
  }
  if (bucket && balanceState.pendingBucket !== bucket) {
    if (balanceState.pendingPnl !== 0) balanceState.balance += balanceState.pendingPnl;
    balanceState.pendingPnl = 0;
    balanceState.pendingBucket = bucket;
  }
  balanceState.pendingPnl += pnlUsd;
}

function finalizeCompounding(balanceState) {
  if (balanceState.pendingPnl) balanceState.balance += balanceState.pendingPnl;
}


function slippageFor(type, cfg, candle) {
  const range = Math.abs((candle?.high ?? 0) - (candle?.low ?? 0));
  const body = Math.abs((candle?.close ?? 0) - (candle?.open ?? 0));
  const rangePct = candle?.open ? range / candle.open : 0;
  const bodyPct = candle?.open ? body / candle.open : 0;

  if (cfg.slippageModel === 'fixed') {
    const base = Number(cfg.slippageBasePts?.[type] ?? 0);
    const presetMult = cfg.slippagePreset === 'baseline' ? 0.6 : cfg.slippagePreset === 'stress' ? 1.8 : 1;
    return +(base * presetMult).toFixed(4);
  }

  const normalBase = type === 'entry' ? 0.08 : type === 'tp' ? 0.15 : 0.26;
  let slip = normalBase;

  if (rangePct > 0.012) slip += range * 0.035;
  else if (rangePct > 0.006) slip += range * 0.020;
  else if (rangePct > 0.003) slip += range * 0.010;

  if (bodyPct > 0.006) slip += range * 0.010;
  if (type === 'sl') slip *= 1.25;
  if (type === 'tp') slip *= 0.85;
  if (cfg.slippageModel === 'stress' || cfg.slippagePreset === 'stress') slip *= 1.6;
  if (cfg.slippagePreset === 'baseline') slip *= 0.65;

  return +clamp(slip, 0, type === 'sl' ? 5 : 3).toFixed(4);
}


function feeUsd(notional, bps) {
  return Math.abs(notional) * (bps / 10000);
}

function buildSignal(diag, engineId, candle, cfg, signalIdx) {
  if (!diag?.fired || !diag.signal) return null;
  const s = diag.signal;
  const side = s.signal;
  const rawEntry = Number(s.entry_price);
  const rawSl = Number(s.stop_loss);

  const slDistRaw = Math.abs(rawEntry - rawSl) * (cfg.slMultiplier || 1);
  const slDistance = Math.max(slDistRaw, cfg.minSlFloor || 0.0001);
  const entry = rawEntry + (side === 'LONG' ? cfg.entryOffset : -cfg.entryOffset);
  const sl = side === 'LONG' ? entry - slDistance : entry + slDistance;
  const tp = side === 'LONG' ? entry + slDistance * cfg.tpRMultiple : entry - slDistance * cfg.tpRMultiple;

  return {
    id: `${engineId}-${signalIdx}-${String(candle.closeTime)}`,
    engine: engineId,
    side,
    signalTime: candle.closeTime,
    signalIdx,
    entry,
    sl,
    tp,
    setupType: s.setup_type || engineId,
    confidence: Number(s.confidence ?? diag.confidence ?? 0),
    slDistance,
    state: 'pending', // pending | active | cancelled | settled
    pendingUntilIdx: signalIdx + (cfg.entryTimeoutCandles || 2),
    activatedAtIdx: null,
    settledAtIdx: null,
    cancelReason: null,
    outcome: null, // TP | SL | TIMEOUT
    outcomeCandle: null,
    expectedPnlR: null,
  };
}

function hasSameEngineLiveSignal(ledger, engineId) {
  return ledger.some(s => s.engine === engineId && (s.state === 'pending' || s.state === 'active'));
}

function didHitSL(signal, candle) {
  return signal.side === 'LONG' ? candle.low <= signal.sl : candle.high >= signal.sl;
}

function didHitTP(signal, candle) {
  return signal.side === 'LONG' ? candle.high >= signal.tp : candle.low <= signal.tp;
}

function resolveExitFromCandle(signal, candle) {
  const hitSL = didHitSL(signal, candle);
  const hitTP = didHitTP(signal, candle);

  if (!hitSL && !hitTP) return null;
  if (hitSL && !hitTP) return 'SL';
  if (hitTP && !hitSL) return 'TP';

  const distToTP = Math.abs(candle.open - signal.tp);
  const distToSL = Math.abs(candle.open - signal.sl);
  return distToTP <= distToSL ? 'TP' : 'SL';
}

function updatePendingSignal(signal, candle, idx) {
  if (signal.state !== 'pending') return;
  if (idx <= signal.signalIdx) return;

  if (didHitSL(signal, candle)) {
    signal.state = 'cancelled';
    signal.cancelReason = 'SL_DURING_PENDING';
    signal.settledAtIdx = idx;
    return;
  }

  if (idx >= signal.pendingUntilIdx) {
    signal.state = 'active';
    signal.activatedAtIdx = idx;
  }
}

function updateActiveSignal(signal, candle, idx, cfg) {
  if (signal.state !== 'active') return;
  if (idx < signal.activatedAtIdx) return;

  const exit = resolveExitFromCandle(signal, candle);
  if (exit) {
    signal.state = 'settled';
    signal.outcome = exit;
    signal.outcomeCandle = candle;
    signal.settledAtIdx = idx;
    signal.expectedPnlR = exit === 'TP' ? cfg.tpRMultiple : -1;
    return;
  }

  if (idx >= signal.activatedAtIdx + cfg.maxHoldCandles) {
    signal.state = 'settled';
    signal.outcome = 'TIMEOUT';
    signal.outcomeCandle = candle;
    signal.settledAtIdx = idx;
    const grossPnl = sideSign(signal.side) * (candle.close - signal.entry);
    signal.expectedPnlR = grossPnl / signal.slDistance;
  }
}

function collectSignalLedger(candles, cfg, enabledEngineIds) {
  const ledger = [];
  const engineStats = Object.fromEntries(
    enabledEngineIds.map(id => [id, {
      raw: 0,
      blocked: 0,
      pending: 0,
      cancelled: 0,
      activated: 0,
      gtxRejected: 0,
      missed: 0,
      settled: 0,
      wins: 0,
      losses: 0,
      timeouts: 0,
      netR: 0,
      signals: 0,
      filled: 0,
      timeoutMissed: 0,
      missedWinners: 0,
      missedLosers: 0,
      makerFilled: 0,
      takerFilled: 0,
      fallbackUsed: 0,
    }])
  );

  for (let i = 80; i < candles.length; i++) {
    const candle = candles[i];

    // 1) progress existing states first
    for (const signal of ledger) {
      const prevState = signal.state;
      updatePendingSignal(signal, candle, i);
      if (prevState === 'pending' && signal.state === 'cancelled') {
        engineStats[signal.engine].cancelled += 1;
      } else if (prevState === 'pending' && signal.state === 'active') {
        engineStats[signal.engine].activated += 1;
      }

      const beforeActive = signal.state;
      updateActiveSignal(signal, candle, i, cfg);
      if (beforeActive === 'active' && signal.state === 'settled') {
        engineStats[signal.engine].settled += 1;
      }
    }

    // 2) run engines on closed-candle slice
    const slice = candles.slice(0, i + 1);
    for (const engineId of enabledEngineIds) {
      const diag = ENGINE_RUNNERS[engineId]?.(slice);
      if (diag?.fired) engineStats[engineId].raw += 1;

      const signal = buildSignal(diag, engineId, candle, cfg, i);
      if (!signal) continue;

      if (hasSameEngineLiveSignal(ledger, engineId)) {
        engineStats[engineId].blocked += 1;
        continue;
      }

      ledger.push(signal);
      engineStats[engineId].pending += 1;
      engineStats[engineId].signals += 1;
    }
  }

  // Final sweep for any still-active signals that can timeout on remaining candles
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    for (const signal of ledger) {
      if (signal.state === 'active') {
        const before = signal.state;
        updateActiveSignal(signal, candle, i, cfg);
        if (before === 'active' && signal.state === 'settled') {
          engineStats[signal.engine].settled += 1;
        }
      }
    }
  }

  return { ledger, engineStats };
}


function buildTradeFromSettledSignal(signal, candles, cfg, riskUsd, execution) {
  const qty = riskUsd / signal.slDistance;
  let entry = signal.entry;
  const entryCandle = candles[signal.activatedAtIdx] || candles[signal.signalIdx] || signal.outcomeCandle;
  const entryIsMaker = execution.entryType === 'maker';
  const entrySlippagePts = entryIsMaker ? 0 : slippageFor('entry', cfg, entryCandle);
  if (!entryIsMaker) {
    entry = signal.side === 'LONG' ? signal.entry + entrySlippagePts : signal.entry - entrySlippagePts;
  }

  const entryNotional = Math.abs(entry * qty);

  // Exits are always taker. TP maker/fallback was intentionally removed after live Binance constraints.
  let exitPrice = signal.outcome === 'TP' ? signal.tp : signal.outcome === 'SL'
    ? signal.sl
    : Number(signal.outcomeCandle?.close ?? entry);

  let slippagePts = 0;
  if (signal.outcome === 'TP') {
    slippagePts = slippageFor('tp', cfg, signal.outcomeCandle);
    exitPrice = signal.side === 'LONG' ? signal.tp - slippagePts : signal.tp + slippagePts;
  } else if (signal.outcome === 'SL') {
    slippagePts = slippageFor('sl', cfg, signal.outcomeCandle);
    exitPrice = signal.side === 'LONG' ? signal.sl - slippagePts : signal.sl + slippagePts;
  }

  const entryFeeUsd = feeUsd(entryNotional, entryIsMaker ? cfg.feeMakerBps : cfg.feeTakerBps);
  const exitNotional = Math.abs(exitPrice * qty);
  const exitFeeUsd = feeUsd(exitNotional, cfg.feeTakerBps);

  const grossPnl = sideSign(signal.side) * (exitPrice - entry) * qty;
  const pnlUsd = grossPnl - entryFeeUsd - exitFeeUsd;
  const pnlR = pnlUsd / riskUsd;

  return {
    engine: signal.engine,
    status: signal.outcome,
    signalTime: signal.signalTime,
    entryTime: entryCandle?.openTime ?? signal.signalTime,
    exitTime: signal.outcomeCandle?.closeTime ?? signal.signalTime,
    side: signal.side,
    entry,
    intendedEntry: signal.entry,
    sl: signal.sl,
    tp: signal.tp,
    exitPrice,
    qty,
    entryMaker: entryIsMaker,
    entryType: execution.entryType,
    fallbackUsed: execution.fallbackUsed,
    grossPnl,
    pnlUsd,
    pnlR,
    entryFeeUsd,
    exitFeeUsd,
    entryNotional,
    exitNotional,
    turnoverUsd: entryNotional + exitNotional,
    entrySlippagePts,
    slippagePts,
    expectedPnlR: finiteNum(signal.expectedPnlR, 0),
  };
}

function decideEntryExecution(signal, cfg) {
  const fillProb = resolveFillProbability(cfg);
  const u = hashUnit(`${cfg.executionModel}|${cfg.entryMode}|${signal.engine}|${signal.signalTime}|${signal.side}|${signal.signalIdx}`);

  if (cfg.entryMode === 'taker') {
    return { filled: true, entryType: 'taker', fallbackUsed: false, missed: false, fillProb: 1 };
  }

  if (cfg.entryMode === 'maker_taker_fallback') {
    if (u <= fillProb) return { filled: true, entryType: 'maker', fallbackUsed: false, missed: false, fillProb };
    return { filled: true, entryType: 'taker', fallbackUsed: true, missed: false, fillProb };
  }

  if (u <= fillProb) return { filled: true, entryType: 'maker', fallbackUsed: false, missed: false, fillProb };
  return { filled: false, entryType: 'none', fallbackUsed: false, missed: true, fillProb };
}


function runExecutionOverlay(ledger, candles, cfg, engineStatsBase) {
  const stats = deepClone(engineStatsBase);
  const settledSignals = ledger.filter(s => s.state === 'settled');
  const fillProb = resolveFillProbability(cfg);
  const results = [];
  const missedSignals = [];
  const balanceState = {
    balance: cfg.startingBalance || 10000,
    pendingPnl: 0,
    pendingBucket: null,
    maxRiskUsed: 0,
  };

  for (const signal of settledSignals.sort((a, b) => a.signalIdx - b.signalIdx)) {
    const execution = decideEntryExecution(signal, cfg);

    if (!execution.filled) {
      missedSignals.push(signal);
      stats[signal.engine].missed += 1;
      if (finiteNum(signal.expectedPnlR, 0) > 0) stats[signal.engine].missedWinners += 1;
      else stats[signal.engine].missedLosers += 1;
      stats[signal.engine].timeoutMissed += 1;
      continue;
    }

    const riskUsd = getRiskDollar(balanceState.balance, cfg);
    balanceState.maxRiskUsed = Math.max(balanceState.maxRiskUsed, riskUsd);

    const trade = buildTradeFromSettledSignal(signal, candles, cfg, riskUsd, execution);
    results.push(trade);
    stats[signal.engine].filled += 1;
    if (trade.entryType === 'maker') stats[signal.engine].makerFilled += 1;
    if (trade.entryType === 'taker') stats[signal.engine].takerFilled += 1;
    if (trade.fallbackUsed) stats[signal.engine].fallbackUsed += 1;

    if (trade.status === 'TP') stats[signal.engine].wins += 1;
    else if (trade.status === 'SL') stats[signal.engine].losses += 1;
    else stats[signal.engine].timeouts += 1;

    stats[signal.engine].netR += trade.pnlR;
    applyCompounding(balanceState, trade.pnlUsd, cfg, trade.exitTime);
  }

  finalizeCompounding(balanceState);

  return { results, missedSignals, engineStats: stats, balanceState, fillProb };
}

function summarize(signals, results, missedSignals, engineStats, balanceState, cfg, fillProb) {
  const closedTrades = results.filter(r => ['TP', 'SL', 'TIMEOUT'].includes(r.status));
  const wins = closedTrades.filter(r => r.status === 'TP').length;
  const losses = closedTrades.filter(r => r.status === 'SL').length;
  const timeouts = closedTrades.filter(r => r.status === 'TIMEOUT').length;
  const totalFeeUsd = closedTrades.reduce((s, r) => s + r.entryFeeUsd + r.exitFeeUsd, 0);
  const totalTurnover = closedTrades.reduce((s, r) => s + finiteNum(r.turnoverUsd, 0), 0);
  const avgFeePerTrade = closedTrades.length ? totalFeeUsd / closedTrades.length : 0;
  const avgTurnoverPerTrade = closedTrades.length ? totalTurnover / closedTrades.length : 0;
  const feeToTurnover = totalTurnover > 0 ? totalFeeUsd / totalTurnover : 0;
  const avgSLSlip = avg(closedTrades.filter(r => r.status === 'SL').map(r => r.slippagePts));
  const avgTPSlip = avg(closedTrades.filter(r => r.status === 'TP').map(r => r.slippagePts));
  const avgEntrySlip = avg(closedTrades.filter(r => !r.entryMaker).map(r => r.entrySlippagePts));
  const makerFilled = closedTrades.filter(r => r.entryType === 'maker').length;
  const takerFilled = closedTrades.filter(r => r.entryType === 'taker').length;
  const fallbackUsed = closedTrades.filter(r => r.fallbackUsed).length;
  const netR = closedTrades.reduce((s, r) => s + r.pnlR, 0);
  const avgR = closedTrades.length ? netR / closedTrades.length : 0;
  const pWinSignal = signals.length ? signals.filter(s => finiteNum(s.expectedPnlR, 0) > 0).length / signals.length : 0;
  const pWinFilled = closedTrades.length ? wins / closedTrades.length : 0;
  const biasRatio = pWinSignal > 0 ? pWinFilled / pWinSignal : 1;
  const missedWinners = missedSignals.filter(s => finiteNum(s.expectedPnlR, 0) > 0).length;
  const missedLosers = missedSignals.filter(s => finiteNum(s.expectedPnlR, 0) <= 0).length;

  return {
    trades: closedTrades.length,
    totalSignals: signals.length,
    filledTrades: closedTrades.length,
    missedTrades: missedSignals.length,
    wins,
    losses,
    timeouts,
    winRate: (wins + losses) ? wins / (wins + losses) : 0,
    pWinSignal,
    pWinFilled,
    biasRatio,
    missedWinners,
    missedLosers,
    netR,
    avgR,
    startBalance: cfg.startingBalance || 10000,
    endBalance: balanceState.balance,
    totalFeeUsd,
    totalTurnover,
    feeToTurnover,
    avgFeePerTrade,
    avgTurnoverPerTrade,
    avgSLSlip,
    avgTPSlip,
    avgEntrySlip,
    makerFilled,
    takerFilled,
    fallbackUsed,
    entryMode: cfg.entryMode,
    executionModel: cfg.executionModel,
    fillProb,
    maxRiskUsed: balanceState.maxRiskUsed,
  };
}

export function simulateScenario(candles, config) {
  const cfg = deepClone({
    ...DEFAULT_CONFIG,
    ...config,
    engines: { ...DEFAULT_CONFIG.engines, ...(config?.engines || {}) }
  });

  const enabledEngineIds = Object.entries(cfg.engines).filter(([, v]) => v).map(([k]) => k);
  if (!enabledEngineIds.length) {
    return {
      summary: {
        trades: 0, wins: 0, losses: 0, timeouts: 0,
        winRate: 0, netR: 0, avgR: 0,
        startBalance: cfg.startingBalance || 10000,
        endBalance: cfg.startingBalance || 10000,
        totalFeeUsd: 0,
        totalTurnover: 0,
        feeToTurnover: 0,
        avgFeePerTrade: 0,
        avgTurnoverPerTrade: 0,
        avgSLSlip: 0,
        avgTPSlip: 0,
        totalSignals: 0,
        filledTrades: 0,
        missedTrades: 0,
        pWinSignal: 0,
        pWinFilled: 0,
        biasRatio: 1,
        missedWinners: 0,
        missedLosers: 0,
        executionModel: cfg.executionModel,
        fillProb: resolveFillProbability(cfg),
        maxRiskUsed: 0,
      },
      engineStats: {},
      results: [],
      signalLedger: [],
      missedSignals: [],
      actualConfig: cfg,
    };
  }

  const { ledger, engineStats: pass1Stats } = collectSignalLedger(candles, cfg, enabledEngineIds);
  const settledSignals = ledger.filter(s => s.state === 'settled');
  const { results, missedSignals, engineStats, balanceState, fillProb } = runExecutionOverlay(settledSignals, candles, cfg, pass1Stats);
  const summary = summarize(settledSignals, results, missedSignals, engineStats, balanceState, cfg, fillProb);

  return {
    summary,
    engineStats,
    results,
    signalLedger: ledger,
    missedSignals,
    actualConfig: cfg,
  };
}
