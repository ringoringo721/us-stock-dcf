const test = require('node:test');
const assert = require('node:assert/strict');
const { financingDebt, workingCapital } = require('../scripts/fcff_sources.cjs');
const { prepareSnapshot } = require('../scripts/fcff_sources.cjs');

function evidence() {
  const periods = [['2025-09-30', 2025, 'Q3'], ['2025-12-31', 2025, 'Q4'],
    ['2026-03-31', 2026, 'Q1'], ['2026-06-30', 2026, 'Q2'], ['2026-09-30', 2026, 'Q3']];
  const rows = fields => periods.map(([date, fiscalYear, period]) => ({
    symbol: 'TEST', reportedCurrency: 'USD', date, fiscalYear, period, ...fields
  }));
  const response = rows => ({ ok: true, rows });
  return { ticker: 'TEST', providerSymbol: 'TEST', capturedAt: '2026-10-17T00:00:00Z',
    responses: {
      profile: response([{ symbol: 'TEST', currency: 'USD', beta: 0, industry: 'Software' }]),
      quote: response([{ symbol: 'TEST', timestamp: Date.parse('2026-10-16') / 1000, price: 10, marketCap: 1e9 }]),
      income: response(rows({ revenue: 250e6, operatingIncome: 50e6, incomeTaxExpense: 10e6,
        incomeBeforeTax: 50e6, interestExpense: 1.25e6, ebitda: 57.5e6 })),
      balance: response(rows({ totalCurrentAssets: 500e6, cashAndShortTermInvestments: 100e6,
        totalCurrentLiabilities: 200e6, shortTermDebt: 100e6, longTermDebt: 0, totalDebt: 100e6,
        capitalLeaseObligations: 0, capitalLeaseObligationsCurrent: 0, longTermInvestments: 0,
        preferredStock: 0, minorityInterest: 0 })),
      cashflow: response(rows({ depreciationAndAmortization: 7.5e6,
        capitalExpenditure: -12.5e6, changeInWorkingCapital: 0, freeCashFlow: 30e6 })),
      annual_income: response([{ symbol: 'TEST', reportedCurrency: 'USD', date: '2025-12-31',
        fiscalYear: 2025, period: 'FY', revenue: 1e9 }]),
      estimates: response([['2025-12-31', 1e9], ['2026-12-31', 1.1e9], ['2027-12-31', 1.2e9]]
        .map(([date, revenueAvg]) => ({ symbol: 'TEST', date, revenueAvg, ebitAvg: revenueAvg * 0.2 })))
    }
  };
}
const treasury = { ok: true, rows: [{ date: '2026-10-16', year10: 4 }] };

test('consensus scale reconciliation uses reviewed statement revenue, not an inconsistent original provider denominator', () => {
  const input = evidence();
  const corrected = structuredClone(input.responses.annual_income.rows);
  input.responses.annual_income.rows[0].revenue = 0.6e9;
  assert.equal(prepareSnapshot('TEST', input, treasury, null, null).reason, 'forecastCurrencyScaleUnverified');
  const statementData = { annual: { income: corrected, balance: [], cashflow: [] },
    quarterly: { income: input.responses.income.rows, balance: input.responses.balance.rows,
      cashflow: input.responses.cashflow.rows } };
  const snapshot = prepareSnapshot('TEST', input, treasury, null, null, { statementData });
  assert.notEqual(snapshot.reason, 'forecastCurrencyScaleUnverified');
  assert.ok(snapshot.forecasts?.length || snapshot.defaults, 'Reviewed revenue allows genuine consensus anchors');
  assert.equal(input.responses.annual_income.rows[0].revenue, 0.6e9, 'Original evidence is preserved');
});

test('corporate FCFF uses the same sourced issuer-wide denominator as the HK market and liquidation paths', () => {
  const shareSource = { shares: 261600.381459, date: '2026-09-30', filingDate: '2026-09-30',
    basis: 'commonSharesOutstandingExcludingTreasury', scope: 'issuerWideOrdinaryShares' };
  const input = evidence();
  const snapshot = prepareSnapshot('TEST', input, treasury, null, null, { shareSource });
  assert.equal(snapshot.defaults.shares, shareSource.shares);
  assert.deepEqual(snapshot.provenance.shares, shareSource);
  for (const invalid of [
    { ...shareSource, shares: -1 }, { ...shareSource, date: '2026-10-18' },
    { ...shareSource, filingDate: '2026-10-18' }, { ...shareSource, basis: 'dilutedWeightedAverage' }
  ]) {
    assert.throws(() => prepareSnapshot('TEST', input, treasury, null, null, { shareSource: invalid }), /invalid valuation share/);
  }
  const unavailable = prepareSnapshot('TEST', input, treasury, null, null, {
    shareSource: { shares: null, basis: 'unavailable', reason: 'shareBasisUnverified' }
  });
  assert.equal(unavailable.defaults.shares, null);
});

test('reported debt already containing leases is preserved, never increased a second time', () => {
  const result = financingDebt({ totalDebt: 38860e6, shortTermDebt: 1000e6,
    longTermDebt: 32366e6, capitalLeaseObligations: 5494e6 });
  assert.equal(result.value, 38860e6);
  assert.equal(result.leaseDebt, 5494e6);
  assert.equal(result.reason, null);
});

test('unclear lease inclusion is explicit rather than guessing whether to add lease debt', () => {
  const result = financingDebt({ totalDebt: 120, shortTermDebt: 20,
    longTermDebt: 100, capitalLeaseObligations: 10 });
  assert.equal(result.value, null);
  assert.equal(result.reason, 'debtCompositionUnverified');
  assert.equal(financingDebt({ totalDebt: 120 }).reason, 'debtCompositionUnverified');
});

test('reported zero debt and zero lease values remain actual zeros', () => {
  assert.equal(financingDebt({ totalDebt: 0, capitalLeaseObligations: 0 }).value, 0);
  assert.equal(financingDebt({ totalDebt: 120, capitalLeaseObligations: 0 }).value, 120);
  assert.equal(financingDebt({ totalDebt: -1, capitalLeaseObligations: 0 }).value, null);
});

test('current financing leases are excluded from operating NWC, not counted like trade payables', () => {
  const balance = { totalCurrentAssets: 500, cashAndShortTermInvestments: 100,
    totalCurrentLiabilities: 200, shortTermDebt: 50, longTermDebt: 100,
    capitalLeaseObligations: 30, capitalLeaseObligationsCurrent: 10, totalDebt: 180 };
  assert.equal(workingCapital(balance), 260);
  assert.equal(workingCapital({ ...balance, totalDebt: 150 }), null);
  assert.equal(financingDebt({ ...balance, capitalLeaseObligationsCurrent: 40 }).value, null);
});

test('unavailable or malformed source records return reasons rather than fabricated snapshots', () => {
  const { prepareSnapshot } = require('../scripts/fcff_sources.cjs');
  assert.equal(prepareSnapshot('TEST', null, null, null).reason, 'sourceUnavailable');
  assert.equal(prepareSnapshot('TEST', { ticker: 'TEST', providerSymbol: 'TEST',
    capturedAt: 123 }, null, null).reason, 'sourceUnavailable');
});

test('source adapter constructs aligned TTM components and preserves zero and negative beta', () => {
  const input = evidence(), snapshot = prepareSnapshot('TEST', input, treasury, null);
  assert.equal(snapshot.reason, null);
  assert.equal(snapshot.ttm.revenue, 1000);
  assert.equal(snapshot.ttm.ebit, 200);
  assert.equal(snapshot.ttm.capex, 50);
  assert.equal(snapshot.defaults.beta, 0);
  assert.equal(snapshot.defaults.tax, 20);
  assert.equal(snapshot.defaults.kd, 5);
  input.responses.profile.rows[0].beta = -0.047;
  assert.equal(prepareSnapshot('TEST', input, treasury, null).defaults.beta, -0.047);
});

test('source support preserves real consensus EBITDA and available annual/quarterly history without filling gaps', () => {
  const input = evidence();
  input.responses.estimates.rows[1].ebitdaAvg = 260e6;
  input.responses.annual_income.rows[0].operatingIncome = 200e6;
  input.responses.annual_income.rows[0].incomeBeforeTax = 100e6;
  input.responses.annual_income.rows[0].incomeTaxExpense = -10e6;
  input.responses.annual_cashflow = { ok: true, rows: [
    { symbol: 'TEST', date: '2025-12-31', reportedCurrency: 'USD', period: 'FY',
      fiscalYear: 2025, depreciationAndAmortization: 30e6, capitalExpenditure: -50e6 }
  ] };
  const snapshot = prepareSnapshot('TEST', input, treasury, null);
  assert.equal(snapshot.modelVersion, 'fcff-v2');
  assert.equal(snapshot.forecasts[1].ebitda, 260);
  assert.equal(snapshot.forecasts[2].ebitda, null);
  assert.equal(snapshot.history.annual.length, 1, 'Do not pad to five years');
  assert.equal(snapshot.history.annual[0].capex, 50);
  assert.equal(snapshot.history.annual[0].depreciation, 30);
  assert.equal(snapshot.history.annual[0].tax, -10, 'Retain reported historical tax benefits, unlike bounded forecast tax inputs');
  assert.equal(snapshot.history.quarterly[2].ltmRevenue, null);
  assert.equal(snapshot.history.quarterly.at(-1).ltmRevenue, 1000);
  assert.equal(snapshot.history.quarterly.at(-1).workingCapitalRate, 0.3);
  assert.equal(snapshot.ytd.ebitda, 172.5);
  assert.equal(snapshot.ytd.depreciation, 22.5);
  assert.equal(snapshot.ytd.capex, 37.5);
  input.responses.annual_cashflow.rows[0].acceptedDate = '2027-01-01';
  const invalid = prepareSnapshot('TEST', input, treasury, null);
  assert.equal(invalid.history.annual[0].capex, null);
  assert.equal(invalid.history.warnings[0].reason, 'sourceDateMismatch');
});

test('positive original lease liabilities cannot be hidden by a normalized zero, but closed older leases do not override a current zero', () => {
  const input = evidence();
  input.responses.balance_as_reported = { ok: true, rows: [
    { date: '2026-09-30', data: { operatingleaseliabilitynoncurrent: 100 } }
  ] };
  assert.equal(prepareSnapshot('TEST', input, treasury, null).reason, 'leaseMappingUnverified');
  input.responses.balance_as_reported.rows[0].date = '2026-06-30';
  input.responses.balance_as_reported.rows.unshift({ date: '2026-09-30',
    data: { operatingleaseliabilitynoncurrent: 0 } });
  assert.equal(prepareSnapshot('TEST', input, treasury, null).reason, null);
  input.responses.balance_as_reported.rows.unshift({ date: '2026-12-31',
    data: { operatingleaseliabilitynoncurrent: 100 } });
  assert.equal(prepareSnapshot('TEST', input, treasury, null).reason, null);
});

test('annual forecast currency checks cannot borrow a different reporting currency or a future annual statement', () => {
  const input = evidence();
  input.responses.annual_income.rows[0].reportedCurrency = 'EUR';
  assert.equal(prepareSnapshot('TEST', input, treasury, null).reason, 'forecastCurrencyScaleUnverified');
  input.responses.annual_income.rows[0].date = '2026-12-31';
  assert.equal(prepareSnapshot('TEST', input, treasury, null).reason, 'sourceDateMismatch');
  delete input.responses.annual_income.rows[0].date;
  assert.equal(prepareSnapshot('TEST', input, treasury, null).reason, 'sourceDateMismatch');
});

function hkEvidence() {
  const input = evidence();
  input.ticker = input.providerSymbol = 'TEST.HK';
  for (const response of Object.values(input.responses)) for (const row of response.rows) row.symbol = 'TEST.HK';
  input.responses.profile.rows[0].currency = 'HKD';
  return input;
}
const hkdRates = require('../cache/fx/hkd_rates.json');

test('HK discount inputs explicitly use a dated USD proxy while retaining company-specific beta', () => {
  const input = hkEvidence();
  for (const beta of [0.5, 1.5]) {
    input.responses.profile.rows[0].beta = beta;
    const snapshot = prepareSnapshot('TEST.HK', input, treasury, hkdRates);
    assert.equal(snapshot.defaults.rf, 4);
    assert.equal(snapshot.defaults.beta, beta);
    assert.equal(snapshot.provenance.treasury.currency, 'USD');
    assert.equal(snapshot.provenance.treasury.date, '2026-10-16');
    assert.match(snapshot.provenance.riskFreeRate, /USD Treasury proxy/);
  }
});

test('HK rf prefers USD Treasury over a separate HKD benchmark when both are supplied', () => {
  const input = hkEvidence();
  const hkdTreasury = { ok: true, rows: [{ date: '2026-10-16', year10: 9.99, year5: 8.5 }] };
  const usdMulti = { ok: true, rows: [{ date: '2026-10-16', year10: 4.1, year5: 3.7, year2: 3.2 }] };
  const snapshot = prepareSnapshot('TEST.HK', input, usdMulti, hkdRates, null, { hkdTreasury });
  assert.equal(snapshot.defaults.rf, 4.1);
  assert.equal(snapshot.provenance.treasury.currency, 'USD');
  assert.equal(snapshot.provenance.treasury.year10, 4.1);
  assert.equal(snapshot.provenance.treasury.year5, 3.7);
  assert.equal(snapshot.provenance.treasury.year2, 3.2);
  assert.match(snapshot.provenance.riskFreeRate, /USD Treasury proxy/);
  assert.doesNotMatch(snapshot.provenance.riskFreeRate, /HKD benchmark/);
});

test('year10-only treasury rows enrich published 1–10Y from the dated USD CMT curve', () => {
  const { enrichTreasuryFromCurve, prepareSnapshot } = require('../scripts/fcff_sources.cjs');
  const pack = {
    version: 1,
    byDate: {
      '2026-10-16': {
        date: '2026-10-16', currency: 'USD',
        year1: 4.46, year2: 4.74, year3: 4.82, year5: 4.89, year7: 4.98, year10: 5.09
      }
    }
  };
  const enriched = enrichTreasuryFromCurve(
    { ok: true, rows: [{ date: '2026-10-16', year10: 5.09 }] }, pack);
  assert.equal(enriched.rows[0].year1, 4.46);
  assert.equal(enriched.rows[0].year7, 4.98);
  assert.equal(enriched.rows[0].year10, 5.09);
  assert.equal(enriched.rows[0].year4, undefined);
  const input = hkEvidence();
  const snapshot = prepareSnapshot('TEST.HK', input,
    { ok: true, rows: [{ date: '2026-10-16', year10: 4 }] }, hkdRates, null, { usdTreasuryCurve: pack });
  assert.equal(snapshot.provenance.treasury.year10, 4);
  assert.equal(snapshot.provenance.treasury.year2, 4.74);
  assert.equal(snapshot.provenance.treasury.year5, 4.89);
});

test('latest matched forecast scale controls eligibility and older differences remain disclosed', () => {
  const input = evidence();
  input.responses.annual_income.rows.unshift({ symbol: 'TEST', date: '2024-12-31',
    fiscalYear: 2024, period: 'FY', reportedCurrency: 'USD', revenue: 500e6 });
  input.responses.estimates.rows.unshift({ symbol: 'TEST', date: '2024-12-31', revenueAvg: 1e9, ebitAvg: 200e6 });
  const snapshot = prepareSnapshot('TEST', input, treasury, null);
  assert.equal(snapshot.reason, null);
  assert.equal(snapshot.provenance.forecastScaleCheck.date, '2025-12-31');
  assert.deepEqual(snapshot.provenance.forecastScaleCheck.earlierDifferences, [{ date: '2024-12-31', ratio: 2 }]);
  input.responses.estimates.rows.find(row => row.date === '2025-12-31').revenueAvg = 2e9;
  const blocked = prepareSnapshot('TEST', input, treasury, null);
  assert.equal(blocked.reason, 'forecastCurrencyScaleUnverified');
  assert.equal(blocked.defaults.reportedDebt, 100);
  assert.equal(blocked.ttm.ebitda, 230);
  assert.equal(blocked.history.annual.length, 2);
});

test('HK annual-only cash flow selects one complete annual base but preserves independent current quote inputs', () => {
  const input = hkEvidence();
  const annual = type => ({ ...input.responses[type].rows[1], period: 'FY' });
  const annualIncome = { ...annual('income'), revenue: 1e9, operatingIncome: 200e6,
    incomeTaxExpense: 40e6, incomeBeforeTax: 200e6, interestExpense: 5e6, ebitda: 230e6 };
  const statements = {
    reportingFrequency: 'quarterly', statementFrequencies: { cashflow: 'annual' },
    annual: { income: [annualIncome], balance: [annual('balance')], cashflow: [{
      ...annual('cashflow'), depreciationAndAmortization: 30e6, capitalExpenditure: -50e6, freeCashFlow: 120e6
    }] },
    quarterly: { income: input.responses.income.rows, balance: input.responses.balance.rows, cashflow: [] }
  };
  const snapshot = prepareSnapshot('TEST.HK', input, treasury, hkdRates, null, { statementData: statements });
  assert.equal(snapshot.ttm.reportingFrequency, 'annual', snapshot.reason);
  assert.deepEqual(snapshot.ttm.dates, ['2025-12-31']);
  assert.equal(snapshot.provenance.operatingRatios, 'latestCompleteReportedAnnualPeriodNotCurrentTtm');
  assert.equal(snapshot.quotedTtm.reportedFcf, null);
  assert.ok(snapshot.quotedTtm.ebitda > 0);
  assert.equal(snapshot.quotedCapital.date, '2026-09-30');
  assert.equal(snapshot.balance.date, '2025-12-31');
});

test('annual model debt costs use the previous annual balance, not a discarded quarterly placeholder', () => {
  const input = hkEvidence();
  for (const response of Object.values(input.responses)) {
    for (const row of response.rows) if (row.reportedCurrency) row.reportedCurrency = 'HKD';
  }
  const annual = type => ({ ...input.responses[type].rows[1], period: 'FY' });
  const statements = {
    reportingFrequency: 'quarterly', statementFrequencies: { cashflow: 'annual' },
    annual: {
      income: [{ ...annual('income'), revenue: 1e9, operatingIncome: 200e6,
        incomeTaxExpense: 40e6, incomeBeforeTax: 200e6, interestExpense: 5e6 }],
      balance: [{ ...annual('balance'), date: '2024-12-31', fiscalYear: 2024, totalDebt: 80e6 },
        annual('balance')],
      cashflow: [{ ...annual('cashflow'), depreciationAndAmortization: 30e6, capitalExpenditure: -50e6 }]
    },
    quarterly: { income: input.responses.income.rows, balance: input.responses.balance.rows, cashflow: [] }
  };
  const build = () => prepareSnapshot('TEST.HK', input, treasury, hkdRates, null, { statementData: statements });
  assert.equal(build().defaults.kd, 5e6 / 90e6 * 100);
  assert.deepEqual(build().provenance.debtCost, {
    basis: 'reportedAnnualInterestOverAverageAnnualDebt', openingDate: '2024-12-31',
    closingDate: '2025-12-31', interest: 5, averageDebt: 90
  });
  statements.annual.balance[0].capitalLeaseObligations = 10e6;
  assert.equal(build().defaults.kd, null, 'Do not mix unreconciled opening debt with the current debt basis');
  statements.annual.balance[0].capitalLeaseObligations = 0;
  statements.annual.balance[0].date = '2024-01-01';
  assert.equal(build().defaults.kd, null, 'A matching fiscal label cannot substitute for a matching balance date');
  statements.annual.balance = statements.annual.balance.slice(1);
  assert.equal(build().defaults.kd, null, 'Never fabricate an opening balance when the annual source is absent');
});
