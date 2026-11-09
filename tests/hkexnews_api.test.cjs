'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createHandler, hkexStockCode, parseFilingDate, decodeEntities, normalizeFiling,
  resetActiveStockCacheForTests,
} = require('../api/hkexnews.js');

function mockRes() {
  const headers = {};
  return {
    statusCode: 0,
    headers,
    setHeader(key, value) { headers[key] = value; },
    end(body) { this.body = typeof body === 'string' ? JSON.parse(body) : body; },
  };
}

async function call(handler, url, method = 'GET') {
  const res = mockRes();
  await handler({ method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
  return res;
}

test('hkexStockCode and date helpers', () => {
  assert.equal(hkexStockCode('1398.HK'), '01398');
  assert.equal(parseFilingDate('30/10/2026 16:40'), '2026-10-30');
  assert.equal(decodeEntities('EGM&#x27;S Meeting'), "EGM'S Meeting");
});

test('normalizeFiling builds openable HKEXNEWS URL', () => {
  const row = normalizeFiling({
    TITLE: '2025 Annual Report',
    LONG_TEXT: 'Financial Statements&#x2f;ESG Information - [Annual Report]',
    FILE_LINK: '/listedco/listconews/sehk/2026/0422/2026042201234.pdf',
    DATE_TIME: '22/04/2026 16:30',
  }, '1398.HK');
  assert.equal(row.form, 'Annual Report');
  assert.equal(row.filingDate, '2026-04-22');
  assert.match(row.link, /^https:\/\/www1\.hkexnews\.hk\/listedco\//);
  assert.doesNotMatch(row.link, /sec\.gov/i);
});

test('filings action looks up stockId and returns HKEXNEWS rows', async () => {
  resetActiveStockCacheForTests();
  const calls = [];
  const handler = createHandler({
    fetch: async (url) => {
      const href = String(url);
      calls.push(href);
      if (href.includes('activestock_sehk_e.json')) {
        return {
          ok: true,
          json: async () => [{ i: 12593, c: '01398', n: 'ICBC', s: 1 }],
        };
      }
      assert.match(href, /titleSearchServlet\.do/);
      assert.match(href, /stockId=12593/);
      assert.match(href, /t1code=40000/);
      return {
        ok: true,
        json: async () => ({
          result: JSON.stringify([{
            TITLE: '2025 Annual Report',
            LONG_TEXT: 'Financial Statements - [Annual Report]',
            FILE_LINK: '/listedco/listconews/sehk/2026/0422/x.pdf',
            DATE_TIME: '22/04/2026 16:30',
            TOTAL_COUNT: 1,
          }]),
        }),
      };
    },
  });
  const result = await call(handler, '/api/hkexnews?action=filings&symbol=1398.HK&limit=10');
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.data.length, 1);
  assert.equal(result.body.data[0].form, 'Annual Report');
  assert.equal(result.body.source.provider, 'HKEXNEWS');
  assert.equal(result.body.source.stockId, '12593');
  assert.match(result.body.source.searchUrl, /stockId=12593/);
  assert.match(String(result.headers['Cache-Control'] || ''), /private/);
  assert.ok(calls.some(url => url.includes('activestock')));
});

test('rejects non-HK symbols and SEC-shaped actions', async () => {
  const handler = createHandler({
    fetch: () => { throw new Error('must not fetch'); },
  });
  assert.equal((await call(handler, '/api/hkexnews?action=filings&symbol=AAPL')).statusCode, 400);
  assert.equal((await call(handler, '/api/hkexnews?action=sec-filings&symbol=1398.HK')).statusCode, 400);
  assert.equal((await call(handler, '/api/hkexnews?action=filings&symbol=1398.HK', 'POST')).statusCode, 405);
});

test('unknown HK code returns 404 without searching filings', async () => {
  resetActiveStockCacheForTests();
  let searched = false;
  const handler = createHandler({
    fetch: async (url) => {
      if (String(url).includes('activestock')) {
        return { ok: true, json: async () => [{ i: 1, c: '00700', n: 'TENCENT' }] };
      }
      searched = true;
      return { ok: true, json: async () => ({ result: '[]' }) };
    },
  });
  const result = await call(handler, '/api/hkexnews?action=filings&symbol=1398.HK');
  assert.equal(result.statusCode, 404);
  assert.equal(result.body.error, 'HKEX_STOCK_NOT_FOUND');
  assert.equal(searched, false);
});
