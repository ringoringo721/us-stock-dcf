const assert = require('node:assert/strict');
const { test } = require('node:test');
const { applyPropertyFv } = require('../scripts/property_fv.cjs');
const { fingerprint } = require('../scripts/hkex_valuation_sources.cjs');
const Scores = require('../statement_scores.js');
const sources = require('../cache/property_fv_sources.json');
const saved = require('../cache/financials/0823.HK_statements_v2.json');
const original = saved.propertyFvOriginal || saved;
const input = { ...saved, annual: structuredClone(original.annual), quarterly: structuredClone(original.quarterly) };
delete input.propertyFvOriginal;
delete input.propertyFvProvenance;

test('Link adjustments use source subtotals, signed FV, attributable bridges and keep original vendor evidence', () => {
  const before = JSON.stringify(input), result = applyPropertyFv(input, '0823.HK');
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(result.propertyFvOriginal.annual, input.annual);
  assert.deepEqual(result.propertyFvOriginal.quarterly, input.quarterly);
  assert.deepEqual(result.propertyFvOriginal.statementFrequencies, input.statementFrequencies);
  const current = result.annual.income.find(row => row.date === '2026-03-31');
  assert.equal(current.operatingIncome, 9357e6, 'Retain the non-property operating impairment');
  assert.equal(current.ebit, 9609e6, 'Do not blindly add FV to already-adjusted vendor operating income');
  assert.equal(current.ebitda, 9699e6);
  assert.equal(current.netIncome, 6430e6, 'Use attributable FV/tax bridge, not the full 14,491m group loss');
  assert.equal(current.eps, 6430e6 / 2588542771);
  assert.equal(result.annual.income.find(row => row.fiscalYear === '2022').weightedAverageShsOutDil, 2129052070,
    'Use the verified reported diluted units for cash-flow-per-unit measures, not mis-mapped vendor counts');
  assert.equal(current.epsDiluted, null, 'Do not fabricate convertible dilution on changed earnings');
  assert.equal(current.incomeBeforeTax, input.annual.income.at(-1).incomeBeforeTax, 'Reported rows remain explicitly reported');
  assert.equal(result.annual.income.find(row => row.fiscalYear === '2020').ebit, 7987e6,
    'Vendor EBIT definitions vary: derive a consistent source-based subtotal, not a second addback');
  assert.equal(fingerprint(result), fingerprint(input), 'Native source-review fingerprint certifies the original archive only');
  assert.deepEqual(applyPropertyFv(result, '0823.HK'), result, 'Repeated overlays are idempotent');
});

test('Combined impairment/FV and incorrect interim share-count-as-profit values never become invented normalized profit', () => {
  const result = applyPropertyFv(input, '0823.HK');
  for (const date of ['2021-03-31', '2020-09-30', '2023-09-30', '2024-03-31']) {
    const row = (date === '2021-03-31' ? result.annual : result.quarterly).income.find(row => row.date === date);
    assert.equal(row.netIncome, null, date);
    assert.ok(row.propertyFvNormalization.netIncomeReason);
  }
  const missing = result.quarterly.income.find(row => row.date === '2020-09-30');
  assert.equal(missing.ebit, null);
  assert.equal(missing.operatingIncome, null);
  const h1 = result.quarterly.income.find(row => row.date === '2021-09-30');
  assert.equal(h1.netIncome, (6288 - 3282 + 152) * 1e6);
  assert.notEqual(h1.netIncome, h1.weightedAverageShsOut);
  for (const row of input.quarterly.income.filter(row => row.date < '2018-09-30')) {
    assert.deepEqual(result.quarterly.income.find(value => value.date === row.date), row, 'Do not erase older unsupported history');
  }
});

test('All official and actual annual-minus-H1 cash periods reconcile without another FV addback or omitted cash property capex', () => {
  const result = applyPropertyFv(input, '0823.HK');
  for (const frequency of ['annual', 'quarterly']) {
    for (const row of result[frequency].cashflow.filter(row => row.propertyFvNormalization)) {
      assert.equal(row.operatingCashFlow + row.netCashProvidedByInvestingActivities
        + row.netCashProvidedByFinancingActivities, row.netChangeInCash, row.date);
      assert.equal(row.cashAtBeginningOfPeriod + row.netChangeInCash + row.effectOfForexChangesOnCash
        + row.heldForSaleCashMovement, row.cashAtEndOfPeriod, row.date);
      assert.equal(row.capitalExpenditure, -(row.cashInvestmentPropertyAdditions + row.cashPpeAdditions), row.date);
      assert.equal(row.freeCashFlow, row.operatingCashFlow + row.capitalExpenditure, row.date);
    }
  }
  const current = result.annual.cashflow.find(row => row.date === '2026-03-31');
  assert.equal(current.operatingCashFlow, 8461e6);
  assert.equal(current.capitalExpenditure, -1934e6);
  assert.equal(current.freeCashFlow, 6527e6);
  assert.equal(current.heldForSaleCashMovement, -45e6);
  const h1 = result.quarterly.cashflow.find(row => row.date === '2025-09-30');
  const h2 = result.quarterly.cashflow.find(row => row.date === '2026-03-31');
  assert.equal(h1.operatingCashFlow + h2.operatingCashFlow, current.operatingCashFlow);
  assert.equal(h2.cashAtBeginningOfPeriod, h1.cashAtEndOfPeriod);
  assert.equal(h2.cashAtEndOfPeriod, current.cashAtEndOfPeriod);
});

test('Only reviewed issuer/period/currency evidence is accepted and reported F-score remains reproducible', () => {
  assert.equal(applyPropertyFv(input, '0388.HK'), input);
  const badCurrency = structuredClone(input);
  badCurrency.annual.income.at(-1).reportedCurrency = 'USD';
  assert.throws(() => applyPropertyFv(badCurrency, '0823.HK'), /source period mismatch/);
  const badCash = structuredClone(sources); badCash.annualCash.at(-1)[6]++;
  assert.throws(() => applyPropertyFv(input, '0823.HK', badCash), /does not reconcile/);
  const badDocs = structuredClone(sources); badDocs.documents['2026annual'].sha256 = '';
  assert.throws(() => applyPropertyFv(input, '0823.HK', badDocs), /source provenance/);
  const result = applyPropertyFv(input, '0823.HK');
  assert.deepEqual(Scores.calculate(result.propertyFvOriginal), Scores.calculate(input));
  assert.equal(result.propertyFvProvenance.fScoreBasis, 'originalReportedStatements');
});

test('Coverage includes the entire universe without treating absent tags or the ASR acquisition balance as earnings', () => {
  const coverage = require('../cache/property_fv_coverage.json');
  const reviews = require('../cache/property_fv_reviews.json');
  const market = { ...require('../full_market_dcf.json'), ...require('../hk_market_dcf.json') };
  assert.deepEqual(Object.keys(coverage.records).sort(), Object.keys(market).sort());
  for (const [ticker, row] of Object.entries(coverage.records)) {
    if (row.candidates.length) assert.ok(reviews.candidates[ticker], ticker);
    else if (row.reason === 'NOT_REVIEWED') {
      assert.equal(row.responseSha256, null, `${ticker}: no invented provider-response evidence`);
      assert.deepEqual(row.periods, []);
    } else assert.match(row.reason, /NO_AS_REPORTED_COVERAGE|NO_ISOLATED_PROPERTY_FV_TAG_RETURNED/);
  }
  assert.equal(reviews.candidates.ASR.decision, 'EXCLUDE_BALANCE_AND_SENSITIVITIES_NOT_PNL');
  assert.match(reviews.candidates.ASR.explanation, /2,855,384,000.*30,906,000/);
});
