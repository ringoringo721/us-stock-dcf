'use strict';
/**
 * US expansion / incomplete FCFF stubs must keep catalogue EV/Debt/NetDebt-to-EBITDA
 * on the screener instead of blanking to N/A when TTM EBITDA is absent.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const FcffView = require('../fcff_view.js');

function loadWindow(file, key) {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  return context.window[key];
}

const core = loadWindow('market_data.js', 'FULL_MARKET_DATA');
const expansion = loadWindow('us_expansion_data.js', 'US_EXPANSION').stocks;
const fcff = loadWindow('fcff_data.js', 'FCFF_DATA').stocks;
const universe = { ...core, ...expansion };

const FOCUS = ['ASML', 'SHEL', 'NVS', 'DELL'];

test('focus ADR/expansion names keep catalogue leverage without FCFF EBITDA', () => {
  for (const ticker of FOCUS) {
    const stock = universe[ticker];
    assert.ok(stock, ticker);
    assert.equal(fcff[ticker], undefined, `${ticker} should be expansion without FCFF pack`);
    assert.ok(Number.isFinite(stock.ev_to_ebitda), `${ticker} catalogue EV/EBITDA`);
    const metrics = FcffView.metrics(stock, undefined, { fairVal: null, E: stock.mcap });
    assert.equal(metrics.ev_to_ebitda, stock.ev_to_ebitda, ticker);
    assert.equal(metrics.debt_to_ebitda, stock.debt_to_ebitda, ticker);
    assert.equal(metrics.net_debt_to_ebitda, stock.net_debt_to_ebitda, ticker);
  }
});

test('US non-financials: catalogue leverage fills missing FCFF EBITDA; negative EBITDA stays N/A', () => {
  let missingCatalogue = 0;
  let negativeEbitdaNa = 0;
  let filled = 0;
  for (const [ticker, stock] of Object.entries(universe)) {
    if (stock.fin_valuation?.is_financial) continue;
    const snapshot = fcff[ticker];
    const ebitda = snapshot?.quotedTtm?.ebitda ?? snapshot?.ttm?.ebitda;
    const metrics = FcffView.metrics(stock, snapshot, { fairVal: null, E: stock.mcap });
    if (Number.isFinite(ebitda) && ebitda <= 0) {
      assert.equal(metrics.ev_to_ebitda, null, `${ticker} non-positive EBITDA`);
      negativeEbitdaNa += 1;
      continue;
    }
    if (Number.isFinite(stock.ev_to_ebitda)) {
      assert.ok(Number.isFinite(metrics.ev_to_ebitda), `${ticker} should show leverage`);
      filled += 1;
    } else if (!Number.isFinite(metrics.ev_to_ebitda)) {
      missingCatalogue += 1;
    }
  }
  assert.ok(filled > 800, `expected broad coverage, filled=${filled}`);
  assert.equal(missingCatalogue, 0, 'stocks without catalogue leverage should be rare/documented');
  assert.ok(negativeEbitdaNa >= 1, 'keeps honest N/A for non-positive TTM EBITDA');
});
