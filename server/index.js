
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

const yearCache = new Map();

function yearRangeUtc(year) {
  const start = Date.UTC(Number(year), 0, 1, 0, 0, 0, 0);
  const end = Date.UTC(Number(year) + 1, 0, 1, 0, 0, 0, 0);
  return { start, end };
}

async function fetchPaginatedRange(symbol, interval, startTime, endTime) {
  const intervalMs = INTERVAL_MS[interval] || 300000;
  let cursor = startTime;
  const allCandles = [];
  let chunksUsed = 0;

  while (cursor < endTime) {
    const url = `${BINANCE_BASE}/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endTime}&limit=${MAX_PER_REQUEST}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Binance error: ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) break;

    const candles = data.map(k => ({
      openTime: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: k[6]
    }));

    allCandles.push(...candles);
    chunksUsed += 1;

    const nextCursor = candles[candles.length - 1].openTime + intervalMs;
    if (nextCursor <= cursor) break;
    cursor = nextCursor;
  }

  return { candles: allCandles.filter(c => c.openTime >= startTime && c.openTime < endTime), chunksUsed };
}

app.get('/api/klines-year', async (req, res) => {
  try {
    const { symbol = 'ETHUSDT', interval = '5m', year } = req.query;
    if (!year) return res.status(400).json({ ok: false, error: 'year is required' });

    const cacheKey = `${symbol}|${interval}|${year}`;
    if (yearCache.has(cacheKey)) {
      const cached = yearCache.get(cacheKey);
      return res.json({ ok: true, candles: cached.candles, count: cached.candles.length, cached: true, year: Number(year), chunksUsed: cached.chunksUsed });
    }

    const { start, end } = yearRangeUtc(year);
    const payload = await fetchPaginatedRange(symbol, interval, start, end);
    yearCache.set(cacheKey, payload);

    res.json({ ok: true, candles: payload.candles, count: payload.candles.length, cached: false, year: Number(year), chunksUsed: payload.chunksUsed });
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
