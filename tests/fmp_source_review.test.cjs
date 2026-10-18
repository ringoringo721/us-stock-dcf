const { test } = require('node:test');
const assert = require('node:assert/strict');
const data = require('../cache/company/0823.HK.json');
const statements = require('../cache/financials/0823.HK_statements_v2.json');
const official = require('../cache/hkex_valuation_reconciliations.json').stocks['0823.HK'];
const { sourceReview } = require('../scripts/fmp_source_review.cjs');

test('Link CFO classifications reconcile exactly, without treating EBIT or EBITDA as cash flow', () => {
  const review = sourceReview(data, statements, official);
  assert.equal(review.reason, null);
  assert.equal(review.years[0].providerCfoBasis, 'asReported');
  const current = review.years[1];
  assert.equal(current.official.reportedOperatingCashFlow, 8461);
  assert.equal(8461 - 1812 + 80 + 87, current.provider.operatingCashFlow);
  assert.equal(current.providerCfoBasis, 'reclassified');
  assert.equal(current.provider.ebit, -4882);
  assert.equal(current.provider.ebitda, -4792);
  assert.notEqual(current.provider.ebitda, current.provider.operatingCashFlow);
  assert.equal(current.provider.purchasesOfInvestments, -(1895 + 467 + 17));
  assert.equal(current.fullCashCapex, 1934);
  assert.equal(current.operatingCashLessPropertyAndPpe, 6527);
});

test('official comparisons cannot silently survive changed financial fingerprints, years, currency or provider mapping', () => {
  const modified = structuredClone(statements);
  modified.annual.cashflow.at(-1).operatingCashFlow++;
  assert.equal(sourceReview(data, modified, official).reason, 'OFFICIAL_COMPARISON_REVIEW_REQUIRED');
  assert.equal(sourceReview({ ...data, currency: 'USD' }, statements, official).reason, 'OFFICIAL_COMPARISON_REVIEW_REQUIRED');
  assert.equal(sourceReview({ ...data, forecastBase: { year: 2027 } }, statements, official).reason, 'OFFICIAL_COMPARISON_REVIEW_REQUIRED');
  const changedProvider = structuredClone(data);
  changedProvider.models.customLevered.data.find(row => row.year === '2026').operatingCashFlow = 8461000000;
  assert.equal(sourceReview(changedProvider, statements, official).reason, 'PROVIDER_COMPARISON_CHANGED_REVIEW_REQUIRED');
});
