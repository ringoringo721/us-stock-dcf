const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Scenario = require('../fmp_scenario.js');
const Models = require('../fmp_models.js');
const root = path.resolve(__dirname, '..');
const read = ticker => JSON.parse(fs.readFileSync(path.join(root, 'cache', 'company', `${ticker}.json`)));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);

function flat(kind = 'advanced') {
  return { version: 1, kind, shares: 10, baseYear: 2025, baseRevenue: 100, openingNwc: 25,
    netDebt: 20, terminalGrowth: 0,
    years: Array.from({ length: 10 }, (_, index) => ({ year: 2026 + index, origins: {},
      values: { growth: 0, ebitda: 30, ebit: 25, da: 5, cash: 20, receivables: 20,
        inventories: 10, payables: 5, cfo: 30, capex: -10, tax: 20, beta: 1,
        rf: 4, erp: 6, kd: 5, ke: 10, debtWeight: 0 } })) };
}

test('advanced cash-flow identity, terminal bridge and no extra projected cash', () => {
  const input = flat(), result = Scenario.calculate(input);
  assert.equal(result.rows.length, 10);
  near(result.rows[0].ebitda, 30);
  near(result.rows[0].ebit, 25);
  near(result.rows[0].cashFlow, 15);
  near(result.enterpriseValue, 150);
  near(result.equityValue, 130);
  near(result.targetPrice, 13);
  input.years.forEach(item => { item.values.cash = 900; });
  near(Scenario.calculate(input).targetPrice, 13);
  assert.equal(Scenario.calculate(input).rows[0].projectedCash, 900);
});

test('CFO scenario deducts CapEx once and does not add D&A', () => {
  const result = Scenario.calculate(flat('customLevered'));
  near(result.rows[0].cashFlow, 20);
  near(result.enterpriseValue, 200);
  near(result.targetPrice, 18);
});

test('annual discount factors compound instead of applying terminal WACC to every year', () => {
  const input = flat();
  input.years[0].values.ke = 20;
  const result = Scenario.calculate(input);
  near(result.rows[0].discount, 1.2);
  near(result.rows[1].discount, 1.32);
  near(result.enterpriseValue, 137.5);
});

test('opening working capital is reconciled against first projection, and zero CapEx is valid', () => {
  const input = flat();
  input.years[0].values.growth = 100;
  const result = Scenario.calculate(input);
  near(result.rows[0].revenue, 200);
  near(result.rows[0].changeNwc, 25);
  near(result.rows[0].cashFlow, 5);
  input.years.forEach(item => { item.values.capex = 0; });
  near(Scenario.calculate(input).rows[0].cashFlow, 25);
});

test('editing EBIT/EBITDA/D&A and CAPM drivers updates linked assumptions, but manual Ke is respected', () => {
  const input = flat();
  Scenario.update(input, 0, 'ebit', 40);
  near(input.years[0].values.ebitda, 45);
  Scenario.update(input, 0, 'da', 10);
  near(input.years[0].values.ebit, 35);
  Scenario.update(input, 0, 'beta', 2);
  near(input.years[0].values.ke, 16);
  assert.equal(input.years[0].origins.ke, 'capm');
  Scenario.update(input, 0, 'ke', 12);
  near(input.years[0].values.ke, 12);
  Scenario.update(input, 0, 'ebitda', null);
  assert.equal(input.years[0].values.ebit, null);
  assert.throws(() => Scenario.calculate(input), /SCENARIO_INVALID/);
});

test('invalid spreads, missing/extra years, nonfinite inputs and inconsistent EBIT are rejected', () => {
  for (const mutate of [
    input => { input.terminalGrowth = 10; },
    input => { input.years.pop(); },
    input => { input.years.push(input.years[0]); },
    input => { input.years[0].year++; },
    input => { input.years[0].values.growth = Infinity; },
    input => { input.years[0].values.ebit = 100; },
    input => { input.years[0].values.capex = 10; },
    input => { input.shares = 0; }
  ]) {
    const input = flat();
    mutate(input);
    assert.throws(() => Scenario.calculate(input), /SCENARIO_/);
  }
});

test('negative equity results are retained rather than clamped or replaced with a positive target', () => {
  const input = flat();
  input.netDebt = 200;
  near(Scenario.calculate(input).targetPrice, -5);
});

test('forecast baseline is sourced from actual annual financials, not snapshot calendar year or oldest FX match', () => {
  const data = read('AAPL');
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'financials', 'AAPL_statements_v2.json')));
  assert.equal(data.currencyCheck.sourceDate.slice(0, 4), '2021');
  assert.equal(Scenario.baseSource(data, raw).year, 2025);
  assert.equal(Scenario.defaults(data, 'advanced', 10).years[0].year, 2026);
  const absent = structuredClone(data);
  delete absent.forecastBase;
  assert.throws(() => Scenario.defaults(absent, 'advanced', 10), /BASE_UNVERIFIED/);
  assert.equal(Scenario.baseSource({ ...data, currencyCheck: { reason: 'unverified' } }, raw).reason, 'SCENARIO_BASE_UNVERIFIED');
});

test('FMP projected values and ratios are distinguished from five extension years without mutating vendor rows', () => {
  const data = read('AAPL'), before = JSON.stringify(data);
  const input = Scenario.defaults(data, 'advanced', 10), result = Scenario.calculate(input);
  assert.equal(input.years.length, 10);
  assert.deepEqual(input.providerYears, [2026, 2027, 2028, 2029, 2030]);
  const provider = data.models.advanced.data.find(row => row.year === '2026');
  near(result.rows[0].revenue, provider.revenue);
  near(result.rows[0].ebitda, provider.ebitda);
  near(input.years[0].values.tax, (1 - provider.ebiat / provider.ebit) * 100);
  assert.equal(input.years[0].origins.ebit, 'derived');
  assert.equal(input.years[5].origins.growth, 'extension');
  near(input.years[9].values.growth, input.terminalGrowth);
  assert.equal(JSON.stringify(data), before);
  assert.notEqual(result.targetPrice, data.models.advanced.data[0].equityValue / 10);
});

test('out-of-range vendor implied taxes are explicitly normalized, not silently copied or hidden', () => {
  const input = Scenario.defaults(read('AMAT'), 'advanced', 10);
  assert.equal(input.years[0].origins.tax, 'normalized-fmp-tax');
  assert.ok(input.warnings.some(warning => warning.original > 100 && warning.replacement === 24.52));
  Scenario.calculate(input);
});

test('all 430 covered company/model pairs create ten sourced fiscal-year projections; absent coverage stays absent', () => {
  const market = { ...require('../full_market_dcf.json'), ...require('../hk_market_dcf.json') };
  let count = 0;
  for (const [ticker, stock] of Object.entries(market)) {
    if (stock.fin_valuation?.is_financial) continue;
    const data = read(ticker);
    for (const kind of ['advanced', 'customLevered']) {
      if (data.models[kind].reason) {
        assert.throws(() => Scenario.defaults(data, kind, Models.issuedShares(stock)), /SOURCE_UNAVAILABLE/);
        continue;
      }
      const input = Scenario.defaults(data, kind, Models.issuedShares(stock));
      assert.equal(input.years.length, 10, `${ticker} ${kind}`);
      assert.equal(Scenario.calculate(input).rows.at(-1).year, data.forecastBase.year + 10);
      count++;
    }
  }
  assert.equal(count, 430);
});
