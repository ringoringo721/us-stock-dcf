'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadWindowScript(file) {
  const context = { window: {}, console };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  return context.window;
}

test('US baseline + expansion embed FMP DCF and Levered reference rows for front table', () => {
  const market = JSON.parse(fs.readFileSync(path.join(root, 'full_market_dcf.json'), 'utf8'));
  const models = loadWindowScript('fmp_model_data.js').FMP_MODEL_DATA.stocks;
  const expansion = loadWindowScript('us_expansion_data.js').US_EXPANSION;
  Object.assign(models, expansion.models || {});

  const Models = require(path.join(root, 'fmp_models.js'));
  const coverage = { baseline: { dcf: 0, levered: 0, na: [], napp: 0 }, expansion: { dcf: 0, levered: 0, na: [], napp: 0 } };

  for (const [bucket, stocks] of [['baseline', market], ['expansion', expansion.stocks]]) {
    for (const [ticker, stock] of Object.entries(stocks)) {
      const item = { ...stock, ticker };
      if (!Models.dcfApplicable(item)) {
        coverage[bucket].napp++;
        assert.equal(Models.reference(models[ticker], 'dcf', item), null);
        assert.equal(Models.reference(models[ticker], 'levered', item), null);
        continue;
      }
      const dcf = Models.reference(models[ticker], 'dcf', item);
      const levered = Models.reference(models[ticker], 'levered', item);
      if (Number.isFinite(dcf)) coverage[bucket].dcf++;
      else coverage[bucket].na.push(`${ticker}/dcf`);
      if (Number.isFinite(levered)) coverage[bucket].levered++;
      else coverage[bucket].na.push(`${ticker}/levered`);
      if (Number.isFinite(dcf) && dcf > 0 && Number.isFinite(stock.price) && stock.price > 0) {
        assert.equal(Models.priceDifference(dcf, stock.price), (stock.price / dcf - 1) * 100);
      } else if (Number.isFinite(dcf)) {
        assert.equal(Models.priceDifference(dcf, stock.price), null);
      }
    }
  }

  assert.equal(coverage.baseline.dcf, 212);
  assert.equal(coverage.baseline.levered, 212);
  assert.equal(coverage.baseline.napp, 16);
  assert.deepEqual(coverage.baseline.na, []);

  assert.equal(coverage.expansion.dcf, 621);
  assert.equal(coverage.expansion.levered, 621);
  assert.equal(coverage.expansion.napp, 77);
  assert.deepEqual(coverage.expansion.na.sort(), [
    'AGI/dcf', 'AGI/levered',
    'ALLE/dcf', 'ALLE/levered',
    'BMNR/dcf', 'BMNR/levered',
    'CACI/dcf', 'CACI/levered',
    'CSL/dcf', 'CSL/levered',
    'EMBJ/dcf', 'EMBJ/levered',
    'FLUT/dcf', 'FLUT/levered',
    'GDDY/dcf', 'GDDY/levered',
    'MAA/dcf', 'MAA/levered',
    'MCHPP/dcf', 'MCHPP/levered',
    'RML/dcf', 'RML/levered',
    'SJM/dcf', 'SJM/levered',
    'SMCIP/dcf', 'SMCIP/levered',
    'TIGO/dcf', 'TIGO/levered',
    'TXT/dcf', 'TXT/levered',
    'VYLR/dcf', 'VYLR/levered',
    'WY/dcf', 'WY/levered',
  ]);
});
