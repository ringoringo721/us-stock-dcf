'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { statementTable } = require('../scripts/build_hkex.cjs');

function loadMarketContext() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'market_context.js'), 'utf8');
  const context = {
    module: { exports: {} },
    exports: {},
    URLSearchParams,
    location: { search: '?market=HKEX', hash: '' }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.module.exports;
}

test('statementTable does not pad six null duration-unverified columns when provider statements are empty', () => {
  const empty = {
    calculationCurrency: 'HKD',
    reportingFrequency: 'quarterly',
    qualityWarnings: [
      { code: 'providerStatementUnavailable', period: 'annual', type: 'income' },
      { code: 'providerStatementUnavailable', period: 'annual', type: 'balance' },
      { code: 'providerStatementUnavailable', period: 'annual', type: 'cashflow' }
    ],
    annual: { income: [], balance: [], cashflow: [] },
    quarterly: { income: [], balance: [], cashflow: [] }
  };
  const table = statementTable(empty);
  assert.equal(table.providerStatementsUnavailable, true);
  assert.deepEqual(table.annual_dates, []);
  assert.deepEqual(table.annual_period_lengths, []);
  assert.deepEqual(table.quarterly_raw.dates, []);
  assert.equal(Object.keys(table.income).length, 0);
  assert.ok(table.qualityWarnings.some(row => row.code === 'providerStatementUnavailable'));
});

test('statementTable still pads short annual histories when real rows exist', () => {
  const row = {
    symbol: '0001.HK', date: '2024-12-31', period: 'FY', fiscalYear: 2024, reportedCurrency: 'HKD',
    revenue: 100, periodLength: 12
  };
  const table = statementTable({
    reportingFrequency: 'annual',
    annual: { income: [row], balance: [{ ...row }], cashflow: [{ ...row, freeCashFlow: 1 }] },
    quarterly: { income: [], balance: [], cashflow: [] }
  });
  assert.equal(table.providerStatementsUnavailable, undefined);
  assert.equal(table.annual_dates.length, 6);
  assert.deepEqual(table.annual_dates.slice(0, 4), [null, null, null, null]);
  assert.equal(table.annual_dates[4], '2024-12');
});

test('MarketContext.statementsUnavailable distinguishes empty provider coverage from dated unverified periods', () => {
  const MarketContext = loadMarketContext();
  assert.equal(MarketContext.statementsUnavailable({
    qualityWarnings: [{ code: 'providerStatementUnavailable', period: 'annual', type: 'income' }],
    statements_raw: {
      annual_dates: [null, null, null, null, null, null],
      quarterly_raw: { dates: [] }
    }
  }), true, 'legacy six-null skeleton with provider warning');
  assert.equal(MarketContext.statementsUnavailable({
    statements_raw: { providerStatementsUnavailable: true, annual_dates: [] }
  }), true);
  assert.equal(MarketContext.statementsUnavailable({
    qualityWarnings: [{ code: 'unverifiedProviderPeriod', type: 'income', date: '2024-06-30' }],
    statements_raw: {
      annual_dates: ['2021-12', '2022-12', '2023-12', '2024-12', '2025-12', '2026-06'],
      quarterly_raw: { dates: ['2025-06', '2025-12'] }
    }
  }), false, 'dated statements with only period-verification warnings stay renderable');
  assert.equal(MarketContext.statementsUnavailable({
    qualityWarnings: [{ code: 'providerStatementUnavailable', period: 'annual', type: 'income' }],
    statements_raw: {
      annual_dates: [null, null, null, null, null, '2026-06'],
      quarterly_raw: { dates: ['2026-06'] }
    }
  }), false, 'TTM-only from interim rows is not treated as total absence');
  assert.match(MarketContext.statementsUnavailableMessage('zh'), /供應商未提供/);
  assert.match(MarketContext.statementsUnavailableMessage('en'), /Provider financial statements are unavailable/);
});

test('0627.HK and 2677.HK cache still mark provider statements unavailable without inventing rows', () => {
  for (const ticker of ['0627.HK', '2677.HK']) {
    const statements = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'cache', 'financials', `${ticker}_statements_v2.json`), 'utf8'));
    assert.equal(statements.annual.income.length, 0);
    assert.ok(statements.qualityWarnings.some(row => row.code === 'providerStatementUnavailable'));
    const table = statementTable(statements);
    assert.equal(table.providerStatementsUnavailable, true);
    assert.deepEqual(table.annual_dates, []);
    const company = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'cache', 'hk_companies', `${ticker}.json`), 'utf8'));
    const MarketContext = loadMarketContext();
    assert.equal(MarketContext.statementsUnavailable(company.stock), true);
  }
});
