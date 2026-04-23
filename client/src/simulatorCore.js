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
function sideSign(side) { return side === 'LONG' ? 1 : -1; }
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

function buildSignal(diag, engineId, candle, cfg) {
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

  return {
    engine: engineId,
    side,
    signalTime: candle.closeTime,
    signalIdx: null,
    entry,
    sl,
    tp,
    confidence: Number(s.confidence ?? diag.confidence ?? 0),
    slDistance: effectiveSlDist,
    setupType: s.setup_type || engineId,
  };
}

function makerWouldReject(signal, nextCandle) {
  if (signal.side === 'LONG') return nextCandle.open > signal.entry;
  return nextCandle.open < signal.entry;
}

function makerTouched(signal, candle) {
  return candle.low <= signal.entry && candle.high >= signal.entry;
}

function feeUsd(notional, isMaker, cfg) {
  return Math.abs(notional) * ((isMaker ? cfg.feeMakerBps : cfg.feeTakerBps) / 10000);
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
  const engineStats = Object.fromEntries(enabledEngineIds.map(id => [id, { signals: 0, filled: 0, gtxRejected: 0, timeoutMissed: 0, wins: 0, losses: 0, timeouts: 0, netR: 0 }]));
  const balanceState = { balance: Number(cfg.startingBalance || 10000), pendingPnl: 0, pendingBucket: null };
  let openTrade = null;

  for (let i = 80; i < candles.length - 2; i++) {
    const slice = candles.slice(0, i + 1);
    const candle = candles[i];
    const next1 = candles[i + 1];
    const next2 = candles[i + 2];

    if (!openTrade) {
      for (const engineId of enabledEngineIds) {
        const diag = ENGINE_RUNNERS[engineId]?.(slice);
        const signal = buildSignal(diag, engineId, candle, cfg);
        if (!signal) continue;

        signal.signalIdx = i;
        engineStats[engineId].signals += 1;

        const riskUsd = getRiskDollar(balanceState.balance, cfg);
        if (!riskUsd || !signal.slDistance) continue;

        const qty = riskUsd / signal.slDistance;
        if (!Number.isFinite(qty) || qty <= 0) continue;

        let filled = false;
        let actualEntry = signal.entry;
        let isEntryMaker = cfg.entryMode === 'maker_gtx';

        if (cfg.entryMode === 'maker_gtx') {
          if (Math.random() < cfg.makerEntryRejectRate || makerWouldReject(signal, next1)) {
            engineStats[engineId].gtxRejected += 1;
            results.push({ engine: engineId, signalTime: signal.signalTime, status: 'GTX_REJECT', entry: signal.entry, sl: signal.sl, tp: signal.tp, intendedRisk: riskUsd });
            continue;
          }

          const touchWindow = [next1, next2].slice(0, cfg.entryTimeoutCandles);
          const touched = touchWindow.find(c => makerTouched(signal, c));
          if (!touched || Math.random() < cfg.makerEntryMissAfterTouchRate) {
            engineStats[engineId].timeoutMissed += 1;
            results.push({ engine: engineId, signalTime: signal.signalTime, status: 'ENTRY_TIMEOUT', entry: signal.entry, sl: signal.sl, tp: signal.tp, intendedRisk: riskUsd });
            continue;
          }

          filled = true;
          actualEntry = signal.entry;
        } else {
          filled = true;
          const slip = slippageFor('entry', cfg, next1);
          actualEntry = signal.side === 'LONG' ? next1.open + slip : next1.open - slip;
          isEntryMaker = false;
        }

        if (!filled) continue;

        const entryNotional = Math.abs(actualEntry * qty);
        openTrade = {
          ...signal,
          riskUsd,
          qty,
          entry: actualEntry,
          entryIdx: i + 1,
          entryMaker: isEntryMaker,
          entryFeeUsd: feeUsd(entryNotional, isEntryMaker, cfg),
          engineId,
        };
        engineStats[engineId].filled += 1;
        break;
      }
    }

    if (openTrade) {
      const side = openTrade.side;
      const start = openTrade.entryIdx;
      const maxJ = Math.min(candles.length, start + cfg.maxHoldCandles);

      for (let j = Math.max(i, start); j < maxJ; j++) {
        const c = candles[j];
        const hitSL = side === 'LONG' ? c.low <= openTrade.sl : c.high >= openTrade.sl;
        const hitTP = side === 'LONG' ? c.high >= openTrade.tp : c.low <= openTrade.tp;
        if (!hitSL && !hitTP) continue;

        let exitType = hitTP && !hitSL ? 'TP' : hitSL && !hitTP ? 'SL' : 'BOTH';
        if (exitType === 'BOTH') {
          const distToTP = Math.abs(c.open - openTrade.tp);
          const distToSL = Math.abs(c.open - openTrade.sl);
          exitType = distToTP <= distToSL ? 'TP' : 'SL';
        }

        let exitPrice;
        let isExitMaker = false;

        if (exitType === 'TP') {
          if (cfg.tpMode === 'limit' && Math.random() >= cfg.tpFailRate) {
            exitPrice = openTrade.tp;
            isExitMaker = true;
          } else {
            const slip = slippageFor('tp', cfg, c);
            exitPrice = side === 'LONG' ? openTrade.tp - slip : openTrade.tp + slip;
            isExitMaker = false;
          }
        } else {
          const slip = slippageFor('sl', cfg, c);
          exitPrice = side === 'LONG' ? openTrade.sl - slip : openTrade.sl + slip;
          isExitMaker = false;
        }

        const grossPnl = side === 'LONG'
          ? (exitPrice - openTrade.entry) * openTrade.qty
          : (openTrade.entry - exitPrice) * openTrade.qty;

        const exitNotional = Math.abs(exitPrice * openTrade.qty);
        const exitFeeUsd = feeUsd(exitNotional, isExitMaker, cfg);
        const pnlUsd = grossPnl - openTrade.entryFeeUsd - exitFeeUsd;
        const pnlR = pnlUsd / openTrade.riskUsd;

        const row = {
          engine: openTrade.engineId,
          status: exitType,
          signalTime: openTrade.signalTime,
          entryTime: candles[start]?.openTime ?? null,
          exitTime: c.closeTime,
          side,
          entry: openTrade.entry,
          sl: openTrade.sl,
          tp: openTrade.tp,
          exitPrice,
          qty: openTrade.qty,
          entryMaker: openTrade.entryMaker,
          tpMode: cfg.tpMode,
          pnlUsd,
          pnlR,
          entryFeeUsd: openTrade.entryFeeUsd,
          exitFeeUsd,
          slippagePts: exitType === 'SL' ? Math.abs(exitPrice - openTrade.sl) : Math.abs(exitPrice - openTrade.tp),
        };

        results.push(row);
        applyCompounding(balanceState, row, cfg, c.closeTime);

        const es = engineStats[openTrade.engineId];
        if (exitType === 'TP') es.wins += 1; else es.losses += 1;
        es.netR += pnlR;

        openTrade = null;
        break;
      }

      if (openTrade && i >= openTrade.entryIdx + cfg.maxHoldCandles) {
        const c = candles[Math.min(candles.length - 1, openTrade.entryIdx + cfg.maxHoldCandles)];
        const exitPrice = c.close;
        const grossPnl = sideSign(openTrade.side) * (exitPrice - openTrade.entry) * openTrade.qty;
        const exitNotional = Math.abs(exitPrice * openTrade.qty);
        const exitFeeUsd = feeUsd(exitNotional, false, cfg);
        const pnlUsd = grossPnl - openTrade.entryFeeUsd - exitFeeUsd;
        const pnlR = pnlUsd / openTrade.riskUsd;

        const row = {
          engine: openTrade.engineId,
          status: 'TIMEOUT',
          signalTime: openTrade.signalTime,
          entryTime: candles[openTrade.entryIdx]?.openTime ?? null,
          exitTime: c.closeTime,
          side: openTrade.side,
          entry: openTrade.entry,
          sl: openTrade.sl,
          tp: openTrade.tp,
          exitPrice,
          qty: openTrade.qty,
          entryMaker: openTrade.entryMaker,
          tpMode: cfg.tpMode,
          pnlUsd,
          pnlR,
          entryFeeUsd: openTrade.entryFeeUsd,
          exitFeeUsd,
          slippagePts: 0,
        };

        results.push(row);
        applyCompounding(balanceState, row, cfg, c.closeTime);
        engineStats[openTrade.engineId].timeouts += 1;
        engineStats[openTrade.engineId].netR += pnlR;
        openTrade = null;
      }
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
  const totalFeeUsd = closedTrades.reduce((s, r) => s + (r.entryFeeUsd || 0) + (r.exitFeeUsd || 0), 0);
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
    },
    engineStats,
    results,
  };
}
