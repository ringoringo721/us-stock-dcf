const test = require('node:test');
const assert = require('node:assert/strict');
const { calculate, operatingRatios } = require('../fcff.js');

function source() {
  return {
    version: 1, method: 'FCFF', currency: 'USD', valuationDate: '2026-10-17',
    balance: { date: '2026-09-30', workingCapital: 100, leaseDebt: 0 },
    ttm: { dates: ['2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30'],
      fiscalPeriods: [2025 * 4 + 4, 2026 * 4 + 1, 2026 * 4 + 2, 2026 * 4 + 3],
      revenue: 1000, ebit: 200, depreciation: 30, capex: 50, workingCapital: 100 },
    ytd: { date: '2026-09-30', revenue: 800, ebit: 160 },
    annualReference: { revenue: 1000 },
    forecasts: [
      { date: '2025-12-31', revenue: 1000, ebit: 200 },
      { date: '2026-12-31', revenue: 1100, ebit: 220 },
      { date: '2027-12-31', revenue: 1200, ebit: 252 },
      { date: '2028-12-31', revenue: 1300, ebit: 286 }
    ],
    defaults: { tax: 20, rf: 4, erp: 5, beta: 1, kd: 5, g: 2,
      price: 10, shares: 100, debt: 100, leaseOverlap: 0, cash: 50, investments: 0, preferred: 0, minority: 0,
      preferredCost: null, minorityCost: null,
      terminalRoic: null }
  };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9,
  `${actual} != ${expected}`);

test('operating assumptions use exactly latest TTM flows and the closing NWC, never annual averages', () => {
  const input = source();
  input.history = [{ revenue: 1, capex: 1000 }];
  const result = calculate(input);
  assert.equal(result.reason, null);
  assert.equal(result.assumptions.historical.basis, 'latestFourConsecutiveFiscalQuarters');
  near(result.assumptions.ratios.depreciation, 0.03);
  near(result.assumptions.ratios.capex, 0.05);
  near(result.assumptions.ratios.workingCapital, 0.1);
  const invalid = structuredClone(input.ttm);
  invalid.fiscalPeriods[2]--;
  assert.equal(operatingRatios(invalid), null);
  assert.equal(calculate({ ...input, balance: { ...input.balance, date: '2026-06-30' } }).reason,
    'statementDateMismatch');
});

test('FCFF components, stub timing, discount factors and equity bridge independently reconcile', () => {
  const result = calculate(source());
  near(result.WACC, 1000 / 1100 * 0.09 + 100 / 1100 * 0.05 * 0.8);
  const first = result.periods[0];
  near(first.revenue, (1100 - 800) * 75 / 92);
  near(first.ebit, (220 - 160) * 75 / 92);
  near(first.nopat, first.ebit * 0.8);
  near(first.fcff, first.nopat + first.revenue * 0.03 - first.revenue * 0.05 - first.nwcChange);
  near(first.df, 1 / (1 + result.WACC) ** (75 / 365.25));
  near(result.sumPV, result.periods.reduce((sum, row) => sum + row.fcff * row.df, 0));
  near(result.EquityVal, result.ModelEV - 100 + 50);
  near(result.fairVal, result.EquityVal / 100);
  assert.equal(result.periods.length, 11);
  assert.equal(result.periods.at(-1).end, '2036-10-17');
});

test('analyst revenue/EBIT anchors are distinct from model-derived cash flow and later extrapolation', () => {
  const result = calculate(source());
  const annual = result.periods.find(row => row.end === '2027-12-31');
  assert.equal(annual.revenue, 1200);
  assert.equal(annual.ebit, 252);
  assert.equal(annual.source, 'analystRevenueEbitWithModelCashFlow');
  assert.equal(result.periods.find(row => row.end === '2029-12-31').source, 'modelExtrapolation');
  for (const row of result.periods) near(row.pv, row.fcff * row.df);
});

test('zero assumptions are retained; invalid terminal spreads and absent source parameters are N/A', () => {
  const result = calculate(source(), { tax: 0, g: 0, kd: 0, cash: 0, beta: 0 });
  assert.equal(result.reason, null);
  assert.equal(result.assumptions.tax, 0);
  assert.equal(result.terminalReinvestment, 0);
  near(result.NetDebt, 100);
  assert.equal(calculate(source(), { discountRate: 0.02, g: 2 }).reason, 'invalidTerminalSpread');
  assert.equal(calculate(source(), { tax: null }).reason, 'missingParameters');
  assert.equal(calculate(source(), { terminalRoic: 1 }).reason, 'invalidTerminalReinvestment');
  const declining = calculate(source(), { g: -1 });
  assert.equal(declining.reason, null);
  assert.ok(declining.terminalReinvestment < 0);
});

test('terminal reinvestment is explicit and negative common-equity arithmetic is not floored to a penny', () => {
  const result = calculate(source(), { terminalRoic: 10, preferred: 50000, minority: 10 });
  near(result.terminalReinvestment, result.terminalNopat * 2 / 10);
  near(result.terminalFcff, result.terminalNopat * 0.8);
  near(result.tv, result.terminalFcff / (result.WACC - 0.02));
  near(result.EquityVal, result.ModelEV - 100 + 50 - 50000 - 10);
  assert.ok(result.fairVal < 0);
  assert.equal(result.premiumPct, null);
});

test('legacy FCF scenarios cannot silently become FCFF scenarios', () => {
  for (const scenario of [{ fcf0: 100 }, { growth_10y: Array(10).fill(5) },
    { modelVersion: 'legacy' }]) {
    assert.equal(calculate(source(), scenario).reason, 'incompatibleSavedModel');
  }
  assert.equal(calculate(source(), { modelVersion: 'fcff-v1' }).reason, null);
});

test('lease payments included in FCFF are not deducted again; WACC and equity bridge use the same financing debt', () => {
  const input = source(), baseline = calculate(input);
  input.balance.leaseDebt = 100;
  input.defaults.debt = 200;
  input.defaults.leaseOverlap = 100;
  assert.equal(calculate(input).reason, 'leaseClassificationRequired');
  input.leaseReconciled = true;
  const result = calculate(input);
  assert.equal(result.reportedDebt, 200);
  assert.equal(result.leaseOverlap, 100);
  assert.equal(result.financingDebt, 100);
  assert.equal(result.NetDebt, 50);
  near(result.WACC, baseline.WACC);
  near(result.fairVal, baseline.fairVal);
  near(result.EquityVal, result.ModelEV - 200 + 100 + 50);
  assert.equal(calculate(input, { leaseOverlap: 101 }).reason, 'invalidParameters');
  const financing = calculate(input, { leaseOverlap: 0 });
  assert.equal(financing.financingDebt, 200);
  near(financing.wD, 200 / 1200);
  near(financing.EquityVal, financing.ModelEV - 200 + 50);
});

test('noncalendar year, leap dates, missing anchors and conflicting actuals do not fabricate periods', () => {
  const input = source();
  input.valuationDate = '2028-02-29';
  input.balance.date = '2027-12-31';
  input.ttm.dates = ['2027-03-31', '2027-06-30', '2027-09-30', '2027-12-31'];
  input.ttm.fiscalPeriods = [2027 * 4 + 1, 2027 * 4 + 2, 2027 * 4 + 3, 2027 * 4 + 4];
  input.ytd = { date: '2027-12-31', revenue: 400, ebit: 80 };
  input.forecasts = [
    { date: '2027-09-30', revenue: 1000, ebit: 200 },
    { date: '2028-09-30', revenue: 1100, ebit: 220 }
  ];
  const result = calculate(input);
  assert.equal(result.reason, null);
  assert.equal(result.periods.at(-1).end, '2038-02-28');
  assert.equal(result.periods[0].end, '2028-09-30');
  assert.equal(calculate({ ...input, forecasts: [] }).reason, 'missingAnalystAnchors');
  input.ytd.revenue = 1200;
  assert.equal(calculate(input).reason, 'forecastConflictsWithActual');
});
