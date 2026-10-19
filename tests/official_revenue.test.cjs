const assert = require('node:assert/strict');
const { test } = require('node:test');
const { applyOfficialRevenue } = require('../scripts/official_revenue.cjs');
const Scenario = require('../fmp_scenario.js');
const source = require('../cache/hkex_revenue_sources.json');
const statements = require('../cache/financials/0027.HK_statements_v2.json');
const company = require('../cache/company/0027.HK.json');
const market = require('../hk_market_dcf.json');
const row = (rows, date) => rows.find(item => item.date === date);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('official revenue overlay is immutable, idempotent and isolated to reviewed issuers', () => {
  const before = structuredClone(statements);
  const corrected = applyOfficialRevenue(statements, '0027.HK');
  assert.deepEqual(statements, before);
  assert.deepEqual(applyOfficialRevenue(corrected, '0027.HK'), corrected);
  assert.equal(applyOfficialRevenue(statements, '0700.HK'), statements);
  assert.throws(() => applyOfficialRevenue(statements, '1928.HK'), /INVALID_OFFICIAL_REVENUE_SOURCE/);
  assert.deepEqual(corrected.annual.balance, statements.annual.balance);
  assert.deepEqual(corrected.annual.cashflow, statements.annual.cashflow);
  assert.deepEqual(corrected.quarterly.balance, statements.quarterly.balance);
  assert.deepEqual(corrected.quarterly.cashflow, statements.quarterly.cashflow);
  assert.deepEqual(corrected.providerRevenueOriginal, statements.providerRevenueOriginal);
  const raw = { ...statements, annual: { ...statements.annual, income: statements.providerRevenueOriginal.annual },
    quarterly: { ...statements.quarterly, income: statements.providerRevenueOriginal.quarterly },
    qualityWarnings: statements.providerRevenueOriginal.qualityWarnings };
  delete raw.providerRevenueOriginal;
  delete raw.revenueProvenance;
  assert.deepEqual(applyOfficialRevenue(raw, '0027.HK'), corrected);
  assert.ok(!corrected.qualityWarnings.some(item => item.code === 'annualInterimReconciliation' && item.date === '2025-12-31'));
  assert.ok(!corrected.qualityWarnings.some(item => item.code === 'annualInterimReconciliation' && item.date === '2020-12-31'));
  assert.ok([...corrected.annual.income, ...corrected.quarterly.income].every(item => item.revenueCorrection));
  const warning = { code: 'annualInterimReconciliation', date: '2016-12-31', message: 'Unreviewed period' };
  assert.ok(applyOfficialRevenue({ ...statements, qualityWarnings: [...statements.qualityWarnings, warning] }, '0027.HK')
    .qualityWarnings.some(item => item.date === warning.date && item.message === warning.message));
});

test('Sands retains official before-tax net revenue, reported operating profit and income-statement D&A', () => {
  const input = require('../cache/financials/1928.HK_statements_v2.json');
  const before = structuredClone(input);
  const corrected = applyOfficialRevenue(input, '1928.HK');
  assert.deepEqual(input, before);
  assert.deepEqual(applyOfficialRevenue(corrected, '1928.HK'), corrected);
  const annual = row(corrected.annual.income, '2025-12-31');
  assert.equal(annual.revenue, 7443000000);
  assert.equal(annual.operatingIncome, 1231000000);
  assert.equal(annual.depreciationAndAmortization, 792000000);
  assert.equal(annual.ebitda, 2023000000);
  const original = row(corrected.providerRevenueOriginal.annual, annual.date);
  assert.equal(original.depreciationAndAmortization, annual.depreciationAndAmortization);
  assert.equal(original.ebit, 1299000000);
  assert.equal(original.ebitda, 2091000000);
  assert.equal(original.ebitda, original.ebit + original.depreciationAndAmortization);
  assert.ok([...corrected.annual.income, ...corrected.quarterly.income].every(item => item.revenueCorrection));
  assert.equal(annual.grossProfit, null);
  assert.equal(annual.netIncome, 896000000);
  assert.equal(annual.reportedCurrency, 'USD');
  assert.equal(row(corrected.quarterly.income, '2026-06-30').revenue, 3879000000);
  assert.equal(row(corrected.quarterly.income, '2025-12-31').revenue, 3951000000);
  assert.equal(row(corrected.quarterly.income, '2025-12-31').depreciationAndAmortization, 397000000);
  assert.deepEqual(corrected.annual.cashflow, input.annual.cashflow);
  assert.deepEqual(corrected.annual.balance, input.annual.balance);
  assert.ok(Scenario.verifiedRevenueCorrection('1928.HK', annual, corrected.revenueProvenance));
  const forged = structuredClone(corrected.revenueProvenance);
  forged.documents['sands-2025-annual'].sha256 = 'unverified';
  assert.equal(Scenario.verifiedRevenueCorrection('1928.HK', annual, forged), false);
});

test('all reviewed annual, H1 and derived H2 revenues use one official before-gaming-tax basis', () => {
  for (const period of source.annual) {
    const annual = row(statements.annual.income, period.date);
    const half = row(statements.quarterly.income, period.date.replace('12-31', '06-30'));
    const second = row(statements.quarterly.income, period.date);
    assert.equal(annual.revenue, period.revenue * 1000);
    assert.equal(second.revenue, annual.revenue - half.revenue);
    assert.equal(second.revenueCorrection.derivation, 'officialAnnualMinusOfficialH1');
    assert.equal(annual.grossProfit, null);
    assert.equal(annual.costOfRevenue, null);
    for (const [ratio, numerator] of Object.entries({ operatingIncomeRatio: 'operatingIncome',
      incomeBeforeTaxRatio: 'incomeBeforeTax', netIncomeRatio: 'netIncome', ebitdaRatio: 'ebitda' })) {
      close(annual[ratio], annual[numerator] / annual.revenue);
    }
  }
  for (const period of source.halfYear) {
    assert.equal(row(statements.quarterly.income, period.date).revenue, period.revenue * 1000);
  }
  const latest = row(statements.annual.income, '2025-12-31');
  assert.equal(latest.revenue - 19650710000, row(statements.providerRevenueOriginal.annual, latest.date).revenue);
  const interim = row(statements.quarterly.income, '2026-06-30');
  assert.equal(interim.revenue - 9872440000, row(statements.providerRevenueOriginal.quarterly, interim.date).revenue);
  close((latest.revenue / 43432373000 - 1) * 100, 13.377007975134125);
  close((43432373000 / 35684253000 - 1) * 100, 21.71299480473923);
  assert.equal(interim.revenue + row(statements.quarterly.income, '2025-12-31').revenue, 50227310000);
  assert.equal(market['0027.HK'].statements_raw.income.revenue.at(-2), 49242.325);
  assert.equal(market['0027.HK'].statements_raw.income.revenue.at(-1), 50227.31);
  assert.equal(market['0027.HK'].statements_raw.income.grossProfitRatio.at(-1), null);
});

test('reviewed operating profit and EBITDA reconcile without fabricating gross profit or adjusted EBITDA', () => {
  for (const [periods, rows] of [[source.annual, statements.annual.income], [source.halfYear, statements.quarterly.income]]) {
    for (const official of periods.filter(item => item.operatingCosts)) {
      const actual = row(rows, official.date);
      const costs = Object.values(official.operatingCosts).reduce((sum, value) => sum + value, 0) * 1000;
      assert.equal(actual.operatingIncome, actual.revenue - costs);
      assert.equal(actual.ebit, actual.operatingIncome);
      assert.equal(actual.ebitda, actual.operatingIncome + actual.depreciationAndAmortization);
      assert.equal(actual.grossProfitRatio, null);
      assert.match(actual.revenueCorrection.operatingBasis, /not adjusted EBITDA/);
    }
  }
  assert.equal(row(statements.annual.income, '2025-12-31').operatingIncome, 9570093000);
  assert.equal(row(statements.annual.income, '2024-12-31').operatingIncome, 7819298000);
  assert.equal(row(statements.quarterly.income, '2025-06-30').operatingIncome, 4488496000);
  assert.equal(row(statements.quarterly.income, '2026-06-30').operatingIncome, 4488562000);
});

test('earlier Galaxy core operating profits reconcile to official pretax profit after excluding other income and investees', () => {
  const bridges = [
    ['2018-12-31', 13613769, 1146210, 387585, 35, 138775],
    ['2019-12-31', 13283819, 1113294, 532173, -18, 129326],
    ['2020-12-31', -3762615, 979237, 452691, 73, 38057],
    ['2021-12-31', 1521052, 1101301, 382666, -29, 67963],
    ['2022-12-31', -3352290, 285362, -89806, 164, 106436],
    ['2023-12-31', 6976918, 789574, 85027, 81, 183317],
    ['2011-06-30', 407790, 71962, 79324, 0, 91573, 164718],
    ['2012-06-30', 3479822, 131817, 49292, 1074, 303768],
    ['2013-06-30', 4664938, 177774, 46836, 641, 199152],
    ['2014-06-30', 6115782, 97501, 77997, 518, 16610],
    ['2015-06-30', 2053040, 130176, 31348, 387, 19407],
    ['2016-06-30', 2599369, 75970, 21663, 834, 16391],
    ['2017-06-30', 4688755, 221105, 118024, -75, 31596],
    ['2018-06-30', 7326481, 672463, 185420, 0, 52806],
    ['2019-06-30', 6792752, 582778, 275028, -3, 89501],
    ['2020-06-30', -2730786, 326082, 199842, 79, 16128],
    ['2021-06-30', 1009761, 553138, 191778, -13, 28958],
    ['2022-06-30', -802005, 377045, 51744, 79, 42002],
    ['2023-06-30', 2944395, 265804, 45360, -27, 122915]
  ];
  for (const [date, pretax, otherIncome, jointVentures, associates, financeCosts, derivativeLoss = 0] of bridges) {
    const rows = date.endsWith('06-30') ? statements.quarterly.income : statements.annual.income;
    assert.equal(row(rows, date).operatingIncome,
      (pretax - otherIncome - jointVentures - associates + financeCosts + derivativeLoss) * 1000, date);
  }
});

test('incompatible before/after-commission costs do not fabricate a reconstructed H2', () => {
  const incompatible = structuredClone(source);
  incompatible.halfYear.find(item => item.date === '2021-06-30').operatingCosts.commissions = 100;
  const corrected = applyOfficialRevenue(statements, '0027.HK', incompatible);
  assert.deepEqual(row(corrected.quarterly.income, '2021-12-31'),
    row(corrected.providerRevenueOriginal.quarterly, '2021-12-31'));
  assert.ok(corrected.qualityWarnings.some(item => item.code === 'officialOperatingCostBasisMismatch'
    && item.date === '2021-12-31'));
});

test('new scenarios use official revenue, corrected actual ratios and genuine consensus without changing native models', () => {
  assert.equal(company.forecastBase.revenue, 49242325000);
  assert.equal(company.analystEstimates.reason, null);
  const cashflow = row(statements.annual.cashflow, '2025-12-31');
  close(company.forecastActuals.latest.items.cfo.percent,
    (cashflow.operatingCashFlow ?? cashflow.netCashProvidedByOperatingActivities) / 49242325000 * 100);
  close(company.forecastActuals.latest.items.capex.percent, cashflow.capitalExpenditure / 49242325000 * 100);
  close(company.forecastActuals.latest.items.da.percent, 3794212000 / 49242325000 * 100);
  assert.equal(company.forecastActuals.latest.items.ebit.provenance.documents[0].id, 'galaxy-2025-annual');
  const before = structuredClone(company.models);
  for (const kind of ['advanced', 'customLevered']) {
    const scenario = Scenario.defaults(company, kind, 4375000000);
    assert.equal(scenario.baseRevenue, 49242325000);
    assert.equal(scenario.baseRevenueSource, 'officialReportedRevenue');
    const consensus = company.analystEstimates.rows.find(item => item.date === '2026-12-31');
    close(scenario.years[0].values.growth, (consensus.revenueAvg / scenario.baseRevenue - 1) * 100);
    for (const key of kind === 'advanced' ? ['da', 'capex'] : ['cfo', 'capex']) {
      close(scenario.years[0].values[key], company.forecastActuals.latest.items[key].percent);
    }
    assert.throws(() => Scenario.calculate(scenario), /SCENARIO_INCOMPLETE_ASSUMPTIONS/);
  }
  const mean = company.forecastActuals.workingCapitalYears.reduce((sum, year) => {
    const annual = statements.annual.income.find(item => Number(item.fiscalYear) === year);
    const cashflow = row(statements.annual.cashflow, annual.date);
    return sum - cashflow.changeInWorkingCapital / annual.revenue * 100;
  }, 0) / 5;
  close(company.forecastActuals.workingCapital.nwcChange, mean);
  assert.equal(company.models.advanced.data.find(item => Number(item.year) === 2025).revenue, 29591615000);
  assert.deepEqual(company.models, before);
});

test('baseline verification accepts original or subsequently corrected native revenue but rejects mismatched correction metadata', () => {
  assert.equal(Scenario.baseSource(company, statements).revenue, 49242325000);
  const updated = structuredClone(company);
  for (const model of updated.models.advanced.data) {
    if (Number(model.year) === 2025) model.revenue = 49242325000;
  }
  assert.equal(Scenario.baseSource(updated, statements).revenue, 49242325000);
  for (const [key, value] of [['symbol', '1928.HK'], ['reportedRevenue', 1], ['basis', 'unverified']]) {
    const changed = structuredClone(statements);
    row(changed.annual.income, '2025-12-31').revenueCorrection[key] = value;
    assert.throws(() => Scenario.baseSource(company, changed), /SCENARIO_REVENUE_SOURCE_UNVERIFIED/);
  }
  const wrong = structuredClone(source);
  wrong.annual[0].sourceId = 'missing';
  assert.throws(() => applyOfficialRevenue(statements, '0027.HK', wrong), /INVALID_OFFICIAL_REVENUE_SOURCE/);
});
