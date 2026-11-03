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

test('dividends action forwards limit and returns payment rows', async () => {
  const handler = createHandler({ apiKey: () => 'test-placeholder', fetch: async url => {
    assert.equal(url.pathname, '/stable/dividends');
    assert.equal(url.searchParams.get('symbol'), 'AAPL');
    assert.equal(url.searchParams.get('limit'), '400');
    assert.ok(url.searchParams.get('from'));
    return { ok: true, json: async () => [{ symbol: 'AAPL', date: '2024-02-09', adjDividend: 0.24 }] };
  } });
  const result = await call(handler, '/api/fmp?action=dividends&symbol=AAPL&limit=400');
  assert.equal(result.status, 200);
  assert.equal(result.body.data[0].adjDividend, 0.24);
});

test('dividends action defaults a long from lookback when omitted', async () => {
  const handler = createHandler({ apiKey: () => 'test-placeholder', fetch: async url => {
    assert.equal(url.searchParams.get('limit'), '500');
    const from = url.searchParams.get('from');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(from));
    assert.ok(Number(from.slice(0, 4)) <= new Date().getUTCFullYear() - 35);
    return { ok: true, json: async () => [{ symbol: 'MCD', date: '2024-02-29', adjDividend: 0.67 }] };
  } });
  const result = await call(handler, '/api/fmp?action=dividends&symbol=MCD');
  assert.equal(result.status, 200);
  assert.equal(result.body.data[0].adjDividend, 0.67);
});

test('revenue segmentation injects period+structure=flat and accepts nested-free rows', async () => {
  const seen = [];
  const handler = createHandler({ apiKey: () => 'test-placeholder', fetch: async url => {
    const symbol = url.searchParams.get('symbol');
    seen.push({
      path: url.pathname,
      period: url.searchParams.get('period'),
      structure: url.searchParams.get('structure'),
      symbol,
    });
    return { ok: true, json: async () => [
      { date: '2024-09-28', symbol, data: { iPhone: 201e9, Americas: 100e9 } },
    ] };
  } });
  const annual = await call(handler, '/api/fmp?action=revenue-product-segmentation&symbol=AAPL');
  assert.equal(annual.status, 200);
  assert.equal(seen[0].period, 'annual');
  assert.equal(seen[0].structure, 'flat');
  assert.equal(annual.body.data[0].data.iPhone, 201e9);

  const quarter = await call(handler,
    '/api/fmp?action=revenue-geographic-segmentation&symbol=NVDA&period=quarter&structure=flat');
  assert.equal(quarter.status, 200);
  assert.equal(seen[1].period, 'quarter');
  assert.equal(seen[1].structure, 'flat');

  assert.equal((await call(handler,
    '/api/fmp?action=revenue-product-segmentation&symbol=AAPL&period=monthly')).status, 400);
});

test('dividends unwraps historical-wrapped FMP payloads', async () => {
  const handler = createHandler({ apiKey: () => 'test-placeholder', fetch: async () => ({
    ok: true,
    json: async () => ({ historical: [{ symbol: 'MSFT', date: '2024-02-14', adjDividend: 0.75 }] }),
  }) });
  const result = await call(handler, '/api/fmp?action=dividends&symbol=MSFT&limit=10');
  assert.equal(result.status, 200);
  assert.equal(result.body.data[0].adjDividend, 0.75);
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


test('sec-filings action forwards from/to/limit to search-by-symbol', async () => {
  const handler = createHandler({ apiKey: () => 'test-placeholder', fetch: async url => {
    assert.equal(url.pathname, '/stable/sec-filings-search/symbol');
    assert.equal(url.searchParams.get('symbol'), 'PCAR');
    assert.equal(url.searchParams.get('from'), '2024-01-01');
    assert.equal(url.searchParams.get('to'), '2025-01-01');
    assert.equal(url.searchParams.get('limit'), '20');
    return { ok: true, json: async () => [{ symbol: 'PCAR', formType: '10-K', filingDate: '2024-06-01', finalLink: 'https://www.sec.gov/x' }] };
  } });
  const result = await call(handler, '/api/fmp?action=sec-filings&symbol=PCAR&from=2024-01-01&to=2025-01-01&limit=20');
  assert.equal(result.status, 200);
  assert.equal(result.body.data[0].formType, '10-K');
});

test('transcript-dates allowed; full transcript body blocked; private cache', async () => {
  const handler = createHandler({ apiKey: () => 'test-placeholder', fetch: async url => {
    assert.ok(url.pathname.endsWith('earning-call-transcript-dates'));
    return {
      ok: true,
      json: async () => [{
        symbol: 'AAPL', fiscalYear: 2024, quarter: 1, date: '2024-02-01',
        content: 'SECRET_SHOULD_STRIP',
      }],
    };
  } });
  const dates = await call(handler, '/api/fmp?action=transcript-dates&symbol=AAPL');
  assert.equal(dates.status, 200);
  assert.equal(dates.body.data[0].quarter, 1);
  assert.equal(dates.body.data[0].content, undefined);
  assert.match(String(dates.headers['Cache-Control'] || ''), /private/);
  const blocked = await call(handler,
    '/api/fmp?action=earning-call-transcript&symbol=AAPL&year=2024&quarter=1');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, 'TRANSCRIPT_BODY_NOT_PROXIED');
});

test('institutional-holders returns broad holders with curated flags and stays private', async () => {
  const handler = createHandler({ apiKey: () => 'test-placeholder', fetch: async url => {
    assert.equal(url.pathname, '/stable/institutional-ownership/extract-analytics/holder');
    assert.equal(url.searchParams.get('symbol'), 'AAPL');
    assert.equal(url.searchParams.get('year'), '2025');
    assert.equal(url.searchParams.get('quarter'), '2');
    assert.equal(url.searchParams.get('limit'), '100');
    return {
      ok: true,
      json: async () => [
        { symbol: 'AAPL', cik: '0001067983', investorName: 'BERKSHIRE', sharesNumber: 1 },
        { symbol: 'AAPL', cik: '0002012383', investorName: 'BLACKROCK', sharesNumber: 9 },
      ],
    };
  } });
  const result = await call(handler,
    '/api/fmp?action=institutional-holders&symbol=AAPL&year=2025&quarter=2&limit=100');
  assert.equal(result.status, 200);
  assert.equal(result.body.data.length, 2);
  assert.equal(result.body.data[0].cik, '0001067983');
  assert.equal(result.body.data[0].isCurated, true);
  assert.equal(result.body.data[1].cik, '0002012383');
  assert.equal(result.body.data[1].isCurated, false);
  assert.match(String(result.headers['Cache-Control'] || ''), /private/);
  assert.equal((await call(handler,
    '/api/fmp?action=institutional-holders&symbol=AAPL&year=2025&quarter=5')).status, 400);
});

test('institutional-extract is capped, CIK-validated, and rate-private', async () => {
  const handler = createHandler({ apiKey: () => 'test-placeholder', fetch: async url => {
    assert.equal(url.pathname, '/stable/institutional-ownership/extract');
    assert.equal(url.searchParams.get('cik'), '0001067983');
    assert.equal(url.searchParams.get('year'), '2025');
    assert.equal(url.searchParams.get('quarter'), '2');
    assert.equal(url.searchParams.has('symbol'), false);
    return {
      ok: true,
      json: async () => Array.from({ length: 500 }, (_, i) => ({
        symbol: `T${i}`, value: i, shares: i, nameOfIssuer: `Name ${i}`,
      })),
    };
  } });
  const result = await call(handler,
    '/api/fmp?action=institutional-extract&cik=0001067983&year=2025&quarter=2');
  assert.equal(result.status, 200);
  assert.equal(result.body.data.length, 400);
  assert.equal(result.body.source.cik, '0001067983');
  assert.equal(result.body.source.cappedAt, 400);
  assert.match(String(result.headers['Cache-Control'] || ''), /private/);
  assert.equal((await call(handler,
    '/api/fmp?action=institutional-extract&cik=bad&year=2025&quarter=2')).status, 400);
});
