const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const Price = require('../price_history.js');
const rows = [
  ['2023-12-29', 100, 1000], ['2024-01-02', 110, null],
  ['2024-02-29', 120, 0], ['2024-12-31', 150, 2000], ['2025-02-28', 180, 3000]
];
const record = (data = rows) => ({
  version: 1, ticker: 'TEST', currency: 'USD', priceBasis: 'splitAdjustedClose',
  source: 'FMP historical-price-eod/full', requestedFrom: '2023-01-01', requestedTo: '2025-03-01', rows: data
});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('historical prices accept real null/zero volume but reject invalid and mixed data', () => {
  assert.equal(Price.validate(record(), 'TEST').rows[1][2], null);
  for (const invalid of [
    { ...record(), currency: 'TWD' }, { ...record(), priceBasis: 'unknown' }, { ...record(), ticker: 'OTHER' },
    record([...rows].reverse()), record([rows[0], rows[0]]),
    record([['2024-02-30', 100, 1000]]), record([['2024-02-29', 0, 1000]]),
    record([['2024-02-29', '100', 1000]]), record([['2024-02-29', 100, -1]]),
    record([['2024-02-29', 100, undefined]]), record([['2026-01-01', 100, 1000]])
  ]) assert.throws(() => Price.validate(invalid, 'TEST'), TypeError);
  assert.equal(Price.validate(record([]), 'TEST').rows.length, 0);
});

test('calendar periods clamp leap days and YTD uses the last actual prior-year close', () => {
  assert.deepEqual(Price.periodRange(rows, 'ytd'), ['2024-12-31', '2025-02-28']);
  assert.deepEqual(Price.periodRange(rows, '1y'), ['2024-02-29', '2025-02-28']);
  assert.deepEqual(Price.periodRange(rows.slice(0, 3), '1y'), ['2023-12-29', '2024-02-29']);
  assert.deepEqual(Price.periodRange(rows, '10y'), [rows[0][0], rows.at(-1)[0]]);
  assert.deepEqual(Price.periodRange(rows, 'all'), [rows[0][0], rows.at(-1)[0]]);
  assert.equal(Price.periodRange([], '5y'), null);
  assert.throws(() => Price.periodRange(rows, 'bad'), TypeError);
});

test('custom dates preserve actual sessions, empty ranges, missing volume and single points', () => {
  assert.deepEqual(Price.select(rows, '2023-12-30', '2024-01-03'), [rows[1]]);
  assert.deepEqual(Price.select(rows, '2024-01-03', '2024-01-04'), []);
  assert.throws(() => Price.select(rows, '2024-02-30', '2024-03-01'), RangeError);
  assert.throws(() => Price.select(rows, '2025-01-01', '2024-01-01'), RangeError);
  assert.equal(Price.summarize([rows[1]]).change, null);
  assert.equal(Price.summarize([rows[1]]).cagr, null);
  assert.equal(Price.summarize([]).price, null);
});

test('returns use selected observed closes and annualize only sufficiently long periods', () => {
  near(Price.summarize(rows).change, 80);
  const days = (Date.parse(rows.at(-1)[0]) - Date.parse(rows[0][0])) / 86400000;
  near(Price.summarize(rows).cagr, (Math.pow(1.8, 365.25 / days) - 1) * 100);
  const ytd = Price.select(rows, ...Price.periodRange(rows, 'ytd'));
  near(Price.summarize(ytd).change, 20);
  assert.equal(Price.summarize(ytd).cagr, null);
  near(Price.summarize([['2024-01-01', 100, 1], ['2025-01-01', 50, 1]]).change, -50);
  assert.equal(Price.summarize([['2024-01-01', Number.MIN_VALUE, 1], ['2025-01-01', 1e308, 1]]).change, null);
});

test('CSV exports exact selected source precision and blanks, not fabricated volume', () => {
  assert.match(Price.csv(rows.slice(1, 3)), /2024-01-02,110,\r\n2024-02-29,120,0/);
  assert.match(Price.csv([['2024-01-02', 12.3456, 7]]), /12\.3456,7/);
});

test('every covered stock has validated daily history or honest unavailability, with consistent ranges', () => {
  const market = require('../full_market_dcf.json');
  let observations = 0;
  for (const ticker of Object.keys(market)) {
    const data = Price.validate(JSON.parse(fs.readFileSync(
      require('node:path').join(__dirname, '..', 'cache', 'price_charts', `${ticker}.json`))), ticker);
    if (!data.rows.length) {
      assert.equal(Price.periodRange(data.rows, 'all'), null, ticker);
      continue;
    }
    assert.ok(data.rows.at(-1)[0] <= data.requestedTo, ticker);
    for (const period of ['3m', '6m', 'ytd', '1y', '3y', '5y', '10y', 'all']) {
      const selected = Price.select(data.rows, ...Price.periodRange(data.rows, period));
      const summary = Price.summarize(selected);
      assert.equal(summary.price, data.rows.at(-1)[1], ticker);
      if (selected.length > 1) near(summary.change, (selected.at(-1)[1] / selected[0][1] - 1) * 100);
    }
    observations += data.rows.length;
  }
  assert.ok(observations > 0);
});
