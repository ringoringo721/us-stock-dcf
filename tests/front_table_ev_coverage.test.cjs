const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { computedEnterpriseValue, quotedEnterpriseValue } = require('../market_ev.js');
const View = require('../fcff_view.js');
const { assets, buildSite } = require('../scripts/build_site.cjs');

const root = path.resolve(__dirname, '..');

const REPORTED_NA = [
  'GEV', 'TM', 'SHOP', 'ARM', 'AMRO',
  'ASML', 'PLTR', 'SHEL', 'DELL', 'NVS', 'SAP', 'AZN',
  'BNTX', 'NTES', 'CBRS', 'PDD', 'SPOT'
];

function loadWindow(file, key) {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  return context.window[key];
}

function mergeUniverse() {
  const core = loadWindow('market_data.js', 'FULL_MARKET_DATA');
  const listings = loadWindow('us_universe_data.js', 'US_LISTINGS');
  const expansion = loadWindow('us_expansion_data.js', 'US_EXPANSION');
  const context = {
    window: {},
    FULL_MARKET_DATA: core,
    US_LISTINGS: listings,
    US_EXPANSION: expansion,
    US_CHINESE_NAMES: { names: {} },
    FinancialIndustry: {
      usesFinancialValuationModel: (industry) => /Bank|Insurance|Capital Markets|Credit Services|Financial/i.test(String(industry || ''))
    }
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'us_universe.js'), 'utf8'), context);
  return context.UsUniverse.merge(core, listings, expansion);
}

test('reported production N/A tickers expose balance-derived EV for the front table', () => {
  const stocks = loadWindow('us_expansion_data.js', 'US_EXPANSION').stocks;
  for (const ticker of REPORTED_NA) {
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

test('full merged US universe fills EV whenever mcap + debt − cash is available', () => {
  const universe = mergeUniverse();
  const fcff = loadWindow('fcff_data.js', 'FCFF_DATA').stocks;
  const missingComputable = [];
  const missingByDesign = [];
  for (const [ticker, stock] of Object.entries(universe)) {
    const metrics = View.metrics(stock, fcff[ticker], { E: stock.mcap, fairVal: null });
    const computable = computedEnterpriseValue(stock);
    if (Number.isFinite(metrics.EV) || Number.isFinite(quotedEnterpriseValue(stock))) continue;
    if (Number.isFinite(computable)) missingComputable.push(ticker);
    else missingByDesign.push(ticker);
  }
  assert.deepEqual(missingComputable, [], `computable EV still N/A: ${missingComputable.join(',')}`);
  for (const ticker of missingByDesign) {
    const stock = universe[ticker];
    assert.ok(Number.isFinite(stock.mcap), `${ticker} should at least have mcap`);
    assert.equal(computedEnterpriseValue(stock), null, ticker);
  }
  for (const ticker of REPORTED_NA) {
    const stock = universe[ticker];
    assert.ok(stock, ticker);
    const metrics = View.metrics(stock, fcff[ticker], { E: stock.mcap, fairVal: null });
    assert.ok(Number.isFinite(metrics.EV), `${ticker} front-table EV`);
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

test('market_ev.js is published with the static site (production allowlist)', () => {
  assert.ok(assets.includes('market_ev.js'), 'build_site assets must include market_ev.js');
  const output = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ev-public-'));
  try {
    buildSite(output);
    assert.ok(fs.existsSync(path.join(output, 'market_ev.js')));
    const html = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
    assert.match(html, /market_ev\.js\?v=front-table-ev-2/);
    const marketEvIdx = html.indexOf('market_ev.js');
    const fcffViewIdx = html.indexOf('fcff_view.js');
    assert.ok(marketEvIdx > 0 && marketEvIdx < fcffViewIdx, 'market_ev.js must load before fcff_view.js');
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test('screener last-resort rejects null debt/cash so AEFC/listing stubs stay N/A', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.equal(/const debt = Number\(item\.debt\)/.test(html), false);
  assert.match(html, /typeof value === 'number' && Number\.isFinite\(value\)/);

  // Mirror the fixed last-resort: Number(null)===0 must not invent EV≈mcap.
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const lastResort = (item) => {
    if (finite(item.EV)) return item.EV;
    if (finite(item.ev)) return item.ev;
    if (finite(item.fmp_official_ev)) return item.fmp_official_ev;
    const mcap = finite(item.mcap) ? item.mcap : null;
    const debt = finite(item.debt) ? item.debt : null;
    const cash = finite(item.cash_and_short_term) ? item.cash_and_short_term
      : finite(item.cash) ? item.cash : null;
    const net = finite(item.net_debt) ? item.net_debt
      : (finite(debt) && finite(cash) ? debt - cash : null);
    return finite(mcap) && finite(net) ? mcap + net : null;
  };
  assert.equal(lastResort({ mcap: 13516.44, debt: null, cash: null, cash_and_short_term: null }), null);
  assert.equal(lastResort({ mcap: 13516.44, debt: null, cash: null, net_debt: null }), null);
  assert.equal(lastResort({ mcap: 232226.9, debt: 3960, cash_and_short_term: 13120, net_debt: -9160 }), 223066.9);
  assert.equal(computedEnterpriseValue({ mcap: 13516.44, debt: null, cash: null }), null);
});

test('FcffView still fills EV when MarketEv global is absent (publish 404 regression)', () => {
  // Browser factory path: load fcff_view without MarketEv, then ensure inline balance fallback works.
  const context = {
    window: {},
    MarketContext: { labels: dict => dict, compatibleSaved: () => true, fcff: () => null }
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'fcff_view.js'), 'utf8'), context);
  assert.equal(typeof context.MarketEv, 'undefined');
  const stock = loadWindow('us_expansion_data.js', 'US_EXPANSION').stocks.GEV;
  const metrics = context.FcffView.metrics(stock, undefined, { fairVal: null });
  assert.ok(Number.isFinite(metrics.EV), 'GEV EV without MarketEv global');
  assert.ok(Math.abs(metrics.EV - (stock.mcap + stock.net_debt)) < 0.2);
});
