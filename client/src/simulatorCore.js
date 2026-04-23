import { runEngineB } from './engines/engineB.js';
import { runEngineC } from './engines/engineC.js';
import { runEngineD } from './engines/engineD.js';
import { runEngineE } from './engines/engineE.js';
import { runEngineF } from './engines/engineF.js';

const ENGINE_RUNNERS = { B: runEngineB, C: runEngineC, D: runEngineD, E: runEngineE, F: runEngineF };
const CANDLE_MS_5M = 5 * 60 * 1000;

export const DEFAULT_CONFIG = {
  symbol: 'ETHUSDT',
  interval: '5m',
  startingBalance: 10000,
  riskMode: 'fixed', // fixed | pct
  fixedRisk: 200,
  riskPct: 2,
  riskCap: 1000,
  compounding: 'per_trade', // none | per_trade | daily | monthly | quarterly
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
};

function deepClone(x) { return JSON.parse(JSON.stringify(x)); }
function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function sideSign(side) { return side === 'LONG' ? 1 : -1; }
function quarterKey(ts) { const d=new Date(ts); return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth()/3)+1}`; }
function monthKey(ts) { const d=new Date(ts); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`; }
function dayKey(ts) { return new Date(ts).toISOString().slice(0,10); }

function maybeRefreshRisk(balanceState, cfg, ts) {
  const mode = cfg.compounding;
  if (mode === 'per_trade') {
    balanceState.riskBaseBalance = balanceState.balance;
    return;
  }
  if (mode === 'none') return;
  const key = mode === 'daily' ? dayKey(ts) : mode === 'monthly' ? monthKey(ts) : quarterKey(ts);
  if (balanceState.compoundKey !== key) {
    balanceState.compoundKey = key;
    balanceState.riskBaseBalance = balanceState.balance;
  }
}

function getRiskDollar(balanceState, cfg) {
  if (cfg.riskMode === 'pct') {
    const base = Math.max(0, balanceState.riskBaseBalance ?? balanceState.balance);
    return Math.min(base * (cfg.riskPct / 100), cfg.riskCap || Infinity);
  }
  return Math.min(cfg.fixedRisk, cfg.riskCap || Infinity);
}

function slippageFor(type, cfg, candle) {
  const base = cfg.slippageBasePts?.[type] ?? 0;
  const range = Math.abs((candle?.high ?? 0) - (candle?.low ?? 0));
  const presetMult = cfg.slippagePreset === 'baseline' ? 0.6 : cfg.slippagePreset === 'stress' ? 1.8 : 1;
  const volatilityBump = range > 15 ? 1.5 : range > 8 ? 1.2 : 1;
  return +(base * presetMult * volatilityBump).toFixed(4);
}

function validateLevels(side, entry, sl, tp) {
  if (![entry, sl, tp].every(Number.isFinite)) return false;
  if (side === 'LONG') return sl < entry && tp > entry;
  if (side === 'SHORT') return sl > entry && tp < entry;
  return false;
}

function buildSignal(diag, engineId, candle) {
  if (!diag?.fired || !diag.signal) return null;
  const s = diag.signal;
  const side = s.signal;
  const entry = Number(s.entry_price);
  const sl = Number(s.stop_loss);
  const tp = Number(s.take_profit);
  if (!validateLevels(side, entry, sl, tp)) return null;
  const slDistance = Math.abs(entry - sl);
  return {
    signal_id: `${engineId}_${candle.closeTime}_${Math.random().toString(36).slice(2,7)}`,
    engine: engineId,
    status: ['D','E','F'].includes(engineId) ? 'pending' : 'active',
    pending_confirmed: 0,
    outcome: null,
    signal_timestamp: candle.closeTime,
    settle_timestamp: null,
    side,
    entry_price: entry,
    stop_loss: sl,
    take_profit: tp,
    sl_distance: slDistance,
    confidence: Number(s.confidence ?? diag.confidence ?? 0),
    setup_type: s.setup_type || engineId,
    timeout_candles: 288,
    cancel_candle: null,
  };
}

function settleSignal(signal, outcome, currentTime, candlesElapsed) {
  const grossR = outcome === 'WIN' ? Math.abs(signal.take_profit - signal.entry_price) / signal.sl_distance
    : outcome === 'LOSS' ? -1 : 0;
  return {
    ...signal,
    status: 'settled',
    outcome,
    pnl_r: grossR,
    settle_candles: candlesElapsed,
    settle_timestamp: currentTime,
    settlement_timestamp: currentTime,
  };
}

function buildResultRow(sig, outcome, riskUsd, balanceBefore, balanceAfter, cfg, settleCandle) {
  const side = sig.side;
  const qty = sig.sl_distance > 0 ? riskUsd / sig.sl_distance : 0;
  const isEntryMaker = cfg.entryMode === 'maker_gtx';
  const entrySlip = isEntryMaker ? 0 : slippageFor('entry', cfg, settleCandle);
  const adjustedEntry = side === 'LONG' ? sig.entry_price + entrySlip : sig.entry_price - entrySlip;

  let exitPrice = adjustedEntry;
  let exitMaker = false;
  let slippagePts = 0;

  if (outcome === 'WIN') {
    const baseTp = sig.take_profit;
    if (cfg.tpMode === 'limit') {
      exitPrice = baseTp;
      exitMaker = true;
    } else {
      slippagePts = slippageFor('tp', cfg, settleCandle);
      exitPrice = side === 'LONG' ? baseTp - slippagePts : baseTp + slippagePts;
      exitMaker = false;
    }
  } else if (outcome === 'LOSS') {
    const baseSl = sig.stop_loss;
    slippagePts = slippageFor('sl', cfg, settleCandle);
    exitPrice = side === 'LONG' ? baseSl - slippagePts : baseSl + slippagePts;
    exitMaker = false;
  } else {
    exitPrice = settleCandle.close;
    exitMaker = false;
  }

  const qtyNotionalEntry = Math.abs(adjustedEntry * qty);
  const qtyNotionalExit = Math.abs(exitPrice * qty);
  const entryFeeUsd = qtyNotionalEntry * ((isEntryMaker ? cfg.feeMakerBps : cfg.feeTakerBps) / 10000);
  const exitFeeUsd = qtyNotionalExit * (((outcome === 'WIN' && exitMaker) ? cfg.feeMakerBps : cfg.feeTakerBps) / 10000);
  const grossPnlUsd = side === 'LONG' ? (exitPrice - adjustedEntry) * qty : (adjustedEntry - exitPrice) * qty;
  const pnlUsd = grossPnlUsd - entryFeeUsd - exitFeeUsd;
  const pnlR = riskUsd > 0 ? pnlUsd / riskUsd : 0;

  return {
    engine: sig.engine,
    status: outcome === 'WIN' ? 'TP' : outcome === 'LOSS' ? 'SL' : outcome,
    side,
    signalTime: sig.signal_timestamp,
    entryTime: sig.signal_timestamp,
    exitTime: sig.settle_timestamp,
    entry: adjustedEntry,
    exitPrice,
    sl: sig.stop_loss,
    tp: sig.take_profit,
    qty,
    entryMaker: isEntryMaker,
    tpMode: cfg.tpMode,
    entryFeeUsd,
    exitFeeUsd,
    pnlUsd,
    pnlR,
    slippagePts,
    balanceBefore,
    balanceAfter,
    settleCandles: sig.settle_candles,
  };
}

export function simulateScenario(candles, config) {
  const cfg = deepClone({ ...DEFAULT_CONFIG, ...config, engines: { ...DEFAULT_CONFIG.engines, ...(config.engines || {}) } });
  const enabledEngineIds = Object.entries(cfg.engines).filter(([,v]) => v).map(([k]) => k);
  if (!enabledEngineIds.length) {
    return { summary: { trades:0,wins:0,losses:0,timeouts:0,winRate:0,netR:0,avgR:0,startBalance:cfg.startingBalance,endBalance:cfg.startingBalance,totalFeeUsd:0,avgSLSlip:0,avgTPSlip:0 }, engineStats: {}, results: [], lifecycle: {pending:0,cancelled:0,active:0,settled:0} };
  }

  const engineStats = Object.fromEntries(enabledEngineIds.map(id => [id, { signals: 0, filled: 0, gtxRejected: 0, timeoutMissed: 0, wins: 0, losses: 0, timeouts: 0, netR: 0, cancelled: 0 }]));
  const balanceState = { balance: cfg.startingBalance, riskBaseBalance: cfg.startingBalance, compoundKey: null };
  const signals = [];
  const results = [];

  for (let i = 80; i < candles.length; i++) {
    const closed = candles.slice(0, i + 1);
    const lastClosed = closed[closed.length - 1];

    // STEP 1: pending window confirmation/cancel exactly like V5
    for (let idx = 0; idx < signals.length; idx++) {
      const sig = signals[idx];
      if (sig.status !== 'pending') continue;
      const pendingElapsed = Math.floor((lastClosed.closeTime - sig.signal_timestamp) / CANDLE_MS_5M);
      const slHit = sig.side === 'LONG' ? lastClosed.low <= sig.stop_loss : lastClosed.high >= sig.stop_loss;
      if (slHit) {
        signals[idx] = { ...sig, status: 'cancelled', outcome: 'CANCELLED', cancel_candle: pendingElapsed, settle_timestamp: lastClosed.closeTime };
        engineStats[sig.engine].cancelled += 1;
        continue;
      }
      if (pendingElapsed >= 2) {
        signals[idx] = { ...sig, status: 'active', pending_confirmed: 1 };
        engineStats[sig.engine].filled += 1;
      }
    }

    // STEP 2: settle active signals exactly like V5
    for (let idx = 0; idx < signals.length; idx++) {
      const sig = signals[idx];
      if (sig.status !== 'active') continue;
      const elapsed = Math.floor((lastClosed.closeTime - sig.signal_timestamp) / CANDLE_MS_5M);
      let outcome = null;
      if (sig.side === 'LONG') {
        if (lastClosed.high >= sig.take_profit) outcome = 'WIN';
        else if (lastClosed.low <= sig.stop_loss) outcome = 'LOSS';
        else if (elapsed >= sig.timeout_candles) outcome = 'TIMEOUT';
      } else {
        if (lastClosed.low <= sig.take_profit) outcome = 'WIN';
        else if (lastClosed.high >= sig.stop_loss) outcome = 'LOSS';
        else if (elapsed >= sig.timeout_candles) outcome = 'TIMEOUT';
      }
      if (!outcome) continue;

      const settled = settleSignal(sig, outcome, lastClosed.closeTime, elapsed);
      signals[idx] = settled;

      maybeRefreshRisk(balanceState, cfg, settled.signal_timestamp);
      const riskUsd = getRiskDollar(balanceState, cfg);
      const balanceBefore = balanceState.balance;
      const row = buildResultRow(settled, outcome, riskUsd, balanceBefore, balanceBefore, cfg, lastClosed);
      balanceState.balance = Math.max(0, balanceState.balance + row.pnlUsd);
      if (cfg.compounding === 'per_trade') balanceState.riskBaseBalance = balanceState.balance;
      row.balanceAfter = balanceState.balance;
      results.push(row);

      const es = engineStats[sig.engine];
      if (outcome === 'WIN') es.wins += 1;
      else if (outcome === 'LOSS') es.losses += 1;
      else es.timeouts += 1;
      es.netR += row.pnlR;
    }

    // STEP 3: run engines and create signals with per-engine active dedup exactly like V5
    for (const engineId of enabledEngineIds) {
      const diag = ENGINE_RUNNERS[engineId]?.(closed);
      const signal = buildSignal(diag, engineId, lastClosed);
      if (!signal) continue;

      const activeSameEngine = signals.find(s => s.engine === engineId && (s.status === 'pending' || s.status === 'active'));
      if (activeSameEngine) continue;

      signals.push(signal);
      engineStats[engineId].signals += 1;
      if (signal.status === 'active') engineStats[engineId].filled += 1;
    }
  }

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
      startBalance: cfg.startingBalance,
      endBalance: balanceState.balance,
      totalFeeUsd,
      avgSLSlip,
      avgTPSlip,
    },
    engineStats,
    results,
    lifecycle: {
      pending: signals.filter(s => s.status === 'pending').length,
      cancelled: signals.filter(s => s.status === 'cancelled').length,
      active: signals.filter(s => s.status === 'active').length,
      settled: signals.filter(s => s.status === 'settled').length,
    }
  };
}
