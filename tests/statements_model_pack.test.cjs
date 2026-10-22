const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Scenario = require('../fmp_scenario.js');
const Pack = require('../statements_model_pack.js');

const root = path.resolve(__dirname, '..');

test('CQP statements pack enables ten-year scenario defaults without live FMP', () => {
  const stock = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'us_companies', 'CQP.json'), 'utf8')).stock;
  const statements = JSON.parse(fs.readFileSync(
    path.join(root, 'cache', 'financials', 'CQP_statements_v2.json'), 'utf8'));
  const pack = Pack.build('CQP', statements, stock, 'USD', '2026-10-22T00:00:00Z');
  assert.equal(pack.hydratedFrom, 'statements_v2-offline');
  assert.equal(pack.forecastBase.reason, null);
  assert.ok(pack.models.advanced.data.length >= 11);
  const shares = Math.round(stock.shares_outstanding);
  const scenario = Scenario.defaults(pack, 'advanced', shares, { statements, stock });
  assert.equal(scenario.symbol, 'CQP');
  assert.equal(scenario.years.length, 10);
  assert.ok(scenario.years.every(year => Number.isFinite(year.values.growth)
    || Number.isFinite(year.values.ebitda)
    || Number.isFinite(year.values.beta)));
  const missing = Scenario.missingInputs(scenario);
  // Capital costs and operating ratios should be seeded from statements / growth_10y.
  assert.ok(!missing.includes('beta'));
  assert.ok(!missing.includes('rf'));
  assert.ok(!missing.includes('growth') || scenario.years.some(y => Number.isFinite(y.values.growth)));
});
