const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const universe = require('../hkex_universe.js');
const catalogue = require('../cache/hkex_universe.json');
const market = require('../hk_market_dcf.json');
const { matrix, build, packageResults, integrate, preferSavedMoat, needsMoatRecovery } = require('../scripts/build_hkex_expansion.cjs');
const { prepareStatements, priceHistory, hash } = require('../scripts/build_hkex.cjs');
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
  assert.deepEqual(matrix(20, '1,3').map(item => item.batch), [1, 3]);
  assert.throws(() => matrix(20, '134'), /Invalid selected/);
  assert.throws(() => matrix(20, '1,,3'), /Invalid selected/);
});
test('targeted recovery preserves original artifact batch identities and selects only requested companies', () => {
  const batches = matrix();
  const first = batches[1].symbols.split(',')[0], second = batches[3].symbols.split(',')[0];
  const expected = [{ batch: 1, symbols: first }, { batch: 3, symbols: second }];
  assert.deepEqual(matrix(20, '', `${first}, ${second}`), expected);
  assert.deepEqual(matrix(20, '1,2,3', `${first},${second}`), expected);
  for (const symbols of [`${first},`, `${first},${first}`, '0005.HK', '99999.HK']) {
    assert.throws(() => matrix(20, '', symbols), /Invalid selected HKEX symbols/);
  }
  assert.throws(() => matrix(20, '1', second), /Invalid selected HKEX symbols/);
  assert.throws(() => matrix(20, '', batches.slice(0, 2).flatMap(item => item.symbols.split(',')).slice(0, 21).join(',')),
    /Invalid selected HKEX symbols/);
});
test('incomplete recovery skips current complete and below-cap reports without treating unknown cap as zero', () => {
  const stock = { ticker: '1911.HK', calculationCurrency: 'HKD', mcap: 1500,
    ratingSources: { moat: { evidenceHash: 'same', currentEvidenceHash: 'same', updatedAt: '2026-10-20T00:00:00Z' } },
    moat: Object.fromEntries(Array.from({ length: 10 }, (_, i) =>
      [`m${i + 1}_test`, { score: 0, comment_zh: 'Evidence-based.', comment_en: 'Evidence-based.' }])) };
  stock.moat.overall_moat_verdict_zh = stock.moat.overall_moat_verdict_en = 'Evidence-based.';
  assert.equal(needsMoatRecovery(stock), false);
  stock.moat.m1_test.score = null;
  assert.equal(needsMoatRecovery(stock), true);
  stock.mcap = 999;
  assert.equal(needsMoatRecovery(stock), false);
  stock.mcap = null;
  assert.equal(needsMoatRecovery(stock), true);
  stock.moat.m1_test.score = 1;
  stock.ratingSources.moat.currentEvidenceHash = 'changed';
  assert.equal(needsMoatRecovery(stock), true);
  assert.equal(needsMoatRecovery(null), true);
});
test('ratings recovery reuses newer verified assessments without inventing update dates or changing evidence', () => {
  const previous = { evidenceHash: 'same', updatedAt: '2026-10-19T00:00:00Z', report: { previous: true } };
  const stock = { moat: { current: true }, ratingSources: { moat: {
    evidenceHash: 'same', currentEvidenceHash: 'same', updatedAt: '2026-10-20T00:00:00Z',
    reason: null, assessmentPolicy: 'saved-policy', businessResearch: { evidenceHash: 'research' }
  } } };
  const saved = JSON.stringify(stock);
  const selected = preferSavedMoat(stock, 'same', previous);
  assert.equal(selected.report, stock.moat);
  assert.equal(selected.updatedAt, stock.ratingSources.moat.updatedAt);
  assert.equal(selected.businessResearch, stock.ratingSources.moat.businessResearch);
  assert.equal(preferSavedMoat(stock, 'changed', previous), previous);
  assert.equal(preferSavedMoat(stock, 'same', { ...previous, updatedAt: '2026-10-21T00:00:00Z' }).report, previous.report);
  assert.equal(JSON.stringify(stock), saved);
  stock.ratingSources.moat.reason = 'staleEvidence';
  assert.equal(preferSavedMoat(stock, 'same', previous), previous);
});
test('official Chinese names enrich both compact listings and lazy full company records', async () => {
  assert.ok(catalogue.stocks.every(stock => typeof stock.name_zh === 'string' && stock.name_zh.length > 0));
  assert.equal(catalogue.chineseNameSource.unmatchedTickers.length, 0);
  assert.equal(catalogue.source.sha256, '43900020cb53d80d3cf90ad67819e7edc9aa9a8cbc2081afe1395531b5db7906');
  const stock = { ticker: '2145.HK', calculationCurrency: 'HKD', name: 'Shanghai Chicmax' };
  const merged = universe.merge(market, catalogue, { stocks: { '2145.HK': stock } });
  assert.equal(merged['2145.HK'].name_zh, '上美股份');
  assert.equal(merged['2145.HK'].name, stock.name);
  assert.equal(stock.name_zh, undefined);
  for (const ticker of Object.keys(market)) assert.equal(merged[ticker], market[ticker]);
  const context = { HKEX_LISTINGS: catalogue,
    fetch: async () => ({ ok: true, json: async () => ({ version: 1, ticker: '2145.HK', stock }) }) };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'hkex_universe.js'), 'utf8'), context);
  assert.equal((await context.HkUniverse.load('2145.HK')).name_zh, '上美股份');
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
test('a changed fiscal closing date cannot invent a zero-length H2 or a duplicate Q4 balance', () => {
  const row = (year, period, date, more = {}) => ({ symbol: '0004.HK', fiscalYear: year, period, date, reportedCurrency: 'HKD', ...more });
  const income = [row(2024, 'Q2', '2023-12-31'), row(2024, 'Q4', '2024-06-30'),
    row(2025, 'Q2', '2024-12-31'), row(2025, 'Q4', '2025-06-30'), row(2026, 'Q2', '2025-12-31')];
  const annual = [row(2024, 'FY', '2024-06-30'), row(2025, 'FY', '2025-06-30'), row(2026, 'FY', '2025-12-31')];
  const statements = prepareStatements({ ticker: '0004.HK', providerSymbol: '0004.HK',
    capturedAt: '2026-10-19T00:00:00Z', responses: {
      income: { ok: true, rows: income }, balance: { ok: true, rows: income },
      annual_income: { ok: true, rows: annual }, annual_balance: { ok: true, rows: annual }
    } }, { allowIncomplete: true });
  assert.equal(statements.annual.income.at(-1).periodLength, 6);
  for (const type of ['income', 'balance']) {
    const rows = statements.quarterly[type];
    assert.equal(rows.filter(row => row.date === '2025-12-31').length, 1);
    assert.equal(rows.find(row => row.date === '2025-12-31').period, 'Q2');
  }
  assert.ok(statements.qualityWarnings.some(row => row.code === 'nonFullFiscalPeriod'));
  assert.ok(statements.qualityWarnings.some(row => row.code === 'annualInterimReconciliation'));
});
test('annual period checks distinguish eleven-month stubs from missing fiscal years', () => {
  const row = (fiscalYear, date) => ({ symbol: '0004.HK', fiscalYear, date, period: 'FY', reportedCurrency: 'HKD' });
  const statements = prepareStatements({ ticker: '0004.HK', providerSymbol: '0004.HK',
    capturedAt: '2026-10-19T00:00:00Z',
    responses: { annual_income: { ok: true, rows: [
      row(2022, '2022-12-31'), row(2024, '2024-12-31'), row(2025, '2025-11-30')
    ] } } }, { allowIncomplete: true });
  assert.equal(statements.annual.income[1].periodLength, 12);
  assert.equal(statements.annual.income[1].periodStartDate, '2024-01-01');
  assert.equal(statements.annual.income[2].periodLength, 11);
});
test('nominal FY and H1 labels alone do not establish a real subsequent H2', () => {
  const row = (fiscalYear, period, date) => ({ symbol: '0004.HK', fiscalYear, period, date, reportedCurrency: 'HKD' });
  const statements = prepareStatements({ ticker: '0004.HK', providerSymbol: '0004.HK',
    capturedAt: '2026-10-19T00:00:00Z',
    responses: {
      income: { ok: true, rows: [row(2024, 'Q2', '2024-06-30'), row(2024, 'Q4', '2024-12-31'),
        row(2025, 'Q2', '2025-12-31'), row(2025, 'Q4', '2026-06-30')] },
      annual_income: { ok: true, rows: [row(2024, 'FY', '2024-12-31'), row(2025, 'FY', '2025-12-31')] }
    } }, { allowIncomplete: true });
  assert.equal(statements.quarterly.income.filter(row => row.date === '2025-12-31').length, 1);
  assert.equal(statements.quarterly.income.find(row => row.date === '2025-12-31').periodLength, null);
  assert.ok(statements.qualityWarnings.some(row => row.code === 'unverifiedProviderPeriod'));
  assert.ok(statements.quarterly.income.some(row => row.period === 'Q4' && row.date === '2024-12-31'
    && row.periodLength === 6 && row.derivation === 'annualMinusReportedH1'));
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
    fs.mkdirSync(path.join(output, 'cache', 'fx'), { recursive: true });
    const captured = structuredClone(require('../cache/fx/hkd_rates.json'));
    captured.currencies.HKD.observations = [['2025-12-31', 0.1]];
    fs.writeFileSync(path.join(output, 'cache', 'fx', 'hkd_rates.json'), JSON.stringify(captured));
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
    const input = JSON.parse(fs.readFileSync(path.join(output, 'moat-inputs.json'), 'utf8'))[0];
    const { evidenceHash, existing, businessResearch, moatScreen, ...financialEvidence } = input;
    assert.deepEqual(moatScreen, { calculationCurrency: 'HKD', marketCapMillions: null });
    assert.equal(evidenceHash, hash(financialEvidence), 'Eligibility metadata cannot invalidate genuine financial evidence');
    fs.writeFileSync(path.join(output, 'fmp_model_data.js'), 'window.FMP_MODEL_DATA = ' + JSON.stringify({
      stocks: { [other]: { symbol: other, currencyCheck: { reason: null, sourceDate: '2025-12-31', sourcePeriodLength: 12 },
        models: { advanced: { data: [{ symbol: other }] } } } }
    }) + ';');
    fs.mkdirSync(path.join(output, 'cache', 'company'));
    fs.writeFileSync(path.join(output, 'cache', 'company', `${other}.json`), JSON.stringify({
      symbol: other, currencyCheck: { reason: null, sourceDate: '2025-12-31' }
    }));
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
    assert.deepEqual(capturedRates, captured);
    const converted = require('../usd_currency.js').convertStatements(foreign, capturedRates);
    assert.equal(converted.annual.balance[0].totalAssets, 1000);
    const native = JSON.parse(fs.readFileSync(path.join(integrated, 'cache', 'hk_companies', `${other}.json`)));
    assert.equal(native.model.currencyCheck.reason, 'FMP_MODEL_CURRENCY_UNVERIFIED');
    const nativeDetails = JSON.parse(fs.readFileSync(path.join(integrated, 'cache', 'company', `${other}.json`)));
    assert.equal(nativeDetails.currencyCheck.reason, 'FMP_MODEL_CURRENCY_UNVERIFIED');
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
test('non-HKD listing prices cannot become a falsely HKD-labelled historical chart', () => {
  for (const ticker of ['0770.HK', '87001.HK']) {
    assert.throws(() => priceHistory({ ticker, capturedAt: '2026-10-19T00:00:00Z',
      responses: { prices_recent: { ok: true, rows: [
        { symbol: ticker, date: '2026-10-16', close: 1.23, volume: 100 }
      ] } } }), /unsupportedTradingCurrency/);
  }
});
