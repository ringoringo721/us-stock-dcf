'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { repairStatements } = require('../scripts/repair_ttm_cash_stock_balances.cjs');

function rawFromQuarters(begins, ends, summed = true) {
  const windowBeg = begins.slice(-4);
  const windowEnd = ends.slice(-4);
  return {
    cashflow: {
      cashAtBeginningOfPeriod: [100, summed ? windowBeg.reduce((a, b) => a + b, 0) : windowBeg[0]],
      cashAtEndOfPeriod: [110, summed ? windowEnd.reduce((a, b) => a + b, 0) : windowEnd.at(-1)]
    },
    quarterly_raw: {
      cashflow: {
        cashAtBeginningOfPeriod: begins,
        cashAtEndOfPeriod: ends
      }
    }
  };
}

test('repair replaces summed TTM cash stock balances with window endpoints', () => {
  const begins = [10, 20, 30, 40, 50, 60, 70, 80];
  const ends = [20, 30, 40, 50, 60, 70, 80, 90];
  const fixed = repairStatements(rawFromQuarters(begins, ends, true));
  assert.ok(fixed);
  assert.equal(fixed.after.cashAtBeginningOfPeriod, 50);
  assert.equal(fixed.after.cashAtEndOfPeriod, 90);
  assert.deepEqual(fixed.statements_raw.cashflow.cashAtBeginningOfPeriod, [100, 50]);
  assert.deepEqual(fixed.statements_raw.cashflow.cashAtEndOfPeriod, [110, 90]);
});

test('repair leaves already-correct TTM cash stock balances alone', () => {
  const begins = [10, 20, 30, 40];
  const ends = [20, 30, 40, 50];
  assert.equal(repairStatements(rawFromQuarters(begins, ends, false)), null);
});

test('repair ignores flow-like values that are not quarter sums', () => {
  const raw = rawFromQuarters([10, 20, 30, 40], [20, 30, 40, 50], true);
  raw.cashflow.cashAtBeginningOfPeriod = [100, 999];
  raw.cashflow.cashAtEndOfPeriod = [110, 888];
  assert.equal(repairStatements(raw), null);
});
