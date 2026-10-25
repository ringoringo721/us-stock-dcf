const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareStatements, flowValue, marketMultiples, priceHistory, compileStock, valuationShares, forwardPriceEarnings, applyForecastTaxAssumption, applyNoncontrollingClaimAssumption } = require('../scripts/build_hkex.cjs');
const { convertStatements } = require('../usd_currency.js');
const ccb = require('../hkex_stocks.json').find(row => row.ticker === '0939.HK');
const ccbCapital = require('../cache/hkex_share_capital.json')[ccb.ticker];

function multiplesFixture() {
  return { reportingFrequency: 'semiannual',
    annual: { income: [{ date: '2025-12-31', fiscalYear: '2025', period: 'FY', periodLength: 12, epsdiluted: 3.5 }],
      balance: [], cashflow: [] },
    quarterly: { income: [
      { date: '2025-12-31', fiscalYear: '2025', period: 'Q4', periodLength: 6,
        reportedCurrency: 'HKD', comparabilityGroup: 'same', netIncome: 4e6, epsdiluted: null },
      { date: '2026-06-30', fiscalYear: '2026', period: 'Q2', periodLength: 6,
        reportedCurrency: 'HKD', comparabilityGroup: 'same', netIncome: 6e6, epsdiluted: 2.7 }
    ], balance: [{ date: '2026-06-30', totalStockholdersEquity: 20e6, preferredStock: 0 }], cashflow: [] } };
}

test('a genuine latest twelve-month second interim supplies P/E without adding its overlapping first interim', () => {
  const data = multiplesFixture();
  data.quarterly.income.push({ date: '2026-12-31', fiscalYear: '2026', period: 'Q3',
    periodLength: 12, reportType: 'secondInterim', reportedCurrency: 'HKD',
    netIncome: -7e6, epsdiluted: null });
  const shares = { shares: 2, date: '2027-01-05' };
  const result = marketMultiples(data, 20, shares);
  assert.equal(result.pe_trailing, 20 / -3.5);
  assert.deepEqual(result.marketRatioSources.pe.dates, ['2026-12-31']);
  data.quarterly.income.at(-1).epsdiluted = -4;
  assert.equal(marketMultiples(data, 20, shares).pe_trailing, -5);
  data.quarterly.income.at(-1).periodLength = 9;
  assert.equal(marketMultiples(data, 20, shares).pe_trailing, null);
  data.quarterly.income.at(-1).periodLength = 12;
  data.quarterly.income.at(-1).currencyConversion = { reason: 'missingFxDate' };
  assert.equal(marketMultiples(data, 20, shares).pe_trailing, null);
});

test('semiannual P/E uses real TTM common earnings and dated ordinary shares, never added or stale annual EPS', () => {
  const data = multiplesFixture(), shares = { shares: 2, date: '2026-10-16' };
  const result = marketMultiples(data, 20, shares);
  assert.equal(result.pe_trailing, 4);
  assert.equal(result.marketRatioSources.pe.eps, 5);
  assert.equal(result.marketRatioSources.pe.basis, 'ttmCommonEarningsOverCurrentOrdinaryShares');
  assert.equal(result.pb_trailing, 2);
  assert.deepEqual(result.marketRatioSources.pe.dates, ['2025-12-31', '2026-06-30']);
  data.quarterly.income[0].comparabilityGroup = 'incompatible';
  assert.equal(marketMultiples(data, 20, shares).pe_trailing, null);
});

test('verified issuer-wide shares support P/B; missing classes, preferred earnings and stale prices remain explicit gaps', () => {
  const data = multiplesFixture(), shares = { shares: 2, date: '2026-10-16', scope: 'issuerWideOrdinaryShares' };
  assert.equal(marketMultiples(data, 20, shares, false).pb_trailing, 2);
  const blocked = marketMultiples(data, 20, shares, true);
  assert.equal(blocked.pb_trailing, null);
  assert.equal(blocked.pe_trailing, null);
  assert.equal(blocked.marketRatioSources.pb.reason, 'shareBasisUnverified');
  const mcapFallback = marketMultiples(data, 20, shares, true, 40);
  assert.equal(mcapFallback.pe_trailing, 4);
  assert.equal(mcapFallback.marketRatioSources.pe.basis, 'ttmCommonEarningsOverMarketCap');
  assert.equal(mcapFallback.pb_trailing, 2);
  assert.equal(mcapFallback.marketRatioSources.pb.basis, 'marketCapOverReportedParentEquity');
  data.quarterly.balance[0].preferredStock = 1e6;
  assert.equal(marketMultiples(data, 20, shares).marketRatioSources.pe.reason, 'preferredEarningsUnverified');
  for (const row of data.quarterly.income) row.netIncomeDeductions = 1e6;
  assert.equal(marketMultiples(data, 20, shares).pe_trailing, 5);
  assert.equal(marketMultiples(data, null, shares).pe_trailing, null);
  assert.equal(marketMultiples(data, null, shares).pb_trailing, null);
});

test('Link forecast tax scenario is explicit, adjustable and cannot overwrite actual tax or clear source guards', () => {
  const item = require('../hkex_stocks.json').find(row => row.ticker === '0823.HK');
  const original = { reason: 'leaseClassificationRequired', defaults: { tax: null },
    history: { annual: [{ tax: null }] }, provenance: { tax: 'Observed TTM effective tax' } };
  const snapshot = applyForecastTaxAssumption(original, item);
  assert.equal(snapshot.defaults.tax, 16.5);
  assert.equal(snapshot.forecastTaxAssumption.observedEffectiveTax, null);
  assert.equal(snapshot.forecastTaxAssumption.basis, 'userApprovedHongKongStatutoryForecastScenario');
  assert.match(snapshot.provenance.tax, /not an observed group effective tax/);
  assert.equal(snapshot.reason, original.reason);
  assert.equal(original.defaults.tax, null);
  assert.equal(snapshot.history.annual[0].tax, null);
  for (const tax of [0, 12, 23]) {
    const observed = { ...original, defaults: { tax } };
    assert.equal(applyForecastTaxAssumption(observed, item), observed);
  }
  assert.equal(applyForecastTaxAssumption(original, ccb), original);
  const incomplete = { reason: 'sourceUnavailable' };
  assert.equal(applyForecastTaxAssumption(incomplete, item), incomplete);
  for (const rate of [null, -1, 101, '16.5', NaN, Infinity]) {
    assert.throws(() => applyForecastTaxAssumption(original,
      { ...item, forecastTaxAssumption: { ...item.forecastTaxAssumption, rate } }), /invalid forecast tax assumption/);
  }
});

test('Link zero noncontrolling claim scenario retains negative book evidence and all other source guards', () => {
  const item = require('../hkex_stocks.json').find(row => row.ticker === '0823.HK');
  const original = { reason: 'leaseClassificationRequired', defaults: { minority: -386 },
    history: { annual: [{ minority: -386 }] }, provenance: { priority: 'Book value proxies' } };
  const snapshot = applyNoncontrollingClaimAssumption(original, item);
  assert.equal(snapshot.defaults.minority, 0);
  assert.equal(snapshot.noncontrollingClaimAssumption.reportedBookValue, -386);
  assert.match(snapshot.provenance.priority, /not verified fair value/);
  assert.match(snapshot.provenance.priority, /overstated/);
  assert.equal(snapshot.reason, original.reason);
  assert.equal(original.defaults.minority, -386);
  assert.equal(snapshot.history.annual[0].minority, -386);
  for (const minority of [null, 0, 12, NaN, undefined]) {
    const observed = { ...original, defaults: { minority } };
    assert.equal(applyNoncontrollingClaimAssumption(observed, item), observed);
  }
  assert.equal(applyNoncontrollingClaimAssumption(original, ccb), original);
  for (const value of [null, -1, 1, '0', NaN, Infinity]) {
    assert.throws(() => applyNoncontrollingClaimAssumption(original, {
      ...item, noncontrollingClaimAssumption: { ...item.noncontrollingClaimAssumption, value }
    }), /invalid noncontrolling claim assumption/);
  }
});

function forwardFixture() {
  const ticker = '0700.HK';
  return {
    item: { ticker }, shares: { shares: 10 },
    rates: { currencies: {
      CNY: { observations: [['2026-10-16', 0.16]] },
      HKD: { observations: [['2026-10-16', 0.125]] }
    } },
    source: { capturedAt: '2026-10-17T00:00:00Z', responses: {
      annual_income: { ok: true, rows: [{ symbol: ticker, date: '2025-12-31',
        reportedCurrency: 'CNY', revenue: 100e6, netIncome: 10e6 }] },
      estimates: { ok: true, rows: [
        { symbol: ticker, date: '2027-12-31', revenueAvg: 140e6, netIncomeAvg: 30e6, epsAvg: 3, numAnalystsEps: 5 },
        { symbol: ticker, date: '2025-12-31', revenueAvg: 100e6, netIncomeAvg: 10e6, epsAvg: 1, numAnalystsEps: 5 },
        { symbol: ticker, date: '2026-12-31', revenueAvg: 120e6, netIncomeAvg: 20e6, epsAvg: 2, numAnalystsEps: 5 }
      ] }
    } }
  };
}

test('forward P/E uses the actual next fiscal forecast and matched official cross-currency FX, independent of DCF', () => {
  const f = forwardFixture();
  const result = forwardPriceEarnings(f.item, f.source, f.rates, f.shares, 20);
  assert.equal(result.reason, null);
  assert.equal(result.fiscalDate, '2026-12-31');
  assert.equal(result.epsHkd, 2.56);
  assert.equal(result.value, 7.8125);
  assert.equal(result.fx.observationDate, '2026-10-16');
  assert.match(result.noteEn, /not reported earnings or the DCF share denominator/);
  assert.match(result.noteZh, /分析師預測/);
  f.item.financial = true;
  f.source.responses.annual_income.rows[0].revenue *= 2;
  assert.equal(forwardPriceEarnings(f.item, f.source, f.rates, f.shares, 20).value, result.value,
    'Banks compare earnings, not incompatible gross and net revenue definitions');
  f.source.responses.annual_income.rows[0].reportedCurrency = 'HKD';
  const sameCurrency = forwardPriceEarnings(f.item, f.source, f.rates, f.shares, 20);
  assert.equal(sameCurrency.value, 10);
  assert.match(sameCurrency.noteZh, /無須匯率換算/);
  assert.doesNotMatch(sameCurrency.noteEn, /FX observation/);
});

test('forward P/E retains missing/loss forecasts and rejects stale FX, ADR scale, duplicates and missing FY1', () => {
  for (const mutate of [
    f => { f.source.responses.estimates.rows[2].epsAvg = null; },
    f => { f.source.responses.estimates.rows[2].epsAvg = 0; },
    f => { f.source.responses.estimates.rows[2].epsAvg = -2; },
    f => { f.source.responses.estimates.rows[2].epsAvg *= 8; },
    f => { f.source.responses.estimates.rows[2].numAnalystsEps = 0; },
    f => { f.source.responses.estimates.rows[2].symbol = 'BABA'; },
    f => { f.source.responses.estimates.rows.push({ ...f.source.responses.estimates.rows[2] }); },
    f => { f.source.responses.estimates.rows.pop(); },
    f => { f.source.responses.estimates.rows[1].revenueAvg /= 8; },
    f => { f.rates.currencies.CNY.observations[0][0] = '2026-09-01'; },
    f => { f.rates.currencies.CNY.observations = []; },
    f => { f.source.responses.annual_income.rows[0].filingDate = '2026-10-18'; },
    f => { f.source.responses.annual_income.rows[0].acceptedDate = '2026-10-18T10:00:00'; },
    f => { f.shares.shares = null; }
  ]) {
    const f = forwardFixture();
    mutate(f);
    const result = forwardPriceEarnings(f.item, f.source, f.rates, f.shares, 20);
    assert.equal(result.value, null);
    assert.ok(result.reason);
  }
  const providerShares = forwardFixture();
  providerShares.shares = { shares: null, providerComparison: { shares: 10, date: '2026-10-16' } };
  const recovered = forwardPriceEarnings(providerShares.item, providerShares.source,
    providerShares.rates, providerShares.shares, 20);
  assert.equal(recovered.value, 7.8125);
  assert.equal(recovered.shareScaleCheck.shareBasis, 'providerOutstandingShares');
  const f = forwardFixture();
  f.source.responses.annual_income.rows[0].date = '2026-03-31';
  f.source.responses.estimates.rows[1].date = '2026-03-31';
  f.source.responses.estimates.rows[2].date = '2027-03-31';
  assert.equal(forwardPriceEarnings(f.item, f.source, f.rates, f.shares, 20).fiscalDate, '2027-03-31');
});

function ccbShares(count = 240417319880) {
  return { ticker: ccb.ticker, providerSymbol: ccb.ticker, capturedAt: '2026-10-17T00:00:00Z',
    responses: { shares_float: { ok: true, rows: [
      { symbol: ccb.ticker, date: '2026-10-16', outstandingShares: count, floatShares: 10 }
    ] } } };
}

test('CCB uses all issued A and H ordinary shares, not H-only provider or preference shares', () => {
  const result = valuationShares(ccb, ccbShares());
  assert.equal(result.outstandingShares, 21183061579 + 240417319880);
  assert.equal(result.outstandingShares, 261600381459);
  assert.equal(result.shares, 261600.381459);
  assert.equal(result.treasuryShares, 0);
  assert.equal(result.date, '2026-09-30');
  assert.equal(result.scope, 'issuerWideOrdinaryShares');
  assert.equal(result.basis, 'commonSharesOutstandingExcludingTreasury');
  assert.equal(result.providerComparison.matchingClass, 'H');
  assert.equal(result.providerSource, ccbCapital.url);
  assert.equal(result.documentSha256, ccbCapital.documentSha256);
});

test('ordinary share counts subtract each class treasury shares; no missing count is assumed zero', () => {
  const capital = structuredClone(ccbCapital);
  capital.classes[0].treasuryShares = 100;
  capital.classes[1].treasuryShares = 200;
  const source = ccbShares();
  source.responses.shares_float.rows = [];
  const result = valuationShares(ccb, source, capital);
  assert.equal(result.outstandingShares, 261600381159);
  assert.equal(result.treasuryShares, 300);
  delete capital.classes[0].treasuryShares;
  assert.throws(() => valuationShares(ccb, source, capital), /invalid issuer-wide/);
});

test('unverified or not-yet-filed A/H returns never fall back to H-only counts', () => {
  assert.equal(valuationShares(ccb, ccbShares(), null).shares, null);
  const capital = { ...ccbCapital, filingDate: '2026-10-18' };
  assert.equal(valuationShares(ccb, ccbShares(), capital).reason, 'issuerShareReturnNotYetAvailable');
  assert.equal(valuationShares(ccb, ccbShares(240417319881)).reason, 'issuerShareReturnNeedsReview');
});

test('issuer share evidence rejects other issuers, missing A/H classes, preference shares, duplicate classes and invalid totals', () => {
  for (const mutate of [
    capital => { capital.ticker = '0005.HK'; },
    capital => { capital.classes.pop(); },
    capital => { capital.classes.push({ name: 'Preferred', type: 'preference', issuedShares: 600000000, treasuryShares: 0 }); },
    capital => { capital.classes.push({ ...capital.classes[0] }); },
    capital => { capital.classes[0].issuedShares = 1.5; },
    capital => { capital.classes[0].treasuryShares = -1; },
    capital => { capital.classes[0].treasuryShares = capital.classes[0].issuedShares + 1; },
    capital => { capital.filingDate = '2026-09-29'; },
    capital => { capital.documentSha256 = ''; }
  ]) {
    const capital = structuredClone(ccbCapital);
    mutate(capital);
    assert.throws(() => valuationShares(ccb, ccbShares(), capital), /invalid issuer-wide/);
  }
});

test('other HK listings retain dated outstanding counts, never float or weighted-average counts', () => {
  for (const item of require('../hkex_stocks.json').filter(row => !row.shareClassReviewRequired)) {
    const source = ccbShares(2000000000);
    source.ticker = source.providerSymbol = source.responses.shares_float.rows[0].symbol = item.ticker;
    source.responses.shares_float.rows[0].weightedAverageShsOutDil = 3000000000;
    assert.equal(valuationShares(item, source).shares, 2000);
    delete source.responses.shares_float.rows[0].outstandingShares;
    assert.equal(valuationShares(item, source).shares, null);
  }
});

test('every reviewed mixed-class issuer covers its actual ordinary classes and excludes treasury shares', () => {
  const config = require('../hkex_stocks.json');
  const capital = require('../cache/hkex_share_capital.json');
  const reviewed = config.filter(item => item.shareClassReviewRequired);
  assert.equal(reviewed.length, 26);
  for (const item of reviewed) {
    const record = capital[item.ticker];
    const expected = record.classes.reduce((total, row) => total + row.issuedShares - row.treasuryShares, 0);
    const source = ccbShares(record.providerReview?.outstandingShares || expected);
    source.ticker = source.providerSymbol = source.responses.shares_float.rows[0].symbol = item.ticker;
    source.capturedAt = `${record.providerReview?.reviewedThrough || '2026-10-19'}T23:00:00Z`;
    source.responses.shares_float.rows[0].date = record.providerReview?.providerDate || '2026-10-18';
    const result = valuationShares(item, source);
    assert.equal(result.outstandingShares, expected, item.ticker);
    assert.equal(result.date, '2026-09-30', item.ticker);
    assert.equal(result.basis, 'commonSharesOutstandingExcludingTreasury', item.ticker);
    for (const name of item.ordinaryShareClasses || ['A', 'H']) {
      assert.ok(record.classes.some(row => row.name === name), `${item.ticker}/${name}`);
      const incomplete = structuredClone(record);
      incomplete.classes = incomplete.classes.filter(row => row.name !== name);
      assert.throws(() => valuationShares(item, source, incomplete), /invalid issuer-wide/, `${item.ticker}/${name}`);
    }
    if (record.providerReview) {
      source.responses.shares_float.rows[0].outstandingShares++;
      assert.equal(valuationShares(item, source).reason, 'issuerShareReturnNeedsReview', item.ticker);
      source.responses.shares_float.rows[0].outstandingShares--;
      // Newer FMP as-of date with the same reviewed mismatched count must keep issuer capital.
      source.responses.shares_float.rows[0].date = '2026-10-25';
      source.capturedAt = '2026-10-25T23:00:00Z';
      const republished = valuationShares(item, source);
      assert.equal(republished.outstandingShares, expected, item.ticker);
      assert.equal(republished.reason, undefined, item.ticker);
      assert.ok(Number.isFinite(republished.shares) && republished.shares > 0, item.ticker);
    }
  }
  for (const [ticker, shares] of Object.entries({
    '0300.HK': 7441638907, '2359.HK': 3005053935, '6690.HK': 9235106175,
    '3750.HK': 4598930642, '2899.HK': 26513323649
  })) {
    assert.equal(capital[ticker].classes.reduce((total, row) => total + row.issuedShares - row.treasuryShares, 0), shares, ticker);
  }
});

test('new mixed-class issuers cannot use listing-only or weighted-average shares for issuer valuations', () => {
  for (const item of require('../hkex_stocks.json').filter(row => row.shareClassReviewRequired && row.ticker !== ccb.ticker)) {
    const source = ccbShares(2000000000);
    source.ticker = source.providerSymbol = source.responses.shares_float.rows[0].symbol = item.ticker;
    source.responses.shares_float.rows[0].weightedAverageShsOutDil = 3000000000;
    const result = valuationShares(item, source, null);
    assert.equal(result.shares, null, item.ticker);
    assert.equal(result.reason, 'shareBasisUnverified', item.ticker);
  }
});

test('ICBC and BOC use verified A/H ordinary shares despite the specifically reviewed FMP count mismatch', () => {
  const config = require('../hkex_stocks.json'), capital = require('../cache/hkex_share_capital.json');
  for (const ticker of ['1398.HK', '3988.HK']) {
    const item = config.find(row => row.ticker === ticker), review = capital[ticker].providerReview;
    const source = ccbShares(review.outstandingShares);
    source.ticker = source.providerSymbol = source.responses.shares_float.rows[0].symbol = ticker;
    source.capturedAt = `${review.providerDate}T23:00:00Z`;
    source.responses.shares_float.rows[0].date = review.providerDate;
    const result = valuationShares(item, source);
    assert.equal(result.outstandingShares, ticker === '1398.HK' ? 356406257089 : 322212411814);
    assert.equal(result.treasuryShares, 0);
    assert.equal(result.providerComparison.reason, 'reviewedProviderShareMismatch');
    assert.equal(result.scope, 'issuerWideOrdinaryShares');
    source.responses.shares_float.rows[0].outstandingShares += 1;
    assert.equal(valuationShares(item, source).reason, 'issuerShareReturnNeedsReview');
    source.responses.shares_float.rows[0].outstandingShares -= 1;
    // Date-only republish of the same reviewed mismatched count remains accepted.
    source.responses.shares_float.rows[0].date = '2026-10-28';
    source.capturedAt = '2026-10-28T00:00:00Z';
    const later = valuationShares(item, source);
    assert.equal(later.outstandingShares, result.outstandingShares);
    assert.equal(later.providerComparison.reason, 'reviewedProviderShareMismatch');
  }
});

test('cached insurer PF scores show audited applicable-item totals without silently assigning current-ratio points', () => {
  const market = require('../hk_market_dcf.json');
  for (const [ticker, expected] of Object.entries({ '1299.HK': 5, '2318.HK': 6, '2628.HK': 7 })) {
    const stock = market[ticker], source = stock.ratingSources.fScore;
    assert.equal(stock.f_score, expected);
    assert.equal(source.assessmentType, 'applicableItems');
    assert.equal(source.applicableTests, 8);
    assert.equal(source.evaluatedTests, 8);
    assert.equal(source.standardScore, null);
    assert.equal(source.reason, null);
    const criterion = stock.f_score_breakdown.find(item => item.id === 6);
    assert.equal(criterion.applicable, false);
    assert.equal(criterion.passed, null);
    assert.ok(criterion.sources.length >= 2);
    assert.equal(stock.f_score_breakdown.reduce((sum, item) => sum + (item.passed || 0), 0), expected);
  }
});

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
test('a historical gap cannot relabel genuine half-year reports as quarters or erase supported recent TTM', () => {
  const source = evidence(true);
  for (const type of ['income', 'balance', 'cashflow']) {
    source.responses[type].rows = source.responses[type].rows.filter(row => row.date !== '2024-03-31');
  }
  const result = prepareStatements(source);
  assert.equal(result.reportingFrequency, 'semiannual');
  assert.ok(result.quarterly.income.every(row => row.periodLength === 6));
  assert.equal(flowValue(result, 'income', 'revenue'), 100);
  assert.equal(result.quarterly.income.find(row => row.date === '2024-03-31').derivation, 'annualMinusReportedH1');
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

test('a stale last trade is archived, not used as a current quote, market cap or market valuation ratio', () => {
  const source = evidence();
  source.responses.profile = { ok: true, rows: [{ symbol: source.ticker, currency: 'HKD', companyName: 'Fixture' }] };
  source.responses.quote = { ok: true, rows: [{ symbol: source.ticker, price: 100, marketCap: 10000,
    timestamp: Date.parse('2025-06-25T08:00:00Z') / 1000 }] };
  source.responses.prices_recent = { ok: true, rows: [{ symbol: source.ticker, date: '2025-06-25', close: 100 }] };
  const item = require('../hkex_stocks.json').find(row => row.ticker === source.ticker);
  const result = compileStock(item, source, { source: 'Fixture already HKD', prepared: source.capturedAt });
  assert.equal(result.stock.quoteAvailability.reason, 'staleQuote');
  assert.equal(result.stock.lastTrade.price, 100);
  assert.equal(result.stock.lastTrade.date, '2025-06-25');
  for (const field of ['price', 'mcap', 'ev', 'year_high', 'year_low', 'pe_trailing', 'pe_forward', 'ps_ratio']) {
    assert.equal(result.stock[field], null, field);
  }
  assert.equal(result.snapshot.reason, 'staleQuote');
  assert.equal(result.chart.rows[0][0], '2025-06-25', 'Actual historical trades remain available');
});
