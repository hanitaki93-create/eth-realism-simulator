import React, { useMemo, useState } from 'react';
import ScenarioForm from './components/ScenarioForm.jsx';
import { DEFAULT_CONFIG, simulateScenario } from './simulatorCore.js';

const fmt = (n, d = 2) => n == null ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

function mergeEngineStats(yearly) {
  const merged = {};
  for (const y of yearly) {
    for (const [id, s] of Object.entries(y.engineStats || {})) {
      if (!merged[id]) merged[id] = { signals: 0, filled: 0, gtxRejected: 0, timeoutMissed: 0, wins: 0, losses: 0, timeouts: 0, netR: 0 };
      for (const key of Object.keys(merged[id])) merged[id][key] += Number(s[key] || 0);
    }
  }
  return merged;
}

export default function App() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('Select year(s) and run a scenario.');

  async function runScenario() {
    const years = [...(config.selectedYears || [])].sort();
    if (!years.length) {
      setStatus('Error: select at least one year.');
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      let runningBalance = Number(config.startingBalance || 10000);
      const yearly = [];

      for (const year of years) {
        setStatus(`Fetching ${year} candles…`);
        const resp = await fetch(`/api/klines-year?symbol=${config.symbol}&interval=${config.interval}&year=${year}`);
        const json = await resp.json();
        if (!json.ok) throw new Error(json.error || `Failed to fetch ${year}`);

        setStatus(`Running ${year} simulation on ${json.candles.length.toLocaleString()} candles…`);
        const sim = simulateScenario(json.candles, { ...config, startingBalance: runningBalance });
        yearly.push({ year, candles: json.candles.length, summary: sim.summary, engineStats: sim.engineStats, results: sim.results });
        runningBalance = sim.summary.endBalance;
      }

      const allClosedTrades = yearly.flatMap(y => (y.results || []).filter(r => ['TP', 'SL', 'TIMEOUT'].includes(r.status)));
      const totalNetR = yearly.reduce((s, y) => s + (y.summary?.netR || 0), 0);
      const totalFees = yearly.reduce((s, y) => s + (y.summary?.totalFeeUsd || 0), 0);
      const wins = allClosedTrades.filter(r => r.status === 'TP').length;
      const losses = allClosedTrades.filter(r => r.status === 'SL').length;
      const timeouts = allClosedTrades.filter(r => r.status === 'TIMEOUT').length;
      const avgR = allClosedTrades.length ? totalNetR / allClosedTrades.length : 0;
      const winRate = (wins + losses) ? wins / (wins + losses) : 0;

      setResult({
        yearly,
        summary: {
          trades: allClosedTrades.length,
          wins,
          losses,
          timeouts,
          winRate,
          netR: totalNetR,
          avgR,
          startBalance: Number(config.startingBalance || 10000),
          endBalance: yearly.at(-1)?.summary?.endBalance ?? Number(config.startingBalance || 10000),
          totalFeeUsd: totalFees,
          avgSLSlip: yearly.length ? yearly.reduce((s, y) => s + (y.summary?.avgSLSlip || 0), 0) / yearly.length : 0,
          avgTPSlip: yearly.length ? yearly.reduce((s, y) => s + (y.summary?.avgTPSlip || 0), 0) / yearly.length : 0,
          loadedCandles: yearly.reduce((s, y) => s + y.candles, 0)
        },
        engineStats: mergeEngineStats(yearly),
        results: allClosedTrades
      });

      setStatus(`Simulation complete. ${allClosedTrades.length.toLocaleString()} closed trades across ${years.join(', ')}.`);
    } catch (e) {
      setStatus(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  const topRows = useMemo(() => (result?.results || []).slice(-50).reverse(), [result]);

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: 20 }}>
      <h1 style={{ marginBottom: 4 }}>ETH Binance Realism Simulator</h1>
      <div style={{ color: 'var(--text2)', marginBottom: 16 }}>MVP built on top of the V5 baseline engine code.</div>

      <ScenarioForm config={config} setConfig={setConfig} onRun={runScenario} loading={loading} />

      <div className="card" style={{ marginBottom: 16 }}>{status}</div>

      {result && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            Loaded candles: {result.summary.loadedCandles.toLocaleString()}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, minmax(0,1fr))', gap: 10, marginBottom: 16 }}>
            {[
              ['Trades', result.summary.trades, 0],
              ['Wins', result.summary.wins, 0],
              ['Losses', result.summary.losses, 0],
              ['Win Rate %', result.summary.winRate * 100, 2],
              ['Net R', result.summary.netR, 2],
              ['Avg R', result.summary.avgR, 2],
              ['End Balance', result.summary.endBalance, 2],
              ['Fees USD', result.summary.totalFeeUsd, 2],
            ].map(([label, value, d]) => (
              <div key={label} className="card">
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>{label}</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{fmt(value, d)}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div className="card">
              <h3 style={{ marginBottom: 10 }}>Engine breakdown</h3>
              <table className="sim-table">
                <thead>
                  <tr><th>Engine</th><th>Signals</th><th>Filled</th><th>GTX rej</th><th>Missed</th><th>Wins</th><th>Losses</th><th>Net R</th></tr>
                </thead>
                <tbody>
                  {Object.entries(result.engineStats).map(([id, s]) => (
                    <tr key={id}>
                      <td>{id}</td>
                      <td>{s.signals}</td>
                      <td>{s.filled}</td>
                      <td>{s.gtxRejected}</td>
                      <td>{s.timeoutMissed}</td>
                      <td>{s.wins}</td>
                      <td>{s.losses}</td>
                      <td>{fmt(s.netR, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card">
              <h3 style={{ marginBottom: 10 }}>Execution summary</h3>
              <div>Avg SL slip: {fmt(result.summary.avgSLSlip, 2)} pts</div>
              <div>Avg TP slip: {fmt(result.summary.avgTPSlip, 2)} pts</div>
              <div>Start balance: {fmt(result.summary.startBalance, 2)}</div>
              <div>End balance: {fmt(result.summary.endBalance, 2)}</div>
              <div style={{ marginTop: 10, color: 'var(--text3)' }}>Config snapshot</div>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, marginTop: 8 }}>{JSON.stringify(config, null, 2)}</pre>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ marginBottom: 10 }}>Year-by-year summary</h3>
            <table className="sim-table">
              <thead>
                <tr><th>Year</th><th>Candles</th><th>Trades</th><th>WR %</th><th>Net R</th><th>Start</th><th>End</th><th>Fees</th></tr>
              </thead>
              <tbody>
                {result.yearly.map(y => (
                  <tr key={y.year}>
                    <td>{y.year}</td>
                    <td>{y.candles.toLocaleString()}</td>
                    <td>{y.summary.trades}</td>
                    <td>{fmt(y.summary.winRate * 100, 2)}</td>
                    <td>{fmt(y.summary.netR, 2)}</td>
                    <td>{fmt(y.summary.startBalance, 2)}</td>
                    <td>{fmt(y.summary.endBalance, 2)}</td>
                    <td>{fmt(y.summary.totalFeeUsd, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3 style={{ marginBottom: 10 }}>Recent trade rows</h3>
            <table className="sim-table">
              <thead>
                <tr><th>Engine</th><th>Status</th><th>Side</th><th>Entry</th><th>Exit</th><th>PnL USD</th><th>PnL R</th><th>Entry fee</th><th>Exit fee</th></tr>
              </thead>
              <tbody>
                {topRows.map((r, idx) => (
                  <tr key={`${r.engine}-${r.signalTime}-${idx}`}>
                    <td>{r.engine}</td>
                    <td>{r.status}</td>
                    <td>{r.side}</td>
                    <td>{fmt(r.entry, 2)}</td>
                    <td>{fmt(r.exitPrice, 2)}</td>
                    <td style={{ color: r.pnlUsd >= 0 ? '#4ade80' : '#f87171' }}>{fmt(r.pnlUsd, 2)}</td>
                    <td>{fmt(r.pnlR, 2)}</td>
                    <td>{fmt(r.entryFeeUsd, 2)}</td>
                    <td>{fmt(r.exitFeeUsd, 2)}</td>
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
