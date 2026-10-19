const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculate } = require('../statement_scores.js');

function fixture() {
  const row = (year, fields) => ({ date: `${year}-12-31`, fiscalYear: year, period: 'FY', reportedCurrency: 'HKD', ...fields });
  return { annual: {
    income: [row(2023, { revenue: 100, netIncome: 8, grossProfit: 25 }),
      row(2024, { revenue: 150, netIncome: 10, grossProfit: 40 }),
      row(2025, { revenue: 200, netIncome: 14, grossProfit: 80 })],
    balance: [row(2023, { totalAssets: 100 }),
      row(2024, { totalAssets: 110, longTermDebt: 22, totalCurrentAssets: 44, totalCurrentLiabilities: 22 }),
      row(2025, { totalAssets: 120, longTermDebt: 12, totalCurrentAssets: 60, totalCurrentLiabilities: 20 })],
    cashflow: [row(2024, { operatingCashFlow: 12, commonStockIssuance: 0 }),
      row(2025, { operatingCashFlow: 18, freeCashFlow: -20, commonStockIssuance: 0 })]
  }, quarterly: { income: [], balance: [], cashflow: [] } };
}
test('All nine financial-statement comparisons are independent and auditable', () => {
  const result = calculate(fixture());
  assert.equal(result.score, 9);
  assert.equal(result.evaluatedTests, 9);
  assert.equal(result.date, '2025-12-31');
  assert.equal(result.basis, 'comparableAnnual');
  assert.ok(result.items.every(item => item.reason === null && item.passed === 1));
});
test('CFO is not FCF; declining ROA and new issuance cannot receive automatic points', () => {
  const data = fixture();
  data.annual.income.at(-1).netIncome = 8;
  data.annual.cashflow.at(-1).commonStockIssuance = 2;
  const result = calculate(data);
  assert.equal(result.items[1].passed, 1, 'Positive CFO earns the point even with negative FCF');
  assert.equal(result.items[2].passed, 0, 'ROA above 6% is not evidence of year-over-year improvement');
  assert.equal(result.items[6].passed, 0, 'Issuance is actually tested');
});
test('Improvement is measured against prior figures, not fixed leverage/liquidity thresholds', () => {
  const data = fixture();
  Object.assign(data.annual.balance.at(-2), { totalCurrentAssets: 16, totalCurrentLiabilities: 20 });
  Object.assign(data.annual.balance.at(-1), { totalCurrentAssets: 18, totalCurrentLiabilities: 20, totalLiabilities: 119 });
  const result = calculate(data);
  assert.equal(result.items[4].passed, 1);
  assert.equal(result.items[5].passed, 1, '0.9 is an improvement over 0.8 even though neither exceeds 1.25');
});
test('Missing tests are unknown, not failed or automatically passed; true zero remains a valid observation', () => {
  const data = fixture();
  delete data.annual.cashflow.at(-1).commonStockIssuance;
  data.annual.cashflow.at(-1).operatingCashFlow = 0;
  const result = calculate(data);
  assert.equal(result.score, null);
  assert.equal(result.evaluatedTests, 8);
  assert.equal(result.items[1].passed, 0);
  assert.equal(result.items[6].passed, null);
  assert.equal(result.reason, 'incompleteCriteria');
});
test('Currency changes cannot silently produce comparable ROA or turnover', () => {
  const data = fixture();
  data.annual.balance[0].reportedCurrency = 'CNY';
  const result = calculate(data);
  assert.equal(result.items[2].passed, null);
  assert.equal(result.items[8].passed, null);
  assert.equal(result.score, null);
});

test('audited insurer presentation excludes liquidity without awarding or normalizing a ninth point', () => {
  const data = fixture();
  data.annual.balance.at(-1).totalCurrentLiabilities = 0;
  const review = require('../cache/pf_applicability.json').tickers['1299.HK'];
  const result = calculate(data, { currentRatioNotApplicable: review });
  assert.equal(result.score, 8);
  assert.equal(result.standardScore, null);
  assert.equal(result.applicableTests, 8);
  assert.equal(result.assessmentType, 'applicableItems');
  assert.equal(result.items[5].applicable, false);
  assert.equal(result.items[5].passed, null);
  assert.equal(result.items[5].reason, 'unclassifiedInsuranceBalanceSheet');
  assert.deepEqual(result.items[5].sources, review.sources);
  assert.equal(result.reason, null);
  assert.equal(calculate(data).score, null, 'No industry-wide automatic exemption');
  delete data.annual.cashflow.at(-1).commonStockIssuance;
  assert.equal(calculate(data, { currentRatioNotApplicable: review }).score, null, 'Other missing inputs remain unknown');
});

test('insurer exclusions require evidence and never extend to unreviewed future statements', () => {
  const review = require('../cache/pf_applicability.json').tickers['1299.HK'];
  assert.throws(() => calculate(fixture(), { currentRatioNotApplicable: { ...review, sources: [] } }), /requires audited/);
  const result = calculate(fixture(), { currentRatioNotApplicable: { ...review, reviewedThrough: '2024-12-31' } });
  assert.equal(result.score, 9);
  assert.equal(result.assessmentType, undefined);
});
