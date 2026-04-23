
import React from 'react';

export default function ScenarioForm({ config, setConfig, onRun, loading }) {
  const set = (k, v) => setConfig(prev => ({ ...prev, [k]: v }));
  const setEngine = (id, v) => setConfig(prev => ({ ...prev, engines: { ...prev.engines, [id]: v } }));

  const toggleYear = (year) => {
    setConfig(prev => {
      const has = prev.selectedYears.includes(year);
      const selectedYears = has ? prev.selectedYears.filter(y => y !== year) : [...prev.selectedYears, year].sort((a,b)=>a-b);
      return { ...prev, selectedYears: selectedYears.length ? selectedYears : [year] };
    });
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6, minmax(0,1fr))', gap:12 }}>
        <label>Symbol<input value={config.symbol} onChange={e=>set('symbol', e.target.value)} /></label>
        <label>Interval<input value={config.interval} onChange={e=>set('interval', e.target.value)} /></label>
        <label>Account Value<input type="number" value={config.startingBalance} onChange={e=>set('startingBalance', +e.target.value)} /></label>

        <label>Risk Mode
          <select value={config.riskMode} onChange={e=>set('riskMode', e.target.value)}>
            <option value="fixed">Fixed $</option>
            <option value="pct">% of account</option>
          </select>
        </label>

        {config.riskMode === 'fixed' ? (
          <label>Fixed R<input type="number" value={config.fixedRisk} onChange={e=>set('fixedRisk', +e.target.value)} /></label>
        ) : (
          <label>Risk %<input type="number" step="0.1" value={config.riskPct} onChange={e=>set('riskPct', +e.target.value)} /></label>
        )}

        <label>Max R Cap<input type="number" value={config.riskCap} onChange={e=>set('riskCap', +e.target.value)} /></label>

        <label>Compounding
          <select value={config.compounding} onChange={e=>set('compounding', e.target.value)}>
            <option value="none">None</option>
            <option value="per_trade">Per trade</option>
            <option value="daily">Daily</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
          </select>
        </label>

        <label>Entry Mode
          <select value={config.entryMode} onChange={e=>set('entryMode', e.target.value)}>
            <option value="maker_gtx">Maker GTX</option>
            <option value="taker_market">Taker Market</option>
          </select>
        </label>

        <label>Execution Model
          <select value={config.executionModel} onChange={e=>set('executionModel', e.target.value)}>
            <option value="A">A — Optimistic (1.00)</option>
            <option value="B">B — Neutral (0.88)</option>
            <option value="C">C — Harsh (0.72)</option>
          </select>
        </label>

        <label>Entry Timeout Candles<input type="number" value={config.entryTimeoutCandles} onChange={e=>set('entryTimeoutCandles', +e.target.value)} /></label>
        <label>Max Hold Candles<input type="number" value={config.maxHoldCandles} onChange={e=>set('maxHoldCandles', +e.target.value)} /></label>
        <label>Maker Fee bps<input type="number" step="0.1" value={config.feeMakerBps} onChange={e=>set('feeMakerBps', +e.target.value)} /></label>
        <label>Taker Fee bps<input type="number" step="0.1" value={config.feeTakerBps} onChange={e=>set('feeTakerBps', +e.target.value)} /></label>
        <label>Slip Preset
          <select value={config.slippagePreset} onChange={e=>set('slippagePreset', e.target.value)}>
            <option value="baseline">Baseline</option>
            <option value="realistic">Realistic</option>
            <option value="stress">Stress</option>
          </select>
        </label>
        <label>TP Slip pts<input type="number" step="0.01" value={config.slippageBasePts.tp} onChange={e=>set('slippageBasePts', { ...config.slippageBasePts, tp: +e.target.value })} /></label>
        <label>SL Slip pts<input type="number" step="0.01" value={config.slippageBasePts.sl} onChange={e=>set('slippageBasePts', { ...config.slippageBasePts, sl: +e.target.value })} /></label>
      </div>

      <div style={{ display:'flex', gap:12, marginTop:12, alignItems:'center', flexWrap:'wrap' }}>
        <div>Years:</div>
        {[2022, 2023, 2024, 2025].map(y => (
          <button key={y} type="button" className={config.selectedYears.includes(y) ? 'primary' : ''} onClick={() => toggleYear(y)}>{y}</button>
        ))}
        <button type="button" onClick={() => set('selectedYears', [2022, 2023, 2024, 2025])}>All 4 years</button>
      </div>

      <div style={{ display:'flex', gap:12, marginTop:12, alignItems:'center', flexWrap:'wrap' }}>
        {['B','C','D','E','F'].map(id => (
          <label key={id}><input type="checkbox" checked={!!config.engines[id]} onChange={e=>setEngine(id,e.target.checked)} /> {id}</label>
        ))}
        <button className="primary" onClick={onRun} disabled={loading}>
          {loading ? 'Running…' : 'Run simulation'}
        </button>
      </div>
    </div>
  );
}
