'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Docs = require('../company_documents.js');

test('normalizeFilings keeps SEC open links and sorts newest first', () => {
  const rows = Docs.normalizeFilings([
    { formType: '10-Q', filingDate: '2024-01-01', finalLink: 'https://www.sec.gov/a.htm' },
    { formType: '10-K', filingDate: '2025-01-01', link: 'https://www.sec.gov/b.htm' },
  ], 'AAPL');
  assert.equal(rows[0].form, '10-K');
  assert.equal(rows[0].link, 'https://www.sec.gov/b.htm');
});

test('normalizeTranscriptDates and open URL prefers SEC 8-K for US', () => {
  const rows = Docs.normalizeTranscriptDates([
    { fiscalYear: 2024, quarter: 2, date: '2024-05-01' },
    { year: 2025, quarter: 1, date: '2025-02-01' },
  ], 'AAPL');
  assert.equal(rows[0].year, 2025);
  assert.match(Docs.transcriptOpenUrl('AAPL', 2025, 1), /sec\.gov\/edgar\/search/);
  assert.match(Docs.transcriptOpenUrl('AAPL', 2025, 1), /8-K/);
  assert.doesNotMatch(Docs.transcriptOpenUrl('AAPL', 2025, 1), /earning-call-transcript/);
});

test('publicLinks expose SEC search for US names', () => {
  const links = Docs.publicLinks('PCAR', { exchange: 'NASDAQ', calculationCurrency: 'USD' });
  assert.ok(links.some(link => /sec\.gov/.test(link.url)));
  assert.ok(links.every(link => !/hkexnews/i.test(link.url)));
});

test('HK listings get HKEXnews public links — never SEC', () => {
  const links = Docs.publicLinks('1398.HK', {
    ticker: '1398.HK', market: 'HKEX', exchange: 'HKEX', calculationCurrency: 'HKD',
  });
  assert.ok(links.length >= 1);
  assert.ok(links.every(link => !/sec\.gov/i.test(link.url)));
  assert.ok(links.some(link => /hkexnews\.hk/i.test(link.url)));
  assert.equal(Docs.isUsListed({ ticker: '1398.HK', market: 'HKEX' }), false);
  assert.equal(Docs.isUsListed({ ticker: '0005.hk', calculationCurrency: 'HKD' }), false);
});

test('transcriptOpenUrl for .HK opens HKEXnews, not SEC', () => {
  const url = Docs.transcriptOpenUrl('1398.HK', 2026, 3, '2026-10-30', 'zh');
  assert.match(url, /hkexnews\.hk/i);
  assert.doesNotMatch(url, /sec\.gov/i);
  assert.doesNotMatch(url, /8-K/);
});

test('rememberHkexSearch upgrades stock-scoped transcript URL', () => {
  const scoped = 'https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=en&stockId=12593';
  Docs.rememberHkexSearch('1398.HK', scoped);
  assert.equal(Docs.transcriptOpenUrl('1398.HK', 2026, 3), scoped);
  assert.equal(Docs.hkexSearchUrlFor('1398.HK'), scoped);
});

test('hkexStockCode pads 4-digit and 5-digit tickers', () => {
  assert.equal(Docs.hkexStockCode('1398.HK'), '01398');
  assert.equal(Docs.hkexStockCode('0700.HK'), '00700');
  assert.equal(Docs.hkexStockCode('09988.HK'), '09988');
  assert.equal(Docs.hkexStockCode('AAPL'), null);
});
