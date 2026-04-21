# ETH Binance Realism Simulator (MVP)

This is a separate simulator project built from the V5 baseline repo.

## What it does in this MVP
- Replays ETH historical candles from Binance spot API
- Runs baseline engines from the V5 client codebase
- Simulates a realistic execution layer with:
  - wick-touch TP/SL settlement
  - maker GTX/post-only entry mode
  - market/taker entry mode
  - maker or taker TP mode
  - taker SL mode
  - configurable rejection/miss logic
  - maker/taker fees
  - configurable slippage presets
  - flat R or % of account with R hard cap
  - compounding cadence: none/per_trade/daily/monthly/quarterly
- Produces scenario stats and per-engine breakdown

## Quick local start
```bash
npm run install:all
npm run dev
```

## New GitHub repo
```bash
git init
git branch -M main
git add .
git commit -m "Initial realism simulator MVP"
git remote add origin <YOUR_NEW_REPO_URL>
git push -u origin main
```

## New DigitalOcean droplet (Ubuntu)
```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git
sudo npm i -g pm2

git clone <YOUR_NEW_REPO_URL> eth-realism-simulator
cd eth-realism-simulator
npm run install:all
cd client && npm run build && cd ..
pm2 start server/index.js --name eth-realism-sim
pm2 save
pm2 startup
```

## Notes
- This MVP intentionally keeps execution modeling explicit and adjustable.
- It is designed for decision-quality realism, not exchange-perfect replay.
