const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { marketBalanceRatios, updateRatioBlocks } = require('../scripts/usd_financials.cjs');
const { convertStatements } = require('../usd_currency.js');
const { calculateReturns } = require('../fcf_ratios.js');
const market = require('../full_market_dcf.json');
const rates = require('../cache/fx/usd_rates.json');
const fields = ['pb_trailing', 'current_ratio', 'cash_to_assets', 'liab_to_assets', 'roe', 'roa'];
const read = ticker => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'financials', `${ticker}_statements_v2.json`)));

function fixture() {
  const rows = ['2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30'].map((date, i) => ({
    date, fiscalYear: date.slice(0, 4), period: `Q${[2, 3, 4, 1, 2][i]}`, reportedCurrency: 'USD',
    netIncome: 5e9, totalStockholdersEquity: i ? 120e9 : 100e9, totalAssets: 1e12,
    totalLiabilities: 880e9, totalCurrentAssets: 300e9, totalCurrentLiabilities: 200e9,
    cashAndShortTermInvestments: 100e9
  }));
  return { annual: { income: [], balance: [], cashflow: [] },
    quarterly: { income: structuredClone(rows), balance: structuredClone(rows), cashflow: [] } };
}

test('US balance ratios ignore corrupted legacy ratios and use actual dated statements with explicit units', () => {
  const stock = { mcap: 300000, current_ratio: 120097000000, roe: 2022600000000, pb_trailing: 284763000000 };
  const data = fixture(), original = structuredClone(data);
  const result = marketBalanceRatios(stock, data);
  assert.deepEqual(Object.fromEntries(fields.map(field => [field, result[field]])),
    { pb_trailing: 2.5, current_ratio: 1.5, cash_to_assets: 10, liab_to_assets: 88, roe: 20, roa: 2 });
  assert.equal(result.marketRatioSources.current_ratio.date, '2026-06-30');
  assert.equal(result.marketRatioSources.roe.basis, 'ttmNetIncomeOverBeginningParentEquity');
  assert.deepEqual(data, original);
});

test('missing or zero denominators and unavailable FX never become one-dollar denominators or capped ratios', () => {
  for (const missing of [null, undefined, NaN, Infinity, 0]) {
    const data = fixture();
    data.quarterly.balance.at(-1).totalCurrentLiabilities = missing;
    data.quarterly.balance.at(-1).totalStockholdersEquity = missing;
    const result = marketBalanceRatios({ mcap: 300000 }, data);
    assert.equal(result.current_ratio, null);
    assert.equal(result.pb_trailing, null);
    assert.ok(result.marketRatioSources.current_ratio.reason);
  }
  const data = fixture();
  data.quarterly.balance.at(-1).totalCurrentAssets = 0;
  assert.equal(marketBalanceRatios({ mcap: 300000 }, data).current_ratio, 0);
  data.quarterly.balance.at(-1).totalStockholdersEquity = -120e9;
  assert.equal(marketBalanceRatios({ mcap: 300000 }, data).pb_trailing, -2.5);
  data.quarterly.balance[0].totalStockholdersEquity = null;
  assert.equal(marketBalanceRatios({ mcap: 300000 }, data).roe, null);
  data.quarterly.balance.at(-1).currencyConversion = { reason: 'missingFxDate' };
  const missingFx = marketBalanceRatios({ mcap: 300000 }, data);
  for (const field of ['current_ratio', 'pb_trailing', 'cash_to_assets', 'liab_to_assets']) assert.equal(missingFx[field], null);
  assert.equal(missingFx.marketRatioSources.current_ratio.reason, 'missingFx');
});

test('market-ratio output patching preserves other fields and JS wrappers and is byte-idempotent', () => {
  const original = { MS: { name: 'Morgan Stanley', ...Object.fromEntries(fields.map(field => [field, 1])),
    price: 180.54, growth_10y: [1, 2], moat: { score: 7 }, fin_valuation: { ke: 9 } } };
  const update = { MS: marketBalanceRatios({ mcap: 300000 }, fixture()) };
  for (const prefix of ['', 'window.FULL_MARKET_DATA = ']) {
    const before = prefix + JSON.stringify(original, null, 2) + (prefix ? ';' : '');
    const after = updateRatioBlocks(before, update);
    assert.equal(updateRatioBlocks(after, update), after);
    const parsed = JSON.parse(after.slice(prefix.length, prefix ? -1 : undefined));
    assert.deepEqual(parsed.MS, { ...original.MS, ...update.MS });
  }
  assert.throws(() => updateRatioBlocks(JSON.stringify(original), update), /Incomplete/);
});

test('Morgan Stanley and all US listings persist the exact same statement-backed ratios as the shared engine', () => {
  assert.equal(Object.keys(market).length, 230);
  for (const [ticker, stock] of Object.entries(market)) {
    const data = convertStatements(read(ticker), rates);
    const expected = marketBalanceRatios(stock, data);
    for (const field of fields) assert.equal(stock[field], expected[field], `${ticker}/${field}`);
    assert.deepEqual(stock.marketRatioSources, expected.marketRatioSources, ticker);
    assert.equal(stock.roe, calculateReturns(data).at(-1)?.ratios.roe.value ?? null, ticker);
  }
  const source = read('MS'), balance = source.quarterly.balance.slice().sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  assert.equal(market.MS.current_ratio, balance.totalCurrentAssets / balance.totalCurrentLiabilities);
  assert.equal(market.MS.pb_trailing, market.MS.mcap / (balance.totalStockholdersEquity / 1e6));
  assert.equal(market.MS.current_ratio.toFixed(2), '1.24');
  assert.equal(market.MS.roe.toFixed(1), '18.7');
});
