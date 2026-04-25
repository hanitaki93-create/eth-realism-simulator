import React, { useState } from 'react';
import ScenarioForm from './components/ScenarioForm.jsx';
import { DEFAULT_CONFIG, simulateScenario } from './simulatorCore.js';

const fmt = (n, d = 2) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

function yearBounds(year) {
  return {
    start: Date.UTC(year, 0, 1, 0, 0, 0, 0),
    end: Date.UTC(year + 1, 0, 1, 0, 0, 0, 0),
  };
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function makeRunId(config, years) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dMode = config.engineEntryMode?.D || config.entryMode;
  const eMode = config.engineEntryMode?.E || config.entryMode;
  const dGtx = config.engineMakerEntryFillStyle?.D || config.makerEntryFillStyle;
  const eGtx = config.engineMakerEntryFillStyle?.E || config.makerEntryFillStyle;
  return `${ts}__Y${years.join('-')}__D-${dMode}-${dGtx}__E-${eMode}-${eGtx}__TP-${config.tpMode}__RR-${config.tpRMultiple}`.replace(/[^A-Za-z0-9_.-]+/g, '_');
}

function modeSummary(config) {
  return {
    years: config.selectedYears,
    riskMode: config.riskMode,
    fixedRisk: config.fixedRisk,
    riskPct: config.riskPct,
    riskCap: config.riskCap,
    selectedLeverage: config.selectedLeverage,
    compounding: config.compounding,
    tpRMultiple: config.tpRMultiple,
    dEntryMode: config.engineEntryMode?.D || config.entryMode,
    dGtxModel: config.engineMakerEntryFillStyle?.D || config.makerEntryFillStyle,
    eEntryMode: config.engineEntryMode?.E || config.entryMode,
    eGtxModel: config.engineMakerEntryFillStyle?.E || config.makerEntryFillStyle,
    executionModel: config.executionModel,
    tpMode: config.tpMode,
    tpMakerFillProb: config.tpMakerFillProb,
    tpFallbackCandles: config.tpFallbackCandles,
    tpFallbackSeconds: config.tpFallbackSeconds,
    makerFeeBps: config.feeMakerBps,
    takerFeeBps: config.feeTakerBps,
    slippageMode: config.slippageMode,
    slippagePreset: config.slippagePreset,
    randomSeed: config.randomSeed,
    engines: config.engines,
  };
}

function StatCard({ label, value, dec = 2 }) {
  return (
    <div className="card">
      <div style={{ fontSize: 11, color: 'var(--text3)' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700 }}>{fmt(value, dec)}</div>
    </div>
  );
}

export default function App() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [result, setResult] = useState(null);
  const [runHistory, setRunHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('Ready.');

  async function fetchYearCandles(year, symbol, interval) {
    const { start, end } = yearBounds(year);
    const intervalMs = interval === '1m' ? 60000 : interval === '3m' ? 180000 : interval === '15m' ? 900000 : 300000;
    const total = Math.floor((end - start) / intervalMs);
    const url = `/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${total}&startTime=${start}`;
    const resp = await fetch(url);
    const contentType = resp.headers.get('content-type') || '';
    const raw = await resp.text();

    if (!resp.ok) throw new Error(`HTTP ${resp.status} from /api/klines: ${raw.slice(0, 180)}`);
    if (!contentType.includes('application/json')) {
      throw new Error(`Expected JSON from /api/klines but got ${contentType || 'unknown'}: ${raw.slice(0, 140)}`);
    }

    let json;
    try { json = JSON.parse(raw); }
    catch { throw new Error(`Invalid JSON from /api/klines: ${raw.slice(0, 140)}`); }
    if (!json.ok) throw new Error(json.error || `Failed to fetch ${year}`);

    return {
      year,
      candles: (json.candles || []).filter(c => c.openTime >= start && c.openTime < end),
      chunks: Math.ceil((json.candles || []).length / 1000),
    };
  }

  async function runScenario() {
    setLoading(true);
    setStatus('Loading candles…');
    try {
      const years = [...config.selectedYears].sort((a, b) => a - b);
      const yearly = [];
      for (const y of years) {
        setStatus(`Loading ${y}…`);
        yearly.push(await fetchYearCandles(y, config.symbol, config.interval));
      }

      const allCandles = yearly.flatMap(y => y.candles);
      const runId = makeRunId(config, years);
      const runMeta = {
        runId,
        runTimestamp: new Date().toISOString(),
        selectedYears: years,
        modeSummary: modeSummary({ ...config, selectedYears: years }),
        actualConfigAtRunStart: JSON.parse(JSON.stringify({ ...config, selectedYears: years })),
      };
      const candleYearAtIndex = (idx) => {
        const ts = allCandles[idx]?.closeTime ?? allCandles[idx]?.openTime ?? 0;
        if (!ts) return null;
        return new Date(ts).getUTCFullYear();
      };
      setStatus(`Loaded ${allCandles.length.toLocaleString()} candles. Running simulation ${runId}…`);
      const simRaw = simulateScenario(allCandles, { ...config, selectedYears: years });
      const sim = {
        ...simRaw,
        results: simRaw.results.map(r => ({ ...r, runId, runTimestamp: runMeta.runTimestamp, testYears: years.join(','), sourceYear: candleYearAtIndex(r.settleIdx), modeSummary: runMeta.modeSummary })),
        missedSignals: simRaw.missedSignals.map(r => ({ ...r, runId, runTimestamp: runMeta.runTimestamp, testYears: years.join(','), sourceYear: candleYearAtIndex(r.signalIdx), modeSummary: runMeta.modeSummary })),
        signalLedger: simRaw.signalLedger.map(r => ({ ...r, runId, runTimestamp: runMeta.runTimestamp, testYears: years.join(','), sourceYear: candleYearAtIndex(r.signalIdx), modeSummary: runMeta.modeSummary })),
        runMeta,
      };

      const yearByYear = yearly.map(({ year, candles, chunks }) => {
        const start = candles[0]?.openTime ?? 0;
        const end = candles[candles.length - 1]?.closeTime ?? 0;
        const rows = sim.results.filter(r => {
          const ts = allCandles[r.settleIdx]?.closeTime ?? 0;
          return ts >= start && ts <= end;
        });
        const missed = sim.missedSignals.filter(r => {
          const ts = allCandles[r.signalIdx]?.closeTime ?? 0;
          return ts >= start && ts <= end;
        });
        const fees = rows.reduce((a, r) => a + r.totalFeeUsd, 0);
        const netR = rows.reduce((a, r) => a + r.pnlR, 0);
        const grossR = rows.reduce((a, r) => a + r.grossRBeforeFees, 0);
        const feeR = rows.reduce((a, r) => a + r.feeR, 0);
        const wins = rows.filter(r => r.status === 'TP').length;
        const pnlUsd = rows.reduce((a, r) => a + r.pnlUsd, 0);
        return {
          year,
          chunks,
          candles: candles.length,
          signals: rows.length + missed.length,
          trades: rows.length,
          missed: missed.length,
          wr: rows.length ? wins / rows.length : 0,
          grossR,
          feeR,
          netR,
          pnlUsd,
          fees,
          avgFeeR: rows.length ? feeR / rows.length : 0,
        };
      });

      const nextResult = { ...sim, yearsRun: years, loadedCandles: allCandles.length, yearByYear, runMeta };
      setResult(nextResult);
      setRunHistory(prev => [
        {
          runId,
          runTimestamp: runMeta.runTimestamp,
          selectedYears: years,
          modeSummary: runMeta.modeSummary,
          summary: sim.summary,
          engineStats: sim.engineStats,
          yearByYear,
        },
        ...prev,
      ].slice(0, 50));
      setStatus(`Simulation complete. ${sim.summary.trades.toLocaleString()} filled trades across ${years.join(', ')}. Run ID: ${runId}`);
    } catch (e) {
      setStatus(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 1700, margin: '0 auto', padding: 20 }}>
      <h1 style={{ marginBottom: 4 }}>ETH Binance Realism Simulator</h1>
      <div style={{ color: 'var(--text3)', marginBottom: 16 }}>Two-pass version: pure signal ledger first, execution overlay second. Latency/open GTX is deterministic price-proxy logic and does not use the 88% probability model.</div>
      <ScenarioForm config={config} setConfig={setConfig} onRun={runScenario} loading={loading} />
      <div className="card" style={{ marginBottom: 16 }}>{status}</div>

      {result && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <b>Run complete.</b> {result.summary.trades.toLocaleString()} filled trades across {result.yearsRun.join(', ')}.<br />Run ID: <code>{result.runMeta?.runId}</code><br />
            Loaded candles: {result.loadedCandles.toLocaleString()} | Global entry: {result.actualConfig.entryMode} | D entry: {result.actualConfig.engineEntryMode?.D} / {result.actualConfig.engineMakerEntryFillStyle?.D} | E entry: {result.actualConfig.engineEntryMode?.E} / {result.actualConfig.engineMakerEntryFillStyle?.E} | TP mode: {result.actualConfig.tpMode} | Slippage: {result.actualConfig.slippageMode}<br />
            TP RR: {fmt(result.actualConfig.tpRMultiple, 2)} | Equity floor: {result.actualConfig.enforceEquityFloor ? 'ON' : 'OFF'} | Leverage block: {result.actualConfig.enforceLeverageLimit ? 'ON' : 'OFF'} | Risk basis: {result.actualConfig.positionSizingBasis} | Max R used: {fmt(result.summary.maxRiskUsed, 2)} | Selected leverage: {fmt(result.actualConfig.selectedLeverage,0)}x | Seed: {result.actualConfig.randomSeed}
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'repeat(10, minmax(0,1fr))', gap:10, marginBottom:16 }}>
            <StatCard label="Signals" value={result.summary.signalCount} dec={0} />
            <StatCard label="Filled" value={result.summary.filledCount} dec={0} />
            <StatCard label="Missed" value={result.summary.missedCount} dec={0} />
            <StatCard label="Win Rate %" value={result.summary.winRate*100} dec={2} />
            <StatCard label="Gross R" value={result.summary.grossR} dec={2} />
            <StatCard label="Fee R" value={result.summary.feeR} dec={2} />
            <StatCard label="Net R" value={result.summary.netR} dec={2} />
            <StatCard label="End Balance" value={result.summary.endBalance} dec={2} />
            <StatCard label="Max Lev Req" value={result.summary.maxRequiredLeverage} dec={2} />
            <StatCard label="Bad @ Lev" value={result.summary.infeasibleAtSelectedLeverage} dec={0} />
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1.25fr 1fr', gap:16, marginBottom:16 }}>
            <div className="card">
              <h3>Engine diagnostics</h3>
              <table className="sim-table">
                <thead>
                  <tr>
                    <th>Engine</th><th>Raw</th><th>Blocked</th><th>Pending</th><th>Cancelled</th><th>Settled</th>
                    <th>Signal Gross R</th><th>Filled</th><th>Missed</th><th>No Touch</th><th>Prob Miss</th><th>Wins</th><th>Losses</th><th>Gross R</th><th>Fee R</th><th>Net R</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(result.engineStats).map(([id, s]) => (
                    <tr key={id}>
                      <td>{id}</td><td>{s.raw}</td><td>{s.blocked}</td><td>{s.pending}</td><td>{s.cancelled}</td><td>{s.settled}</td>
                      <td>{fmt(s.signalGrossR,2)}</td><td>{s.filled}</td><td>{s.missed}</td><td>{s.missedNoTouch}</td><td>{s.missedProb}</td><td>{s.wins}</td><td>{s.losses}</td><td>{fmt(s.executedGrossR,2)}</td><td>{fmt(s.feeR,2)}</td><td>{fmt(s.executedNetR,2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card">
              <h3>Execution / fees audit</h3>
              <div>Start balance: {fmt(result.summary.startBalance, 2)}</div>
              <div>End balance: {fmt(result.summary.endBalance, 2)}</div>
              <div>Fees deducted: {fmt(result.summary.totalFeeUsd, 2)}</div>
              <div>TP / SL / Timeout: {result.summary.wins} / {result.summary.losses} / {result.summary.timeouts}</div>
              <div>Net-positive trades: {result.summary.netPositiveTrades}</div>
              <div>Clean gross from status formula: {fmt(result.summary.cleanGrossRFromStatus, 2)}R</div>
              <div>Gross R difference vs status formula: {fmt(result.summary.grossRDiffFromStatusFormula, 2)}R</div>
              <div>Missed insufficient equity: {result.summary.missedInsufficientEquity}</div>
              <div>Missed leverage infeasible: {result.summary.missedLeverageInfeasible}</div>
              <div>Total turnover: {fmt(result.summary.totalTurnover, 2)}</div>
              <div>Fee / total turnover: {fmt(result.summary.feeTurnoverPct, 4)}%</div>
              <div>Round-trip fee vs one-way notional: {fmt(result.summary.roundTripFeeOneWayPct, 4)}%</div>
              <div>Avg fee / trade: {fmt(result.summary.avgFeePerTrade, 2)}</div>
              <div>Avg fee R: {fmt(result.summary.avgFeeR, 4)}</div>
              <div>Median fee R: {fmt(result.summary.medianFeeR, 4)}</div>
              <div>Avg notional: {fmt(result.summary.avgNotional, 2)}</div>
              <div>Median notional: {fmt(result.summary.medianNotional, 2)}</div>
              <div>Avg required leverage: {fmt(result.summary.avgRequiredLeverage, 2)}x</div>
              <div>Median required leverage: {fmt(result.summary.medianRequiredLeverage, 2)}x</div>
              <div>Max required leverage: {fmt(result.summary.maxRequiredLeverage, 2)}x</div>
              <div>Selected leverage: {fmt(result.summary.selectedLeverage, 0)}x</div>
              <div>Infeasible at selected leverage: {fmt(result.summary.infeasibleAtSelectedLeverage, 0)}</div>
              <div>Leverage checks: <code>{JSON.stringify(result.summary.leverageFeasibility || {})}</code></div>
              <div>Avg SL distance: {fmt(result.summary.avgSLDistance, 4)} pts</div>
              <div>Median SL distance: {fmt(result.summary.medianSLDistance, 4)} pts</div>
              <div>Avg entry slip: {fmt(result.summary.avgEntrySlip, 4)} pts</div>
              <div>Avg TP slip: {fmt(result.summary.avgTPSlip, 4)} pts</div>
              <div>Avg SL slip: {fmt(result.summary.avgSLSlip, 4)} pts</div>
              <div>Maker entries: {result.summary.makerEntries}</div>
              <div>Taker entries: {result.summary.takerEntries}</div>
              <div>TP maker exits: {result.summary.tpMakerCount}</div>
              <div>TP taker exits: {result.summary.tpTakerCount}</div>
              <div>TP fallback exits: {result.summary.tpFallbackCount}</div>
              <div>GTX passive misses toward TP: {result.summary.gtxPassiveMissTowardTP}</div>
              <div>GTX rejected/crossing toward SL: {result.summary.gtxRejectedTowardSL}</div>
              <div>GTX accepted near-entry maker fills: {result.summary.gtxAcceptedNearEntry}</div>
              <div>GTX rejected toward TP: {result.summary.gtxRejectTowardTP} <span style={{color:'var(--text3)'}}>(should be near 0 under corrected latency/open logic)</span></div>
              <div>GTX reject→taker fallback entries: {result.summary.gtxRejectTakerFallbackEntries}</div>
              <div>GTX attempt→market fallback entries: {result.summary.makerAttemptMarketFallbackEntries}</div>
              <div>Passive miss toward TP by engine: <code>{JSON.stringify(result.summary.gtxPassiveMissTowardTPByEngine || {})}</code></div>
              <div>Rejected toward SL by engine: <code>{JSON.stringify(result.summary.gtxRejectedTowardSLByEngine || {})}</code></div>
            </div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16 }}>
            <div className="card">
              <h3>Signal vs fill bias</h3>
              <div>Total signals: {result.summary.signalCount}</div>
              <div>Filled trades: {result.summary.filledCount}</div>
              <div>Missed trades: {result.summary.missedCount}</div>
              <div>Missed no touch: {result.summary.missedNoTouch}</div>
              <div>Missed after touch/probability: {result.summary.missedProb}</div>
              <div>P(win | signal): {fmt(result.summary.signalWinRate*100, 2)}%</div>
              <div>P(win | filled): {fmt(result.summary.filledWinRate*100, 2)}%</div>
              <div>Bias ratio: {fmt(result.summary.biasRatio, 4)}</div>
              <div>Missed winners: {result.summary.missedWinners}</div>
              <div>Missed losers: {result.summary.missedLosers}</div>
            </div>
            <div className="card">
              <h3>Exports</h3>
              <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                <button onClick={() => downloadJson(`${result.runMeta?.runId || 'eth-sim'}__trades.json`, { runMeta: result.runMeta, rows: result.results })}>Download trades</button>
                <button onClick={() => downloadJson(`${result.runMeta?.runId || 'eth-sim'}__missed.json`, { runMeta: result.runMeta, rows: result.missedSignals })}>Download missed</button>
                <button onClick={() => downloadJson(`${result.runMeta?.runId || 'eth-sim'}__signals.json`, { runMeta: result.runMeta, rows: result.signalLedger })}>Download signal ledger</button>
                <button onClick={() => downloadJson(`${result.runMeta?.runId || 'eth-sim'}__summary.json`, { runMeta: result.runMeta, summary: result.summary, engineStats: result.engineStats, actualConfig: result.actualConfig, yearByYear: result.yearByYear })}>Download summary</button>
                <button onClick={() => downloadJson(`${result.runMeta?.runId || 'eth-sim'}__full_package.json`, { runMeta: result.runMeta, summary: result.summary, engineStats: result.engineStats, actualConfig: result.actualConfig, yearByYear: result.yearByYear, trades: result.results, missed: result.missedSignals, signalLedger: result.signalLedger })}>Download full package</button>
                <button onClick={() => downloadJson(`eth-sim-run-history.json`, runHistory)}>Download run history</button>
              </div>
              <h3>Actual config used</h3>
              <pre style={{ whiteSpace:'pre-wrap', fontSize:11, maxHeight:320, overflow:'auto' }}>{JSON.stringify(result.actualConfig, null, 2)}</pre>
            </div>
          </div>

          <div className="card" style={{ marginBottom:16 }}>
            <h3>Run history in this browser session</h3>
            <div style={{ color:'var(--text3)', fontSize:12, marginBottom:8 }}>Each run receives a unique Run ID and exports include the exact parameters used. Download run history for side-by-side comparison summaries.</div>
            <table className="sim-table">
              <thead><tr><th>Run ID</th><th>Years</th><th>D entry</th><th>E entry</th><th>TP mode</th><th>WR %</th><th>Net R</th><th>Fee R</th><th>Filled</th><th>Missed</th></tr></thead>
              <tbody>
                {runHistory.slice(0, 8).map(h => (
                  <tr key={h.runId}><td style={{ maxWidth:260, overflow:'hidden', textOverflow:'ellipsis' }}>{h.runId}</td><td>{h.selectedYears.join(',')}</td><td>{h.modeSummary.dEntryMode}/{h.modeSummary.dGtxModel}</td><td>{h.modeSummary.eEntryMode}/{h.modeSummary.eGtxModel}</td><td>{h.modeSummary.tpMode}</td><td>{fmt(h.summary.winRate*100,2)}</td><td>{fmt(h.summary.netR,2)}</td><td>{fmt(h.summary.feeR,2)}</td><td>{h.summary.filledCount}</td><td>{h.summary.missedCount}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card" style={{ marginBottom:16 }}>
            <h3>Year-by-year summary</h3>
            <table className="sim-table">
              <thead>
                <tr><th>Year</th><th>Chunks</th><th>Candles</th><th>Signals</th><th>Filled</th><th>Missed</th><th>WR %</th><th>Gross R</th><th>Fee R</th><th>Net R</th><th>PnL USD</th><th>Fees USD</th><th>Avg Fee R</th></tr>
              </thead>
              <tbody>
                {result.yearByYear.map(y => (
                  <tr key={y.year}>
                    <td>{y.year}</td><td>{y.chunks}</td><td>{y.candles.toLocaleString()}</td><td>{y.signals}</td><td>{y.trades}</td><td>{y.missed}</td><td>{fmt(y.wr*100,2)}</td><td>{fmt(y.grossR,2)}</td><td>{fmt(y.feeR,2)}</td><td>{fmt(y.netR,2)}</td><td>{fmt(y.pnlUsd,2)}</td><td>{fmt(y.fees,2)}</td><td>{fmt(y.avgFeeR,4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3>Recent trade rows</h3>
            <table className="sim-table">
              <thead>
                <tr>
                  <th>Engine</th><th>Status</th><th>Side</th><th>Entry</th><th>Exit</th><th>Raw TP</th><th>Exec TP</th><th>Gross R</th><th>Fee R</th><th>Net R</th>
                  <th>PnL USD</th><th>Entry fee</th><th>Exit fee</th><th>Fee types</th><th>Entry reason</th><th>TP exit</th><th>Entry slip</th><th>TP slip</th><th>SL slip</th><th>Entry notional</th>
                </tr>
              </thead>
              <tbody>
                {[...(result.results || [])].slice(-80).reverse().map((r, idx) => (
                  <tr key={idx}>
                    <td>{r.engine}</td><td>{r.status}</td><td>{r.side}</td><td>{fmt(r.entry,2)}</td><td>{fmt(r.exit,2)}</td><td>{fmt(r.rawTp,2)}</td><td>{fmt(r.executionTp,2)}</td><td>{fmt(r.grossRBeforeFees,4)}</td><td>{fmt(r.feeR,4)}</td><td>{fmt(r.pnlR,4)}</td>
                    <td>{fmt(r.pnlUsd,2)}</td><td>{fmt(r.entryFeeUsd,2)}</td><td>{fmt(r.exitFeeUsd,2)}</td><td>{r.entryFeeType}/{r.exitFeeType}</td><td>{r.entryFillReason}</td><td>{r.tpExitMode}</td><td>{fmt(r.entrySlip,4)}</td><td>{fmt(r.tpSlip,4)}</td><td>{fmt(r.slSlip,4)}</td><td>{fmt(r.entryNotional,2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
