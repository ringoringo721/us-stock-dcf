const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Market = require('../market_context.js');
const Ratios = require('../fcf_ratios.js');
const Profile = require('../profile_overview.js');
const Price = require('../price_history.js');

// Deliberately isolated arithmetic fixture, not a production company dataset.
function halfYears() {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    fiscalYear: 2022 + Math.floor(i / 2), period: i % 2 ? 'Q4' : 'Q2',
    date: `${2022 + Math.floor(i / 2)}-${i % 2 ? '12-31' : '06-30'}`,
    periodStartDate: `${2022 + Math.floor(i / 2)}-${i % 2 ? '07-01' : '01-01'}`,
    periodLength: 6, reportedCurrency: 'HKD',
    revenue: (i + 1) * 100, grossProfit: (i + 1) * 40, operatingIncome: (i + 1) * 25,
    netIncome: (i + 1) * 20, ebitda: (i + 1) * 30,
    freeCashFlow: (i + 1) * 10, epsDiluted: i + 1, commonDividendsPaid: -(i + 1) * 2,
    weightedAverageShsOutDil: 10, totalAssets: (i + 1) * 1000,
    totalStockholdersEquity: (i + 1) * 500, goodwillAndIntangibleAssets: (i + 1) * 100
  }));
  return { calculationCurrency: 'HKD', reportingFrequency: 'semiannual',
    statementFrequencies: { income: 'semiannual', balance: 'semiannual', cashflow: 'semiannual' },
    quarterly: Object.fromEntries(['income', 'balance', 'cashflow'].map(key => [key, structuredClone(rows)])),
    annual: { income: [], balance: [], cashflow: [] } };
}

test('market is explicit or inferred only from a qualified HK hash, without mixing datasets', () => {
  assert.equal(Market.resolve({ search: '?market=HKEX', hash: '#AAPL/profile' }), 'HKEX');
  assert.equal(Market.resolve({ search: '?market=US', hash: '#0700.HK/profile' }), 'US');
  assert.equal(Market.resolve({ hash: '#0700.HK/profile' }), 'HKEX');
  assert.equal(Market.resolve({ hash: '#9988.HK' }), 'HKEX');
  assert.equal(Market.resolve({ hash: '#JPM/profile' }), 'US');
  const context = { URLSearchParams, location: { search: '?market=HKEX' },
    FULL_MARKET_DATA: { US: {} }, HK_MARKET_DATA: { '0700.HK': {} },
    FCFF_DATA: { stocks: { US: {} } }, HK_FCFF_DATA: { stocks: { '0700.HK': {} } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../market_context.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.MarketContext.stocks()), ['0700.HK']);
  assert.deepEqual(Object.keys(context.MarketContext.fcff().stocks), ['0700.HK']);
  assert.equal(context.MarketContext.currency, 'HKD');
  assert.match(context.MarketContext.labels({ money: 'USD / $M' }).money, /^HKD \/ HKD M$/);
});

test('saved models keep qualified securities and currencies isolated, preserving legacy USD', () => {
  assert.equal(Market.compatibleSaved({}, 'JPM'), true);
  assert.equal(Market.compatibleSaved({}, '0005.HK'), false);
  assert.equal(Market.compatibleSaved({ currency: 'USD' }, '0005.HK'), false);
  assert.equal(Market.compatibleSaved({ currency: 'HKD' }, '0005.HK'), true);
  assert.equal(Market.compatibleSaved({ currency: 'HKD' }, 'JPM'), false);
  assert.equal(Market.compatibleSaved({ currency: 'HKD', params: { currency: 'USD' } }, '0005.HK'), false);
});

test('half-year TTM sums two real periods and uses one-year opening balance and real H1/H2 columns', () => {
  const data = halfYears();
  const fcf = Ratios.calculate(data);
  assert.equal(fcf.length, 6);
  assert.equal(fcf[0].ratios.assets.reason, 'incompleteTtm');
  assert.equal(fcf.at(-1).label, 'FY 2024 H2');
  assert.equal(fcf.at(-1).ratios.assets.value, 110 / 4000 * 100);
  assert.equal(fcf.at(-1).ratios.sales.value, 10);
  const returns = Ratios.calculateReturns(data);
  assert.equal(returns.at(-1).ratios.roa.value, 220 / 4000 * 100);
  assert.equal(returns.at(-1).ratios.rote.value, 220 / 1600 * 100);
  const single = Ratios.calculateReturns(data, { flow: 'single' }).at(-1);
  assert.equal(single.ratios.roa.value, 120 / 5000 * 100);
  const balances = Ratios.calculateBalances(data);
  assert.equal(balances.length, 6);
  assert.deepEqual(balances.map(column => column.label),
    ['FY 2022 H1', 'FY 2022 H2', 'FY 2023 H1', 'FY 2023 H2', 'FY 2024 H1', 'FY 2024 H2']);
  assert.equal(balances.at(-1).currency, 'HKD');
  const earnings = Ratios.calculateEarnings(data).at(-1);
  assert.equal(earnings.amounts.eps.value, 11);
  assert.equal(earnings.amounts.fcf.value, 11);
  assert.equal(earnings.amounts.dividend.value, 2.2);
  const summary = Profile.calculate(data);
  assert.equal(summary.revenue, 1100);
  assert.equal(summary.grossMargin, 40);
  assert.equal(summary.revenueGrowth, (1100 / 700 - 1) * 100);
  assert.equal(Ratios.financialReference(data, { shares: 0.00001 }).tbvps, 240);
});

test('semiannual gaps, duplicate reports, invalid half-year date gaps and missing values stay unavailable', () => {
  const gap = halfYears();
  gap.quarterly.cashflow.splice(4, 1);
  assert.equal(Ratios.calculate(gap).at(-1).ratios.assets.reason, 'incompleteTtm');
  const irregular = halfYears();
  for (const rows of Object.values(irregular.quarterly)) rows.at(-1).date = '2024-09-30';
  assert.equal(Ratios.calculate(irregular).at(-1).ratios.assets.reason, 'nonConsecutive');
  assert.equal(Ratios.calculateEarnings(irregular).at(-1).amounts.eps.reason, 'nonConsecutive');
  assert.equal(Profile.calculate(irregular).revenue, null);
  const duplicate = halfYears();
  duplicate.quarterly.income.push(structuredClone(duplicate.quarterly.income.at(-1)));
  assert.equal(Profile.calculate(duplicate).revenue, null);
  const missing = halfYears();
  missing.quarterly.cashflow.at(-1).freeCashFlow = null;
  assert.equal(Ratios.calculate(missing).at(-1).ratios.assets.value, null);
});

test('annual-only cash flows never become interim or TTM values while income returns remain usable', () => {
  const data = halfYears();
  data.statementFrequencies.cashflow = 'annual';
  // A source may retain a historical placeholder: the declared frequency still wins.
  assert.equal(Ratios.calculate(data).at(-1).ratios.assets.reason, 'annualCashflowOnly');
  const earnings = Ratios.calculateEarnings(data).at(-1);
  assert.equal(earnings.amounts.eps.value, 11);
  assert.equal(earnings.amounts.fcf.reason, 'annualCashflowOnly');
  assert.equal(earnings.amounts.dividend.reason, 'annualCashflowOnly');
  assert.notEqual(Ratios.calculateReturns(data).at(-1).ratios.roa.value, null);
});

test('derived H2 additive flows do not synthesize nonadditive EPS or diluted shares', () => {
  const data = halfYears();
  const h2 = data.quarterly.income.at(-1);
  h2.epsDiluted = null;
  h2.weightedAverageShsOutDil = null;
  h2.derivation = { method: 'FY minus H1', sourceDates: ['2024-06-30', '2024-12-31'] };
  const earnings = Ratios.calculateEarnings(data).at(-1);
  assert.equal(earnings.amounts.eps.value, null);
  assert.equal(earnings.amounts.fcf.reason, 'missingDilutedShares');
  assert.equal(Profile.calculate(data).revenue, 1100);
  assert.equal(Ratios.calculate(data).at(-1).ratios.sales.value, 10);
  assert.equal(h2.epsDiluted, null);
});

test('fiscal-year-end TTM preserves verified annual EPS without inventing derived H2 EPS', () => {
  const data = halfYears();
  const latest = data.quarterly.income.at(-1);
  latest.epsDiluted = null;
  latest.weightedAverageShsOutDil = null;
  latest.derivation = 'annualMinusReportedH1';
  data.annual.income.push({ ...latest, period: 'FY', periodLength: 12, periodStartDate: '2024-01-01', epsDiluted: -2.86 });
  const result = Ratios.calculateEarnings(data).at(-1);
  assert.equal(result.amounts.eps.value, -2.86);
  assert.equal(result.amounts.eps.basis, 'reportedAnnualAtFiscalYearEnd');
  assert.equal(result.amounts.fcf.reason, 'missingDilutedShares');
  assert.equal(latest.epsDiluted, null);
  data.annual.income[0].date = '2024-12-30';
  assert.equal(Ratios.calculateEarnings(data).at(-1).amounts.eps.value, null);
  data.annual.income[0].date = latest.date;
  data.annual.income[0].currencyConversion = { reason: 'missingFx' };
  assert.equal(Ratios.calculateEarnings(data).at(-1).amounts.eps.value, null);
});

test('HK prices validate and export HKD without relabeling USD histories', () => {
  const record = { version: 1, ticker: '0700.HK', currency: 'HKD',
    source: 'FMP historical-price-eod/full', priceBasis: 'splitAdjustedClose',
    requestedFrom: '2024-01-01', requestedTo: '2024-12-31',
    rows: [['2024-01-02', 300.125, null], ['2024-12-31', 400.25, 0]] };
  assert.equal(Price.validate(record, '0700.HK'), record);
  assert.throws(() => Price.validate({ ...record, currency: 'USD' }, '0700.HK'));
  assert.throws(() => Price.validate({ ...record, ticker: 'JPM' }, 'JPM'));
  assert.match(Price.csv(record.rows, 'HKD'), /close \(HKD\)/);
  assert.match(Price.csv(record.rows, 'HKD'), /300\.125,\r\n/);
  assert.match(Price.csv(record.rows), /close \(USD\)/);
});

module.exports = { halfYears };
