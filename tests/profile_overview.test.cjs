const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { calculate } = require('../profile_overview.js');

function statements() {
  return { quarterly: { income: [1, 2, 3, 4].map((quarter, i) => ({
    fiscalYear: '2025', period: `Q${quarter}`,
    date: ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'][i],
    reportedCurrency: 'USD', revenue: 100 + i * 10, grossProfit: 40 + i * 5,
    operatingIncome: 20 + i, netIncome: 10 + i
  })) } };
}

test('Profile margins use four actual quarters, not an average of percentages', () => {
  const result = calculate(statements());
  assert.equal(result.date, '2025-12-31');
  assert.equal(result.currency, 'USD');
  assert.equal(result.revenue, 460);
  assert.equal(result.grossMargin, 190 / 460 * 100);
  assert.equal(result.operatingMargin, 86 / 460 * 100);
  assert.equal(result.netMargin, 46 / 460 * 100);
});

test('Profile leaves gaps, duplicate periods, currency changes and invalid dates unavailable', () => {
  const changes = [
    data => data.quarterly.income.splice(1, 1),
    data => data.quarterly.income.push({ ...data.quarterly.income[1] }),
    data => { data.quarterly.income[0].reportedCurrency = 'TWD'; },
    data => { data.quarterly.income[1].date = '2025-02-30'; },
    data => { data.quarterly.income[0].date = '2024-03-31'; },
    data => { data.quarterly.income[2].reportedCurrency = ''; }
  ];
  for (const change of changes) {
    const data = statements();
    change(data);
    assert.equal(calculate(data).grossMargin, null);
  }
  assert.equal(calculate({ quarterly: { income: [] } }).netMargin, null);
  assert.throws(() => calculate({}), /Missing quarterly/);
});

test('Profile preserves negative/zero margins and does not coerce missing fields to zero', () => {
  const data = statements();
  data.quarterly.income.forEach(row => { row.netIncome = -5; row.operatingIncome = 0; });
  assert.equal(calculate(data).netMargin, -20 / 460 * 100);
  assert.equal(calculate(data).operatingMargin, 0);
  data.quarterly.income[0].grossProfit = null;
  assert.equal(calculate(data).grossMargin, null);
  data.quarterly.income.forEach(row => { row.revenue = 0; });
  assert.equal(calculate(data).netMargin, null);
});

test('Reported growth compares two real TTM windows and requires a positive prior base', () => {
  const data = statements();
  const previous = data.quarterly.income.map(row => ({
    ...row, fiscalYear: '2024', date: row.date.replace('2025', '2024'),
    revenue: row.revenue / 2, operatingIncome: row.operatingIncome / 2, netIncome: row.netIncome / 2
  }));
  data.quarterly.income.push(...previous);
  assert.equal(calculate(data).revenueGrowth, 100);
  assert.equal(calculate(data).operatingGrowth, 100);
  assert.equal(calculate(data).netIncomeGrowth, 100);
  previous.forEach(row => { row.netIncome = -1; });
  assert.equal(calculate(data).netIncomeGrowth, null);
  previous.forEach(row => { row.netIncome = 0; });
  assert.equal(calculate(data).netIncomeGrowth, null);
  previous[0].reportedCurrency = 'TWD';
  assert.equal(calculate(data).revenueGrowth, null);
  assert.equal(calculate(data).grossMargin, 190 / 460 * 100, 'Unavailable growth does not hide valid margins');
  data.quarterly.income.pop();
  assert.equal(calculate(data).operatingGrowth, null);
});

test('Profile snapshot agrees with every available cached four-quarter income statement', () => {
  const market = require('../full_market_dcf.json');
  for (const ticker of Object.keys(market)) {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'financials', `${ticker}_statements_v2.json`)));
    const summary = calculate(data);
    const quarters = data.quarterly.income.slice().sort((a, b) => a.date.localeCompare(b.date)).slice(-4);
    assert.equal(summary.date, quarters.at(-1).date, ticker);
    const revenue = quarters.reduce((sum, row) => sum + row.revenue, 0);
    for (const [metric, field] of [['grossMargin', 'grossProfit'], ['operatingMargin', 'operatingIncome'], ['netMargin', 'netIncome']]) {
      const expected = quarters.every(row => row[field] !== null && Number.isFinite(row[field])) && revenue !== 0
        ? quarters.reduce((sum, row) => sum + row[field], 0) / revenue * 100 : null;
      assert.equal(summary[metric], expected, `${ticker} ${metric}`);
    }
    const prior = data.quarterly.income.slice().sort((a, b) => a.date.localeCompare(b.date)).slice(-8, -4);
    for (const [metric, field] of [['revenueGrowth', 'revenue'], ['operatingGrowth', 'operatingIncome'], ['netIncomeGrowth', 'netIncome']]) {
      const previous = prior.reduce((sum, row) => sum + row[field], 0);
      const expected = prior.length === 4 && previous > 0 && [...prior, ...quarters].every(row => Number.isFinite(row[field]))
        ? (quarters.reduce((sum, row) => sum + row[field], 0) / previous - 1) * 100 : null;
      assert.equal(summary[metric], expected, `${ticker} ${metric}`);
    }
  }
});
