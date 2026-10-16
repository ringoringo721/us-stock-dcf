const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { calculate } = require('../fcf_ratios.js');

function fixture() {
  const data = {};
  for (const period of ['annual', 'quarterly']) {
    const rows = { income: [], balance: [], cashflow: [] };
    const dates = period === 'annual'
      ? ['2023-12-31', '2024-12-31', '2025-12-31']
      : ['2023-12-31', '2024-03-31', '2024-06-30', '2024-09-30', '2024-12-31',
        '2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'];
    dates.forEach((date, i) => {
      const base = { date, fiscalYear: date.slice(0, 4), reportedCurrency: 'USD',
        period: period === 'annual' ? 'FY' : `Q${Math.ceil(Number(date.slice(5, 7)) / 3)}` };
      rows.income.push({ ...base, revenue: 100 + i * 10, ebitda: 20 + i * 2 });
      rows.balance.push({ ...base, totalStockholdersEquity: 100 + i * 10, totalAssets: 200 + i * 20 });
      rows.cashflow.push({ ...base, freeCashFlow: i * 10 });
    });
    data[period] = rows;
  }
  return data;
}

function last(data, options) {
  return calculate(data, options).at(-1).ratios;
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

test('defaults to quarterly TTM and beginning balances; all four ratios use matching flows', () => {
  const ratios = last(fixture());
  near(ratios.equity.value, 260 / 140 * 100);
  near(ratios.assets.value, 260 / 280 * 100);
  near(ratios.sales.value, 260 / 660 * 100);
  near(ratios.ebitda.value, 260 / 132 * 100);
});

test('single, TTM and annual support all three balance bases without changing flow ratios', () => {
  for (const period of ['quarterly', 'annual']) {
    for (const flow of ['single', 'ttm']) {
      const data = fixture();
      const annual = period === 'annual';
      const fcf = annual ? 20 : flow === 'single' ? 80 : 260;
      const beginning = annual ? 110 : flow === 'single' ? 170 : 140;
      const ending = annual ? 120 : 180;
      const flowReference = last(data, { period, flow, balance: 'beginning' });
      for (const [balance, denominator] of [['beginning', beginning], ['ending', ending], ['average', (beginning + ending) / 2]]) {
        const ratios = last(data, { period, flow, balance });
        near(ratios.equity.value, fcf / denominator * 100);
        near(ratios.assets.value, fcf / (denominator * 2) * 100);
        assert.equal(ratios.sales.value, flowReference.sales.value);
        assert.equal(ratios.ebitda.value, flowReference.ebitda.value);
      }
    }
  }
});

test('earliest TTM and missing opening balances stay N/A; ending balances remain usable', () => {
  const columns = calculate(fixture());
  for (const column of columns.slice(0, 3)) {
    for (const ratio of Object.values(column.ratios)) {
      assert.equal(ratio.value, null);
      assert.equal(ratio.reason, 'incompleteTtm');
    }
  }
  assert.equal(columns[3].ratios.equity.reason, 'missingOpening');
  assert.notEqual(columns[3].ratios.sales.value, null);
  const first = calculate(fixture(), { flow: 'single', balance: 'ending' })[0];
  assert.equal(first.ratios.equity.value, 0);
  assert.equal(calculate(fixture(), { period: 'annual' })[0].ratios.equity.reason, 'missingOpening');
});

test('aligns independently ordered statements by fiscal period and full date', () => {
  const data = fixture();
  const expected = calculate(data);
  data.quarterly.income.reverse();
  data.quarterly.cashflow.reverse();
  data.quarterly.balance.unshift({ ...data.quarterly.balance.at(-1), fiscalYear: '2026', period: 'Q1', date: '2026-03-31', totalAssets: 999999 });
  assert.deepEqual(calculate(data), expected);
  data.quarterly.income[0].date = '2025-12-30';
  assert.equal(last(data).sales.reason, 'dateMismatch');
  assert.notEqual(last(data).equity.value, null);
});

test('rejects missing quarters, fiscal gaps and irregular date gaps across years', () => {
  const data = fixture();
  data.quarterly.cashflow.splice(6, 1);
  assert.equal(last(data).equity.reason, 'incompleteTtm');
  const irregular = fixture();
  irregular.quarterly.cashflow[6].date = '2025-04-01';
  assert.equal(last(irregular).equity.reason, 'nonConsecutive');
  const valid = calculate(fixture());
  assert.equal(valid[5].label, 'FY 2025 Q1');
  near(valid[5].ratios.equity.value, (20 + 30 + 40 + 50) / 110 * 100);
});

test('zero denominators, missing fields and zero average are explicit N/A', () => {
  const data = fixture();
  data.quarterly.income.at(-1).ebitda = 0;
  assert.equal(last(data, { flow: 'single' }).ebitda.reason, 'zeroDenominator');
  delete data.quarterly.income.at(-1).revenue;
  assert.equal(last(data, { flow: 'single' }).sales.reason, 'missingDenominator');
  data.quarterly.balance.at(-2).totalStockholdersEquity = -180;
  assert.equal(last(data, { flow: 'single', balance: 'average' }).equity.reason, 'zeroDenominator');
  data.quarterly.cashflow.at(-1).freeCashFlow = null;
  assert.equal(last(data, { flow: 'single' }).assets.reason, 'missingFcf');
});

test('retains negative arithmetic and warns about negative FCF, equity and EBITDA', () => {
  const data = fixture();
  data.quarterly.cashflow.at(-1).freeCashFlow = -80;
  data.quarterly.balance.at(-1).totalStockholdersEquity = -160;
  data.quarterly.income.at(-1).ebitda = -40;
  const ratios = last(data, { flow: 'single', balance: 'ending' });
  assert.equal(ratios.equity.value, 50);
  assert.equal(ratios.ebitda.value, 200);
  assert.ok(ratios.equity.warnings.includes('negativeFcf'));
  assert.ok(ratios.equity.warnings.includes('negativeEquity'));
  assert.ok(ratios.ebitda.warnings.includes('negativeEbitda'));
  assert.ok(ratios.assets.value < 0);
});

test('rejects mixed currencies, ambiguous duplicates, invalid dates and invalid options', () => {
  const data = fixture();
  data.quarterly.income.at(-1).reportedCurrency = 'TWD';
  assert.equal(last(data).sales.reason, 'currencyMismatch');
  data.quarterly.cashflow.push({ ...data.quarterly.cashflow.at(-1) });
  assert.equal(last(data).equity.reason, 'incompleteTtm');
  const invalid = fixture();
  invalid.quarterly.cashflow.at(-1).date = '2025-02-30';
  assert.equal(last(invalid).equity.reason, 'incompleteTtm');
  assert.throws(() => calculate(data, { balance: 'current' }), RangeError);
  assert.throws(() => calculate({}), TypeError);
  for (const value of [undefined, '', false, Infinity, NaN]) {
    const missing = fixture();
    missing.quarterly.cashflow.at(-1).freeCashFlow = value;
    assert.equal(last(missing).equity.reason, 'missingFcf');
  }
});

test('quarter fiscal labels do not assume calendar-year fiscal ends', () => {
  const data = fixture();
  for (const group of Object.values(data.quarterly)) {
    group.forEach(row => { row.fiscalYear = String(Number(row.fiscalYear) + 1); });
  }
  assert.equal(calculate(data).at(-1).label, 'FY 2026 Q4');
});

test('all checked-in statements calculate without nonfinite ratios in every supported mode', () => {
  const directory = path.join(__dirname, '..', 'cache', 'financials');
  const files = fs.readdirSync(directory).filter(file => file.endsWith('_statements_v2.json'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    for (const period of ['quarterly', 'annual']) {
      for (const flow of ['single', 'ttm']) {
        for (const balance of ['beginning', 'ending', 'average']) {
          for (const column of calculate(data, { period, flow, balance })) {
            for (const ratio of Object.values(column.ratios)) {
              assert.ok(ratio.value === null ? Boolean(ratio.reason) : Number.isFinite(ratio.value), file);
            }
          }
        }
      }
    }
  }
});

test('DE, HD, PFE and PGR use exact source dates rather than shifted array positions', () => {
  for (const ticker of ['DE', 'HD', 'PFE', 'PGR']) {
    const data = JSON.parse(fs.readFileSync(path.join(
      __dirname, '..', 'cache', 'financials', `${ticker}_statements_v2.json`), 'utf8'));
    const columns = calculate(data, { flow: 'single', balance: 'ending' });
    for (const column of columns) {
      const cf = data.quarterly.cashflow.find(row => row.date === column.date);
      if (!cf) continue;
      const samePeriod = row => row.date === cf.date
        && row.fiscalYear === cf.fiscalYear && row.period === cf.period;
      const balance = data.quarterly.balance.find(samePeriod);
      const income = data.quarterly.income.find(samePeriod);
      if (balance && balance.totalStockholdersEquity !== 0) {
        near(column.ratios.equity.value, cf.freeCashFlow / balance.totalStockholdersEquity * 100);
      }
      if (income && income.revenue !== 0) {
        near(column.ratios.sales.value, cf.freeCashFlow / income.revenue * 100);
      }
    }
  }
});

test('the exact shipped HTML scripts compile and the removed chart cannot initialize', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).filter(script => script.trim());
  assert.ok(scripts.length > 0);
  scripts.forEach(script => assert.doesNotThrow(() => new vm.Script(script)));
  assert.doesNotMatch(html, /renderDetailHistoricalChart|detailDcfHistoricalChart|chartjs-adapter-date-fns/);
  assert.match(html, /id="fcf-ratio-panel"/);
  assert.match(html, /src="fcf_ratios.js"/);
  assert.equal((html.match(/id="fcf-ratio-panel"/g) || []).length, 1);
  const detail = html.slice(html.indexOf('id="detail-view"'), html.indexOf('id="company-view"'));
  assert.doesNotMatch(detail, /id="fcf-ratio-panel"/);
  const trends = html.slice(html.indexOf('id="subpage-charts"'), html.indexOf('id="subpage-dividend"'));
  assert.match(trends, /id="fcf-ratio-panel"/);
});
