const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const universe = require('../hkex_universe.js');
const catalogue = require('../cache/hkex_universe.json');
const market = require('../hk_market_dcf.json');
const { matrix, build, packageResults, integrate } = require('../scripts/build_hkex_expansion.cjs');
const { prepareStatements } = require('../scripts/build_hkex.cjs');
const root = path.resolve(__dirname, '..');
test('official full-market namespace retains every reviewed company without inventing financials', () => {
  assert.equal(catalogue.stocks.length, 2787);
  assert.equal(new Set(catalogue.stocks.map(item => item.ticker)).size, catalogue.stocks.length);
  const merged = universe.merge(market, catalogue);
  for (const ticker of Object.keys(market)) assert.equal(merged[ticker], market[ticker]);
  assert.equal(Object.keys(merged).length, 2787);
  for (const item of catalogue.stocks.filter(item => !market[item.ticker])) {
    const stock = merged[item.ticker];
    for (const field of ['price', 'mcap', 'shares', 'fcf0', 'fair_val', 'f_score', 'moat']) assert.equal(stock[field], null);
    assert.equal(stock.expansion.status, 'pendingCapture');
    assert.equal(stock.fin_valuation.is_financial, false);
  }
  assert.ok(catalogue.stocks.some(item => item.ticker === '87001.HK' && item.tradingCurrency === 'RMB'));
  assert.equal(catalogue.additionalCounters.length, 24);
});
test('bounded matrix covers every additional listing exactly once and never overwrites the reviewed set', () => {
  const batches = matrix(), symbols = batches.flatMap(item => item.symbols.split(','));
  assert.equal(symbols.length, catalogue.stocks.length - Object.keys(market).length);
  assert.equal(new Set(symbols).size, symbols.length);
  assert.ok(batches.every(item => item.symbols.split(',').length <= 20));
  assert.ok(symbols.every(ticker => !market[ticker]));
  assert.throws(() => matrix(21), /1-20/);
});
test('a short Q2/Q4-only new-company history does not acquire fabricated three-month durations', () => {
  const statements = prepareStatements({
    ticker: '0004.HK', providerSymbol: '0004.HK', capturedAt: '2026-10-19T00:00:00Z',
    responses: { income: { ok: true, rows: [
      { symbol: '0004.HK', date: '2025-06-30', period: 'Q2', fiscalYear: 2025, reportedCurrency: 'HKD' },
      { symbol: '0004.HK', date: '2025-12-31', period: 'Q4', fiscalYear: 2025, reportedCurrency: 'HKD' }
    ] } }
  }, { allowIncomplete: true });
  assert.ok(statements.quarterly.income.every(row => row.periodLength === null));
  assert.ok(statements.qualityWarnings.some(row => row.code === 'unverifiedProviderPeriod'));
});
test('lazy company loading rejects mismatched identities and supports retry without leaking models', async () => {
  let calls = 0;
  const context = { fetch: async () => ({ ok: true, json: async () => ++calls === 1
    ? { version: 1, ticker: '0005.HK', stock: { ticker: '0005.HK', calculationCurrency: 'HKD' } }
    : { version: 1, ticker: '0004.HK', stock: { ticker: '0004.HK', calculationCurrency: 'HKD' } } }) };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'hkex_universe.js'), 'utf8'), context);
  await assert.rejects(context.HkUniverse.load('0004.HK'), /INVALID_HK_COMPANY/);
  assert.equal((await context.HkUniverse.load('0004.HK')).ticker, '0004.HK');
  await assert.rejects(context.HkUniverse.load('../0004.HK'), /INVALID_HK_TICKER/);
});
test('partial provider evidence persists real missingness, and artifact integration protects reviewed companies', () => {
  fs.mkdirSync(path.join(root, 'valuation-audit-output'), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(root, 'valuation-audit-output', 'expansion-test-'));
  try {
    const sources = path.join(temporary, 'sources'), output = path.join(temporary, 'built'), integrated = path.join(temporary, 'integrated');
    fs.mkdirSync(sources);
    fs.writeFileSync(path.join(sources, '0004.HK.json'), JSON.stringify({
      ticker: '0004.HK', providerSymbol: '0004.HK', capturedAt: '2026-10-19T00:00:00Z', responses: {}
    }));
    const other = matrix()[0].symbols.split(',').find(ticker => ticker !== '0004.HK');
    fs.writeFileSync(path.join(sources, `${other}.json`), JSON.stringify({
      ticker: other, providerSymbol: other, capturedAt: '2026-10-19T00:00:00Z',
      responses: {
        annual_income: { ok: true, rows: [
          { symbol: '0004.HK', date: '2025-12-31', fiscalYear: 2025, period: 'FY', reportedCurrency: 'USD' }
        ] },
        annual_balance: { ok: true, rows: [
          { symbol: other, date: '2025-12-31', fiscalYear: 2025, period: 'FY', reportedCurrency: 'USD',
            totalAssets: 100, totalStockholdersEquity: 80 }
        ] }
      }
    }));
    const result = build(sources, output, ['0004.HK', other]);
    assert.equal(result[0].status, 'available');
    assert.equal(result[0].fScore, null);
    assert.equal(result[0].moat, false);
    packageResults(output);
    assert.equal(integrate(output, integrated), 2);
    const full = JSON.parse(fs.readFileSync(path.join(integrated, 'cache', 'hk_companies', '0004.HK.json')));
    assert.equal(full.stock.price, null);
    assert.equal(full.stock.moat, null);
    const financials = JSON.parse(fs.readFileSync(path.join(integrated, 'cache', 'financials', '0004.HK_statements_v2.json')));
    assert.deepEqual(financials.annual.income, []);
    const foreign = JSON.parse(fs.readFileSync(path.join(integrated, 'cache', 'financials', `${other}_statements_v2.json`)));
    assert.deepEqual(foreign.annual.income, []);
    assert.equal(foreign.annual.balance[0].totalAssets, 100);
    assert.ok(foreign.qualityWarnings.some(row => row.code === 'providerStatementInvalid' && row.endpoint === 'annual_income'));
    const capturedRates = JSON.parse(fs.readFileSync(path.join(integrated, foreign.hkdFxSource.path)));
    const converted = require('../usd_currency.js').convertStatements(foreign, capturedRates);
    assert.ok(converted.annual.balance[0].totalAssets > 700);
    assert.throws(() => build(sources, output, ['0005.HK']), /may not overwrite/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
test('captured HKD FX paths cannot select arbitrary resources or silently fall back to base rates', () => {
  const currency = require('../usd_currency.js');
  assert.throws(() => currency.loadRates(false, 'HKD', { path: '../secrets.json', sha256: 'a'.repeat(64) }), /Invalid captured HKD FX/);
  assert.throws(() => currency.loadRates(false, 'USD', {
    path: `cache/fx/hk_expansion_${'a'.repeat(64)}.json`, sha256: 'a'.repeat(64)
  }), /Invalid captured HKD FX/);
});
