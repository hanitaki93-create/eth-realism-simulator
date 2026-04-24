[README_PATCH.md](https://github.com/user-attachments/files/27065568/README_PATCH.md)
# ETH simulator final tonight fix

Replace these files in GitHub:

- client/src/simulatorCore.js
- client/src/App.jsx
- client/src/components/ScenarioForm.jsx

Main changes:

- Adds GTX Fill Style control:
  - neutral_prob = default main research mode; applies A/B/C/custom fill probability neutrally after signal activation, preventing the no-touch filter from selecting mostly losers.
  - hybrid = immediate neutral fill attempt first, then touch-gated retry.
  - touch_gated = strict old stress-test behavior only.
- Changes TP default to maker_limit with tpMakerFillProb 0.995.
- Keeps TP maker/taker/fallback controls functional.
- Keeps fee and slippage controls functional.
- Adds GTX style to output config/log context.

Recommended default for main tests:

- Entry Mode: Maker GTX
- GTX Fill Style: Neutral probability
- Execution Model: B, Fill Prob 0.88
- TP Mode: TP Maker Limit
- TP Maker Fill Prob: 0.995 or 1.00
- TP Fallback Candles: disabled/off unless using Maker then Taker mode
- SL exit remains taker
- Slippage: Dynamic candle / realistic base

VPS after GitHub commit:

cd /root/eth-realism-simulator && git pull && cd client && npm run build && cd .. && pm2 restart all

Build tested locally: npm run build passed.
