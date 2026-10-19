const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { calculate } = require('../liquidation.js');
const { prepareSnapshot, applyToMarket, patchMarketText } = require('../scripts/apply_liquidation.cjs');
const { rateFor } = require('../usd_currency.js');
const fixture = () => ({
  ticker: 'TEST', providerSymbol: 'TEST', fetchedAt: '2026-10-17T05:00:00Z',
  balance: { date: '2026-06-30', reportedCurrency: 'USD', filingDate: '2026-07-30',
    totalCurrentAssets: 500, totalLiabilities: 200, cashAndShortTermInvestments: 100,
    accountsReceivables: 100, netReceivables: 900, inventory: 100, preferredStock: 0 },
  quote: { currency: 'USD', date: '2026-10-16', price: 10, marketCap: 1000 }
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('all screens use one closing balance, trade AR and quote-implied common shares, not TTM or legacy DCF inputs', () => {
  const source = fixture(), before = structuredClone(source);
  const snapshot = prepareSnapshot('TEST', source, null);
  const result = calculate(snapshot, 'TEST');
  near(result.values[0], 3);
  near(result.values[1], 0.3);
  near(result.values[2], -1);
  assert.equal(result.shares, 100);
  assert.equal(result.balanceDate, '2026-06-30');
  assert.equal(result.quoteDate, '2026-10-16');
  assert.deepEqual(source, before);
  const stock = { price: 150, shares: 1, cash: 99999, debt: 1, fcf0: 999 };
  const updates = applyToMarket({ TEST: stock }, { version: 1, stocks: { TEST: source } }, null);
  assert.deepEqual(Object.keys(stock), ['price', 'shares', 'cash', 'debt', 'fcf0']);
  assert.deepEqual([updates.TEST.liq_val_1, updates.TEST.liq_val_2, updates.TEST.liq_val_3], result.values);
});

test('non-USD balances use dated closing FX once, never converting USD quotes, shares or ADR units', () => {
  const source = fixture();
  source.balance.reportedCurrency = 'TWD';
  const rates = { currencies: { TWD: { series: 'test', observations: [['2026-06-30', 0.1]] } } };
  const snapshot = prepareSnapshot('TEST', source, rates);
  const result = calculate(snapshot, 'TEST');
  near(result.values[0], 0.3);
  near(result.values[1], 0.03);
  near(result.values[2], -0.1);
  assert.equal(result.shares, 100);
  assert.equal(snapshot.quote.price, 10);
  assert.equal(snapshot.fx.observationDate, source.balance.date);
  const missing = prepareSnapshot('TEST', source, { currencies: {} });
  assert.deepEqual(calculate(missing, 'TEST').values, [null, null, null]);
  assert.deepEqual(calculate(missing, 'TEST').reasons, ['missingFx', 'missingFx', 'missingFx']);
});

test('missing values only disable affected formulas; actual zeros are retained and total AR is not a fallback', () => {
  const snapshot = prepareSnapshot('TEST', fixture(), null);
  snapshot.amounts.tradeReceivables = null;
  assert.deepEqual(calculate(snapshot, 'TEST').values, [3, null, -1]);
  snapshot.amounts.tradeReceivables = 0;
  near(calculate(snapshot, 'TEST').values[1], -0.5);
  snapshot.amounts.inventory = 0;
  near(calculate(snapshot, 'TEST').values[1], -1);
  snapshot.amounts.currentAssets = null;
  assert.deepEqual(calculate(snapshot, 'TEST').values, [null, -1, -1]);
  assert.equal(calculate(snapshot, 'TEST').reasons[0], 'missingInputs');
});

test('invalid dates, currencies, missing snapshots and quotes never become invented cash, shares or zero', () => {
  assert.deepEqual(calculate(null, 'TEST').values, [null, null, null]);
  const valid = prepareSnapshot('TEST', fixture(), null);
  for (const change of [
    { ticker: 'OTHER' }, { currency: 'TWD' }, { balanceDate: '2026-02-30' },
    { balanceDate: '2027-01-01' }, { receivablesBasis: 'total' }, { fetchedAt: 123 },
    { shareBasis: 'dilutedAverage' }, { fx: { ...valid.fx, basis: 'average' } },
    { quote: { ...valid.quote, price: 0 } }, { quote: { ...valid.quote, marketCap: null } },
    { quote: { ...valid.quote, currency: 'EUR' } }
  ]) assert.deepEqual(calculate({ ...valid, ...change }, 'TEST').values, [null, null, null]);
});

test('preferred claims are explicitly flagged rather than treating book value as legal liquidation proceeds', () => {
  const snapshot = prepareSnapshot('TEST', fixture(), null);
  snapshot.amounts.preferredStock = 20;
  assert.deepEqual(calculate(snapshot, 'TEST').warnings, ['preferredClaims']);
  near(calculate(snapshot, 'TEST').values[0], 3);
  snapshot.amounts.preferredStock = null;
  assert.deepEqual(calculate(snapshot, 'TEST').warnings, ['preferredUnknown']);
});

test('stale prices cannot imply current shares, while independently dated outstanding shares preserve intrinsic screens', () => {
  const snapshot = prepareSnapshot('TEST', fixture(), null);
  snapshot.quote = { ...snapshot.quote, price: null, marketCap: null, availabilityReason: 'staleQuote' };
  assert.deepEqual(calculate(snapshot, 'TEST').reasons, ['staleQuote', 'staleQuote', 'staleQuote']);
  snapshot.shareBasis = 'commonSharesOutstandingExcludingTreasury';
  snapshot.sharesOutstanding = 100;
  const result = calculate(snapshot, 'TEST');
  assert.deepEqual(result.values, [3, 0.3, -1]);
  assert.deepEqual(result.warnings, ['staleQuote']);
});

test('targeted market patch is idempotent and preserves unrelated numeric text and financial values', () => {
  const text = '{\n  "TEST": {\n    "price": 1.000000,\n    "mcap": 1e-6,\n    "liq_val_1": 9,\n    "liq_val_2": 9,\n    "liq_val_3": 9\n  }\n}';
  const update = applyToMarket(JSON.parse(text), { version: 1, stocks: { TEST: fixture() } }, null);
  const changed = patchMarketText(text, update);
  assert.ok(changed.includes('"price": 1.000000'));
  assert.ok(changed.includes('"mcap": 1e-6'));
  assert.equal(patchMarketText(changed, update), changed);
  assert.deepEqual(JSON.parse(changed).TEST.liquidation, update.TEST.liquidation);
  const js = patchMarketText('window.FULL_MARKET_DATA = ' + text + ';', update);
  assert.ok(js.startsWith('window.FULL_MARKET_DATA = {'));
  assert.ok(js.endsWith('};'));
  const missing = applyToMarket(JSON.parse(text), { version: 1, stocks: {} }, null);
  assert.equal(missing.TEST.liq_val_1, null);
});

test('all covered stocks publish the shared source-derived liquidation outputs and independent formula results', () => {
  const root = path.join(__dirname, '..');
  const market = JSON.parse(fs.readFileSync(path.join(root, 'full_market_dcf.json')));
  const sources = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'liquidation_sources.json')));
  const rates = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'fx', 'usd_rates.json')));
  for (const [ticker, stock] of Object.entries(market)) {
    const record = sources.stocks[ticker];
    assert.ok(record, ticker);
    const snapshot = prepareSnapshot(ticker, record, rates, stock);
    assert.deepEqual(stock.liquidation, snapshot, ticker);
    const result = calculate(snapshot, ticker);
    assert.deepEqual([stock.liq_val_1, stock.liq_val_2, stock.liq_val_3], result.values, ticker);
    const b = record.balance, r = rateFor(rates, b.reportedCurrency, null, b.date, 'closing').rate;
    if (result.values.every(value => value !== null)) {
      const shares = stock.shares_outstanding;
      near(result.values[0], (b.totalCurrentAssets - b.totalLiabilities) * r / shares);
      near(result.values[1], (b.cashAndShortTermInvestments + b.accountsReceivables * 0.8
        + b.inventory * 0.5 - b.totalLiabilities) * r / shares);
      near(result.values[2], (b.cashAndShortTermInvestments - b.totalLiabilities) * r / shares);
    }
  }
  assert.ok(calculate(market['BRK.B'].liquidation, 'BRK.B').shares > 2e9);
});
