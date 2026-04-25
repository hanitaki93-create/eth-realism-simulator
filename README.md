[README_ENDGAME_SIM_FINAL.md](https://github.com/user-attachments/files/27081517/README_ENDGAME_SIM_FINAL.md)
# ETH Simulator Endgame Execution Patch

Files to replace in GitHub:
- client/src/simulatorCore.js
- client/src/App.jsx
- client/src/components/ScenarioForm.jsx

## Added / fixed

1. Added new entry execution option:
   - `GTX attempt → market fallback` (`maker_gtx_then_market`)
   - This is different from `GTX reject → taker fallback`.
   - `GTX reject → taker fallback` only rescues latency/open GTX rejections moving toward TP.
   - `GTX attempt → market fallback` rescues any simulated maker GTX failure/miss/no-touch by entering market after the maker attempt fails.

2. Per-engine D/E entry controls remain separate:
   - D can be market / GTX / reject fallback / attempt fallback.
   - E can remain GTX while D is tested separately.

3. Logs/exports strengthened:
   - Every trade/missed/signal row gets `runId`, `runTimestamp`, `testYears`, `sourceYear`, and `modeSummary`.
   - Export filenames include the run ID.
   - Added full package export with summary, config, trades, missed trades, and signal ledger.
   - Added browser-session run history table and export for side-by-side comparison.

4. Year selection fixed:
   - Single mode: clicking 2023 replaces 2022 and runs only 2023.
   - Custom multi: clicking years toggles multiple years.
   - All 4 years button still runs 2022-2025 together.

5. Control contradiction fixes:
   - Disabled controls remain inactive.
   - Execution model controls stay enabled if D/E per-engine maker modes are active, even when global entry mode is taker.
   - Maker Entry Timeout stays enabled when any active per-engine GTX model needs touch/hybrid timeout.

## Important limitation
This is still a 5-minute OHLC simulator. It cannot perfectly simulate real GTX queue position, bid/ask, latency, order-book depth, or exact 15/30/45-second TP fallback behavior. The added `latency/open GTX proxy` is closer than flat fill probability, but it remains an approximation.

## Recommended first comparison set
Run 2022 fixed risk first, then repeat 2023:

A. D Maker GTX + latency/open, E Maker GTX + neutral, TP maker_then_market
B. D GTX reject → taker fallback + latency/open, E Maker GTX + neutral, TP maker_then_market
C. D GTX attempt → market fallback + latency/open, E Maker GTX + neutral, TP maker_then_market
D. D Taker Market, E Maker GTX + neutral, TP maker_then_market

Compare:
- P(win|signal) vs P(win|filled)
- Bias ratio
- Fee R
- Net R
- maker entries vs taker entries
- GTX rejected toward TP by engine
- GTX/maker attempt → market fallback entries
