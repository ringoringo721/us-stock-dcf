const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Scenario = require('../fmp_scenario.js');
const Models = require('../fmp_models.js');
const root = path.resolve(__dirname, '..');
const read = ticker => JSON.parse(fs.readFileSync(path.join(root, 'cache', 'company', `${ticker}.json`)));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const finite = value => typeof value === 'number' && Number.isFinite(value);

function flat(kind = 'advanced') {
  return { version: 1, kind, shares: 10, baseYear: 2025, baseRevenue: 100, openingNwc: 25,
    netDebt: 20, terminalGrowth: 0,
    years: Array.from({ length: 10 }, (_, index) => ({ year: 2026 + index, origins: {},
      values: { growth: 0, ebitda: 30, ebit: 25, da: 5, cash: 20, receivables: 20,
        inventories: 10, payables: 5, cfo: 30, capex: -10, tax: 20, beta: 1,
        rf: 4, erp: 6, kd: 5, ke: 10, debtWeight: 0 } })) };
}

test('advanced cash-flow identity, terminal bridge and no extra projected cash', () => {
  const input = flat(), result = Scenario.calculate(input);
  assert.equal(result.rows.length, 10);
  near(result.rows[0].ebitda, 30);
  near(result.rows[0].ebit, 25);
  near(result.rows[0].cashFlow, 15);
  near(result.enterpriseValue, 150);
  near(result.equityValue, 130);
  near(result.targetPrice, 13);
  input.years.forEach(item => { item.values.cash = 900; });
  near(Scenario.calculate(input).targetPrice, 13);
  assert.equal(Scenario.calculate(input).rows[0].projectedCash, 900);
  assert.ok(!Scenario.activeFields('advanced').some(field => field[0] === 'cash'));
  input.years.forEach(item => { delete item.values.cash; });
  near(Scenario.calculate(input).targetPrice, result.targetPrice);
  assert.equal(Scenario.calculate(input).rows[0].projectedCash, null);
});

test('CFO scenario deducts CapEx once and does not add D&A', () => {
  const result = Scenario.calculate(flat('customLevered'));
  near(result.rows[0].cashFlow, 20);
  near(result.enterpriseValue, 200);
  near(result.targetPrice, 18);
});

test('annual discount factors compound instead of applying terminal WACC to every year', () => {
  const input = flat();
  input.years[0].values.ke = 20;
  const result = Scenario.calculate(input);
  near(result.rows[0].discount, 1.2);
  near(result.rows[1].discount, 1.32);
  near(result.enterpriseValue, 137.5);
});

test('opening working capital is reconciled against first projection, and zero CapEx is valid', () => {
  const input = flat();
  input.years[0].values.growth = 100;
  const result = Scenario.calculate(input);
  near(result.rows[0].revenue, 200);
  near(result.rows[0].changeNwc, 25);
  near(result.rows[0].cashFlow, 5);
  input.years.forEach(item => { item.values.capex = 0; });
  near(Scenario.calculate(input).rows[0].cashFlow, 25);
});

test('single working-capital change ratio deducts increases, adds releases, and never differences closing balances again', () => {
  const input = flat();
  input.workingCapitalMethod = 'cash-change-to-revenue';
  for (const year of input.years) {
    year.values.nwcChange = 5;
    for (const key of ['receivables', 'inventories', 'payables']) delete year.values[key];
  }
  input.years[0].values.growth = 100;
  input.years[1].values.nwcChange = -5;
  const result = Scenario.calculate(input);
  near(result.rows[0].changeNwc, 10);
  near(result.rows[0].cashFlow, 20);
  near(result.rows[1].changeNwc, -10);
  near(result.rows[1].cashFlow, 40);
  input.openingNwc = null;
  near(Scenario.calculate(input).targetPrice, result.targetPrice);
});

test('legacy three-ratio inputs convert to one editable ratio without changing cash flows or saved input objects', () => {
  const input = flat();
  input.years.forEach((year, index) => {
    year.values.growth = 3 + index;
    year.values.receivables += index;
  });
  const original = structuredClone(input), before = Scenario.calculate(input);
  const converted = Scenario.upgradeWorkingCapital(input);
  const after = Scenario.calculate(converted);
  assert.deepEqual(input, original);
  near(after.targetPrice, before.targetPrice);
  after.rows.forEach((row, index) => near(row.cashFlow, before.rows[index].cashFlow));
  assert.equal(converted.years[0].values.receivables, undefined);
  assert.equal(converted.years[0].origins.nwcChange, 'derived-legacy');
  assert.equal(converted.legacyWorkingCapital.years[0].values.receivables, 20);
  assert.equal(Scenario.upgradeWorkingCapital(converted), converted);
  const shrinking = flat();
  shrinking.years[0].values.growth = -99.9;
  near(Scenario.calculate(Scenario.upgradeWorkingCapital(shrinking)).targetPrice,
    Scenario.calculate(shrinking).targetPrice);
});

test('editing EBIT/EBITDA/D&A and CAPM drivers updates linked assumptions, but manual Ke is respected', () => {
  const input = flat();
  Scenario.update(input, 0, 'ebit', 40);
  near(input.years[0].values.ebitda, 45);
  Scenario.update(input, 0, 'da', 10);
  near(input.years[0].values.ebit, 35);
  Scenario.update(input, 0, 'beta', 2);
  near(input.years[0].values.ke, 16);
  assert.equal(input.years[0].origins.ke, 'capm');
  Scenario.update(input, 0, 'ke', 12);
  near(input.years[0].values.ke, 12);
  Scenario.update(input, 0, 'ebitda', null);
  assert.equal(input.years[0].values.ebit, null);
  assert.throws(() => Scenario.calculate(input), /SCENARIO_INVALID/);
});

test('invalid spreads, missing/extra years, nonfinite inputs and inconsistent EBIT are rejected', () => {
  for (const mutate of [
    input => { input.terminalGrowth = 10; },
    input => { input.years.pop(); },
    input => { input.years.push(input.years[0]); },
    input => { input.years[0].year++; },
    input => { input.years[0].values.growth = Infinity; },
    input => { input.years[0].values.ebit = 100; },
    input => { input.years[0].values.capex = 10; },
    input => { input.shares = 0; }
  ]) {
    const input = flat();
    mutate(input);
    assert.throws(() => Scenario.calculate(input), /SCENARIO_/);
  }
});

test('negative equity results are retained rather than clamped or replaced with a positive target', () => {
  const input = flat();
  input.netDebt = 200;
  near(Scenario.calculate(input).targetPrice, -5);
  assert.deepEqual(Scenario.calculate(input).warnings, ['NEGATIVE_EQUITY_VALUE']);
});

test('annual reference uses exact financial dates and units, not vendor historical model rows or TTM placeholders', () => {
  const data = read('AAPL');
  const raw = require('../cache/financials/AAPL_statements_v2.json');
  const before = JSON.stringify(raw);
  const reference = Scenario.actualReference(data, raw);
  const actualRow = raw.annual.income.find(row => row.date === data.forecastBase.date);
  const cashRow = raw.annual.cashflow.find(row => row.date === data.forecastBase.date);
  assert.equal(reference.date, data.forecastBase.date);
  assert.equal(reference.revenue, actualRow.revenue);
  assert.equal(reference.items.cfo.amount, cashRow.operatingCashFlow);
  near(reference.items.ebitda.percent, reference.items.ebitda.amount / reference.revenue * 100);
  assert.equal(reference.items.beta, undefined, 'Financing assumptions are not invented historical actuals');
  assert.equal(reference.items.tax.basis, 'historicalEffectiveTaxNotForecastOperatingTax');
  assert.equal(JSON.stringify(raw), before);
  const absent = structuredClone(raw);
  absent.annual.income = absent.annual.income.filter(row => row.date !== data.forecastBase.date);
  assert.equal(Scenario.actualReference(data, absent).reason, 'ACTUAL_PERIOD_UNAVAILABLE');
  const foreign = structuredClone(raw);
  foreign.annual.income.find(row => row.date === data.forecastBase.date).reportedCurrency = 'CNY';
  assert.equal(Scenario.actualReference(data, foreign).reason, 'ACTUAL_CURRENCY_UNVERIFIED');
  const incomplete = structuredClone(raw);
  const incompleteCash = incomplete.annual.cashflow.find(row => row.date === data.forecastBase.date);
  delete incompleteCash.operatingCashFlow;
  incompleteCash.netCashProvidedByOperatingActivities = 0;
  assert.equal(Scenario.actualReference(data, incomplete).items.cfo.amount, 0, 'Genuine printed zero is not missing');
  const shifted = structuredClone(raw);
  const prior = shifted.annual.income.find(row => Number(row.fiscalYear || row.calendarYear) === data.forecastBase.year - 1);
  prior.date = `${data.forecastBase.year - 1}-09-28`;
  assert.notEqual(Scenario.actualReference(data, shifted).items.growth.percent, null, '52/53-week fiscal calendars still have genuine annual growth');
  prior.periodLength = 9;
  assert.equal(Scenario.actualReference(data, shifted).items.growth.percent, null, 'A known short reporting year cannot silently form full-year growth');
  shifted.annual.income.find(row => row.date === data.forecastBase.date).periodLength = 9;
  assert.equal(Scenario.actualReference(data, shifted).reason, 'ACTUAL_PERIOD_NOT_FULL_YEAR');
});

test('Link actual reference and new defaults use official reported CFO and full property/PPE cash investment', () => {
  const data = read('0823.HK'), raw = require('../cache/financials/0823.HK_statements_v2.json');
  const before = Scenario.defaults(data, 'customLevered', 10);
  const actual = Scenario.actualReference(data, raw);
  assert.equal(actual.items.cfo.amount, 8461e6);
  assert.equal(actual.items.capex.amount, -1934e6);
  assert.equal(actual.items.capex.basis, 'propertyAndPpeCashAdditions');
  assert.equal(actual.items.cfo.source, 'officialReport');
  assert.deepEqual(Scenario.defaults(data, 'customLevered', 10), before);
  near(before.years[0].values.cfo, data.forecastActuals.latest.items.cfo.percent);
  near(before.years[0].values.capex, data.forecastActuals.latest.items.capex.percent);
  assert.equal(before.years[0].origins.capex, 'latest-fy');
  // Operating defaults (tax / growth / ratios) may now complete the scenario without statements.
  if (Scenario.missingInputs(before).length) {
    assert.throws(() => Scenario.calculate(before), /INCOMPLETE_ASSUMPTIONS/);
  } else {
    assert.equal(typeof Scenario.calculate(before).targetPrice, 'number');
  }
  const unreviewed = structuredClone(data);
  unreviewed.sourceReview.reason = 'FINGERPRINT_CHANGED';
  assert.equal(Scenario.actualReference(unreviewed, raw).items.cfo.amount, 8461e6,
    'Historical statutory CFO is independently source-reviewed, not restored to the old provider classification');
  assert.equal(Scenario.actualReference(unreviewed, raw.propertyFvOriginal).items.cfo.amount, 6816e6);
  assert.equal(actual.items.ebit.amount, 9609e6);
  assert.equal(actual.items.ebitda.amount, 9699e6);
  assert.equal(actual.items.ebit.source, 'officialPropertyFv');
  assert.ok(actual.propertyFvProvenance);
});

test('audit export preserves native rows, full-precision local inputs, denominators and source inconsistencies', () => {
  const data = read('0823.HK'), stock = require('../hk_market_dcf.json')['0823.HK'];
  const scenario = Scenario.defaults(data, 'advanced', Models.issuedShares(stock));
  const packet = Models.auditPacket({ data, kind: 'advanced', stock, scenario,
    statements: require('../cache/financials/0823.HK_statements_v2.json') });
  assert.deepEqual(packet.native.rows, data.models.advanced.data);
  assert.deepEqual(packet.tenYear.input, scenario);
  if (packet.tenYear.missingInputs.length) {
    assert.equal(packet.tenYear.result, null);
    assert.equal(packet.tenYear.reason, 'SCENARIO_INCOMPLETE_ASSUMPTIONS');
  } else {
    assert.equal(packet.tenYear.reason, null);
    assert.equal(typeof packet.tenYear.result?.targetPrice, 'number');
  }
  assert.deepEqual(packet.analystEstimates, data.analystEstimates);
  assert.ok(packet.native.checks.some(check => Math.abs(check.ebitIdentityResidual) > 20e6));
  assert.equal(packet.native.issuedShares, stock.shares_outstanding);
  assert.match(packet.formulas.native, /not independently reproduced/);
  const varying = structuredClone(data);
  varying.models.advanced.data[0].netDebt++;
  assert.throws(() => Scenario.defaults(varying, 'advanced', 10), /SNAPSHOT_NET_DEBT_UNVERIFIED/);
});

test('forecast baseline is sourced from actual annual financials, not snapshot calendar year or oldest FX match', () => {
  const data = read('AAPL');
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'financials', 'AAPL_statements_v2.json')));
  assert.ok(/^\d{4}/.test(data.currencyCheck.sourceDate));
  assert.equal(Scenario.baseSource(data, raw).year, 2025);
  assert.equal(Scenario.defaults(data, 'advanced', 10).years[0].year, 2026);
  const absent = structuredClone(data);
  delete absent.forecastBase;
  // Model year matching currencyCheck.sourceDate can recover a base when capture omitted forecastBase.
  const recovered = Scenario.defaults(absent, 'advanced', 10);
  assert.equal(recovered.baseYear, Number(data.currencyCheck.sourceDate.slice(0, 4)));
  assert.equal(recovered.recoveredForecastBase, true);
  const noEvidence = structuredClone(data);
  delete noEvidence.forecastBase;
  delete noEvidence.currencyCheck.sourceDate;
  assert.throws(() => Scenario.defaults(noEvidence, 'advanced', 10), /BASE_UNVERIFIED/);
  assert.equal(Scenario.baseSource({ ...data, currencyCheck: { reason: 'unverified' } }, raw).reason, 'SCENARIO_BASE_UNVERIFIED');
});

test('analyst values and approved actual ratios replace vendor forecasts without inventing extension years', () => {
  const data = read('AAPL'), before = JSON.stringify(data);
  const input = Scenario.defaults(data, 'advanced', 10);
  assert.equal(input.years.length, 10);
  assert.deepEqual(input.analystYears, [2026, 2027, 2028, 2029, 2030]);
  assert.deepEqual(input.providerYears, []);
  const provider = data.models.advanced.data.find(row => row.year === '2026');
  const consensus = data.analystEstimates.rows.find(row => row.date.startsWith('2026'));
  near(input.baseRevenue * (1 + input.years[0].values.growth / 100), consensus.revenueAvg * data.analystEstimates.fx.rate);
  near(input.years[0].values.ebitda, consensus.ebitdaAvg / consensus.revenueAvg * 100);
  assert.ok(finite(input.years[0].values.tax), 'Tax uses latest-FY / model-base fallback when statements are absent');
  assert.ok(['latest-fy', 'fmp-base-year', 'five-year-effective-tax'].includes(input.years[0].origins.tax));
  assert.equal(input.years[0].origins.ebit, 'derived');
  assert.ok(['suggested-mature-growth', 'historical-cagr', 'peer-median-growth'].includes(input.years[5].origins.growth),
    'Without statements, uncovered years use growth defaults rather than inventing consensus');
  assert.ok(finite(input.years[9].values.growth));
  assert.equal(input.terminalGrowth, 2.5);
  assert.equal(input.terminalGrowthOrigin, 'suggested-default');
  near(input.years[0].values.beta, provider.beta);
  near(input.years[9].values.beta, data.models.advanced.data.find(row => row.year === '2030').beta);
  assert.equal(JSON.stringify(data), before);
  assert.equal(Scenario.missingInputs(input).length, 0);
  assert.equal(typeof Scenario.calculate(input).targetPrice, 'number');
});

test('new defaults do not import vendor implied taxes as analyst forecasts; latest-FY / base-year remain labeled', () => {
  const input = Scenario.defaults(read('AMAT'), 'advanced', 10);
  assert.ok(['latest-fy', 'fmp-base-year', 'five-year-effective-tax'].includes(input.years[0].origins.tax));
  assert.notEqual(input.years[0].origins.tax, 'analyst');
  assert.deepEqual(input.warnings, []);
  assert.ok(finite(input.years[0].values.tax));
});

test('all supported company/model pairs create ten sourced fiscal-year projections; absent or unverified coverage stays absent', () => {
  const market = { ...require('../full_market_dcf.json'), ...require('../hk_market_dcf.json') };
  let count = 0;
  let eligibleModels = 0;
  for (const [ticker, stock] of Object.entries(market)) {
    if (!Models.dcfApplicable(stock)) continue;
    const data = read(ticker);
    for (const kind of ['advanced', 'customLevered']) {
      if (Models.value(data, kind, { ...stock, ticker }).fairVal !== null) eligibleModels++;
      if (data.models[kind].reason || Models.issuedShares(stock) === null) {
        assert.throws(() => Scenario.defaults(data, kind, Models.issuedShares(stock)),
          /FMP_ISSUED_SHARES_UNAVAILABLE|SCENARIO_FORECAST_UNAVAILABLE|SCENARIO_SOURCE_UNAVAILABLE/);
        continue;
      }
      let input;
      try {
        input = Scenario.defaults(data, kind, Models.issuedShares(stock));
      } catch (error) {
        assert.match(error.message, /SCENARIO_BASE_UNVERIFIED|SCENARIO_FORECAST_UNAVAILABLE|SCENARIO_SNAPSHOT_NET_DEBT_UNVERIFIED/);
        continue;
      }
      assert.equal(input.years.length, 10, `${ticker} ${kind}`);
      assert.equal(input.years.at(-1).year, input.baseYear + 10);
      assert.equal(input.assumptionPolicy, 'analyst-consensus-v1');
      const capital = data.models[kind].data.filter(row => Number(row.year) > input.baseYear)
        .sort((a, b) => Number(a.year) - Number(b.year));
      input.years.forEach((year, index) => {
        const expected = capital[index] || capital.at(-1);
        for (const [key, source] of Object.entries({ beta: 'beta', rf: 'riskFreeRate',
          erp: 'marketRiskPremium', kd: 'costofDebt', ke: 'costOfEquity', debtWeight: 'debtWeighting' })) {
          assert.equal(year.values[key], expected[source], `${ticker}/${kind}/${year.year}/${key}: retained setting`);
        }
      });
      count++;
    }
  }
  assert.ok(count >= eligibleModels, 'Scenarios cover at least every native-verified model; FX-unverified ADR/HK may also build');
  assert.ok(count >= 546, 'The industry extension does not remove existing source-supported scenarios');
});

test('advanced dual terminal keeps Gordon primary and reports exit-multiple beside it without inventing a multiple', () => {
  const input = flat();
  const missing = Scenario.calculate(input);
  assert.equal(missing.terminalMethod, 'gordon');
  near(missing.targetPrice, missing.terminals.gordon.targetPrice);
  assert.equal(missing.terminals.exitMultiple.available, false);
  assert.equal(missing.terminals.exitMultiple.reason, 'EXIT_MULTIPLE_UNAVAILABLE');
  input.exitMultiple = 10;
  const dual = Scenario.calculate(input);
  near(dual.targetPrice, missing.targetPrice);
  near(dual.terminals.gordon.enterpriseValue, missing.enterpriseValue);
  assert.equal(dual.terminals.exitMultiple.available, true);
  near(dual.terminals.exitMultiple.terminalValue, 300);
  near(dual.terminals.exitMultiple.targetPrice, dual.terminals.exitMultiple.equityValue / input.shares);
  assert.ok(Math.abs(dual.terminals.exitMultiple.targetPrice - dual.targetPrice) > 1e-6);
  input.exitMultiple = 0;
  assert.equal(Scenario.calculate(input).terminals.exitMultiple.reason, 'EXIT_MULTIPLE_INVALID');
  input.exitMultiple = 10;
  input.years.forEach(year => { year.values.ebitda = 0; year.values.ebit = -5; year.values.da = 5; });
  assert.equal(Scenario.calculate(input).terminals.exitMultiple.reason, 'EXIT_MULTIPLE_NONPOSITIVE_EBITDA');
});

test('levered scenarios never invent an EBITDA exit-multiple terminal', () => {
  const input = flat('customLevered');
  input.exitMultiple = 12;
  const result = Scenario.calculate(input);
  assert.equal(result.terminals.exitMultiple.available, false);
  assert.equal(result.terminals.exitMultiple.reason, 'EXIT_MULTIPLE_ADVANCED_ONLY');
  near(result.targetPrice, result.terminals.gordon.targetPrice);
});

test('new scenario defaults expose suggested terminal growth and optional exitMultiple slot', () => {
  const data = read('AAPL');
  const scenario = Scenario.defaults(data, 'advanced', 1000);
  assert.equal(scenario.exitMultiple, null);
  assert.equal(scenario.terminalGrowth, 2.5);
  assert.equal(scenario.terminalGrowthOrigin, 'suggested-default');
  assert.equal(scenario.netDebtDate, data.forecastBase.date);
});

test('five-year effective tax averages consecutive full FY rates and stays N/A when incomplete', () => {
  const statements = { annual: { income: [] } };
  for (let year = 2021; year <= 2025; year++) {
    statements.annual.income.push({
      date: `${year}-12-31`, fiscalYear: String(year), periodLength: 12, reportedCurrency: 'USD',
      incomeBeforeTax: 100, incomeTaxExpense: 10 + year - 2021
    });
  }
  const tax = Scenario.fiveYearEffectiveTax(statements, { year: 2025, date: '2025-12-31' }, 'USD');
  assert.equal(tax.reason, null);
  near(tax.percent, (10 + 11 + 12 + 13 + 14) / 5);
  assert.deepEqual(tax.years, [2021, 2022, 2023, 2024, 2025]);
  delete statements.annual.income[0].incomeTaxExpense;
  assert.equal(Scenario.fiveYearEffectiveTax(statements, { year: 2025, date: '2025-12-31' }, 'USD').reason,
    'TAX_PRETAX_OR_EXPENSE_UNAVAILABLE');
  assert.equal(Scenario.fiveYearEffectiveTax(null, { year: 2025, date: '2025-12-31' }, 'USD').reason,
    'TAX_STATEMENTS_UNAVAILABLE');
});

test('new defaults label net cash vs net debt with snapshot date and suggested terminal/exit inputs', () => {
  const data = read('AAPL');
  const statements = require('../cache/financials/AAPL_statements_v2.json');
  const stock = { ...require('../full_market_dcf.json').AAPL, ev_to_ebitda: 25, pe_trailing: 38.4 };
  const scenario = Scenario.defaults(data, 'advanced', Models.issuedShares(stock), { statements, stock });
  assert.equal(scenario.netDebtDate, data.forecastBase.date);
  assert.equal(scenario.netDebtBasis, scenario.netDebt < 0 ? 'net-cash' : 'net-debt');
  assert.equal(scenario.terminalGrowth, 2.5);
  assert.equal(scenario.exitMultiple, 25);
  assert.ok(scenario.taxFiveYear.percent > 0);
  assert.equal(scenario.years[0].origins.tax, 'five-year-effective-tax');
  const history = Scenario.fiveYearHistory(statements, data, 'advanced');
  assert.equal(history.reason, null);
  assert.equal(history.years.length, 5);
  assert.ok(Number.isFinite(history.summary.revenueCagr));
});

test('suggested terminal growth does not overwrite an existing user terminal growth value', () => {
  const input = flat();
  input.terminalGrowth = 1.25;
  input.exitMultiple = 8;
  const again = Scenario.calculate(input);
  near(again.g, 1.25);
  near(again.terminals.exitMultiple.exitMultiple, 8);
});

test('revenue growth suggestion prefers historical CAGR then peers then mature default, and blanks outliers', () => {
  const statements = { annual: { income: [], cashflow: [] } };
  for (let year = 2021; year <= 2025; year++) {
    const revenue = 100 * Math.pow(1.05, year - 2021);
    statements.annual.income.push({
      date: `${year}-12-31`, fiscalYear: String(year), periodLength: 12, reportedCurrency: 'USD',
      revenue, ebitda: revenue * 0.3, incomeBeforeTax: 20, incomeTaxExpense: 4
    });
    statements.annual.cashflow.push({
      date: `${year}-12-31`, fiscalYear: String(year), periodLength: 12, reportedCurrency: 'USD',
      capitalExpenditure: -8, changeInWorkingCapital: -1, operatingCashFlow: 40
    });
  }
  const data = { forecastBase: { year: 2025, date: '2025-12-31' }, currencyCheck: { sourceCurrency: 'USD' } };
  const historical = Scenario.suggestRevenueGrowth({ statements, data, peers: [] });
  assert.equal(historical.origin, 'historical-cagr');
  near(historical.percent, 5);

  statements.annual.income[4].revenue = 1000;
  const outlier = Scenario.suggestRevenueGrowth({ statements, data, peers: [
    { stock: { growth_10y: [6] } }, { stock: { growth_10y: [7] } }, { stock: { growth_10y: [8] } }
  ] });
  assert.equal(outlier.origin, 'peer-median-growth');
  near(outlier.percent, 7);

  const mature = Scenario.suggestRevenueGrowth({ statements, data, peers: [] });
  assert.ok(mature.origin === 'suggested-mature-growth' || mature.reason === 'GROWTH_REQUIRES_MANUAL_INPUT');
  if (mature.origin === 'suggested-mature-growth') near(mature.percent, 2.5);

  const volatile = structuredClone(statements);
  volatile.annual.income[1].revenue = 40;
  volatile.annual.income[2].revenue = 200;
  volatile.annual.income[3].revenue = 50;
  volatile.annual.income[4].revenue = 300;
  const manual = Scenario.suggestRevenueGrowth({ statements: volatile, data, peers: [] });
  assert.equal(manual.percent, null);
  assert.equal(manual.reason, 'GROWTH_REQUIRES_MANUAL_INPUT');
});

test('TSM builds a ten-year scenario from cached model rows despite unverified FX', () => {
  const data = read('TSM');
  const market = require('../full_market_dcf.json').TSM;
  assert.equal(data.currencyCheck?.reason, 'FMP_MODEL_CURRENCY_UNVERIFIED');
  assert.equal(data.forecastBase?.reason, 'SCENARIO_BASE_UNVERIFIED');
  assert.equal(data.analystEstimates?.reason, 'ANALYST_ACTUAL_BASE_UNAVAILABLE');
  assert.deepEqual(data.analystEstimates?.rows || [], []);
  const shares = Models.issuedShares({ ...market, ticker: 'TSM' });
  assert.ok(shares > 0);
  const scenario = Scenario.defaults(data, 'advanced', shares, { stock: { ...market, ticker: 'TSM' } });
  assert.equal(scenario.recoveredForecastBase, true);
  assert.equal(scenario.currencyWarning, 'FMP_MODEL_CURRENCY_UNVERIFIED');
  assert.equal(scenario.terminalGrowth, 2.5);
  assert.ok(finite(scenario.years[0].values.tax));
  assert.ok(finite(scenario.years[0].values.ebitda));
  assert.ok(finite(scenario.years[0].values.growth));
  // Empty analyst feed stays honest; year-specific FMP model projections fill providerYears.
  assert.deepEqual(scenario.analystYears, []);
  assert.equal(scenario.analystReason, 'ANALYST_ACTUAL_BASE_UNAVAILABLE');
  assert.ok(scenario.providerYears.length >= 5, scenario.providerYears.join(','));
  assert.equal(scenario.years[0].origins.growth, 'fmp');
  near(scenario.years[0].values.growth, 25.9);
  assert.equal(scenario.years[0].origins.ebitda, 'fmp');
  assert.equal(Scenario.missingInputs(scenario).length, 0);
  const fair = Scenario.calculate(scenario).targetPrice;
  assert.equal(typeof fair, 'number');
  assert.ok(fair > 0);
});

test('TSM embedded summary alone cannot recover a base year; company cache must supply historical model rows', () => {
  const market = require('../full_market_dcf.json').TSM;
  const shares = Models.issuedShares({ ...market, ticker: 'TSM' });
  const context = { window: {} };
  require('node:vm').runInNewContext(fs.readFileSync(path.join(root, 'fmp_model_data.js'), 'utf8'), context);
  const embedded = context.window.FMP_MODEL_DATA.stocks.TSM;
  const company = read('TSM');
  assert.ok((embedded.models.advanced.data || []).length < (company.models.advanced.data || []).length);
  assert.equal(embedded.capturedAt, company.capturedAt);
  // Truncated embed fails honestly (base/forecast), never as "missing shares".
  assert.throws(() => Scenario.defaults(embedded, 'advanced', shares), error => {
    assert.match(error.message, /SCENARIO_BASE_UNVERIFIED|SCENARIO_FORECAST_UNAVAILABLE/);
    assert.notEqual(error.message, 'SCENARIO_SOURCE_UNAVAILABLE');
    assert.notEqual(error.message, 'FMP_ISSUED_SHARES_UNAVAILABLE');
    return true;
  });
  const recovered = Scenario.defaults(company, 'advanced', shares, { stock: { ...market, ticker: 'TSM' } });
  assert.equal(recovered.recoveredForecastBase, true);
  assert.ok(Scenario.calculate(recovered).targetPrice > 0);
});
