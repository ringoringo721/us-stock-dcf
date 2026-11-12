'use strict';

const fs = require('node:fs');
const path = require('node:path');
const UsIndexes = require('../us_indexes.js');
const { authorizeLiveRefresh, readRefreshSecret } = require('./index-belt-access.js');

const MEMORY_TTL_MS = 5 * 60 * 1000;
const HISTORY_CONCURRENCY = 4;
const RATE_WINDOW_MS = 60_000;
/** Tight budget for secret-authorized refresh=1 live fan-out. */
const LIVE_RATE_MAX = 3;
/** One live FMP rebuild at a time per handler isolate. */
const LIVE_MAX_INFLIGHT = 1;

function clientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const parts = forwarded.split(',').map(part => part.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket?.remoteAddress || req.headers?.['x-real-ip'] || 'unknown';
}

function createHandler({
  fetch: fetcher = globalThis.fetch,
  apiKey = () => process.env.FMP_API_KEY,
  now = () => new Date(),
  readSeed = defaultReadSeed,
  refreshSecret = readRefreshSecret,
} = {}) {
  let memoryCache = null;
  let liveInflight = null;
  let liveInflightCount = 0;
  const rateBuckets = new Map();

  function rateLimited(req) {
    const key = `${clientIp(req)}:live`;
    const stamp = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || stamp >= bucket.resetAt) {
      bucket = { count: 0, resetAt: stamp + RATE_WINDOW_MS };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (rateBuckets.size > 4000) {
      for (const [id, entry] of rateBuckets) {
        if (stamp >= entry.resetAt) rateBuckets.delete(id);
      }
    }
    return bucket.count > LIVE_RATE_MAX;
  }

  function coalesceLiveFetch(args) {
    if (liveInflight) return liveInflight;
    liveInflightCount += 1;
    liveInflight = fetchLivePayload(args)
      .finally(() => {
        liveInflight = null;
        liveInflightCount = Math.max(0, liveInflightCount - 1);
      });
    return liveInflight;
  }

  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, value, cacheControl) => {
      if (cacheControl) res.setHeader('Cache-Control', cacheControl);
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(405, { error: 'METHOD_NOT_ALLOWED' }, 'private, no-store');
    }
    const query = new URL(req.url, 'http://localhost').searchParams;
    if ([...query.keys()].some(key => key !== 'refresh')) {
      return send(400, { error: 'INVALID_REQUEST' }, 'private, no-store');
    }
    const refresh = query.get('refresh') === '1';
    const stamp = now();
    const seed = readSeed();
    const liveAuthorized = refresh && authorizeLiveRefresh(req, refreshSecret());

    // Public path: memory + committed seed only — never trust spoofable browser headers.
    if (!liveAuthorized) {
      if (!refresh && memoryCache && stamp.getTime() < memoryCache.expiresAt) {
        res.setHeader('X-Index-Belt-Cache', 'memory');
        return send(200, memoryCache.payload, 'public, s-maxage=300, stale-while-revalidate=3600');
      }
      if (seed) {
        res.setHeader('X-Index-Belt-Cache', refresh ? 'seed-refresh-denied' : 'seed');
        return send(200, {
          ...seed,
          cache: { hit: true, mode: refresh ? 'seed-refresh-denied' : 'seed' },
        }, refresh ? 'private, no-store' : 'public, s-maxage=120, stale-while-revalidate=600');
      }
      return send(refresh ? 403 : 503, {
        error: refresh ? 'REFRESH_FORBIDDEN' : 'SEED_UNAVAILABLE',
      }, 'private, no-store');
    }

    // Secret-authorized live rebuild (ops / cron). Still rate-limit + coalesce.
    if (rateLimited(req)) {
      res.setHeader('Retry-After', '60');
      if (seed) {
        res.setHeader('X-Index-Belt-Cache', 'seed-rate-limited');
        return send(200, { ...seed, cache: { hit: true, mode: 'seed-rate-limited' } },
          'private, no-store');
      }
      return send(429, { error: 'RATE_LIMITED' }, 'private, no-store');
    }

    const key = apiKey();
    if (!key) {
      if (seed) {
        res.setHeader('X-Index-Belt-Cache', 'seed');
        return send(200, { ...seed, cache: { hit: true, mode: 'seed' } },
          'public, s-maxage=120, stale-while-revalidate=600');
      }
      return send(503, { error: 'FMP_NOT_CONFIGURED' }, 'private, no-store');
    }

    if (liveInflightCount >= LIVE_MAX_INFLIGHT && !liveInflight) {
      res.setHeader('Retry-After', '30');
      if (seed) {
        res.setHeader('X-Index-Belt-Cache', 'seed-busy');
        return send(200, { ...seed, cache: { hit: true, mode: 'seed-busy' } }, 'private, no-store');
      }
      return send(429, { error: 'RATE_LIMITED', notice: 'US_INDEX_BELT_BUSY' }, 'private, no-store');
    }

    try {
      const payload = await coalesceLiveFetch({ fetcher, key, now: stamp });
      UsIndexes.validatePayload(payload);
      memoryCache = { payload, expiresAt: stamp.getTime() + MEMORY_TTL_MS };
      res.setHeader('X-Index-Belt-Cache', 'live');
      return send(200, payload, 'public, s-maxage=300, stale-while-revalidate=3600');
    } catch (error) {
      console.error('US index belt fetch failed', error?.message || error);
      if (seed) {
        res.setHeader('X-Index-Belt-Cache', 'seed-fallback');
        return send(200, {
          ...seed,
          cache: { hit: true, mode: 'seed-fallback', warning: String(error?.message || error) },
        }, 'public, s-maxage=60, stale-while-revalidate=600');
      }
      return send(502, { error: 'US_INDEX_BELT_UPSTREAM_ERROR' }, 'private, no-store');
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
module.exports.authorizeLiveRefresh = authorizeLiveRefresh;
