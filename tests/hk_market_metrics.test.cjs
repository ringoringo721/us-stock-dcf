const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const market = require('../hk_market_dcf.json');
const config = require('../hkex_stocks.json');
const { convertStatements } = require('../usd_currency.js');
const rates = require('../cache/fx/hkd_rates.json');
const Liquidation = require('../liquidation.js');
const { marketLeverage } = require('../scripts/build_hkex.cjs');
const FcffView = require('../fcff_view.js');

function leverageFixture() {
  return { calculationCurrency: 'HKD', reportingFrequency: 'semiannual',
    annual: { income: [], balance: [], cashflow: [] },
    quarterly: { income: [
      { date: '2025-12-31', fiscalYear: '2025', period: 'Q4', periodLength: 6,
        reportedCurrency: 'HKD', comparabilityGroup: 'same', ebitda: 4e6 },
      { date: '2026-06-30', fiscalYear: '2026', period: 'Q2', periodLength: 6,
        reportedCurrency: 'HKD', comparabilityGroup: 'same', ebitda: 6e6 }
    ], balance: [{ date: '2026-06-30', totalDebt: 30e6,
      cashAndShortTermInvestments: 50e6, preferredStock: 2e6, minorityInterest: 3e6 }], cashflow: [] } };
}

test('actual semiannual EBITDA supports trading multiples without CFO, CapEx or a valid DCF', () => {
  const inputs = marketLeverage(leverageFixture(), { mcap: 100 });
  assert.deepEqual(inputs.reportedMultiples.incomeDates, ['2025-12-31', '2026-06-30']);
  assert.equal(inputs.reportedMultiples.ebitda, 10);
  assert.equal(inputs.ev_to_ebitda, 8.5);
  assert.equal(inputs.debt_to_ebitda, 3);
  assert.equal(inputs.net_debt_to_ebitda, -2);
  const snapshot = { reason: 'incompleteTtm', defaults: { debt: 999, cash: 0 }, ttm: { ebitda: null } };
  const before = structuredClone(snapshot);
  const result = FcffView.metrics({ ...inputs, price: 10 }, snapshot, { reason: 'incompleteTtm', fairVal: null });
  assert.equal(result.ev_to_ebitda, 8.5);
  assert.equal(result.debt_to_ebitda, 3);
  assert.equal(result.net_debt_to_ebitda, -2);
  assert.equal(result.EV, 85);
  assert.equal(result.reportedEbitda, 10);
  assert.equal(result.fairVal, null);
  assert.equal(result.reason, 'incompleteTtm');
  assert.deepEqual(snapshot, before);
});

test('missing claims, stale quotes and missing cash block only the numerators that need them', () => {
  const data = leverageFixture();
  const stale = marketLeverage(data, { mcap: null }).reportedMultiples;
  assert.equal(stale.values.ev_to_ebitda, null);
  assert.equal(stale.reasons.ev_to_ebitda, 'currentMarketCapUnavailable');
  assert.equal(stale.values.debt_to_ebitda, 3);
  assert.equal(stale.values.net_debt_to_ebitda, -2);
  data.quarterly.balance[0].minorityInterest = null;
  const claims = marketLeverage(data, { mcap: 100 }).reportedMultiples;
  assert.equal(claims.values.ev_to_ebitda, null);
  assert.equal(claims.reasons.ev_to_ebitda, 'missingReportedCapital');
  assert.equal(claims.values.debt_to_ebitda, 3);
  data.quarterly.balance[0].cashAndShortTermInvestments = null;
  assert.equal(marketLeverage(data, { mcap: 100 }).net_debt_to_ebitda, null);
  assert.equal(marketLeverage(data, { mcap: 100 }).debt_to_ebitda, 3);
});

test('nonpositive EBITDA is not a meaningful denominator; real zero debt and negative EV are preserved', () => {
  const data = leverageFixture();
  assert.equal(marketLeverage(data, { mcap: 1 }).ev_to_ebitda, -1.4);
  data.quarterly.balance[0].totalDebt = 0;
  assert.equal(marketLeverage(data, { mcap: 100 }).debt_to_ebitda, 0);
  for (const ebitda of [0, -1e6]) {
    data.quarterly.income.forEach(row => { row.ebitda = ebitda; });
    const result = marketLeverage(data, { mcap: 100 });
    for (const key of ['ev_to_ebitda', 'debt_to_ebitda', 'net_debt_to_ebitda']) {
      assert.equal(result[key], null);
      assert.equal(result.reportedMultiples.reasons[key], 'nonPositiveEbitda');
    }
  }
});

test('a reported twelve-month second interim is used once, never added to overlapping half-years', () => {
  const data = leverageFixture();
  data.quarterly.income.push({ date: '2026-12-31', fiscalYear: '2026', period: 'Q3',
    periodLength: 12, reportType: 'secondInterim', reportedCurrency: 'HKD', ebitda: -7e6 });
  const result = marketLeverage(data, { mcap: 100 }).reportedMultiples;
  assert.deepEqual(result.incomeDates, ['2026-12-31']);
  assert.equal(result.ebitda, -7);
  assert.equal(result.periodBasis, 'reportedTwelveMonthSecondInterim');
  assert.equal(result.reasons.ev_to_ebitda, 'nonPositiveEbitda');
});

test('incompatible durations, comparability groups, currencies, missing FX and missing EBITDA are not guessed', () => {
  for (const [field, value] of [['periodLength', null], ['periodLength', 9], ['comparabilityGroup', 'different'],
    ['reportedCurrency', 'USD'], ['date', '2025-01-01']]) {
    const data = leverageFixture();
    data.quarterly.income[0][field] = value;
    const result = marketLeverage(data, { mcap: 100 }).reportedMultiples;
    assert.equal(result.values.ev_to_ebitda, null, field);
    assert.equal(result.reasons.ev_to_ebitda, 'missingEbitdaPeriod', field);
  }
  const fx = leverageFixture();
  fx.quarterly.income[0].currencyConversion = { reason: 'missingFxDate' };
  assert.equal(marketLeverage(fx, { mcap: 100 }).reportedMultiples.reasons.debt_to_ebitda, 'missingFx');
  assert.equal(marketLeverage(fx, { mcap: 100 }).reportedMultiples.ebitda, null);
  const capitalFx = leverageFixture();
  capitalFx.quarterly.balance[0].currencyConversion = { reason: 'missingFxDate' };
  assert.equal(marketLeverage(capitalFx, { mcap: 100 }).reportedMultiples.ebitda, 10);
  assert.equal(marketLeverage(capitalFx, { mcap: 100 }).reportedMultiples.reasons.debt_to_ebitda, 'missingFx');
  const missing = leverageFixture();
  missing.quarterly.income[0].ebitda = null;
  assert.equal(marketLeverage(missing, { mcap: 100 }).reportedMultiples.reasons.debt_to_ebitda, 'missingEbitda');
});

test('all nonfinancial HK persisted multiples match independently supported statement inputs, including screenshots', () => {
  for (const [ticker, stock] of Object.entries(market).filter(([, stock]) => !stock.fin_valuation.is_financial)) {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'financials', `${ticker}_statements_v2.json`)));
    const expected = marketLeverage(convertStatements(raw, rates), stock);
    assert.deepEqual(stock.reportedMultiples, expected.reportedMultiples, ticker);
    const metrics = FcffView.metrics(stock, { reason: 'incompleteTtm' }, { reason: 'incompleteTtm' });
    for (const key of ['ev_to_ebitda', 'debt_to_ebitda', 'net_debt_to_ebitda']) {
      assert.equal(stock[key], expected[key], `${ticker}/${key}`);
      assert.equal(metrics[key], expected[key], `${ticker}/${key}/frontend`);
      if (expected[key] === null) assert.ok(stock.reportedMultiples.reasons[key], ticker);
    }
  }
  assert.equal(market['0880.HK'].reportedMultiples.ebitda, 3434.3);
  assert.ok(market['0880.HK'].ev_to_ebitda > 0);
  assert.ok(market['3918.HK'].net_debt_to_ebitda < 0);
  assert.ok(market['0296.HK'].ev_to_ebitda > 0);
  assert.ok(market['0296.HK'].reportedMultiples.minority > 0);
  const macau = market['0296.HK'].reportedMultiples;
  assert.ok(Math.abs(macau.ev - (macau.mcap + macau.debt - macau.cash + macau.preferred + macau.minority)) < 1e-9);
  assert.equal(market['1009.HK'].reportedMultiples.ebitda, -270.478);
  assert.deepEqual(market['1009.HK'].reportedMultiples.incomeDates, ['2026-06-30']);
  assert.equal(market['0959.HK'].ev_to_ebitda, null);
  assert.ok(market['0959.HK'].debt_to_ebitda > 0);
});

test('persisted HK P/E, P/B and liquidation values use their disclosed earnings and issuer-share bases', () => {
  for (const [ticker, stock] of Object.entries(market)) {
    const pe = stock.marketRatioSources.pe;
    const pb = stock.marketRatioSources.pb;
    assert.equal(stock.pe_trailing, Number.isFinite(stock.price) && Number.isFinite(pe.eps) && pe.eps !== 0
      ? stock.price / pe.eps : null, ticker);
    assert.equal(stock.pb_trailing, Number.isFinite(stock.price) && Number.isFinite(pb.bookEquity) && pb.bookEquity !== 0
      && Number.isFinite(stock.shares) ? stock.price / (pb.bookEquity / (stock.shares * 1e6)) : null, ticker);
    if (stock.pe_trailing === null) assert.ok(pe.reason, ticker);
    if (stock.pb_trailing === null) assert.ok(pb.reason, ticker);
    const liquidation = Liquidation.calculate(stock.liquidation, ticker);
    liquidation.values.forEach((value, i) => assert.equal(stock[`liq_val_${i + 1}`], value, ticker));
    if (config.find(item => item.ticker === ticker).shareClassReviewRequired) {
      assert.equal(stock.shareBasis, 'commonSharesOutstandingExcludingTreasury', ticker);
      assert.equal(stock.liquidation.sharesOutstanding, stock.shares_outstanding, ticker);
      assert.equal(stock.shareSource.scope, 'issuerWideOrdinaryShares', ticker);
    }
    if (pe.basis === 'ttmCommonEarningsOverCurrentOrdinaryShares' && !pe.reason) {
      assert.equal(pe.shareDate, stock.shareSource.date, ticker);
      assert.ok(pe.dates.length > 0, ticker);
    }
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'financials', `${ticker}_statements_v2.json`)));
    const latestBalance = [...raw.annual.balance, ...raw.quarterly.balance].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    const data = convertStatements({ ...raw,
      annual: { income: [], balance: [latestBalance], cashflow: [] },
      quarterly: { income: [], balance: [], cashflow: [] } }, rates);
    const balance = data.annual.balance[0];
    assert.equal(pb.bookEquity, balance.totalStockholdersEquity, ticker);
  }
});

test('unavailable current metrics retain specific real-data reasons rather than fabricated replacements', () => {
  assert.equal(market['0959.HK'].pe_trailing, null);
  assert.equal(market['0959.HK'].pb_trailing, null);
  assert.equal(market['0959.HK'].marketRatioSources.pe.reason, 'currentPriceUnavailable');
  assert.ok(Number.isFinite(market['1009.HK'].pe_trailing));
  assert.deepEqual(market['1009.HK'].marketRatioSources.pe.dates, ['2026-06-30']);
  assert.equal(market['1009.HK'].marketRatioSources.pe.reason, null);
  assert.equal(market['0388.HK'].liq_val_2, null);
  assert.equal(Liquidation.calculate(market['0388.HK'].liquidation, '0388.HK').reasons[1], 'missingInputs');
});

test('all configured HK companies have complete current bilingual Moat assessments, including additions', () => {
  const reports = require('../cache/hkex_moat.json');
  for (const item of config) {
    const stock = market[item.ticker], assessment = reports[item.ticker];
    assert.equal(stock.ratingSources.moat.reason, null, item.ticker);
    assert.equal(assessment.evidenceHash, stock.ratingSources.moat.currentEvidenceHash, item.ticker);
    assert.deepEqual(stock.moat, assessment.report, item.ticker);
    const dimensions = Object.entries(stock.moat).filter(([key]) => /^m\d+_/.test(key));
    assert.equal(dimensions.length, 10, item.ticker);
    for (const [, dimension] of dimensions) {
      assert.ok(Number.isInteger(dimension.score) && dimension.score >= 0 && dimension.score <= 10, item.ticker);
      assert.ok(dimension.comment_zh.trim() && dimension.comment_en.trim() && dimension.sources.length, item.ticker);
    }
  }
});
