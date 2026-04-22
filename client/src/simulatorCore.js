import { runEngineB } from './engines/engineB.js';
import { runEngineC } from './engines/engineC.js';
import { runEngineD } from './engines/engineD.js';
import { runEngineE } from './engines/engineE.js';
import { runEngineF } from './engines/engineF.js';

export const ENGINE_RUNNERS = { B: runEngineB, C: runEngineC, D: runEngineD, E: runEngineE, F: runEngineF };

export const DEFAULT_CONFIG = {
  symbol: 'ETHUSDT',
  interval: '5m',
  riskMode: 'fixed', // fixed | pct
  fixedRisk: 200,
  riskPct: 2,
  riskCap: 1000,
  compounding: 'none', // none | per_trade | daily | monthly | quarterly
  tpRMultiple: 2,
  slMultiplier: 1,
  minSlFloor: 0,
  entryMode: 'maker_gtx', // maker_gtx | taker_market
  entryOffset: 0,
  entryTimeoutCandles: 2,
  makerEntryRejectRate: 0,
  makerEntryMissAfterTouchRate: 0.02,
  partialFillRate: 0,
  partialFillThreshold: 0.8,
  tpMode: 'market', // market | limit
  tpFailRate: 0.005,
  feeMakerBps: 2,
  feeTakerBps: 5,
  slippagePreset: 'realistic', // baseline | realistic | stress
  slippageBasePts: { entry: 0, tp: 0.15, sl: 0.26 },
  fundingBpsPer8h: 1,
  maxHoldCandles: 288,
  oneWayMode: true,
  allowStacking: false,
  engines: { B: false, C: false, D: true, E: true, F: false },
  defenseMode: { B: false, C: false, D: false, E: false, F: false },
  regimeDetector: { B: false, C: false, D: false, E: false, F: false },
};

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
function quarterKey(ts) { const d = new Date(ts); return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth()/3)+1}`; }
function monthKey(ts) { const d = new Date(ts); return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`; }
function sideSign(side) { return side === 'LONG' ? 1 : -1; }
function avg(arr){ return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function isFiniteNumber(n) { return Number.isFinite(Number(n)); }

function getRiskDollar(balance, cfg) {
  const raw = cfg.riskMode === 'pct' ? balance * (cfg.riskPct / 100) : cfg.fixedRisk;
  return Math.max(0, Math.min(raw, cfg.riskCap || raw));
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
  const range = candle.high - candle.low;
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
  if (!['LONG', 'SHORT'].includes(side) || !isFiniteNumber(rawEntry) || !isFiniteNumber(rawSl)) return null;

  const slDist = Math.abs(rawEntry - rawSl) * (cfg.slMultiplier || 1);
  const effectiveSlDist = Math.max(slDist, cfg.minSlFloor || 0.0001);
  if (!isFiniteNumber(effectiveSlDist) || effectiveSlDist <= 0) return null;

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
    setupType: s.setup_type || engineId,
    confidence: Number(s.confidence ?? diag.confidence ?? 0),
    slDistance: effectiveSlDist,
  };
}

function makerWouldReject(signal, nextCandle) {
  if (!nextCandle) return true;
  if (signal.side === 'LONG') return nextCandle.open > signal.entry;
  return nextCandle.open < signal.entry;
}

function makerTouched(signal, candle) {
  return candle && candle.low <= signal.entry && candle.high >= signal.entry;
}

function entryFee(notional, isMaker, cfg) { return notional * ((isMaker ? cfg.feeMakerBps : cfg.feeTakerBps) / 10000); }
function exitFee(notional, isMaker, cfg) { return notional * ((isMaker ? cfg.feeMakerBps : cfg.feeTakerBps) / 10000); }

function buildClosedTradeRow(trade, candle, exitType, exitPrice, isExitMaker, cfg) {
  const grossPnl = trade.side === 'LONG'
    ? (exitPrice - trade.entry) * trade.qty
    : (trade.entry - exitPrice) * trade.qty;
  const notionalExit = Math.abs(exitPrice * trade.qty);
  const exitFeeUsd = exitFee(notionalExit, isExitMaker, cfg);
  const fees = trade.entryFeeUsd + exitFeeUsd;
  const pnlUsd = grossPnl - fees;
  const pnlR = trade.riskUsd ? pnlUsd / trade.riskUsd : 0;

  return {
    engine: trade.engineId,
    status: exitType,
    signalTime: trade.signalTime,
    entryTime: trade.entryTime,
    exitTime: candle.closeTime,
    side: trade.side,
    entry: trade.entry,
    sl: trade.sl,
    tp: trade.tp,
    exitPrice,
    qty: trade.qty,
    entryMaker: !!trade.entryMaker,
    tpMode: cfg.tpMode,
    pnlUsd,
    pnlR,
    entryFeeUsd: trade.entryFeeUsd,
    exitFeeUsd,
    slippagePts: exitType === 'SL' ? Math.abs(exitPrice - trade.sl) : exitType === 'TP' ? Math.abs(exitPrice - trade.tp) : 0,
  };
}

export function simulateScenario(candles, config) {
  const cfg = deepClone({ ...DEFAULT_CONFIG, ...config, engines: { ...DEFAULT_CONFIG.engines, ...(config.engines || {}) } });
  const enabledEngineIds = Object.entries(cfg.engines).filter(([,v]) => v).map(([k]) => k);
  if (!enabledEngineIds.length) {
    throw new Error('Enable at least one engine before running the simulator.');
  }
  if (!Array.isArray(candles) || candles.length < 120) {
    throw new Error('Not enough candles loaded to run the simulator.');
  }

  const results = [];
  const engineStats = Object.fromEntries(enabledEngineIds.map(id => [id, { signals: 0, filled: 0, gtxRejected: 0, timeoutMissed: 0, wins: 0, losses: 0, timeouts: 0, netR: 0 }]));
  const balanceState = { balance: 10000, pendingPnl: 0, pendingBucket: null };
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
        if (!riskUsd || !isFiniteNumber(signal.slDistance) || signal.slDistance <= 0) continue;
        const qty = riskUsd / signal.slDistance;
        const intendedNotional = Math.abs(qty * signal.entry);

        let filled = false;
        let actualEntry = signal.entry;
        let isEntryMaker = cfg.entryMode === 'maker_gtx';

        if (cfg.entryMode === 'maker_gtx') {
          if (Math.random() < cfg.makerEntryRejectRate || makerWouldReject(signal, next1)) {
            engineStats[engineId].gtxRejected += 1;
            results.push({ engine: engineId, signalTime: signal.signalTime, status: 'GTX_REJECT', entry: signal.entry, sl: signal.sl, tp: signal.tp, intendedRisk: riskUsd, entryMaker: true });
            continue;
          }
          const touchWindow = [next1, next2].slice(0, Math.max(1, cfg.entryTimeoutCandles));
          const touched = touchWindow.find(c => makerTouched(signal, c));
          if (!touched || Math.random() < cfg.makerEntryMissAfterTouchRate) {
            engineStats[engineId].timeoutMissed += 1;
            results.push({ engine: engineId, signalTime: signal.signalTime, status: 'ENTRY_TIMEOUT', entry: signal.entry, sl: signal.sl, tp: signal.tp, intendedRisk: riskUsd, entryMaker: true });
            continue;
          }
          filled = true;
          actualEntry = signal.entry;
        } else {
          filled = true;
          actualEntry = next1?.open ?? signal.entry;
          isEntryMaker = false;
        }

        if (!filled || !isFiniteNumber(actualEntry) || !isFiniteNumber(qty)) continue;

        openTrade = {
          ...signal,
          riskUsd,
          qty,
          entry: actualEntry,
          entryIdx: i + 1,
          entryTime: candles[i + 1]?.openTime ?? candle.closeTime,
          entryFeeUsd: entryFee(intendedNotional, isEntryMaker, cfg),
          entryMaker: isEntryMaker,
          engineId,
        };
        engineStats[engineId].filled += 1;
        break;
      }
    }

    if (openTrade) {
      const trade = openTrade;
      const side = trade.side;
      const start = trade.entryIdx;
      let closed = false;
      for (let j = Math.max(i, start); j < Math.min(candles.length, start + cfg.maxHoldCandles); j++) {
        const c = candles[j];
        const hitSL = side === 'LONG' ? c.low <= trade.sl : c.high >= trade.sl;
        const hitTP = side === 'LONG' ? c.high >= trade.tp : c.low <= trade.tp;
        if (!hitSL && !hitTP) continue;

        let exitType = hitTP && !hitSL ? 'TP' : hitSL && !hitTP ? 'SL' : 'BOTH';
        if (exitType === 'BOTH') {
          const distToTP = Math.abs(c.open - trade.tp);
          const distToSL = Math.abs(c.open - trade.sl);
          exitType = distToTP <= distToSL ? 'TP' : 'SL';
        }

        let exitPrice;
        let isExitMaker = false;
        if (exitType === 'TP') {
          if (cfg.tpMode === 'limit' && Math.random() >= cfg.tpFailRate) {
            exitPrice = trade.tp;
            isExitMaker = true;
          } else {
            const slip = slippageFor('tp', cfg, c);
            exitPrice = side === 'LONG' ? trade.tp - slip : trade.tp + slip;
          }
        } else {
          const slip = slippageFor('sl', cfg, c);
          exitPrice = side === 'LONG' ? trade.sl - slip : trade.sl + slip;
        }

        const row = buildClosedTradeRow(trade, c, exitType, exitPrice, isExitMaker, cfg);
        results.push(row);
        applyCompounding(balanceState, row, cfg, c.closeTime);
        const es = engineStats[trade.engineId];
        if (exitType === 'TP') es.wins += 1; else es.losses += 1;
        es.netR += row.pnlR;
        openTrade = null;
        closed = true;
        break;
      }

      if (!closed && openTrade && i >= trade.entryIdx + cfg.maxHoldCandles) {
        const c = candles[Math.min(candles.length - 1, trade.entryIdx + cfg.maxHoldCandles)];
        const row = buildClosedTradeRow(trade, c, 'TIMEOUT', c.close, false, cfg);
        results.push(row);
        applyCompounding(balanceState, row, cfg, c.closeTime);
        engineStats[trade.engineId].timeouts += 1;
        engineStats[trade.engineId].netR += row.pnlR;
        openTrade = null;
      }
    }
  }

  finalizeCompounding(balanceState);
  const closedTrades = results.filter(r => r && ['TP','SL','TIMEOUT'].includes(r.status));
  const wins = closedTrades.filter(r => r.status === 'TP').length;
  const losses = closedTrades.filter(r => r.status === 'SL').length;
  const timeouts = closedTrades.filter(r => r.status === 'TIMEOUT').length;
  const netR = closedTrades.reduce((s, r) => s + (r.pnlR || 0), 0);
  const avgR = closedTrades.length ? netR / closedTrades.length : 0;
  const winRate = (wins + losses) ? wins / (wins + losses) : 0;
  const totalFeeUsd = closedTrades.reduce((s, r) => s + (r.entryFeeUsd || 0) + (r.exitFeeUsd || 0), 0);
  const avgSLSlip = avg(closedTrades.filter(r => r.status === 'SL').map(r => r.slippagePts || 0));
  const avgTPSlip = avg(closedTrades.filter(r => r.status === 'TP').map(r => r.slippagePts || 0));

  return {
    summary: {
      trades: closedTrades.length,
      wins,
      losses,
      timeouts,
      winRate,
      netR,
      avgR,
      startBalance: 10000,
      endBalance: balanceState.balance,
      totalFeeUsd,
      avgSLSlip,
      avgTPSlip,
    },
    engineStats,
    results,
  };
}
