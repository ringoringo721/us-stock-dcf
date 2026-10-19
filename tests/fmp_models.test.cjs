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
