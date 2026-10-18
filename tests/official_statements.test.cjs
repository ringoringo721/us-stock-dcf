const test = require('node:test');
const assert = require('node:assert/strict');
const { applyOfficialBalance } = require('../scripts/official_balance.cjs');
const { applyOfficialCashflows, reviewedSource } = require('../scripts/official_cashflows.cjs');
const { flowValue, statementTable } = require('../scripts/build_hkex.cjs');
const ratios = require('../fcf_ratios.js');
const review = require('../cache/hkex_balance_classifications.json');

function statements(ticker) {
  const income = Array.from({ length: 8 }, (_, index) => {
    const year = 2025 + Math.floor(index / 4), quarter = index % 4 + 1;
    const month = quarter * 3;
    return { symbol: ticker, fiscalYear: String(year), period: `Q${quarter}`,
      date: `${year}-${String(month).padStart(2, '0')}-${quarter % 2 ? '30' : '31'}`,
      reportedCurrency: ticker === '0005.HK' ? 'USD' : 'HKD',
      revenue: 100, netIncome: 10, ebitda: 20, weightedAverageShsOutDil: 10, epsDiluted: 1 };
  }).slice(0, 6).map(row => ({ ...row, date: row.date.replace('06-31', '06-30') }));
  return { reportingFrequency: 'quarterly', calculationCurrency: ticker === '0005.HK' ? 'USD' : 'HKD',
    statementFrequencies: { income: 'quarterly', cashflow: 'annual', balance: 'quarterly' },
    annual: { income: [{ ...income[3], period: 'FY' }], cashflow: [],
      balance: review.periods.slice(0, 1).map(period => ({ symbol: ticker, date: period.date, reportedCurrency: 'HKD',
        fiscalYear: '2025', period: 'FY', totalAssets: period.fields.totalAssets * 1e6,
        totalLiabilities: period.fields.totalLiabilities * 1e6,
        totalStockholdersEquity: period.fields.totalStockholdersEquity * 1e6 })) },
    quarterly: { income, cashflow: [], balance: income.map(row => ({ ...row, totalAssets: 1000 })) } };
}

test('HKEX official classification reconciles all components, preserves provider evidence and avoids duplicate leases', () => {
  const data = statements('0388.HK');
  for (const row of data.quarterly.balance) {
    const report = review.periods.find(period => period.date === row.date);
    if (report) Object.assign(row, {
      totalAssets: report.fields.totalAssets * 1e6, totalLiabilities: report.fields.totalLiabilities * 1e6,
      totalStockholdersEquity: report.fields.totalStockholdersEquity * 1e6 });
  }
  const out = applyOfficialBalance(data, '0388.HK');
  const latest = out.quarterly.balance.at(-1), annual = out.annual.balance[0];
  assert.equal(latest.totalCurrentAssets, 539820e6);
  assert.equal(latest.totalNonCurrentAssets, 37258e6);
  assert.equal(latest.totalCurrentLiabilities, 513308e6);
  assert.equal(latest.totalNonCurrentLiabilities, 2819e6);
  assert.equal(latest.deferredRevenue, 1044e6);
  assert.equal(latest.deferredRevenueNonCurrent, 420e6);
  assert.equal(latest.accountsReceivables, null);
  assert.equal(latest.goodwill, null);
  assert.equal(latest.propertyPlantEquipmentNet, 1953e6);
  assert.equal(latest.rightOfUseAssets, 5441e6);
  assert.equal(latest.accumulatedOtherComprehensiveIncomeLoss, -188e6);
  assert.equal(latest.employeeShareBasedCompensationReserve, 604e6);
  assert.equal(latest.otherTotalStockholdersEquity, 2216e6);
  assert.equal(latest.acceptedDate, null);
  assert.equal(latest.availabilityBasis, 'retrospectiveOfficialCorrectionNotPointInTime');
  assert.equal(annual.totalDebt, 1249e6);
  assert.equal(latest.totalDebt, 946e6);
  assert.equal(out.archivedProviderBalance.length, 3);
  assert.equal(data.quarterly.balance.at(-1).totalCurrentAssets, undefined);
  assert.equal(out.quarterly.balance[0], data.quarterly.balance[0]);
  const changed = structuredClone(data);
  changed.quarterly.balance.at(-1).totalAssets += 1e6;
  assert.throws(() => applyOfficialBalance(changed, '0388.HK'), /PROVIDER_COMPARISON_CHANGED/);
  const invalid = structuredClone(review);
  invalid.periods[0].fields.totalCurrentAssets++;
  assert.throws(() => applyOfficialBalance(data, '0388.HK', invalid), /DOES_NOT_RECONCILE/);
  assert.equal(applyOfficialBalance(data, '0700.HK'), data);
});

for (const [ticker, cfo, investment, opening, closing] of [
  ['0388.HK', 22708, -4672, 18470, 19114],
  ['0005.HK', 98346, -5209, 428907, 424272]
]) {
  test(`${ticker} official FY/H1 produce genuine mixed-cadence TTM with closing cash, not fabricated quarters`, () => {
    const out = applyOfficialCashflows(statements(ticker), ticker, reviewedSource(ticker));
    assert.deepEqual(out.quarterly.cashflow.map(row => row.period), ['Q2', 'Q4', 'Q2']);
    assert.equal(out.quarterly.cashflow[1].derivation, 'annualMinusOfficialH1');
    assert.equal(flowValue(out, 'cashflow', 'operatingCashFlow'), cfo * 1e6);
    assert.equal(flowValue(out, 'cashflow', 'capitalExpenditure'), investment * 1e6);
    assert.equal(flowValue(out, 'cashflow', 'cashAtBeginningOfPeriod'), opening * 1e6);
    assert.equal(flowValue(out, 'cashflow', 'cashAtEndOfPeriod'), closing * 1e6);
    assert.equal(flowValue(out, 'cashflow', 'netIncome'), null);
    if (ticker === '0005.HK') {
      assert.equal(flowValue(out, 'cashflow', 'commonDividendsPaid'), -12850e6);
      assert.equal(flowValue(out, 'cashflow', 'dividendsPaidToParentShareholdersAndNonControllingInterests'), -14429e6);
      assert.equal(flowValue(out, 'cashflow', 'changeInOperatingAssets'), null);
    }
    assert.equal(flowValue(out, 'cashflow', 'depreciationAndAmortization'), null);
    assert.equal(out.quarterly.cashflow[1].periodStartDate, '2025-07-01');
    assert.equal(out.quarterly.cashflow[1].periodLength, 6);
    assert.equal(statementTable(out).cashflow.operatingCashFlow.at(-1), cfo);
    const result = ratios.calculate(out).at(-1);
    assert.equal(result.date, '2026-06-30');
    assert.equal(result.ratios.sales.value, (cfo + investment) * 1e6 / 400 * 100);
    assert.equal(ratios.calculateEarnings(out).at(-1).amounts.fcf.value, (cfo + investment) * 1e6 / 10);
    assert.equal(ratios.calculateEarnings(out, { flow: 'single' }).at(-1).amounts.fcf.reason, 'cadenceMismatch');
    const gap = structuredClone(out);
    gap.quarterly.cashflow.splice(1, 1);
    assert.equal(flowValue(gap, 'cashflow', 'operatingCashFlow'), null);
    const mismatchedCurrency = structuredClone(out);
    mismatchedCurrency.quarterly.cashflow.at(-1).reportedCurrency = 'EUR';
    assert.equal(flowValue(mismatchedCurrency, 'cashflow', 'operatingCashFlow'), null);
    const later = structuredClone(out);
    later.quarterly.income.push({ ...later.quarterly.income.at(-1), date: '2026-09-30', period: 'Q3' });
    assert.equal(flowValue(later, 'cashflow', 'operatingCashFlow'), null);
    assert.equal(applyOfficialCashflows(out, ticker, reviewedSource(ticker)).quarterly.cashflow.length, 3);
    const invalid = reviewedSource(ticker);
    invalid.periods[0].fields.operatingCashFlow++;
    assert.throws(() => applyOfficialCashflows(statements(ticker), ticker, invalid), /INVALID_OFFICIAL/);
  });
}
