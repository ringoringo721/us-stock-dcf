const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { computedEnterpriseValue, quotedEnterpriseValue } = require('../market_ev.js');
const View = require('../fcff_view.js');

const root = path.resolve(__dirname, '..');

function loadWindow(file, key) {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  return context.window[key];
}

test('screenshot expansion tickers expose balance-derived EV for the front table', () => {
  const stocks = loadWindow('us_expansion_data.js', 'US_EXPANSION').stocks;
  for (const ticker of ['BNTX', 'NTES', 'CBRS', 'PDD', 'SPOT']) {
    const stock = stocks[ticker];
    assert.ok(stock, ticker);
    assert.ok(Number.isFinite(stock.mcap), `${ticker} mcap`);
    const computed = computedEnterpriseValue(stock);
    assert.ok(Number.isFinite(computed), `${ticker} computed EV`);
    assert.ok(Math.abs(stock.ev - computed) < 0.2, `${ticker} catalogue EV`);
    const metrics = View.metrics(stock, undefined, { fairVal: null });
    assert.ok(Math.abs(metrics.EV - quotedEnterpriseValue(stock)) < 1e-6, `${ticker} screener EV`);
    assert.ok(Number.isFinite(metrics.EV), `${ticker} screener EV finite`);
  }
});

test('US expansion EV coverage is nearly complete (mcap + debt − cash)', () => {
  const stocks = loadWindow('us_expansion_data.js', 'US_EXPANSION').stocks;
  const fcff = loadWindow('fcff_data.js', 'FCFF_DATA').stocks;
  let total = 0;
  let withEv = 0;
  const missing = [];
  for (const [ticker, stock] of Object.entries(stocks)) {
    total += 1;
    const metrics = View.metrics(stock, fcff[ticker], { E: stock.mcap, fairVal: null });
    if (Number.isFinite(metrics.EV) || Number.isFinite(quotedEnterpriseValue(stock))) {
      withEv += 1;
    } else {
      missing.push(ticker);
    }
  }
  assert.equal(total, 724);
  assert.ok(withEv >= 723, `expected ≥723 EV rows, got ${withEv}; missing ${missing.join(',')}`);
  // AEFC-class stubs without debt/cash remain N/A by design.
  for (const ticker of missing) {
    const stock = stocks[ticker];
    assert.equal(computedEnterpriseValue(stock), null, ticker);
  }
});

test('incomplete core FCFF stubs (EA/WBD/MMC) no longer blank screener EV', () => {
  const core = loadWindow('market_data.js', 'FULL_MARKET_DATA');
  const fcff = loadWindow('fcff_data.js', 'FCFF_DATA').stocks;
  for (const ticker of ['EA', 'WBD', 'MMC']) {
    const stock = core[ticker];
    assert.ok(stock, ticker);
    assert.ok(fcff[ticker], `${ticker} has FCFF stub`);
    assert.equal(fcff[ticker].defaults, undefined);
    const metrics = View.metrics(stock, fcff[ticker], { fairVal: null });
    assert.equal(metrics.EV, quotedEnterpriseValue(stock));
    assert.ok(Number.isFinite(metrics.EV), ticker);
  }
});
