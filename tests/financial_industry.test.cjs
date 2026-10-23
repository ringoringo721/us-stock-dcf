const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  usesFinancialValuationModel, isInsuranceIndustry, shouldNormalizeBankRevenue,
  bankRevenueUsesGrossInterest, bankOperatingRevenue, normalizeBankIncomeRow,
  normalizeBankStatements
} = require('../financial_industry.js');

test('baseline and expansion bank/insurance industries use financial models', () => {
  assert.equal(usesFinancialValuationModel('Diversified Banks', 'JPM'), true);
  assert.equal(usesFinancialValuationModel('Banks - Regional', 'DB'), true);
  assert.equal(usesFinancialValuationModel('Banks - Diversified', 'HSBC'), true);
  assert.equal(usesFinancialValuationModel('Insurance - Life', 'MFC'), true);
  assert.equal(usesFinancialValuationModel('Financial - Credit Services', 'AXP'), true);
  assert.equal(usesFinancialValuationModel('Property & Casualty Insurance', 'PGR'), true);
});

test('brokers, asset managers, midstream and Berkshire stay on corporate DCF', () => {
  assert.equal(usesFinancialValuationModel('Insurance - Brokers', 'MRSH'), false);
  assert.equal(usesFinancialValuationModel('Insurance Brokers', 'AON'), false);
  assert.equal(usesFinancialValuationModel('Asset Management', 'BLK'), false);
  assert.equal(usesFinancialValuationModel('Oil & Gas Midstream', 'CQP'), false);
  assert.equal(usesFinancialValuationModel('Insurance - Diversified', 'BRK-A'), false);
  assert.equal(usesFinancialValuationModel('Consumer Electronics', 'AAPL'), false);
});

test('insurance industry helper covers old and new FMP labels', () => {
  assert.equal(isInsuranceIndustry('Life & Health Insurance'), true);
  assert.equal(isInsuranceIndustry('Insurance - Life'), true);
  assert.equal(isInsuranceIndustry('Banks - Regional'), false);
});

test('banks and insurers suppress industrial gross-profit display', () => {
  const { suppressIndustrialGrossProfit } = require('../financial_industry.js');
  assert.equal(suppressIndustrialGrossProfit('Banks - Diversified', '3988.HK'), true);
  assert.equal(suppressIndustrialGrossProfit('Diversified Banks', 'JPM'), true);
  assert.equal(suppressIndustrialGrossProfit('Insurance - Life', 'AFL'), true);
  assert.equal(suppressIndustrialGrossProfit('Semiconductors', 'NVDA'), false);
  assert.equal(suppressIndustrialGrossProfit('Software - Infrastructure', 'NET'), false);
});

test('bank revenue normalization targets banks/credit, not insurers', () => {
  assert.equal(shouldNormalizeBankRevenue('Banks - Diversified', '3988.HK'), true);
  assert.equal(shouldNormalizeBankRevenue('Diversified Banks', 'JPM'), true);
  assert.equal(shouldNormalizeBankRevenue('Financial - Credit Services', 'AXP'), true);
  assert.equal(shouldNormalizeBankRevenue('Insurance - Life', 'AFL'), false);
  assert.equal(shouldNormalizeBankRevenue('Semiconductors', 'NVDA'), false);
});

test('gross-interest revenue framing is detected and converted to NII + non-interest', () => {
  const gross = {
    revenue: 1217380000000,
    interestIncome: 1000907000000,
    interestExpense: 560202000000,
    netInterestIncome: 440705000000
  };
  const netStyle = {
    revenue: 531258000000,
    interestIncome: 1071539000000,
    interestExpense: 622605000000,
    netInterestIncome: 448934000000
  };
  assert.equal(bankRevenueUsesGrossInterest(gross), true);
  assert.equal(bankRevenueUsesGrossInterest(netStyle), false);
  assert.equal(bankOperatingRevenue(gross), 440705000000 + (1217380000000 - 1000907000000));
  assert.equal(bankOperatingRevenue(netStyle), netStyle.revenue);
  const normalized = normalizeBankIncomeRow(gross, 'Banks - Diversified', '3988.HK');
  assert.equal(normalized.revenue, bankOperatingRevenue(gross));
  assert.equal(normalized.providerRevenue, gross.revenue);
  assert.equal(normalizeBankIncomeRow(gross, 'Insurance - Life', 'AFL').revenue, gross.revenue);
});

test('3988.HK 2025 annual revenue spike normalizes while earlier net-style years stay put', () => {
  const source = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'financials', '3988.HK_statements_v2.json'), 'utf8'));
  const normalized = normalizeBankStatements(source, 'Banks - Diversified', '3988.HK');
  const byYear = Object.fromEntries(normalized.annual.income.map(row => [row.date.slice(0, 4), row]));
  assert.equal(byYear['2024'].revenue, 531258000000);
  assert.ok(!byYear['2024'].revenueNormalization);
  assert.equal(byYear['2025'].revenue, 657178000000);
  assert.equal(byYear['2025'].providerRevenue, 1217380000000);
  const growth = byYear['2025'].revenue / byYear['2024'].revenue - 1;
  assert.ok(growth < 0.5, `corrected YoY should be far below the broken +129% (got ${(growth * 100).toFixed(1)}%)`);
});

test('bank revenue normalization is idempotent across convert/reportedGrowth passes', () => {
  const { convertStatements } = require('../usd_currency.js');
  const { reportedGrowth } = require('../scripts/reported_growth.cjs');
  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'fx', 'usd_rates.json'), 'utf8'));
  const source = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'financials', 'JPM_statements_v2.json'), 'utf8'));
  const once = normalizeBankStatements(convertStatements(source, rates), 'Diversified Banks', 'JPM');
  const twice = normalizeBankStatements(structuredClone(once), 'Diversified Banks', 'JPM');
  assert.deepEqual(
    twice.quarterly.income.map(row => row.revenue),
    once.quarterly.income.map(row => row.revenue)
  );
  const fromSource = reportedGrowth(source, rates, { industry: 'Diversified Banks', ticker: 'JPM' });
  const fromNormalized = reportedGrowth(once, rates, { industry: 'Diversified Banks', ticker: 'JPM' });
  assert.equal(fromNormalized.fields.revenue.value, fromSource.fields.revenue.value);
});

test('peer annualView uses normalized bank revenue for 3988.HK growth', () => {
  const { annualView } = require('../peer_comparison.js');
  const { convertStatements } = require('../usd_currency.js');
  const rates = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'fx', 'usd_rates.json'), 'utf8'));
  const source = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'financials', '3988.HK_statements_v2.json'), 'utf8'));
  const data = convertStatements(source, rates);
  const stock = {
    ticker: '3988.HK', industry: 'Banks - Diversified', calculationCurrency: 'HKD',
    mcap: 1e6, shares: 1, shareBasis: 'commonSharesOutstandingExcludingTreasury', price: 1
  };
  const view = annualView(stock, data);
  assert.ok(view.peerAnnual.growth.revenue);
  assert.ok(!view.peerAnnual.growth.revenue.reason, view.peerAnnual.growth.revenue.reason);
  assert.ok(Math.abs(view.peerAnnual.growth.revenue.value) < 50,
    `peer revenue YoY should not stay near +129% (got ${view.peerAnnual.growth.revenue.value})`);
});
