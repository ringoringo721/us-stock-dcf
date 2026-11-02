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

test('normalizeTranscriptDates and open URL prefers SEC 8-K', () => {
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
  assert.equal(Docs.publicLinks('0005.HK', { ticker: '0005.HK', calculationCurrency: 'HKD' }).length, 0);
});
