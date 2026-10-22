const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const universe = require('../us_universe.js');
const { needsMoatRecovery, ingest, packageResults, integrate } = require('../scripts/build_us_expansion.cjs');
const root = path.resolve(__dirname, '..');

test('US listings merge keeps the reviewed baseline and marks uncaptured names pending', () => {
  const market = { AAPL: { ticker: 'AAPL', calculationCurrency: 'USD', price: 100, moat: { m1_brand_pricing: { score: 9 } } } };
  const catalogue = {
    stocks: [
      { ticker: 'AAPL', name: 'Apple', name_en: 'Apple', exchange: 'NASDAQ', sector: 'Technology', industry: 'Hardware', marketCap: 3e12 },
      { ticker: 'NEWCO', name: 'New Co', name_en: 'New Co', exchange: 'NYSE', sector: 'Industrials', industry: 'Machinery', marketCap: 3e9,
        universeMembership: 'FMP US equity screener (NYSE/NASDAQ/AMEX, marketCap > USD 10B)' }
    ]
  };
  const merged = universe.merge(market, catalogue);
  assert.equal(merged.AAPL, market.AAPL);
  assert.equal(merged.NEWCO.price, null);
  assert.equal(merged.NEWCO.moat, null);
  assert.equal(merged.NEWCO.f_score, null);
  assert.equal(merged.NEWCO.expansion.status, 'pendingCapture');
  assert.equal(merged.NEWCO.ratingSources.moat.reason, 'analysisUnavailable');
});

test('incomplete US moat recovery refuses invented or partial scores', () => {
  assert.equal(needsMoatRecovery(null), true);
  assert.equal(needsMoatRecovery({ ratingSources: { moat: { reason: 'analysisUnavailable' } } }), true);
  const stock = {
    ratingSources: { moat: { evidenceHash: 'same', currentEvidenceHash: 'same', updatedAt: '2026-10-20T00:00:00Z' } },
    moat: Object.fromEntries(Array.from({ length: 10 }, (_, i) =>
      [`m${i + 1}_test`, { score: 8, comment_zh: '有據評分。', comment_en: 'Evidence-based.' }]))
  };
  stock.moat.overall_moat_verdict_zh = stock.moat.overall_moat_verdict_en = 'Evidence-based.';
  assert.equal(needsMoatRecovery(stock), false);
  stock.moat.m1_test.score = 5;
  stock.moat.m1_test.comment_zh = '';
  assert.equal(needsMoatRecovery(stock), true);
});

test('ingest accepts build_full_market payloads that omit ticker and calculationCurrency', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'us-expansion-'));
  const cataloguePath = path.join(root, 'cache', 'us_universe.json');
  const previous = fs.readFileSync(cataloguePath, 'utf8');
  const catalogue = {
    version: 1,
    source: { provider: 'Financial Modeling Prep company/stock screener', retrievedAt: '2026-10-21T00:00:00Z' },
    screen: { exchanges: ['NYSE', 'NASDAQ', 'AMEX'], marketCapMoreThanUsd: 1e10 },
    stocks: [
      { ticker: 'ZZZZ', name_en: 'Zeta Test', exchange: 'NYSE', sector: 'Test', industry: 'Test', marketCap: 12e9,
        universeMembership: 'test' }
    ]
  };
  fs.writeFileSync(cataloguePath, JSON.stringify(catalogue));
  try {
    // Mimic Actions market.json: key is the ticker; fields may be absent.
    const market = {
      ZZZZ: {
        name: 'Zeta Test', exchange: 'NYSE', price: 12, mcap: 12000, f_score: 7, moat: null,
        ratingSources: { moat: { reason: 'analysisUnavailable' } },
        expansion: { capturedAt: '2026-10-21T01:00:00Z' }
      }
    };
    const marketFile = path.join(tmp, 'market.json');
    fs.writeFileSync(marketFile, JSON.stringify(market));
    const manifest = ingest(tmp, marketFile);
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].moat, false);
    packageResults(tmp);
    const coverage = readManifest(tmp).coverage;
    assert.equal(coverage.companies, 1);
    assert.equal(coverage.completeMoats, 0);
    assert.equal(coverage.fScores, 1);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'us-integrate-'));
    const count = integrate(tmp, out);
    assert.equal(count, 1);
    const expansion = JSON.parse(fs.readFileSync(path.join(out, 'us_expansion_data.js'), 'utf8')
      .replace(/^window\.US_EXPANSION = /, '').replace(/;\n$/, ''));
    assert.equal(expansion.stocks.ZZZZ.moat, null);
    assert.equal(expansion.stocks.ZZZZ.expansion.status, 'available');
    assert.throws(() => ingest(tmp, marketFile.replace('market.json', 'missing.json')));
  } finally {
    fs.writeFileSync(cataloguePath, previous);
  }
});

test('browser helper rejects HK tickers for US lazy loads', async () => {
  const context = { US_LISTINGS: { stocks: [] }, fetch: async () => ({ ok: false, status: 404 }) };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'us_universe.js'), 'utf8'), context);
  await assert.rejects(() => context.UsUniverse.load('0700.HK'), /INVALID_US_TICKER/);
});

function readManifest(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
}
