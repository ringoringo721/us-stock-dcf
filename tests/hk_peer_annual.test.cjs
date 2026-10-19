const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Peers = require('../peer_comparison.js');
const Currency = require('../usd_currency.js');
const market = require('../hk_market_dcf.json');
const rates = require('../cache/fx/hkd_rates.json');

function fixture() {
  const row = (year, values) => ({ date: `${year}-12-31`, fiscalYear: String(year),
    period: 'FY', periodLength: 12, reportedCurrency: 'HKD', ...values });
  const stock = { price: 50, mcap: 100, shares: 2, calculationCurrency: 'HKD',
    shareBasis: 'commonSharesOutstandingExcludingTreasury', pe_trailing: 999, roe: 999,
    reported_growth: { fields: { revenue: { value: 999 } } } };
  const data = { calculationCurrency: 'HKD', reportingFrequency: 'semiannual',
    annual: {
      income: [row(2024, { revenue: 50e6, netIncome: 10e6, ebitda: 20e6 }),
        row(2025, { revenue: 100e6, netIncome: 20e6, ebitda: 40e6 })],
      balance: [row(2024, { totalStockholdersEquity: 20e6, totalAssets: 80e6 }),
        row(2025, { totalDebt: 30e6, cashAndShortTermInvestments: 50e6,
          preferredStock: 0, minorityInterest: 5e6, totalStockholdersEquity: 40e6,
          totalAssets: 100e6, totalCurrentAssets: 35e6, totalCurrentLiabilities: 20e6 })],
      cashflow: [row(2024, { operatingCashFlow: 10e6, freeCashFlow: 5e6 }),
        row(2025, { operatingCashFlow: 15e6, freeCashFlow: 10e6, capitalExpenditure: -5e6,
          dividendsPaid: -2e6 })]
    },
    quarterly: { income: [{ date: '2026-06-30', period: 'Q2', fiscalYear: '2026',
      periodLength: 6, netIncome: 999e6, revenue: 999e6 }], balance: [], cashflow: [] } };
  return { stock, data };
}

test('HK peer annual view uses matching full-FY flows, FY-end balances and beginning-balance returns, never TTM', () => {
  const { stock, data } = fixture(), before = structuredClone({ stock, data });
  const view = Peers.annualView(stock, data), year = view.peerAnnual;
  assert.equal(year.date, '2025-12-31');
  assert.equal(year.income.revenue, 100);
  assert.equal(year.cashflow.freeCashFlow, 10);
  assert.equal(view.EV, 85);
  assert.equal(view.ev_to_ebitda, 2.125);
  assert.equal(view.debt_to_ebitda, 0.75);
  assert.equal(view.net_debt_to_ebitda, -0.5);
  assert.equal(view.pe_trailing, 5);
  assert.equal(view.pb_trailing, 2.5);
  assert.equal(view.roe, 100);
  assert.equal(view.roa, 25);
  assert.equal(view.current_ratio, 1.75);
  assert.equal(view.div_yield, 2);
  assert.equal(year.growth.revenue.value, 100);
  assert.equal(year.growth.freeCashFlow.value, 100);
  assert.equal(year.growth.revenue.basis, 'annual');
  assert.deepEqual({ stock, data }, before);
});

test('a twelve-month interim and an incomplete fiscal period are not relabeled as a full fiscal year', () => {
  const { stock, data } = fixture();
  data.annual.income.push({ ...data.annual.income.at(-1), date: '2026-06-30',
    period: 'Q3', reportType: 'secondInterim', periodLength: 12 });
  data.annual.income.push({ ...data.annual.income[0], date: '2026-12-31', periodLength: 9 });
  assert.equal(Peers.annualView(stock, data).peerAnnual.date, '2025-12-31');
});

test('missing matching annual cash flows do not borrow older years, interim flows or synthesize zero dividends', () => {
  const { stock, data } = fixture();
  data.annual.cashflow.pop();
  const view = Peers.annualView(stock, data);
  assert.equal(view.peerAnnual.cashflow.freeCashFlow, null);
  assert.equal(view.div_yield, null);
  assert.equal(view.peerAnnual.growth.freeCashFlow.value, null);
  assert.equal(view.peerAnnual.growth.freeCashFlow.reason, 'missingPeriod');
  assert.equal(view.ev_to_ebitda, 2.125);
});

test('annual peer cash dividends recognize canonical common-share aliases, including genuine zero distributions', () => {
  for (const field of ['commonDividendsPaid', 'commonStockDividendsPaid', 'netDividendsPaid']) {
    const { stock, data } = fixture();
    delete data.annual.cashflow.at(-1).dividendsPaid;
    data.annual.cashflow.at(-1)[field] = -2e6;
    let view = Peers.annualView(stock, data);
    assert.equal(view.div_yield, 2, field);
    assert.equal(view.peerAnnual.dividendField, field);
    data.annual.cashflow.at(-1)[field] = 0;
    assert.equal(Peers.annualView(stock, data).div_yield, 0, field);
    assert.equal(Peers.annualView({ ...stock, mcap: null }, data).div_yield, null, field);
    data.annual.cashflow.at(-1)[field] = null;
    assert.equal(Peers.annualView(stock, data).div_yield, null, field);
  }
  const { stock, data } = fixture();
  data.annual.balance.at(-1).preferredStock = 1e6;
  assert.equal(Peers.annualView(stock, data).div_yield, null);
  data.annual.cashflow.at(-1).commonDividendsPaid = -1e6;
  assert.equal(Peers.annualView(stock, data).div_yield, 1);
});

test('reported EPS, missing share/claim/FX inputs, negative EBITDA and true zero debt retain honest annual results', () => {
  const { stock, data } = fixture();
  data.annual.income.at(-1).netIncomeDeductions = 2e6;
  assert.equal(Peers.annualView(stock, data).pe_trailing, 50 / 9);
  delete data.annual.income.at(-1).netIncomeDeductions;
  data.annual.income.at(-1).epsdiluted = 5;
  assert.equal(Peers.annualView(stock, data).pe_trailing, 10);
  const unverified = Peers.annualView({ ...stock, shareBasis: 'unverifiedMixedShareClasses' }, data);
  assert.equal(unverified.pb_trailing, null);
  delete data.annual.income.at(-1).epsdiluted;
  assert.equal(Peers.annualView({ ...stock, shares: null }, data).pe_trailing, null);
  data.annual.balance.at(-1).minorityInterest = null;
  assert.equal(Peers.annualView(stock, data).EV, null);
  assert.equal(Peers.annualView(stock, data).debt_to_ebitda, 0.75);
  data.annual.balance.at(-1).totalDebt = 0;
  assert.equal(Peers.annualView(stock, data).debt_to_ebitda, 0);
  data.annual.income.at(-1).ebitda = -40e6;
  assert.equal(Peers.annualView(stock, data).debt_to_ebitda, null);
  assert.equal(Peers.annualView(stock, data).peerAnnual.income.ebitda, -40);
  data.annual.income.at(-1).currencyConversion = { reason: 'missingFxDate' };
  assert.equal(Peers.annualView(stock, data).peerAnnual.income.revenue, null);
  assert.equal(Peers.annualView(stock, data).roe, null);
  const stale = Peers.annualView({ ...stock, price: null, mcap: null }, fixture().data);
  assert.equal(stale.EV, null);
  assert.equal(stale.pe_trailing, null);
  assert.equal(stale.peerAnnual.cashflow.freeCashFlow, 10);
});

test('annual growth retains accounting-basis and negative-prior safeguards', () => {
  const { stock, data } = fixture();
  data.annual.income[0].comparabilityGroup = 'before';
  data.annual.income[1].comparabilityGroup = 'after';
  assert.equal(Peers.annualView(stock, data).peerAnnual.growth.revenue.reason, 'accountingBasisMismatch');
  data.annual.income[0].comparabilityGroup = 'after';
  data.annual.income[0].netIncome = -10e6;
  assert.equal(Peers.annualView(stock, data).peerAnnual.growth.netIncome.reason, 'nonPositivePrior');
});

test('annual peer growth classifies strict sign changes without altering numeric growth or zero-base rules', () => {
  for (const [previous, present, transition, value, reason] of [
    [-10, 20, 'negativeToPositive', null, 'nonPositivePrior'],
    [10, -20, 'positiveToNegative', -300, null],
    [-10, -20, null, null, 'nonPositivePrior'],
    [10, 20, null, 100, null],
    [0, 20, null, null, 'nonPositivePrior'],
    [0, -20, null, null, 'nonPositivePrior'],
    [-10, 0, null, null, 'nonPositivePrior'],
    [10, 0, null, -100, null],
    [10, 10, null, 0, null]
  ]) {
    for (const [type, field] of [['income', 'revenue'], ['income', 'grossProfit'],
      ['income', 'operatingIncome'], ['income', 'netIncome'], ['income', 'ebitda'],
      ['cashflow', 'operatingCashFlow'], ['cashflow', 'freeCashFlow']]) {
      const { stock, data } = fixture();
      data.annual[type][0][field] = previous;
      data.annual[type][1][field] = present;
      const before = structuredClone({ stock, data });
      const record = Peers.annualView(stock, data).peerAnnual.growth[field];
      assert.equal(record.transition, transition, `${field}/${previous}/${present}`);
      assert.equal(record.value, value);
      assert.equal(record.reason, reason);
      assert.deepEqual({ stock, data }, before);
    }
  }
});

test('missing or incomparable annual data never produces a sign-change label', () => {
  for (const mutate of [
    rows => { rows[0].netIncome = null; },
    rows => { rows[1].netIncome = null; },
    rows => { rows[0].comparabilityGroup = 'old'; rows[1].comparabilityGroup = 'new'; },
    rows => { rows[0].reportedCurrency = 'USD'; },
    rows => { rows[1].currencyConversion = { reason: 'missingFxDate' }; },
    rows => { rows[0].date = '2023-12-31'; },
    rows => { rows.pop(); }
  ]) {
    const { stock, data } = fixture();
    data.annual.income[0].netIncome = -10;
    data.annual.income[1].netIncome = 20;
    mutate(data.annual.income);
    const record = Peers.annualView(stock, data).peerAnnual.growth.netIncome;
    assert.ok(record.reason);
    assert.ok(!record.transition);
  }
});

test('all 114 HK issuers use their own latest actual twelve-month FY without changing persisted market data', () => {
  for (const [ticker, stock] of Object.entries(market)) {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'financials', `${ticker}_statements_v2.json`)));
    const data = Currency.convertStatements(raw, rates);
    const view = Peers.annualView(stock, data);
    const latest = data.annual.income.filter(row => row.period === 'FY' && row.periodLength === 12)
      .sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    assert.equal(view.peerAnnual.date, latest.date, ticker);
    assert.equal(view.peerAnnual.income.revenue, latest.revenue / 1e6, ticker);
    const cashflow = data.annual.cashflow.find(row => row.date === latest.date && row.periodLength === 12);
    assert.equal(view.peerAnnual.cashflow.freeCashFlow, Number.isFinite(cashflow?.freeCashFlow)
      && !cashflow.currencyConversion?.reason ? cashflow.freeCashFlow / 1e6 : null, ticker);
    const common = ['commonDividendsPaid', 'commonStockDividendsPaid'].find(field => Number.isFinite(cashflow?.[field]));
    if (common && Number.isFinite(stock.mcap) && stock.mcap > 0 && !cashflow.currencyConversion?.reason) {
      assert.equal(view.div_yield, cashflow[common] === 0 ? 0 : -(cashflow[common] / 1e6) / stock.mcap * 100, ticker);
    }
    if (['0296.HK', '1680.HK', '0487.HK', '0582.HK'].includes(ticker)) {
      assert.equal(view.div_yield, 0, ticker);
      assert.equal(view.peerAnnual.dividendField, 'commonDividendsPaid', ticker);
    }
    for (const record of Object.values(view.peerAnnual.growth)) assert.equal(record.date, latest.date, ticker);
    if (ticker === '1009.HK') assert.equal(view.peerAnnual.date, '2025-06-30');
    if (ticker === '3918.HK') assert.ok(Math.abs(view.peerAnnual.cashflow.freeCashFlow - 2363.8739565167994) < 1e-6);
    if (ticker === '0200.HK') assert.equal(view.peerAnnual.cashflow.freeCashFlow, 7581.097);
  }
});
