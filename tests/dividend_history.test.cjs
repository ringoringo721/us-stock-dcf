'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const DividendHistory = require('../dividend_history.js');

test('calendar aggregation fills Q/H/FY from ex-dividend dates', () => {
  const table = DividendHistory.aggregateCalendar([
    { date: '2024-02-15', adjDividend: 0.24 },
    { date: '2024-05-15', dividend: 0.25 },
    { date: '2024-08-15', adjDividend: 0.25 },
    { date: '2024-11-15', adjDividend: 0.26 },
    { date: '2023-03-01', adjDividend: 0.23 },
  ], { years: 2, asOf: '2024-12-31' });
  const y2024 = table.years.find(row => row.year === 2024);
  assert.equal(y2024.q1, 0.24);
  assert.equal(y2024.q2, 0.25);
  assert.equal(y2024.h1, 0.49);
  assert.ok(Math.abs(y2024.fy - 1.0) < 1e-9);
  assert.equal(y2024.count, 4);
});

test('aggregateCalendar respects adjustable tenor up to 30y and attaches payout ratio', () => {
  const payments = [];
  for (let year = 1995; year <= 2024; year++) {
    payments.push({ date: `${year}-03-15`, adjDividend: 0.1 });
  }
  const payoutByYear = new Map([[2024, 35.5], [2023, 40]]);
  const table = DividendHistory.aggregateCalendar(payments, {
    years: 10, asOf: '2024-12-31', payoutByYear,
  });
  assert.equal(table.span, 10);
  assert.equal(table.years.length, 10);
  assert.equal(table.years[0].year, 2024);
  assert.equal(table.years[0].payoutRatioPct, 35.5);
  assert.equal(table.years.at(-1).year, 2015);
});

test('tableForGrain exposes amount columns plus payout for Q/H/FY', () => {
  const aggregated = DividendHistory.aggregateCalendar([
    { date: '2024-02-15', adjDividend: 0.24 },
    { date: '2024-05-15', adjDividend: 0.25 },
    { date: '2024-08-15', adjDividend: 0.25 },
    { date: '2024-11-15', adjDividend: 0.26 },
  ], { years: 1, asOf: '2024-12-31', payoutByYear: new Map([[2024, 28]]) });
  const quarter = DividendHistory.tableForGrain(aggregated, 'quarter');
  assert.deepEqual(quarter.columns, ['q1', 'q2', 'q3', 'q4', 'fy']);
  assert.equal(quarter.rows[0].payoutRatioPct, 28);
  assert.equal(quarter.rows[0].amount.fy, 1);
  const half = DividendHistory.tableForGrain(aggregated, 'half');
  assert.deepEqual(half.columns, ['h1', 'h2', 'fy']);
  const year = DividendHistory.tableForGrain(aggregated, 'year');
  assert.deepEqual(year.columns, ['fy']);
});

test('CAGR windows use positive DPS endpoints', () => {
  const series = [
    { date: '2015-12-31', dps: 1 },
    { date: '2020-12-31', dps: 1.5 },
    { date: '2025-12-31', dps: 2.25 },
  ];
  const growth = DividendHistory.growthWindows(series, '2025-12-31');
  assert.equal(growth.div_cagr_5y, 8.45);
  assert.equal(growth.div_cagr_10y, 8.45);
  assert.equal(growth.div_cagr_15y, null);
});

test('statement DPS proxy, payout ratio, and leverage-to-FCF helpers', () => {
  const statements = {
    annual: {
      income: [
        { date: '2020-12-31', weightedAverageShsOutDil: 100, netIncome: 200, epsdiluted: 2 },
        { date: '2025-12-31', weightedAverageShsOutDil: 100, netIncome: 300, epsdiluted: 3 },
      ],
      cashflow: [
        { date: '2020-12-31', commonDividendsPaid: -100 },
        { date: '2025-12-31', commonDividendsPaid: -150 },
      ],
    },
  };
  const metrics = DividendHistory.metricsFromStatements(statements, { debt: 300, net_debt: 100, fcf0: 50 });
  assert.equal(metrics.div_cagr_5y, 8.45);
  assert.equal(metrics.debt_to_fcf, 6);
  assert.equal(metrics.net_debt_to_fcf, 2);
  const payout = DividendHistory.payoutRatiosFromStatements(statements);
  assert.equal(payout.get(2025), 50);
  assert.equal(payout.get(2020), 50);
  const synthetic = DividendHistory.paymentsFromStatements(statements);
  assert.equal(synthetic.length, 2);
  assert.equal(synthetic[1].dividend, 1.5);
});

test('leverage stays N/A when FCF is non-positive', () => {
  assert.deepEqual(DividendHistory.leverageToFcf({ debt: 10, net_debt: -5, fcf0: 0 }), {
    debt_to_fcf: null, net_debt_to_fcf: null,
  });
  assert.deepEqual(DividendHistory.leverageToFcf({ debt: 10, net_debt: -5, fcf0: -20 }), {
    debt_to_fcf: null, net_debt_to_fcf: null,
  });
});

test('paymentsFromStatementRaw builds DPS and scale-invariant payout %', () => {
  const { payments, payoutByYear } = DividendHistory.paymentsFromStatementRaw({
    annual_dates: ['2023-06', '2024-06'],
    cashflow: { dividendsPaid: [-21771, -24082] },
    income: {
      netIncome: [88136, 101832],
      weightedAverageShsOutDil: [7469000000, 7465000000],
    },
  });
  assert.equal(payments.length, 2);
  assert.ok(payments[0].dividend > 0);
  assert.equal(payoutByYear.get(2024), Math.round((24082 / 101832) * 10000) / 100);
});

test('statement FY DPS fallback does not dump into Q4', () => {
  const payments = DividendHistory.paymentsFromStatements({
    annual: {
      income: [{ date: '2024-12-31', weightedAverageShsOutDil: 100 }],
      cashflow: [{ date: '2024-12-31', commonDividendsPaid: -500 }],
    },
  });
  assert.equal(payments[0].annualOnly, true);
  const table = DividendHistory.aggregateCalendar(payments, { years: 5, asOf: '2024-12-31' });
  const y2024 = table.years.find(row => row.year === 2024);
  assert.equal(y2024.fy, 5);
  assert.equal(y2024.q1, null);
  assert.equal(y2024.q2, null);
  assert.equal(y2024.q3, null);
  assert.equal(y2024.q4, null);
  assert.equal(y2024.annualOnly, true);
});

test('annualDpsFromPayments keeps a window longer than 30y for CAGR publish', () => {
  const payments = [];
  for (let year = 1990; year <= 2024; year++) {
    payments.push(
      { date: `${year}-03-15`, adjDividend: 0.2 },
      { date: `${year}-06-15`, adjDividend: 0.2 },
      { date: `${year}-09-15`, adjDividend: 0.2 },
      { date: `${year}-12-15`, adjDividend: 0.2 },
    );
  }
  const series = DividendHistory.annualDpsFromPayments(payments);
  assert.ok(series.length >= 30, `expected ≥30 annual points, got ${series.length}`);
  const growth = DividendHistory.growthWindows(series, '2024-12-31');
  assert.ok(growth.div_cagr_30y != null);
});

test('continuousDividendGrowth matches TradingView Cont div growth example', () => {
  // Chronological DPS $100,$90,$80,$80,$90,$100 → trailing streak [80,90,100] → 3.
  const series = [100, 90, 80, 80, 90, 100].map((dps, i) => ({
    date: `${2019 + i}-12-31`,
    dps,
  }));
  assert.equal(DividendHistory.continuousDividendGrowth(series), 3);
  assert.equal(DividendHistory.continuousDividendGrowth([
    { date: '2023-12-31', dps: 1 },
    { date: '2024-12-31', dps: 1 },
  ]), 0);
  assert.equal(DividendHistory.continuousDividendGrowth([
    { date: '2018-12-31', dps: 1 },
    { date: '2019-12-31', dps: 2 },
    { date: '2020-12-31', dps: 3 },
    { date: '2021-12-31', dps: 4 },
    { date: '2022-12-31', dps: 5 },
    { date: '2023-12-31', dps: 6 },
    { date: '2024-12-31', dps: 7 },
    { date: '2025-12-31', dps: 8 },
  ]), 7); // capped
  const metrics = DividendHistory.metricsFromPayments([
    { date: '2022-03-15', adjDividend: 80 },
    { date: '2023-03-15', adjDividend: 80 },
    { date: '2024-03-15', adjDividend: 90 },
    { date: '2025-03-15', adjDividend: 100 },
  ], null, '2025-12-31');
  assert.equal(metrics.cont_div_growth, 3);
  // Dividend holiday omitted from series must break the streak (no year skip).
  assert.equal(DividendHistory.continuousDividendGrowth([
    { date: '2020-12-31', dps: 1 },
    { date: '2021-12-31', dps: 2 },
    // 2022 suspended — missing
    { date: '2023-12-31', dps: 3 },
    { date: '2024-12-31', dps: 4 },
  ]), 2);
  // Incomplete open year (asOf = last complete) excludes YTD that would zero the streak.
  assert.equal(DividendHistory.continuousDividendGrowth([
    { date: '2023-12-31', dps: 1 },
    { date: '2024-12-31', dps: 2 },
    { date: '2025-12-31', dps: 3 },
    { date: '2026-12-31', dps: 0.5 }, // YTD partial
  ], '2025-12-31'), 3);
});

test('trailingTwelveMonthYieldPct sums last 365d (not last 4 rows)', () => {
  // Annual payer: four yearly rows must NOT inflate to 4×.
  const annual = [
    { date: '2022-03-15', adjDividend: 1 },
    { date: '2023-03-15', adjDividend: 1 },
    { date: '2024-03-15', adjDividend: 1 },
    { date: '2025-03-15', adjDividend: 1 },
  ];
  assert.equal(DividendHistory.trailingTwelveMonthDps(annual, '2025-06-01'), 1);
  assert.equal(DividendHistory.trailingTwelveMonthYieldPct(annual, 50, '2025-06-01'), 2);
  // Quarterly: four pays inside the window sum.
  const quarterly = [
    { date: '2024-09-15', adjDividend: 0.25 },
    { date: '2024-12-15', adjDividend: 0.25 },
    { date: '2025-03-15', adjDividend: 0.25 },
    { date: '2025-06-15', adjDividend: 0.25 },
  ];
  assert.equal(DividendHistory.trailingTwelveMonthDps(quarterly, '2025-07-01'), 1);
  assert.equal(DividendHistory.trailingTwelveMonthYieldPct(quarterly, 25, '2025-07-01'), 4);
});

test('yieldPct uses year-end close then current quote for open year', () => {
  const closes = DividendHistory.yearEndCloseByYear([
    ['2024-12-31', 200],
    ['2025-06-01', 210],
    ['2025-12-30', 250],
  ]);
  assert.equal(closes.get(2025), 250);
  assert.equal(DividendHistory.yieldPctForYear(2.5, 2025, { yearEndCloseByYear: closes }), 1);
  const shaped = DividendHistory.tableForGrain(
    DividendHistory.aggregateCalendar([
      { date: '2025-02-15', adjDividend: 0.25 },
      { date: '2025-05-15', adjDividend: 0.25 },
      { date: '2025-08-15', adjDividend: 0.25 },
      { date: '2025-11-15', adjDividend: 0.25 },
    ], { years: 1, asOf: '2025-12-31' }),
    'year',
    { yearEndCloseByYear: closes, currentPrice: 260 },
  );
  // FY DPS = 1.00; year-end close 250 → 0.4%
  assert.equal(shaped.rows[0].fy, 1);
  assert.equal(shaped.rows[0].yieldPct, 0.4);
});
