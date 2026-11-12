'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { valuationShares } = require('../scripts/build_hkex.cjs');
const { applyOne, itemFor } = require('../scripts/repair_hkex_share_capital_apply.cjs');
const { evidenceFromStock } = require('../scripts/repair_hkex_share_reviews.cjs');
const Models = require('../fmp_models.js');

const root = path.join(__dirname, '..');
const capital = require('../cache/hkex_share_capital.json');
const loadExpansion = () => JSON.parse(
  fs.readFileSync(path.join(root, 'hkex_expansion_data.js'), 'utf8')
    .replace(/^window\.HKEX_EXPANSION = /, '').replace(/;?\s*$/, '')
);

test('1766.HK has verified issuer-wide A+H ordinary shares from the October 2026 monthly return', () => {
  const record = capital['1766.HK'];
  assert.ok(record, 'capital record');
  assert.equal(record.coverage, 'allOrdinaryShareClasses');
  assert.equal(record.date, '2026-10-31');
  assert.equal(record.filingDate, '2026-11-02');
  assert.match(record.url, /^https:\/\/www1\.hkexnews\.hk\/.+\.pdf$/);
  assert.match(record.documentSha256, /^[a-f0-9]{64}$/);
  const byName = Object.fromEntries(record.classes.map(row => [row.name, row]));
  assert.equal(byName.H.issuedShares, 4371066040);
  assert.equal(byName.H.treasuryShares, 0);
  assert.equal(byName.A.issuedShares, 24327798048);
  assert.equal(byName.A.treasuryShares, 0);
  const outstanding = record.classes.reduce(
    (total, row) => total + row.issuedShares - row.treasuryShares, 0);
  assert.equal(outstanding, 28698864088);

  const expansion = loadExpansion();
  const stock = expansion.stocks['1766.HK'];
  assert.equal(stock.shares_outstanding, 28698864088);
  assert.equal(stock.shareBasis, 'commonSharesOutstandingExcludingTreasury');
  assert.equal(stock.shareSource.scope, 'issuerWideOrdinaryShares');
  assert.equal(stock.shareSource.reason, undefined);

  const item = itemFor('1766.HK', stock);
  const verified = valuationShares(item, evidenceFromStock(item, stock));
  assert.equal(verified.outstandingShares, 28698864088);
  assert.equal(verified.scope, 'issuerWideOrdinaryShares');
  assert.notEqual(verified.basis, 'unavailable');

  // Fair value uses verified issued shares, never FMP diluted weighted-average substitution.
  assert.equal(Models.issuedShares(stock), 28698864088);
  const model = expansion.models['1766.HK'];
  const valued = Models.value(model, 'advanced', stock);
  assert.equal(valued.reason, null);
  assert.ok(Number.isFinite(valued.fairVal) && valued.fairVal > 0);
  assert.ok(Number.isFinite(valued.WACC) && valued.WACC > 0);
  assert.equal(valued.issuedShares, 28698864088);
  // Denominator is verified issued ordinary shares from the monthly return, not a silent
  // diluted weighted-average substitute — even when FMP's diluted count happens to match.
  assert.equal(valued.providerShares, model.models.advanced.data[0].dilutedSharesOutstanding);
  assert.ok(Math.abs(valued.fairVal - model.models.advanced.data[0].equityValue / 28698864088) < 1e-9);
});

test('3983.HK liquidation uses issuer-wide H+Domestic issued shares (4.61B), not H-only 1.796B', () => {
  const record = capital['3983.HK'];
  assert.ok(record, 'capital record');
  assert.equal(record.coverage, 'allOrdinaryShareClasses');
  const byName = Object.fromEntries(record.classes.map(row => [row.name, row]));
  assert.equal(byName.H.issuedShares, 1796000122);
  assert.equal(byName.H.treasuryShares, 0);
  assert.equal(byName.Domestic.issuedShares, 2813999878);
  assert.equal(byName.Domestic.treasuryShares, 0);
  const outstanding = record.classes.reduce(
    (total, row) => total + row.issuedShares - row.treasuryShares, 0);
  assert.equal(outstanding, 4610000000);

  const expansion = loadExpansion();
  const stock = expansion.stocks['3983.HK'];
  assert.equal(stock.shares_outstanding, 4610000000);
  assert.equal(stock.shareBasis, 'commonSharesOutstandingExcludingTreasury');
  assert.equal(stock.shareSource.scope, 'issuerWideOrdinaryShares');
  assert.equal(stock.shareSource.reason, undefined);
  assert.equal(Models.issuedShares(stock), 4610000000);

  const { calculate } = require('../liquidation.js');
  const liq = calculate(stock.liquidation, '3983.HK');
  assert.deepEqual(liq.reasons, [null, null, null]);
  // Prior H-only denominator inflated I/II/III to ~7.27/6.30/5.78; issuer-wide is ~2.83/2.46/2.25.
  assert.ok(Math.abs(liq.values[0] - 2.832369117945661) < 1e-9);
  assert.ok(Math.abs(liq.values[1] - 2.4554617726046786) < 1e-9);
  assert.ok(Math.abs(liq.values[2] - 2.251047425861203) < 1e-9);
  assert.equal(liq.shares, 4610000000);
});

test('applyOne refuses to invent shares when monthly-return capital is absent', () => {
  const stock = {
    ticker: '9999.HK',
    shares: null,
    shares_outstanding: null,
    shareSource: {
      reason: 'shareBasisUnverified',
      providerComparison: { shares: 100, date: '2026-11-05' }
    }
  };
  const result = applyOne('9999.HK', stock);
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'noCapital');
});
