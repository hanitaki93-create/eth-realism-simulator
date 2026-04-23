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
  tpRMultiple: 2,
  slMultiplier: 1,
  minSlFloor: 0,
  entryMode: 'maker_gtx', // maker_gtx | taker_market
  entryOffset: 0,
  entryTimeoutCandles: 2,
  makerEntryRejectRate: 0, // deprecated for now; structural GTX modeling will replace this
  makerEntryMissAfterTouchRate: 0,
  tpMode: 'market', // market | limit
  tpFailRate: 0.005,
  feeMakerBps: 2,
  feeTakerBps: 5,
  slippagePreset: 'realistic', // baseline | realistic | stress
  slippageBasePts: { entry: 0, tp: 0.15, sl: 0.26 },
  maxHoldCandles: 288,
  engines: { B: false, C: false, D: true, E: true, F: false },
};

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
function avg(arr){ return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function quarterKey(ts) { const d = new Date(ts); return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth()/3)+1}`; }
function monthKey(ts) { const d = new Date(ts); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`; }
function dayKey(ts) { return new Date(ts).toISOString().slice(0,10); }
function sideSign(side) { return side === 'LONG' ? 1 : -1; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function round4(n) { return Math.round((n + Number.EPSILON) * 10000) / 10000; }

function getBucket(ts, freq) {
  if (freq === 'daily') return dayKey(ts);
  if (freq === 'monthly') return monthKey(ts);
  if (freq === 'quarterly') return quarterKey(ts);
  return null;
}

function effectiveBalanceForSizing(account, cfg) {
  if (cfg.compounding === 'none') return account.startingBalance;
  return account.balance;
}

function getRiskDollar(account, cfg) {
  const baseBalance = effectiveBalanceForSizing(account, cfg);
  const raw = cfg.riskMode === 'pct' ? baseBalance * (cfg.riskPct / 100) : cfg.fixedRisk;
  return Math.max(0, Math.min(raw, cfg.riskCap || raw));
}

function applyCompounding(account, pnlUsd, ts, cfg) {
  if (!Number.isFinite(pnlUsd)) return;
  if (cfg.compounding === 'per_trade' || cfg.compounding === 'none') {
    account.balance += pnlUsd;
    return;
  }
  const bucket = getBucket(ts, cfg.compounding);
  if (account.pendingBucket !== bucket) {
    if (account.pendingPnl !== 0) account.balance += account.pendingPnl;
    account.pendingPnl = 0;
    account.pendingBucket = bucket;
  }
  account.pendingPnl += pnlUsd;
}

function finalizeCompounding(account) {
  if (account.pendingPnl) account.balance += account.pendingPnl;
  account.pendingPnl = 0;
}

function feeUsd(notional, isMaker, cfg) {
  return Math.abs(notional) * ((isMaker ? cfg.feeMakerBps : cfg.feeTakerBps) / 10000);
}

function slippageFor(type, cfg, candle) {
  const base = cfg.slippageBasePts?.[type] ?? 0;
  const range = (candle?.high ?? 0) - (candle?.low ?? 0);
  const presetMult = cfg.slippagePreset === 'baseline' ? 0.6 : cfg.slippagePreset === 'stress' ? 1.8 : 1;
  const volatilityBump = range > 15 ? 1.5 : range > 8 ? 1.2 : 1;
  return round4(base * presetMult * volatilityBump);
}

function validateLevels(side, entry, sl, tp) {
  if (![entry, sl, tp].every(v => Number.isFinite(Number(v)))) return false;
  if (side === 'LONG') return sl < entry && tp > entry;
  if (side === 'SHORT') return sl > entry && tp < entry;
  return false;
}

function buildSignalRow(engineId, diag, candle, candleIdx, cfg) {
  if (!diag?.fired || !diag.signal) return null;
  const s = diag.signal;
  const entryBase = Number(s.entry_price);
  const slBase = Number(s.stop_loss);
  const slDistRaw = Math.abs(entryBase - slBase) * (cfg.slMultiplier || 1);
  const slDistance = Math.max(slDistRaw, cfg.minSlFloor || 0.0001);
  const entry = entryBase + (s.signal === 'LONG' ? cfg.entryOffset : -cfg.entryOffset);
  const sl = s.signal === 'LONG' ? entry - slDistance : entry + slDistance;
  const tpFromEngine = Number(s.take_profit);
  const tp = Number.isFinite(tpFromEngine)
    ? tpFromEngine
    : (s.signal === 'LONG' ? entry + slDistance * cfg.tpRMultiple : entry - slDistance * cfg.tpRMultiple);

  if (!validateLevels(s.signal, entry, sl, tp)) return null;

  return {
    signal_id: `${engineId}_${candle.closeTime}_${Math.random().toString(36).slice(2,7)}`,
    engine: engineId,
    side: s.signal,
    signal_timestamp: candle.closeTime,
    signal_idx: candleIdx,
    entry_price: entry,
    stop_loss: sl,
    take_profit: tp,
    confidence: Number(s.confidence ?? diag.confidence ?? 0),
    setup_type: s.setup_type || engineId,
    reason: s.reason || '',
    sl_distance: slDistance,
    status: ['D', 'E', 'F'].includes(engineId) ? 'pending' : 'active',
    outcome: null,
    pnl_r: null,
    settle_candles: null,
    settle_timestamp: null,
    timeout_candles: cfg.maxHoldCandles,
    pending_confirmed: 0,
    cancel_candle: null,
    fill_idx: null,
    fill_timestamp: null,
    qty: null,
    risk_usd: null,
    entry_price_actual: null,
    entry_fee_usd: 0,
    entry_maker: cfg.entryMode === 'maker_gtx',
    exit_fee_usd: 0,
    slippage_pts: 0,
    settlement_applied: 0,
  };
}

function settleSignal(signal, outcome, candle, candleIdx, cfg) {
  const elapsed = candleIdx - signal.signal_idx;
  let exitPrice = candle.close;
  let exitMaker = false;
  let slipPts = 0;

  if (outcome === 'WIN') {
    if (cfg.tpMode === 'limit') {
      exitPrice = signal.take_profit;
      exitMaker = true;
    } else {
      slipPts = slippageFor('tp', cfg, candle);
      exitPrice = signal.side === 'LONG' ? signal.take_profit - slipPts : signal.take_profit + slipPts;
    }
  } else if (outcome === 'LOSS') {
    slipPts = slippageFor('sl', cfg, candle);
    exitPrice = signal.side === 'LONG' ? signal.stop_loss - slipPts : signal.stop_loss + slipPts;
    exitMaker = false;
  } else {
    exitPrice = candle.close;
    exitMaker = false;
  }

  const grossPnlUsd = sideSign(signal.side) * (exitPrice - signal.entry_price_actual) * signal.qty;
  const exitNotional = Math.abs(exitPrice * signal.qty);
  const exitFeeUsd = feeUsd(exitNotional, exitMaker, cfg);
  const pnlUsd = grossPnlUsd - signal.entry_fee_usd - exitFeeUsd;
  const pnlR = signal.risk_usd > 0 ? pnlUsd / signal.risk_usd : 0;

  return {
    ...signal,
    status: 'settled',
    outcome,
    exit_price: exitPrice,
    exit_maker: exitMaker,
    exit_fee_usd: round4(exitFeeUsd),
    pnl_usd: round4(pnlUsd),
    pnl_r: round4(pnlR),
    slippage_pts: round4(slipPts),
    settle_candles: elapsed,
    settle_timestamp: candle.closeTime,
  };
}

export function simulateScenario(candles, config) {
  const cfg = deepClone({ ...DEFAULT_CONFIG, ...config, engines: { ...DEFAULT_CONFIG.engines, ...(config.engines || {}) } });
  const enabledEngineIds = Object.entries(cfg.engines).filter(([,v]) => v).map(([k]) => k);
  const engineStats = Object.fromEntries(enabledEngineIds.map(id => [id, {
    signals: 0, filled: 0, gtxRejected: 0, timeoutMissed: 0, wins: 0, losses: 0, timeouts: 0, netR: 0,
  }]));
  const account = {
    startingBalance: Number(cfg.startingBalance || 10000),
    balance: Number(cfg.startingBalance || 10000),
    pendingPnl: 0,
    pendingBucket: null,
  };

  const signals = [];
  const warmup = 80;

  for (let i = warmup; i < candles.length; i++) {
    const lastClosed = candles[i];
    const closed = candles.slice(0, i + 1);
    const prevSignals = signals.slice(); // snapshot at start of candle, like V5 signalsRef.current

    // STEP 1 — pending confirmation window
    for (let k = 0; k < signals.length; k++) {
      const sig = signals[k];
      if (sig.status !== 'pending') continue;
      const elapsed = i - sig.signal_idx;
      const slHit = sig.side === 'LONG' ? lastClosed.low <= sig.stop_loss : lastClosed.high >= sig.stop_loss;
      if (slHit) {
        signals[k] = {
          ...sig,
          status: 'cancelled',
          outcome: 'CANCELLED',
          cancel_candle: elapsed,
          settle_timestamp: lastClosed.closeTime,
        };
        continue;
      }
      if (elapsed >= cfg.entryTimeoutCandles) {
        const riskUsd = getRiskDollar(account, cfg);
        const qty = riskUsd > 0 ? (riskUsd / sig.sl_distance) : 0;
        const entryIsMaker = cfg.entryMode === 'maker_gtx';
        const entrySlip = entryIsMaker ? 0 : slippageFor('entry', cfg, lastClosed);
        const entryActual = sig.side === 'LONG' ? sig.entry_price + entrySlip : sig.entry_price - entrySlip;
        const entryNotional = Math.abs(entryActual * qty);
        const entryFeeUsd = feeUsd(entryNotional, entryIsMaker, cfg);
        signals[k] = {
          ...sig,
          status: 'active',
          pending_confirmed: 1,
          fill_idx: i,
          fill_timestamp: lastClosed.closeTime,
          risk_usd: round4(riskUsd),
          qty: round8(qty),
          entry_price_actual: round4(entryActual),
          entry_fee_usd: round4(entryFeeUsd),
          entry_maker: entryIsMaker,
        };
        engineStats[sig.engine].filled += 1;
      }
    }

    // STEP 2 — settle active signals on this candle
    for (let k = 0; k < signals.length; k++) {
      const sig = signals[k];
      if (sig.status !== 'active') continue;
      const elapsed = i - sig.signal_idx;
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
      signals[k] = settleSignal(sig, outcome, lastClosed, i, cfg);
    }

    // STEP 3 — apply account settlement exactly once
    for (let k = 0; k < signals.length; k++) {
      const sig = signals[k];
      if (sig.status !== 'settled' || sig.settlement_applied) continue;
      applyCompounding(account, sig.pnl_usd || 0, sig.settle_timestamp || lastClosed.closeTime, cfg);
      signals[k] = { ...sig, settlement_applied: 1 };
      if (sig.outcome === 'WIN') engineStats[sig.engine].wins += 1;
      else if (sig.outcome === 'LOSS') engineStats[sig.engine].losses += 1;
      else if (sig.outcome === 'TIMEOUT') engineStats[sig.engine].timeouts += 1;
      engineStats[sig.engine].netR += Number(sig.pnl_r || 0);
    }

    // STEP 4 — run engines on current closed slice, append new pending signals
    for (const engineId of enabledEngineIds) {
      const runner = ENGINE_RUNNERS[engineId];
      const diag = runner?.(closed);
      if (!diag?.fired || !diag.signal) continue;

      const activeSameEngine = prevSignals.find(sig => sig.engine === engineId && (sig.status === 'pending' || sig.status === 'active'));
      if (activeSameEngine) continue;

      const sigRow = buildSignalRow(engineId, diag, lastClosed, i, cfg);
      if (!sigRow) continue;
      signals.push(sigRow);
      engineStats[engineId].signals += 1;
    }
  }

  finalizeCompounding(account);

  const closedTrades = signals.filter(s => s.status === 'settled');
  const wins = closedTrades.filter(r => r.outcome === 'WIN').length;
  const losses = closedTrades.filter(r => r.outcome === 'LOSS').length;
  const timeouts = closedTrades.filter(r => r.outcome === 'TIMEOUT').length;
  const netR = closedTrades.reduce((s, r) => s + Number(r.pnl_r || 0), 0);
  const avgR = closedTrades.length ? netR / closedTrades.length : 0;
  const winRate = (wins + losses) ? wins / (wins + losses) : 0;
  const totalFeeUsd = closedTrades.reduce((s, r) => s + Number(r.entry_fee_usd || 0) + Number(r.exit_fee_usd || 0), 0);
  const avgSLSlip = avg(closedTrades.filter(r => r.outcome === 'LOSS').map(r => Number(r.slippage_pts || 0)));
  const avgTPSlip = avg(closedTrades.filter(r => r.outcome === 'WIN').map(r => Number(r.slippage_pts || 0)));

  const results = closedTrades.map(r => ({
    engine: r.engine,
    status: r.outcome === 'WIN' ? 'TP' : r.outcome === 'LOSS' ? 'SL' : 'TIMEOUT',
    signalTime: r.signal_timestamp,
    entryTime: r.fill_timestamp,
    exitTime: r.settle_timestamp,
    side: r.side,
    entry: r.entry_price_actual,
    sl: r.stop_loss,
    tp: r.take_profit,
    exitPrice: r.exit_price,
    qty: r.qty,
    entryMaker: r.entry_maker,
    tpMode: cfg.tpMode,
    pnlUsd: r.pnl_usd,
    pnlR: r.pnl_r,
    entryFeeUsd: r.entry_fee_usd,
    exitFeeUsd: r.exit_fee_usd,
    slippagePts: r.slippage_pts,
  }));

  return {
    summary: {
      trades: closedTrades.length,
      wins,
      losses,
      timeouts,
      winRate,
      netR: round4(netR),
      avgR: round4(avgR),
      startBalance: account.startingBalance,
      endBalance: round2(account.balance),
      totalFeeUsd: round2(totalFeeUsd),
      avgSLSlip: round4(avgSLSlip),
      avgTPSlip: round4(avgTPSlip),
    },
    engineStats,
    results,
    signalLedger: signals,
  };
}

function round8(n) { return Math.round((n + Number.EPSILON) * 1e8) / 1e8; }
