import React, { useMemo, useState } from 'react';
import ScenarioForm from './components/ScenarioForm.jsx';
import { DEFAULT_CONFIG, simulateScenario } from './simulatorCore.js';

const fmt = (n, d=2) => n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toFixed(d);
const YEARS = [2022, 2023, 2024, 2025];

function yearRange(year) {
  return {
    startTime: Date.UTC(year, 0, 1, 0, 0, 0, 0),
    endTime: Date.UTC(year + 1, 0, 1, 0, 0, 0, 0) - 1,
  };
}

function mergeEngineStats(target, source) {
  for (const [id, s] of Object.entries(source || {})) {
    if (!target[id]) target[id] = { signals: 0, filled: 0, gtxRejected: 0, timeoutMissed: 0, wins: 0, losses: 0, timeouts: 0, netR: 0 };
    for (const key of Object.keys(target[id])) target[id][key] += Number(s[key] || 0);
  }
}

function combineRuns(runResults, startingBalance) {
  const combined = {
    summary: {
      trades: 0, wins: 0, losses: 0, timeouts: 0,
      winRate: 0, netR: 0, avgR: 0,
      startBalance: startingBalance,
      endBalance: startingBalance,
      riskBalanceEnd: startingBalance,
      totalFeeUsd: 0,
      avgSLSlip: 0,
      avgTPSlip: 0,
    },
    engineStats: {},
    results: [],
    yearRuns: runResults,
  };

  for (const yr of runResults) {
    combined.summary.trades += yr.summary.trades;
    combined.summary.wins += yr.summary.wins;
    combined.summary.losses += yr.summary.losses;
    combined.summary.timeouts += yr.summary.timeouts;
    combined.summary.netR += yr.summary.netR;
    combined.summary.totalFeeUsd += yr.summary.totalFeeUsd;
    combined.results.push(...yr.results);
    mergeEngineStats(combined.engineStats, yr.engineStats);
    combined.summary.endBalance = yr.summary.endBalance;
    combined.summary.riskBalanceEnd = yr.summary.riskBalanceEnd;
  }

  const closedTrades = combined.summary.trades;
  combined.summary.avgR = closedTrades ? combined.summary.netR / closedTrades : 0;
  combined.summary.winRate = (combined.summary.wins + combined.summary.losses)
    ? combined.summary.wins / (combined.summary.wins + combined.summary.losses)
    : 0;

  const slRows = combined.results.filter(r => r?.status === 'SL');
  const tpRows = combined.results.filter(r => r?.status === 'TP');
  combined.summary.avgSLSlip = slRows.length ? slRows.reduce((s, r) => s + Number(r.slippagePts || 0), 0) / slRows.length : 0;
  combined.summary.avgTPSlip = tpRows.length ? tpRows.reduce((s, r) => s + Number(r.slippagePts || 0), 0) / tpRows.length : 0;
  return combined;
}

export default function App() {
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [candlesLoaded, setCandlesLoaded] = useState({});
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('Select years, then run a scenario.');

  async function fetchYearCandles(symbol, interval, year) {
    const { startTime, endTime } = yearRange(year);
    const resp = await fetch(`/api/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}`);
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || `Failed to fetch ${year}`);
    return json.candles || [];
  }

  async function runScenario() {
    setLoading(true);
    setResult(null);
    try {
      const years = (config.selectedYears || []).slice().sort();
      if (!years.length) throw new Error('Select at least one year.');

      let currentBalance = Number(config.startBalance || 10000);
      const loadedMap = {};
      const yearRuns = [];

      for (const year of years) {
        setStatus(`Fetching ${year} candles…`);
        const yearCandles = await fetchYearCandles(config.symbol, config.interval, year);
        loadedMap[year] = yearCandles.length;
        setStatus(`Running ${year} simulation on ${yearCandles.length.toLocaleString()} candles…`);
        const sim = simulateScenario(yearCandles, { ...config, startBalance: currentBalance });
        yearRuns.push({ year, candleCount: yearCandles.length, ...sim });
        currentBalance = sim.summary.endBalance;
      }

      setCandlesLoaded(loadedMap);
      const combined = combineRuns(yearRuns, Number(config.startBalance || 10000));
      setResult(combined);
      setStatus(`Simulation complete. ${combined.summary.trades} closed trades across ${years.join(', ')}.`);
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
      {!!Object.keys(candlesLoaded).length && (
        <div className="card" style={{ marginBottom:16 }}>
          {Object.entries(candlesLoaded).map(([year, count]) => (
            <div key={year}>{year}: {Number(count).toLocaleString()} candles</div>
          ))}
        </div>
      )}
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
              <div>Risk balance end: {fmt(result.summary.riskBalanceEnd, 2)}</div>
              <div style={{ marginTop: 8 }}>Year runs:</div>
              <table className="sim-table"><thead><tr><th>Year</th><th>Candles</th><th>Trades</th><th>Net R</th><th>End Bal</th></tr></thead><tbody>
                {(result.yearRuns || []).map(yr => <tr key={yr.year}><td>{yr.year}</td><td>{yr.candleCount.toLocaleString()}</td><td>{yr.summary.trades}</td><td>{fmt(yr.summary.netR,2)}</td><td>{fmt(yr.summary.endBalance,2)}</td></tr>)}
              </tbody></table>
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
