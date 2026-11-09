'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createHandler, hkexStockCode, parseFilingDate, decodeEntities, normalizeFiling,
  hkexServletLang, isQuarterlyResultsRow, mergeFilings, resetActiveStockCacheForTests,
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
  assert.equal(hkexServletLang('zh'), 'zh');
  assert.equal(hkexServletLang('en'), 'E');
});

test('normalizeFiling builds openable HKEXNEWS URL', () => {
  const row = normalizeFiling({
    TITLE: '2025年度報告',
    LONG_TEXT: '財務報表&#x2f;環境、社會及管治資料 - [年報]',
    FILE_LINK: '/listedco/listconews/sehk/2026/0422/2026042201234.pdf',
    DATE_TIME: '22/04/2026 16:30',
  }, '1398.HK');
  assert.equal(row.form, '年報');
  assert.equal(row.title, '2025年度報告');
  assert.equal(row.filingDate, '2026-04-22');
  assert.match(row.link, /^https:\/\/www1\.hkexnews\.hk\/listedco\//);
  assert.doesNotMatch(row.link, /sec\.gov/i);
});

test('isQuarterlyResultsRow keeps 季度業績 and drops briefing invites', () => {
  assert.equal(isQuarterlyResultsRow({
    LONG_TEXT: '公告及通告 - [季度業績]',
    TITLE: '截至二零二六年三月三十一日止三個月業績公佈',
  }), true);
  assert.equal(isQuarterlyResultsRow({
    LONG_TEXT: 'Announcements and Notices - [Quarterly Results]',
    TITLE: 'ANNOUNCEMENT OF THE RESULTS FOR THE THREE MONTHS ENDED 31 MARCH 2026',
  }), true);
  assert.equal(isQuarterlyResultsRow({
    LONG_TEXT: '公告及通告 - [其他-雜項]',
    TITLE: '關於召開2026年第三季度業績說明會的公告',
  }), false);
  assert.equal(isQuarterlyResultsRow({
    LONG_TEXT: 'Announcements and Notices - [Results of AGM]',
    TITLE: 'POLL RESULTS FOR THE 2026 ANNUAL GENERAL MEETING',
  }), false);
});

test('mergeFilings dedupes by link and sorts newest first', () => {
  const merged = mergeFilings([
    {
      TITLE: '年報', LONG_TEXT: '[年報]', FILE_LINK: '/a.pdf', DATE_TIME: '01/01/2025 10:00',
    },
  ], [
    {
      TITLE: '季度業績', LONG_TEXT: '[季度業績]', FILE_LINK: '/q.pdf', DATE_TIME: '01/06/2025 10:00',
    },
    {
      TITLE: '年報 dup', LONG_TEXT: '[年報]', FILE_LINK: '/a.pdf', DATE_TIME: '01/01/2025 10:00',
    },
  ], '0700.HK', 10);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].link.endsWith('/q.pdf'), true);
});

test('filings action uses lang=zh, merges statements + quarterly', async () => {
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
      assert.match(href, /lang=zh/);
      if (href.includes('t1code=40000')) {
        return {
          ok: true,
          json: async () => ({
            result: JSON.stringify([{
              TITLE: '2025年度報告',
              LONG_TEXT: '財務報表 - [年報]',
              FILE_LINK: '/listedco/listconews/sehk/2026/0422/a.pdf',
              DATE_TIME: '22/04/2026 16:30',
              TOTAL_COUNT: 1,
            }]),
          }),
        };
      }
      assert.match(href, /t1code=10000/);
      const titled = href.includes('title=%E5%AD%A3%E5%BA%A6') || href.includes('title=季度');
      return {
        ok: true,
        json: async () => ({
          result: JSON.stringify(titled ? [{
            TITLE: '二〇二五年第一季度報告',
            LONG_TEXT: '公告及通告 - [季度業績]',
            FILE_LINK: '/listedco/listconews/sehk/2025/0429/q2.pdf',
            DATE_TIME: '29/04/2025 16:30',
            TOTAL_COUNT: 1,
          }] : [
            {
              TITLE: '二〇二六年第三季度報告',
              LONG_TEXT: '公告及通告 - [季度業績 / 內幕消息]',
              FILE_LINK: '/listedco/listconews/sehk/2026/1030/q.pdf',
              DATE_TIME: '30/10/2026 16:40',
              TOTAL_COUNT: 2,
            },
            {
              TITLE: '關於召開業績說明會的公告',
              LONG_TEXT: '公告及通告 - [其他-雜項]',
              FILE_LINK: '/listedco/listconews/sehk/2026/1023/x.pdf',
              DATE_TIME: '23/10/2026 18:27',
              TOTAL_COUNT: 2,
            },
          ]),
        }),
      };
    },
  });
  const result = await call(handler, '/api/hkexnews?action=filings&symbol=1398.HK&limit=10&lang=zh');
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.data.length, 3);
  assert.match(result.body.data[0].title, /第三季度報告/);
  assert.equal(result.body.data[1].form, '年報');
  assert.match(result.body.data[2].title, /第一季度報告/);
  assert.equal(result.body.source.lang, 'zh');
  assert.equal(result.body.source.includesQuarterlyResults, true);
  assert.match(result.body.source.searchUrl, /stockId=12593/);
  assert.doesNotMatch(result.body.source.searchUrl, /lang=/);
  assert.equal(calls.filter(url => url.includes('titleSearchServlet')).length, 3);
});

test('filings action lang=en maps to servlet lang=E', async () => {
  resetActiveStockCacheForTests();
  const handler = createHandler({
    fetch: async (url) => {
      const href = String(url);
      if (href.includes('activestock')) {
        return { ok: true, json: async () => [{ i: 7609, c: '00700', n: 'TENCENT' }] };
      }
      assert.match(href, /lang=E/);
      return { ok: true, json: async () => ({ result: '[]' }) };
    },
  });
  const result = await call(handler, '/api/hkexnews?action=filings&symbol=0700.HK&lang=en');
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.source.lang, 'E');
});

test('rejects non-HK symbols and SEC-shaped actions', async () => {
  const handler = createHandler({
    fetch: () => { throw new Error('must not fetch'); },
  });
  assert.equal((await call(handler, '/api/hkexnews?action=filings&symbol=AAPL')).statusCode, 400);
  assert.equal((await call(handler, '/api/hkexnews?action=sec-filings&symbol=1398.HK')).statusCode, 400);
  assert.equal((await call(handler, '/api/hkexnews?action=filings&symbol=1398.HK', 'POST')).statusCode, 405);
  assert.equal((await call(handler, '/api/hkexnews?action=filings&symbol=1398.HK&lang=fr')).statusCode, 400);
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
