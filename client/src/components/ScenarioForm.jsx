import React from 'react';

export default function ScenarioForm({ config, setConfig, onRun, loading }) {
  const set = (k, v) => setConfig(prev => ({ ...prev, [k]: v }));
  const setEngine = (id, v) => setConfig(prev => ({ ...prev, engines: { ...prev.engines, [id]: v } }));

  const toggleYear = (year) => {
    setConfig(prev => {
      const has = prev.selectedYears.includes(year);
      const selectedYears = has ? prev.selectedYears.filter(y => y !== year) : [...prev.selectedYears, year].sort((a,b)=>a-b);
      return { ...prev, selectedYears };
    });
  };

  const setAllYears = () => set('selectedYears', [2022, 2023, 2024, 2025]);

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
            <option value="maker_gtx">Maker GTX only</option>
            <option value="taker">Taker only</option>
            <option value="maker_taker_fallback">Maker GTX → taker fallback</option>
          </select>
        </label>

        <label>Execution Model
          <select value={config.executionModel} onChange={e=>set('executionModel', e.target.value)}>
            <option value="A">A — Optimistic</option>
            <option value="B">B — Neutral</option>
            <option value="C">C — Harsh</option>
          </select>
        </label>

        <label>Exit Mode
          <input value="TP/SL always taker" disabled />
        </label>

        <label>TP RR<input type="number" step="0.1" value={config.tpRMultiple} onChange={e=>set('tpRMultiple', +e.target.value)} /></label>
        <label>SL Mult<input type="number" step="0.05" value={config.slMultiplier} onChange={e=>set('slMultiplier', +e.target.value)} /></label>
        <label>Min SL Floor<input type="number" step="0.01" value={config.minSlFloor} onChange={e=>set('minSlFloor', +e.target.value)} /></label>
        <label>Timeout Candles<input type="number" value={config.entryTimeoutCandles} onChange={e=>set('entryTimeoutCandles', +e.target.value)} /></label>

        <label>Maker Fee bps<input type="number" step="0.1" value={config.feeMakerBps} onChange={e=>set('feeMakerBps', +e.target.value)} /></label>
        <label>Taker Fee bps<input type="number" step="0.1" value={config.feeTakerBps} onChange={e=>set('feeTakerBps', +e.target.value)} /></label>

        <label>Slippage Model
          <select value={config.slippageModel} onChange={e=>set('slippageModel', e.target.value)}>
            <option value="fixed">Fixed preset</option>
            <option value="dynamic">Candle dynamic</option>
            <option value="stress">Dynamic stress</option>
          </select>
        </label>

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

      <div style={{ display:'flex', flexWrap:'wrap', gap:12, marginTop:14, alignItems:'center' }}>
        <span>Years:</span>
        {[2022, 2023, 2024, 2025].map(y => (
          <label key={y}><input type="checkbox" checked={config.selectedYears.includes(y)} onChange={()=>toggleYear(y)} /> {y}</label>
        ))}
        <button type="button" onClick={setAllYears}>All 4 years</button>
      </div>

      <div style={{ display:'flex', flexWrap:'wrap', gap:12, marginTop:14, alignItems:'center' }}>
        {['B','C','D','E','F'].map(id => (
          <label key={id}><input type="checkbox" checked={!!config.engines[id]} onChange={e=>setEngine(id, e.target.checked)} /> {id}</label>
        ))}
        <button className="primary" onClick={onRun} disabled={loading}>{loading ? 'Running…' : 'Run simulation'}</button>
      </div>
    </div>
  );
}
