const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  computedEnterpriseValue, quotedEnterpriseValue, applyEnterpriseValue, looksUnconvertedLocalEv
} = require('../market_ev.js');

const root = path.resolve(__dirname, '..');

test('EV formula is mcap + debt - cash (net debt)', () => {
  assert.equal(computedEnterpriseValue({ mcap: 1000, net_debt: -50 }), 950);
  assert.equal(computedEnterpriseValue({ mcap: 1000, debt: 200, cash_and_short_term: 80 }), 1120);
});

test('SKHY-like KRW FMP EV is rejected in favor of USD mcap + net debt', () => {
  const skhy = {
    ticker: 'SKHY',
    reportedCurrency: 'KRW',
    calculationCurrency: 'USD',
    mcap: 1016867.1,
    net_debt: -42579.8,
    ev: 1846260112.1,
    fmp_official_ev: 1846260112.1
  };
  assert.ok(looksUnconvertedLocalEv(skhy.ev, computedEnterpriseValue(skhy), skhy.mcap));
  assert.equal(Math.round(quotedEnterpriseValue(skhy)), 974287);
});

test('ASX-like TWD FMP EV is rejected', () => {
  const asx = {
    reportedCurrency: 'TWD',
    calculationCurrency: 'USD',
    mcap: 85072.1,
    net_debt: 5936.1,
    ev: 3358029.3,
    fmp_official_ev: 3358029.3
  };
  assert.equal(Math.round(quotedEnterpriseValue(asx) * 10) / 10, 91008.2);
});

test('USD reporters prefer balance-derived EV (mcap + net debt) over FMP storage', () => {
  const adi = {
    reportedCurrency: 'USD',
    calculationCurrency: 'USD',
    mcap: 189499,
    net_debt: 6796.7,
    ev: 186068.1,
    fmp_official_ev: 186068.1
  };
  assert.equal(quotedEnterpriseValue(adi), 196295.7);
  assert.equal(quotedEnterpriseValue(adi), computedEnterpriseValue(adi));
});

test('applyEnterpriseValue rewrites multiples from balance-derived EV', () => {
  const stock = {
    reportedCurrency: 'KRW',
    calculationCurrency: 'USD',
    mcap: 1016867.1,
    debt: 13632.1,
    cash_and_short_term: 56211.9,
    net_debt: -42579.8,
    fcf0: 61778.4,
    debt_to_ebitda: 0.12,
    ev: 1846260112.1,
    fmp_official_ev: 1846260112.1,
    ev_to_ebitda: 16917.2
  };
  applyEnterpriseValue(stock);
  assert.equal(stock.ev, 974287.3);
  assert.equal(stock.fmp_official_ev, 974287.3);
  assert.match(stock.enterpriseValueBasis, /market capitalization \+ USD debt/);
  assert.ok(stock.ev_to_ebitda < 20);
  assert.ok(stock.fcf_to_ev > 1 && stock.fcf_to_ev < 20);
});

test('US expansion catalogue SKHY/ASX EV matches USD mcap + net debt', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'us_expansion_data.js'), 'utf8'), context);
  const stocks = context.window.US_EXPANSION.stocks;
  for (const ticker of ['SKHY', 'ASX', 'SONY', 'TM', 'BABA']) {
    const stock = stocks[ticker];
    assert.ok(stock, ticker);
    assert.notEqual(stock.reportedCurrency, 'USD', ticker);
    const computed = computedEnterpriseValue(stock);
    assert.ok(Math.abs(stock.ev - computed) < 0.2, `${ticker} compact EV`);
    assert.ok(Math.abs(stock.fmp_official_ev - computed) < 0.2, `${ticker} official EV`);
    assert.equal(quotedEnterpriseValue(stock), computed);
    const record = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'us_companies', `${ticker}.json`), 'utf8'));
    assert.ok(Math.abs(record.stock.ev - computed) < 0.2, `${ticker} company cache EV`);
  }
  // USD peers also quote balance-derived EV when mcap + net debt are present.
  assert.equal(stocks.ADI.reportedCurrency, 'USD');
  assert.equal(quotedEnterpriseValue(stocks.ADI), computedEnterpriseValue(stocks.ADI));
});
