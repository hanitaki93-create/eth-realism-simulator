
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
  riskMode: 'fixed', // fixed | pct
  fixedRisk: 200,
  riskPct: 2,
  riskCap: 1000,
  compounding: 'per_trade', // none | per_trade | daily | monthly | quarterly
  entryMode: 'maker_gtx',
  executionModel: 'B', // A | B | C
  fillProbA: 1.0,
  fillProbB: 0.88,
  fillProbC: 0.72,
  feeMakerBps: 2,
  feeTakerBps: 5,
  slippagePreset: 'realistic', // baseline | realistic | stress
  slippageBasePts: { entry: 0, tp: 0.15, sl: 0.26 },
  maxHoldCandles: 288,
  entryTimeoutCandles: 2,
  engines: { B: false, C: false, D: true, E: true, F: false },
};

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function fmtNum(n, d = 2) { return Number.isFinite(n) ? +n.toFixed(d) : 0; }
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function sideSign(side) { return side === 'LONG' ? 1 : -1; }
function monthKey(ts) { const d = new Date(ts); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`; }
function quarterKey(ts) { const d = new Date(ts); return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth()/3)+1}`; }

function slippageFor(type, cfg, candle) {
  const base = cfg.slippageBasePts?.[type] ?? 0;
  const range = (candle?.high ?? 0) - (candle?.low ?? 0);
  const presetMult = cfg.slippagePreset === 'baseline' ? 0.6 : cfg.slippagePreset === 'stress' ? 1.8 : 1;
  const volatilityBump = range > 15 ? 1.5 : range > 8 ? 1.2 : 1;
  return +(base * presetMult * volatilityBump).toFixed(2);
}

function getRiskDollar(balance, cfg) {
  const raw = cfg.riskMode === 'pct' ? balance * (cfg.riskPct / 100) : cfg.fixedRisk;
  const capped = cfg.riskCap ? Math.min(raw, cfg.riskCap) : raw;
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
}

function buildSignal(diag, engineId, candle) {
  if (!diag?.fired || !diag.signal) return null;
  const s = diag.signal;
  const entry = Number(s.entry_price);
  const sl = Number(s.stop_loss);
  const tp = Number(s.take_profit);
  const slDistance = Math.abs(entry - sl);
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(tp) || slDistance <= 0) return null;
  return {
    engine: engineId,
    side: s.signal,
    signalTime: candle.closeTime,
    entry,
    sl,
    tp,
    setupType: s.setup_type || engineId,
    confidence: Number(s.confidence ?? diag.confidence ?? 0),
    slDistance
  };
}

function resolveSignalOutcome(signal, candles, activeFromIdx, cfg) {
  const side = signal.side;
  const maxIdx = Math.min(candles.length - 1, activeFromIdx + cfg.maxHoldCandles);
  for (let j = activeFromIdx; j <= maxIdx; j++) {
    const c = candles[j];
    const hitSL = side === 'LONG' ? c.low <= signal.sl : c.high >= signal.sl;
    const hitTP = side === 'LONG' ? c.high >= signal.tp : c.low <= signal.tp;
    if (!hitSL && !hitTP) continue;

    let status = hitTP && !hitSL ? 'TP' : hitSL && !hitTP ? 'SL' : 'BOTH';
    if (status === 'BOTH') {
      const distToTP = Math.abs(c.open - signal.tp);
      const distToSL = Math.abs(c.open - signal.sl);
      status = distToTP <= distToSL ? 'TP' : 'SL';
    }

    const grossR = status === 'TP' ? Math.abs(signal.tp - signal.entry) / signal.slDistance : -1;
    return {
      status,
      settleIdx: j,
      exitRefPrice: status === 'TP' ? signal.tp : signal.sl,
      expectedGrossR: fmtNum(grossR, 4)
    };
  }

  const last = candles[maxIdx];
  const move = side === 'LONG' ? (last.close - signal.entry) : (signal.entry - last.close);
  return {
    status: 'TIMEOUT',
    settleIdx: maxIdx,
    exitRefPrice: last.close,
    expectedGrossR: fmtNum(move / signal.slDistance, 4)
  };
}

function passOneBuildLedger(candles, cfg) {
  const enabledEngineIds = Object.entries(cfg.engines).filter(([, v]) => v).map(([k]) => k);
  const engineStats = Object.fromEntries(enabledEngineIds.map(id => [id, {
    raw: 0, blocked: 0, pending: 0, cancelled: 0, activated: 0, settled: 0,
    gtxRejected: 0, missed: 0, wins: 0, losses: 0, netR: 0
  }]));

  const pendingByEngine = {};
  const activeByEngine = {};
  const settledSignals = [];

  for (let i = 80; i < candles.length; i++) {
    const candle = candles[i];

    // update pending
    for (const engineId of enabledEngineIds) {
      const pending = pendingByEngine[engineId];
      if (!pending) continue;

      const hitSL = pending.side === 'LONG' ? candle.low <= pending.sl : candle.high >= pending.sl;
      if (hitSL) {
        pending.status = 'cancelled';
        pending.cancelIdx = i;
        engineStats[engineId].cancelled += 1;
        pendingByEngine[engineId] = null;
        continue;
      }

      if (i >= pending.activateIdx) {
        pending.status = 'active';
        pending.activeFromIdx = i;
        engineStats[engineId].activated += 1;
        activeByEngine[engineId] = pending;
        pendingByEngine[engineId] = null;
      }
    }

    // update active
    for (const engineId of enabledEngineIds) {
      const sig = activeByEngine[engineId];
      if (!sig) continue;
      const outcome = resolveSignalOutcome(sig, candles, i, cfg);
      if (!outcome || outcome.settleIdx !== i) continue;
      sig.status = 'settled';
      sig.settleIdx = i;
      sig.outcome = outcome.status;
      sig.exitRefPrice = outcome.exitRefPrice;
      sig.expectedGrossR = outcome.expectedGrossR;
      settledSignals.push(sig);
      engineStats[engineId].settled += 1;
      if (sig.expectedGrossR > 0) engineStats[engineId].wins += 1; else engineStats[engineId].losses += 1;
      engineStats[engineId].netR += sig.expectedGrossR;
      activeByEngine[engineId] = null;
    }

    // run engines at candle close
    const slice = candles.slice(0, i + 1);
    for (const engineId of enabledEngineIds) {
      const diag = ENGINE_RUNNERS[engineId]?.(slice);
      if (!diag?.fired) continue;
      engineStats[engineId].raw += 1;

      if (pendingByEngine[engineId] || activeByEngine[engineId]) {
        engineStats[engineId].blocked += 1;
        continue;
      }

      const signal = buildSignal(diag, engineId, candle);
      if (!signal) continue;

      signal.signalIdx = i;
      signal.status = 'pending';
      signal.activateIdx = i + Math.max(1, cfg.entryTimeoutCandles || 2);
      pendingByEngine[engineId] = signal;
      engineStats[engineId].pending += 1;
    }
  }

  return { signals: settledSignals, engineStats };
}

function getFillProbability(signal, candles, cfg) {
  const key = cfg.executionModel || 'B';
  const base = key === 'A' ? cfg.fillProbA : key === 'C' ? cfg.fillProbC : cfg.fillProbB;
  const touchWindow = candles.slice(signal.signalIdx + 1, Math.min(candles.length, signal.activateIdx + 1));
  let penetrationBonus = 0;

  for (const c of touchWindow) {
    if (!c) continue;
    if (signal.side === 'LONG') {
      if (c.low <= signal.entry) penetrationBonus = Math.max(penetrationBonus, (signal.entry - c.low) / signal.slDistance * 0.08);
    } else {
      if (c.high >= signal.entry) penetrationBonus = Math.max(penetrationBonus, (c.high - signal.entry) / signal.slDistance * 0.08);
    }
  }
  return clamp(base + penetrationBonus, 0, 1);
}

function entryFee(notional, isMaker, cfg) { return notional * ((isMaker ? cfg.feeMakerBps : cfg.feeTakerBps) / 10000); }
function exitFee(notional, isMaker, cfg) { return notional * ((isMaker ? cfg.feeMakerBps : cfg.feeTakerBps) / 10000); }

function passTwoExecution(signals, candles, cfg) {
  const balanceState = { balance: cfg.startingBalance, pendingPnl: 0, pendingBucket: null };
  const executed = [];
  const missed = [];
  let totalTurnover = 0;
  let maxRiskUsed = 0;
  const feeSamples = [];
  const turnoverSamples = [];

  // sort by settle time so compounding is chronological
  const ordered = [...signals].sort((a,b) => a.signalIdx - b.signalIdx);

  for (const sig of ordered) {
    const fillProb = cfg.entryMode === 'taker_market' ? 1 : getFillProbability(sig, candles, cfg);
    const filled = Math.random() <= fillProb;

    if (!filled) {
      missed.push(sig);
      continue;
    }

    const riskUsd = getRiskDollar(balanceState.balance, cfg);
    maxRiskUsed = Math.max(maxRiskUsed, riskUsd);
    const qty = riskUsd / sig.slDistance;
    const entryPrice = sig.entry + (cfg.entryMode === 'taker_market' ? (sig.side === 'LONG' ? slippageFor('entry', cfg, candles[sig.signalIdx+1] || candles[sig.signalIdx]) : -slippageFor('entry', cfg, candles[sig.signalIdx+1] || candles[sig.signalIdx])) : 0);

    const exitCandle = candles[sig.settleIdx] || candles[candles.length - 1];
    let exitPrice = sig.exitRefPrice;
    let exitMaker = false;
    let tpSlip = 0;
    let slSlip = 0;

    if (sig.outcome === 'TP') {
      if (cfg.tpMode === 'limit') {
        exitMaker = true;
      } else {
        tpSlip = slippageFor('tp', cfg, exitCandle);
        exitPrice = sig.side === 'LONG' ? sig.exitRefPrice - tpSlip : sig.exitRefPrice + tpSlip;
      }
    } else if (sig.outcome === 'SL') {
      slSlip = slippageFor('sl', cfg, exitCandle);
      exitPrice = sig.side === 'LONG' ? sig.exitRefPrice - slSlip : sig.exitRefPrice + slSlip;
    }

    const grossPnl = sig.side === 'LONG' ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
    const entryNotional = Math.abs(entryPrice * qty);
    const exitNotional = Math.abs(exitPrice * qty);
    const entryFeeUsd = entryFee(entryNotional, cfg.entryMode === 'maker_gtx', cfg);
    const exitFeeUsd = exitFee(exitNotional, exitMaker, cfg);
    const totalFeeUsd = entryFeeUsd + exitFeeUsd;
    const pnlUsd = grossPnl - totalFeeUsd;
    const pnlR = riskUsd > 0 ? pnlUsd / riskUsd : 0;

    const trade = {
      ...sig,
      status: sig.outcome,
      riskUsd,
      qty,
      entry: entryPrice,
      exit: exitPrice,
      grossPnl: fmtNum(grossPnl, 2),
      pnlUsd: fmtNum(pnlUsd, 2),
      pnlR: fmtNum(pnlR, 4),
      entryFeeUsd: fmtNum(entryFeeUsd, 2),
      exitFeeUsd: fmtNum(exitFeeUsd, 2),
      totalFeeUsd: fmtNum(totalFeeUsd, 2),
      entryNotional: fmtNum(entryNotional, 2),
      exitNotional: fmtNum(exitNotional, 2),
      tpSlip: fmtNum(tpSlip, 2),
      slSlip: fmtNum(slSlip, 2),
      fillProb: fmtNum(fillProb, 4)
    };

    executed.push(trade);
    totalTurnover += entryNotional + exitNotional;
    feeSamples.push(totalFeeUsd);
    turnoverSamples.push(entryNotional + exitNotional);
    applyCompounding(balanceState, trade, cfg, candles[sig.settleIdx]?.closeTime || sig.signalTime);
  }

  finalizeCompounding(balanceState);

  return {
    executed,
    missed,
    maxRiskUsed: fmtNum(maxRiskUsed, 2),
    totalTurnover: fmtNum(totalTurnover, 2),
    avgFeePerTrade: fmtNum(avg(feeSamples), 2),
    avgTurnoverPerTrade: fmtNum(avg(turnoverSamples), 2),
    endBalance: fmtNum(balanceState.balance, 2)
  };
}

export function simulateScenario(candles, config) {
  const cfg = deepClone({
    ...DEFAULT_CONFIG,
    ...config,
    engines: { ...DEFAULT_CONFIG.engines, ...(config.engines || {}) }
  });

  const startBalance = config.startingBalance ?? cfg.startingBalance ?? 10000;
  cfg.startingBalance = startBalance;

  const pass1 = passOneBuildLedger(candles, cfg);
  const pass2 = passTwoExecution(pass1.signals, candles, cfg);

  const enabledEngineIds = Object.entries(cfg.engines).filter(([, v]) => v).map(([k]) => k);
  const engineStats = Object.fromEntries(enabledEngineIds.map(id => [id, {
    ...pass1.engineStats[id],
    gtxRejected: 0,
    missed: 0,
    filled: 0
  }]));

  for (const trade of pass2.executed) {
    const s = engineStats[trade.engine];
    if (!s) continue;
    s.filled += 1;
    s.netR = fmtNum((s.netR || 0) + trade.pnlR, 4);
  }
  for (const sig of pass2.missed) {
    const s = engineStats[sig.engine];
    if (!s) continue;
    s.missed += 1;
  }

  const results = [...pass2.executed].sort((a,b) => a.settleIdx - b.settleIdx);
  const wins = results.filter(t => t.pnlR > 0).length;
  const losses = results.filter(t => t.pnlR <= 0).length;
  const totalFeeUsd = results.reduce((a, t) => a + t.totalFeeUsd, 0);
  const netR = results.reduce((a, t) => a + t.pnlR, 0);
  const avgSLSlip = avg(results.map(t => t.slSlip || 0));
  const avgTPSlip = avg(results.map(t => t.tpSlip || 0));

  const signalWinRate = pass1.signals.length ? pass1.signals.filter(s => s.expectedGrossR > 0).length / pass1.signals.length : 0;
  const filledWinRate = results.length ? wins / results.length : 0;
  const missedWinners = pass2.missed.filter(s => s.expectedGrossR > 0).length;
  const missedLosers = pass2.missed.filter(s => s.expectedGrossR <= 0).length;

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
      signalWinRate,
      filledWinRate,
      biasRatio: signalWinRate > 0 ? filledWinRate / signalWinRate : 0,
      missedWinners,
      missedLosers,
      netR: fmtNum(netR, 4),
      avgR: fmtNum(results.length ? netR / results.length : 0, 4),
      startBalance: fmtNum(startBalance, 2),
      endBalance: pass2.endBalance,
      totalFeeUsd: fmtNum(totalFeeUsd, 2),
      totalTurnover: pass2.totalTurnover,
      feeTurnoverPct: pass2.totalTurnover > 0 ? fmtNum((totalFeeUsd / pass2.totalTurnover) * 100, 4) : 0,
      avgFeePerTrade: pass2.avgFeePerTrade,
      avgTurnoverPerTrade: pass2.avgTurnoverPerTrade,
      avgSLSlip: fmtNum(avgSLSlip, 2),
      avgTPSlip: fmtNum(avgTPSlip, 2),
      maxRiskUsed: pass2.maxRiskUsed
    },
    actualConfig: cfg
  };
}
