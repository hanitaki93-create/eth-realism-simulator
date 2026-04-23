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
  riskMode: 'fixed',
  fixedRisk: 200,
  riskPct: 2,
  riskCap: 1000,
  compounding: 'per_trade',
  tpRMultiple: 2,
  slMultiplier: 1,
  minSlFloor: 0,
  entryMode: 'maker_gtx',
  entryOffset: 0,
  entryTimeoutCandles: 2,
  makerEntryRejectRate: 0,
  makerEntryMissAfterTouchRate: 0.02,
  tpMode: 'market',
  tpFailRate: 0.005,
  feeMakerBps: 2,
  feeTakerBps: 5,
  slippagePreset: 'realistic',
  slippageBasePts: { entry: 0, tp: 0.15, sl: 0.26 },
  maxHoldCandles: 288,
  engines: { B: false, C: false, D: true, E: true, F: false },
  selectedYears: [2022],
};

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
function quarterKey(ts) { const d = new Date(ts); return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth()/3)+1}`; }
function monthKey(ts) { const d = new Date(ts); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`; }
function avg(arr){ return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }

function getRiskDollar(balance, cfg) {
  const raw = cfg.riskMode === 'pct' ? balance * (cfg.riskPct / 100) : cfg.fixedRisk;
  return Math.min(raw, cfg.riskCap || raw);
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

function slippageFor(type, cfg, candle) {
  const base = cfg.slippageBasePts?.[type] ?? 0;
  const range = Math.abs(candle.high - candle.low);
  const presetMult = cfg.slippagePreset === 'baseline' ? 0.6 : cfg.slippagePreset === 'stress' ? 1.8 : 1;
  const volatilityBump = range > 15 ? 1.5 : range > 8 ? 1.2 : 1;
  return +(base * presetMult * volatilityBump).toFixed(2);
}

function validateLevels(side, entry, sl, tp) {
  if (!entry || !sl || !tp) return false;
  if (side === 'LONG')  return sl < entry && tp > entry && (tp - entry) > (entry - sl) * 0.5;
  if (side === 'SHORT') return sl > entry && tp < entry && (entry - tp) > (sl - entry) * 0.5;
  return false;
}

function buildSignal(diag, engineId, candle, cfg, riskUsd) {
  if (!diag?.fired || !diag.signal) return null;
  const s = diag.signal;
  const side = s.signal;
  const rawEntry = Number(s.entry_price);
  const rawSl = Number(s.stop_loss);
  const slDist = Math.abs(rawEntry - rawSl) * (cfg.slMultiplier || 1);
  const effectiveSlDist = Math.max(slDist, cfg.minSlFloor || 0.0001);
  const entry = rawEntry + (side === 'LONG' ? cfg.entryOffset : -cfg.entryOffset);
  const sl = side === 'LONG' ? entry - effectiveSlDist : entry + effectiveSlDist;
  const tp = side === 'LONG' ? entry + effectiveSlDist * cfg.tpRMultiple : entry - effectiveSlDist * cfg.tpRMultiple;

  if (!validateLevels(side, entry, sl, tp)) return null;

  return {
    engine: engineId,
    side,
    status: 'pending',
    pending_confirmed: 0,
    signalTime: candle.closeTime,
    entry,
    stopLoss: sl,
    takeProfit: tp,
    confidence: Number(s.confidence ?? diag.confidence ?? 0),
    slDistance: effectiveSlDist,
    setupType: s.setup_type || engineId,
    timeoutCandles: cfg.maxHoldCandles,
    riskUsd,
    entryMaker: cfg.entryMode === 'maker_gtx',
  };
}

function calcFeeR(entryPrice, slDistance, outcome, cfg) {
  if (!slDistance || slDistance <= 0 || !entryPrice) return 0.15;
  const maker = (cfg.feeMakerBps ?? 2) / 10000;
  const taker = (cfg.feeTakerBps ?? 5) / 10000;
  const exitRate = outcome === 'SL' ? taker : maker;
  return ((maker + exitRate) * entryPrice) / slDistance;
}

function buildSettlementRow(sig, outcome, candle, cfg) {
  const grossR = outcome === 'TP' ? cfg.tpRMultiple : outcome === 'SL' ? -1 : 0;
  const feeR = outcome === 'TIMEOUT' ? 0 : calcFeeR(sig.entry, sig.slDistance, outcome, cfg);
  const slipPts = outcome === 'SL'
    ? slippageFor('sl', cfg, candle)
    : outcome === 'TP' && cfg.tpMode === 'market'
      ? slippageFor('tp', cfg, candle)
      : 0;
  const slipR = sig.slDistance > 0 ? (slipPts / sig.slDistance) : 0;
  const pnlR = grossR - feeR - slipR;
  const pnlUsd = pnlR * sig.riskUsd;
  const exitPrice = outcome === 'TP'
    ? (sig.side === 'LONG' ? sig.takeProfit - slipPts : sig.takeProfit + slipPts)
    : outcome === 'SL'
      ? (sig.side === 'LONG' ? sig.stopLoss - slipPts : sig.stopLoss + slipPts)
      : candle.close;

  return {
    engine: sig.engine,
    status: outcome,
    signalTime: sig.signalTime,
    entryTime: sig.signalTime,
    exitTime: candle.closeTime,
    side: sig.side,
    entry: sig.entry,
    sl: sig.stopLoss,
    tp: sig.takeProfit,
    exitPrice,
    qty: sig.slDistance > 0 ? sig.riskUsd / sig.slDistance : null,
    entryMaker: sig.entryMaker,
    tpMode: cfg.tpMode,
    pnlUsd,
    pnlR,
    entryFeeUsd: Math.max(0, feeR * sig.riskUsd * 0.5),
    exitFeeUsd: Math.max(0, feeR * sig.riskUsd * 0.5),
    slippagePts: slipPts,
  };
}

function hasActiveSignal(signals, engineId) {
  return signals.some(sig => sig.engine === engineId && (sig.status === 'pending' || sig.status === 'active'));
}

export function simulateScenario(candles, config) {
  const cfg = deepClone({
    ...DEFAULT_CONFIG,
    ...config,
    slippageBasePts: { ...DEFAULT_CONFIG.slippageBasePts, ...(config.slippageBasePts || {}) },
    engines: { ...DEFAULT_CONFIG.engines, ...(config.engines || {}) }
  });

  const enabledEngineIds = Object.entries(cfg.engines).filter(([,v]) => v).map(([k]) => k);
  if (!enabledEngineIds.length) {
    return {
      summary: { trades: 0, wins: 0, losses: 0, timeouts: 0, winRate: 0, netR: 0, avgR: 0, startBalance: cfg.startingBalance, endBalance: cfg.startingBalance, totalFeeUsd: 0, avgSLSlip: 0, avgTPSlip: 0 },
      engineStats: {},
      results: [],
      error: 'No engines enabled'
    };
  }

  const results = [];
  const signals = [];
  const engineStats = Object.fromEntries(enabledEngineIds.map(id => [id, { signals: 0, filled: 0, gtxRejected: 0, timeoutMissed: 0, wins: 0, losses: 0, timeouts: 0, netR: 0 }]));
  const balanceState = { balance: Number(cfg.startingBalance || 10000), pendingPnl: 0, pendingBucket: null };
  const fiveMinMs = 5 * 60 * 1000;

  for (let i = 80; i < candles.length - 1; i++) {
    const closed = candles.slice(0, i + 1);
    const lastClosed = closed[closed.length - 1];

    // STEP 1: pending -> cancelled/active (V5 parity)
    for (const sig of signals) {
      if (sig.status !== 'pending') continue;
      const pendingElapsed = Math.floor((lastClosed.closeTime - sig.signalTime) / fiveMinMs);
      const slHit = sig.side === 'LONG'
        ? lastClosed.low <= sig.stopLoss
        : lastClosed.high >= sig.stopLoss;

      if (slHit) {
        sig.status = 'cancelled';
        sig.outcome = 'CANCELLED';
        sig.cancelCandle = pendingElapsed;
        continue;
      }

      if (pendingElapsed >= 2) {
        sig.status = 'active';
        sig.pending_confirmed = 1;
        engineStats[sig.engine].filled += 1;
      }
    }

    // STEP 2: settle active (V5 parity)
    for (const sig of signals) {
      if (sig.status !== 'active') continue;
      const elapsed = Math.floor((lastClosed.closeTime - sig.signalTime) / fiveMinMs);
      let outcome = null;
      if (sig.side === 'LONG') {
        if (lastClosed.high >= sig.takeProfit) outcome = 'TP';
        else if (lastClosed.low <= sig.stopLoss) outcome = 'SL';
        else if (elapsed >= sig.timeoutCandles) outcome = 'TIMEOUT';
      } else {
        if (lastClosed.low <= sig.takeProfit) outcome = 'TP';
        else if (lastClosed.high >= sig.stopLoss) outcome = 'SL';
        else if (elapsed >= sig.timeoutCandles) outcome = 'TIMEOUT';
      }
      if (!outcome) continue;

      sig.status = 'settled';
      sig.outcome = outcome;
      sig.settleTime = lastClosed.closeTime;
      const row = buildSettlementRow(sig, outcome, lastClosed, cfg);
      results.push(row);
      applyCompounding(balanceState, row, cfg, lastClosed.closeTime);
      const es = engineStats[sig.engine];
      if (outcome === 'TP') es.wins += 1;
      else if (outcome === 'SL') es.losses += 1;
      else es.timeouts += 1;
      es.netR += row.pnlR;
    }

    // STEP 3: scan engines and save new signals (V5-style dedup)
    for (const engineId of enabledEngineIds) {
      if (hasActiveSignal(signals, engineId)) continue;
      const diag = ENGINE_RUNNERS[engineId]?.(closed);
      if (!diag?.fired || !diag.signal) continue;
      const riskUsd = getRiskDollar(balanceState.balance, cfg);
      const signal = buildSignal(diag, engineId, lastClosed, cfg, riskUsd);
      if (!signal) continue;
      signals.push(signal);
      engineStats[engineId].signals += 1;
    }
  }

  finalizeCompounding(balanceState);
  const closedTrades = results.filter(r => ['TP','SL','TIMEOUT'].includes(r.status));
  const wins = closedTrades.filter(r => r.status === 'TP').length;
  const losses = closedTrades.filter(r => r.status === 'SL').length;
  const timeouts = closedTrades.filter(r => r.status === 'TIMEOUT').length;
  const netR = closedTrades.reduce((s, r) => s + r.pnlR, 0);
  const avgR = closedTrades.length ? netR / closedTrades.length : 0;
  const winRate = (wins + losses) ? wins / (wins + losses) : 0;
  const totalFeeUsd = closedTrades.reduce((s, r) => s + r.entryFeeUsd + r.exitFeeUsd, 0);
  const avgSLSlip = avg(closedTrades.filter(r => r.status === 'SL').map(r => r.slippagePts));
  const avgTPSlip = avg(closedTrades.filter(r => r.status === 'TP').map(r => r.slippagePts));

  return {
    summary: {
      trades: closedTrades.length,
      wins,
      losses,
      timeouts,
      winRate,
      netR,
      avgR,
      startBalance: Number(cfg.startingBalance || 10000),
      endBalance: balanceState.balance,
      totalFeeUsd,
      avgSLSlip,
      avgTPSlip,
      pendingCancelled: signals.filter(s => s.outcome === 'CANCELLED').length,
    },
    engineStats,
    results,
  };
}
