import React, { useMemo, useState } from 'react';
import ScenarioForm from './components/ScenarioForm.jsx';
import { DEFAULT_CONFIG, simulateScenario } from './simulatorCore.js';

const fmt = (n, d=2) => n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toFixed(d);

export default function App() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [candles, setCandles] = useState([]);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('Load candles and run a scenario.');

  async function runScenario() {
    setLoading(true);
    setResult(null);
    setStatus('Fetching candles…');
    try {
      const resp = await fetch(`/api/klines?symbol=${config.symbol}&interval=${config.interval}&limit=110000`);
      const json = await resp.json();
      if (!json.ok) throw new Error(json.error || 'Failed to fetch candles');
      setCandles(json.candles);
      setStatus(`Fetched ${json.candles.length.toLocaleString()} candles. Running simulation…`);
      const sim = simulateScenario(json.candles, config);
      setResult(sim);
      setStatus(`Simulation complete. ${sim.summary.trades} closed trades from ${json.candles.length.toLocaleString()} candles.`);
    } catch (e) {
      setStatus(`Error: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  const topRows = useMemo(() => (result?.results || []).filter(Boolean).slice(-50).reverse(), [result]);

  return (
    <div style={{ maxWidth: 1400, margin:'0 auto', padding:20 }}>
      <h1 style={{ marginBottom: 4 }}>ETH Binance Realism Simulator</h1>
      <div style={{ color:'var(--text3)', marginBottom: 16 }}>MVP built on top of the V5 baseline engine code.</div>
      <ScenarioForm config={config} setConfig={setConfig} onRun={runScenario} loading={loading} />
      <div className="card" style={{ marginBottom:16 }}>{status}</div>
      {!!candles.length && <div className="card" style={{ marginBottom:16 }}>Loaded candles: {candles.length.toLocaleString()}</div>}
      {result && (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(8, minmax(0,1fr))', gap:10, marginBottom:16 }}>
            {[
              ['Trades', result.summary.trades],
              ['Wins', result.summary.wins],
              ['Losses', result.summary.losses],
              ['Win Rate %', result.summary.winRate*100],
              ['Net R', result.summary.netR],
              ['Avg R', result.summary.avgR],
              ['End Balance', result.summary.endBalance],
              ['Fees USD', result.summary.totalFeeUsd],
            ].map(([label, value]) => <div key={label} className="card"><div style={{fontSize:11,color:'var(--text3)'}}>{label}</div><div style={{fontSize:22,fontWeight:700}}>{fmt(value, label==='Trades'||label==='Wins'||label==='Losses'?0:2)}</div></div>)}
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16 }}>
            <div className="card">
              <h3>Engine breakdown</h3>
              <table className="sim-table"><thead><tr><th>Engine</th><th>Signals</th><th>Filled</th><th>GTX rej</th><th>Missed</th><th>Wins</th><th>Losses</th><th>Net R</th></tr></thead><tbody>
                {Object.entries(result.engineStats).map(([id, s]) => <tr key={id}><td>{id}</td><td>{s.signals}</td><td>{s.filled}</td><td>{s.gtxRejected}</td><td>{s.timeoutMissed}</td><td>{s.wins}</td><td>{s.losses}</td><td>{fmt(s.netR,2)}</td></tr>)}
              </tbody></table>
            </div>
            <div className="card">
              <h3>Execution summary</h3>
              <div>Avg SL slip: {fmt(result.summary.avgSLSlip, 2)} pts</div>
              <div>Avg TP slip: {fmt(result.summary.avgTPSlip, 2)} pts</div>
              <div>Start balance: {fmt(result.summary.startBalance, 2)}</div>
              <div>End balance: {fmt(result.summary.endBalance, 2)}</div>
              <div>Config snapshot:</div>
              <pre style={{ whiteSpace:'pre-wrap', fontSize:11 }}>{JSON.stringify(config, null, 2)}</pre>
            </div>
          </div>
          <div className="card">
            <h3>Recent trade rows</h3>
            <table className="sim-table"><thead><tr><th>Engine</th><th>Status</th><th>Side</th><th>Entry</th><th>Exit</th><th>PnL R</th><th>Slip</th><th>Entry Maker</th></tr></thead><tbody>
              {topRows.map((r, idx) => <tr key={idx}><td>{r.engine}</td><td>{r.status}</td><td>{r.side || '—'}</td><td>{fmt(r.entry,2)}</td><td>{fmt(r.exitPrice,2)}</td><td>{fmt(r.pnlR,2)}</td><td>{fmt(r.slippagePts,2)}</td><td>{r.entryMaker == null ? '—' : String(r.entryMaker)}</td></tr>)}
            </tbody></table>
          </div>
        </>
      )}
    </div>
  );
}
