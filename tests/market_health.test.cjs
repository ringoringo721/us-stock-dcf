const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const View = require('../fcff_view.js');
const Ratios = require('../fcf_ratios.js');
const { outstandingShares } = require('../scripts/fcff_sources.cjs');
const { applyToMarket, patchMarketText } = require('../scripts/apply_valuation_shares.cjs');

test('quoted EV and leverage survive a blocked model without borrowing its lease-adjusted capital basis', () => {
  const stock = { price: 20, mcap: 2000 };
  const source = { defaults: { reportedDebt: 100, cash: 200, preferred: 15, minority: 20, investments: 50 },
    ttm: { ebitda: 100, reportedFcf: 30 } };
  for (const reason of [null, 'leaseClassificationRequired', 'missingParameters']) {
    const result = View.metrics(stock, source, { reason, fairVal: null, E: null, NetDebt: -150 });
    assert.equal(result.EV, 1935);
    assert.equal(result.net_debt_to_ebitda, -1);
    assert.equal(result.debt_to_ebitda, 1);
    assert.equal(result.fairVal, null);
    assert.equal(result.reason, reason);
  }
  source.defaults.preferred = null;
  assert.equal(View.metrics(stock, source, {}).EV, null, 'An unknown priority claim is not filled with zero');
});

test('Moat partial coverage shows N/A overall without inventing a /100 or partial-sum total', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  const context = { currentLang: 'en', ratingState: () => '', HkUniverse: require('../hkex_universe.js') };
  vm.runInNewContext(html.slice(html.indexOf('  function evaluateMoat('), html.indexOf('  function setValFilter(')), context);
  const keys = ['m1_brand_pricing', 'm2_patents_regulatory', 'm3_high_switching_costs', 'm4_network_effects',
    'm5_cost_advantage_scale', 'm6_unique_geography_assets', 'm7_operational_efficiency', 'm8_capital_allocation',
    'm9_customer_retention', 'm10_durability'];
  const stock = { moat: Object.fromEntries(keys.map((key, i) => [key, { score: i === 6 ? null : 8 }])) };
  let result = context.evaluateMoat(stock);
  assert.equal(result.total, null);
  assert.equal(result.scoreText, 'N/A · Partial (9/10)');
  assert.equal(result.coverage, '9/10 dimensions assessed');
  assert.equal(result.grade, 'Partial assessment');
  assert.equal(result.criteria[6].score, null);
  stock.moat.m7_operational_efficiency.score = 0;
  result = context.evaluateMoat(stock);
  assert.equal(result.total, 72, 'A genuine zero is retained');
  assert.equal(result.scoreText, '72 / 100');
  assert.equal(context.evaluateMoat({}).scoreText, 'N/A');
  const small = { ...stock, ticker: '0004.HK', calculationCurrency: 'HKD', mcap: 4999.999, f_score: 7 };
  const original = JSON.stringify(small);
  context.currentLang = 'zh';
  const excluded = context.evaluateMoat(small);
  assert.equal(excluded.scoreText, 'N/A - 尚無評分');
  assert.equal(excluded.total, null);
  assert.equal(excluded.grade, '');
  assert.ok(excluded.criteria.every(row => row.score === null && row.comment === ''));
  assert.equal(excluded.ref, '');
  assert.equal(JSON.stringify(small), original, 'Stored assessments and PF data are preserved');
  context.currentLang = 'en';
  assert.equal(context.evaluateMoat(small).scoreText, 'N/A - Not assessed');
  assert.equal(context.evaluateMoat({ ...small, mcap: 5000 }).total, 72, 'Exactly HKD 5 billion remains assessable');
  assert.equal(context.evaluateMoat({ ...small, mcap: 1000 }).excluded, true, 'Former HKD 1B floor no longer applies');
  assert.equal(context.evaluateMoat({ ...small, mcap: 750 }).excluded, true, 'The former HKD 500M threshold no longer applies');
  for (const mcap of [null, undefined, 0, -1, NaN, Infinity]) {
    assert.equal(context.evaluateMoat({ ...small, mcap }).excluded, false, 'Unknown/invalid market cap is not zero');
  }
  assert.equal(context.evaluateMoat({ ...small, calculationCurrency: 'USD' }).excluded, false);
  assert.equal(context.evaluateMoat({ ...small, ticker: 'SMALL', calculationCurrency: 'USD' }).total, 72);
  const incomplete = {
    ticker: '0901.HK', calculationCurrency: 'HKD', mcap: 130000,
    qualityWarnings: [{ code: 'providerStatementUnavailable', period: 'annual', type: 'income' }],
    moat: Object.fromEntries(keys.map((key, i) => [key, { score: i === 6 || i === 9 ? null : 5 }]))
  };
  const partial = context.evaluateMoat(incomplete);
  assert.equal(partial.scoreText, 'N/A · Partial (8/10)');
  assert.match(partial.comment, /Provider financial statements are unavailable/);
  context.currentLang = 'zh';
  assert.equal(context.evaluateMoat(incomplete).scoreText, 'N/A · 部分評分（8/10）');
  assert.match(context.evaluateMoat(incomplete).comment, /供應商尚未提供/);
});
test('a model-only noncontrolling claim scenario cannot rewrite quoted book-based enterprise value', () => {
  const stock = { price: 20, mcap: 2000 };
  const source = { defaults: { reportedDebt: 100, cash: 200, preferred: 0, minority: 0 },
    noncontrollingClaimAssumption: { value: 0, reportedBookValue: -5 },
    ttm: { ebitda: 100, reportedFcf: 30 } };
  assert.equal(View.metrics(stock, source, {}).EV, 1895);
  source.quotedCapital = { reportedDebt: 100, cash: 200, preferred: 0, minority: 7 };
  assert.equal(View.metrics(stock, source, {}).EV, 1907, 'An independently dated quoted balance keeps its own book proxy');
});
test('annual valuation fallback cannot become current quoted cash flow or a stale quoted balance', () => {
  const result = View.metrics({ mcap: 2000, fcf0: 999 }, {
    defaults: { reportedDebt: 100, cash: 200, preferred: 0, minority: 0 },
    ttm: { ebitda: 50, reportedFcf: 30 },
    quotedTtm: { ebitda: 80, reportedFcf: null },
    quotedCapital: { reportedDebt: 400, cash: 50, preferred: 0, minority: 0 }
  }, { reason: 'debtCompositionUnverified' });
  assert.equal(result.EV, 2350);
  assert.equal(result.ev_to_ebitda, 2350 / 80);
  assert.equal(result.fcf_to_ev, null);
  assert.equal(result.localFCF0, null);
});

function quarters() {
  const rows = [2024, 2025].flatMap(year => [1, 2, 3, 4].map(q => ({
    fiscalYear: year, period: `Q${q}`, date: `${year}-${['03-31', '06-30', '09-30', '12-31'][q - 1]}`,
    reportedCurrency: 'HKD', revenue: q * 100, freeCashFlow: q * 10, netIncome: q * 20,
    weightedAverageShsOutDil: 8 + q * 2, epsDiluted: q, totalAssets: year === 2024 ? 1000 : q * 500,
    totalStockholdersEquity: 500, goodwillAndIntangibleAssets: 100,
    cashAtBeginningOfPeriod: q * 10, cashAtEndOfPeriod: q * 10 + 5,
    currencyConversion: { rate: q, reason: null }
  })));
  return { reportingFrequency: 'quarterly', quarterly: Object.fromEntries(['income', 'balance', 'cashflow'].map(type =>
    [type, structuredClone(rows)])), annual: { income: [], balance: [], cashflow: [] } };
}

test('half years sum genuine translated quarters, retain closing balances and do not add shares or EPS', () => {
  const data = quarters(), half = Ratios.halfYearStatements(data);
  const h1 = half.quarterly.income.at(-2);
  assert.equal(h1.revenue, 300);
  assert.equal(h1.weightedAverageShsOutDil, 11);
  assert.equal(h1.epsDiluted, null);
  assert.deepEqual(h1.sourceDates, ['2025-03-31', '2025-06-30']);
  assert.equal(h1.currencyConversion.periods.length, 2);
  assert.equal(half.quarterly.balance.at(-2).totalAssets, 1000);
  assert.equal(half.quarterly.cashflow.at(-2).cashAtBeginningOfPeriod, 10);
  assert.equal(half.quarterly.cashflow.at(-2).cashAtEndOfPeriod, 25);
  assert.equal(Ratios.calculate(data, { period: 'semiannual' }).at(-1).ratios.assets.value, 10);
  assert.equal(Ratios.calculateEarnings(data, { period: 'semiannual' }).at(-1).amounts.eps.value, 10);
  assert.equal(Ratios.calculateEarnings(data, { period: 'semiannual', flow: 'single' }).at(-1).amounts.eps.value, null);
  for (const type of ['income', 'cashflow']) data.quarterly[type].splice(4, 1);
  assert.equal(Ratios.halfYearStatements(data).quarterly.income.at(-2).revenue, null);
});

test('outstanding-share counts are sourced and dated, never substituted with float or diluted shares', () => {
  const evidence = { ticker: 'TEST', providerSymbol: 'TEST', capturedAt: '2026-10-17T00:00:00Z',
    responses: { shares_float: { ok: true, rows: [{ symbol: 'TEST', date: '2026-10-16',
      outstandingShares: 120e6, floatShares: 90e6 }] } } };
  const source = outstandingShares(evidence, '2026-10-17');
  assert.equal(source.shares, 120);
  const original = { shares: 100, price: 10, mcap: 999, fair_val: 12, default_fair_val: 12, fin_valuation: {
    is_financial: true, tbvps: 6, dps_total: 3, reference: { tbvps: 6 } } };
  const updated = applyToMarket({ TEST: original }, { TEST: evidence });
  assert.equal(updated.TEST.fin_valuation.tbvps, 5);
  assert.equal(updated.TEST.fin_valuation.dps_total, 2.5);
  assert.equal(updated.TEST.fair_val, 10);
  assert.equal(updated.TEST.default_fair_val, 10);
  assert.equal(updated.TEST.premium_pct, 0);
  assert.equal(updated.TEST.mcap, 999, 'A share-count change does not rewrite quoted market cap');
  const text = JSON.stringify({ TEST: original }, null, 2);
  const patched = patchMarketText(text, updated);
  assert.deepEqual(JSON.parse(patched), updated);
  assert.equal(patchMarketText(patched, updated), patched);
  evidence.responses.shares_float.rows[0].date = '2027-01-01';
  assert.equal(outstandingShares(evidence, '2026-10-17').shares, null);
  assert.throws(() => applyToMarket({ TEST: original }, { TEST: evidence }), /outstanding shares/);
});
