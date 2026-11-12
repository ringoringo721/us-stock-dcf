'use strict';

const fs = require('node:fs');
const path = require('node:path');
const UsIndexes = require('../us_indexes.js');

const MEMORY_TTL_MS = 5 * 60 * 1000;
const HISTORY_CONCURRENCY = 4;
let memoryCache = null;

function createHandler({
  fetch: fetcher = globalThis.fetch,
  apiKey = () => process.env.FMP_API_KEY,
  now = () => new Date(),
  readSeed = defaultReadSeed,
} = {}) {
  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(405, { error: 'METHOD_NOT_ALLOWED' });
    }
    const query = new URL(req.url, 'http://localhost').searchParams;
    if ([...query.keys()].some(key => key !== 'refresh')) {
      return send(400, { error: 'INVALID_REQUEST' });
    }
    const refresh = query.get('refresh') === '1';
    const stamp = now();
    if (!refresh && memoryCache && stamp.getTime() < memoryCache.expiresAt) {
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
      res.setHeader('X-Index-Belt-Cache', 'memory');
      return send(200, memoryCache.payload);
    }

    const key = apiKey();
    if (!key) {
      const seed = readSeed();
      if (seed) {
        res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
        res.setHeader('X-Index-Belt-Cache', 'seed');
        return send(200, { ...seed, cache: { hit: true, mode: 'seed' } });
      }
      return send(503, { error: 'FMP_NOT_CONFIGURED' });
    }

    try {
      const payload = await fetchLivePayload({ fetcher, key, now: stamp });
      UsIndexes.validatePayload(payload);
      memoryCache = { payload, expiresAt: stamp.getTime() + MEMORY_TTL_MS };
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
      res.setHeader('X-Index-Belt-Cache', 'live');
      return send(200, payload);
    } catch (error) {
      console.error('US index belt fetch failed', error?.message || error);
      const seed = readSeed();
      if (seed) {
        res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
        res.setHeader('X-Index-Belt-Cache', 'seed-fallback');
        return send(200, {
          ...seed,
          cache: { hit: true, mode: 'seed-fallback', warning: String(error?.message || error) },
        });
      }
      return send(502, { error: 'US_INDEX_BELT_UPSTREAM_ERROR' });
    }
  };
}

async function fetchLivePayload({ fetcher, key, now }) {
  const from = UsIndexes.isoDaysAgo(UsIndexes.HISTORY_LOOKBACK_DAYS, now);
  const to = UsIndexes.todayIso(now);
  const symbols = UsIndexes.SYMBOLS;
  const quoteUrl = new URL('https://financialmodelingprep.com/stable/batch-quote');
  quoteUrl.searchParams.set('symbols', symbols.join(','));
  quoteUrl.searchParams.set('apikey', key);

  const quoteResponse = await fetcher(quoteUrl, {
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  });
  if (!quoteResponse.ok) {
    const error = new Error(`FMP_QUOTE_${quoteResponse.status}`);
    error.status = quoteResponse.status;
    throw error;
  }
  const quotePayload = await quoteResponse.json();
  const quotes = Array.isArray(quotePayload) ? quotePayload
    : Array.isArray(quotePayload?.data) ? quotePayload.data : null;
  if (!Array.isArray(quotes)) throw new Error('FMP_INVALID_QUOTE_RESPONSE');

  const histories = {};
  for (let i = 0; i < symbols.length; i += HISTORY_CONCURRENCY) {
    const batch = symbols.slice(i, i + HISTORY_CONCURRENCY);
    const rows = await Promise.all(batch.map(async symbol => {
      const url = new URL('https://financialmodelingprep.com/stable/historical-price-eod/full');
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('from', from);
      url.searchParams.set('to', to);
      url.searchParams.set('apikey', key);
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(25000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`FMP_HISTORY_${symbol}_${response.status}`);
      const payload = await response.json();
      const list = Array.isArray(payload) ? payload
        : Array.isArray(payload?.historical) ? payload.historical
          : Array.isArray(payload?.data) ? payload.data : null;
      if (!Array.isArray(list)) throw new Error(`FMP_INVALID_HISTORY_${symbol}`);
      return [symbol, list];
    }));
    for (const [symbol, list] of rows) histories[symbol] = list;
  }

  return UsIndexes.buildPayload({
    quotes,
    histories,
    capturedAt: now.toISOString(),
    source: 'FMP',
  });
}

function defaultReadSeed() {
  const candidates = [
    path.join(__dirname, '..', 'cache', 'us-indexes', 'latest.json'),
    path.join(process.cwd(), 'cache', 'us-indexes', 'latest.json'),
    path.join(process.cwd(), 'public', 'cache', 'us-indexes', 'latest.json'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      return UsIndexes.validatePayload(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch { /* try next */ }
  }
  return null;
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.fetchLivePayload = fetchLivePayload;
