'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const RevenueSegments = require('../revenue_segments.js');

test('normalizeRows flattens FMP product segmentation payloads', () => {
  const rows = RevenueSegments.normalizeRows([
    { date: '2024-09-28', symbol: 'AAPL', data: { iPhone: 201e9, Mac: 30e9 } },
    { date: '2023-09-30', iPhone: 180e9, Services: 85e9 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, '2023-09-30');
  assert.equal(rows[1].segments.iPhone, 201e9);
});

test('normalizeRows unwraps symbol-keyed nested segment maps', () => {
  const rows = RevenueSegments.normalizeRows([
    { date: '2024-01-28', NVDA: { 'Compute & Networking': 18e9, 'Graphics': 3e9 } },
  ], 'NVDA');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].segments['Compute & Networking'], 18e9);
  assert.equal(rows[0].segments.Graphics, 3e9);
});

test('alignToPeriods matches YYYY-MM prefixes then prior dates', () => {
  const aligned = RevenueSegments.alignToPeriods([
    { date: '2024-09-28', data: { iPhone: 10, Mac: 2 } },
    { date: '2023-09-30', data: { iPhone: 8, Mac: 1 } },
  ], ['2023-09', '2024-09', 'TTM']);
  assert.deepEqual(new Set(aligned.names), new Set(['Mac', 'iPhone']));
  assert.equal(aligned.columns[0].segments.iPhone, 8);
  assert.equal(aligned.columns[1].segments.Mac, 2);
  assert.equal(aligned.columns[2].segments, null);
});

test('alignToPeriods never maps TTM/latest-balance to a prior FY segment date', () => {
  const aligned = RevenueSegments.alignToPeriods([
    { date: '2025-09-27', data: { iPhone: 209e9 } },
    { date: '2024-09-28', data: { iPhone: 201e9 } },
  ], [
    { label: '2024', date: '2024-09-28' },
    { label: '2025', date: '2025-09-27' },
    { label: 'TTM', date: '2026-06-28', kind: 'ttm' },
  ]);
  assert.equal(aligned.columns[0].segments.iPhone, 201e9);
  assert.equal(aligned.columns[1].segments.iPhone, 209e9);
  assert.equal(aligned.columns[2].label, 'TTM');
  assert.equal(aligned.columns[2].segments, null);
  assert.equal(aligned.columns[2].date, '2026-06-28');
});

test('alignToPeriods string TTM label also skips nearest-prior FY match', () => {
  const aligned = RevenueSegments.alignToPeriods([
    { date: '2025-09-27', data: { iPhone: 1 } },
  ], ['2025-09-27', '2026-06-28']);
  // Last entry looks like an ISO date (statement TTM axis) — still matches prior FY today.
  // Specs with kind/label TTM are the supported way to leave TTM empty.
  assert.equal(aligned.columns[0].segments.iPhone, 1);
  const ttm = RevenueSegments.alignToPeriods([
    { date: '2025-09-27', data: { iPhone: 1 } },
  ], [{ label: 'TTM', date: '2026-06-28' }]);
  assert.equal(ttm.columns[0].segments, null);
});

test('alignToPeriods keeps already-normalized {date, segments} rows from load()', () => {
  const normalized = RevenueSegments.normalizeRows([
    { date: '2024-09-28', data: { iPhone: 10, Mac: 2 } },
  ]);
  assert.equal(normalized[0].segments.iPhone, 10);
  const aligned = RevenueSegments.alignToPeriods(normalized, ['2024-09']);
  assert.equal(aligned.columns[0].segments.iPhone, 10);
  assert.equal(aligned.columns[0].segments.Mac, 2);
});

test('fmpPeriod maps statement cadence to FMP annual|quarter', () => {
  assert.equal(RevenueSegments.fmpPeriod('quarterly'), 'quarter');
  assert.equal(RevenueSegments.fmpPeriod('quarter'), 'quarter');
  assert.equal(RevenueSegments.fmpPeriod('annual'), 'annual');
  assert.equal(RevenueSegments.fmpPeriod('semiannual'), 'annual');
});

test('validateCache marks unset period as annual-compatible only', () => {
  const record = RevenueSegments.validateCache({
    version: 1,
    ticker: 'AAPL',
    product: [{ date: '2024-09-28', data: { iPhone: 1 } }],
    geographic: [],
  }, 'AAPL');
  assert.equal(record.period, null);
  assert.equal(record.product[0].segments.iPhone, 1);
});
