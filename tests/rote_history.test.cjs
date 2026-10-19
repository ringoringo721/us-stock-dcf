const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { annualRoteHistory } = require('../fcf_ratios.js');
const { convertStatements } = require('../usd_currency.js');
const { merge } = require('../scripts/capture_rote_history.cjs');
function fixture() {
  const rows = Array.from({ length: 11 }, (_, index) => ({ date: `${2015 + index}-12-31`,
    fiscalYear: String(2015 + index), period: 'FY', reportedCurrency: 'USD',
    netIncome: index * 10, totalStockholdersEquity: 1000 + index * 100, goodwillAndIntangibleAssets: 100 }));
  return { annual: { income: structuredClone(rows), balance: structuredClone(rows), cashflow: [] },
    quarterly: { income: [], balance: [], cashflow: [] } };
}
test('Ten annual ROTE periods use full-year income and the preceding actual tangible equity, not current/ending equity', () => {
  const history = annualRoteHistory(fixture());
  assert.equal(history.length, 10);
  assert.deepEqual(history.map(row => row.year), Array.from({ length: 10 }, (_, index) => 2016 + index));
  assert.equal(history[0].value, 10 / 900 * 100);
  assert.equal(history.at(-1).value, 100 / 1800 * 100);
  assert.deepEqual(annualRoteHistory({ annual: { income: [] } }), []);
});
test('Missing years/opening balances, duplicates, zero and negative equity are never replaced with inferred values', () => {
  const data = fixture();
  data.annual.balance.shift();
  assert.equal(annualRoteHistory(data)[0].reason, 'missingOpening');
  data.annual.income = data.annual.income.filter(row => row.fiscalYear !== '2017');
  assert.equal(annualRoteHistory(data)[1].reason, 'missingPeriod');
  data.annual.income.push(structuredClone(data.annual.income.at(-1)));
  assert.equal(annualRoteHistory(data).at(-1).value, null);
  const negative = fixture();
  negative.annual.income.at(-1).netIncome = 0;
  assert.equal(annualRoteHistory(negative).at(-1).value, 0);
  negative.annual.balance.at(-2).totalStockholdersEquity = 50;
  negative.annual.income.at(-1).netIncome = 100;
  const result = annualRoteHistory(negative).at(-1);
  assert.equal(result.value, -200);
  assert.ok(result.warnings.includes('negativeTangibleEquity'));
  negative.annual.balance.at(-2).totalStockholdersEquity = 100;
  assert.equal(annualRoteHistory(negative).at(-1).reason, 'zeroDenominator');
});
test('All financial-model stocks have ten saved auditable values matching the shared engine and exact FX snapshot', () => {
  const markets = { ...require('../full_market_dcf.json'), ...require('../hk_market_dcf.json') };
  const symbols = Object.keys(markets).filter(symbol => markets[symbol].fin_valuation?.is_financial === true);
  assert.equal(symbols.length, 25);
  for (const symbol of symbols) {
    const saved = require(`../cache/rote_history/${symbol}.json`);
    const rates = require(saved.calculationCurrency === 'HKD' ? '../cache/fx/hkd_rates.json' : '../cache/fx/usd_rates.json');
    assert.equal(saved.symbol, symbol);
    assert.equal(saved.method, 'reportedNetIncomeOverBeginningTangibleEquity');
    assert.equal(saved.years.filter(row => row.value !== null).length, 10, symbol);
    assert.equal(saved.source.fxSnapshotHash, crypto.createHash('sha256').update(JSON.stringify(rates)).digest('hex'));
    const data = { calculationCurrency: saved.calculationCurrency, annual: saved.annual,
      quarterly: { income: [], balance: [], cashflow: [] } };
    assert.deepEqual(saved.years, annualRoteHistory(convertStatements(data, rates)), symbol);
    const original = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'financials', `${symbol}_statements_v2.json`)));
    assert.equal(saved.source.existingStatementsHash, crypto.createHash('sha256').update(JSON.stringify({
      annual: { income: original.annual.income, balance: original.annual.balance },
      currency: original.calculationCurrency || 'USD'
    })).digest('hex'), `${symbol}: only the actual ROTE inputs invalidate the saved history`);
    assert.deepEqual(merge(original.annual.income, saved.annual.income)
      .filter(row => original.annual.income.some(existing => existing.date === row.date))
      .sort((a, b) => a.date.localeCompare(b.date)), [...original.annual.income].sort((a, b) => a.date.localeCompare(b.date)));
  }
});
