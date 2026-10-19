const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAnalystSources } = require('../scripts/analyst_sources.cjs');
const Scenario = require('../fmp_scenario.js');

function fixture() {
  const annual = { income: [], balance: [], cashflow: [] };
  for (let year = 2021; year <= 2025; year++) {
    const base = { date: `${year}-12-31`, fiscalYear: String(year), periodLength: 12, reportedCurrency: 'USD' };
    annual.income.push({ ...base, revenue: 100, ebitda: 30, depreciationAndAmortization: year - 2020 });
    annual.balance.push({ ...base, netReceivables: 20, inventory: 10, accountPayables: 5 });
    annual.cashflow.push({ ...base, operatingCashFlow: year === 2025 ? 40 : -30,
      capitalExpenditure: year === 2025 ? -8 : -60, changeInWorkingCapital: year === 2025 ? -10 : 2 });
  }
  const data = { symbol: 'TEST', currency: 'HKD', capturedAt: '2026-10-20T00:00:00Z',
    forecastBase: { year: 2025, date: '2025-12-31', reason: null },
    currencyCheck: { sourceCurrency: 'USD', fx: { price: 7.8 }, reason: null },
    models: { advanced: { data: [{ year: '2025', revenue: 780, receivables: 156, inventories: 78, payable: 39, netDebt: -50 },
      { year: '2026', revenue: 9999, netDebt: -50, beta: 1.2, riskFreeRate: 4.2,
        marketRiskPremium: 5.5, costofDebt: 3.2, costOfEquity: 10.8, debtWeighting: 15 }] } } };
  data.models.customLevered = structuredClone(data.models.advanced);
  const response = { ok: true, rows: [
    { symbol: 'TEST', date: '2025-12-31', revenueAvg: 100 },
    { symbol: 'TEST', date: '2026-12-31', revenueAvg: 120, ebitdaAvg: 36, ebitAvg: 24, numAnalystsRevenue: 4 },
    { symbol: 'TEST', date: '2027-12-31', revenueAvg: 150, ebitdaAvg: 0, ebitAvg: -4, numAnalystsRevenue: 2 }
  ] };
  return { data, statements: { annual }, response };
}
function seeded(f = fixture()) {
  Object.assign(f.data, buildAnalystSources(f.data, f.statements, f.response, f.data.capturedAt));
  return { ...f, input: Scenario.defaults(f.data, 'advanced', 10) };
}

test('analyst revenue uses verified FX; only CFO/CapEx/DA use latest FY, not five-year means', () => {
  const { data, input } = seeded();
  assert.ok(Math.abs(input.years[0].values.growth - 20) < 1e-12);
  assert.equal(input.years[0].values.ebitda, 30);
  assert.equal(input.years[0].values.da, 5);
  assert.equal(input.years[0].values.ebit, 25, 'Linked EBIT is not falsely represented as the independent EBIT consensus');
  assert.equal(input.years[0].values.capex, -8);
  assert.equal(input.years[0].values.nwcChange, 0.4, 'Five annual change/revenue ratios, not closing-balance ratios');
  assert.equal(input.years[0].values.receivables, undefined);
  assert.equal(Scenario.defaults(data, 'customLevered', 10).years[0].values.cfo, 40);
  assert.equal(input.years[1].values.ebitda, 0, 'A genuine zero forecast remains zero');
  assert.equal(input.years[2].values.growth, null);
  assert.equal(input.years[9].values.capex, -8);
  assert.equal(input.years[0].values.tax, null);
  assert.equal(input.years[0].values.ke, 10.8);
  for (const year of input.years) {
    assert.equal(year.values.beta, 1.2);
    assert.equal(year.values.rf, 4.2);
    assert.equal(year.values.erp, 5.5);
    assert.equal(year.values.kd, 3.2);
    assert.equal(year.values.debtWeight, 15);
    assert.equal(year.origins.beta, 'retained-capital');
  }
  assert.equal(input.terminalGrowth, null);
  assert.equal(input.years[0].origins.capex, 'latest-fy');
  assert.equal(input.years[0].origins.ebitda, 'analyst');
  assert.equal(input.years[2].origins.growth, 'unavailable');
  assert.throws(() => Scenario.calculate(input), /INCOMPLETE_ASSUMPTIONS/);
});

test('reported consensus CFO/CapEx/DA takes precedence, including genuine zeros', () => {
  const f = fixture();
  Object.assign(f.response.rows[1], { operatingCashFlowAvg: 0, capitalExpenditureAvg: 0, depreciationAndAmortizationAvg: 0 });
  const { data, input } = seeded(f);
  assert.equal(input.years[0].values.da, 0);
  assert.equal(input.years[0].values.capex, 0);
  assert.equal(input.years[0].origins.da, 'analyst');
  assert.equal(Scenario.defaults(data, 'customLevered', 10).years[0].values.cfo, 0);
});

test('currency, identity, ambiguous periods, missing responses and stale scale cannot create consensus', () => {
  for (const [mutate, expected] of [
    [f => { f.response.rows[1].symbol = 'WRONG'; }, 'ANALYST_SECURITY_MISMATCH'],
    [f => { f.response.rows[0].revenueAvg = 1000; }, 'ANALYST_CURRENCY_SCALE_UNVERIFIED'],
    [f => { f.response.rows.push(f.response.rows[1]); }, 'ANALYST_AMBIGUOUS_PERIOD'],
    [f => { f.response.rows[1].date = '2026-02-30'; }, 'ANALYST_INVALID_FISCAL_DATE'],
    [f => { f.data.currencyCheck.fx.price = null; }, 'ANALYST_FX_UNVERIFIED'],
    [f => { f.response = { reason: 'ANALYST_CAPTURE_UNAVAILABLE' }; }, 'ANALYST_CAPTURE_UNAVAILABLE']
  ]) {
    const f = fixture(); mutate(f);
    const result = buildAnalystSources(f.data, f.statements, f.response, f.data.capturedAt);
    assert.equal(result.analystEstimates.reason, expected);
    assert.deepEqual(result.analystEstimates.rows, []);
  }
});

test('five-year NWC averages require all five annual cash changes; missing latest CapEx is not replaced by an older year', () => {
  const f = fixture();
  delete f.statements.annual.cashflow[0].changeInWorkingCapital;
  delete f.statements.annual.cashflow[4].capitalExpenditure;
  const { input } = seeded(f);
  assert.equal(input.years[0].values.nwcChange, null);
  assert.equal(input.years[0].values.capex, null);
  assert.equal(input.years[0].values.da, 5);
  assert.equal(input.years[0].values.receivables, undefined);
  f.statements.annual.income.shift();
  assert.equal(seeded(f).input.years[0].values.nwcChange, null);
});

test('fiscal matching tolerates 52/53-week dates but does not select a different fiscal period or fill a revenue gap', () => {
  const f = fixture();
  f.response.rows[1].date = '2026-12-25';
  f.response.rows[2].date = '2028-03-31';
  const { input } = seeded(f);
  assert.equal(input.years[0].consensusDate, '2026-12-25');
  assert.equal(input.years[1].values.growth, null);
  assert.equal(input.years[2].values.growth, null);
});

test('no D&A is inferred from EBITDA minus EBIT when both explicit D&A and latest actual D&A are missing', () => {
  const f = fixture();
  delete f.statements.annual.income[4].depreciationAndAmortization;
  const { input } = seeded(f);
  assert.equal(input.years[0].values.da, null);
  assert.equal(input.years[0].values.ebit, 20);
  assert.throws(() => Scenario.calculate(input), /INCOMPLETE_ASSUMPTIONS/);
});

test('stale annual caches and invalid latest-year revenue do not silently substitute old operating ratios', () => {
  const stale = fixture();
  stale.data.forecastBase.year = 2026;
  stale.data.forecastBase.date = '2026-12-31';
  const sources = buildAnalystSources(stale.data, stale.statements, stale.response, stale.data.capturedAt);
  assert.equal(sources.forecastActuals.latest, null);
  assert.equal(sources.forecastActuals.workingCapital.nwcChange, null);
  const invalid = fixture();
  invalid.statements.annual.income.at(-1).revenue = 0;
  const result = buildAnalystSources(invalid.data, invalid.statements, invalid.response, invalid.data.capturedAt);
  assert.equal(result.forecastActuals.latest.reason, 'ACTUAL_PERIOD_UNAVAILABLE');
  assert.equal(result.analystEstimates.reason, 'ANALYST_ACTUAL_BASE_UNAVAILABLE');
});
