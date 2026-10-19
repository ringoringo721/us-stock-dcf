const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyOfficialRevenue } = require('../scripts/official_revenue.cjs');
const Scenario = require('../fmp_scenario.js');
const { flowValue, statementTable } = require('../scripts/build_hkex.cjs');
const { buildAnalystSources } = require('../scripts/analyst_sources.cjs');
const FcfRatios = require('../fcf_ratios.js');
const Overview = require('../profile_overview.js');
const Models = require('../fmp_models.js');

function fixture() {
  const symbol = '9999.HK';
  const period = (date, start, length, revenue) => ({ date, periodStartDate: start, periodLength: length,
    sourceId: 'synthetic', comparabilityGroup: 'continuing-v1', operatingIncomeBasis: 'reported', revenue,
    income: { grossProfit: revenue * 2 / 3, costOfRevenue: revenue / 3,
      operatingIncome: revenue / 5, depreciationAndAmortization: revenue / 10,
      netIncome: revenue / 12, incomeBeforeTax: revenue / 10, incomeTaxExpense: revenue / 60 },
    perShare: { eps: 0.125, epsdiluted: 0.12 } });
  const source = { symbol, currency: 'USD', unit: 'millions', basisCode: 'issuerReportedConsolidatedRevenue',
    basis: 'Synthetic schema fixture, not issuer financial facts', grossProfitPolicy: 'reported',
    incomeHistoryPolicy: 'reviewedPeriodsOnly', ebitdaBasis: 'reportedOperatingIncomePlusReportedDA',
    documents: { synthetic: { url: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0101/2026010100001.pdf',
      sha256: 'a'.repeat(64), pdfPages: [1] } },
    annual: [period('2025-03-31', '2024-01-01', 15, 150), period('2026-03-31', '2025-04-01', 12, 120)],
    halfYear: [period('2024-09-30', '2024-01-01', 9, 90), period('2025-09-30', '2025-04-01', 6, 60),
      period('2026-09-30', '2026-04-01', 6, 66)],
    limitations: 'Synthetic fixture only' };
  const original = { symbol, date: '2025-12-31', fiscalYear: '2025', calendarYear: '2025',
    period: 'FY', reportedCurrency: 'USD', revenue: 999e6, operatingIncome: 888e6, eps: 9, periodLength: 12 };
  const statements = { calculationCurrency: 'HKD', reportingFrequency: 'semiannual',
    statementFrequencies: { income: 'semiannual', balance: 'semiannual', cashflow: 'semiannual' },
    annual: { income: [original], balance: [], cashflow: [] },
    quarterly: { income: [{ ...original, date: '2025-06-30', period: 'Q2', periodLength: 6 }],
      balance: [], cashflow: [] }, qualityWarnings: [] };
  return { symbol, source, statements };
}

test('canonical official periods replace misdated provider income without converting a 15-month transition into a full FY', () => {
  const f = fixture(), original = structuredClone(f.statements);
  const corrected = applyOfficialRevenue(f.statements, f.symbol, f.source);
  assert.deepEqual(f.statements, original);
  assert.deepEqual(corrected.providerRevenueOriginal.annual, original.annual.income);
  assert.deepEqual(corrected.annual.income.map(row => row.date), ['2025-03-31', '2026-03-31']);
  assert.equal(corrected.annual.income[0].periodLength, 15);
  assert.equal(corrected.annual.income[1].grossProfit, 80e6);
  assert.equal(corrected.annual.income[1].costOfRevenue, 40e6);
  assert.equal(corrected.annual.income[1].operatingIncome, 24e6);
  assert.equal(corrected.annual.income[1].eps, 0.125, 'Per-share units are not multiplied by millions');
  assert.equal(corrected.annual.income[1].epsDiluted, 0.12, 'Earnings trends receive the reviewed diluted-EPS alias');
  const second = corrected.quarterly.income.find(row => row.date === '2025-03-31');
  assert.equal(second.periodLength, 6, 'A verified 15-minus-9-month remainder is six months, not two fictitious half years');
  assert.equal(second.revenue, 60e6);
  assert.equal(second.eps, null, 'Annual EPS minus first-interim EPS is not valid H2 EPS');
  assert.equal(corrected.quarterly.income.find(row => row.date === '2024-09-30').periodLength, 9);
  assert.equal(flowValue(corrected, 'income', 'revenue'), 126e6);
  assert.ok(Scenario.verifiedRevenueCorrection(f.symbol, corrected.annual.income[1], corrected.revenueProvenance));
});

test('unmatched restatements retain real H1 records but do not invent H2', () => {
  const f = fixture();
  f.source.halfYear[1].comparabilityGroup = 'discontinued-operation-restatement';
  const corrected = applyOfficialRevenue(f.statements, f.symbol, f.source);
  assert.ok(corrected.quarterly.income.some(row => row.date === '2025-09-30'));
  assert.ok(!corrected.quarterly.income.some(row => row.date === '2026-03-31'));
  assert.ok(corrected.qualityWarnings.some(row => row.code === 'officialIncomeReconstructionUnavailable'
    && row.date === '2026-03-31'));
  assert.equal(flowValue(corrected, 'income', 'revenue'), null);
});

test('unknown FY duration cannot enter consensus or bypass the scenario guard via cached currency evidence', () => {
  const f = fixture();
  delete f.source.annual[1].periodLength;
  const corrected = applyOfficialRevenue(f.statements, f.symbol, f.source);
  const data = { symbol: f.symbol, currency: 'USD', capturedAt: '2026-10-19T00:00:00Z',
    currencyCheck: { reason: null, sourceDate: '2026-03-31', sourcePeriodLength: 12,
      sourceCurrency: 'USD', originalRevenue: 120e6, modelRevenue: 120e6, fx: { price: 1 } },
    models: { advanced: { data: [{ year: '2026', revenue: 120e6 }] } } };
  assert.equal(Scenario.baseSource(data, corrected).reason, 'SCENARIO_BASE_UNVERIFIED');
  data.forecastBase = { date: '2026-03-31', year: 2026 };
  assert.equal(Scenario.actualReference(data, corrected).reason, 'ACTUAL_PERIOD_NOT_FULL_YEAR');
  assert.equal(buildAnalystSources(data, corrected, { ok: true, rows: [] }, data.capturedAt)
    .analystEstimates.reason, 'ANALYST_ACTUAL_BASE_UNAVAILABLE');
  assert.equal(Scenario.fullAnnualPeriod({ symbol: f.symbol, period: 'FY' }), false);
  assert.equal(Scenario.fullAnnualPeriod({ symbol: 'AAPL', period: 'FY' }), true, 'Legacy US FY cache format remains supported');
});

test('reviewed unavailable D&A is not replaced with an incompatible provider cash-flow add-back', () => {
  const f = fixture();
  f.source.annual[1].income.depreciationAndAmortization = null;
  const corrected = applyOfficialRevenue(f.statements, f.symbol, f.source);
  corrected.annual.cashflow.push({ symbol: f.symbol, date: '2026-03-31', reportedCurrency: 'USD',
    fiscalYear: '2026', period: 'FY', periodLength: 12, depreciationAndAmortization: 999e6 });
  const actual = Scenario.actualReference({ currency: 'USD' }, corrected, { date: '2026-03-31', year: 2026 });
  assert.equal(actual.reason, null);
  assert.equal(actual.items.da.amount, null);
  assert.equal(corrected.annual.income[1].ebitda, null);
});

test('transition returns and unverified-duration cash flows are unavailable rather than normal annual or TTM ratios', () => {
  const f = fixture(), corrected = applyOfficialRevenue(f.statements, f.symbol, f.source);
  const income = corrected.annual.income[0];
  corrected.annual.balance.push({ ...income, totalAssets: 300e6, totalStockholdersEquity: 100e6 });
  const columns = FcfRatios.calculateReturns(corrected, { period: 'annual', flow: 'single', balance: 'ending' });
  const transition = columns.find(row => row.date === '2025-03-31');
  assert.match(transition.label, /15M/);
  assert.equal(transition.ratios.roe.value, null);
  assert.equal(transition.ratios.roe.reason, 'invalidPeriodLength');
  const historical = structuredClone(corrected);
  historical.quarterly.income = historical.quarterly.income.filter(row => row.date <= '2025-03-31');
  assert.equal(Overview.calculate(historical).revenue, null, 'Nine plus six months is not twelve-month revenue');
});

test('continuing revenue never creates a net margin from total discontinued-operation profit', () => {
  const f = fixture();
  for (const row of [...f.source.annual, ...f.source.halfYear]) row.earningsIncludeDiscontinued = true;
  let corrected = applyOfficialRevenue(f.statements, f.symbol, f.source);
  assert.equal(corrected.annual.income[1].netIncomeRatio, null);
  assert.equal(flowValue(corrected, 'income', 'netIncomeRatio'), null);
  assert.equal(Overview.calculate(corrected).netMargin, null);
  for (const row of [...f.source.annual, ...f.source.halfYear]) row.income.netIncomeFromContinuingOperations = row.revenue / 20;
  corrected = applyOfficialRevenue(f.statements, f.symbol, f.source);
  assert.equal(corrected.annual.income[1].netIncomeRatio, 0.05);
  assert.equal(flowValue(corrected, 'income', 'netIncomeRatio'), 0.05);
  assert.equal(Overview.calculate(corrected).netMargin, 5);
  assert.equal(corrected.annual.income[1].netIncome, 10e6, 'Reported total parent NI is not overwritten');
});

test('mixed financial/gaming and equity-accounted investments do not masquerade as one verified corporate DCF', () => {
  const stock = { ticker: '8279.HK', corporateDcfApplicability: 'requiresSegmentValuation' };
  assert.equal(Models.dcfApplicable(stock), false);
  assert.equal(Models.value(null, 'advanced', stock).reason, 'FMP_SEGMENT_VALUATION_REQUIRED');
  assert.equal(Models.reference({ symbol: stock.ticker }, 'dcf', stock), null);
  assert.match(Models.reasonText('FMP_SEGMENT_VALUATION_REQUIRED', 'en'), /segment valuation/);
});

test('a genuine twelve-month second interim is preserved as I2, never relabeled as a half year or an audited FY', () => {
  const f = fixture();
  f.source.interimPeriods = [{ ...structuredClone(f.source.halfYear[0]), date: '2024-12-31',
    periodLength: 12, revenue: 120, reportType: 'secondInterim' }];
  const corrected = applyOfficialRevenue(f.statements, f.symbol, f.source);
  const interim = corrected.quarterly.income.find(row => row.date === '2024-12-31');
  assert.equal(interim.reportType, 'secondInterim');
  assert.equal(interim.periodLength, 12);
  assert.equal(interim.revenue, 120e6);
  assert.equal(interim.revenueCorrection.derivation, 'issuerReportedSecondInterim');
  assert.ok(!corrected.annual.income.some(row => row.date === interim.date));
  assert.equal(Scenario.fullAnnualPeriod(interim), false);
  const table = statementTable(corrected);
  assert.equal(table.quarterly_raw.periods[table.quarterly_raw.dates.indexOf('2024-12')], '2025I2');
  assert.equal(table.annual_dates.length, 6, 'Unavailable older annual columns are padded, not shifted into the TTM slot');
  assert.deepEqual(table.annual_dates.slice(0, 3), [null, null, null]);
  const earnings = FcfRatios.calculateEarnings(corrected, { flow: 'single' }).find(row => row.date === interim.date);
  assert.match(earnings.label, /2025I2.*12M/);
});

test('reviewed source guards reject duplicate interim dates, inconsistent month counts and untrusted document hosts', () => {
  const f = fixture();
  const duplicate = structuredClone(f.source);
  duplicate.interimPeriods = [{ ...duplicate.halfYear[0], reportType: 'secondInterim' }];
  assert.throws(() => applyOfficialRevenue(f.statements, f.symbol, duplicate));
  const wrongMonths = structuredClone(f.source);
  wrongMonths.annual[0].periodLength = 12;
  assert.throws(() => applyOfficialRevenue(f.statements, f.symbol, wrongMonths));
  const document = { url: 'https://www.sjmholdings.com/resources/images/uploads/intrep2009.pdf',
    sha256: 'a'.repeat(64), pdfPages: [1, 3] };
  assert.equal(Scenario.verifiedIncomeDocument(document), true);
  assert.equal(Scenario.verifiedIncomeDocument({ ...document, url: document.url.replace('https:', 'http:') }), false);
  assert.equal(Scenario.verifiedIncomeDocument({ ...document, url: document.url.replace('intrep2009.pdf', 'unreviewed.pdf') }), false);
  assert.equal(Scenario.verifiedIncomeDocument({ ...document, url: document.url.replace('www.sjmholdings.com', 'example.com') }), false);
  assert.equal(Scenario.verifiedIncomeDocument({ ...document, pdfPages: [0] }), false);
});
