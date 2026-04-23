import React, { useMemo, useState } from 'react';
import ScenarioForm from './components/ScenarioForm.jsx';
import { DEFAULT_CONFIG, simulateScenario } from './simulatorCore.js';

const API_BASE = 'http://157.230.252.80:3001';
const INTERVAL_MS = { '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
const fmt = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toFixed(d));

function candleCountForYear(year, interval) {
  const start = Date.UTC(year, 0, 1, 0, 0, 0);
  const end = Date.UTC(year + 1, 0, 1, 0, 0, 0);
  const ms = INTERVAL_MS[interval] || 300000;
  return Math.floor((end - start) / ms);
}

async function fetchYearCandles(symbol, interval, year) {
  const startTime = Date.UTC(year, 0, 1, 0, 0, 0);
  const limit = candleCountForYear(year, interval);
  const url = `${API_BASE}/api/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}&startTime=${startTime}`;
  const resp = await fetch(url);
  const json = await resp.json();
  if (!json.ok) throw new Error(json.error || `Failed to fetch ${year}`);
  return { year, candles: json.candles || [], chunks: Math.ceil((json.candles?.length || 0) / 1000) };
}

export default function App() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [candles, setCandles] = useState([]);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('Select years and run.');
  const [yearsRun, setYearsRun] = useState([]);
  const [yearMeta, setYearMeta] = useState([]);

  async function runScenario() {
    setLoading(true);
    setResult(null);
    setCandles([]);
    try {
      const years = config.selectedYears?.length ? [...config.selectedYears].sort((a,b)=>a-b) : [2022];
      setYearsRun(years);
      setStatus(`Fetching ${years.join(', ')} …`);
      const fetched = [];
      for (const y of years) {
        const yr = await fetchYearCandles(config.symbol, config.interval, y);
        fetched.push(yr);
        setStatus(`Fetched ${y}: ${yr.candles.length.toLocaleString()} candles. Continuing…`);
      }
      const merged = fetched.flatMap(x => x.candles).sort((a,b)=>a.openTime - b.openTime);
      setYearMeta(fetched.map(x => ({ year: x.year, candles: x.candles.length, chunks: x.chunks })));
      setCandles(merged);

      const sim = simulateScenario(merged, { ...config, startingBalance: config.startingBalance });
      setResult(sim);
      setStatus(`Simulation complete. ${sim.summary.trades.toLocaleString()} closed trades across ${years.join(', ')}.`);
    } catch (e) {
      setStatus(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  const recentRows = useMemo(() => (result?.results || []).slice(-20).reverse(), [result]);
  const engineRows = useMemo(() => Object.entries(result?.engineStats || {}), [result]);

  return (
    <div style={{ maxWidth: 1500, margin:'0 auto', padding:20 }}>
      <h1 style={{ marginBottom:4 }}>ETH Binance Realism Simulator</h1>
      <div style={{ opacity:0.75, marginBottom:16 }}>Two-pass architecture: signal ledger first, execution overlay second.</div>

      <ScenarioForm config={config} setConfig={setConfig} onRun={runScenario} loading={loading} />
      <div className="card" style={{ marginBottom:16 }}>{status}</div>

      {result && (
        <>
          <div className="card" style={{ marginBottom:16 }}>
            <div><b>Years run:</b> {yearsRun.join(', ')}</div>
            <div><b>Loaded candles:</b> {candles.length.toLocaleString()}</div>
            <div><b>Actual risk mode:</b> {result.actualConfig.riskMode === 'pct' ? '% of account' : 'Fixed $'}</div>
            <div><b>Execution model:</b> {result.summary.executionModel} (fill probability {fmt(result.summary.fillProb, 2)})</div>
            <div><b>Max R used:</b> {fmt(result.summary.maxRiskUsed, 2)}</div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'repeat(10, minmax(0,1fr))', gap:10, marginBottom:16 }}>
            {[
              ['Signals', result.summary.totalSignals],
              ['Filled', result.summary.filledTrades],
              ['Missed', result.summary.missedTrades],
              ['Wins', result.summary.wins],
              ['Losses', result.summary.losses],
              ['Win Rate %', result.summary.winRate * 100],
              ['Net R', result.summary.netR],
              ['End Balance', result.summary.endBalance],
              ['Fees USD', result.summary.totalFeeUsd],
              ['Bias Ratio', result.summary.biasRatio],
            ].map(([label, value]) => (
              <div key={label} className="card">
                <div style={{ fontSize:11, opacity:0.7 }}>{label}</div>
                <div style={{ fontSize:22, fontWeight:700 }}>{fmt(value, ['Signals','Filled','Missed','Wins','Losses'].includes(label) ? 0 : 2)}</div>
              </div>
            ))}
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'1.15fr 0.85fr', gap:16, marginBottom:16 }}>
            <div className="card">
              <h3>Engine diagnostics</h3>
              <table className="sim-table">
                <thead>
                  <tr>
                    <th>Engine</th><th>Raw</th><th>Blocked</th><th>Pending</th><th>Cancelled</th><th>Activated</th><th>Settled</th><th>Filled</th><th>Missed</th><th>Wins</th><th>Losses</th><th>Net R</th>
                  </tr>
                </thead>
                <tbody>
                  {engineRows.map(([id, s]) => (
                    <tr key={id}>
                      <td>{id}</td>
                      <td>{fmt(s.raw,0)}</td>
                      <td>{fmt(s.blocked,0)}</td>
                      <td>{fmt(s.pending,0)}</td>
                      <td>{fmt(s.cancelled,0)}</td>
                      <td>{fmt(s.activated,0)}</td>
                      <td>{fmt(s.settled,0)}</td>
                      <td>{fmt(s.filled,0)}</td>
                      <td>{fmt(s.missed,0)}</td>
                      <td>{fmt(s.wins,0)}</td>
                      <td>{fmt(s.losses,0)}</td>
                      <td>{fmt(s.netR,2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="card">
              <h3>Execution summary</h3>
              <div>Start balance: {fmt(result.summary.startBalance, 2)}</div>
              <div>End balance: {fmt(result.summary.endBalance, 2)}</div>
              <div>Fees deducted: {fmt(result.summary.totalFeeUsd, 2)}</div>
              <div>Total turnover: {fmt(result.summary.totalTurnover, 2)}</div>
              <div>Fee / turnover: {fmt((result.summary.feeToTurnover || 0) * 100, 3)}%</div>
              <div>Avg fee / trade: {fmt(result.summary.avgFeePerTrade, 2)}</div>
              <div>Avg turnover / trade: {fmt(result.summary.avgTurnoverPerTrade, 2)}</div>
              <div>Avg SL slip: {fmt(result.summary.avgSLSlip, 2)} pts</div>
              <div>Avg TP slip: {fmt(result.summary.avgTPSlip, 2)} pts</div>
              <div>Missed winners: {fmt(result.summary.missedWinners, 0)}</div>
              <div>Missed losers: {fmt(result.summary.missedLosers, 0)}</div>
              <div>P(win | signal): {fmt((result.summary.pWinSignal || 0) * 100, 2)}%</div>
              <div>P(win | filled): {fmt((result.summary.pWinFilled || 0) * 100, 2)}%</div>
            </div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'0.9fr 1.1fr', gap:16 }}>
            <div className="card">
              <h3>Year load summary</h3>
              <table className="sim-table">
                <thead><tr><th>Year</th><th>Chunks</th><th>Candles</th></tr></thead>
                <tbody>
                  {yearMeta.map(y => (
                    <tr key={y.year}><td>{y.year}</td><td>{y.chunks}</td><td>{y.candles.toLocaleString()}</td></tr>
                  ))}
                </tbody>
              </table>
              <h3 style={{ marginTop: 16 }}>Actual config used</h3>
              <pre style={{ whiteSpace:'pre-wrap', fontSize:11 }}>{JSON.stringify(result.actualConfig, null, 2)}</pre>
            </div>

            <div className="card">
              <h3>Recent trade rows</h3>
              <table className="sim-table">
                <thead>
                  <tr>
                    <th>Engine</th><th>Status</th><th>Side</th><th>Entry</th><th>Exit</th><th>Gross</th><th>PnL USD</th><th>PnL R</th><th>Entry fee</th><th>Exit fee</th><th>Entry notional</th><th>Exit notional</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRows.map((r, idx) => (
                    <tr key={idx}>
                      <td>{r.engine}</td><td>{r.status}</td><td>{r.side}</td>
                      <td>{fmt(r.entry,2)}</td><td>{fmt(r.exitPrice,2)}</td><td>{fmt(r.grossPnl,2)}</td>
                      <td>{fmt(r.pnlUsd,2)}</td><td>{fmt(r.pnlR,2)}</td><td>{fmt(r.entryFeeUsd,2)}</td>
                      <td>{fmt(r.exitFeeUsd,2)}</td><td>{fmt(r.entryNotional,2)}</td><td>{fmt(r.exitNotional,2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
