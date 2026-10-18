const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { calculate, fcfToEquity, storedTtmFcfToEquity, calculateReturns, calculateBalances, calculateEarnings, financialReference, trend } = require('../fcf_ratios.js');

test('FCF / closing parent equity preserves zero and negative values without filling missing inputs', () => {
  assert.equal(fcfToEquity(120, 600), 20);
  assert.equal(fcfToEquity(0, 600), 0);
  assert.equal(fcfToEquity(-120, 600), -20);
  assert.equal(fcfToEquity(120, -600), -20);
  for (const missing of [null, undefined, NaN, Infinity, '120']) {
    assert.equal(fcfToEquity(missing, 600), null);
    assert.equal(fcfToEquity(120, missing), null);
  }
  assert.equal(fcfToEquity(120, 0), null);
  assert.equal(fcfToEquity(Number.MAX_VALUE, Number.MIN_VALUE), null);
});

test('stored TTM FCF / parent equity uses the closing slot, not annual FCF or total equity including NCI', () => {
  const statements = {
    cashflow: { freeCashFlow: [10, 60] },
    balance: { totalStockholdersEquity: [100, 200], totalEquity: [400, 600] }
  };
  assert.equal(storedTtmFcfToEquity(statements), 30);
  assert.equal(storedTtmFcfToEquity(statements, 'dateMismatch'), null);
  assert.equal(storedTtmFcfToEquity(statements, 'missingFinancialData'), 30,
    'Unrelated missing valuation inputs must not hide supported FCF/equity');
  const missing = structuredClone(statements);
  missing.cashflow.freeCashFlow[1] = null;
  assert.equal(storedTtmFcfToEquity(missing), null, 'Annual FCF must not fill missing TTM');
  assert.equal(storedTtmFcfToEquity({ ...statements, fxUnavailable: [false, true] }), null);
  assert.equal(storedTtmFcfToEquity({ ...statements, cashflow: { freeCashFlow: [10] } }), null);
  assert.equal(storedTtmFcfToEquity({ ...statements, balance: { totalEquity: [400, 600] } }), null);
  assert.equal(storedTtmFcfToEquity(undefined), null);
});

test('Per-diluted-share trends preserve reported EPS, historical shares, fiscal periods and missing data', () => {
  const data = fixture();
  for (const period of ['annual', 'quarterly']) {
    data[period].income.forEach((row, i) => { row.epsDiluted = i - 2; });
    data[period].cashflow.forEach((row, i) => { row.commonDividendsPaid = -i * 3; });
  }
  const single = calculateEarnings(data, { flow: 'single' });
  assert.equal(single.at(-1).amounts.eps.value, 6);
  assert.equal(single.at(-1).amounts.dividend.value, 2.4);
  assert.equal(single.at(-1).amounts.fcf.value, 8);
  const ttm = calculateEarnings(data);
  assert.equal(ttm[0].amounts.eps.reason, 'incompleteTtm');
  assert.equal(ttm.at(-1).amounts.eps.value, 18);
  assert.equal(ttm.at(-1).amounts.fcf.value, 26);
  assert.equal(ttm.at(-1).amounts.dividend.value, 7.8);
  assert.equal(calculateEarnings(data, { period: 'annual' }).at(-1).amounts.eps.value, 0);
  data.quarterly.cashflow.at(-1).date = '2025-12-30';
  assert.equal(calculateEarnings(data).at(-1).amounts.fcf.reason, 'dateMismatch');
  data.quarterly.cashflow.at(-1).date = '2025-12-31';
  delete data.quarterly.cashflow.at(-1).commonDividendsPaid;
  assert.equal(calculateEarnings(data).at(-1).amounts.dividend.reason, 'missingField');
  data.quarterly.income.at(-2).reportedCurrency = 'EUR';
  assert.equal(calculateEarnings(data).at(-1).amounts.eps.reason, 'currencyMismatch');
  data.quarterly.income.splice(-2, 1);
  assert.equal(calculateEarnings(data).at(-1).amounts.eps.reason, 'incompleteTtm');
  assert.throws(() => calculateEarnings(data, { flow: 'invalid' }), RangeError);
});

test('Earnings trends reject duplicates and irregular quarters, but retain zero and negative values', () => {
  const data = fixture();
  data.quarterly.income.forEach(row => { row.epsDiluted = 0; });
  data.quarterly.cashflow.forEach(row => { row.commonDividendsPaid = 0; });
  assert.equal(calculateEarnings(data).at(-1).amounts.dividend.value, 0);
  assert.equal(calculateEarnings(data).at(-1).amounts.eps.value, 0);
  data.quarterly.income.at(-1).epsDiluted = -2;
  assert.equal(calculateEarnings(data).at(-1).amounts.eps.value, -2);
  data.quarterly.income.at(-2).date = '2025-07-01';
  assert.equal(calculateEarnings(data).at(-1).amounts.eps.reason, 'nonConsecutive');
  data.quarterly.income.at(-2).date = '2025-09-30';
  data.quarterly.income.push({ ...data.quarterly.income.at(-1) });
  assert.equal(calculateEarnings(data).at(-1).amounts.eps.reason, 'incompleteTtm');
});

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
      rows.income.push({ ...base, revenue: 100 + i * 10, ebitda: 20 + i * 2, netIncome: 10 + i, weightedAverageShsOutDil: 10 });
      rows.balance.push({ ...base, totalStockholdersEquity: 100 + i * 10, totalAssets: 200 + i * 20,
        goodwill: 10 + i, intangibleAssets: 5 + i, goodwillAndIntangibleAssets: 15 + i * 2 });
      rows.cashflow.push({ ...base, freeCashFlow: i * 10 });
    });
    data[period] = rows;
  }
  return data;
}

test('Per-diluted-share cash flows use period-matched shares, not ending/current shares or sums of shares', () => {
  const data = fixture();
  data.quarterly.income.forEach((row, i) => { row.weightedAverageShsOutDil = (i + 1) * 10; row.epsDiluted = i; });
  data.quarterly.cashflow.forEach(row => { row.commonDividendsPaid = -30; });
  data.annual.cashflow.forEach(row => { row.commonDividendsPaid = -100; });
  near(calculateEarnings(data).at(-1).amounts.fcf.value, 260 / 75);
  near(calculateEarnings(data).at(-1).amounts.dividend.value, 120 / 75);
  near(calculateEarnings(data)[5].amounts.fcf.value, 140 / 45, 'TTM crosses a fiscal-year boundary');
  near(calculateEarnings(data, { flow: 'single' }).at(-1).amounts.fcf.value, 80 / 90);
  near(calculateEarnings(data, { period: 'annual' }).at(-1).amounts.dividend.value, 10);
  data.quarterly.cashflow.at(-1).freeCashFlow = -80;
  assert.ok(calculateEarnings(data, { flow: 'single' }).at(-1).amounts.fcf.value < 0);
  data.quarterly.cashflow.at(-1).commonDividendsPaid = 30;
  assert.ok(calculateEarnings(data, { flow: 'single' }).at(-1).amounts.dividend.value < 0,
    'Dividend reversals retain their direction instead of applying absolute value');
  for (const shares of [null, undefined, '', 0, -10]) {
    data.quarterly.income.at(-1).weightedAverageShsOutDil = shares;
    const result = calculateEarnings(data).at(-1);
    assert.equal(result.amounts.fcf.reason, shares === 0 || shares === -10 ? 'invalidDilutedShares' : 'missingDilutedShares');
    assert.equal(result.amounts.dividend.value, null);
    assert.equal(result.amounts.eps.value, 26, 'Reported EPS does not require a reconstructed denominator');
  }
});

test('All cached per-share trends match exact reported shares, EPS and common dividends in every mode', () => {
  const directory = path.join(__dirname, '..', 'cache', 'financials');
  for (const file of fs.readdirSync(directory).filter(file => file.endsWith('_statements_v2.json'))) {
    const data = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    for (const [period, flow] of [['quarterly', 'single'], ['quarterly', 'ttm'], ['annual', 'ttm']]) {
      const columns = calculateEarnings(data, { period, flow });
      for (const column of columns) {
        for (const result of Object.values(column.amounts)) {
          assert.ok(result.value === null ? result.reason : Number.isFinite(result.value), file);
        }
        if (!column.date) continue;
        const rows = data[period].income.filter(row => row.date <= column.date).sort((a, b) => a.date.localeCompare(b.date));
        const count = data.statementFrequencies?.income === 'semiannual' || data.reportingFrequency === 'semiannual' ? 2 : 4;
        const window = rows.slice(period === 'quarterly' && flow === 'ttm' ? -count : -1);
        if (column.amounts.eps.value !== null) {
          const annual = data.annual.income.find(row => row.date === column.date);
          near(column.amounts.eps.value, column.amounts.eps.basis === 'reportedAnnualAtFiscalYearEnd'
            ? annual.epsDiluted : window.reduce((sum, row) => sum + Number(row.epsDiluted), 0));
        }
        for (const [metric, field, sign] of [['fcf', 'freeCashFlow', 1], ['dividend', 'commonDividendsPaid', -1]]) {
          if (column.amounts[metric].value === null) continue;
          const mixedCadence = period === 'quarterly' && flow === 'ttm'
            && data.statementFrequencies?.cashflow === 'semiannual' && count === 4;
          const flows = mixedCadence
            ? data[period].cashflow.filter(row => row.date <= column.date)
              .sort((a, b) => a.date.localeCompare(b.date)).slice(-2)
            : window.map(row => data[period].cashflow.find(flow => flow.date === row.date));
          assert.ok(flows.every(Boolean), `${file}: missing source flow`);
          if (mixedCadence) assert.equal(flows.at(-1).date, column.date);
          const shares = window.reduce((sum, row) => sum + Number(row.weightedAverageShsOutDil), 0) / window.length;
          near(column.amounts[metric].value, sign * flows.reduce((sum, row) => sum + Number(row[field]), 0) / shares);
        }
      }
    }
  }
});

test('Financial health bands cover every score and do not infer missing or inconsistent details', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const source = html.slice(html.indexOf('  function financialHealthAssessment('), html.indexOf('  function loadFScoreView('));
  const assess = vm.runInNewContext(`${source}; financialHealthAssessment`);
  const details = score => Array.from({ length: 9 }, (_, i) => ({ id: i + 1, passed: i < score ? 1 : 0 }));
  for (let score = 0; score <= 9; score++) {
    const result = assess(score, details(score));
    assert.equal(result.level, score >= 7 ? 'strong' : score >= 4 ? 'moderate' : 'weak');
    assert.equal(result.validBreakdown, true);
    assert.equal(result.passed.length, score);
    assert.equal(result.failed.length, 9 - score);
  }
  for (const score of [null, undefined, '', '8', -1, 10, 4.5, NaN, Infinity]) {
    const result = assess(score, details(8));
    assert.equal(result.level, 'unavailable');
    assert.equal(result.validBreakdown, false);
    assert.equal(result.passed.length + result.failed.length, 0);
  }
  for (const rows of [null, {}, [], details(7), details(8).slice(1),
    [...details(8).slice(1), { id: 2, passed: 1 }],
    details(8).map(row => ({ ...row, passed: String(row.passed) }))]) {
    const result = assess(8, rows);
    assert.equal(result.level, 'strong');
    assert.equal(result.validBreakdown, false);
    assert.equal(result.passed.length + result.failed.length, 0);
  }
});

function last(data, options) {
  return calculate(data, options).at(-1).ratios;
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

test('defaults to quarterly TTM and beginning balances; all five ratios use matching flows', () => {
  const ratios = last(fixture());
  near(ratios.equity.value, 260 / 140 * 100);
  near(ratios.assets.value, 260 / 280 * 100);
  near(ratios.sales.value, 260 / 660 * 100);
  near(ratios.ebitda.value, 260 / 132 * 100);
  near(ratios.netIncome.value, 260 / 66 * 100);
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
        near(ratios.netIncome.value, fcf / (annual ? 12 : flow === 'single' ? 18 : 66) * 100);
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
  assert.equal(last(data).netIncome.reason, 'dateMismatch');
  assert.notEqual(last(data).equity.value, null);
});

test('net income handles losses, zero, missing fields and period totals without changing other ratios', () => {
  const data = fixture();
  const original = last(data, { flow: 'single' });
  data.quarterly.income.at(-1).netIncome = -40;
  const loss = last(data, { flow: 'single' });
  assert.equal(loss.netIncome.value, -200);
  assert.deepEqual(loss.netIncome.warnings, ['negativeNetIncome']);
  for (const metric of ['equity', 'assets', 'sales', 'ebitda']) {
    assert.deepEqual(loss[metric], original[metric]);
  }
  data.quarterly.cashflow.at(-1).freeCashFlow = -80;
  assert.equal(last(data, { flow: 'single' }).netIncome.value, 200);
  assert.deepEqual(last(data, { flow: 'single' }).netIncome.warnings, ['negativeFcf', 'negativeNetIncome']);
  data.quarterly.income.at(-1).netIncome = -48;
  assert.equal(last(data).netIncome.reason, 'zeroDenominator');
  data.quarterly.income.at(-1).netIncome = 0;
  assert.equal(last(data, { flow: 'single' }).netIncome.reason, 'zeroDenominator');
  for (const value of [undefined, null, '', false, Infinity, NaN]) {
    data.quarterly.income.at(-1).netIncome = value;
    assert.equal(last(data).netIncome.reason, 'missingDenominator');
  }
  data.annual.income.at(-1).netIncome = -10;
  assert.equal(last(data, { period: 'annual' }).netIncome.value, -200);
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

test('trend lines retain actual chronology, negative/zero values and gaps without fabrication', () => {
  assert.equal(trend([null, null]), null);
  const chart = trend([0, null, -10, 10]);
  assert.equal(chart.segments.length, 2);
  assert.equal(chart.segments[0].length, 1);
  assert.equal(chart.segments[1].length, 2);
  near(chart.segments[0][0].x, 4);
  near(chart.segments[1][0].x, 4 + 200 / 3);
  assert.equal(chart.color, '#22c55e');
  assert.equal(trend([2, 1]).color, '#ef4444');
  assert.equal(trend([0, 0]).last.y, 16);
  assert.equal(trend([null, 0]).last.x, 104);
  assert.equal(trend([false, '', NaN, Infinity]), null);
});

test('ROA, ROE and ROTE use reported net income and the correct balances in every mode', () => {
  const data = fixture();
  for (const period of ['quarterly', 'annual']) {
    for (const flow of ['single', 'ttm']) {
      const source = data[period];
      const size = period === 'quarterly' && flow === 'ttm' ? 4 : 1;
      const numerator = source.income.slice(-size).reduce((sum, row) => sum + row.netIncome, 0);
      const opening = source.balance.at(-1 - size);
      const ending = source.balance.at(-1);
      for (const balance of ['beginning', 'ending', 'average']) {
        const result = calculateReturns(data, { period, flow, balance }).at(-1).ratios;
        assert.deepEqual(Object.keys(result), ['roa', 'roe', 'rote']);
        const rows = balance === 'beginning' ? [opening] : balance === 'ending' ? [ending] : [opening, ending];
        for (const metric of ['roa', 'roe', 'rote']) {
          const denominator = rows.reduce((sum, row) => sum + (metric === 'roa' ? row.totalAssets
            : metric === 'roe' ? row.totalStockholdersEquity
              : row.totalStockholdersEquity - row.goodwillAndIntangibleAssets), 0) / rows.length;
          near(result[metric].value, numerator / denominator * 100);
        }
      }
    }
  }
  near(calculateReturns(data).at(-1).ratios.rote.value, 66 / 117 * 100);
  delete data.quarterly.cashflow;
  assert.notEqual(calculateReturns(data).at(-1).ratios.roa.value, null);
});

test('ROTE deducts goodwill and intangibles once, never assumes missing components are zero', () => {
  const data = fixture();
  const options = { flow: 'single', balance: 'ending' };
  const balance = data.quarterly.balance.at(-1);
  const expected = calculateReturns(data, options).at(-1).ratios.rote.value;
  balance.preferredStock = 20;
  assert.equal(calculateReturns(data, options).at(-1).ratios.rote.value, expected);
  delete balance.goodwillAndIntangibleAssets;
  assert.equal(calculateReturns(data, options).at(-1).ratios.rote.value, expected);
  delete balance.goodwill;
  const result = calculateReturns(data, options).at(-1).ratios;
  assert.equal(result.rote.reason, 'missingDenominator');
  assert.notEqual(result.roe.value, null);
  balance.goodwillAndIntangibleAssets = 0;
  near(calculateReturns(data, options).at(-1).ratios.rote.value, 18 / 180 * 100);
});

test('financial DCF reference is exactly the latest Trend TTM/beginning ROTE with actual closing TBV', () => {
  const data = fixture();
  const reference = financialReference(data, { shares: 2 });
  assert.equal(reference.rote, calculateReturns(data).at(-1).ratios.rote.value);
  assert.equal(reference.date, '2025-12-31');
  assert.equal(reference.tbvps, (180 - 31) / 2e6);
  assert.equal(reference.reason, null);
  assert.throws(() => financialReference(data, { shares: 2, fxRate: 0.5 }), /period-specific USD rates/);
  data.quarterly.balance.at(-1).goodwillAndIntangibleAssets = 190;
  const negative = financialReference(data, { shares: 2 });
  assert.equal(negative.tbvps, -10 / 2e6);
  assert.equal(negative.reason, 'nonPositiveTangibleEquity');
  assert.equal(negative.rote, reference.rote);
  assert.equal(financialReference(fixture(), { shares: 0 }).reason, 'invalidSharesOrCurrency');
});

test('the market generator CLI returns the same financial reference as the browser engine', () => {
  const { execFileSync } = require('node:child_process');
  const input = { statements: fixture(), shares: 2, fxRate: 1 };
  const output = execFileSync(process.execPath,
    [path.join(__dirname, '..', 'scripts', 'financial_reference.cjs'), '--stdin'],
    { input: JSON.stringify(input), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), financialReference(input.statements, input));
});

test('all stored financial DCFs use the shared historical return engine, not ROE or capital floors', () => {
  const market = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'full_market_dcf.json'), 'utf8'));
  for (const [ticker, stock] of Object.entries(market)) {
    if (!stock.fin_valuation.is_financial) continue;
    const statements = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'financials',
      `${ticker}_statements_v2.json`), 'utf8'));
    const converted = require('../usd_currency.js').convertStatements(statements, require('../cache/fx/usd_rates.json'));
    const reference = financialReference(converted, { shares: stock.shares });
    assert.deepEqual(stock.fin_valuation.reference, reference, ticker);
    assert.equal(stock.fin_valuation.rote, reference.rote, ticker);
    assert.equal(stock.fin_valuation.tbvps, reference.tbvps, ticker);
    if (reference.reason) assert.equal(stock.fair_val, null, ticker);
  }
});

test('returns preserve losses, negative equity and tangible equity with warnings and zero denominators as N/A', () => {
  const data = fixture();
  const options = { flow: 'single', balance: 'ending' };
  data.quarterly.income.at(-1).netIncome = -18;
  data.quarterly.balance.at(-1).totalStockholdersEquity = -180;
  const result = calculateReturns(data, options).at(-1).ratios;
  assert.equal(result.roe.value, 10);
  assert.ok(result.roe.warnings.includes('negativeNetIncome'));
  assert.ok(result.roe.warnings.includes('negativeEquity'));
  assert.ok(result.rote.warnings.includes('negativeTangibleEquity'));
  assert.ok(result.roa.value < 0);
  data.quarterly.balance.at(-1).totalStockholdersEquity = 31;
  assert.equal(calculateReturns(data, options).at(-1).ratios.rote.reason, 'zeroDenominator');
  data.quarterly.balance.at(-1).totalAssets = 0;
  assert.equal(calculateReturns(data, options).at(-1).ratios.roa.reason, 'zeroDenominator');
  data.quarterly.balance.at(-1).totalStockholdersEquity = 0;
  assert.equal(calculateReturns(data, options).at(-1).ratios.roe.reason, 'zeroDenominator');
  data.quarterly.balance.at(-2).totalStockholdersEquity = -31;
  data.quarterly.balance.at(-1).totalStockholdersEquity = 31;
  assert.equal(calculateReturns(data, { flow: 'single', balance: 'average' }).at(-1).ratios.roe.reason, 'zeroDenominator');
  const zero = fixture();
  zero.quarterly.income.at(-1).netIncome = 0;
  assert.equal(calculateReturns(zero, options).at(-1).ratios.rote.value, 0);
});

test('returns enforce complete TTM, fiscal/date alignment, currencies and missing-income rules', () => {
  const data = fixture();
  const initial = calculateReturns(data);
  assert.equal(initial[2].ratios.roa.reason, 'incompleteTtm');
  assert.equal(initial[3].ratios.roa.reason, 'missingOpening');
  near(initial[5].ratios.roa.value, (12 + 13 + 14 + 15) / 220 * 100);
  data.quarterly.balance.reverse();
  data.quarterly.income.reverse();
  assert.deepEqual(calculateReturns(data), initial);
  data.quarterly.balance[0].date = '2025-12-30';
  assert.equal(calculateReturns(data, { balance: 'ending' }).at(-1).ratios.roe.reason, 'dateMismatch');
  data.quarterly.income[0].reportedCurrency = 'TWD';
  assert.equal(calculateReturns(data).at(-1).ratios.roe.reason, 'currencyMismatch');
  const missing = fixture();
  delete missing.quarterly.income.at(-1).netIncome;
  assert.equal(calculateReturns(missing).at(-1).ratios.roe.reason, 'missingNetIncome');
  missing.quarterly.income.splice(6, 1);
  assert.equal(calculateReturns(missing).at(-1).ratios.roe.reason, 'incompleteTtm');
  const irregular = fixture();
  irregular.quarterly.income[6].date = '2025-04-01';
  assert.equal(calculateReturns(irregular).at(-1).ratios.roe.reason, 'nonConsecutive');
  const ambiguous = fixture();
  ambiguous.quarterly.income.push({ ...ambiguous.quarterly.income.at(-1) });
  assert.equal(calculateReturns(ambiguous).at(-1).ratios.roe.reason, 'incompleteTtm');
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
            for (const column of calculateReturns(data, { period, flow, balance })) {
              for (const ratio of Object.values(column.ratios)) {
                assert.ok(ratio.value === null ? Boolean(ratio.reason) : Number.isFinite(ratio.value), file);
              }
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
      if (income && typeof income.netIncome === 'number' && income.netIncome !== 0) {
        near(column.ratios.netIncome.value, cf.freeCashFlow / income.netIncome * 100);
      }
    }
    for (const column of calculateReturns(data, { flow: 'single', balance: 'ending' })) {
      const income = data.quarterly.income.find(row => row.date === column.date);
      if (!income) continue;
      const balance = data.quarterly.balance.find(row => row.date === income.date
        && row.fiscalYear === income.fiscalYear && row.period === income.period);
      if (!balance) {
        assert.equal(column.ratios.roa.value, null);
        continue;
      }
      if (typeof balance.totalAssets === 'number' && balance.totalAssets !== 0) {
        near(column.ratios.roa.value, income.netIncome / balance.totalAssets * 100);
      }
      if (typeof balance.totalStockholdersEquity === 'number' && balance.totalStockholdersEquity !== 0) {
        near(column.ratios.roe.value, income.netIncome / balance.totalStockholdersEquity * 100);
      }
      const tangible = balance.totalStockholdersEquity - balance.goodwillAndIntangibleAssets;
      if (typeof balance.goodwillAndIntangibleAssets === 'number' && tangible !== 0) {
        near(column.ratios.rote.value, income.netIncome / tangible * 100);
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
  assert.doesNotMatch(html, /renderChartsSubPage|chart-bars-wrap|cmp-analytics-chart-container/);
  assert.match(html, /id="fcf-ratio-panel"/);
  assert.match(html, /src="fcf_ratios\.js\?v=parent-equity-1"/);
  assert.equal((html.match(/id="fcf-ratio-panel"/g) || []).length, 1);
  const detail = html.slice(html.indexOf('id="detail-view"'), html.indexOf('id="company-view"'));
  assert.doesNotMatch(detail, /id="fcf-ratio-panel"/);
  const trends = html.slice(html.indexOf('id="subpage-charts"'), html.indexOf('id="subpage-dividend"'));
  assert.match(trends, /id="fcf-ratio-panel"/);
  assert.equal((html.match(/id="return-ratio-panel"/g) || []).length, 1);
  assert.doesNotMatch(detail, /id="return-ratio-panel"/);
  assert.ok(trends.indexOf('id="return-ratio-panel"') > trends.indexOf('id="fcf-ratio-panel"'));
  assert.doesNotMatch(trends, /return-ratio-roic/);
  assert.doesNotMatch(html, /renderAssetAnalysisChart|renderReturnChart|ratioAssetChart|ratioReturnChart|setReturnMetricMode/);
  assert.match(trends, /id="balance-panel"/);
  assert.ok(trends.indexOf('id="balance-panel"') > trends.indexOf('id="return-ratio-panel"'));
  assert.match(html, /src="balance_sheet.js"/);
});

test('balance analysis uses actual dated quarterly and annual closing balances without fabricated TTM', () => {
  const data = fixture();
  for (const period of ['quarterly', 'annual']) {
    data[period].balance.forEach((row, i) => {
      row.totalCurrentAssets = 40 + i;
      row.totalNonCurrentAssets = row.totalAssets - row.totalCurrentAssets;
      row.totalLiabilities = 90 + i;
      row.totalCurrentLiabilities = 20 + i;
      row.totalNonCurrentLiabilities = row.totalLiabilities - row.totalCurrentLiabilities;
      row.cashAndCashEquivalents = i;
    });
    const expected = structuredClone(data[period].balance);
    const columns = calculateBalances(data, { period });
    assert.equal(columns.length, expected.length);
    columns.forEach((column, i) => {
      assert.equal(column.date, expected[i].date);
      assert.equal(column.currency, 'USD');
      assert.equal(column.amounts.assets.value, expected[i].totalAssets);
      assert.equal(column.amounts.equity.value, expected[i].totalStockholdersEquity);
      assert.equal(column.amounts.cash.value, i);
      near(column.ratios.currentRatio.value, expected[i].totalCurrentAssets / expected[i].totalCurrentLiabilities);
      near(column.ratios.cashRatio.value, i / expected[i].totalCurrentLiabilities);
      near(column.ratios.liabilitiesRatio.value, expected[i].totalLiabilities / expected[i].totalAssets * 100);
      near(column.ratios.leverage.value, expected[i].totalAssets / expected[i].totalStockholdersEquity);
      near(column.amounts.tangibleEquity.value, expected[i].totalStockholdersEquity - expected[i].goodwillAndIntangibleAssets);
    });
    data[period].balance.reverse();
    assert.deepEqual(calculateBalances(data, { period }), columns);
    delete data[period].income;
    delete data[period].cashflow;
    assert.deepEqual(calculateBalances(data, { period }), columns, 'Balance-only data needs no synthetic income join');
  }
  assert.throws(() => calculateBalances(data, { period: 'ttm' }), RangeError);
  assert.throws(() => calculateBalances({}), TypeError);
});

test('balance analysis retains zero/negative values and explicitly rejects unavailable or ambiguous data', () => {
  const data = fixture();
  const row = data.quarterly.balance.at(-1);
  row.totalStockholdersEquity = -50;
  row.totalCurrentLiabilities = 0;
  row.totalCurrentAssets = 0;
  row.cashAndCashEquivalents = 0;
  let result = calculateBalances(data).at(-1);
  assert.equal(result.amounts.cash.value, 0);
  assert.equal(result.ratios.cashRatio.reason, 'zeroDenominator');
  assert.equal(result.ratios.currentRatio.reason, 'zeroDenominator');
  assert.equal(result.amounts.liabilities.reason, 'missingField');
  assert.ok(result.ratios.leverage.value < 0);
  assert.deepEqual(result.ratios.leverage.warnings, ['negativeEquity']);
  assert.ok(result.amounts.tangibleEquity.value < 0);
  row.totalStockholdersEquity = 0;
  assert.equal(calculateBalances(data).at(-1).ratios.leverage.reason, 'zeroDenominator');
  delete row.reportedCurrency;
  assert.equal(calculateBalances(data).at(-1).amounts.assets.reason, 'currencyMismatch');
  row.reportedCurrency = 'TWD';
  assert.equal(calculateBalances(data).at(-1).currency, 'TWD');
  data.quarterly.balance.push({ ...row });
  result = calculateBalances(data).at(-1);
  assert.equal(result.date, null);
  assert.equal(result.amounts.assets.reason, 'ambiguousPeriod');
  assert.deepEqual(calculateBalances({ quarterly: { balance: [] } }), []);
  const gap = fixture();
  gap.quarterly.balance.splice(4, 1);
  const missing = calculateBalances(gap)[4];
  assert.equal(missing.label, 'FY 2024 Q4');
  assert.equal(missing.date, null);
  assert.equal(missing.amounts.assets.reason, 'missingPeriod');
});

test('all cached balance sheets retain exact reported dates, currencies and asset values', () => {
  const directory = path.join(__dirname, '..', 'cache', 'financials');
  for (const file of fs.readdirSync(directory).filter(file => file.endsWith('_statements_v2.json'))) {
    const data = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    for (const period of ['annual', 'quarterly']) {
      for (const column of calculateBalances(data, { period })) {
        for (const result of [...Object.values(column.amounts), ...Object.values(column.ratios)]) {
          assert.ok(result.value === null ? result.reason : Number.isFinite(result.value), file);
        }
        if (!column.date) continue;
        const row = data[period].balance.find(row => row.date === column.date);
        assert.equal(column.currency, row.reportedCurrency);
        assert.equal(column.amounts.assets.value, row.totalAssets);
      }
    }
  }
});
