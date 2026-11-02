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

test('sanitizeQuarterlyRows de-cumulates near-YTD year-end and drops annual-scale Q4', () => {
  const ytd = RevenueSegments.sanitizeQuarterlyRows([
    { date: '2025-03-31', data: { A: 10 } },
    { date: '2025-06-30', data: { A: 10 } },
    { date: '2025-09-30', data: { A: 10 } },
    // Reported YTD ≈ sum(Q1–Q3) + small Q4 → de-cumulate to ~10
    { date: '2025-12-31', data: { A: 40 } },
  ]);
  // 40 vs priorSum 30 is >12% → treated as annual-scale (>> median) and dropped
  assert.deepEqual(ytd.map(row => row.date), ['2025-03-31', '2025-06-30', '2025-09-30']);

  const softYtd = RevenueSegments.sanitizeQuarterlyRows([
    { date: '2025-03-31', data: { A: 10 } },
    { date: '2025-06-30', data: { A: 10 } },
    { date: '2025-09-30', data: { A: 10 } },
    { date: '2025-12-31', data: { A: 31 } }, // ~YTD through Q3 + 1
  ]);
  assert.equal(softYtd.length, 4);
  assert.equal(softYtd[3].segments.A, 1);

  const annualScale = RevenueSegments.sanitizeQuarterlyRows([
    { date: '2014-03-31', data: { A: 500 } },
    { date: '2014-06-30', data: { A: 550 } },
    { date: '2014-09-30', data: { A: 560 } },
    { date: '2014-12-31', data: { A: 9981 } }, // FY dump into Q4 (ABBV-style)
  ]);
  assert.equal(annualScale.length, 3);
  assert.ok(!annualScale.some(row => row.date === '2014-12-31'));

  // Cascade: FY-scale into both Sep and Dec (real ABBV 2014 product feed).
  const cascade = RevenueSegments.sanitizeQuarterlyRows([
    { date: '2014-03-31', data: { A: 539 } },
    { date: '2014-06-30', data: { A: 559 } },
    { date: '2014-09-30', data: { A: 5019 } },
    { date: '2014-12-31', data: { A: 9981 } },
  ]);
  assert.deepEqual(cascade.map(row => row.date), ['2014-03-31', '2014-06-30']);

  // Coincident total match with mismatched keys must DROP — never invent negatives.
  const falseYtd = RevenueSegments.sanitizeQuarterlyRows([
    { date: '2025-03-31', data: { Construction: 10, Resource: 5 } },
    { date: '2025-06-30', data: { Construction: 12, Resource: 6 } },
    { date: '2025-09-30', data: { Construction: 11, Resource: 7 } },
    // Totals ≈ priorSum but rollup key differs → subtraction would go negative.
    { date: '2025-12-31', data: { Construction: 5, ReportableSubsegments: 46 } },
  ]);
  assert.deepEqual(falseYtd.map(row => row.date),
    ['2025-03-31', '2025-06-30', '2025-09-30']);
  assert.ok(falseYtd.every(row => Object.values(row.segments).every(v => v >= 0)));

  // Same keys but one residual negative → drop, do not keep partial residual.
  const negResidual = RevenueSegments.sanitizeQuarterlyRows([
    { date: '2025-03-31', data: { A: 10, B: 10 } },
    { date: '2025-06-30', data: { A: 10, B: 10 } },
    { date: '2025-09-30', data: { A: 10, B: 10 } },
    { date: '2025-12-31', data: { A: 40, B: 20 } }, // A residual 10, B residual −10
  ]);
  assert.equal(negResidual.length, 3);

  // Idempotent: a leftover de-cumulated Q4 must survive a second sanitize pass.
  const again = RevenueSegments.sanitizeQuarterlyRows(softYtd);
  assert.equal(again.length, 4);
  assert.equal(again[3].segments.A, 1);
});

test('validateCache period=quarter runs sanitizeQuarterlyRows', () => {
  const record = RevenueSegments.validateCache({
    version: 1,
    ticker: 'ABBV',
    period: 'quarter',
    product: [
      { date: '2014-03-31', data: { Humira: 500 } },
      { date: '2014-06-30', data: { Humira: 550 } },
      { date: '2014-09-30', data: { Humira: 560 } },
      { date: '2014-12-31', data: { Humira: 9981 } },
    ],
    geographic: [],
  }, 'ABBV');
  assert.equal(record.product.length, 3);
});

test('validateCache skips re-sanitize when sanitizedAt is set', () => {
  const leftoverQ4 = [
    { date: '2025-03-31', segments: { A: 10 } },
    { date: '2025-06-30', segments: { A: 10 } },
    { date: '2025-09-30', segments: { A: 10 } },
    { date: '2025-12-31', segments: { A: 1 } }, // de-cumulated leftover
  ];
  const record = RevenueSegments.validateCache({
    version: 1,
    ticker: 'TEST',
    period: 'quarter',
    sanitizedAt: '2026-11-02T00:00:00.000Z',
    product: leftoverQ4,
    geographic: [],
  }, 'TEST');
  assert.equal(record.product.length, 4);
  assert.equal(record.product[3].segments.A, 1);
});

test('sumTrailingQuarters / applyTtmFromQuarters fill annual TTM from last 4Q', () => {
  const quarters = [
    { date: '2025-12-31', data: { AWS: 10 } },
    { date: '2026-03-31', data: { AWS: 11 } },
    { date: '2026-06-30', data: { AWS: 12 } },
    { date: '2026-09-30', data: { AWS: 13 } },
  ];
  const sum = RevenueSegments.sumTrailingQuarters(quarters);
  assert.equal(sum.segments.AWS, 46);
  assert.equal(sum.date, '2026-09-30');
  assert.equal(RevenueSegments.sumTrailingQuarters(quarters.slice(0, 3)), null);

  const aligned = RevenueSegments.alignToPeriods(
    [{ date: '2025-12-31', data: { AWS: 40 } }],
    [{ label: '2025', date: '2025-12-31' }, { label: 'TTM', date: '2026-09-30', kind: 'ttm' }],
  );
  assert.equal(aligned.columns[1].segments, null);
  const filled = RevenueSegments.applyTtmFromQuarters(aligned, quarters);
  assert.equal(filled.columns[1].segments.AWS, 46);
  assert.equal(filled.columns[1].date, '2026-09-30');
});
