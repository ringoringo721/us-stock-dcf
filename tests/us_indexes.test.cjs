'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const UsIndexes = require('../us_indexes.js');
const { createHandler } = require('../api/us-indexes.js');

const SECRET = 'us-index-belt-test-secret';
const authHeaders = {
  host: 'localhost:57111',
  'x-index-belt-refresh': SECRET,
};

const call = async (handler, url, method = 'GET', reqHeaders = {}) => {
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader(name, value) { headers[name] = value; },
    end(body) { this.body = JSON.parse(body); },
  };
  await handler({ method, url, headers: reqHeaders }, res);
  return { status: res.statusCode, body: res.body, headers };
};

function fakeHistory(symbol, closes) {
  const start = Date.parse('2026-09-01T00:00:00Z');
  return closes.map((close, index) => ({
    symbol,
    date: new Date(start + index * 86400000).toISOString().slice(0, 10),
    close,
  }));
}

function fakeQuotes() {
  return UsIndexes.SYMBOLS.map((symbol, index) => ({
    symbol,
    price: 200 + index,
    changePercentage: 0.15 * (index % 3 === 0 ? -1 : 1),
    previousClose: 199 + index,
  }));
}

function liveFetcher(quotes = fakeQuotes()) {
  return async url => {
    assert.equal(url.hostname, 'financialmodelingprep.com');
    if (url.pathname.endsWith('/batch-quote')) {
      assert.ok(url.searchParams.get('symbols').includes('^GSPC'));
      return { ok: true, json: async () => quotes };
    }
    assert.ok(url.pathname.endsWith('/historical-price-eod/full'));
    const symbol = url.searchParams.get('symbol');
    return {
      ok: true,
      json: async () => fakeHistory(symbol, Array.from({ length: 20 }, (_, day) => 100 + day)),
    };
  };
}

test('catalog covers majors plus sector SPDRs', () => {
  const ids = UsIndexes.CATALOG.map(row => row.id);
  assert.deepEqual(ids.slice(0, 5), ['GSPC', 'IXIC', 'DJI', 'RUT', 'VIX']);
  assert.ok(ids.includes('XLK'));
  assert.ok(ids.includes('XLC'));
  assert.equal(UsIndexes.CATALOG.length, 16);
});

test('buildPayload keeps only complete quote + sparkline rows', () => {
  const quotes = UsIndexes.SYMBOLS.map((symbol, index) => ({
    symbol,
    price: 100 + index,
    changePercentage: index % 2 === 0 ? 1.25 : -0.5,
    previousClose: 99 + index,
  }));
  const histories = Object.fromEntries(UsIndexes.SYMBOLS.map((symbol, index) => [
    symbol,
    fakeHistory(symbol, Array.from({ length: 12 }, (_, day) => 90 + index + day * 0.1)),
  ]));
  histories['^GSPC'] = fakeHistory('^GSPC', [1, 2]); // too short — drop
  const payload = UsIndexes.buildPayload({ quotes, histories, capturedAt: '2026-11-12T00:00:00.000Z' });
  assert.equal(payload.indexes.length, UsIndexes.SYMBOLS.length - 1);
  assert.ok(!payload.indexes.some(row => row.symbol === '^GSPC'));
  assert.equal(payload.indexes[0].sparkline.length, 12);
  UsIndexes.validatePayload(payload);
});

test('public GET serves seed only — spoofed Sec-Fetch-Site cannot live-fetch', async () => {
  let fetches = 0;
  const seed = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'us-indexes', 'latest.json'),
    'utf8',
  ));
  const handler = createHandler({
    apiKey: () => 'test-key',
    refreshSecret: () => SECRET,
    readSeed: () => seed,
    fetch: async () => { fetches += 1; throw new Error('must not fetch'); },
  });
  const spoofed = await call(handler, '/api/us-indexes', 'GET', {
    'sec-fetch-site': 'none',
    origin: 'https://evil.example/us-stock-dcf',
    referer: 'https://attacker.vercel.app/',
  });
  assert.equal(spoofed.status, 200);
  assert.equal(spoofed.headers['X-Index-Belt-Cache'], 'seed');
  assert.equal(fetches, 0);

  const refreshSpoof = await call(handler, '/api/us-indexes?refresh=1', 'GET', {
    'sec-fetch-site': 'same-origin',
    origin: 'http://localhost:57111',
  });
  assert.equal(refreshSpoof.status, 200);
  assert.equal(refreshSpoof.headers['X-Index-Belt-Cache'], 'seed-refresh-denied');
  assert.equal(fetches, 0);
});

test('secret-authorized refresh=1 serves live FMP batch', async () => {
  const handler = createHandler({
    apiKey: () => 'test-key',
    refreshSecret: () => SECRET,
    now: () => new Date('2026-11-12T15:00:00Z'),
    readSeed: () => null,
    fetch: liveFetcher(),
  });
  const result = await call(handler, '/api/us-indexes?refresh=1', 'GET', authHeaders);
  assert.equal(result.status, 200);
  assert.equal(result.body.indexes.length, 16);
  assert.match(String(result.headers['Cache-Control'] || ''), /s-maxage=300/);
  assert.equal(result.headers['X-Index-Belt-Cache'], 'live');
  assert.equal(JSON.stringify(result.body).includes('test-key'), false);
  assert.equal(JSON.stringify(result.body).includes(SECRET), false);
});

test('wrong secret cannot live-fetch even with refresh=1', async () => {
  let fetches = 0;
  const seed = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'us-indexes', 'latest.json'),
    'utf8',
  ));
  const handler = createHandler({
    apiKey: () => 'test-key',
    refreshSecret: () => SECRET,
    readSeed: () => seed,
    fetch: async () => { fetches += 1; throw new Error('must not fetch'); },
  });
  const denied = await call(handler, '/api/us-indexes?refresh=1', 'GET', {
    authorization: 'Bearer wrong-secret',
  });
  assert.equal(denied.status, 200);
  assert.equal(denied.headers['X-Index-Belt-Cache'], 'seed-refresh-denied');
  assert.equal(fetches, 0);
});

test('authorized refresh falls back to seed when FMP is unavailable', async () => {
  const seed = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'us-indexes', 'latest.json'),
    'utf8',
  ));
  const handler = createHandler({
    apiKey: () => 'test-key',
    refreshSecret: () => SECRET,
    readSeed: () => seed,
    fetch: async () => { throw new Error('network down'); },
  });
  const result = await call(handler, '/api/us-indexes?refresh=1', 'GET', authHeaders);
  assert.equal(result.status, 200);
  assert.equal(result.headers['X-Index-Belt-Cache'], 'seed-fallback');
  assert.ok(result.body.indexes.length >= 5);
});

test('authorized live refresh rate limit returns seed instead of another FMP fan-out', async () => {
  const seed = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'us-indexes', 'latest.json'),
    'utf8',
  ));
  let fetches = 0;
  const handler = createHandler({
    apiKey: () => 'test-key',
    refreshSecret: () => SECRET,
    readSeed: () => seed,
    fetch: async url => {
      fetches += 1;
      return liveFetcher()(url);
    },
  });
  const headers = {
    ...authHeaders,
    'x-forwarded-for': '203.0.113.77',
  };
  for (let i = 0; i < 3; i += 1) {
    const ok = await call(handler, '/api/us-indexes?refresh=1', 'GET', headers);
    assert.equal(ok.status, 200);
  }
  const limited = await call(handler, '/api/us-indexes?refresh=1', 'GET', headers);
  assert.equal(limited.status, 200);
  assert.equal(limited.headers['X-Index-Belt-Cache'], 'seed-rate-limited');
  assert.ok(fetches > 0);
  const afterLimit = fetches;
  await call(handler, '/api/us-indexes?refresh=1', 'GET', headers);
  assert.equal(fetches, afterLimit, 'rate-limited refresh must not call FMP again');
});

test('committed seed validates', () => {
  const seed = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'us-indexes', 'latest.json'),
    'utf8',
  ));
  UsIndexes.validatePayload(seed);
  assert.ok(seed.indexes.some(row => row.symbol === '^GSPC'));
  assert.ok(seed.indexes.some(row => row.symbol === 'XLK'));
});
