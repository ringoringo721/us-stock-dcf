const { test } = require('node:test');
const assert = require('node:assert/strict');
const View = require('../fcff_view.js');
const { quotedEnterpriseValue } = require('../market_ev.js');

test('screener without FCFF snapshot still reports FCF/EV from MarketEv (mcap + net debt)', () => {
  const stock = {
    ticker: 'GEV',
    reportedCurrency: 'USD',
    calculationCurrency: 'USD',
    mcap: 232226.9,
    debt: 3960,
    cash_and_short_term: 13120,
    net_debt: -9160,
    fcf0: 12439,
    ev: 223066.9,
    fmp_official_ev: 223066.9
  };
  const metrics = View.metrics(stock, undefined, { reason: 'incompleteTtm', fairVal: null });
  assert.equal(metrics.fcf_to_mcap, stock.fcf0 / stock.mcap * 100);
  assert.ok(Number.isFinite(metrics.fcf_to_ev), 'FCF/EV must not be N/A without preferred/NCI snapshot');
  assert.equal(metrics.EV, quotedEnterpriseValue(stock));
  assert.ok(Math.abs(metrics.fcf_to_ev - stock.fcf0 / metrics.EV * 100) < 1e-9);
});

test('explicit unknown preferred claim in an FCFF snapshot still blanks EV', () => {
  const stock = { mcap: 2000, fcf0: 30 };
  const source = { defaults: { reportedDebt: 100, cash: 200, preferred: null, minority: 0 },
    ttm: { ebitda: 100, reportedFcf: 30 } };
  assert.equal(View.metrics(stock, source, {}).EV, null);
  assert.equal(View.metrics(stock, source, {}).fcf_to_ev, null);
});

test('incomplete FCFF stub without preferred/NCI still falls back to MarketEv', () => {
  // EA/WBD/MMC-class: truthy FCFF entry but empty defaults used to blank front-table EV.
  const stock = {
    ticker: 'EA',
    reportedCurrency: 'USD',
    mcap: 52925.6,
    debt: 1486,
    cash_and_short_term: 2404,
    net_debt: -918,
    fcf0: 1000,
    ev: 50868.1
  };
  const source = { /* no defaults */ };
  const metrics = View.metrics(stock, source, { reason: 'incompleteTtm', fairVal: null });
  assert.equal(metrics.EV, quotedEnterpriseValue(stock));
  assert.ok(Number.isFinite(metrics.fcf_to_ev));
});

test('loaded preferred and minority still form quoted EV with priority claims', () => {
  const stock = { mcap: 2000, fcf0: 30 };
  const source = { defaults: { reportedDebt: 100, cash: 200, preferred: 15, minority: 20 },
    ttm: { ebitda: 100, reportedFcf: 30 } };
  const metrics = View.metrics(stock, source, {});
  assert.equal(metrics.EV, 1935);
  assert.equal(metrics.fcf_to_ev, 30 / 1935 * 100);
});
