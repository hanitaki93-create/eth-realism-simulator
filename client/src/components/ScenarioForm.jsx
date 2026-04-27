import React from 'react';

const inputStyle = { width: '100%' };
const disabledStyle = { opacity: 0.45 };

function NumInput({ value, onChange, step = '1', disabled = false }) {
  return <input style={inputStyle} type="number" step={step} value={value} disabled={disabled} onChange={e => onChange(+e.target.value)} />;
}

const ENTRY_OPTIONS = [
  ['maker_gtx', 'GTX Only — maker or reject/miss'],
  ['normal_limit', 'Normal Limit Only — maker/taker/miss'],
  ['normal_limit_then_market', 'Limit then Market Fallback'],
  ['taker_market', 'Taker Market'],
];

export default function ScenarioForm({ config, setConfig, onRun, loading }) {
  const set = (k, v) => setConfig(prev => ({ ...prev, [k]: v }));
  const setNested = (root, k, v) => setConfig(prev => ({ ...prev, [root]: { ...prev[root], [k]: v } }));
  const setEngine = (id, v) => setConfig(prev => ({ ...prev, engines: { ...prev.engines, [id]: v } }));
  const setEngineExec = (root, id, v) => setConfig(prev => ({ ...prev, [root]: { ...(prev[root] || {}), [id]: v } }));

  const chooseYear = (year) => setConfig(prev => ({ ...prev, selectedYears: [year] }));
  const toggleYear = (year) => {
    setConfig(prev => {
      const has = prev.selectedYears.includes(year);
      const selectedYears = has ? prev.selectedYears.filter(y => y !== year) : [...prev.selectedYears, year].sort((a,b)=>a-b);
      return { ...prev, selectedYears: selectedYears.length ? selectedYears : [year] };
    });
  };

  const slippageMode = config.slippageMode || 'dynamic';
  const tpMode = config.tpMode || 'market';
  const entryMode = config.entryMode || 'maker_gtx';
  const perEngineIds = ['D','E'];
  const allEngineIds = Object.keys(config.engines || {}).length ? Object.keys(config.engines || {}) : ['D','E'];
  const presetActive = slippageMode === 'preset';
  const manualActive = slippageMode === 'manual';
  const dynamicActive = slippageMode === 'dynamic';
  const engineMode = (id) => config.engineEntryMode?.[id] || entryMode;
  const entryWindowActive = allEngineIds.filter(id => (config.engines || {})[id]).some(id => ['maker_gtx','normal_limit','normal_limit_then_market'].includes(engineMode(id)));
  const tpMakerActive = tpMode === 'maker_limit' || tpMode === 'maker_then_market';
  const tpFallbackActive = tpMode === 'maker_then_market';

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3>Scenario controls</h3>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(6, minmax(0,1fr))', gap:12 }}>
        <label>Symbol<input style={inputStyle} value={config.symbol} onChange={e=>set('symbol', e.target.value)} /></label>
        <label>Interval<input style={inputStyle} value={config.interval} onChange={e=>set('interval', e.target.value)} /></label>
        <label>Account Value<NumInput value={config.startingBalance} onChange={v=>set('startingBalance', v)} /></label>

        <label>Risk Mode
          <select style={inputStyle} value={config.riskMode} onChange={e=>set('riskMode', e.target.value)}>
            <option value="fixed">Fixed $</option>
            <option value="pct">% of account</option>
          </select>
        </label>
        {config.riskMode === 'fixed' ? <label>Fixed R<NumInput value={config.fixedRisk} onChange={v=>set('fixedRisk', v)} /></label> : <label>Risk %<NumInput step="0.1" value={config.riskPct} onChange={v=>set('riskPct', v)} /></label>}
        <label>Max R Cap<NumInput value={config.riskCap} onChange={v=>set('riskCap', v)} /></label>

        <label>Selected Leverage<NumInput value={config.selectedLeverage ?? 20} onChange={v=>set('selectedLeverage', v)} /></label>
        <label>Equity Floor
          <select style={inputStyle} value={config.enforceEquityFloor === false ? 'off' : 'on'} onChange={e=>set('enforceEquityFloor', e.target.value === 'on')}>
            <option value="on">ON — stop below risk</option>
            <option value="off">OFF — diagnostic</option>
          </select>
        </label>
        <label>Leverage Block
          <select style={inputStyle} value={config.enforceLeverageLimit ? 'on' : 'off'} onChange={e=>set('enforceLeverageLimit', e.target.value === 'on')}>
            <option value="off">OFF — report only</option>
            <option value="on">ON — skip infeasible</option>
          </select>
        </label>
        <label>Risk Size Basis
          <select style={inputStyle} value={config.positionSizingBasis || 'signal_entry'} onChange={e=>set('positionSizingBasis', e.target.value)}>
            <option value="signal_entry">Signal entry distance</option>
            <option value="actual_entry">Actual entry-to-SL</option>
          </select>
        </label>
        <label>Market Entry SL Mult
          <select style={inputStyle} value={String(config.marketEntrySlMultiplier ?? 1)} onChange={e=>set('marketEntrySlMultiplier', +e.target.value)}>
            <option value="1">OFF / 1.00x</option>
            <option value="1.1">1.10x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.50x</option>
          </select>
        </label>
        <label>Compounding
          <select style={inputStyle} value={config.compounding} onChange={e=>set('compounding', e.target.value)}>
            <option value="none">None</option>
            <option value="per_trade">Per trade</option>
            <option value="daily">Daily</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
          </select>
        </label>

        <label>TP RR<NumInput step="0.1" value={config.tpRMultiple} onChange={v=>set('tpRMultiple', v)} /></label>
        <label>One-way Mode
          <select style={inputStyle} value={config.oneWayMode ? 'yes' : 'no'} onChange={e=>set('oneWayMode', e.target.value === 'yes')}>
            <option value="yes">Yes</option><option value="no">No</option>
          </select>
        </label>
        <label style={config.oneWayMode ? {} : disabledStyle}>Allow stacking
          <select style={inputStyle} disabled={!config.oneWayMode} value={config.allowStacking ? 'yes' : 'no'} onChange={e=>set('allowStacking', e.target.value === 'yes')}>
            <option value="no">No</option><option value="yes">Yes</option>
          </select>
        </label>
        <label>Default Entry Mode
          <select style={inputStyle} value={entryMode} onChange={e=>set('entryMode', e.target.value)}>
            {ENTRY_OPTIONS.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label>GTX/Limit Buffer pts<NumInput step="0.01" value={config.gtxRejectBufferPts ?? 0.01} onChange={v=>set('gtxRejectBufferPts', v)} /></label>
        <label>Same-candle TP/SL Rule
          <select style={inputStyle} value={config.sameCandleRule || 'path_heuristic'} onChange={e=>set('sameCandleRule', e.target.value)}>
            <option value="path_heuristic">Path heuristic</option>
            <option value="sl_first">Conservative — SL first</option>
            <option value="tp_first">Optimistic — TP first</option>
          </select>
        </label>
        <label>Pending Confirm Candles<NumInput value={config.entryTimeoutCandles} onChange={v=>set('entryTimeoutCandles', v)} /></label>
        <label style={entryWindowActive ? {} : disabledStyle}>Maker/Limit Timeout<NumInput disabled={!entryWindowActive} value={config.makerEntryTimeoutCandles} onChange={v=>set('makerEntryTimeoutCandles', v)} /></label>
        <label>Max Hold Candles<NumInput value={config.maxHoldCandles} onChange={v=>set('maxHoldCandles', v)} /></label>
        <label>Random Seed<NumInput value={config.randomSeed} onChange={v=>set('randomSeed', v)} /></label>
      </div>

      <div className="card" style={{ marginTop:12, background:'rgba(255,255,255,0.03)' }}>
        <h3>D/E execution overrides</h3>
        <div style={{ color:'var(--text3)', fontSize:12, marginBottom:8 }}>
          Clean entry model: GTX is maker-only and can reject/miss; normal limit can fill maker or taker; limit-then-market adds a bot fallback. Entry classification is candle-based, not fixed percentage-based.
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4, minmax(0,1fr))', gap:12 }}>
          {perEngineIds.map(id => <label key={id}>{id} Entry Mode
            <select style={inputStyle} value={engineMode(id)} onChange={e=>setEngineExec('engineEntryMode', id, e.target.value)}>
              {ENTRY_OPTIONS.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>)}
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(6, minmax(0,1fr))', gap:12, marginTop:12 }}>
        <label>TP Mode
          <select style={inputStyle} value={tpMode} onChange={e=>set('tpMode', e.target.value)}>
            <option value="market">TP Market / Taker</option>
            <option value="maker_limit">TP Maker Limit</option>
            <option value="maker_then_market">TP Maker then Taker</option>
          </select>
        </label>
        <label style={tpMakerActive ? {} : disabledStyle}>TP Maker Fill Prob<NumInput step="0.01" disabled={!tpMakerActive} value={config.tpMakerFillProb} onChange={v=>set('tpMakerFillProb', v)} /></label>
        <label style={tpFallbackActive ? {} : disabledStyle}>TP Fallback Candles<NumInput disabled={!tpFallbackActive} value={config.tpFallbackCandles} onChange={v=>set('tpFallbackCandles', v)} /></label>
        <label style={tpFallbackActive ? {} : disabledStyle}>TP Fallback Seconds (live ref)<NumInput disabled={!tpFallbackActive} value={config.tpFallbackSeconds ?? 45} onChange={v=>set('tpFallbackSeconds', v)} /></label>
        <label>Maker Fee bps<NumInput step="0.1" value={config.feeMakerBps} onChange={v=>set('feeMakerBps', v)} /></label>
        <label>Taker Fee bps<NumInput step="0.1" value={config.feeTakerBps} onChange={v=>set('feeTakerBps', v)} /></label>

        <label>Slippage Mode
          <select style={inputStyle} value={slippageMode} onChange={e=>set('slippageMode', e.target.value)}>
            <option value="manual">Manual exact</option><option value="preset">Preset only</option><option value="dynamic">Dynamic candle</option>
          </select>
        </label>
        <label style={presetActive ? {} : disabledStyle}>Slip Preset
          <select style={inputStyle} disabled={!presetActive} value={config.slippagePreset} onChange={e=>set('slippagePreset', e.target.value)}>
            <option value="baseline">Baseline</option><option value="realistic">Realistic</option><option value="stress">Stress</option>
          </select>
        </label>
        <label style={manualActive ? {} : disabledStyle}>Manual Entry Slip<NumInput step="0.01" disabled={!manualActive} value={config.slippageManualPts?.entry ?? 0} onChange={v=>setNested('slippageManualPts', 'entry', v)} /></label>
        <label style={manualActive ? {} : disabledStyle}>Manual TP Slip<NumInput step="0.01" disabled={!manualActive} value={config.slippageManualPts?.tp ?? 0} onChange={v=>setNested('slippageManualPts', 'tp', v)} /></label>
        <label style={manualActive ? {} : disabledStyle}>Manual SL Slip<NumInput step="0.01" disabled={!manualActive} value={config.slippageManualPts?.sl ?? 0} onChange={v=>setNested('slippageManualPts', 'sl', v)} /></label>
        <label style={dynamicActive ? {} : disabledStyle}>Dynamic Entry Base<NumInput step="0.01" disabled={!dynamicActive} value={config.slippageDynamicBasePts?.entry ?? 0} onChange={v=>setNested('slippageDynamicBasePts', 'entry', v)} /></label>
        <label style={dynamicActive ? {} : disabledStyle}>Dynamic TP Base<NumInput step="0.01" disabled={!dynamicActive} value={config.slippageDynamicBasePts?.tp ?? 0} onChange={v=>setNested('slippageDynamicBasePts', 'tp', v)} /></label>
        <label style={dynamicActive ? {} : disabledStyle}>Dynamic SL Base<NumInput step="0.01" disabled={!dynamicActive} value={config.slippageDynamicBasePts?.sl ?? 0} onChange={v=>setNested('slippageDynamicBasePts', 'sl', v)} /></label>
      </div>

      <div style={{ display:'flex', gap:12, marginTop:12, alignItems:'center', flexWrap:'wrap' }}>
        <div>Years:</div>
        <label>Selection
          <select style={{ ...inputStyle, width: 120 }} value={config.yearSelectionMode || 'single'} onChange={e=>set('yearSelectionMode', e.target.value)}>
            <option value="single">Single</option><option value="multi">Custom multi</option>
          </select>
        </label>
        {[2022, 2023, 2024, 2025].map(y => <button key={y} type="button" className={config.selectedYears.includes(y) ? 'primary' : ''} onClick={() => (config.yearSelectionMode || 'single') === 'multi' ? toggleYear(y) : chooseYear(y)}>{y}</button>)}
        <button type="button" onClick={() => setConfig(prev => ({ ...prev, yearSelectionMode: 'multi', selectedYears: [2022, 2023, 2024, 2025] }))}>All 4 years</button>
        <div style={{ color:'var(--text3)', fontSize:12 }}>Single mode replaces the year. Custom multi toggles years.</div>
      </div>

      <div style={{ display:'flex', gap:12, marginTop:12, alignItems:'center', flexWrap:'wrap' }}>
        <div>Engines:</div>
        {Object.keys(config.engines).map(id => <label key={id} style={{ display:'flex', gap:5, alignItems:'center' }}><input type="checkbox" checked={config.engines[id]} onChange={e=>setEngine(id, e.target.checked)} /> {id}</label>)}
      </div>

      <button className="primary" style={{ marginTop: 14 }} disabled={loading} onClick={onRun}>{loading ? 'Running…' : 'Run simulation'}</button>
      <div style={{ color:'var(--text3)', marginTop:8, fontSize:12 }}>Disabled controls are intentionally inactive under the selected mode, so the panel does not show fake or contradictory toggles.</div>
    </div>
  );
}
