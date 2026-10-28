const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { calculate } = require('../liquidation.js');
const { buildSourceRecord, latestQuarterBalance } = require('../scripts/liquidation_from_financials.cjs');
const { prepareSnapshot, applyToMarket } = require('../scripts/apply_liquidation.cjs');

const root = path.join(__dirname, '..');

function readExpansion() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'us_expansion_data.js'), 'utf8'), context);
  return context.window.US_EXPANSION;
}

test('financials helper builds dated trade-AR source records for expansion tickers', () => {
  const statements = JSON.parse(fs.readFileSync(
    path.join(root, 'cache', 'financials', 'ABNB_statements_v2.json'), 'utf8'));
  const balance = latestQuarterBalance(statements);
  assert.equal(balance.period, 'Q2');
  assert.ok(balance.totalCurrentAssets > 0);
  const stock = {
    price: 172.01, mcap: 102997.1,
    shareBasis: 'commonSharesOutstandingExcludingTreasury',
    shares_outstanding: 598785647,
    shareSource: { date: '2026-10-27', capturedAt: '2026-10-28T00:00:00Z',
      basis: 'commonSharesOutstandingExcludingTreasury' }
  };
  const built = buildSourceRecord('ABNB', stock, statements, '2026-10-28T12:00:00Z');
  assert.equal(built.record.ticker, 'ABNB');
  assert.equal(built.record.providerSymbol, 'ABNB');
  assert.equal(built.record.balance.date, balance.date);
  assert.equal(built.record.balance.accountsReceivables, balance.accountsReceivables);
  assert.equal(built.record.quote.currency, 'USD');
  assert.equal(built.record.quote.marketCap, stock.mcap * 1e6);
  assert.equal(buildSourceRecord('AMRO', stock, { quarterly: { balance: [] } }).reason, 'noQuarter');
});

test('published expansion catalogue ships liquidation snapshots and uses outstanding shares, not diluted', () => {
  const expansion = readExpansion();
  const sources = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'liquidation_sources.json'), 'utf8'));
  const rates = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'fx', 'usd_rates.json'), 'utf8'));
  const tickers = Object.keys(expansion.stocks);
  assert.ok(tickers.length >= 700);

  let withValues = 0;
  let missingSnapshot = 0;
  for (const ticker of tickers) {
    const stock = expansion.stocks[ticker];
    if (!stock.liquidation) {
      missingSnapshot++;
      assert.ok(stock.liq_val_1 == null, ticker);
      continue;
    }
    assert.equal(stock.liquidation.ticker, ticker);
    assert.equal(stock.liquidation.receivablesBasis, 'trade');
    assert.ok(['marketCapOverPrice', 'commonSharesOutstandingExcludingTreasury']
      .includes(stock.liquidation.shareBasis), ticker);
    // Product rule: liquidation denominator is outstanding (ex-treasury), never diluted WA.
    assert.notEqual(stock.liquidation.shareBasis, 'dilutedAverage', ticker);
    const result = calculate(stock.liquidation, ticker);
    assert.deepEqual([stock.liq_val_1, stock.liq_val_2, stock.liq_val_3], result.values, ticker);
    if (result.values.every(value => value !== null)) withValues++;
  }

  // Before the expansion backfill this was 0/724. Keep a high floor so regressions fail loudly.
  assert.ok(withValues >= 650, `expected >=650 expansion liquidation values, got ${withValues}`);
  assert.ok(missingSnapshot <= 30, `expected few missing snapshots, got ${missingSnapshot}`);

  // Spot-check ABNB recomputes from shared apply helpers.
  if (sources.stocks.ABNB && expansion.stocks.ABNB?.liquidation) {
    const snapshot = prepareSnapshot('ABNB', sources.stocks.ABNB, rates, expansion.stocks.ABNB);
    assert.deepEqual(applyToMarket({ ABNB: expansion.stocks.ABNB }, sources, rates).ABNB.liquidation,
      snapshot);
  }
});

test('ORLY negative liquidation and negative P/B are consistent with liabilities > current assets / equity', () => {
  const market = JSON.parse(fs.readFileSync(path.join(root, 'full_market_dcf.json'), 'utf8'));
  const orly = market.ORLY;
  assert.ok(orly, 'ORLY must remain in core market');
  const result = calculate(orly.liquidation, 'ORLY');
  assert.ok(result.values[0] < 0);
  assert.ok(result.values[1] < 0);
  assert.ok(result.values[2] < 0);
  assert.ok(orly.pb_trailing < 0);
  const amounts = orly.liquidation.amounts;
  assert.ok(amounts.currentAssets < amounts.totalLiabilities);
  assert.equal(orly.liquidation.shareBasis, 'commonSharesOutstandingExcludingTreasury');
  assert.equal(result.shares, orly.shares_outstanding);
});
