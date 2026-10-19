const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rateFor, convertStatements } = require('../usd_currency.js');

const rates = { currencies: {
  HKD: { series: 'HKD_USD', observations: [['2025-01-02', 0.125], ['2025-01-03', 0.1]] },
  CNY: { series: 'CNY_USD', observations: [['2025-01-02', 0.15], ['2025-01-03', 0.14]] },
  JPY: { series: 'JPY_USD', observations: [['2025-01-02', 0.01], ['2025-01-03', 0.009]] }
} };

test('HKD period averages use aligned daily cross rates, not a quotient of averages', () => {
  const fx = rateFor(rates, 'CNY', '2025-01-01', '2025-01-03', 'average', 'HKD');
  assert.ok(Math.abs(fx.rate - 1.3) < 1e-12);
  assert.notEqual(fx.rate, 0.145 / 0.1125);
  assert.equal(rateFor(rates, 'USD', null, '2025-01-03', 'closing', 'HKD').rate, 10);
  assert.equal(rateFor(null, 'HKD', null, '2025-01-03', 'closing', 'HKD').rate, 1);
  assert.equal(rateFor(null, 'CNY', null, '2025-01-03', 'closing', 'HKD').reason, 'missingFxCurrency');
});

test('Missing target dates do not get forward-filled or use a fixed HKD peg', () => {
  assert.equal(rateFor(rates, 'CNY', null, '2025-01-06', 'closing', 'HKD').reason, 'missingFxDate');
  const missing = structuredClone(rates);
  missing.currencies.HKD.observations.pop();
  assert.equal(rateFor(missing, 'CNY', null, '2025-01-03', 'closing', 'HKD').reason, 'missingFxDate');
});

test('JPY gaming financials use daily HKD cross rates without mistaking yen amounts for HK dollars', () => {
  const fx = rateFor(rates, 'JPY', '2025-01-01', '2025-01-03', 'average', 'HKD');
  assert.ok(Math.abs(fx.rate - 0.085) < 1e-12);
  assert.ok(Math.abs(rateFor(rates, 'JPY', null, '2025-01-03', 'closing', 'HKD').rate - 0.09) < 1e-12);
  const cached = require('../cache/fx/hkd_rates.json');
  assert.ok(cached.currencies.JPY.observations[0][0] <= '2010-01-04');
  const historical = rateFor(cached, 'JPY', '2011-01-01', '2011-06-30', 'average', 'HKD');
  assert.equal(historical.reason, null);
  assert.ok(historical.rate > 0 && historical.rate < 1);
  const usd = rateFor(cached, 'USD', '2011-01-01', '2011-06-30', 'average', 'HKD');
  assert.equal(usd.reason, null);
  assert.ok(usd.rate > 7 && usd.rate < 9);
});

test('HKD conversion retains original currency, source dates, shares and nonadditive metadata', () => {
  const row = { date: '2025-01-03', periodStartDate: '2025-01-01', period: 'Q1',
    fiscalYear: '2025', reportedCurrency: 'CNY', revenue: 100, weightedAverageShsOut: 20,
    sourceReleaseDate: '2025-02-14', derivation: 'reported', periodLength: 6 };
  const input = { calculationCurrency: 'HKD', annual: { income: [], cashflow: [], balance: [] },
    quarterly: { income: [row], cashflow: [], balance: [{ ...row, totalAssets: 500 }] } };
  const result = convertStatements(input, rates);
  assert.ok(Math.abs(result.quarterly.income[0].revenue - 130) < 1e-10);
  assert.ok(Math.abs(result.quarterly.balance[0].totalAssets - 700) < 1e-10);
  assert.equal(result.quarterly.income[0].reportedCurrency, 'HKD');
  assert.equal(result.quarterly.income[0].sourceReportedCurrency, 'CNY');
  assert.equal(result.quarterly.income[0].weightedAverageShsOut, 20);
  assert.equal(result.quarterly.income[0].periodLength, 6);
  assert.equal(result.quarterly.income[0].sourceReleaseDate, row.sourceReleaseDate);
  assert.deepEqual(convertStatements(result, rates), result);
  assert.throws(() => convertStatements(result, rates, 'USD'), /reconvert/);
  assert.equal(input.quarterly.income[0].revenue, 100);
});
