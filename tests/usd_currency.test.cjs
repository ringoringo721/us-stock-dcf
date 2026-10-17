const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rateFor, convertStatements } = require('../usd_currency.js');
const { calculate, calculateBalances, calculateEarnings, calculateReturns, financialReference } = require('../fcf_ratios.js');
const { normalizeStock } = require('../scripts/usd_financials.cjs');
const rates = require('../cache/fx/usd_rates.json');
const market = require('../full_market_dcf.json');
const raw = ticker => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'financials', `${ticker}_statements_v2.json`)));

test('Official observations retain correct USD-per-unit direction and provenance', () => {
  assert.match(rates.source, /^https:\/\/www\.federalreserve\.gov\//);
  assert.ok(Object.keys(rates.currencies).length >= 23);
  const observation = rates.currencies.TWD.observations.find(row => row[0] === '2026-06-30');
  assert.equal(observation[1], 1 / 31.85);
  assert.equal(rateFor(rates, 'TWD', null, observation[0], 'closing').rate, observation[1]);
  assert.ok(rateFor(rates, 'EUR', null, '2026-06-30', 'closing').rate > 1);
  assert.ok(rateFor(rates, 'MXN', null, '2026-06-30', 'closing').rate < 0.1);
});

test('Period average, closing, weekends, missing currencies and future observations do not use fixed fallbacks', () => {
  const input = { currencies: { XXX: { series: 'test', observations: [
    ['2025-01-02', 0.1], ['2025-01-03', 0.2], ['2025-01-06', 0.3]
  ] } } };
  assert.equal(rateFor(input, 'XXX', '2025-01-01', '2025-01-06', 'average').rate, (0.1 + 0.2 + 0.3) / 3);
  assert.equal(rateFor(input, 'XXX', null, '2025-01-05', 'closing').rate, 0.2);
  assert.equal(rateFor(input, 'XXX', null, '2025-01-07', 'closing').reason, 'missingFxDate');
  assert.equal(rateFor(input, 'ZZZ', null, '2025-01-06', 'closing').reason, 'missingFxCurrency');
  assert.equal(rateFor(input, 'XXX', '2024-01-01', '2025-01-06', 'average').reason, 'incompleteFxPeriod');
  assert.equal(rateFor(input, 'XXX', null, '2025-01-06', 'average').reason, 'missingFxPeriod');
});

test('TSM EPS, FCF and dividends are translated quarter by quarter without changing historical shares or ADR basis', () => {
  const source = raw('TSM');
  const before = structuredClone(source);
  const data = convertStatements(source, rates);
  const latest = calculateEarnings(data).at(-1);
  const income = data.quarterly.income.slice(0, 4);
  const cashflow = data.quarterly.cashflow.slice(0, 4);
  const shares = income.reduce((sum, row) => sum + row.weightedAverageShsOutDil, 0) / 4;
  assert.equal(latest.currency, 'USD');
  assert.equal(latest.amounts.eps.value, income.reduce((sum, row) => sum + row.epsDiluted, 0));
  assert.equal(latest.amounts.fcf.value, cashflow.reduce((sum, row) => sum + row.freeCashFlow, 0) / shares);
  assert.ok(Math.abs(latest.amounts.dividend.value + cashflow.reduce((sum, row) => sum + row.commonDividendsPaid, 0) / shares) < 1e-12);
  assert.ok(Math.abs(latest.amounts.eps.value - 13.975161263493478) < 1e-10);
  assert.notEqual(latest.amounts.eps.value, calculateEarnings(source).at(-1).amounts.eps.value * income[0].currencyConversion.rate);
  assert.equal(income[0].weightedAverageShsOutDil, source.quarterly.income[0].weightedAverageShsOutDil);
  assert.deepEqual(source, before, 'Raw source records are retained unchanged');
  assert.deepEqual(convertStatements(data, rates), data, 'Already-normalized USD records are never translated twice');
});

test('Closing balances and cash endpoints use dated closing FX, not average flow FX', () => {
  const source = raw('TSM');
  const data = convertStatements(source, rates);
  const closing = rateFor(rates, 'TWD', null, source.quarterly.balance[0].date, 'closing').rate;
  assert.equal(data.quarterly.balance[0].totalAssets, source.quarterly.balance[0].totalAssets * closing);
  assert.equal(data.quarterly.cashflow[0].cashAtEndOfPeriod, source.quarterly.cashflow[0].cashAtEndOfPeriod * closing);
  const opening = rateFor(rates, 'TWD', null, '2026-03-31', 'closing').rate;
  assert.equal(data.quarterly.cashflow[0].cashAtBeginningOfPeriod, source.quarterly.cashflow[0].cashAtBeginningOfPeriod * opening);
  assert.notEqual(closing, data.quarterly.income[0].currencyConversion.rate);
});

test('USD statements retain monetary values, shares and ratios exactly', () => {
  const source = raw('NVDA');
  const data = convertStatements(source, null);
  for (const period of ['annual', 'quarterly']) for (const type of ['income', 'cashflow', 'balance']) {
    source[period][type].forEach((row, i) => {
      for (const [key, value] of Object.entries(row)) assert.deepEqual(data[period][type][i][key], value);
    });
  }
});

test('Unavailable FX yields explicit N/A throughout balances, earnings and returns, not zero or 1:1', () => {
  assert.throws(() => financialReference(raw('TSM'), { shares: market.TSM.shares }), /period-specific USD rates/);
  const data = convertStatements(raw('TSM'), { currencies: {} });
  assert.equal(data.quarterly.income[0].revenue, null);
  assert.equal(data.quarterly.income[0].epsDiluted, null);
  assert.equal(data.quarterly.income[0].weightedAverageShsOutDil, raw('TSM').quarterly.income[0].weightedAverageShsOutDil);
  for (const column of [calculate(data).at(-1), calculateReturns(data).at(-1)]) {
    for (const ratio of Object.values(column.ratios)) {
      assert.equal(ratio.value, null);
      assert.equal(ratio.reason, 'missingFx');
    }
  }
  assert.equal(calculateBalances(data).at(-1).amounts.assets.reason, 'missingFx');
  assert.equal(calculateEarnings(data).at(-1).amounts.eps.reason, 'missingFx');
  assert.equal(financialReference(data, { shares: market.TSM.shares }).reason, 'missingFx');
});

test('Every foreign stock uses the same USD records in summaries, statements, ratios and valuations', () => {
  for (const [ticker, stock] of Object.entries(market)) {
    if (stock.reportedCurrency === 'USD') continue;
    const data = convertStatements(raw(ticker), rates);
    const rebuilt = normalizeStock(stock, raw(ticker), rates);
    const income = data.quarterly.income.slice(0, 4);
    const flows = data.quarterly.cashflow.slice(0, 4);
    assert.equal(rebuilt.calculationCurrency, 'USD');
    assert.equal(rebuilt.currencyConversion.reason, null, ticker);
    assert.equal(rebuilt.price, stock.price, 'USD listing quotes are not converted');
    assert.equal(rebuilt.shares, stock.shares, 'Shares are counts, not currency');
    assert.ok(Math.abs(rebuilt.fcf0 - flows.reduce((sum, row) => sum + row.freeCashFlow, 0) / 1e6) < 1e-8);
    assert.ok(Math.abs(rebuilt.statements_raw.income.epsdiluted.at(-1) - income.reduce((sum, row) => sum + row.epsDiluted, 0)) < 1e-12);
    assert.ok(Math.abs(rebuilt.ev - (rebuilt.mcap + rebuilt.debt - rebuilt.cash_and_short_term)) < 1e-8);
    assert.equal(rebuilt.roe, calculateReturns(data).at(-1).ratios.roe.value);
    assert.equal(rebuilt.currencyConversion.income.basis, 'average');
    assert.equal(rebuilt.currencyConversion.balance.basis, 'closing');
    assert.deepEqual(rebuilt, stock, `${ticker} published values match the shared USD engine`);
  }
});

test('A missing required flow or unsupported currency cannot produce a zero-shaped DCF valuation', () => {
  const missing = raw('TSM');
  missing.quarterly.cashflow[0].freeCashFlow = null;
  for (const [source, observations, reason] of [
    [missing, rates, 'missingFinancialData'],
    [raw('TSM'), { ...rates, currencies: {} }, 'missingFxCurrency']
  ]) {
    const stock = normalizeStock(market.TSM, source, observations);
    assert.equal(stock.currencyConversion.reason, reason);
    assert.equal(stock.fcf0, null);
    assert.equal(stock.fair_val, null);
    assert.equal(stock.default_fair_val, null);
    assert.equal(stock.dcf_model_ev, null);
    assert.equal(stock.wacc, null);
    assert.equal(stock.premium_pct, null);
  }
});

test('Noncalendar fiscal periods use actual prior report dates and reject ambiguous inferred starts', () => {
  const source = raw('TSM');
  for (const type of ['income', 'cashflow', 'balance']) {
    source.quarterly[type] = source.quarterly[type].slice(0, 2);
    source.quarterly[type][0].date = '2026-06-27';
    source.quarterly[type][1].date = '2026-03-28';
  }
  const data = convertStatements(source, rates);
  assert.equal(data.quarterly.income[0].currencyConversion.start, '2026-03-29');
  assert.equal(data.quarterly.income[0].currencyConversion.reason, null);
  assert.equal(data.quarterly.income[1].currencyConversion.reason, 'missingFxPeriod');
  source.quarterly.income[1].periodStartDate = '2026-01-04';
  assert.equal(convertStatements(source, rates).quarterly.income[1].currencyConversion.start, '2026-01-04');
});
