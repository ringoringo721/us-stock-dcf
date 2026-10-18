const assert = require('node:assert/strict');
const { test } = require('node:test');
const { applyReports } = require('../scripts/apply_hkex_moat.cjs');
const market = require('../hk_market_dcf.json');
const reports = require('../cache/hkex_moat.json');

test('Applying matching moat reports preserves every financial and valuation field', () => {
  const updated = applyReports(market, reports);
  for (const ticker of Object.keys(reports)) {
    const omit = stock => {
      const result = structuredClone(stock);
      delete result.moat;
      delete result.description_zh;
      delete result.ratingSources.moat;
      return result;
    };
    assert.deepEqual(omit(updated[ticker]), omit(market[ticker]));
    assert.equal(updated[ticker].ratingSources.moat.reason, null);
    assert.equal(updated[ticker].moat.ticker, ticker);
  }
});

test('Other securities, stale evidence and failed refreshes cannot overwrite existing ratings', () => {
  for (const edit of [
    report => { report.report.ticker = '9988.HK'; },
    report => { report.evidenceHash = 'different'; },
    report => { report.lastError = { code: 403 }; },
    report => { report.report.m1_brand_pricing.sources = []; }
  ]) {
    const invalid = structuredClone(reports);
    edit(invalid['0700.HK']);
    assert.throws(() => applyReports(market, invalid));
  }
});
