const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  applyFinancialValuation, ttmPayout
} = require('../scripts/expansion_financial_models.cjs');

const root = path.resolve(__dirname, '..');

test('DB expansion bank gets excess-return / DDM defaults from statements', () => {
  const stock = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'us_companies', 'DB.json'), 'utf8')).stock;
  const statements = JSON.parse(fs.readFileSync(
    path.join(root, 'cache', 'financials', 'DB_statements_v2.json'), 'utf8'));
  assert.equal(stock.fin_valuation.is_financial, true);
  assert.ok(Number.isFinite(stock.fin_valuation.rote));
  assert.ok(Number.isFinite(stock.fin_valuation.tbvps));
  assert.ok(Number.isFinite(stock.fin_valuation.ke));
  assert.ok(Number.isFinite(stock.fin_valuation.excess_return_fair));
  assert.ok(Number.isFinite(stock.fair_val));
  // TTM payout may be empty for incomplete FY; annual fallback must still fund DDM.
  const payout = ttmPayout(statements);
  assert.equal(payout.basis, 'latestCompleteAnnualWithPayout');
  assert.ok(payout.payout > 0);
  const valued = applyFinancialValuation({ ...stock, fin_valuation: { is_financial: false } }, statements);
  assert.equal(valued.fin_valuation.is_financial, true);
  assert.ok(Number.isFinite(valued.fin_valuation.ddm_fair));
});

test('CQP midstream stays non-financial', () => {
  const stock = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'us_companies', 'CQP.json'), 'utf8')).stock;
  assert.equal(stock.fin_valuation?.is_financial, false);
});
