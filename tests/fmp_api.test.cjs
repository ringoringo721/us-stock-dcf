const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHandler } = require('../api/fmp.js');
const call = async (handler, url, method = 'GET') => {
  const headers = {};
  const res = { statusCode: 200, setHeader(name, value) { headers[name] = value; },
    end(body) { this.body = JSON.parse(body); } };
  await handler({ method, url }, res);
  return { status: res.statusCode, body: res.body, headers };
};

test('FMP API forwards only the allowed news query and never exposes its key', async () => {
  const handler = createHandler({ apiKey: () => 'test-only-placeholder', fetch: async url => {
    assert.equal(url.hostname, 'financialmodelingprep.com');
    assert.equal(url.pathname, '/stable/news/stock');
    assert.equal(url.searchParams.get('symbols'), '0700.HK');
    assert.equal(url.searchParams.get('page'), '3');
    assert.equal(url.searchParams.get('limit'), '50');
    return { ok: true, json: async () => [{ symbol: '0700.HK', title: 'Actual supplied article' }] };
  } });
  const result = await call(handler, '/api/fmp?action=news&symbol=0700.HK&page=3');
  assert.equal(result.status, 200);
  assert.equal(result.body.page, 3);
  assert.equal(result.body.hasMore, false);
  assert.equal(JSON.stringify(result).includes('test-only-placeholder'), false);
});

test('Missing keys, wrong methods, arbitrary URLs, extra queries and unbounded pagination fail explicitly', async () => {
  const handler = createHandler({ apiKey: () => undefined, fetch: () => { throw new Error('Must not fetch'); } });
  for (const url of ['/api/fmp?action=https://example.com&symbol=AAPL',
    '/api/fmp?action=news&symbol=../AAPL', '/api/fmp?action=news&symbol=AAPL&page=-1',
    '/api/fmp?action=news&symbol=AAPL&page=1001', '/api/fmp?action=news&symbol=AAPL&apikey=untrusted']) {
    assert.equal((await call(handler, url)).status, 400, url);
  }
  assert.equal((await call(handler, '/api/fmp?action=news&symbol=AAPL', 'POST')).status, 405);
  assert.equal((await call(handler, '/api/fmp?action=news&symbol=AAPL')).body.error, 'FMP_NOT_CONFIGURED');
});

test('HTTP denial, vendor errors and security mismatches are not success-shaped empty feeds', async () => {
  for (const [response, expected] of [
    [{ ok: false, status: 401 }, 'FMP_UNAUTHORIZED'],
    [{ ok: false, status: 402 }, 'FMP_PLAN_REQUIRED'],
    [{ ok: false, status: 429 }, 'FMP_RATE_LIMITED'],
    [{ ok: true, json: async () => ({ 'Error Message': 'provider error' }) }, 'FMP_INVALID_RESPONSE'],
    [{ ok: true, json: async () => [{ symbol: 'TCEHY' }] }, 'FMP_SECURITY_MISMATCH']
  ]) {
    const result = await call(createHandler({ apiKey: () => 'test-only-placeholder',
      fetch: async () => response }), '/api/fmp?action=news&symbol=0700.HK');
    assert.equal(result.status, 502);
    assert.equal(result.body.error, expected);
    assert.equal(Object.hasOwn(result.body, 'data'), false);
  }
});

test('Custom parameter units, model restrictions and Berkshire provider aliases are preserved', async () => {
  const handler = createHandler({ apiKey: () => 'test-placeholder', fetch: async url => {
    assert.equal(url.searchParams.get('symbol'), 'BRK-B');
    assert.equal(url.searchParams.get('revenueGrowthPct'), '0.09');
    assert.equal(url.searchParams.get('costOfEquity'), '12');
    return { ok: true, json: async () => [{ symbol: 'BRK-B', equityValue: 123 }] };
  } });
  const result = await call(handler, '/api/fmp?action=custom-dcf&symbol=BRK.B&revenueGrowthPct=0.09&costOfEquity=12');
  assert.equal(result.status, 200);
  assert.equal(result.body.data[0].symbol, 'BRK.B');
  assert.equal(result.body.data[0].providerSymbol, 'BRK-B');
  for (const parameters of ['revenueGrowthPct=9', 'beta=NaN', 'capitalExpenditurePct=0.03',
    'longTermGrowthRate=11', 'taxRate=0.2', 'numberOfShares=123']) {
    assert.equal((await call(handler, `/api/fmp?action=custom-dcf&symbol=AAPL&${parameters}`)).status, 400);
  }
  assert.equal((await call(handler, '/api/fmp?action=custom-dcf&symbol=AAPL&operatingCashFlowPct=0.3')).body.error,
    'UNSUPPORTED_MODEL_INPUT');
  assert.equal((await call(handler, '/api/fmp?action=custom-levered-dcf&symbol=AAPL&ebitPct=0.3')).body.error,
    'UNSUPPORTED_MODEL_INPUT');
});

test('historical-price action forwards dated EOD queries for beta benchmarks only when configured', async () => {
  const handler = createHandler({ apiKey: () => 'test-placeholder', fetch: async url => {
    assert.equal(url.pathname, '/stable/historical-price-eod/full');
    assert.equal(url.searchParams.get('symbol'), 'SPY');
    assert.equal(url.searchParams.get('from'), '2020-01-01');
    assert.equal(url.searchParams.get('to'), '2021-01-01');
    return { ok: true, json: async () => [{ symbol: 'SPY', date: '2020-06-01', close: 300, volume: 1 }] };
  } });
  const result = await call(handler, '/api/fmp?action=historical-price&symbol=SPY&from=2020-01-01&to=2021-01-01');
  assert.equal(result.status, 200);
  assert.equal(result.body.data[0].close, 300);
  assert.equal(result.body.source.from, '2020-01-01');
  assert.equal((await call(handler, '/api/fmp?action=historical-price&symbol=SPY')).status, 400);
});

test('News pagination discloses its bound instead of offering an invalid next page', async () => {
  const handler = createHandler({ apiKey: () => 'test-placeholder', fetch: async () =>
    ({ ok: true, json: async () => Array.from({ length: 50 }, () => ({ symbol: 'AAPL' })) }) });
  const result = await call(handler, '/api/fmp?action=news&symbol=AAPL&page=1000');
  assert.equal(result.body.hasMore, false);
  assert.equal(result.body.limitReached, true);
});
