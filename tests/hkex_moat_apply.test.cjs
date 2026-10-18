const assert = require('node:assert/strict');
const { test } = require('node:test');
const { applyReports } = require('../scripts/apply_hkex_moat.cjs');
const market = require('../hk_market_dcf.json');
const reports = require('../cache/hkex_moat.json');

test('Applying matching moat reports preserves every financial and valuation field', () => {
  const matching = Object.fromEntries(Object.entries(reports).filter(([ticker, report]) =>
    report.evidenceHash === market[ticker].ratingSources.moat.currentEvidenceHash));
  assert.ok(Object.keys(matching).length > 0);
  const updated = applyReports(market, matching);
  for (const ticker of Object.keys(matching)) {
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
    const invalid = { '0700.HK': structuredClone(reports['0700.HK']) };
    edit(invalid['0700.HK']);
    assert.throws(() => applyReports(market, invalid));
  }
});

test('Official statement corrections retain earlier narratives but require new evidence-matched AI assessment', () => {
  for (const ticker of ['0388.HK', '0005.HK']) {
    assert.notEqual(reports[ticker].evidenceHash, market[ticker].ratingSources.moat.currentEvidenceHash);
    assert.deepEqual(market[ticker].moat, reports[ticker].report);
    assert.throws(() => applyReports(market, { [ticker]: reports[ticker] }), /evidence does not match/);
  }
});
