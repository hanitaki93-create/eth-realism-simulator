[README_DIRECTIONAL_SIM_PATCH.md](https://github.com/user-attachments/files/27082619/README_DIRECTIONAL_SIM_PATCH.md)
# Directional Simulator Patch - GTX/Fees/Leverage Truth Layer

Files to replace:
- client/src/simulatorCore.js
- client/src/App.jsx
- client/src/components/ScenarioForm.jsx

Main fixes:
1. Corrected entry fee classification bug: maker fills under `GTX reject -> taker fallback` are now charged as maker. Only actual market/taker fallback fills are charged as taker.
2. Added selected leverage and leverage diagnostics: required leverage, notional/equity, selected leverage feasibility, and leverage check buckets.
3. Added clearer trade exports: signalEntry, entryBasePrice, actual entry, equityBefore, qty, riskUsd, notional, requiredLeverage, leverageFeasibleAtSelected, GTX rejection direction and moved points.
4. Kept engine-specific controls for D/E entry mode and GTX model.
5. Latency/open GTX proxy remains the closer OHLC-only model for real GTX rejection; neutral probability remains a fill-probability model and should not be used as proof of real GTX rejection behavior.

Important interpretation:
- To test true D GTX rejection fallback, use D GTX Model = Latency/open proxy.
- If D GTX Model = Neutral probability, `GTX reject -> taker fallback` will not create real rejection fallback events; maker fills are maker and neutral misses are misses.
- Full taker D remains a valid stress test.

VPS command after GitHub commit:
cd /root/eth-realism-simulator && git pull && cd client && npm run build && cd .. && pm2 restart all
