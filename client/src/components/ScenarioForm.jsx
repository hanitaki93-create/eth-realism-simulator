import React from 'react';

const inputStyle = { width: '100%' };
const disabledStyle = { opacity: 0.45 };

function NumInput({ value, onChange, step = '1', disabled = false }) {
  return <input style={inputStyle} type="number" step={step} value={value} disabled={disabled} onChange={e => onChange(+e.target.value)} />;
}

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
  const activeEngineIds = allEngineIds.filter(id => (config.engines || {})[id]);
  const presetActive = slippageMode === 'preset';
  const manualActive = slippageMode === 'manual';
  const dynamicActive = slippageMode === 'dynamic';
  const engineMode = (id) => config.engineEntryMode?.[id] || entryMode;
  const engineStyle = (id) => config.engineMakerEntryFillStyle?.[id] || config.makerEntryFillStyle || 'neutral_prob';
  const engineIsMaker = (id) => engineMode(id) !== 'taker_market';
  const engineUsesProbability = (id) => engineIsMaker(id) && engineStyle(id) !== 'latency_open';
  const engineUsesLatency = (id) => engineIsMaker(id) && engineStyle(id) === 'latency_open';
  const engineUsesTouchTimeout = (id) => engineIsMaker(id) && (engineStyle(id) === 'touch_gated' || engineStyle(id) === 'hybrid');
  const makerEntryActive = activeEngineIds.some(engineIsMaker);
  const fillModelActive = activeEngineIds.some(engineUsesProbability);
  const gtxRejectBufferActive = activeEngineIds.some(engineUsesLatency);
  const entryTouchTimeoutActive = activeEngineIds.some(engineUsesTouchTimeout);
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

        {config.riskMode === 'fixed' ? (
          <label>Fixed R<NumInput value={config.fixedRisk} onChange={v=>set('fixedRisk', v)} /></label>
        ) : (
          <label>Risk %<NumInput step="0.1" value={config.riskPct} onChange={v=>set('riskPct', v)} /></label>
        )}

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
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>

        <label style={config.oneWayMode ? {} : disabledStyle}>Allow stacking
          <select style={inputStyle} disabled={!config.oneWayMode} value={config.allowStacking ? 'yes' : 'no'} onChange={e=>set('allowStacking', e.target.value === 'yes')}>
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
        </label>

        <label>Entry Mode
          <select style={inputStyle} value={entryMode} onChange={e=>set('entryMode', e.target.value)}>
            <option value="maker_gtx">Maker GTX</option>
            <option value="maker_gtx_then_taker">GTX crossing reject → taker fallback</option>
            <option value="maker_gtx_then_market">GTX any failed attempt → market fallback</option>
            <option value="taker_market">Taker Market</option>
          </select>
        </label>

        <label style={fillModelActive ? {} : disabledStyle}>Execution Model
          <select style={inputStyle} disabled={!fillModelActive} value={config.executionModel} onChange={e=>set('executionModel', e.target.value)}>
            <option value="A">A — Optimistic</option>
            <option value="B">B — Neutral</option>
            <option value="C">C — Harsh</option>
            <option value="custom">Custom</option>
          </select>
        </label>

        <label style={fillModelActive && config.executionModel === 'A' ? {} : disabledStyle}>A Fill Prob<NumInput step="0.01" disabled={!fillModelActive || config.executionModel !== 'A'} value={config.fillProbA} onChange={v=>set('fillProbA', v)} /></label>
        <label style={fillModelActive && config.executionModel === 'B' ? {} : disabledStyle}>B Fill Prob<NumInput step="0.01" disabled={!fillModelActive || config.executionModel !== 'B'} value={config.fillProbB} onChange={v=>set('fillProbB', v)} /></label>
        <label style={fillModelActive && config.executionModel === 'C' ? {} : disabledStyle}>C Fill Prob<NumInput step="0.01" disabled={!fillModelActive || config.executionModel !== 'C'} value={config.fillProbC} onChange={v=>set('fillProbC', v)} /></label>
        <label style={fillModelActive && config.executionModel === 'custom' ? {} : disabledStyle}>Custom Fill Prob<NumInput step="0.01" disabled={!fillModelActive || config.executionModel !== 'custom'} value={config.fillProbOverride ?? 0.88} onChange={v=>set('fillProbOverride', v)} /></label>

        <label style={makerEntryActive ? {} : disabledStyle}>GTX Fill Style
          <select style={inputStyle} disabled={!makerEntryActive} value={config.makerEntryFillStyle || 'neutral_prob'} onChange={e=>set('makerEntryFillStyle', e.target.value)}>
            <option value="neutral_prob">Neutral probability</option>
            <option value="latency_open">Latency/open GTX proxy</option>
            <option value="hybrid">Hybrid immediate + touch</option>
            <option value="touch_gated">Strict touch-gated</option>
          </select>
        </label>

        <label style={gtxRejectBufferActive ? {} : disabledStyle}>GTX Reject Buffer pts<NumInput step="0.01" disabled={!gtxRejectBufferActive} value={config.gtxRejectBufferPts ?? 0.01} onChange={v=>set('gtxRejectBufferPts', v)} /></label>
        <label>Pending Confirm Candles<NumInput value={config.entryTimeoutCandles} onChange={v=>set('entryTimeoutCandles', v)} /></label>
        <label style={entryTouchTimeoutActive ? {} : disabledStyle}>Maker Entry Timeout<NumInput disabled={!entryTouchTimeoutActive} value={config.makerEntryTimeoutCandles} onChange={v=>set('makerEntryTimeoutCandles', v)} /></label>
        <label>Max Hold Candles<NumInput value={config.maxHoldCandles} onChange={v=>set('maxHoldCandles', v)} /></label>
        <label>Random Seed<NumInput value={config.randomSeed} onChange={v=>set('randomSeed', v)} /></label>


      </div>

      <div className="card" style={{ marginTop:12, background:'rgba(255,255,255,0.03)' }}>
        <h3>D/E execution overrides</h3>
        <div style={{ color:'var(--text3)', fontSize:12, marginBottom:8 }}>
          End-game testing panel: D can be taker/GTX/fallback while E stays GTX. The latency/open proxy uses candle movement around order placement, not a flat block percentage. It separates accepted-passive orders, return-touch maker fills, passive no-return misses, and crossing rejections. Latency/open ignores the 88% probability model. Maker fills are charged maker; only true fallback/market fills are charged taker.
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(6, minmax(0,1fr))', gap:12 }}>
          {perEngineIds.map(id => {
            const engMode = engineMode(id);
            const engStyle = engineStyle(id);
            const engIsMakerActive = engineIsMaker(id);
            const engProbActive = engineUsesProbability(id);
            return <React.Fragment key={id}>
              <label>{id} Entry Mode
                <select style={inputStyle} value={engMode} onChange={e=>setEngineExec('engineEntryMode', id, e.target.value)}>
                  <option value="maker_gtx">Maker GTX</option>
                  <option value="maker_gtx_then_taker">GTX crossing reject → taker fallback</option>
                  <option value="maker_gtx_then_market">GTX any failed attempt → market fallback</option>
                  <option value="taker_market">Taker Market</option>
                </select>
              </label>
              <label style={engIsMakerActive ? {} : disabledStyle}>{id} GTX Model
                <select style={inputStyle} disabled={!engIsMakerActive} value={engStyle} onChange={e=>setEngineExec('engineMakerEntryFillStyle', id, e.target.value)}>
                  <option value="neutral_prob">Neutral probability</option>
                  <option value="latency_open">Latency/open proxy</option>
                  <option value="hybrid">Hybrid immediate + touch</option>
                  <option value="touch_gated">Strict touch-gated</option>
                </select>
              </label>
              <label style={engProbActive ? {} : disabledStyle}>{id} Fill Prob Override
                <input style={inputStyle} disabled={!engProbActive} type="number" step="0.01" placeholder={engProbActive ? 'global' : 'inactive'} value={config.engineFillProbOverride?.[id] ?? ''} onChange={e=>setEngineExec('engineFillProbOverride', id, e.target.value === '' ? null : +e.target.value)} />
              </label>
            </React.Fragment>;
          })}
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
            <option value="manual">Manual exact</option>
            <option value="preset">Preset only</option>
            <option value="dynamic">Dynamic candle</option>
          </select>
        </label>

        <label style={presetActive ? {} : disabledStyle}>Slip Preset
          <select style={inputStyle} disabled={!presetActive} value={config.slippagePreset} onChange={e=>set('slippagePreset', e.target.value)}>
            <option value="baseline">Baseline</option>
            <option value="realistic">Realistic</option>
            <option value="stress">Stress</option>
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
            <option value="single">Single</option>
            <option value="multi">Custom multi</option>
          </select>
        </label>
        {[2022, 2023, 2024, 2025].map(y => (
          <button key={y} type="button" className={config.selectedYears.includes(y) ? 'primary' : ''} onClick={() => (config.yearSelectionMode || 'single') === 'multi' ? toggleYear(y) : chooseYear(y)}>{y}</button>
        ))}
        <button type="button" onClick={() => set('selectedYears', [2022, 2023, 2024, 2025])}>All 4 years</button>
        <span style={{ color:'var(--text3)', fontSize:12 }}>Single mode replaces the year. Custom multi toggles years.</span>
      </div>

      <div style={{ display:'flex', gap:12, marginTop:12, alignItems:'center', flexWrap:'wrap' }}>
        <div>Engines:</div>
        {['B','C','D','E','F'].map(id => (
          <label key={id}><input type="checkbox" checked={!!config.engines[id]} onChange={e=>setEngine(id,e.target.checked)} /> {id}</label>
        ))}
        <button className="primary" onClick={onRun} disabled={loading}>
          {loading ? 'Running…' : 'Run simulation'}
        </button>
      </div>

      <div style={{ marginTop: 10, color: 'var(--text3)', fontSize: 12 }}>
        Disabled controls are intentionally inactive under the selected mode, so the panel does not show fake or contradictory toggles.
      </div>
    </div>
  );
}
