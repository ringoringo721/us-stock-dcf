const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const Models = require('../fmp_models.js');
const market = { ...require('../full_market_dcf.json'), ...require('../hk_market_dcf.json') };
const context = { window: {} };
vm.runInNewContext(fs.readFileSync('fmp_model_data.js', 'utf8'), context);
const records = JSON.parse(JSON.stringify(context.window.FMP_MODEL_DATA.stocks));

test('Every model is an actual matched FMP record and site prices use issued common shares, not diluted counts', () => {
  const outcomes = {};
  for (const [ticker, stock] of Object.entries(market)) {
    const data = records[ticker];
    assert.equal(data.symbol, ticker);
    assert.equal(data.currency, stock.calculationCurrency || 'USD');
    if (stock.fin_valuation?.is_financial) continue;
    for (const kind of ['advanced', 'customLevered']) {
      const result = Models.value(data, kind, { ...stock, ticker });
      outcomes[result.reason || 'available'] = (outcomes[result.reason || 'available'] || 0) + 1;
      if (result.reason) { assert.equal(result.fairVal, null); continue; }
      assert.equal(result.fairVal, result.row.equityValue / Models.issuedShares(stock));
      assert.equal(result.providerShares, result.row.dilutedSharesOutstanding);
      assert.equal(result.WACC, result.row.wacc / 100);
      assert.equal(result.g, result.row.longTermGrowthRate);
      assert.ok(Math.abs(result.row.enterpriseValue - result.row.netDebt - result.row.equityValue) <= 2);
      const detailed = JSON.parse(fs.readFileSync(`cache\\company\\${ticker}.json`, 'utf8'));
      assert.ok(detailed.models[kind].data.length >= data.models[kind].data.length);
    }
  }
  console.log('FMP Custom coverage:', JSON.stringify(outcomes));
});

test('Issued-share validation tolerates only binary conversion noise, not fractional or missing shares', () => {
  const stock = { ...market.AAPL, ticker: 'AAPL' };
  for (const shares of [1067839506.9999999, 1033862000.0000001, 16325399.999999998]) {
    assert.equal(Models.issuedShares({ ...stock, shares_outstanding: shares }), Math.round(shares));
  }
  for (const shares of [1000.1, 1000.0001, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(Models.issuedShares({ ...stock, shares_outstanding: shares }), null);
  }
  assert.equal(Models.issuedShares({ ...stock, shareSource: null }), null);
  assert.equal(Models.issuedShares({ ...stock, shareSource: { reason: 'unverified' } }), null);
});

test('Price comparisons match the saved-target market premium, rejecting nonpositive valuations', () => {
  assert.equal(Models.priceDifference(120, 100), (100 / 120 - 1) * 100);
  assert.equal(Models.priceDifference(80, 100), 25);
  assert.equal(Models.priceDifference(100, 100), 0);
  assert.equal(Models.priceDifference(0, 100), null);
  assert.equal(Models.priceDifference(-20, 100), null);
  assert.equal(Models.priceDifference(Number.MIN_VALUE, 100), null);
  for (const invalid of [null, undefined, NaN, Infinity, '100']) {
    assert.equal(Models.priceDifference(invalid, 100), null);
    assert.equal(Models.priceDifference(100, invalid), null);
  }
  assert.equal(Models.priceDifference(100, 0), null);
  assert.equal(Models.priceDifference(100, -100), null);
});

test('Vendor direct DCF references remain unmodified, separate from the issued-share custom valuation', () => {
  for (const [ticker, data] of Object.entries(records)) {
    for (const kind of ['dcf', 'levered']) {
      const row = data.models[kind]?.data[0];
      assert.equal(Models.reference(data, kind), row?.dcf ?? null, `${ticker}/${kind}`);
    }
  }
  const data = records.AAPL;
  const site = Models.value(data, 'advanced', { ...market.AAPL, ticker: 'AAPL' });
  assert.notEqual(site.fairVal, site.providerFairValue);
});

test('Bank, insurer and segment-required DCF references are inapplicable without hiding financial-sector fair values', () => {
  for (const [ticker, stock] of Object.entries(market)) {
    const applicable = stock.fin_valuation?.is_financial !== true
      && stock.corporateDcfApplicability !== 'requiresSegmentValuation';
    assert.equal(Models.dcfApplicable(stock), applicable, ticker);
    for (const kind of ['dcf', 'levered']) {
      assert.equal(Models.reference(records[ticker], kind, stock),
        applicable ? Models.reference(records[ticker], kind) : null, `${ticker}/${kind}`);
    }
  }
  for (const ticker of ['0005.HK', '0939.HK', 'JPM', 'MS', 'PGR', 'MET', '0487.HK', '8279.HK']) assert.equal(Models.dcfApplicable(market[ticker]), false);
  for (const ticker of ['0388.HK', 'BLK', 'AON', 'AJG', 'MMC']) assert.equal(Models.dcfApplicable(market[ticker]), true);
});

test('Source identity, currency, issued shares and terminal-spread failures never produce synthetic values', () => {
  const stock = { ...market.AAPL, ticker: 'AAPL' }, data = records.AAPL;
  assert.equal(Models.value(data, 'advanced', { ...stock, ticker: 'NVDA' }).fairVal, null);
  assert.equal(Models.value({ ...data, currency: 'HKD' }, 'advanced', stock).fairVal, null);
  assert.equal(Models.value(data, 'advanced', { ...stock, shares_outstanding: null }).fairVal, null);
  const invalid = structuredClone(data);
  invalid.models.advanced.data[0].wacc = invalid.models.advanced.data[0].longTermGrowthRate;
  assert.equal(Models.value(invalid, 'advanced', stock).reason, 'FMP_INVALID_TERMINAL_SPREAD');
  invalid.currencyCheck.reason = 'FMP_MODEL_CURRENCY_UNVERIFIED';
  assert.equal(Models.value(invalid, 'advanced', stock).reason, 'FMP_MODEL_CURRENCY_UNVERIFIED');
});

test('Intrinsic confidence uses existing completeness signals without inventing coverage', () => {
  const stock = { ...market.AAPL, ticker: 'AAPL' };
  const available = Models.value(records.AAPL, 'advanced', stock);
  assert.equal(Models.valuationConfidence({ stock, result: available }).level, 'high');
  assert.match(Models.confidenceText(Models.valuationConfidence({ stock, result: available }), 'zh'), /信心.*高/);
  assert.match(Models.confidenceText(Models.valuationConfidence({ stock, result: available }), 'en'), /confidence: High/i);

  assert.equal(Models.valuationConfidence({
    stock: { ...market.JPM, ticker: 'JPM' }, result: { fairVal: 100 }
  }).level, 'unavailable');
  assert.deepEqual(Models.valuationConfidence({
    stock: { ...market.JPM, ticker: 'JPM' }, result: { fairVal: 100 }
  }).reasons, ['FINANCIAL_INSTITUTION']);

  const segment = Object.entries(market).find(([, row]) => row.corporateDcfApplicability === 'requiresSegmentValuation');
  assert.ok(segment, 'fixture includes a segment-required name');
  assert.equal(Models.valuationConfidence({
    stock: { ...segment[1], ticker: segment[0] }, result: { fairVal: null, reason: 'FMP_SEGMENT_VALUATION_REQUIRED' }
  }).level, 'unavailable');

  assert.equal(Models.valuationConfidence({
    stock: { ...stock, shares_outstanding: null, shareSource: { reason: 'unverified' } },
    result: { fairVal: null, reason: 'FMP_ISSUED_SHARES_UNAVAILABLE' }
  }).reasons[0], 'SHARE_BASIS');

  assert.equal(Models.valuationConfidence({
    stock, result: { fairVal: null, reason: 'FMP_INVALID_TERMINAL_SPREAD' }
  }).reasons[0], 'TERMINAL_SPREAD');

  assert.equal(Models.valuationConfidence({
    stock, result: { fairVal: null, reason: 'SCENARIO_INCOMPLETE_ASSUMPTIONS' },
    mode: 'ten-year', scenario: { terminalGrowth: null, years: [] }
  }).level, 'low');

  assert.equal(Models.valuationConfidence({
    stock, result: available, mode: 'ten-year', statementsMissing: true
  }).level, 'low');

  const corrected = Models.valuationConfidence({
    stock: { ...stock, revenueProvenance: { symbol: 'AAPL' } }, result: available
  });
  assert.equal(corrected.level, 'medium');
});

test('Detail and ten-year UI expose confidence and dual-terminal hooks', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  const models = fs.readFileSync('fmp_models.js', 'utf8');
  assert.match(html, /id="det-res-confidence"/);
  assert.match(models, /id="fmp-exit-multiple"/);
  assert.match(models, /id="fmp-dual-terminal"/);
  assert.match(models, /function valuationConfidence/);
  assert.match(models, /EXIT_MULTIPLE_UNAVAILABLE/);
  assert.match(models, /id="fmp-terminal-growth-ref"/);
  assert.match(models, /id="fmp-peer-multiples"/);
  assert.match(models, /id="fmp-fy-history"/);
  assert.doesNotMatch(models, /id="fmp-fy-history-chart"/);
  assert.match(models, /id="fmp-growth-default-note"/);
  assert.match(models, /id="fmp-capital-provenance"/);
  assert.match(models, /id="fmp-rf-tenor"/);
  assert.match(models, /id="fmp-rf-tenor-control"/);
  assert.match(models, /data-scenario-field="\$\{key\}"/);
  assert.match(models, /key === 'rf'/);
  assert.match(models, /rfTenorControlHtml/);
  assert.match(models, /id="fmp-beta-provenance"/);
  assert.match(models, /id="fmp-snapshot-net-debt-meta"/);
  assert.match(models, /five-year-effective-tax/);
  assert.match(models, /港股採用美元公債／美股無風險利率概念（聯繫匯率代理），非港元曲線/);
  assert.match(models, /HK stocks use the USD Treasury \/ US-stock risk-free concept/);
  // Tenor chooser must stay in the rf table row (not only above the history panel).
  assert.match(models, /無風險利率 \(\%\)」列左側/);
  assert.doesNotMatch(models, /fin-model-grid"><div class="form-group">\s*<label for="fmp-rf-tenor"/);
});

test('HK Advanced rf tenor source defaults to USD Treasury curve, not HKD', () => {
  globalThis.HK_FCFF_DATA = { stocks: {
    '0700.HK': { provenance: {
      treasury: { date: '2026-10-16', year10: 5.09, year5: 4.2, currency: 'USD' },
      riskFreeRate: 'User-directed USD Treasury proxy under the HKD/USD peg; not an observed HKD yield or a copied US-stock WACC',
      beta: 'FMP profile beta'
    } }
  } };
  globalThis.FCFF_DATA = { stocks: {
    AAPL: { provenance: { treasury: { date: '2026-10-20', year10: 5.12, year2: 3.9, currency: 'USD' } } }
  } };
  const Models = require('../fmp_models.js');
  const source = Models.riskFreeTenorSource(
    { ticker: '0700.HK', market: 'HKEX', calculationCurrency: 'HKD' }, '0700.HK');
  assert.equal(source.currency, 'USD');
  assert.equal(source.hkPegProxy, true);
  assert.equal(source.rates[10], 5.09);
  assert.equal(source.rates[5], 4.2);
  assert.equal(source.rates[2], undefined);
  assert.match(source.riskFreeNote, /USD Treasury proxy/);

  const hkdLabeled = Models.riskFreeTenorSource(
    { ticker: '0001.HK', market: 'HKEX', calculationCurrency: 'HKD' }, '0001.HK');
  // No own USD capture → fall back to latest USD curve from FCFF_DATA, never calculationCurrency HKD.
  assert.equal(hkdLabeled.currency, 'USD');
  assert.equal(hkdLabeled.rates[10], 5.12);
  assert.equal(hkdLabeled.rates[2], 3.9);
});

test('applyRfTenor code path preserves user rf overrides', () => {
  const models = fs.readFileSync('fmp_models.js', 'utf8');
  assert.match(models, /origins\?\.rf === 'user'\) continue/);
  assert.match(models, /origins\?\.ke === 'user'\) continue/);
});
