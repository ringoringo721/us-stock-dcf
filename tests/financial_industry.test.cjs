const test = require('node:test');
const assert = require('node:assert/strict');
const { usesFinancialValuationModel, isInsuranceIndustry } = require('../financial_industry.js');

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
