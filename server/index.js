const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const BINANCE_BASE = 'https://api.binance.com/api/v3';
const MAX_PER_REQUEST = 1000;
const INTERVAL_MS = {
  '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000,
  '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000
};

async function fetchPaginated(symbol, interval, totalCandles, startTimeOverride = null) {
  const intervalMs = INTERVAL_MS[interval] || 300000;
  let startTime = startTimeOverride !== null ? startTimeOverride : Date.now() - totalCandles * intervalMs;
  let allCandles = [];
  while (allCandles.length < totalCandles) {
    const limit = Math.min(MAX_PER_REQUEST, totalCandles - allCandles.length);
    const url = `${BINANCE_BASE}/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&limit=${limit}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Binance error: ${response.status}`);
    const data = await response.json();
    if (!data.length) break;
    const candles = data.map(k => ({
      openTime: k[0], open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]), closeTime: k[6]
    }));
    allCandles = allCandles.concat(candles);
    startTime = candles[candles.length - 1].openTime + intervalMs;
  }
  return allCandles.slice(0, totalCandles);
}

app.get('/api/klines', async (req, res) => {
  try {
    const { symbol = 'ETHUSDT', interval = '5m', limit = 2000, startTime } = req.query;
    const totalCandles = Math.min(parseInt(limit, 10), 120000);
    const candles = await fetchPaginated(symbol, interval, totalCandles, startTime ? parseInt(startTime, 10) : null);
    res.json({ ok: true, candles, count: candles.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (_, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`ETH Realism Simulator backend running on http://localhost:${PORT}`);
});
