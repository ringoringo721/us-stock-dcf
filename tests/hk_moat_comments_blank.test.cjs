'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { repairCompanyCache, SHARE_PATCH_KEYS } = require('../scripts/repair_hkex_share_capital_apply.cjs');

const root = path.join(__dirname, '..');
const DIMS = [
  'm1_brand_pricing', 'm2_patents_regulatory', 'm3_high_switching_costs',
  'm4_network_effects', 'm5_cost_advantage_scale', 'm6_unique_geography_assets',
  'm7_operational_efficiency', 'm8_capital_allocation', 'm9_customer_retention',
  'm10_durability'
];

function zhCount(moat) {
  return DIMS.reduce((n, key) => n + (((moat?.[key] || {}).comment_zh || '').trim() ? 1 : 0), 0);
}

test('1766.HK company cache keeps full Traditional Chinese moat comments after share repair', () => {
  const record = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'hk_companies', '1766.HK.json'), 'utf8'));
  assert.equal(zhCount(record.stock.moat), 10);
  for (const key of DIMS) {
    const zh = (record.stock.moat[key].comment_zh || '').trim();
    const en = (record.stock.moat[key].comment_en || '').trim();
    // Salvaged pre-#106 comments — restore even if some dims are outside the
    // later 100–300 字 preference band; do not remoat for length alone.
    assert.ok(zh.length > 0, `${key} missing comment_zh`);
    assert.ok(en.length > 0, `${key} missing comment_en`);
    assert.equal(typeof record.stock.moat[key].score, 'number');
  }
  assert.ok((record.stock.moat.overall_moat_verdict_zh || '').trim().length > 0);
  assert.equal(record.stock.shares_outstanding, 28698864088);
  assert.equal(record.stock.shareBasis, 'commonSharesOutstandingExcludingTreasury');
});

test('repairCompanyCache share patch preserves moat comments on disk', () => {
  const ticker = '1766.HK';
  const target = path.join(root, 'cache', 'hk_companies', `${ticker}.json`);
  const before = fs.readFileSync(target, 'utf8');
  const original = JSON.parse(before);
  assert.equal(zhCount(original.stock.moat), 10);
  assert.ok(SHARE_PATCH_KEYS.includes('shares'));
  assert.ok(!SHARE_PATCH_KEYS.includes('moat'));

  const compactLike = {
    ...original.stock,
    shares: 12345.6,
    shares_display: 12345.6,
    shares_outstanding: 12345600000,
    shareBasis: 'commonSharesOutstandingExcludingTreasury',
    shareSource: {
      shares: 12345.6,
      outstandingShares: 12345600000,
      basis: 'commonSharesOutstandingExcludingTreasury'
    },
    moat: Object.fromEntries(DIMS.map(key => [key, { score: original.stock.moat[key].score }])),
    f_score_breakdown: [],
    z_score_breakdown: [],
    m_score_breakdown: []
  };

  try {
    assert.ok(repairCompanyCache(ticker, compactLike));
    const after = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(zhCount(after.stock.moat), 10);
    assert.deepEqual(after.stock.moat, original.stock.moat);
    assert.equal(after.stock.shares, 12345.6);
    assert.equal(after.stock.shares_outstanding, 12345600000);
    assert.deepEqual(after.stock.f_score_breakdown, original.stock.f_score_breakdown);
  } finally {
    fs.writeFileSync(target, before);
  }
});
