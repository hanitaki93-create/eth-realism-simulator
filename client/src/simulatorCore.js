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
  entryMode: 'maker_gtx',
  entryOffset: 0,
  entryTimeoutCandles: 2, // baseline-style pending confirmation window
  makerEntryRejectRate: 0, // optional extra stress override, not core GTX model
  makerEntryMissAfterTouchRate: 0, // optional extra stress override, not core GTX model
  tpMode: 'market',
  tpFailRate: 0.005,
  feeMakerBps: 2,
  feeTakerBps: 5,
  slippagePreset: 'realistic',
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
function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function round4(n) { return Math.round((n + Number.EPSILON) * 10000) / 10000; }
function round8(n) { return Math.round((n + Number.EPSILON) * 1e8) / 1e8; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

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

function chance01(key) {
  const h = cryptoHash(key);
  return (h % 1000000) / 1000000;
}

function cryptoHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
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
    entry_price: round4(entry),
    stop_loss: round4(sl),
    take_profit: round4(tp),
    confidence: Number(s.confidence ?? diag.confidence ?? 0),
    setup_type: s.setup_type || engineId,
    reason: s.reason || '',
    sl_distance: round4(slDistance),
    status: ['D', 'E', 'F'].includes(engineId) ? 'pending' : 'armed',
    outcome: null,
    pnl_r: null,
    settle_candles: null,
    settle_timestamp: null,
    timeout_candles: cfg.maxHoldCandles,
    pending_confirmed: 0,
    cancel_candle: null,
    arm_idx: ['D', 'E', 'F'].includes(engineId) ? null : candleIdx,
    arm_timestamp: ['D', 'E', 'F'].includes(engineId) ? null : candle.closeTime,
    fill_idx: null,
    fill_timestamp: null,
    qty: null,
    risk_usd: null,
    entry_price_actual: null,
    entry_fee_usd: 0,
    entry_maker: cfg.entryMode === 'maker_gtx',
    entry_notional_usd: 0,
    exit_fee_usd: 0,
    exit_notional_usd: 0,
    gross_pnl_usd: 0,
    slippage_pts: 0,
    settlement_applied: 0,
  };
}

function settleSignal(signal, outcome, candle, candleIdx, cfg) {
  const elapsed = candleIdx - (signal.fill_idx ?? signal.signal_idx);
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
  } else if (outcome === 'TIMEOUT') {
    slipPts = slippageFor('tp', cfg, candle);
    exitPrice = signal.side === 'LONG' ? candle.close - slipPts : candle.close + slipPts;
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
    exit_price: round4(exitPrice),
    exit_maker: exitMaker,
    exit_fee_usd: round4(exitFeeUsd),
    exit_notional_usd: round4(exitNotional),
    gross_pnl_usd: round4(grossPnlUsd),
    pnl_usd: round4(pnlUsd),
    pnl_r: round4(pnlR),
    slippage_pts: round4(slipPts),
    settle_candles: elapsed,
    settle_timestamp: candle.closeTime,
  };
}

function baseEngineStats() {
  return {
    rawDetections: 0,
    blockedByLifecycle: 0,
    signals: 0,
    pendingCancelled: 0,
    activated: 0,
    filled: 0,
    gtxRejected: 0,
    timeoutMissed: 0,
    settled: 0,
    wins: 0,
    losses: 0,
    timeouts: 0,
    netR: 0,
  };
}

function makerDecision(signal, candle, cfg) {
  const side = signal.side;
  const entry = signal.entry_price;
  const range = Math.max(0.0001, candle.high - candle.low);
  const touch = side === 'LONG' ? candle.low <= entry : candle.high >= entry;
  const marketableAtOpen = side === 'LONG' ? candle.open <= entry : candle.open >= entry;
  const gap = marketableAtOpen
    ? (side === 'LONG' ? Math.max(0, entry - candle.open) : Math.max(0, candle.open - entry))
    : 0;
  const gapFrac = clamp(gap / range, 0, 1);

  // If price never comes back to the entry level during the candle, just keep waiting.
  // A 5m bar cannot justify a hard reject here.
  if (!touch) return { action: 'wait', reason: marketableAtOpen ? 'opened_through_no_retrace' : 'not_touched' };

  const overshoot = side === 'LONG' ? Math.max(0, entry - candle.low) : Math.max(0, candle.high - entry);
  const overshootFrac = clamp(overshoot / range, 0, 1);
  const baseMiss = 0.015;
  const wideCandleBump = range > 15 ? 0.03 : range > 8 ? 0.015 : 0;
  const overshootBump = overshootFrac > 0.5 ? 0.05 : overshootFrac > 0.25 ? 0.025 : 0;
  const lowConfidenceBump = signal.confidence < 0.55 ? 0.02 : 0;
  const marketableBump = marketableAtOpen ? (gapFrac > 0.6 ? 0.12 : gapFrac > 0.25 ? 0.06 : 0.025) : 0;
  const extraStressMiss = clamp(Number(cfg.makerEntryMissAfterTouchRate || 0), 0, 0.5);
  const extraStressReject = clamp(Number(cfg.makerEntryRejectRate || 0), 0, 0.5);
  const missProb = clamp(baseMiss + wideCandleBump + overshootBump + lowConfidenceBump + marketableBump + extraStressMiss, 0, 0.45);
  const rejectProb = clamp((marketableAtOpen ? (gapFrac > 0.8 ? 0.05 : gapFrac > 0.5 ? 0.02 : 0) : 0) + extraStressReject, 0, 0.35);
  const rand = chance01(`${signal.signal_id}_${candle.closeTime}_maker`);

  if (rand < rejectProb) return { action: 'gtx_reject', reason: marketableAtOpen ? 'opened_through_reject' : 'stress_reject' };
  if (rand < rejectProb + missProb) return { action: 'miss', reason: marketableAtOpen ? 'opened_through_no_fill' : 'touch_no_fill' };
  return { action: 'fill', reason: marketableAtOpen ? 'opened_through_reprice_fill' : 'maker_touch_fill' };
}

function fillSignal(signal, candle, candleIdx, cfg, account) {
  const riskUsd = getRiskDollar(account, cfg);
  account.maxRiskUsed = Math.max(account.maxRiskUsed, riskUsd);
  const qtyRaw = (riskUsd > 0 && finiteNum(signal.sl_distance) > 0) ? (riskUsd / signal.sl_distance) : 0;
  const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 0;
  const entryIsMaker = cfg.entryMode === 'maker_gtx';
  const entrySlip = entryIsMaker ? 0 : slippageFor('entry', cfg, candle);
  const entryActual = signal.side === 'LONG' ? signal.entry_price + entrySlip : signal.entry_price - entrySlip;
  const entryNotional = Math.abs(entryActual * qty);
  const entryFeeUsd = feeUsd(entryNotional, entryIsMaker, cfg);

  return {
    ...signal,
    status: 'active',
    pending_confirmed: 1,
    fill_idx: candleIdx,
    fill_timestamp: candle.closeTime,
    risk_usd: round4(riskUsd),
    qty: round8(qty),
    entry_price_actual: round4(entryActual),
    entry_fee_usd: round4(entryFeeUsd),
    entry_maker: entryIsMaker,
    entry_notional_usd: round4(entryNotional),
  };
}

export function simulateScenario(candles, config) {
  const cfg = deepClone({ ...DEFAULT_CONFIG, ...config, engines: { ...DEFAULT_CONFIG.engines, ...(config.engines || {}) } });
  const enabledEngineIds = Object.entries(cfg.engines).filter(([,v]) => v).map(([k]) => k);
  const engineStats = Object.fromEntries(enabledEngineIds.map(id => [id, baseEngineStats()]));
  const account = {
    startingBalance: Number(cfg.startingBalance || 10000),
    balance: Number(cfg.startingBalance || 10000),
    pendingPnl: 0,
    pendingBucket: null,
    maxRiskUsed: 0,
  };

  const signals = [];
  const warmup = 80;
  const makerEntryWindowCandles = Math.max(2, Number(cfg.entryTimeoutCandles || 2));

  for (let i = warmup; i < candles.length; i++) {
    const lastClosed = candles[i];
    const closed = candles.slice(0, i + 1);
    const prevSignals = signals.slice();

    // 1) pending lifecycle
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
        engineStats[sig.engine].pendingCancelled += 1;
        continue;
      }
      if (elapsed >= cfg.entryTimeoutCandles) {
        signals[k] = {
          ...sig,
          status: 'armed',
          arm_idx: i,
          arm_timestamp: lastClosed.closeTime,
        };
      }
    }

    // 2) armed entry lifecycle
    for (let k = 0; k < signals.length; k++) {
      const sig = signals[k];
      if (sig.status !== 'armed') continue;
      const armAge = i - (sig.arm_idx ?? i);

      if (cfg.entryMode === 'maker_gtx') {
        const decision = makerDecision(sig, lastClosed, cfg);
        if (decision.action === 'fill') {
          signals[k] = fillSignal(sig, lastClosed, i, cfg, account);
          engineStats[sig.engine].activated += 1;
          engineStats[sig.engine].filled += 1;
          continue;
        }
        if (decision.action === 'gtx_reject') {
          signals[k] = {
            ...sig,
            status: 'gtx_rejected',
            outcome: 'GTX_REJECT',
            settle_timestamp: lastClosed.closeTime,
          };
          engineStats[sig.engine].gtxRejected += 1;
          continue;
        }
        if (decision.action === 'miss' && armAge >= makerEntryWindowCandles) {
          signals[k] = {
            ...sig,
            status: 'missed',
            outcome: 'ENTRY_MISSED',
            settle_timestamp: lastClosed.closeTime,
          };
          engineStats[sig.engine].timeoutMissed += 1;
          continue;
        }
        if (decision.action === 'wait' && armAge >= makerEntryWindowCandles) {
          signals[k] = {
            ...sig,
            status: 'missed',
            outcome: 'ENTRY_TIMEOUT',
            settle_timestamp: lastClosed.closeTime,
          };
          engineStats[sig.engine].timeoutMissed += 1;
          continue;
        }
      } else {
        signals[k] = fillSignal(sig, lastClosed, i, cfg, account);
        engineStats[sig.engine].activated += 1;
        engineStats[sig.engine].filled += 1;
      }
    }

    // 3) active settlement
    for (let k = 0; k < signals.length; k++) {
      const sig = signals[k];
      if (sig.status !== 'active') continue;
      const elapsed = i - (sig.fill_idx ?? sig.signal_idx);
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

    // 4) apply settled PnL
    for (let k = 0; k < signals.length; k++) {
      const sig = signals[k];
      if (sig.status !== 'settled' || sig.settlement_applied) continue;
      applyCompounding(account, sig.pnl_usd || 0, sig.settle_timestamp || lastClosed.closeTime, cfg);
      signals[k] = { ...sig, settlement_applied: 1 };
      engineStats[sig.engine].settled += 1;
      if (sig.outcome === 'WIN') engineStats[sig.engine].wins += 1;
      else if (sig.outcome === 'LOSS') engineStats[sig.engine].losses += 1;
      else if (sig.outcome === 'TIMEOUT') engineStats[sig.engine].timeouts += 1;
      engineStats[sig.engine].netR += Number(sig.pnl_r || 0);
    }

    // 5) new signals from engines
    for (const engineId of enabledEngineIds) {
      const runner = ENGINE_RUNNERS[engineId];
      const diag = runner?.(closed);
      if (!diag?.fired || !diag.signal) continue;

      engineStats[engineId].rawDetections += 1;
      const activeSameEngine = prevSignals.find(sig => sig.engine === engineId && ['pending', 'armed', 'active'].includes(sig.status));
      if (activeSameEngine) {
        engineStats[engineId].blockedByLifecycle += 1;
        continue;
      }

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
  const totalFeeUsd = closedTrades.reduce((s, r) => s + finiteNum(r.entry_fee_usd) + finiteNum(r.exit_fee_usd), 0);
  const totalEntryNotional = closedTrades.reduce((s, r) => s + finiteNum(r.entry_notional_usd), 0);
  const totalExitNotional = closedTrades.reduce((s, r) => s + finiteNum(r.exit_notional_usd), 0);
  const totalTurnoverUsd = totalEntryNotional + totalExitNotional;
  const avgSLSlip = avg(closedTrades.filter(r => r.outcome === 'LOSS').map(r => Number(r.slippage_pts || 0)));
  const avgTPSlip = avg(closedTrades.filter(r => r.outcome === 'WIN').map(r => Number(r.slippage_pts || 0)));
  const avgFeePerTradeUsd = closedTrades.length ? totalFeeUsd / closedTrades.length : 0;
  const avgTurnoverPerTradeUsd = closedTrades.length ? totalTurnoverUsd / closedTrades.length : 0;
  const feePctTurnover = totalTurnoverUsd > 0 ? (totalFeeUsd / totalTurnoverUsd) : 0;

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
    grossPnlUsd: r.gross_pnl_usd,
    pnlR: r.pnl_r,
    entryFeeUsd: r.entry_fee_usd,
    exitFeeUsd: r.exit_fee_usd,
    entryNotionalUsd: r.entry_notional_usd,
    exitNotionalUsd: r.exit_notional_usd,
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
      totalTurnoverUsd: round2(totalTurnoverUsd),
      avgFeePerTradeUsd: round2(avgFeePerTradeUsd),
      avgTurnoverPerTradeUsd: round2(avgTurnoverPerTradeUsd),
      feePctTurnover: round4(feePctTurnover),
      avgSLSlip: round4(avgSLSlip),
      avgTPSlip: round4(avgTPSlip),
      actualRiskModeUsed: cfg.riskMode,
      maxRiskUsed: round2(account.maxRiskUsed),
    },
    engineStats,
    results,
    signalLedger: signals,
    actualConfig: cfg,
  };
}
