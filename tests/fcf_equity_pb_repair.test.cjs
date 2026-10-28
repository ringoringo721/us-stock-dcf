const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { compactForExpansion } = require('../scripts/expansion_financial_models.cjs');
const { storedTtmFcfToEquity } = require('../fcf_ratios.js');

const root = path.resolve(__dirname, '..');

function loadExpansion() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'us_expansion_data.js'), 'utf8'), context);
  return context.window.US_EXPANSION.stocks;
}

test('compactForExpansion persists fcf_to_equity before stripping statements_raw', () => {
  const stock = {
    ticker: 'TEST',
    fcf0: 100,
    statements_raw: {
      cashflow: { freeCashFlow: [10, 20, 100] },
      balance: { totalStockholdersEquity: [500, 600, 800] }
    }
  };
  const compact = compactForExpansion(stock);
  assert.equal(compact.statements_raw, undefined);
  assert.equal(compact.fcf_to_equity, 12.5);
});

test('AMRO trailing P/B is not raw mcap digits after repair', () => {
  const stocks = loadExpansion();
  const amro = stocks.AMRO;
  assert.ok(amro, 'AMRO in expansion');
  assert.equal(amro.pb_trailing, null, 'AMRO has no usable parent equity → P/B N/A');
  assert.ok(Number.isFinite(amro.mcap));
  assert.notEqual(amro.pb_trailing, amro.mcap * 1e6);
});

test('no expansion stock keeps the equity-or-1.0 mcap×1e6 P/B fingerprint', () => {
  const stocks = loadExpansion();
  const bad = [];
  for (const [ticker, stock] of Object.entries(stocks)) {
    const pb = stock.pb_trailing, mcap = stock.mcap;
    if (!Number.isFinite(pb) || !Number.isFinite(mcap) || mcap <= 0) continue;
    if (Math.abs(pb - mcap * 1e6) / (mcap * 1e6) < 0.001) bad.push(ticker);
  }
  assert.deepEqual(bad, []);
});

test('GEV-class expansion rows persist finite FCF/parent-equity for the screener', () => {
  const stocks = loadExpansion();
  for (const ticker of ['GEV', 'SHOP', 'ARM', 'WELL', 'PBR', 'BUD', 'STX', 'CVS']) {
    assert.ok(Number.isFinite(stocks[ticker].fcf_to_equity), ticker);
    const record = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'us_companies', `${ticker}.json`), 'utf8'));
    const expected = storedTtmFcfToEquity(record.stock.statements_raw, record.stock.currencyConversion?.reason);
    assert.ok(Math.abs(stocks[ticker].fcf_to_equity - expected) < 0.02, ticker);
  }
});
