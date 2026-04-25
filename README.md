[README_GODLIKE_GTX_TRUTH_PATCH.md](https://github.com/user-attachments/files/27082613/README_GODLIKE_GTX_TRUTH_PATCH.md)
# God-like GTX Truth Patch

Files to replace in GitHub:

- `client/src/simulatorCore.js`
- `client/src/App.jsx`
- `client/src/components/ScenarioForm.jsx`

## Main correction

`Latency/open GTX proxy` is now deterministic and does **not** use the 88% A/B/C probability model.

It separates three price-proxy outcomes:

1. `GTX_ACCEPTED_NEAR_ENTRY_FILLED_MAKER`
   - price stayed near entry; maker fill is assumed.
2. `PASSIVE_MISS_TOWARD_TP`
   - price moved away in the TP direction; maker order would likely rest/passively miss, not reject.
3. `GTX_REJECTED_CROSSING_TOWARD_SL`
   - price moved through the order in the crossing direction; post-only/GTX likely rejects.

## Entry modes under latency/open

- `Maker GTX`: only near-entry fills; passive misses and crossing rejects are missed.
- `GTX crossing reject -> taker fallback`: only crossing rejects fall back to taker.
- `GTX any failed attempt -> market fallback`: passive misses and crossing rejects both fall back to market/taker.
- `Taker Market`: all eligible settled signals use taker entry.

## Panel audit fixes

- Probability controls are disabled when active engines use latency/open proxy.
- Per-engine fill-prob overrides are disabled for latency/open and taker-market engines.
- GTX reject buffer is enabled only when at least one active engine uses latency/open proxy.
- TP fallback seconds is labelled as live reference only; candle fallback remains the simulator behavior.

## New logs/summary metrics

- `gtxDecisionModel`
- `gtxOutcome`
- `gtxPassiveMissTowardTP`
- `gtxRejected`
- `gtxRejectDirection`
- `gtxRejectMovedPts`
- passive miss toward TP by engine
- rejected/crossing toward SL by engine
- accepted near-entry maker fills

## Recommended truth-test settings

For deterministic GTX reality proxy:

- D GTX Model: `Latency/open proxy`
- E GTX Model: `Latency/open proxy`
- ignore A/B/C probabilities; they should be disabled/inactive

Compare:

1. D Maker GTX / E Maker GTX
2. D GTX any failed attempt -> market fallback / E Maker GTX
3. D Taker Market / E Maker GTX
4. E only, Maker GTX, RR 2 / 2.5 / 3
