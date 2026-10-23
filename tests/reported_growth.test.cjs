const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { calculate, growth, storedGrowth } = require('../profile_overview.js');
const { convertStatements } = require('../usd_currency.js');
const { reportedGrowth, fields } = require('../scripts/reported_growth.cjs');
const market = require('../full_market_dcf.json');
const rates = require('../cache/fx/usd_rates.json');
const source = ticker => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'financials', `${ticker}_statements_v2.json`)));

test('MU and LRCX growth uses prior-year fiscal TTM, not a duplicate current annual column', () => {
  for (const [ticker, expected] of [['MU', 256.3272513243084], ['LRCX', 26.020858240997]]) {
    const data = source(ticker);
    const value = growth(data, 'income', 'revenue');
    assert.ok(Math.abs(value.value - expected) < 1e-12);
    assert.notEqual(value.date, value.previousDate);
    assert.equal(market[ticker].statements_raw.annual_dates.at(-1), market[ticker].statements_raw.annual_dates.at(-2));
    assert.equal(value.value, market[ticker].reported_growth.fields.revenue.value);
  }
});

test('All eight stored growth metrics agree with independently summed, USD-normalized source quarters for every stock', () => {
  const { normalizeBankStatements } = require('../financial_industry.js');
  let unavailable = 0;
  for (const [ticker, stock] of Object.entries(market)) {
    const data = normalizeBankStatements(convertStatements(source(ticker), rates), stock.industry, ticker);
    assert.deepEqual(stock.reported_growth, reportedGrowth(data, rates, { industry: stock.industry, ticker }), ticker);
    const income = data.quarterly.income.slice().sort((a, b) => a.date.localeCompare(b.date)).slice(-8);
    for (const [field, statement] of Object.entries(fields)) {
      const rows = income.map(anchor => data.quarterly[statement].find(row => row.date === anchor.date));
      const valid = rows.length === 8 && rows.every(row => row && !row.currencyConversion.reason && Number.isFinite(row[field]));
      const previous = valid ? rows.slice(0, 4).reduce((sum, row) => sum + row[field], 0) : null;
      const expected = valid && previous > 0
        ? (rows.slice(4).reduce((sum, row) => sum + row[field], 0) / previous - 1) * 100 : null;
      const record = storedGrowth(stock, field);
      assert.ok(record, `${ticker}/${field} metadata is current`);
      assert.equal(record.value, expected, `${ticker}/${field}`);
      if (expected === null) { unavailable++; assert.ok(record.reason); }
      else assert.equal(record.reason, null);
    }
    const summary = calculate(data);
    assert.equal(summary.revenueGrowth, stock.reported_growth.fields.revenue.value);
    assert.equal(summary.operatingGrowth, stock.reported_growth.fields.operatingIncome.value);
    assert.equal(summary.netIncomeGrowth, stock.reported_growth.fields.netIncome.value);
  }
  console.log(`Growth health: ${Object.keys(market).length * Object.keys(fields).length} stock/metric combinations; ${unavailable} explicitly unavailable, not fake zeros`);
});

test('US bank TTM revenue growth uses operating revenue, not raw FMP gross-interest revenue', () => {
  const { normalizeBankStatements } = require('../financial_industry.js');
  for (const ticker of ['JPM', 'GS', 'BAC']) {
    const stock = market[ticker];
    assert.ok(stock, ticker);
    const raw = convertStatements(source(ticker), rates);
    const normalized = normalizeBankStatements(structuredClone(raw), stock.industry, ticker);
    const rawGrowth = growth(raw, 'income', 'revenue').value;
    const operatingGrowth = growth(normalized, 'income', 'revenue').value;
    const stored = stock.reported_growth.fields.revenue.value;
    assert.equal(stored, reportedGrowth(source(ticker), rates, { industry: stock.industry, ticker }).fields.revenue.value, ticker);
    assert.ok(Math.abs(stored - operatingGrowth) < 1e-9, `${ticker}: stored TTM growth must match normalized operating revenue`);
    assert.ok(Math.abs(rawGrowth - operatingGrowth) > 0.01, `${ticker}: fixture must differ raw vs operating so the regression is meaningful`);
  }
});

test('Growth retains genuine unchanged, zero and negative current results, but rejects nonpositive prior bases', () => {
  const data = source('LRCX');
  const rows = data.quarterly.income;
  rows.slice(0, 4).forEach(row => { row.revenue = 10; });
  rows.slice(4, 8).forEach(row => { row.revenue = 10; });
  assert.equal(growth(data, 'income', 'revenue').value, 0);
  rows.slice(0, 4).forEach(row => { row.revenue = 0; });
  assert.equal(growth(data, 'income', 'revenue').value, -100);
  rows.slice(0, 4).forEach(row => { row.revenue = -10; });
  assert.equal(growth(data, 'income', 'revenue').value, -200);
  for (const value of [0, -10]) {
    rows.slice(4, 8).forEach(row => { row.revenue = value; });
    assert.equal(growth(data, 'income', 'revenue').reason, 'nonPositivePrior');
  }
});

test('Gaps, duplicate periods, missing fields, mismatched dates and unavailable FX are explicit, not 0%', () => {
  const changes = [
    [data => data.quarterly.income.splice(2, 1), 'missingPeriod'],
    [data => data.quarterly.income.push({ ...data.quarterly.income[2] }), 'ambiguousPeriod'],
    [data => { data.quarterly.income[0].revenue = null; }, 'missingField'],
    [data => { data.quarterly.income[0].reportedCurrency = 'TWD'; }, 'currencyMismatch'],
    [data => { data.quarterly.income[0].currencyConversion = { reason: 'missingFxDate' }; }, 'missingFx']
  ];
  for (const [change, reason] of changes) {
    const data = source('LRCX');
    change(data);
    const record = growth(data, 'income', 'revenue');
    assert.equal(record.value, null);
    assert.equal(record.reason, reason);
  }
  const data = source('LRCX');
  data.quarterly.cashflow[0].date = '2026-06-27';
  assert.equal(growth(data, 'cashflow', 'freeCashFlow').reason, 'dateMismatch');
});

test('Stale or unconverted stored growth is not used as a fallback', () => {
  const stock = structuredClone(market.MU);
  stock.reported_growth.currency = 'TWD';
  assert.equal(storedGrowth(stock, 'revenue'), null);
  stock.reported_growth.currency = 'USD';
  stock.statements_raw.annual_dates[stock.statements_raw.annual_dates.length - 1] = '2027-03';
  assert.equal(storedGrowth(stock, 'revenue'), null);
  delete stock.reported_growth;
  assert.equal(storedGrowth(stock, 'revenue'), null);
});
