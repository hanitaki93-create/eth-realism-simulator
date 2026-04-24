[README_PATCH.md](https://github.com/user-attachments/files/27064112/README_PATCH.md)
# ETH simulator control-truth patch

Replace these files in your GitHub repo:

- client/src/simulatorCore.js
- client/src/App.jsx
- client/src/components/ScenarioForm.jsx

Patch purpose:
- TP RR is fully wired into execution TP.
- Maker GTX entry requires actual touch before fill probability is applied.
- TP mode supports market/taker, maker limit, and maker then taker fallback.
- Slippage controls are mutually exclusive: manual, preset, or dynamic.
- Disabled UI controls are intentionally inactive to avoid fake/contradictory toggles.
- Logs include gross R, fee R, net R, raw TP vs execution TP, notional, fill reason, TP exit mode, fee types, slippage used.
- Summary includes fee R, median fee R, SL distance, notional, TP maker/taker/fallback counts, missed-no-touch and missed-probability counts.

After pushing to GitHub, pull and rebuild on VPS.
