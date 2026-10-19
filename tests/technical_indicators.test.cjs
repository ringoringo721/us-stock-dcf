const assert = require('node:assert/strict');
const { test } = require('node:test');
const Technical = require('../technical_indicators.js');
const { createHandler } = require('../api/fmp.js');
async function call(query, rows) {
  let requested;
  const handler = createHandler({ apiKey: () => 'test-placeholder', fetch: async url => {
    requested = url; return { ok: true, json: async () => rows };
  } });
  const res = { statusCode: 200, setHeader() {}, end(body) { this.body = JSON.parse(body); } };
  await handler({ method: 'GET', url: `/api/fmp?${query}` }, res);
  return { ...res, requested };
}
const query = id => `action=technical&symbol=0388.HK&indicator=${id}&periodLength=14&from=2026-10-01&to=2026-10-16`;

test('All nine FMP endpoints use daily data and the exact indicator response field', async () => {
  assert.equal(Technical.catalog.length, 9);
  for (const item of Technical.catalog) {
    const field = item.id === 'standarddeviation' ? 'standardDeviation' : item.id;
    const result = await call(query(item.id), [{ date: '2026-10-16 00:00:00', close: 374.6, [field]: 42 }]);
    assert.equal(result.statusCode, 200);
    assert.equal(result.requested.pathname, `/stable/technical-indicators/${item.id}`);
    assert.equal(result.requested.searchParams.get('timeframe'), '1day');
    assert.equal(result.requested.searchParams.get('periodLength'), '14');
    assert.deepEqual(result.body.data, [{ date: '2026-10-16', close: 374.6, value: 42 }]);
    assert.equal(result.body.source.indicator, item.id);
    assert.equal(result.body.source.periodLength, 14);
    assert.equal(JSON.stringify(result.body).includes('test-placeholder'), false);
  }
});
test('Indicator query bounds, dates, duplicate parameters and arbitrary types are rejected before fetching', async () => {
  for (const bad of [query('macd'), query('../sma'), query('sma').replace('14', '0'),
    query('sma').replace('14', '501'), query('sma').replace('14', '1.5'),
    query('sma').replace('2026-10-01', '2026-02-30'),
    query('sma').replace('2026-10-01', '2026-11-01'),
    query('sma').replace('2026-10-01', '1990-01-01'),
    query('sma') + '&indicator=ema', query('sma') + '&timeframe=1min']) {
    const result = await call(bad, []);
    assert.equal(result.statusCode, 400, bad);
    assert.equal(result.requested, undefined);
  }
});
test('Malformed, duplicate, wrong-security and out-of-range observations fail explicitly', async () => {
  const row = { date: '2026-10-16', close: 374.6, sma: 380 };
  for (const rows of [[{ ...row, symbol: 'AAPL' }], [{ ...row, sma: '380' }],
    [{ ...row, date: '2026-10-17' }], [{ ...row, close: 0 }], [row, row], [null]]) {
    assert.equal((await call(query('sma'), rows)).statusCode, 502);
  }
  assert.deepEqual((await call(query('sma'), [])).body.data, []);
});
test('Actual date alignment preserves zero oscillator values and null warmup, not invented observations', () => {
  const prices = [['2026-10-15', 375, 1], ['2026-10-16', 374.6, 1]];
  assert.deepEqual([...Technical.align([{ date: '2026-10-15', close: 375, value: null },
    { date: '2026-10-16', close: 374.6, value: 0 }], prices)],
  [['2026-10-15', null], ['2026-10-16', 0]]);
  assert.throws(() => Technical.align([{ date: '2026-10-16', close: 749.2, value: 40 }], prices), /PRICE_BASIS_MISMATCH/);
  assert.throws(() => Technical.align([{ date: '2026-10-14', close: 375, value: 40 }], prices), /NO_MATCHING_SESSIONS/);
  assert.equal(Technical.align([], prices).size, 0);
});
