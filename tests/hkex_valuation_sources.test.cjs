const test = require('node:test');
const assert = require('node:assert/strict');
const { calculate } = require('../fcff.js');
const { reconcileValuation, fingerprint } = require('../scripts/hkex_valuation_sources.cjs');
const { applyForecastTaxAssumption, applyNoncontrollingClaimAssumption } = require('../scripts/build_hkex.cjs');
const config = require('../hkex_stocks.json').find(row => row.ticker === '0823.HK');
const official = require('../cache/hkex_valuation_reconciliations.json').stocks['0823.HK'];
const statements = { annual: { income: [{ date: '2026-03-31', revenue: 14003 }] }, quarterly: {} };
const record = () => ({ ...structuredClone(official), financialFingerprint: fingerprint(statements) });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function source() {
  return {
    ticker: '0823.HK', version: 1, modelVersion: 'fcff-v2', method: 'FCFF', currency: 'HKD',
    valuationDate: '2026-10-17', reason: 'leaseClassificationRequired',
    balance: { date: '2026-03-31', workingCapital: 1094, leaseDebt: 18 },
    ttm: { reportingFrequency: 'semiannual', dates: ['2025-09-30', '2026-03-31'],
      fiscalPeriods: [8106, 8108], revenue: 14003, ebit: 9416, depreciation: 90,
      capex: 39, workingCapital: 1094, ebitda: -4792, reportedFcf: 6777 },
    annualReference: { date: '2026-03-31', revenue: 14003 },
    ytd: { date: '2026-03-31', revenue: 0, ebit: 0, ebitda: 0, depreciation: 0, capex: 0 },
    forecasts: [2026, 2027, 2028, 2029].map(year => ({
      date: `${year}-03-31`, revenue: 14000, ebit: 10200, ebitda: 12000
    })),
    defaults: { price: 38.2, shares: 2627.3133, debt: 56300, cash: 3805, investments: 212044,
      preferred: 0, minority: -386, rf: 5.09, erp: 4.75, beta: 0.875, kd: 3.59, tax: null,
      g: 2.25, preferredCost: null, minorityCost: null, terminalRoic: null },
    history: { annual: [{ date: '2026-03-31', ebitda: -4792 }], quarterly: [{ capex: 39 }] }
  };
}
const prepare = (input = source(), review = record()) => applyNoncontrollingClaimAssumption(
  applyForecastTaxAssumption(reconcileValuation(input, statements, review), config), config);

test('official rental components remove revaluation double counting and retain actual property cash investment', () => {
  const input = source(), before = structuredClone(input), normalized = prepare(input);
  assert.equal(normalized.reason, null);
  assert.equal(normalized.ttm.reportingFrequency, 'annual');
  assert.deepEqual(normalized.ttm.dates, ['2026-03-31']);
  assert.equal(normalized.ttm.revenue, 13938);
  assert.equal(normalized.ttm.ebit, 10230 - 829);
  assert.equal(normalized.ttm.ebitda, 10230 - 829 + 90);
  assert.equal(normalized.ttm.capex, 1895 + 39);
  assert.equal(normalized.balance.leaseDebt, 9);
  assert.equal(normalized.ttm.workingCapital, 1094 + 233 - 2442 - 2216 - 187 + 559 + 163);
  assert.equal(normalized.defaults.investments, 2324);
  assert.equal(normalized.defaults.cash, 3350);
  assert.deepEqual(normalized.history, before.history);
  assert.deepEqual(input, before);
  assert.equal(normalized.quotedTtm.ebitda, -4792, 'Reported historical multiples are not rewritten as normalized operating metrics');
  assert.equal(normalized.quotedCapital.cash, 3805);
  assert.equal(normalized.quotedCapital.minority, -386);
});

test('financing claims include NCI loans despite the separate approved zero equity scenario', () => {
  const normalized = prepare(), result = calculate(normalized);
  assert.equal(result.reason, null);
  assert.equal(normalized.defaults.debt, 53029 + 3262 + 3063 + 1650 + 163);
  assert.equal(result.financingDebt, 61167);
  assert.equal(result.minority, 0);
  assert.equal(normalized.noncontrollingClaimAssumption.reportedBookValue, -386);
  near(normalized.defaults.kd, 1812 / ((61167 + 56501) / 2) * 100);
  assert.equal(result.shares, 2627.3133);
  near(result.EquityVal, result.ModelEV - 61167 + 3350 + 2324);
  near(result.fairVal, result.EquityVal / result.shares);
});

test('rental profit forecasts are labeled model scenarios and terminal reinvestment retains property capex', () => {
  const normalized = prepare(), result = calculate(normalized);
  assert.equal(result.reason, null);
  assert.equal(normalized.defaults.depreciationBasis, 'ttm');
  assert.equal(result.assumptions.terminalMethod, 'components');
  near(normalized.forecasts[1].ebit, 14000 * 9401 / 13938);
  assert.deepEqual(normalized.forecasts[1].unnormalizedConsensus, { ebit: 10200, ebitda: 12000 });
  assert.equal(result.annuals[0].sources.revenue, 'analyst');
  assert.equal(result.annuals[0].sources.ebitda, 'normalizedRentalMargin');
  near(result.terminalCapex, result.terminalRevenue * 1934 / 13938);
  near(result.terminalReinvestment, result.terminalCapex - result.terminalDepreciation + result.terminalNwcChange);
  assert.ok(result.terminalReinvestment > 0);
  const edited = calculate(normalized, { years: { '2027-03-31': { ebitda: 10000 } } });
  assert.equal(edited.annuals[0].sources.ebitda, 'user');
});

test('a dated official review cannot clear changed periods, revised statements or unrelated source failures', () => {
  for (const input of [
    { ...source(), valuationDate: '2026-06-10' },
    { ...source(), balance: { ...source().balance, date: '2026-09-30' } },
    { ...source(), annualReference: { date: '2025-03-31', revenue: 14000 } }
  ]) assert.equal(prepare(input).reason, 'officialReconciliationRequired');
  const changed = structuredClone(statements);
  changed.annual.income[0].revenue++;
  assert.equal(reconcileValuation(source(), changed, record()).reason, 'officialReconciliationRequired');
  for (const reason of ['missingFx', 'incompleteTtm', 'sourceDateMismatch', 'forecastCurrencyScaleUnverified']) {
    const input = { ...source(), reason };
    assert.equal(reconcileValuation(input, statements, record()), input);
  }
  const unrelated = { ...source(), ticker: '0700.HK' };
  assert.equal(reconcileValuation(unrelated, statements), unrelated);
});

test('missing components and unsupported lease additions fail explicitly rather than becoming zeros', () => {
  const missing = record();
  delete missing.inputs.cashPropertyAdditions;
  assert.throws(() => prepare(source(), missing), /invalid official valuation/);
  const unsupported = record();
  unsupported.inputs.newNoncashLeaseAssets = 10;
  assert.throws(() => prepare(source(), unsupported), /inconsistent official/);
});
