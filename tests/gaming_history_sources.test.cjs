const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Scenario = require('../fmp_scenario.js');
const { rateFor, convertStatements } = require('../usd_currency.js');
const { flowValue } = require('../scripts/build_hkex.cjs');
const universe = require('../cache/hkex_gaming_universe.json');
const registry = require('../cache/hkex_gaming_revenue_sources.json').stocks;
const galaxy = require('../cache/hkex_revenue_sources.json');
const rates = require('../cache/fx/hkd_rates.json');
const market = require('../hk_market_dcf.json');
const read = ticker => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'financials', `${ticker}_statements_v2.json`)));
const source = ticker => ticker === galaxy.symbol ? galaxy : registry[ticker];
const multiplier = unit => ({ units: 1, thousands: 1000, millions: 1e6 }[unit]);

test('all 21 configured gaming-related issuers have period-specific primary sources and preserved provider archives', () => {
  assert.equal(universe.symbols.length, 21);
  for (const ticker of universe.symbols) {
    const record = source(ticker), data = read(ticker);
    assert.equal(record.symbol, ticker);
    assert.ok(Object.values(record.documents).every(Scenario.verifiedIncomeDocument), ticker);
    assert.ok(data.providerRevenueOriginal.annual.length || data.providerReportedIncome, ticker);
    assert.equal(market[ticker].revenueProvenance.symbol, ticker);
    for (const [period, reviewed] of [['annual', record.annual], ['quarterly', record.halfYear]]) {
      for (const row of data[period].income) {
        if (!row.revenueCorrection || row.revenueCorrection.derivation === 'officialAnnualMinusOfficialH1') continue;
        const actual = reviewed.find(value => value.date === row.date)
          || record.interimPeriods?.find(value => value.date === row.date);
        assert.ok(actual, `${ticker}/${row.date}: source period exists`);
        assert.equal(row.revenue, actual.revenue * multiplier(actual.unit || record.unit));
        for (const [field, amount] of Object.entries(actual.income || {})) {
          assert.equal(row[field], amount === null ? null : amount * multiplier(actual.unit || record.unit),
            `${ticker}/${row.date}/${field}`);
        }
        if (actual.perShare) {
          for (const [field, amount] of Object.entries(actual.perShare)) assert.equal(row[field], amount,
            `${ticker}/${row.date}/${field}: per-share reporting units, not thousands/millions`);
          if (Object.hasOwn(actual.perShare, 'epsdiluted')) assert.equal(row.epsDiluted, actual.perShare.epsdiluted);
        }
        if (record.incomeHistoryPolicy === 'reviewedPeriodsOnly') {
          assert.equal(row.periodLength, actual.periodLength);
          assert.equal(row.periodStartDate, actual.periodStartDate);
        }
      }
    }
    if (record.incomeHistoryPolicy === 'reviewedPeriodsOnly') {
      assert.deepEqual(data.annual.income.map(row => row.date), record.annual.map(row => row.date).sort());
      for (const row of [...record.halfYear, ...(record.interimPeriods || [])]) {
        assert.ok(data.quarterly.income.some(actual => actual.date === row.date), `${ticker}/${row.date}: no reviewed interim erased`);
      }
      assert.ok(data.providerReportedIncome && data.providerReportedBalance, ticker);
    }
  }
});

test('gaming gross profit and net margins preserve reported definitions, including genuine zero and discontinued earnings', () => {
  for (const ticker of universe.symbols) {
    const data = read(ticker), record = source(ticker);
    for (const row of [...data.annual.income, ...data.quarterly.income]) {
      if (!row.revenueCorrection) continue;
      if (record.grossProfitPolicy === 'notReported') {
        assert.equal(row.grossProfit, null);
        assert.equal(row.grossProfitRatio, null);
      }
      const numerator = row.earningsIncludeDiscontinued ? row.netIncomeFromContinuingOperations : row.netIncome;
      assert.equal(row.netIncomeRatio, typeof numerator === 'number' && row.revenue > 0 ? numerator / row.revenue : null,
        `${ticker}/${row.date}: margin cannot use discontinued earnings with continuing-only revenue`);
    }
  }
  const paradise = read('1180.HK').annual.income.at(-1);
  assert.equal(paradise.grossProfit, 152291000);
  assert.equal(paradise.netIncome, 141539000);
  assert.equal(paradise.netIncomeFromContinuingOperations, 10925000);
  assert.equal(paradise.netIncomeRatio, 10925 / 201245);
  assert.equal(read('1245.HK').annual.income.at(-1).depreciationAndAmortization, null,
    'Unsupported continuing D&A is not replaced by a total including discontinued operations');
});

test('compatible primary half-years retain supported current TTM for all five major casino additions', () => {
  for (const ticker of ['2282.HK', '1128.HK', '0200.HK', '0880.HK', '3918.HK']) {
    const data = read(ticker), latest = data.quarterly.income.at(-1);
    const annual = data.annual.income.find(row => row.date === '2025-12-31');
    const priorHalf = data.quarterly.income.find(row => row.date === '2025-06-30');
    const h2 = data.quarterly.income.find(row => row.date === annual.date);
    assert.equal(latest.date, '2026-06-30');
    assert.equal(h2.revenueCorrection.derivation, 'officialAnnualMinusOfficialH1');
    assert.equal(h2.periodLength, 6);
    assert.equal(h2.comparabilityGroup, latest.comparabilityGroup);
    assert.equal(h2.revenue, annual.revenue - priorHalf.revenue);
    assert.equal(flowValue(data, 'income', 'revenue'), annual.revenue - priorHalf.revenue + latest.revenue);
    const converted = convertStatements(data, rates);
    const expected = flowValue(converted, 'income', 'revenue') / 1e6;
    assert.ok(Math.abs(market[ticker].statements_raw.income.revenue[5] - expected) < 1e-8, ticker);
  }
});

test('published second interims and transitions retain actual dates and durations without creating annual or TTM observations', () => {
  for (const ticker of ['1371.HK', '1009.HK', '8279.HK']) {
    const data = read(ticker), record = source(ticker);
    for (const row of record.interimPeriods) {
      const interim = data.quarterly.income.find(actual => actual.date === row.date);
      assert.equal(interim.reportType, 'secondInterim');
      assert.equal(interim.periodLength, 12);
      assert.equal(interim.revenueCorrection.derivation, 'issuerReportedSecondInterim');
      assert.ok(!data.annual.income.some(actual => actual.date === row.date));
      assert.equal(Scenario.fullAnnualPeriod(interim), false);
    }
  }
  assert.equal(read('8279.HK').annual.income.find(row => row.date === '2024-03-31').periodLength, 15);
  const latest = read('1009.HK');
  assert.equal(latest.quarterly.income.at(-1).reportType, 'secondInterim');
  assert.equal(flowValue(latest, 'income', 'revenue'), null, 'A second 12-month interim is not appended to six months to make TTM');
});

test('every reviewed full-FY table amount uses period-average historical HKD FX, while uncertain flow durations remain unavailable', () => {
  for (const ticker of universe.symbols.filter(ticker => source(ticker).incomeHistoryPolicy === 'reviewedPeriodsOnly')) {
    const data = read(ticker), table = market[ticker].statements_raw;
    for (const row of data.annual.income.slice(-5)) {
      const fx = rateFor(rates, row.reportedCurrency, row.periodStartDate, row.date, 'average', 'HKD');
      const index = table.annual_dates.indexOf(row.date.slice(0, 7));
      assert.ok(index >= 0 && index < 5, `${ticker}/${row.date}`);
      const expected = fx.reason ? null : row.revenue * fx.rate / 1e6;
      assert.equal(table.income.revenue[index], expected);
    }
    const converted = convertStatements(data, rates);
    for (const row of converted.quarterly.cashflow) {
      if (row.periodLength === null && row.sourceReportedCurrency !== 'HKD') {
        assert.equal(row.operatingCashFlow, null, `${ticker}/${row.date}: no guessed FX period`);
        assert.ok(row.currencyConversion.reason);
      }
    }
  }
});
