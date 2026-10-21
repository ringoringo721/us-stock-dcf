const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TICKERS, PRIOR_RUN_ID } = require('../scripts/recover_hk_missing_statements_14.cjs');

test('the 14 large-cap empty-statement targets stay explicitly unavailable, never zero-filled', () => {
  assert.equal(TICKERS.length, 14);
  assert.equal(PRIOR_RUN_ID, '39519497780');
  for (const ticker of TICKERS) {
    const record = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'hk_companies', `${ticker}.json`), 'utf8'));
    assert.equal(record.ticker, ticker);
    const stock = record.stock;
    assert.equal(stock.calculationCurrency, 'HKD');
    assert.ok(Number.isFinite(stock.mcap) && stock.mcap >= 1000, `${ticker} must clear HKD 1B screen`);
    const warnings = stock.qualityWarnings || [];
    assert.ok(warnings.some(row => row.code === 'providerStatementUnavailable'),
      `${ticker} must retain providerStatementUnavailable rather than fabricating statements`);
    const statements = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'cache', 'financials', `${ticker}_statements_v2.json`), 'utf8'));
    assert.equal(statements.annual.income.length, 0, `${ticker} annual income must stay empty until provider coverage exists`);
    assert.equal(statements.annual.balance.length, 0);
    assert.equal(statements.annual.cashflow.length, 0);
    for (const field of ['pe_trailing', 'roe', 'roa', 'fcf0']) {
      assert.equal(stock[field], null, `${ticker}.${field} must remain null without statements`);
    }
    const dims = Object.entries(stock.moat || {}).filter(([key]) => /^m\d+_/.test(key));
    assert.equal(dims.length, 10, `${ticker} moat report must keep all ten dimensions`);
    assert.ok(dims.some(([, value]) => value.score === null),
      `${ticker} must keep at least one unscored moat dimension until evidence supports a full /100`);
  }
});
