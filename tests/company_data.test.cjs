const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const { matches } = require('../stock_search.js');
const { splits, newsRows, safeUrl } = require('../company_data.js');
const { reportedGrowth } = require('../scripts/reported_growth.cjs');
const { storedGrowth, annualGrowth } = require('../profile_overview.js');
const rates = require('../cache/fx/hkd_rates.json');
const market = require('../hk_market_dcf.json');

test('HK search accepts code variants, Chinese, full company names and a one-letter English typo', () => {
  const tencent = market['0700.HK'];
  for (const query of ['700', '0700', '00700', '0700.HK', '00700.hk', ' 700 ', 'Tencent', 'Tecent', '\u9a30', '\u817e', 'Holdings']) {
    assert.equal(matches(tencent, query), true, query);
  }
  assert.equal(matches(tencent, '9988'), false);
  assert.equal(matches(tencent, 'Unrelated'), false);
  assert.equal(matches(tencent, 'media'), true);
  assert.equal(matches({ ticker: 'AAPL', name: 'Apple' }, 'appl'), true);
  assert.equal(matches({ ticker: 'AAPL', name: 'Apple' }, '700'), false);
});

test('FMP split adjustment rows get usable ratios without falsely certifying rights adjustments as splits', () => {
  const rows = splits([{ symbol: '0700.HK', date: '2014-05-15', numerator: 5, denominator: 1 },
    { date: '2023-02-24', numerator: 1029, denominator: 1000 }, { date: '2024-02-30', numerator: 2, denominator: 1 }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ratio, '1029:1000');
  assert.equal(rows[1].ratio, '5:1');
  assert.equal(rows[0].verifiedEventType, false);
  assert.ok(rows[0].desc);
  assert.equal(splits([{ date: '2025-01-01', numerator: null, denominator: 1 }])[0].ratio, 'N/A');
});

test('News retains only actual dated articles for this security with safe links, deduplicated by URL', () => {
  const row = { symbol: '0700.HK', publishedDate: '2026-10-01 12:00:00', title: 'Actual title', url: 'https://example.com/article' };
  const rows = newsRows([row, { ...row }, { ...row, symbol: 'TCEHY' }, { ...row, url: 'javascript:alert(1)' },
    { ...row, publishedDate: '2026-02-30 00:00:00' }], '0700.HK');
  assert.deepEqual(rows, [row]);
  assert.equal(safeUrl('javascript:alert(1)'), null);
});

test('Every HK stock has genuinely supported growth records in HKD; annual-only cash flow is explicitly FY, not TTM', () => {
  for (const [ticker, stock] of Object.entries(market)) {
    const source = JSON.parse(fs.readFileSync(`cache\\financials\\${ticker}_statements_v2.json`, 'utf8'));
    const record = reportedGrowth(source, rates);
    assert.equal(record.currency, 'HKD', ticker);
    const updated = { ...stock, reported_growth: record };
    assert.ok(Number.isFinite(storedGrowth(updated, 'revenue')?.value), ticker);
    if (source.statementFrequencies.cashflow === 'annual') {
      const cf = storedGrowth(updated, 'operatingCashFlow');
      assert.equal(cf.basis, 'annual');
      assert.ok(Number.isFinite(cf.value), ticker);
      assert.equal(cf.date, source.annual.cashflow.at(-1).date);
      assert.notEqual(cf.date, record.date);
    }
  }
});

test('Annual growth rejects missing FX, invalid dates, missing fields and nonpositive prior bases', () => {
  const data = { annual: { cashflow: [
    { date: '2024-12-31', reportedCurrency: 'HKD', freeCashFlow: 100 },
    { date: '2025-12-31', reportedCurrency: 'HKD', freeCashFlow: 120 }
  ] } };
  assert.ok(Math.abs(annualGrowth(data, 'cashflow', 'freeCashFlow').value - 20) < 1e-12);
  for (const [change, reason] of [
    [d => { d.annual.cashflow[0].freeCashFlow = 0; }, 'nonPositivePrior'],
    [d => { d.annual.cashflow[1].freeCashFlow = null; }, 'missingField'],
    [d => { d.annual.cashflow[0].currencyConversion = { reason: 'missingFxDate' }; }, 'missingFx'],
    [d => { d.annual.cashflow[0].date = '2024-02-30'; }, 'dateMismatch']
  ]) {
    const copy = structuredClone(data);
    change(copy);
    assert.equal(annualGrowth(copy, 'cashflow', 'freeCashFlow').reason, reason);
  }
});
