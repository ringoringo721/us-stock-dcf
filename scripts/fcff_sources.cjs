const { convertStatements, rateFor } = require('../usd_currency.js');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const period = row => Number(row.fiscalYear || row.calendarYear) * 4 + Number(String(row.period)[1]);
const number = (row, field) => finite(row?.[field]) ? row[field] : null;
const sum = (rows, field) => rows.length && rows.every(row => number(row, field) !== null)
  ? rows.reduce((total, row) => total + row[field], 0) : null;
const millions = value => finite(value) ? value / 1e6 : null;
const sorted = rows => rows.slice().sort((a, b) => a.date.localeCompare(b.date));
const workingCapital = row => ['totalCurrentAssets', 'cashAndShortTermInvestments',
  'totalCurrentLiabilities', 'shortTermDebt', 'capitalLeaseObligationsCurrent']
  .every(field => number(row, field) !== null)
  && financingDebt(row).reason === null
  ? row.totalCurrentAssets - row.cashAndShortTermInvestments - row.totalCurrentLiabilities
    + row.shortTermDebt + row.capitalLeaseObligationsCurrent : null;

function financingDebt(row) {
  const debt = number(row, 'totalDebt'), leases = number(row, 'capitalLeaseObligations');
  const currentLease = number(row, 'capitalLeaseObligationsCurrent');
  if (debt === null || leases === null || debt < 0 || leases < 0
      || (currentLease !== null && (currentLease < 0 || currentLease > leases))) {
    return { value: null, reason: 'debtCompositionUnverified' };
  }
  if (leases === 0) return { value: debt, leaseDebt: leases,
    basis: 'reportedTotalDebt', reason: null };
  const short = number(row, 'shortTermDebt'), long = number(row, 'longTermDebt');
  if (short !== null && long !== null
      && Math.abs(debt - short - long - leases) <= Math.max(1, debt * 1e-8)) {
    return { value: debt, leaseDebt: leases,
      basis: 'reportedTotalDebtReconcilesToBorrowingsPlusLeases', reason: null };
  }
  return { value: null, leaseDebt: leases, reason: 'debtCompositionUnverified' };
}

function prepareSnapshot(ticker, evidence, treasury, rates, leaseEvidence, options = {}) {
  const currency = ticker.endsWith('.HK') ? 'HKD' : 'USD';
  const providerSymbol = ticker.endsWith('.HK') ? ticker : ticker.replace(/\./g, '-');
  const unavailable = reason => ({ version: 1, modelVersion: 'fcff-v2', method: 'FCFF', ticker, currency,
    fetchedAt: evidence?.capturedAt || null, reason });
  if (!evidence || evidence.ticker !== ticker || evidence.providerSymbol !== providerSymbol
      || typeof evidence.capturedAt !== 'string' || !day(evidence.capturedAt.slice(0, 10))) {
    return unavailable('sourceUnavailable');
  }
  const valuationDate = evidence.capturedAt.slice(0, 10), source = evidence.responses;
  const read = name => source?.[name]?.ok && Array.isArray(source[name].rows) ? source[name].rows : null;
  const names = ['profile', 'quote', 'balance', 'income', 'cashflow', 'annual_income', 'estimates'];
  if (names.some(name => !read(name))) return unavailable('sourceUnavailable');
  if (names.some(name => read(name).some(row => !row || row.symbol !== evidence.providerSymbol))) {
    return unavailable('sourceSymbolMismatch');
  }
  if (read('annual_income').some(row => !day(row.date) || row.date > valuationDate)) {
    return unavailable('sourceDateMismatch');
  }
  const profile = read('profile')[0], quote = read('quote')[0];
  if (read('profile').length !== 1 || read('quote').length !== 1 || profile.currency !== currency
      || !finite(quote.timestamp) || !finite(quote.price) || quote.price <= 0
      || !finite(quote.marketCap) || quote.marketCap <= 0) return unavailable('missingQuote');
  const quoteTime = new Date(quote.timestamp * 1000);
  if (!finite(quoteTime.getTime())) return unavailable('missingQuote');
  const quoteDate = quoteTime.toISOString().slice(0, 10);
  if (quoteDate > valuationDate
      || (Date.parse(valuationDate) - Date.parse(quoteDate)) / 86400000 > 14) {
    return unavailable('sourceDateMismatch');
  }
  const historyWarnings = [];
  const annualRows = name => (read(name) || []).filter(row => {
    const valid = row?.symbol === evidence.providerSymbol && day(row.date) && row.date <= valuationDate
      && ['filingDate', 'acceptedDate'].every(field => !row[field]
        || (typeof row[field] === 'string' && day(row[field].slice(0, 10))
          && row[field].slice(0, 10) <= valuationDate));
    if (!valid) historyWarnings.push({ source: name, reason: 'sourceDateMismatch' });
    return valid;
  });
  const raw = options.statementData || { annual: { income: annualRows('annual_income'), balance: annualRows('annual_balance'),
    cashflow: annualRows('annual_cashflow') },
    quarterly: { income: read('income'), balance: read('balance'), cashflow: read('cashflow') } };
  for (const rows of Object.values(raw.quarterly)) {
    if (rows.some(row => !day(row.date) || row.date > valuationDate
        || !/^Q[1-4]$/.test(row.period) || !Number.isInteger(period(row))
        || ['filingDate', 'acceptedDate'].some(field => row[field]
          && (typeof row[field] !== 'string' || !day(row[field].slice(0, 10))
            || row[field].slice(0, 10) > valuationDate)))
        || new Set(rows.map(row => row.date)).size !== rows.length
        || new Set(rows.map(period)).size !== rows.length) return unavailable('sourceDateMismatch');
  }
  const income = sorted(raw.quarterly.income).slice(-4), balance = sorted(raw.quarterly.balance).at(-1);
  const cashflow = income.map(row => raw.quarterly.cashflow.find(other => other.date === row.date
    && period(other) === period(row)));
  if (income.length !== 4 || !balance || cashflow.some(row => !row)
      || income.some((row, i) => i > 0 && (period(row) !== period(income[i - 1]) + 1
        || (Date.parse(row.date) - Date.parse(income[i - 1].date)) / 86400000 < 60
        || (Date.parse(row.date) - Date.parse(income[i - 1].date)) / 86400000 > 120))
      || balance.date !== income.at(-1).date
      || sorted(raw.quarterly.cashflow).at(-1)?.date !== balance.date) return unavailable('incompleteTtm');
  const currencies = new Set([...income, ...cashflow, balance].map(row => row.reportedCurrency));
  if (currencies.size !== 1 || !/^[A-Z]{3}$/.test(balance.reportedCurrency)) {
    return unavailable('sourceCurrencyMismatch');
  }
  const converted = convertStatements(raw, rates, currency);
  const inc = sorted(converted.quarterly.income).slice(-4);
  const cf = income.map(row => converted.quarterly.cashflow.find(other => other.date === row.date));
  const bs = converted.quarterly.balance.find(row => row.date === balance.date);
  if ([...inc, ...cf, bs].some(row => row.currencyConversion.reason)) return unavailable('missingFx');
  const sourceCurrency = balance.reportedCurrency;
  const observation = sourceCurrency === 'USD' ? valuationDate : rates?.currencies?.[sourceCurrency]?.observations
    ?.filter(row => row[0] <= valuationDate && finite(row[1]) && row[1] > 0).at(-1)?.[0];
  if (!observation || (Date.parse(valuationDate) - Date.parse(observation)) / 86400000 > 14) {
    return unavailable('missingForecastFx');
  }
  const forecastFx = rateFor(rates, sourceCurrency, null, observation, 'closing', currency);
  if (!finite(forecastFx.rate)) return unavailable('missingForecastFx');
  const estimates = sorted(read('estimates').filter(row => day(row.date)
    && finite(row.revenueAvg) && row.revenueAvg > 0 && (finite(row.ebitAvg) || finite(row.ebitdaAvg))));
  const comparableAnnual = read('annual_income').filter(row => row.reportedCurrency === sourceCurrency);
  const overlaps = comparableAnnual.map(row => {
    const estimate = estimates.find(other => Math.abs(Date.parse(other.date) - Date.parse(row.date)) < 30 * 86400000);
    return estimate && number(row, 'revenue') > 0 ? estimate.revenueAvg / row.revenue : null;
  }).filter(finite);
  if (!overlaps.length || overlaps.some(ratio => ratio < 0.75 || ratio > 1.25)) {
    return unavailable('forecastCurrencyScaleUnverified');
  }
  const forecasts = estimates.map(row => ({ date: row.date, revenue: row.revenueAvg * forecastFx.rate / 1e6,
    ebit: finite(row.ebitAvg) ? row.ebitAvg * forecastFx.rate / 1e6 : null,
    ebitda: number(row, 'ebitdaAvg') === null ? null : row.ebitdaAvg * forecastFx.rate / 1e6,
    analystsRevenue: number(row, 'numAnalystsRevenue') }));
  const next = forecasts.find(row => row.date > valuationDate);
  if (!next) return unavailable('missingAnalystAnchors');
  const fy = Number(next.date.slice(0, 4));
  const ytdRows = income.filter(row => Number(row.fiscalYear || row.calendarYear) === fy);
  if (ytdRows.length && (ytdRows.length !== Number(income.at(-1).period[1])
      || ytdRows[0].period !== 'Q1' || sum(ytdRows, 'revenue') === null
      || sum(ytdRows, 'operatingIncome') === null)) return unavailable('incompleteYearToDate');
  const taxExpense = sum(inc, 'incomeTaxExpense'), pretax = sum(inc, 'incomeBeforeTax');
  const tax = finite(taxExpense) && finite(pretax) && pretax > 0 && taxExpense >= 0 && taxExpense <= pretax
    ? taxExpense / pretax * 100 : null;
  const debtBasis = financingDebt(bs);
  const olderBalance = converted.quarterly.balance.find(row => period(row) === period(bs) - 4);
  const averageDebt = olderBalance && number(olderBalance, 'totalDebt') !== null && number(bs, 'totalDebt') !== null
    ? (olderBalance.totalDebt + bs.totalDebt) / 2 : null;
  const interest = sum(inc, 'interestExpense');
  const kd = bs.totalDebt === 0 ? 0
    : averageDebt > 0 && interest > 0 ? interest / averageDebt * 100 : null;
  const rateSource = currency === 'HKD' ? options.hkdTreasury : treasury;
  const curve = rateSource?.ok && Array.isArray(rateSource.rows)
    ? sorted(rateSource.rows.filter(row => day(row.date) && row.date <= valuationDate && finite(row.year10))).at(-1) : null;
  const ttm = {
    dates: inc.map(row => row.date), fiscalPeriods: inc.map(period),
    revenue: millions(sum(inc, 'revenue')), ebit: millions(sum(inc, 'operatingIncome')),
    depreciation: millions(sum(cf, 'depreciationAndAmortization')),
    capex: millions(sum(cf, 'capitalExpenditure') === null ? null : -sum(cf, 'capitalExpenditure')),
    workingCapital: millions(workingCapital(bs)),
    workingCapitalCashChange: millions(sum(cf, 'changeInWorkingCapital')),
    reportedFcf: millions(sum(cf, 'freeCashFlow')), ebitda: millions(sum(inc, 'ebitda'))
  };
  const defaults = {
    price: quote.price, shares: quote.marketCap / quote.price / 1e6,
    debt: millions(debtBasis.value), leaseOverlap: bs.capitalLeaseObligations === 0 ? 0 : null,
    cash: millions(number(bs, 'cashAndShortTermInvestments')),
    investments: millions(number(bs, 'longTermInvestments')),
    preferred: millions(number(bs, 'preferredStock')), minority: millions(number(bs, 'minorityInterest')),
    beta: number(profile, 'beta'), rf: curve && (Date.parse(valuationDate) - Date.parse(curve.date)) / 86400000 <= 14
      ? curve.year10 : null,
    erp: 4.75, kd, tax, g: 2.25, terminalRoic: null, preferredCost: null, minorityCost: null,
    discountRate: null, forecastGrowth: 2.25, terminalMethod: 'roic', discountTiming: 'midYear',
    depreciationBasis: 'analystSpread', extrapolation: 'fade'
  };
  const supportRow = (row, flow) => {
    const valid = !row.currencyConversion.reason;
    const cfValid = flow && !flow.currencyConversion.reason && row.reportedCurrency === flow.reportedCurrency;
    const pretax = valid ? number(row, 'incomeBeforeTax') : null;
    const expense = valid ? number(row, 'incomeTaxExpense') : null;
    return { date: row.date, fiscalYear: row.fiscalYear || row.calendarYear, period: row.period,
      revenue: valid ? millions(number(row, 'revenue')) : null,
      ebit: valid ? millions(number(row, 'operatingIncome')) : null,
      ebitda: valid ? millions(number(row, 'ebitda')) : null,
      depreciation: cfValid ? millions(number(flow, 'depreciationAndAmortization')) : null,
      capex: cfValid && number(flow, 'capitalExpenditure') !== null ? -flow.capitalExpenditure / 1e6 : null,
      tax: finite(pretax) && pretax !== 0 && finite(expense)
        ? expense / pretax * 100 : null,
      fxReason: row.currencyConversion.reason || flow?.currencyConversion.reason || null
    };
  };
  const annualHistory = sorted(converted.annual.income).slice(-5).map(row => supportRow(row,
    converted.annual.cashflow.find(other => other.date === row.date)));
  const quarterIncome = sorted(converted.quarterly.income);
  const quarterlyHistory = quarterIncome.map((row, index) => {
    const closing = converted.quarterly.balance.find(other => other.date === row.date && period(other) === period(row));
    const matching = converted.quarterly.cashflow.find(other => other.date === row.date && period(other) === period(row));
    const window = quarterIncome.slice(Math.max(0, index - 3), index + 1);
    const complete = window.length === 4 && window.every((other, i) => !other.currencyConversion.reason
      && (i === 0 || (period(other) === period(window[i - 1]) + 1
        && (Date.parse(other.date) - Date.parse(window[i - 1].date)) / 86400000 >= 60
        && (Date.parse(other.date) - Date.parse(window[i - 1].date)) / 86400000 <= 120)));
    const ltmRevenue = complete ? millions(sum(window, 'revenue')) : null;
    const balanceValid = closing && !closing.currencyConversion.reason;
    const wc = balanceValid ? millions(workingCapital(closing)) : null;
    return { ...supportRow(row, matching), ltmRevenue, workingCapital: wc,
      currentAssets: balanceValid ? millions(number(closing, 'totalCurrentAssets')) : null,
      cash: balanceValid ? millions(number(closing, 'cashAndShortTermInvestments')) : null,
      currentLiabilities: balanceValid ? millions(number(closing, 'totalCurrentLiabilities')) : null,
      currentDebt: balanceValid && finite(closing.shortTermDebt) && finite(closing.capitalLeaseObligationsCurrent)
        ? millions(closing.shortTermDebt + closing.capitalLeaseObligationsCurrent) : null,
      workingCapitalRate: finite(wc) && ltmRevenue > 0 ? wc / ltmRevenue : null };
  });
  const ytdCf = ytdRows.map(row => raw.quarterly.cashflow.find(other => other.date === row.date));
  const ytdFlow = field => ytdRows.length ? millions(sum(ytdCf, field) === null ? null
    : sum(ytdCf, field) * forecastFx.rate) : 0;
  const ytdEbit = ytdRows.length ? sum(ytdRows, 'operatingIncome') * forecastFx.rate / 1e6 : 0;
  const ytdDa = ytdFlow('depreciationAndAmortization');
  const lastAnnual = sorted(comparableAnnual).at(-1);
  const snapshot = {
    version: 1, modelVersion: 'fcff-v2', method: 'FCFF', ticker, currency, sourceCurrency,
    fetchedAt: evidence.capturedAt, valuationDate, quoteDate, quote: { price: quote.price, marketCap: quote.marketCap },
    balance: { date: bs.date, workingCapital: ttm.workingCapital,
      fx: bs.currencyConversion, leaseDebt: millions(number(bs, 'capitalLeaseObligations')) },
    ttm, defaults, forecasts,
    history: { annual: annualHistory, quarterly: quarterlyHistory, warnings: historyWarnings,
      annualCashflowAvailable: !!read('annual_cashflow')?.length },
    annualReference: { date: lastAnnual?.date,
      revenue: millions(number(lastAnnual, 'revenue') === null ? null : lastAnnual.revenue * forecastFx.rate) },
    ytd: { date: bs.date, revenue: ytdRows.length ? sum(ytdRows, 'revenue') * forecastFx.rate / 1e6 : 0,
      ebit: ytdEbit, depreciation: ytdDa, capex: ytdFlow('capitalExpenditure') === null ? null : -ytdFlow('capitalExpenditure'),
      ebitda: finite(ytdDa) && finite(ytdEbit) ? ytdEbit + ytdDa : null },
    provenance: {
      operatingRatios: 'latestFourConsecutiveFiscalQuarters',
      ebitda: 'Analyst ebitdaAvg when supplied; otherwise analyst EBIT plus modeled D&A, explicitly derived. YTD operating EBITDA is reported operating EBIT plus cash-flow D&A, not an adjusted analyst measure.',
      depreciation: 'Analyst EBITDA minus EBIT when nonnegative and both available; otherwise modeled TTM D&A/revenue. Analyst measure definitions are not independently certified.',
      forecastCurrency: 'reportedCurrencyWithHistoricalAnnualScaleCheck',
      forecastFx: { ...forecastFx, assumption: 'constantLatestAvailableOfficialObservation' },
      treasury: curve ? { date: curve.date, year10: curve.year10, ...(currency === 'HKD' ? { currency } : {}) } : null,
      ...(currency === 'HKD' ? { riskFreeRate: 'A dated HKD benchmark is required; US Treasury yields are not substituted' } : {}),
      tax: 'TTM effective tax; scenario assumption, not a marginal-rate forecast',
      kd: 'TTM accounting interest / average reported debt; not a current financing quote',
      erp: '4.75% model assumption, not an FMP forecast',
      beta: 'FMP profile beta; lookback, frequency and benchmark unspecified by the response',
      terminalG: '2.25% model assumption, not an FMP forecast',
      cash: 'All reported cash and short-term investments assumed nonoperating; adjustable',
      investments: 'Long-term investments assumed nonoperating at book value; adjustable, not fair-value evidence',
      priority: 'Preferred and minority book values are adjustable value proxies; cost defaults to common Ke',
      debt: { ...debtBasis, unit: currency, policy: 'preserveReportedDebtWithSeparateCashFlowMatchedLeaseAdjustment' },
      leases: 'Cash-flow-matched debt reconciliation: liabilities whose payments remain in FCFF are not deducted again; financing treatment requires matching profit, depreciation and reinvestment adjustments',
      historicalFx: [...inc, ...cf].map(row => ({ date: row.date, ...row.currencyConversion }))
    },
    reason: null
  };
  if (/Insurance|Banks|Financial Conglomerate/i.test(profile.industry) || ['F', 'GM'].includes(ticker)) {
    snapshot.reason = 'requiresSegmentValuation';
  } else if (debtBasis.reason) snapshot.reason = debtBasis.reason;
  else if (bs.capitalLeaseObligations > 0) {
    snapshot.reason = 'leaseClassificationRequired';
    snapshot.leaseEvidenceAvailable = !!leaseEvidence;
  }
  const reportedBalance = leaseEvidence?.responses?.balance_as_reported?.rows
    || read('balance_as_reported') || [];
  const latestReported = sorted(reportedBalance.filter(row => day(row.date)
    && row.date <= valuationDate)).at(-1);
  const leaseTags = Object.entries(latestReported?.data || {})
    .filter(([tag, value]) => /lease.*liabilit|capitalleaseobligation/i.test(tag)
      && finite(value) && value > 0);
  if (!snapshot.reason && bs.capitalLeaseObligations === 0 && leaseTags.length) {
    snapshot.reason = 'leaseMappingUnverified';
  }
  if (currency === 'HKD' && !latestReported && !snapshot.reason) snapshot.reason = 'leaseMappingUnverified';
  snapshot.provenance.leaseEvidence = {
    date: latestReported?.date || null,
    positiveLiabilityTags: [...new Set(leaseTags.map(([tag]) => tag))]
  };
  return snapshot;
}

module.exports = { prepareSnapshot, financingDebt, workingCapital };
