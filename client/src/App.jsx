
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

export default function App() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('Ready.');

  async function fetchYearCandles(year, symbol, interval) {
    const { start, end } = yearBounds(year);
    const intervalMs = 5 * 60 * 1000;
    const total = Math.floor((end - start) / intervalMs);
    const resp = await fetch(`/api/klines?symbol=${symbol}&interval=${interval}&limit=${total}&startTime=${start}`);
    const json = await resp.json();
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
      setStatus(`Loaded ${allCandles.length.toLocaleString()} candles. Running simulation…`);
      const sim = simulateScenario(allCandles, config);

      let cursor = config.startingBalance;
      const yearByYear = yearly.map(({ year, candles, chunks }) => {
        const start = candles[0]?.openTime ?? 0;
        const end = candles[candles.length - 1]?.closeTime ?? 0;
        const rows = sim.results.filter(r => {
          const ts = allCandles[r.settleIdx]?.closeTime ?? 0;
          return ts >= start && ts <= end;
        });
        const fees = rows.reduce((a, r) => a + r.totalFeeUsd, 0);
        const netR = rows.reduce((a, r) => a + r.pnlR, 0);
        const wins = rows.filter(r => r.pnlR > 0).length;
        const endBal = cursor + rows.reduce((a, r) => a + r.pnlUsd, 0);
        const summary = {
          year,
          chunks,
          candles: candles.length,
          trades: rows.length,
          wr: rows.length ? wins / rows.length : 0,
          netR,
          start: cursor,
          end: endBal,
          fees
        };
        cursor = endBal;
        return summary;
      });

      setResult({
        ...sim,
        yearsRun: years,
        loadedCandles: allCandles.length,
        yearByYear
      });
      setStatus(`Simulation complete. ${sim.summary.trades.toLocaleString()} closed trades across ${years.join(', ')}.`);
    } catch (e) {
      setStatus(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 1500, margin: '0 auto', padding: 20 }}>
      <h1 style={{ marginBottom: 4 }}>ETH Binance Realism Simulator</h1>
      <div style={{ color: 'var(--text3)', marginBottom: 16 }}>Two-pass version: signal ledger first, execution overlay second.</div>
      <ScenarioForm config={config} setConfig={setConfig} onRun={runScenario} loading={loading} />
      <div className="card" style={{ marginBottom: 16 }}>{status}</div>

      {result && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            Simulation complete. {result.summary.trades.toLocaleString()} closed trades across {result.yearsRun.join(', ')}.<br/>
            Years run: {result.yearsRun.join(', ')}<br/>
            Loaded candles: {result.loadedCandles.toLocaleString()}<br/>
            Actual risk mode: {result.actualConfig.riskMode === 'pct' ? '% of account' : 'Fixed $'}<br/>
            Max R used: {fmt(result.summary.maxRiskUsed, 2)}
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'repeat(8, minmax(0,1fr))', gap:10, marginBottom:16 }}>
            {[
              ['Trades', result.summary.trades, 0],
              ['Wins', result.summary.wins, 0],
              ['Losses', result.summary.losses, 0],
              ['Win Rate %', result.summary.winRate*100, 2],
              ['Net R', result.summary.netR, 2],
              ['Avg R', result.summary.avgR, 2],
              ['End Balance', result.summary.endBalance, 2],
              ['Fees USD', result.summary.totalFeeUsd, 2],
            ].map(([label, value, dec]) => (
              <div key={label} className="card">
                <div style={{fontSize:11,color:'var(--text3)'}}>{label}</div>
                <div style={{fontSize:22,fontWeight:700}}>{fmt(value, dec)}</div>
              </div>
            ))}
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1.2fr 1fr', gap:16, marginBottom:16 }}>
            <div className="card">
              <h3>Engine diagnostics</h3>
              <table className="sim-table">
                <thead>
                  <tr><th>Engine</th><th>Raw</th><th>Blocked</th><th>Pending</th><th>Cancelled</th><th>Activated</th><th>GTX Rej</th><th>Missed</th><th>Settled</th><th>Wins</th><th>Losses</th><th>Net R</th></tr>
                </thead>
                <tbody>
                  {Object.entries(result.engineStats).map(([id, s]) => (
                    <tr key={id}>
                      <td>{id}</td><td>{s.raw}</td><td>{s.blocked}</td><td>{s.pending}</td><td>{s.cancelled}</td><td>{s.activated}</td><td>{s.gtxRejected}</td><td>{s.missed}</td><td>{s.settled}</td><td>{s.wins}</td><td>{s.losses}</td><td>{fmt(s.netR,2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card">
              <h3>Execution summary</h3>
              <div>Avg SL slip: {fmt(result.summary.avgSLSlip, 2)} pts</div>
              <div>Avg TP slip: {fmt(result.summary.avgTPSlip, 2)} pts</div>
              <div>Start balance: {fmt(result.summary.startBalance, 2)}</div>
              <div>End balance: {fmt(result.summary.endBalance, 2)}</div>
              <div>Fees deducted: {fmt(result.summary.totalFeeUsd, 2)}</div>
              <div>Total turnover: {fmt(result.summary.totalTurnover, 2)}</div>
              <div>Fee / turnover: {fmt(result.summary.feeTurnoverPct, 4)}%</div>
              <div>Avg fee / trade: {fmt(result.summary.avgFeePerTrade, 2)}</div>
              <div>Avg turnover / trade: {fmt(result.summary.avgTurnoverPerTrade, 2)}</div>
            </div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16 }}>
            <div className="card">
              <h3>Signal vs fill bias</h3>
              <div>Total signals: {result.summary.signalCount}</div>
              <div>Filled trades: {result.summary.filledCount}</div>
              <div>Missed trades: {result.summary.missedCount}</div>
              <div>P(win|signal): {fmt(result.summary.signalWinRate*100, 2)}%</div>
              <div>P(win|filled): {fmt(result.summary.filledWinRate*100, 2)}%</div>
              <div>Bias ratio: {fmt(result.summary.biasRatio, 4)}</div>
              <div>Missed winners: {result.summary.missedWinners}</div>
              <div>Missed losers: {result.summary.missedLosers}</div>
            </div>
            <div className="card">
              <h3>Actual config used</h3>
              <pre style={{ whiteSpace:'pre-wrap', fontSize:11 }}>{JSON.stringify(result.actualConfig, null, 2)}</pre>
            </div>
          </div>

          <div className="card" style={{ marginBottom:16 }}>
            <h3>Year-by-year summary</h3>
            <table className="sim-table">
              <thead><tr><th>Year</th><th>Chunks</th><th>Candles</th><th>Trades</th><th>WR %</th><th>Net R</th><th>Start</th><th>End</th><th>Fees</th></tr></thead>
              <tbody>
                {result.yearByYear.map(y => (
                  <tr key={y.year}>
                    <td>{y.year}</td><td>{y.chunks}</td><td>{y.candles.toLocaleString()}</td><td>{y.trades}</td><td>{fmt(y.wr*100,2)}</td><td>{fmt(y.netR,2)}</td><td>{fmt(y.start,2)}</td><td>{fmt(y.end,2)}</td><td>{fmt(y.fees,2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3>Recent trade rows</h3>
            <table className="sim-table">
              <thead>
                <tr><th>Engine</th><th>Status</th><th>Side</th><th>Entry</th><th>Exit</th><th>Gross</th><th>PnL USD</th><th>PnL R</th><th>Entry fee</th><th>Exit fee</th><th>Entry notional</th><th>Exit notional</th></tr>
              </thead>
              <tbody>
                {[...(result.results || [])].slice(-50).reverse().map((r, idx) => (
                  <tr key={idx}>
                    <td>{r.engine}</td><td>{r.status}</td><td>{r.side}</td><td>{fmt(r.entry,2)}</td><td>{fmt(r.exit,2)}</td><td>{fmt(r.grossPnl,2)}</td><td>{fmt(r.pnlUsd,2)}</td><td>{fmt(r.pnlR,2)}</td><td>{fmt(r.entryFeeUsd,2)}</td><td>{fmt(r.exitFeeUsd,2)}</td><td>{fmt(r.entryNotional,2)}</td><td>{fmt(r.exitNotional,2)}</td>
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
