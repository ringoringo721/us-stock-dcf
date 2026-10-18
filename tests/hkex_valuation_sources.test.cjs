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
  const unrelated = { ...source(), ticker: '0001.HK' };
  assert.equal(reconcileValuation(unrelated, statements), unrelated);
});

const rates = require('../cache/fx/hkd_rates.json');
const { rateFor } = require('../usd_currency.js');
for (const ticker of ['0700.HK', '0388.HK', '9988.HK']) {
  const reviewed = require('../cache/hkex_valuation_reconciliations.json').stocks[ticker];
  const review = () => ({ ...structuredClone(reviewed), financialFingerprint: fingerprint(statements) });
  const corporateSource = () => ({ ...source(), ticker, sourceCurrency: reviewed.currency,
    balance: { date: reviewed.reviewedSnapshotDate || reviewed.balanceDate, workingCapital: 1, leaseDebt: 0 },
    ttm: { ...source().ttm, dates: ticker === '9988.HK' ? ['2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30']
      : ticker === '0700.HK' ? ['2025-12-31', '2026-06-30'] : ['2025-12-31'],
      reportingFrequency: ticker === '0700.HK' ? 'semiannual' : 'annual',
      fiscalPeriods: ticker === '0700.HK' ? [8104, 8106] : [8104] },
    annualReference: { date: reviewed.annualReference.date, revenue: 1 },
    forecasts: [2026, 2027, 2028, 2029].map(year => ({ date: `${year}-${ticker === '9988.HK' ? '03-31' : '12-31'}`,
      revenue: ticker === '0388.HK' ? 32000 : 1500000, ebit: ticker === '0388.HK' ? 24000 : 350000,
      ebitda: ticker === '0388.HK' ? 26000 : 450000 })),
    provenance: { forecastFx: { rate: ticker === '0388.HK' ? 1 : 1.17 } } });
  const normalize = input => reconcileValuation(input, statements, review(), rates);

  test(`${ticker}: official flows, financing and investment bridge are independently reproducible`, () => {
    const input = corporateSource(), before = structuredClone(input), normalized = normalize(input);
    const closing = rateFor(rates, reviewed.currency, null, reviewed.balanceDate, 'closing', 'HKD').rate;
    const converted = key => reviewed.flows.reduce((sum, row) =>
      sum + row[key] * rateFor(rates, reviewed.currency, row.start, row.end, 'average', 'HKD').rate, 0);
    assert.equal(normalized.reason, null);
    near(normalized.ttm.revenue, converted('revenue'));
    near(normalized.ttm.capex, converted('cashCapex') + converted('newNoncashLeaseAssets'));
    near(normalized.defaults.debt, reviewed.capital.debt * closing);
    near(normalized.defaults.investments, (reviewed.capital.investments - reviewed.capital.otherClaims) * closing);
    near(normalized.defaults.kd, reviewed.debtCost.interest * reviewed.debtCost.annualization
      / ((reviewed.debtCost.openingDebt + reviewed.debtCost.closingDebt) / 2) * 100);
    assert.deepEqual(input, before);
    assert.deepEqual(normalized.history, before.history);
    assert.equal(normalized.quotedTtm.ebitda, before.ttm.ebitda);
    const result = calculate(normalized);
    assert.equal(result.reason, null);
    near(result.EquityVal, result.ModelEV - normalized.defaults.debt + normalized.defaults.cash
      + normalized.defaults.investments - normalized.defaults.minority - normalized.defaults.preferred);
    near(result.fairVal, result.EquityVal / input.defaults.shares);
  });

  test(`${ticker}: reviewed inputs never bypass missing FX, future evidence or changed financial content`, () => {
    assert.equal(normalize({ ...corporateSource(), reason: 'missingFx' }).reason, 'missingFx');
    assert.equal(normalize({ ...corporateSource(), valuationDate: '2026-01-01' }).reason, 'officialReconciliationRequired');
    const changed = structuredClone(statements);
    changed.annual.income[0].revenue++;
    assert.equal(reconcileValuation(corporateSource(), changed, review(), rates).reason, 'officialReconciliationRequired');
    if (ticker === '0700.HK') assert.equal(reconcileValuation(corporateSource(), statements, review(), {}).reason, 'missingFx');
    const missing = review();
    delete missing.capital.otherClaims;
    assert.throws(() => reconcileValuation(corporateSource(), statements, missing, rates), /invalid official/);
    const gap = review();
    gap.flows[0].start = '2025-08-01';
    assert.equal(reconcileValuation(corporateSource(), statements, gap, rates).reason, 'officialReconciliationRequired');
  });

  test(`${ticker}: issuer-specific lease and portfolio treatments are not generic zero-filled overrides`, () => {
    const normalized = normalize(corporateSource()), result = calculate(normalized);
    assert.equal(result.reason, null);
    if (ticker === '0700.HK') {
      assert.equal(reviewed.flows.reduce((sum, row) => sum + row.newNoncashLeaseAssets, 0), 6839 - 2658 + 3974);
      assert.equal(reviewed.flows.reduce((sum, row) => sum + row.cashCapex, 0), 112875 - 57451 + 107163);
      assert.equal(reviewed.capital.workingCapital, 175052 - 394519 + 71 - 3582 - 796 - 2127);
      assert.equal(reviewed.capital.otherClaims, 1813 + 2072 + 1331 + 4403 + 4647);
      assert.equal(reviewed.capital.investments, 920502 + 28041 + 9658 + 3051 + 3196 + 760 + 4717 + 11389 + 2582);
      near(normalized.ytd.capex, (107163 + 3974) * 1.17);
      assert.equal(result.annuals[0].sources.revenue, 'analyst');
      assert.equal(normalized.defaults.depreciationBasis, 'ttm');
    } else if (ticker === '0388.HK') {
      assert.equal(normalized.ttm.ebit, 21228 - 1870 - 50);
      assert.equal(normalized.ttm.capex, 3148 + 1733 + 112);
      assert.equal(normalized.defaults.cash, 20676 - 1323 - 532);
      assert.equal(normalized.ttm.workingCapital, 68691 - 43088 - 21688 - 350 - 715
        - (50846 - 45637 - 532) - 1593 - 151 + 1817 + 2276 - 78);
      near(normalized.forecasts[0].revenue, 32000 * (1 - 1870 / 29161));
      near(normalized.forecasts[0].ebitda, 26000 - 32000 * 1920 / 29161);
      assert.equal(result.annuals[0].sources.revenue, 'exCorporateInvestmentIncome');
      assert.equal(result.annuals[0].sources.ebitda, 'exCorporateInvestmentIncome');
      assert.deepEqual(normalized.forecasts[0].unnormalizedConsensus, { revenue: 32000, ebit: 24000, ebitda: 26000 });
      assert.deepEqual(normalize(normalized).forecasts, normalized.forecasts, 'Repeated reconciliation cannot strip portfolio income twice');
    } else {
      assert.equal(normalized.ttm.reportingFrequency, 'annual');
      assert.deepEqual(normalized.ttm.dates, ['2026-03-31']);
      assert.equal(normalized.balance.date, '2026-03-31');
      assert.equal(normalized.quotedCapital.date, '2026-06-30');
      const annualFx = rateFor(rates, 'CNY', '2025-04-01', '2026-03-31', 'average', 'HKD').rate;
      near(normalized.ttm.ebit, (50150 + 9515 - 1848) * annualFx);
      near(normalized.ttm.depreciation, (37067 + 5079) * annualFx);
      near(normalized.ttm.capex, (126063 + 874) * annualFx);
      assert.equal(normalized.balance.leaseDebt, 0, 'US GAAP operating rentals are retained in expense, not capitalized again');
      assert.equal(reviewed.capital.debt, 28224 + 47450 + 117485 + 55861 + 10976);
      assert.equal(reviewed.capital.workingCapital, 251837 - 4198 + 10964
        - (359893 - 33685 - 4318 - 6192 - 35965 + 236 + 77415 + 4885) + 4091);
      const quoteFx = rateFor(rates, 'CNY', null, '2026-06-30', 'closing', 'HKD').rate;
      near(normalized.quotedCapital.cash, (142914 + 154653) * quoteFx);
      assert.equal(normalized.ttm.reportedFcf, null, 'Current provider FCF cannot masquerade as official annual-model history');
      assert.equal(normalized.ytd.revenue, 0);
      assert.match(normalized.officialReconciliation.noteEn, /not a current TTM/);
    }
  });
}

test('missing components and unsupported lease additions fail explicitly rather than becoming zeros', () => {
  const missing = record();
  delete missing.inputs.cashPropertyAdditions;
  assert.throws(() => prepare(source(), missing), /invalid official valuation/);
  const unsupported = record();
  unsupported.inputs.newNoncashLeaseAssets = 10;
  assert.throws(() => prepare(source(), unsupported), /inconsistent official/);
});
