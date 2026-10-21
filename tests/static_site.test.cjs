const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSite, assets } = require('../scripts/build_site.cjs');

test('static production output contains both markets and required caches, not backend/source evidence', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'hkex-public-test-'));
  try {
    const files = buildSite(output);
    for (const filename of assets) assert.ok(fs.existsSync(path.join(output, filename)), filename);
    for (const filename of [path.join('cache', 'fx', 'hkd_rates.json'), path.join('cache', 'fx', 'usd_rates.json'),
      path.join('cache', 'financials', '0700.HK_statements_v2.json'), path.join('cache', 'price_charts', 'AAPL.json'),
      path.join('cache', 'beta_benchmarks', 'SPY.json'), path.join('cache', 'beta_benchmarks', '2800.HK.json'),
      'beta_lookback.js']) {
      assert.ok(fs.existsSync(path.join(output, filename)), filename);
    }
    assert.equal(files.some(filename => /\.py$|\.cjs$|moat-inputs|transcript/.test(filename)), false);
    assert.equal(fs.existsSync(path.join(output, 'scripts')), false);
    assert.equal(fs.existsSync(path.join(output, '.github')), false);
    assert.throws(() => buildSite(path.resolve(__dirname, '..')), /repository root/);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
