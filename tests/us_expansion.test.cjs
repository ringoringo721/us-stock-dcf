const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const universe = require('../us_universe.js');
const {
  needsMoatRecovery, ingest, packageResults, integrate, writeMoatCaches, applyBatchWindow,
  usMoatEvidenceHash, roundFin
} = require('../scripts/build_us_expansion.cjs');
const root = path.resolve(__dirname, '..');

test('US listings merge keeps the reviewed baseline and marks uncaptured names pending', () => {
  const market = { AAPL: { ticker: 'AAPL', calculationCurrency: 'USD', price: 100, moat: { m1_brand_pricing: { score: 9 } } } };
  const catalogue = {
    stocks: [
      { ticker: 'AAPL', name: 'Apple', name_en: 'Apple', exchange: 'NASDAQ', sector: 'Technology', industry: 'Hardware', marketCap: 3e12 },
      { ticker: 'NEWCO', name: 'New Co', name_en: 'New Co', exchange: 'NYSE', sector: 'Industrials', industry: 'Machinery', marketCap: 3e9,
        universeMembership: 'FMP US equity screener (NYSE/NASDAQ/AMEX, marketCap > USD 5B)' }
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

test('shipped US universe+expansion merge is baseline+catalogue (not market_data alone)', () => {
  const context = { window: {}, console };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'us_universe_data.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(root, 'us_expansion_data.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(root, 'market_data.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(root, 'us_universe.js'), 'utf8'), context);
  const baseline = Object.keys(context.FULL_MARKET_DATA).length;
  const expansion = Object.keys(context.US_EXPANSION.stocks).length;
  const merged = context.UsUniverse.merge(context.FULL_MARKET_DATA, context.US_LISTINGS, context.US_EXPANSION);
  const keys = Object.keys(merged);
  assert.equal(baseline, 228);
  // Expansion catalogue grows with financial refresh; AEFC stays excluded.
  // Live screen is FMP common equity marketCap > USD 5B (AMRO/ITRI/IRDM dropped);
  // dual-class / inactive commons (FOXA…) are retained when the screener omits them.
  assert.equal(expansion, 715);
  assert.equal(context.US_LISTINGS.stocks.length, 1350);
  assert.equal(keys.length, 1355);
  assert.ok(keys.length > baseline, 'frontpage must not stay on sync market_data.js alone');
  let expansionWithMoat = 0;
  const expansionWithoutMoat = [];
  for (const ticker of Object.keys(context.US_EXPANSION.stocks)) {
    if (context.FULL_MARKET_DATA[ticker]) continue;
    if (merged[ticker]?.moat) expansionWithMoat++;
    else expansionWithoutMoat.push(ticker);
  }
  // Complete assessments (incl. archived staleEvidence) keep screener scores; only
  // analysisUnavailable capture stubs stay moat-null (DCF-1 backlog — not remoated here).
  assert.equal(expansionWithMoat, 702);
  assert.equal(expansionWithoutMoat.length, 13);
  assert.ok(expansionWithoutMoat.every(ticker =>
    context.US_EXPANSION.stocks[ticker]?.ratingSources?.moat?.reason === 'analysisUnavailable'));
  assert.ok(context.US_EXPANSION.stocks.BABA?.moat?.m1_brand_pricing?.score === 7);
  assert.equal(context.US_EXPANSION.stocks.BABA.ratingSources.moat.reason, 'staleEvidence');
  assert.equal(context.US_EXPANSION.stocks.AEFC, undefined);
  assert.equal(merged.AEFC, undefined);
});

test('financial refresh batch window is gated and rotates', () => {
  const batches = Array.from({ length: 4 }, (_, batch) => ({ batch, symbols: `T${batch}` }));
  delete process.env.EXPANSION_FINANCIAL_REFRESH;
  assert.equal(applyBatchWindow(batches, '1', '2').length, 4);
  process.env.EXPANSION_FINANCIAL_REFRESH = '1';
  assert.deepEqual(applyBatchWindow(batches, '2', '2').map(item => item.batch), [2, 3]);
  delete process.env.EXPANSION_FINANCIAL_REFRESH;
});

test('usMoatEvidenceHash matches Python us_moat_evidence_hash domain (not statement SHA)', () => {
  const fin = {
    name: 'Zeta Test', sector: 'Test', industry: 'Widgets',
    roe: 12.345, roa: 4.567, f_score: 7, fcf0: 100.4, debt: 50.2, cash: 20.6, mcap: 999
  };
  const a = usMoatEvidenceHash(fin);
  const b = usMoatEvidenceHash({ ...fin, mcap: 1 });
  assert.equal(a, b);
  assert.notEqual(a, usMoatEvidenceHash({ ...fin, f_score: 6 }));
  assert.match(a, /^[a-f0-9]{64}$/);
});

test('roundFin matches Python 3 banker’s rounding (not Math.round half-up)', () => {
  // Exact halfway ties (digits=0) — Math.round diverges.
  assert.equal(roundFin(0.5, 0), 0);
  assert.equal(roundFin(1.5, 0), 2);
  assert.equal(roundFin(2.5, 0), 2); // Math.round(2.5) === 3
  assert.equal(roundFin(3.5, 0), 4);
  assert.equal(roundFin(100.5, 0), 100); // Math.round(100.5) === 101
  assert.equal(roundFin(101.5, 0), 102);
  assert.equal(roundFin(-1.5, 0), -2);
  assert.equal(roundFin(-2.5, 0), -2);
  // Float dtoa / Decimal.from_float quantize parity (not naive scale-half-even).
  assert.equal(roundFin(12.345, 2), 12.35);
  assert.equal(roundFin(12.355, 2), 12.36);
  assert.equal(roundFin(4.565, 2), 4.57);
  assert.equal(roundFin(null, 0), null);
  assert.notEqual(roundFin(2.5, 0), Math.round(2.5));
  // Half-up would flip fcf0 100.5 → 101 and desync the hash vs build_full_market.
  const base = {
    name: 'Tie', sector: 'S', industry: 'I', roe: 1, roa: 1, f_score: 1,
    fcf0: 100.5, debt: 2.5, cash: 0.5
  };
  assert.match(usMoatEvidenceHash(base), /^[a-f0-9]{64}$/);
});

test('ingest preserves saved moat; staleEvidence uses moat evidenceHash not statement SHA', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'us-expansion-stale-'));
  const cataloguePath = path.join(root, 'cache', 'us_universe.json');
  const previous = fs.readFileSync(cataloguePath, 'utf8');
  const companiesDir = path.join(root, 'cache', 'us_companies');
  const savedPath = path.join(companiesDir, 'ZZZZ.json');
  const hadSaved = fs.existsSync(savedPath);
  const previousSaved = hadSaved ? fs.readFileSync(savedPath, 'utf8') : null;
  const zh = '繁體護城河評分註解用以通過字數門檻測試用字串補滿到足夠長度並確認回收邏輯。'.repeat(4);
  const fin = {
    name: 'Zeta Test', sector: 'Test', industry: 'Widgets',
    roe: 10, roa: 5, f_score: 7, fcf0: 100, debt: 50, cash: 20
  };
  const currentHash = usMoatEvidenceHash(fin);
  const moat = Object.fromEntries(Array.from({ length: 10 }, (_, i) =>
    [`m${i + 1}_test`, { score: 8, comment_zh: zh, comment_en: 'ok' }]));
  moat.overall_moat_verdict_zh = zh;
  moat.overall_moat_verdict_en = 'ok';
  moat.evidenceHash = 'old-moat-hash';
  const catalogue = {
    version: 1,
    source: { provider: 'Financial Modeling Prep company/stock screener', retrievedAt: '2026-10-21T00:00:00Z' },
    screen: { exchanges: ['NYSE', 'NASDAQ', 'AMEX'], marketCapMoreThanUsd: 5e9 },
    stocks: [
      { ticker: 'ZZZZ', name_en: 'Zeta Test', exchange: 'NYSE', sector: 'Test', industry: 'Widgets', marketCap: 12e9,
        universeMembership: 'test' }
    ]
  };
  fs.writeFileSync(cataloguePath, JSON.stringify(catalogue));
  fs.mkdirSync(companiesDir, { recursive: true });
  fs.writeFileSync(savedPath, JSON.stringify({
    version: 1, ticker: 'ZZZZ',
    stock: {
      ticker: 'ZZZZ', moat,
      ratingSources: {
        moat: {
          evidenceHash: 'old-moat-hash', currentEvidenceHash: 'old-moat-hash',
          reason: null, updatedAt: '2026-10-20T00:00:00Z'
        }
      }
    }
  }));
  const finDir = path.join(root, 'cache', 'financials');
  const finPath = path.join(finDir, 'ZZZZ_statements_v2.json');
  const hadFin = fs.existsSync(finPath);
  const previousFin = hadFin ? fs.readFileSync(finPath, 'utf8') : null;
  fs.mkdirSync(finDir, { recursive: true });
  // Statement content differs wildly; stale labeling must NOT key off this SHA.
  fs.writeFileSync(finPath, JSON.stringify({
    annual: { income: [{ date: '2025-12-31' }], balance: [], cashflow: [] },
    quarterly: { income: [{ date: '2026-06-30' }], balance: [], cashflow: [] }
  }));
  try {
    // Keep input market.json separate from ingest output (ingest rewrites output/market.json).
    const out = path.join(tmp, 'out');
    const marketFile = path.join(tmp, 'input-market.json');
    const payload = {
      ZZZZ: {
        ...fin, exchange: 'NYSE', price: 12, mcap: 12000, moat: null,
        ratingSources: { moat: { reason: 'analysisUnavailable' } },
        expansion: { capturedAt: '2026-11-02T00:00:00Z' }
      }
    };
    fs.writeFileSync(marketFile, JSON.stringify(payload));
    ingest(out, marketFile);
    const record = JSON.parse(fs.readFileSync(path.join(out, 'cache', 'us_companies', 'ZZZZ.json'), 'utf8'));
    assert.ok(record.stock.moat);
    assert.equal(record.stock.ratingSources.moat.reason, 'staleEvidence');
    assert.equal(record.stock.ratingSources.moat.evidenceHash, 'old-moat-hash');
    assert.equal(record.stock.ratingSources.moat.currentEvidenceHash, currentHash);
    assert.notEqual(record.stock.ratingSources.moat.currentEvidenceHash, 'old-moat-hash');

    // Matching moat evidenceHash → not stale (even if statements file changed).
    moat.evidenceHash = currentHash;
    fs.writeFileSync(savedPath, JSON.stringify({
      version: 1, ticker: 'ZZZZ',
      stock: {
        ticker: 'ZZZZ', moat,
        ratingSources: {
          moat: {
            evidenceHash: currentHash, currentEvidenceHash: currentHash,
            reason: null, updatedAt: '2026-10-20T00:00:00Z'
          }
        }
      }
    }));
    ingest(out, marketFile);
    const fresh = JSON.parse(fs.readFileSync(path.join(out, 'cache', 'us_companies', 'ZZZZ.json'), 'utf8'));
    assert.equal(fresh.stock.ratingSources.moat.reason, null);
    assert.equal(fresh.stock.ratingSources.moat.evidenceHash, currentHash);
  } finally {
    fs.writeFileSync(cataloguePath, previous);
    if (hadSaved) fs.writeFileSync(savedPath, previousSaved);
    else fs.rmSync(savedPath, { force: true });
    if (hadFin) fs.writeFileSync(finPath, previousFin);
    else fs.rmSync(finPath, { force: true });
  }
});

test('incomplete US moat recovery refuses invented or partial scores', () => {
  assert.equal(needsMoatRecovery(null), true);
  assert.equal(needsMoatRecovery({ ratingSources: { moat: { reason: 'analysisUnavailable' } } }), true);
  const zh = '繁體護城河評分註解用以通過字數門檻測試用字串補滿到足夠長度並確認回收邏輯。'.repeat(4);
  const stock = {
    ratingSources: {
      moat: {
        evidenceHash: 'same',
        currentEvidenceHash: 'same',
        updatedAt: '2026-10-20T00:00:00Z',
        assessmentPolicy: 'buffett-moat-v3'
      }
    },
    moat: Object.fromEntries(Array.from({ length: 10 }, (_, i) =>
      [`m${i + 1}_test`, { score: 8, comment_zh: zh, comment_en: 'Evidence-based Traditional Chinese comment.' }]))
  };
  stock.moat.assessmentPolicy = 'buffett-moat-v3';
  stock.moat.overall_moat_verdict_zh = zh;
  stock.moat.overall_moat_verdict_en = 'Evidence-based.';
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
    screen: { exchanges: ['NYSE', 'NASDAQ', 'AMEX'], marketCapMoreThanUsd: 5e9 },
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

test('ingest records skipped tickers as unavailable without aborting available peers', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'us-expansion-skip-'));
  const cataloguePath = path.join(root, 'cache', 'us_universe.json');
  const previous = fs.readFileSync(cataloguePath, 'utf8');
  const catalogue = {
    version: 1,
    source: { provider: 'Financial Modeling Prep company/stock screener', retrievedAt: '2026-10-21T00:00:00Z' },
    screen: { exchanges: ['NYSE', 'NASDAQ', 'AMEX'], marketCapMoreThanUsd: 5e9 },
    stocks: [
      { ticker: 'GOOD', name_en: 'Good Co', exchange: 'NYSE', sector: 'Test', industry: 'Test', marketCap: 12e9,
        universeMembership: 'test' },
      { ticker: 'AEFC', name_en: 'Preferred Stub', exchange: 'NYSE', sector: 'Test', industry: 'Test', marketCap: 12e9,
        universeMembership: 'test' }
    ]
  };
  fs.writeFileSync(cataloguePath, JSON.stringify(catalogue));
  try {
    const marketFile = path.join(tmp, 'market.json');
    fs.writeFileSync(marketFile, JSON.stringify({
      GOOD: {
        name: 'Good Co', exchange: 'NYSE', price: 10, mcap: 10000, f_score: 6, moat: null,
        ratingSources: { moat: { reason: 'analysisUnavailable' } },
        expansion: { capturedAt: '2026-10-22T00:00:00Z' }
      }
    }));
    fs.writeFileSync(path.join(tmp, 'skipped.json'), JSON.stringify({
      version: 1,
      stocks: [{ ticker: 'AEFC', reason: 'verifiedOutstandingSharesUnavailable' }]
    }));
    const manifest = ingest(tmp, marketFile);
    assert.equal(manifest.length, 2);
    assert.equal(manifest.find(item => item.ticker === 'GOOD').status, 'available');
    assert.equal(manifest.find(item => item.ticker === 'AEFC').status, 'unavailable');
    assert.equal(manifest.find(item => item.ticker === 'AEFC').reason, 'verifiedOutstandingSharesUnavailable');
    assert.ok(fs.existsSync(path.join(tmp, 'cache', 'us_companies', 'GOOD.json')));
    assert.equal(fs.existsSync(path.join(tmp, 'cache', 'us_companies', 'AEFC.json')), false);
    packageResults(tmp);
    const coverage = readManifest(tmp).coverage;
    assert.equal(coverage.available, 1);
    assert.equal(coverage.unavailable, 1);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'us-integrate-skip-'));
    integrate(tmp, out);
    const expansion = JSON.parse(fs.readFileSync(path.join(out, 'us_expansion_data.js'), 'utf8')
      .replace(/^window\.US_EXPANSION = /, '').replace(/;\n$/, ''));
    assert.equal(expansion.stocks.GOOD.expansion.status, 'available');
    assert.equal(expansion.stocks.AEFC.expansion.status, 'unavailable');
    assert.equal(expansion.stocks.AEFC.expansion.reason, 'verifiedOutstandingSharesUnavailable');
  } finally {
    fs.writeFileSync(cataloguePath, previous);
  }
});

test('writeMoatCaches materializes period-stamped cache/moat JSON from company records', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'us-moat-cache-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'us-moat-out-'));
  const dim = (score) => ({
    score,
    comment_zh: '測'.repeat(120),
    comment_en: 'x'.repeat(40)
  });
  const moat = {
    ticker: 'ZZZZ',
    period: '2026Q2',
    assessmentPolicy: 'buffett-moat-v3',
    model: 'gemini-2.5-flash-lite',
    m1_brand_pricing: dim(5),
    m2_patents_regulatory: dim(5),
    m3_high_switching_costs: dim(5),
    m4_network_effects: dim(5),
    m5_cost_advantage_scale: dim(5),
    m6_unique_geography_assets: dim(5),
    m7_operational_efficiency: dim(5),
    m8_capital_allocation: dim(5),
    m9_customer_retention: dim(5),
    m10_durability: dim(5),
    overall_moat_verdict_zh: '護'.repeat(40),
    overall_moat_verdict_en: 'verdict'
  };
  fs.mkdirSync(path.join(tmp, 'cache', 'us_companies'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'cache', 'us_companies', 'ZZZZ.json'), JSON.stringify({
    version: 1,
    ticker: 'ZZZZ',
    stock: {
      ticker: 'ZZZZ',
      calculationCurrency: 'USD',
      moat,
      ratingSources: { moat: { reason: null, assessmentPolicy: 'buffett-moat-v3' } }
    },
    snapshot: null
  }));
  const written = writeMoatCaches(tmp, out);
  assert.deepEqual(written, ['cache/moat/ZZZZ_2026Q2.json']);
  const cached = JSON.parse(fs.readFileSync(path.join(out, 'cache', 'moat', 'ZZZZ_2026Q2.json'), 'utf8'));
  assert.equal(cached.assessmentPolicy, 'buffett-moat-v3');
  assert.equal(cached.m1_brand_pricing.score, 5);
  assert.equal(cached.m1_brand_pricing.comment_zh.length, 120);
});

test('browser helper rejects HK tickers for US lazy loads', async () => {
  const context = { US_LISTINGS: { stocks: [] }, fetch: async () => ({ ok: false, status: 404 }) };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'us_universe.js'), 'utf8'), context);
  await assert.rejects(() => context.UsUniverse.load('0700.HK'), /INVALID_US_TICKER/);
});

function readManifest(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
}
