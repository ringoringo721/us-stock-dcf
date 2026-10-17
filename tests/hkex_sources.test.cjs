const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareStatements, flowValue, priceHistory, compileStock } = require('../scripts/build_hkex.cjs');
const { convertStatements } = require('../usd_currency.js');

function evidence(half = false) {
  const ticker = half ? '0823.HK' : '0700.HK';
  const responses = {};
  for (const type of ['income', 'balance', 'cashflow']) {
    const annual = [2024, 2025, 2026].map(year => ({
      symbol: ticker, fiscalYear: String(year), period: 'FY', reportedCurrency: 'HKD',
      date: `${year}-${half ? '03-31' : '12-31'}`, revenue: 100, epsDiluted: 4,
      weightedAverageShsOut: 10, operatingCashFlow: 20, capitalExpenditure: -2,
      netCashProvidedByInvestingActivities: -2, netCashProvidedByFinancingActivities: -5,
      depreciationAndAmortization: 2, cashAtBeginningOfPeriod: 10, cashAtEndOfPeriod: 23
    })).filter(row => row.date <= '2026-10-17');
    const rows = half ? [2024, 2025, 2026].flatMap(year => [
      { ...annual[0], date: `${year - 1}-09-30`, fiscalYear: String(year), period: 'Q2', revenue: 45,
        epsDiluted: 2, weightedAverageShsOut: 9, operatingCashFlow: 8, cashAtEndOfPeriod: 15 },
      { ...annual[0], date: `${year}-03-31`, fiscalYear: String(year), period: 'Q4', revenue: 70 }
    ]) : [2024, 2025].flatMap(year => [1, 2, 3, 4].map(quarter => ({
      ...annual[0], fiscalYear: String(year), period: `Q${quarter}`,
      date: `${year}-${['03-31', '06-30', '09-30', '12-31'][quarter - 1]}`, revenue: 25
    })));
    responses[`annual_${type}`] = { ok: true, rows: annual };
    responses[type] = { ok: true, rows };
  }
  return { ticker, providerSymbol: ticker, capturedAt: '2026-10-17T00:00:00Z', responses };
}
test('Semiannual TTM derives actual H2 from FY minus H1 before FX; no quarters or half-year EPS are invented', () => {
  const raw = prepareStatements(evidence(true));
  assert.equal(raw.reportingFrequency, 'semiannual');
  assert.ok(raw.quarterly.income.every(row => ['Q2', 'Q4'].includes(row.period)));
  const latest = raw.quarterly.income.at(-1);
  assert.equal(latest.revenue, 55);
  assert.equal(latest.derivation, 'annualMinusReportedH1');
  assert.equal(latest.periodStartDate, '2025-10-01');
  assert.equal(latest.epsDiluted, null);
  assert.equal(latest.weightedAverageShsOut, null);
  const data = convertStatements(raw, null);
  assert.equal(flowValue(data, 'income', 'revenue'), 100);
  assert.equal(flowValue(data, 'income', 'epsdiluted'), 4, 'The actual full-year EPS remains available');
  assert.equal(raw.quarterly.cashflow.at(-1).cashAtBeginningOfPeriod, 15);
  assert.equal(raw.quarterly.cashflow.at(-1).cashAtEndOfPeriod, 23);
});
test('Unreported quarterly cash-flow placeholders cannot masquerade as true zero CFO or FCF', () => {
  const source = evidence();
  source.responses.cashflow.rows.forEach(row => Object.assign(row, {
    operatingCashFlow: 0, capitalExpenditure: 0, netCashProvidedByInvestingActivities: 0,
    netCashProvidedByFinancingActivities: 0, depreciationAndAmortization: 0
  }));
  const raw = prepareStatements(source);
  assert.equal(raw.quarterly.cashflow.length, 0);
  assert.equal(raw.statementFrequencies.cashflow, 'annual');
  assert.equal(raw.annual.cashflow.at(-1).operatingCashFlow, 20);
  assert.equal(flowValue(raw, 'cashflow', 'operatingCashFlow'), null);
  assert.ok(raw.qualityWarnings.some(row => row.code === 'incompleteCashflowCoverage'));
  assert.equal(raw.unverifiedInterimCashflow.rows.length, 8);
});
test('An actual zero CFO within otherwise disclosed cash flows is retained', () => {
  const source = evidence();
  source.responses.cashflow.rows[0].operatingCashFlow = 0;
  const raw = prepareStatements(source);
  assert.equal(raw.quarterly.cashflow.length, 8);
  assert.equal(raw.quarterly.cashflow[0].operatingCashFlow, 0);
});
test('Incomplete cash-flow constructions retain their original evidence but cannot become quarterly or TTM financials', () => {
  for (const cashBalance of [0, 100]) {
    const source = evidence();
    source.responses.cashflow.rows.forEach(row => Object.assign(row, {
      operatingCashFlow: 1, capitalExpenditure: 0, netCashProvidedByInvestingActivities: 0,
      netCashProvidedByFinancingActivities: 0, cashAtBeginningOfPeriod: cashBalance,
      cashAtEndOfPeriod: cashBalance, netChangeInCash: 0
    }));
    const raw = prepareStatements(source);
    assert.equal(raw.quarterly.cashflow.length, 0);
    assert.equal(raw.statementFrequencies.cashflow, 'annual');
    assert.equal(raw.unverifiedInterimCashflow.rows.length, 8);
    assert.equal(raw.unverifiedInterimCashflow.rows[0].operatingCashFlow, 1);
    assert.equal(flowValue(raw, 'cashflow', 'operatingCashFlow'), null);
  }
});
test('Source identity and future statement dates fail rather than aliasing another company', () => {
  for (const mutate of [
    source => { source.responses.income.rows[0].symbol = 'CSCO'; },
    source => { source.responses.income.rows[0].date = '2030-01-01'; }
  ]) {
    const source = evidence();
    mutate(source);
    assert.throws(() => prepareStatements(source), /invalid/);
  }
});
test('Genuine HK daily prices preserve dates, prices and missing volume and reject foreign symbols', () => {
  const source = { ticker: '0700.HK', capturedAt: '2026-10-17T00:00:00Z', responses: {
    prices_recent: { ok: true, rows: [{ symbol: '0700.HK', date: '2026-10-16', close: 417.8 }] }
  } };
  const prices = priceHistory(source);
  assert.equal(prices.currency, 'HKD');
  assert.deepEqual(prices.rows, [['2026-10-16', 417.8, null]]);
  source.responses.prices_recent.rows[0].symbol = 'CSCO';
  assert.throws(() => priceHistory(source), /invalid/);
});

test('quote-only checks preserve rating dates; actual financial or transcript changes invalidate assessed evidence', () => {
  const source = evidence();
  source.responses.profile = { ok: true, rows: [{ symbol: source.ticker, currency: 'HKD', companyName: 'Fixture company' }] };
  source.responses.quote = { ok: true, rows: [{ symbol: source.ticker, price: 100, marketCap: 10000,
    timestamp: Date.parse('2026-10-16T08:00:00Z') / 1000 }] };
  source.responses.prices_recent = { ok: true, rows: [{ symbol: source.ticker, date: '2026-10-16', close: 100 }] };
  source.responses.transcript_latest = { ok: true, rows: [{ symbol: source.ticker, date: '2026-08-12',
    year: 2026, period: 'Q2', content: 'Fixture call evidence' }] };
  const item = require('../hkex_stocks.json').find(row => row.ticker === source.ticker);
  const rates = { source: 'Fixture FX metadata; financials already HKD', prepared: source.capturedAt };
  const original = compileStock(item, source, rates);
  const report = Object.fromEntries(['m1_brand_pricing', 'm2_patents_regulatory', 'm3_high_switching_costs',
    'm4_network_effects', 'm5_cost_advantage_scale', 'm6_unique_geography_assets', 'm7_operational_efficiency',
    'm8_capital_allocation', 'm9_customer_retention', 'm10_durability'].map(key => [key, { score: null }]));
  const reports = { [source.ticker]: { evidenceHash: original.fingerprint, report, updatedAt: source.capturedAt } };
  const checked = structuredClone(source);
  checked.capturedAt = '2026-10-17T12:00:00Z';
  checked.responses.quote.rows[0].price = 101;
  const unchanged = compileStock(item, checked, rates, reports, original.stock);
  assert.equal(unchanged.fingerprint, original.fingerprint);
  assert.equal(unchanged.stock.ratingSources.fScore.updatedAt, source.capturedAt);
  assert.equal(unchanged.stock.ratingSources.moat.updatedAt, source.capturedAt);
  assert.equal(unchanged.stock.ratingSources.moat.checkedAt, checked.capturedAt);
  assert.equal(unchanged.stock.ratingSources.moat.reason, null);
  checked.responses.transcript_latest.rows[0].content = 'Changed fixture call evidence';
  const changedCall = compileStock(item, checked, rates, reports, original.stock);
  assert.notEqual(changedCall.fingerprint, original.fingerprint);
  assert.equal(changedCall.stock.ratingSources.moat.reason, 'staleEvidence');
  assert.equal(changedCall.stock.ratingSources.fScore.updatedAt, source.capturedAt);
  checked.responses.income.rows.at(-1).netIncome = 8;
  const changedStatement = compileStock(item, checked, rates, reports, original.stock);
  assert.equal(changedStatement.stock.ratingSources.fScore.updatedAt, checked.capturedAt);
});
