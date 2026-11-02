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

test('alignToPeriods keeps already-normalized {date, segments} rows from load()', () => {
  const normalized = RevenueSegments.normalizeRows([
    { date: '2024-09-28', data: { iPhone: 10, Mac: 2 } },
  ]);
  assert.equal(normalized[0].segments.iPhone, 10);
  const aligned = RevenueSegments.alignToPeriods(normalized, ['2024-09']);
  assert.equal(aligned.columns[0].segments.iPhone, 10);
  assert.equal(aligned.columns[0].segments.Mac, 2);
});
