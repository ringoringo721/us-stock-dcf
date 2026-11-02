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

test('statement DPS proxy and leverage-to-FCF helpers', () => {
  const metrics = DividendHistory.metricsFromStatements({
    annual: {
      income: [
        { date: '2020-12-31', weightedAverageShsOutDil: 100 },
        { date: '2025-12-31', weightedAverageShsOutDil: 100 },
      ],
      cashflow: [
        { date: '2020-12-31', commonDividendsPaid: -100 },
        { date: '2025-12-31', commonDividendsPaid: -150 },
      ],
    },
  }, { debt: 300, net_debt: 100, fcf0: 50 });
  assert.equal(metrics.div_cagr_5y, 8.45);
  assert.equal(metrics.debt_to_fcf, 6);
  assert.equal(metrics.net_debt_to_fcf, 2);
});

test('leverage stays N/A when FCF is non-positive', () => {
  assert.deepEqual(DividendHistory.leverageToFcf({ debt: 10, net_debt: -5, fcf0: 0 }), {
    debt_to_fcf: null, net_debt_to_fcf: null,
  });
});
