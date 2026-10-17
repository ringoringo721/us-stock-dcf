const test = require('node:test');
const assert = require('node:assert/strict');
const { calculate } = require('../fcff.js');
const near = (a, b) => assert.ok(Math.abs(a - b) < Math.max(1e-9, Math.abs(b) * 1e-10), `${a} != ${b}`);
function source() {
  return {
    version: 1, modelVersion: 'fcff-v2', method: 'FCFF', currency: 'USD', valuationDate: '2026-10-17',
    balance: { date: '2026-09-30', workingCapital: 100, leaseDebt: 0 },
    ttm: { dates: ['2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30'],
      fiscalPeriods: [8104, 8105, 8106, 8107], revenue: 1000, ebit: 200, ebitda: 230,
      depreciation: 30, capex: 50, workingCapital: 100 },
    ytd: { date: '2026-09-30', revenue: 800, ebit: 160, ebitda: 182.5, depreciation: 22.5, capex: 37.5 },
    annualReference: { revenue: 1000 },
    forecasts: [2025, 2026, 2027, 2028].map((year, i) => ({
      date: `${year}-12-31`, revenue: 1000 + i * 100, ebit: (1000 + i * 100) * 0.2,
      ebitda: (1000 + i * 100) * 0.23
    })),
    defaults: { tax: 20, rf: 4, erp: 5, beta: 1, kd: 5, g: 2,
      price: 10, shares: 100, debt: 100, leaseOverlap: 0, cash: 50, investments: 0,
      preferred: 0, minority: 0, preferredCost: null, minorityCost: null, terminalRoic: null }
  };
}
test('ten fiscal columns remove reported YTD and elapsed unreported flows before mid-year discounting', () => {
  const result = calculate(source()), first = result.periods[0];
  assert.equal(result.reason, null);
  assert.equal(result.periods.length, 10);
  assert.equal(result.annuals.length, 10);
  assert.equal(result.periods.at(-1).end, '2035-12-31');
  near(first.revenue, (1100 - 800) * 75 / 92);
  near(first.ebitda, (253 - 182.5) * 75 / 92);
  near(first.depreciation, (33 - 22.5) * 75 / 92);
  near(first.capex, (55 - 37.5) * 75 / 92);
  near(first.ebit, (220 - 160) * 75 / 92);
  near(first.time, 37.5 / 365.25);
  assert.equal(first.discountDate, '2026-11-23T12:00:00.000Z');
  near(first.df, (1 + result.WACC) ** (-37.5 / 365.25));
  near(result.estimatedOpeningWorkingCapital, 100 + 10 * 17 / 92);
  near(first.nwcChange, 110 - result.estimatedOpeningWorkingCapital);
  near(first.fcff, first.ebit * 0.8 + first.depreciation - first.capex - first.nwcChange);
});
test('real consensus EBITDA, derived EBITDA and modeled D&A carry separate provenance', () => {
  const input = source();
  assert.equal(calculate(input).annuals[0].sources.ebitda, 'analyst');
  assert.equal(calculate(input).annuals[0].sources.depreciation, 'analystSpread');
  delete input.forecasts[1].ebitda;
  const result = calculate(input);
  assert.equal(result.annuals[0].sources.ebitda, 'analystEbitPlusModelDa');
  assert.equal(result.annuals[0].sources.depreciation, 'model');
  near(result.annuals[0].ebitda, 220 + 1100 * 0.03);
  assert.equal(result.annuals.at(-1).sources.ebitda, 'model');
  input.forecasts[1].ebitda = 210;
  assert.equal(calculate(input).annuals[0].sources.depreciation, 'model',
    'A negative consensus spread is not converted into negative D&A');
  input.forecasts[1].ebit = null;
  assert.equal(calculate(input).annuals[0].sources.ebitda, 'analyst',
    'Available consensus EBITDA is not discarded just because EBIT is absent');
  assert.equal(calculate(input).annuals[0].sources.depreciation, 'model');
});
test('per-year amount/rate overrides preserve zero, negative margins and NWC signs', () => {
  const result = calculate(source(), { years: { '2027-12-31': {
    revenueGrowth: 0, ebitdaMargin: -0.1, capexRate: 0, depreciationRate: 0,
    workingCapitalRate: -0.1, tax: 0
  } } });
  assert.equal(result.reason, null);
  const year = result.annuals[1], flow = result.periods[1];
  near(year.revenue, 1100);
  near(year.ebitda, -110);
  assert.equal(year.capex, 0);
  assert.equal(year.depreciation, 0);
  assert.equal(flow.taxExpense, 0);
  assert.ok(flow.nwcChange < 0);
  near(flow.fcff, flow.nopat - flow.nwcChange);
  assert.equal(year.sources.revenue, 'user');
  assert.equal(year.sources.ebitda, 'user');
  assert.equal(year.sources.depreciation, 'user');
});
test('first-year growth uses aligned reported annual revenue before explicitly labeled prior-year consensus', () => {
  const input = source();
  input.annualReference = { date: '2025-12-31', revenue: 900 };
  const reported = calculate(input);
  near(reported.annuals[0].revenueGrowth, 1100 / 900 - 1);
  assert.equal(reported.assumptions.revenueReference.source, 'reportedAnnual');
  input.annualReference.date = '2024-12-31';
  const consensus = calculate(input);
  near(consensus.annuals[0].revenueGrowth, 0.1);
  assert.equal(consensus.assumptions.revenueReference.source, 'analyst');
});
test('terminal ROIC default follows WACC; Gordon growth is applied once and discounted at fiscal end', () => {
  const result = calculate(source());
  near(result.assumptions.terminalRoic, result.WACC * 100);
  near(result.terminalRevenue, result.annuals.at(-1).revenue * 1.02);
  near(result.terminalNopat, result.terminalRevenue * 0.2 * 0.8);
  near(result.terminalFcff, result.terminalNopat * (1 - 0.02 / result.WACC));
  near(result.tv, result.terminalFcff / (result.WACC - 0.02));
  const years = (Date.parse('2035-12-31') - Date.parse('2026-10-17')) / 86400000 / 365.25;
  near(result.terminalTime, years);
  near(result.terminalDf, (1 + result.WACC) ** -years);
  near(result.pvTV, result.tv * result.terminalDf);
  assert.notEqual(result.terminalDf, result.periods.at(-1).df);
  near(result.EquityVal, result.sumPV + result.pvTV - 100 + 50);
  near(result.fairVal, result.EquityVal / 100);
});
test('normalized component terminal uses next-year EBITDA, D&A, capex and incremental NWC', () => {
  const result = calculate(source(), {
    terminalMethod: 'components', terminalEbitdaMargin: 0.24,
    terminalDepreciation: 0.04, terminalCapex: 0.06, terminalWorkingCapital: -0.1
  });
  assert.equal(result.reason, null);
  near(result.terminalEbitda, result.terminalRevenue * 0.24);
  near(result.terminalEbit, result.terminalRevenue * 0.2);
  near(result.terminalNwcChange, (result.terminalRevenue - result.annuals.at(-1).revenue) * -0.1);
  near(result.terminalFcff, result.terminalNopat + result.terminalDepreciation
    - result.terminalCapex - result.terminalNwcChange);
  const warning = calculate(source(), { terminalMethod: 'components', terminalCapex: 0 });
  assert.equal(warning.terminalWarning, true);
  assert.equal(calculate(source(), { g: 100 }).reason, 'invalidTerminalSpread');
});
test('explicit custom WACC can replace missing rate proxies without bypassing financing source guards', () => {
  const input = source();
  Object.assign(input.defaults, { rf: null, erp: null, beta: null, kd: null });
  assert.equal(calculate(input).reason, 'missingParameters');
  const manual = calculate(input, { discountRate: 0.09 });
  assert.equal(manual.reason, null);
  near(manual.WACC, 0.09);
  input.reason = 'leaseClassificationRequired';
  const blocked = calculate(input, { discountRate: 0.09 });
  assert.equal(blocked.reason, 'leaseClassificationRequired');
  assert.equal(blocked.fairVal, null);
  assert.equal(blocked.periods.length, 10, 'Supported draft cash flows are not removed wholesale');
  assert.ok(blocked.periods.every(row => row.pv === null && row.df === null));
});
test('period-end alternative shares cash flows and terminal factors with the mid-year model', () => {
  const mid = calculate(source()), end = calculate(source(), { discountTiming: 'periodEnd' });
  near(end.terminalDf, mid.terminalDf);
  for (const [i, row] of end.periods.entries()) {
    near(row.fcff, mid.periods[i].fcff);
    assert.ok(row.df < mid.periods[i].df);
  }
  assert.ok(end.fairVal < mid.fairVal);
  const changedTerminalGrowth = calculate(source(), { g: 3 });
  for (const [i, row] of changedTerminalGrowth.periods.entries()) near(row.fcff, mid.periods[i].fcff);
});
test('malformed, stale and conflicting overrides fail explicitly; older models are not reinterpreted', () => {
  for (const years of [null, [], { '2027-12-31': { capex: null } },
    { '2027-12-31': { revenue: 100, revenueGrowth: 0.1 } }]) {
    assert.equal(calculate(source(), { years }).reason, 'invalidForecastOverrides');
  }
  assert.equal(calculate(source(), { years: { '2020-12-31': { revenue: 10 } } }).reason, 'staleSavedPeriods');
  assert.equal(calculate(source(), { modelVersion: 'fcff-v1' }).reason, 'incompatibleSavedModel');
  const conflict = calculate(source(), { years: { '2026-12-31': { capex: 0 } } });
  assert.equal(conflict.reason, 'forecastConflictsWithActual');
  assert.equal(conflict.fairVal, null);
  assert.equal(conflict.annuals.length, 10, 'Retain editable annual assumptions so the conflict can be corrected');
  assert.equal(calculate(source(), { shares: 0 }).reason, 'invalidParameters');
  assert.equal(calculate(source(), { years: { '2027-12-31': { tax: 101 } } }).reason, 'invalidForecastOverrides');
});
test('noncalendar fiscal years and leap-year stubs use actual dates rather than rounded year indices', () => {
  const input = source();
  input.forecasts = [
    { date: '2026-02-28', revenue: 1000, ebit: 200, ebitda: 230 },
    { date: '2027-02-28', revenue: 1200, ebit: 240, ebitda: 276 },
    { date: '2028-02-29', revenue: 1300, ebit: 260, ebitda: 299 }
  ];
  const result = calculate(input);
  assert.equal(result.reason, null);
  assert.equal(result.periods[0].end, '2027-02-28');
  assert.equal(result.periods[1].end, '2028-02-29');
  assert.equal(result.periods[5].end, '2032-02-29');
  near(result.periods[1].time, ((Date.parse('2027-02-28') + Date.parse('2028-02-29')) / 2
    - Date.parse(input.valuationDate)) / 86400000 / 365.25);
});
