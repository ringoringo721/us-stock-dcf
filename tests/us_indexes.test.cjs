'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const UsIndexes = require('../us_indexes.js');
const { createHandler } = require('../api/us-indexes.js');

const call = async (handler, url, method = 'GET') => {
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader(name, value) { headers[name] = value; },
    end(body) { this.body = JSON.parse(body); },
  };
  await handler({ method, url, headers: {} }, res);
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

test('API serves live FMP batch when configured', async () => {
  const quotes = UsIndexes.SYMBOLS.map((symbol, index) => ({
    symbol,
    price: 200 + index,
    changePercentage: 0.15 * (index % 3 === 0 ? -1 : 1),
    previousClose: 199 + index,
  }));
  const handler = createHandler({
    apiKey: () => 'test-key',
    now: () => new Date('2026-11-12T15:00:00Z'),
    readSeed: () => null,
    fetch: async url => {
      assert.equal(url.hostname, 'financialmodelingprep.com');
      if (url.pathname.endsWith('/batch-quote')) {
        assert.ok(url.searchParams.get('symbols').includes('^GSPC'));
        assert.equal(url.searchParams.get('apikey'), 'test-key');
        return { ok: true, json: async () => quotes };
      }
      assert.ok(url.pathname.endsWith('/historical-price-eod/full'));
      const symbol = url.searchParams.get('symbol');
      return {
        ok: true,
        json: async () => fakeHistory(symbol, Array.from({ length: 20 }, (_, day) => 100 + day)),
      };
    },
  });
  const result = await call(handler, '/api/us-indexes');
  assert.equal(result.status, 200);
  assert.equal(result.body.indexes.length, 16);
  assert.match(String(result.headers['Cache-Control'] || ''), /s-maxage=300/);
  assert.equal(result.headers['X-Index-Belt-Cache'], 'live');
  assert.equal(JSON.stringify(result.body).includes('test-key'), false);
});

test('API falls back to seed when FMP is unavailable', async () => {
  const seed = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'us-indexes', 'latest.json'),
    'utf8',
  ));
  const handler = createHandler({
    apiKey: () => 'test-key',
    readSeed: () => seed,
    fetch: async () => { throw new Error('network down'); },
  });
  const result = await call(handler, '/api/us-indexes?refresh=1');
  assert.equal(result.status, 200);
  assert.equal(result.headers['X-Index-Belt-Cache'], 'seed-fallback');
  assert.ok(result.body.indexes.length >= 5);
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
