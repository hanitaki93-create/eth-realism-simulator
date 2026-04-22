import React from 'react';

const YEARS = [2022, 2023, 2024, 2025];

export default function ScenarioForm({ config, setConfig, onRun, loading }) {
  const set = (k, v) => setConfig(prev => ({ ...prev, [k]: v }));
  const setEngine = (id, v) => setConfig(prev => ({ ...prev, engines: { ...prev.engines, [id]: v } }));
  const toggleYear = (year) => setConfig(prev => ({
    ...prev,
    selectedYears: (prev.selectedYears || []).includes(year)
      ? prev.selectedYears.filter(y => y !== year)
      : [...(prev.selectedYears || []), year].sort(),
  }));
  const riskMode = config.riskMode || 'fixed';

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6, minmax(0,1fr))', gap:12 }}>
        <label>Symbol<input value={config.symbol} onChange={e=>set('symbol', e.target.value.toUpperCase())} /></label>
        <label>Interval<input value={config.interval} onChange={e=>set('interval', e.target.value)} /></label>
        <label>Account Value<input type="number" step="100" value={config.startBalance} onChange={e=>set('startBalance', +e.target.value)} /></label>
        <label>Risk Mode<select value={riskMode} onChange={e=>set('riskMode', e.target.value)}><option value="fixed">Fixed $</option><option value="pct">% of balance</option></select></label>
        {riskMode === 'fixed'
          ? <label>Fixed R<input type="number" value={config.fixedRisk} onChange={e=>set('fixedRisk', +e.target.value)} /></label>
          : <label>Risk %<input type="number" step="0.1" value={config.riskPct} onChange={e=>set('riskPct', +e.target.value)} /></label>}
        <label>R Cap<input type="number" value={config.riskCap} onChange={e=>set('riskCap', +e.target.value)} /></label>
        <label>Compounding<select value={config.compounding} onChange={e=>set('compounding', e.target.value)}><option value="none">None</option><option value="per_trade">Per trade</option><option value="daily">Daily</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option></select></label>
        <label>Entry Mode<select value={config.entryMode} onChange={e=>set('entryMode', e.target.value)}><option value="maker_gtx">Maker GTX</option><option value="taker_market">Taker Market</option></select></label>
        <label>TP Mode<select value={config.tpMode} onChange={e=>set('tpMode', e.target.value)}><option value="market">Market</option><option value="limit">Limit</option></select></label>
        <label>TP RR<input type="number" step="0.1" value={config.tpRMultiple} onChange={e=>set('tpRMultiple', +e.target.value)} /></label>
        <label>SL Mult<input type="number" step="0.05" value={config.slMultiplier} onChange={e=>set('slMultiplier', +e.target.value)} /></label>
        <label>Min SL Floor<input type="number" step="0.1" value={config.minSlFloor} onChange={e=>set('minSlFloor', +e.target.value)} /></label>
        <label>Entry Offset<input type="number" step="0.01" value={config.entryOffset} onChange={e=>set('entryOffset', +e.target.value)} /></label>
        <label>GTX Reject %<input type="number" step="0.1" value={config.makerEntryRejectRate*100} onChange={e=>set('makerEntryRejectRate', +e.target.value/100)} /></label>
        <label>TP Fail %<input type="number" step="0.1" value={config.tpFailRate*100} onChange={e=>set('tpFailRate', +e.target.value/100)} /></label>
        <label>Maker Fee bps<input type="number" step="0.1" value={config.feeMakerBps} onChange={e=>set('feeMakerBps', +e.target.value)} /></label>
        <label>Taker Fee bps<input type="number" step="0.1" value={config.feeTakerBps} onChange={e=>set('feeTakerBps', +e.target.value)} /></label>
        <label>Slip Preset<select value={config.slippagePreset} onChange={e=>set('slippagePreset', e.target.value)}><option value="baseline">Baseline</option><option value="realistic">Realistic</option><option value="stress">Stress</option></select></label>
        <label>TP Slip pts<input type="number" step="0.01" value={config.slippageBasePts.tp} onChange={e=>set('slippageBasePts', { ...config.slippageBasePts, tp: +e.target.value })} /></label>
        <label>SL Slip pts<input type="number" step="0.01" value={config.slippageBasePts.sl} onChange={e=>set('slippageBasePts', { ...config.slippageBasePts, sl: +e.target.value })} /></label>
      </div>
      <div style={{ display:'flex', gap:12, marginTop:12, alignItems:'center', flexWrap:'wrap' }}>
        <div>Years:</div>
        {YEARS.map(year => (
          <button key={year} type="button" className={(config.selectedYears || []).includes(year) ? 'primary' : ''} onClick={() => toggleYear(year)}>
            {year}
          </button>
        ))}
      </div>
      <div style={{ display:'flex', gap:12, marginTop:12, alignItems:'center', flexWrap:'wrap' }}>
        {['B','C','D','E','F'].map(id => <label key={id}><input type="checkbox" checked={!!config.engines[id]} onChange={e=>setEngine(id,e.target.checked)} /> {id}</label>)}
        <button className="primary" onClick={onRun} disabled={loading}>{loading ? 'Running…' : 'Run simulation'}</button>
      </div>
    </div>
  );
}
