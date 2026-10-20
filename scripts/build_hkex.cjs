const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { convertStatements, rateFor } = require('../usd_currency.js');
const { value } = require('./usd_financials.cjs');
const scores = require('../statement_scores.js');
const ratios = require('../fcf_ratios.js');
const context = require('../market_context.js');
const { applyOfficialBalance } = require('./official_balance.cjs');
const { applyOfficialCashflows, reviewedSource } = require('./official_cashflows.cjs');
const { applyOfficialRevenue, reviewedSource: reviewedIncomeSource } = require('./official_revenue.cjs');
const { applyPropertyFv } = require('./property_fv.cjs');
const liquidation = require('../liquidation.js');
const { prepareSnapshot, forecastFxRate } = require('./fcff_sources.cjs');
const { reconcileValuation } = require('./hkex_valuation_sources.cjs');
const { reportedGrowth } = require('./reported_growth.cjs');
const config = require('../hkex_stocks.json');
const registered = new Map([...require('../cache/hkex_universe.json').stocks, ...config].map(item => [item.ticker, item]));
const shareCapital = require('../cache/hkex_share_capital.json');

const finite = value => typeof value === 'number' && Number.isFinite(value);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const key = row => Number(row.fiscalYear || row.calendarYear) * 4 + Number(String(row.period)[1]);
const sorted = rows => rows.slice().sort((a, b) => a.date.localeCompare(b.date));
const annualColumns = rows => {
  const latest = sorted(rows).slice(-5);
  return [...Array(5 - latest.length).fill(null), ...latest];
};
const nextDay = date => new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
const millions = value => finite(value) ? value / 1e6 : null;
const divide = (a, b, scale = 1) => finite(a) && finite(b) && b !== 0 ? a / b * scale : null;
const sum = values => values.length && values.every(finite) ? values.reduce((a, b) => a + b, 0) : null;
const hash = data => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
const readRows = (evidence, name) => evidence.responses?.[name]?.ok
  && Array.isArray(evidence.responses[name].rows) ? evidence.responses[name].rows : [];
const flowFields = ['operatingCashFlow', 'capitalExpenditure',
  'netCashProvidedByInvestingActivities', 'netCashProvidedByFinancingActivities'];

function valuationShares(item, evidence, capital = shareCapital[item.ticker]) {
  const asOf = evidence.capturedAt?.slice(0, 10);
  if (item.ticker !== evidence.ticker || item.ticker !== evidence.providerSymbol || !day(asOf)) {
    throw new TypeError('Invalid valuation share identity or date');
  }
  const provider = require('./fcff_sources.cjs').outstandingShares(evidence, asOf);
  const unavailable = reason => ({ ...provider, shares: null, basis: 'unavailable', reason,
    providerComparison: { shares: provider.shares, date: provider.date } });
  if (!capital) return item.shareClassReviewRequired ? unavailable('shareBasisUnverified') : provider;
  const classes = capital.classes;
  const requiredClasses = item.ordinaryShareClasses || ['A', 'H'];
  if (capital.ticker !== item.ticker || capital.coverage !== 'allOrdinaryShareClasses'
      || !day(capital.date) || !day(capital.filingDate) || capital.filingDate < capital.date
      || !/^https:\/\//.test(capital.url || '') || !/^[a-f0-9]{64}$/.test(capital.documentSha256 || '')
      || !Array.isArray(classes) || !classes.length
      || classes.some(row => !row || row.type !== 'ordinary' || typeof row.name !== 'string' || !row.name.trim()
        || !Number.isSafeInteger(row.issuedShares) || row.issuedShares <= 0
        || !Number.isSafeInteger(row.treasuryShares) || row.treasuryShares < 0 || row.treasuryShares > row.issuedShares)
      || new Set(classes.map(row => row.name)).size !== classes.length
      || item.shareClassReviewRequired && (!Array.isArray(requiredClasses) || requiredClasses.length < 2
        || new Set(requiredClasses).size !== requiredClasses.length
        || requiredClasses.some(name => typeof name !== 'string' || !name.trim()
          || !classes.some(row => row.name === name)))) {
    throw new TypeError(`${item.ticker}: invalid issuer-wide ordinary share evidence`);
  }
  if (capital.filingDate > asOf) return unavailable('issuerShareReturnNotYetAvailable');
  const issuedShares = sum(classes.map(row => row.issuedShares));
  const treasuryShares = sum(classes.map(row => row.treasuryShares));
  const outstanding = issuedShares - treasuryShares;
  if (!Number.isSafeInteger(issuedShares) || !Number.isSafeInteger(treasuryShares)
      || !Number.isSafeInteger(outstanding) || outstanding <= 0) {
    throw new TypeError(`${item.ticker}: invalid issuer-wide ordinary share total`);
  }
  const knownCounts = [outstanding, ...classes.map(row => row.issuedShares - row.treasuryShares)];
  const review = capital.providerReview;
  const reviewedMismatch = review?.basis === 'officialOrdinaryShareReturnOverridesReviewedProviderMismatch'
    && day(review.providerDate) && review.providerDate === provider.date
    && day(review.reviewedThrough) && review.reviewedThrough >= asOf
    && Number.isSafeInteger(review.outstandingShares) && review.outstandingShares > 0
    && review.outstandingShares / 1e6 === provider.shares
    && typeof review.note === 'string' && review.note.trim().length > 0;
  if (provider.date > capital.date && provider.shares !== null
      && !knownCounts.some(count => count / 1e6 === provider.shares) && !reviewedMismatch) {
    return unavailable('issuerShareReturnNeedsReview');
  }
  return { shares: outstanding / 1e6, outstandingShares: outstanding, issuedShares, treasuryShares,
    date: capital.date, filingDate: capital.filingDate, basis: 'commonSharesOutstandingExcludingTreasury',
    scope: 'issuerWideOrdinaryShares', source: capital.source, providerSource: capital.url,
    capturedAt: capital.verifiedAt, documentSha256: capital.documentSha256, pdfPages: capital.pdfPages,
    classes, providerComparison: { shares: provider.shares, date: provider.date,
      ...(reviewedMismatch ? { reason: 'reviewedProviderShareMismatch', review } : {}),
      matchingClass: classes.find(row => (row.issuedShares - row.treasuryShares) / 1e6 === provider.shares)?.name || null } };
}

function prepareStatements(evidence, { allowIncomplete = false, sourceWarnings = [] } = {}) {
  const ticker = evidence.ticker, today = evidence.capturedAt?.slice(0, 10);
  if (!registered.has(ticker) || evidence.providerSymbol !== ticker || !day(today)) {
    throw new TypeError('Invalid HKEX source identity or capture date');
  }
  const qualityWarnings = [...sourceWarnings];
  const reviewedPeriodsRequired = registered.get(ticker).reviewedPeriodsRequired;
  const incomeSource = reviewedIncomeSource(ticker);
  const warn = (code, message, extra = {}) => qualityWarnings.push({ code, message, ...extra });
  const statements = { calculationCurrency: 'HKD', fetchedAt: evidence.capturedAt, annual: {}, quarterly: {}, qualityWarnings };
  if (reviewedPeriodsRequired) statements.providerReportedIncome = {
    annual: structuredClone(readRows(evidence, 'annual_income')),
    interim: structuredClone(readRows(evidence, 'income')),
    use: 'Unmodified provider archive; canonical dates and income amounts come from cited reviewed issuer statements.'
  };
  for (const [period, prefix] of [['annual', 'annual_'], ['quarterly', '']]) {
    for (const type of ['income', 'balance', 'cashflow']) {
      const rows = readRows(evidence, `${prefix}${type}`);
      if (!rows.length && period === 'annual') {
        if (!allowIncomplete && (!reviewedPeriodsRequired || !incomeSource)) throw new TypeError(`${ticker}: missing annual ${type}`);
        warn('providerStatementUnavailable', allowIncomplete
          ? 'Provider statement is unavailable; missing financial statements are not fabricated.'
          : 'Provider statement is unavailable; reviewed income is retained without inventing balance sheets or cash flows.',
          { period, type });
      }
      if (rows.some(row => row.symbol !== ticker || !day(row.date) || row.date > today
          || !/^[A-Z]{3}$/.test(row.reportedCurrency)
          || !/^(FY|Q[1-4])$/.test(row.period)
          || !Number.isInteger(Number(row.fiscalYear || row.calendarYear)))
          || new Set(rows.map(row => row.date)).size !== rows.length) {
        throw new TypeError(`${ticker}: invalid ${period} ${type} source records`);
      }
      statements[period][type] = sorted(rows).map(row => ({ ...row }));
    }
  }
  const original = statements.quarterly.income;
  const semiannual = original.length >= 4 && original.every(row => ['Q2', 'Q4'].includes(row.period))
    && original.some(row => row.period === 'Q2') && original.some(row => row.period === 'Q4')
    && original.every((row, i) => !i || key(row) > key(original[i - 1])
      && (key(row) - key(original[i - 1])) % 2 === 0);
  statements.reportingFrequency = semiannual ? 'semiannual' : 'quarterly';
  for (const period of ['annual', 'quarterly']) {
    const annual = period === 'annual';
    for (const type of ['income', 'cashflow']) {
      const rows = statements[period][type];
      rows.forEach((row, i) => {
        if (reviewedPeriodsRequired) {
          const reviewed = (annual ? incomeSource?.annual : type === 'income' && row.period === 'Q2' ? incomeSource?.halfYear : [])
            ?.find(period => period.date === row.date);
          row.periodLength = Number.isSafeInteger(reviewed?.periodLength) ? reviewed.periodLength : null;
          row.periodStartDate = reviewed?.periodStartDate || null;
          if (!row.periodStartDate && row.periodLength) {
            const end = new Date(row.date);
            if (new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate() === end.getUTCDate()) {
              row.periodStartDate = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1 - row.periodLength, 1)).toISOString().slice(0, 10);
            }
          }
          row.reportingFrequency = annual ? 'annual' : statements.reportingFrequency;
          row.derivation = 'providerReported';
          if (!row.periodLength) warn('unverifiedProviderPeriod', 'Provider period duration/date is not matched to a reviewed issuer reporting period.',
            { type, date: row.date });
          return;
        }
        const previous = rows[i - 1];
        if (allowIncomplete && !annual && !semiannual && original.length < 4
            && original.every(row => ['Q2', 'Q4'].includes(row.period))) {
          row.periodStartDate = null;
          row.periodLength = null;
          row.reportingFrequency = 'unknown';
          row.derivation = 'providerReported';
          warn('unverifiedProviderPeriod', 'Short Q2/Q4-only source history cannot establish quarter or half-year duration.',
            { type, date: row.date });
          return;
        }
        const consecutiveAnnual = annual && (!allowIncomplete || previous
          && Number(row.fiscalYear || row.calendarYear) === Number(previous.fiscalYear || previous.calendarYear) + 1);
        if (previous && (consecutiveAnnual || !annual && key(row) === key(previous) + (semiannual ? 2 : 1))) {
          row.periodStartDate = nextDay(previous.date);
        } else {
          const end = new Date(row.date), months = annual ? 12 : semiannual ? 6 : 3;
          const calendarEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate() === end.getUTCDate();
          if (calendarEnd) row.periodStartDate = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1 - months, 1)).toISOString().slice(0, 10);
        }
        row.reportingFrequency = annual ? 'annual' : statements.reportingFrequency;
        row.periodLength = annual ? 12 : semiannual ? 6 : 3;
        if (allowIncomplete && previous && (annual ? consecutiveAnnual : key(row) === key(previous) + (semiannual ? 2 : 1))) {
          const days = (Date.parse(row.date) - Date.parse(previous.date)) / 86400000;
          const start = new Date(row.periodStartDate), end = new Date(row.date);
          const calendarEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate() === end.getUTCDate();
          const months = start.getUTCDate() === 1 && calendarEnd
            ? (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth() + 1 : null;
          const expectedMonths = annual ? 12 : semiannual ? 6 : 3;
          const expectedDays = annual ? [364, 365, 366, 371] : semiannual ? [181, 182, 183, 184, 189] : [89, 90, 91, 92, 98];
          if (months !== null ? months !== expectedMonths : !expectedDays.includes(days)) {
            row.periodLength = annual ? months : null;
            warn(annual ? 'nonFullFiscalPeriod' : 'unverifiedProviderPeriod',
              `Consecutive reporting dates do not establish the claimed ${expectedMonths}-month period.`,
              { type, date: row.date, periodLength: row.periodLength });
          }
        }
        row.derivation = 'providerReported';
      });
    }
  }
  const isPlaceholder = row => {
    const fields = flowFields.filter(field => finite(row[field]));
    return fields.length === flowFields.length && fields.every(field => row[field] === 0);
  };
  const placeholderPattern = statements.annual.cashflow.some(annual => {
    const rows = statements.quarterly.cashflow.filter(row => Number(row.fiscalYear || row.calendarYear)
      === Number(annual.fiscalYear || annual.calendarYear));
    return finite(annual.operatingCashFlow) && annual.operatingCashFlow !== 0
      && rows.length === (semiannual ? 2 : 4) && rows.every(isPlaceholder);
  });
  const cashMovements = ['capitalExpenditure', 'netCashProvidedByInvestingActivities',
    'netCashProvidedByFinancingActivities'];
  const incompleteCashflowCoverage = statements.annual.cashflow.some(annual => {
    const rows = statements.quarterly.cashflow.filter(row => Number(row.fiscalYear || row.calendarYear)
      === Number(annual.fiscalYear || annual.calendarYear));
    return rows.length === (semiannual ? 2 : 4) && cashMovements.some(field => finite(annual[field]) && annual[field] !== 0)
      && rows.every(row => cashMovements.every(field => row[field] === 0));
  }) && statements.quarterly.cashflow.every(row => cashMovements.every(field => row[field] === 0));
  if (incompleteCashflowCoverage) {
    statements.unverifiedInterimCashflow = { reason: 'incompleteCashflowCoverage',
      use: 'Source archive only; duration and complete cash movements are not verified',
      rows: statements.quarterly.cashflow };
    warn('incompleteCashflowCoverage', 'Interim cash movements are not disclosed consistently with the annual statements. Original provider rows are archived, not used as actual quarterly cash flows.');
    statements.quarterly.cashflow = [];
  }
  statements.quarterly.cashflow = statements.quarterly.cashflow.filter(row => {
    const placeholder = placeholderPattern && isPlaceholder(row);
    if (placeholder) {
      if (!statements.unverifiedInterimCashflow) statements.unverifiedInterimCashflow = {
        reason: 'providerCashflowPlaceholder', use: 'Source archive only; not verified reported cash flows', rows: []
      };
      statements.unverifiedInterimCashflow.rows.push(row);
      warn('providerCashflowPlaceholder', 'Quarterly cash-flow placeholders are unavailable, not real zero cash flows.', { date: row.date });
    }
    return !placeholder;
  });
  if (semiannual) {
    for (const type of ['income', 'cashflow']) {
      const halves = statements.quarterly[type].filter(row => row.period === 'Q2');
      const derived = [];
      for (const annual of statements.annual[type]) {
        const first = halves.find(row => Number(row.fiscalYear || row.calendarYear) === Number(annual.fiscalYear || annual.calendarYear)
          && row.reportedCurrency === annual.reportedCurrency);
        if (!first || !day(first.periodStartDate) || annual.periodLength !== 12 || first.periodLength !== 6
            || annual.periodStartDate !== first.periodStartDate) continue;
        if (allowIncomplete && ((Date.parse(annual.date) - Date.parse(first.date)) / 86400000 < 150
            || (Date.parse(annual.date) - Date.parse(first.date)) / 86400000 > 220)) {
          warn('annualInterimReconciliation', 'Annual and H1 dates cannot establish a subsequent six-month H2.',
            { type, date: annual.date, interimDate: first.date });
          continue;
        }
        const second = { ...annual, period: 'Q4', periodStartDate: nextDay(first.date),
          periodLength: 6, reportingFrequency: 'semiannual', derivation: 'annualMinusReportedH1',
          sourceDates: [annual.date, first.date] };
        for (const [field, amount] of Object.entries(annual)) {
          if (!finite(amount) || ['fiscalYear', 'calendarYear', 'periodLength'].includes(field)) continue;
          if (/^eps|^weightedAverageShs|ratio$/i.test(field)) second[field] = null;
          else second[field] = finite(first[field]) ? amount - first[field] : null;
        }
        if (type === 'cashflow') {
          second.cashAtBeginningOfPeriod = finite(first.cashAtEndOfPeriod) ? first.cashAtEndOfPeriod : null;
          second.cashAtEndOfPeriod = finite(annual.cashAtEndOfPeriod) ? annual.cashAtEndOfPeriod : null;
        }
        derived.push(second);
      }
      statements.quarterly[type] = sorted([...halves, ...derived]);
    }
    const interimBalances = statements.quarterly.balance.filter(row => row.period === 'Q2');
    const annualBalances = statements.annual.balance.filter(row => {
      if (!allowIncomplete || !interimBalances.some(interim => interim.date === row.date)) return true;
      warn('annualInterimReconciliation', 'Annual and H1 balance sources assign conflicting fiscal periods to one date; no duplicate Q4 is constructed.',
        { type: 'balance', date: row.date });
      return false;
    });
    statements.quarterly.balance = sorted([...interimBalances,
      ...annualBalances.map(row => ({ ...row, period: 'Q4', derivation: 'reportedAnnualClosingBalance' }))]);
  }
  statements.statementFrequencies = Object.fromEntries(['income', 'balance', 'cashflow'].map(type =>
    [type, statements.quarterly[type].length ? statements.reportingFrequency : 'annual']));
  for (const annual of statements.annual.income) {
    const rows = original.filter(row => Number(row.fiscalYear || row.calendarYear) === Number(annual.fiscalYear || annual.calendarYear));
    const total = sum(rows.map(row => value(row, 'revenue')));
    if (rows.length === (semiannual ? 2 : 4) && finite(total) && finite(annual.revenue)
        && Math.abs(total - annual.revenue) > Math.max(1, Math.abs(annual.revenue) * 0.001)) {
      warn('annualInterimReconciliation', 'Provider annual and interim revenues do not reconcile; their reporting bases must not be mixed.',
        { date: annual.date, annualRevenue: annual.revenue, interimRevenueSum: total });
    }
  }
  return statements;
}

function ttmRows(data, type) {
  const { stride: step, count, minDays, maxDays, frequency } = context.cadence(data, type);
  if (frequency === 'annual') return [];
  const income = sorted(data.quarterly.income), latest = income.at(-1);
  if (!latest) return [];
  const matches = Array.from({ length: count }, (_, index) => {
    const expected = key(latest) - (count - index - 1) * step;
    const rows = data.quarterly[type].filter(row => key(row) === expected);
    const anchor = income.find(row => key(row) === expected);
    return rows.length === 1 && anchor?.date === rows[0].date ? rows[0] : null;
  });
  if (matches.some(row => !row || row.periodLength !== undefined && row.periodLength !== (step === 2 ? 6 : 3))
      || new Set(matches.map(row => row?.comparabilityGroup).filter(Boolean)).size > 1
      || matches.some(row => row.reportedCurrency !== latest.reportedCurrency)
      || matches.some((row, index) => index
      && ((Date.parse(row.date) - Date.parse(matches[index - 1].date)) / 86400000 < minDays
        || (Date.parse(row.date) - Date.parse(matches[index - 1].date)) / 86400000 > maxDays))) return [];
  return matches;
}
function flowValue(data, type, field) {
  const rows = ttmRows(data, type);
  if (context.cadence(data, type).frequency === 'semiannual' && rows.length === 2 && /^eps|^weightedAverageShs/i.test(field)) {
    return value(data.annual[type].find(row => row.date === rows.at(-1).date
      && (row.periodLength === undefined || row.periodLength === 12)), field);
  }

  if (field === 'cashAtEndOfPeriod') return value(rows.at(-1), field);
  if (field === 'cashAtBeginningOfPeriod') return value(rows[0], field);
  if (/ratio$/i.test(field)) {
    let numerator = { grossProfitRatio: 'grossProfit', operatingIncomeRatio: 'operatingIncome',
      incomeBeforeTaxRatio: 'incomeBeforeTax', netIncomeRatio: 'netIncome', ebitdaratio: 'ebitda' }[field];
    if (field === 'netIncomeRatio' && rows.some(row => row.earningsIncludeDiscontinued)) numerator = 'netIncomeFromContinuingOperations';
    return numerator ? divide(sum(rows.map(row => value(row, numerator))), sum(rows.map(row => value(row, 'revenue')))) : null;
  }
  const total = sum(rows.map(row => value(row, field)));
  return /^weightedAverageShs/.test(field) && total !== null ? total / rows.length : total;
}
function marketIncomeRows(data) {
  const latestIncome = sorted([...data.annual.income, ...data.quarterly.income]).at(-1);
  const reportedTwelveMonths = latestIncome?.reportType === 'secondInterim' && latestIncome.periodLength === 12
    && !latestIncome.currencyConversion?.reason;
  return reportedTwelveMonths ? [latestIncome] : ttmRows(data, 'income');
}

function marketLeverage(data, stock) {
  const rows = marketIncomeRows(data);
  const balance = sorted([...data.annual.balance, ...data.quarterly.balance]).at(-1);
  const amount = field => !balance || balance.currencyConversion?.reason ? null : millions(value(balance, field));
  const debt = amount('totalDebt'), cash = amount('cashAndShortTermInvestments');
  const preferred = amount('preferredStock'), minority = amount('minorityInterest');
  const netDebt = finite(debt) && finite(cash) ? debt - cash : null;
  const mcap = finite(stock.mcap) && stock.mcap > 0 ? stock.mcap : null;
  const ev = [mcap, netDebt, preferred, minority].every(finite) ? mcap + netDebt + preferred + minority : null;
  const missingFx = rows.some(row => row.currencyConversion?.reason);
  const ebitda = missingFx ? null : millions(sum(rows.map(row => value(row, 'ebitda'))));
  const reason = !rows.length ? 'missingEbitdaPeriod'
    : missingFx ? 'missingFx'
      : !finite(ebitda) ? 'missingEbitda' : ebitda <= 0 ? 'nonPositiveEbitda' : null;
  const numerators = { ev_to_ebitda: ev, debt_to_ebitda: debt, net_debt_to_ebitda: netDebt };
  const reasons = {}, values = {};
  for (const [field, numerator] of Object.entries(numerators)) {
    reasons[field] = reason || (finite(numerator) ? null : field === 'ev_to_ebitda' && mcap === null
      ? 'currentMarketCapUnavailable' : balance?.currencyConversion?.reason ? 'missingFx' : 'missingReportedCapital');
    values[field] = reasons[field] ? null : divide(numerator, ebitda);
    if (!reasons[field] && !finite(values[field])) {
      reasons[field] = 'invalidCalculation';
      values[field] = null;
    }
  }
  return { ...values, reportedMultiples: {
    version: 1, currency: data.calculationCurrency || 'HKD', unit: 'millions',
    quoteDate: stock.quoteDate || null, balanceDate: balance?.date || null, incomeDates: rows.map(row => row.date),
    periodBasis: rows.length === 1 ? 'reportedTwelveMonthSecondInterim' : 'compatibleReportedTtmPeriods',
    ebitdaBasis: 'reportedOrExplicitlyDerivedEbitda', ebitda, mcap, ev, debt, cash, preferred, minority, netDebt,
    reasons, values
  } };
}

function marketMultiples(data, price, shareSource, shareClassUnverified = false) {
  const rows = marketIncomeRows(data);
  const reportedTwelveMonths = rows.length === 1 && rows[0].reportType === 'secondInterim';
  const balance = sorted([...data.annual.balance, ...data.quarterly.balance]).at(-1);
  const shares = !shareClassUnverified && finite(shareSource.shares) && shareSource.shares > 0
    ? shareSource.shares * 1e6 : null;
  const reportedEps = reportedTwelveMonths ? value(rows[0], 'epsdiluted') : flowValue(data, 'income', 'epsdiluted');
  let eps = reportedEps, basis = 'reportedDilutedTtmEps', reason = null;
  if (!finite(eps)) {
    const earnings = sum(rows.map(row => value(row, 'netIncome')));
    const deductions = sum(rows.map(row => value(row, 'netIncomeDeductions')));
    const noPreferred = value(balance, 'preferredStock') === 0;
    if (shares === null) reason = 'shareBasisUnverified';
    else if (earnings === null) reason = 'missingTtmEarnings';
    else if (!noPreferred && deductions === null) reason = 'preferredEarningsUnverified';
    else {
      eps = (earnings - (deductions ?? 0)) / shares;
      basis = 'ttmCommonEarningsOverCurrentOrdinaryShares';
    }
  }
  const book = value(balance, 'totalStockholdersEquity');
  return {
    pe_trailing: divide(price, eps),
    pb_trailing: divide(price, shares === null ? null : divide(book, shares)),
    marketRatioSources: {
      pe: { basis, reason: finite(price) ? reason || (eps === 0 ? 'zeroEarnings' : null) : 'currentPriceUnavailable',
        ...(reportedTwelveMonths ? { reportType: 'secondInterim', periodLength: 12 } : {}),
        date: rows.at(-1)?.date || null, eps: finite(eps) ? eps : null,
        dates: rows.map(row => row.date), shareDate: basis === 'reportedDilutedTtmEps' ? null : shareSource.date },
      pb: { basis: 'quotedPriceOverIssuerBookValuePerOrdinaryShare',
        reason: !finite(price) ? 'currentPriceUnavailable' : shares === null ? 'shareBasisUnverified'
          : !finite(book) || book === 0 ? 'missingBookEquity' : null,
        date: balance?.date || null, shareDate: shareSource.date, bookEquity: book,
        preferredEquityDeducted: false }
    }
  };
}

function statementTable(data, includeHalfYears = true) {
  const dates = annualColumns(data.annual.income), quarters = sorted(data.quarterly.income).slice(-20);
  const latest = quarters.at(-1), raw = { annual_dates: [...dates.map(row => row?.date.slice(0, 7) || null), latest?.date.slice(0, 7)],
    annual_period_lengths: [...dates.map(row => row?.periodLength), null],
    calculationCurrency: 'HKD', reportingFrequency: data.reportingFrequency,
    quarterly_raw: { dates: quarters.map(row => row.date.slice(0, 7)),
      periodLengths: quarters.map(row => row.periodLength),
      periods: quarters.map(row => row.reportType === 'secondInterim' ? `${row.fiscalYear || row.calendarYear}I2`
        : `${row.fiscalYear || row.calendarYear}${data.reportingFrequency === 'semiannual'
        ? `H${Number(row.period[1]) / 2}` : row.period}`), derivations: quarters.map(row => row.derivation || 'providerReported') } };
  const extras = {
    income: ['epsdiluted', 'grossProfitRatio', 'operatingIncomeRatio', 'incomeBeforeTaxRatio', 'netIncomeRatio', 'ebitdaratio'],
    balance: ['tradeAccountsReceivables', 'vendorNonTradeReceivables'],
    cashflow: ['netCashProvidedByOperatingActivities', 'netCashUsedForInvestingActivites',
      'netCashUsedProvidedByFinancingActivities', 'otherInvestingActivites', 'otherFinancingActivites', 'dividendsPaid']
  };
  raw.statementPeriodLengths = {};
  raw.quarterly_raw.statementPeriodLengths = {};
  for (const type of ['income', 'balance', 'cashflow']) {
    raw.statementPeriodLengths[type] = [...dates.map(date => data.annual[type].find(row => row.date === date?.date)?.periodLength ?? null), null];
    raw.quarterly_raw.statementPeriodLengths[type] = quarters.map(date => data.quarterly[type].find(row => row.date === date.date)?.periodLength ?? null);
    const fields = new Set([...extras[type], ...[...data.annual[type], ...data.quarterly[type]].flatMap(row =>
      Object.keys(row).filter(field => typeof row[field] === 'number' && !['periodLength', 'fiscalYear', 'calendarYear'].includes(field)))]);
    raw[type] = {}; raw.quarterly_raw[type] = {};
    const scale = (field, amount) => !finite(amount) ? null : /^weightedAverageShs|^eps|ratio$/i.test(field) ? amount : amount / 1e6;
    for (const field of fields) {
      const reported = row => type !== 'balance' && row?.periodLength === null ? null : value(row, field);
      raw[type][field] = [...dates.map(date => scale(field, reported(data.annual[type].find(row => row.date === date?.date)))),
        scale(field, type === 'balance' ? value(data.quarterly.balance.find(row => row.date === latest?.date), field) : flowValue(data, type, field))];
      raw.quarterly_raw[type][field] = quarters.map(date => scale(field, reported(data.quarterly[type].find(row => row.date === date.date))));
    }
  }
  for (const field of ['tradeAccountsReceivables', 'vendorNonTradeReceivables']) {
    raw[field] = raw.balance[field]; raw.quarterly_raw[field] = raw.quarterly_raw.balance[field];
  }
  if (includeHalfYears) raw.semiannual_raw = statementTable(ratios.halfYearStatements(data), false).quarterly_raw;
  return raw;
}

function scoreBreakdown(score, data) {
  const rows = type => score.basis === 'comparableAnnual'
    ? data.annual[type].filter(row => row.date === score.date) : ttmRows(data, type);
  const amount = (type, field) => sum(rows(type).map(row => value(row, field)));
  const shown = {
    2: [amount('cashflow', 'operatingCashFlow')],
    4: [amount('cashflow', 'operatingCashFlow'), amount('income', 'netIncome')],
    7: [sum(rows('cashflow').map(row => finite(row.commonStockIssuance) ? row.commonStockIssuance : value(row, 'commonStockIssued')))]
  };
  return score.items.map(item => {
    if (item.applicable === false) return { ...item, metrics: [], displayCurrency: null };
    const monetary = [2, 4, 7].includes(item.id);
    const values = monetary ? shown[item.id] : item.metrics || [];
    const percent = [1, 3, 5, 8].includes(item.id);
    const formatted = values.map(n => !finite(n) ? 'N/A' : monetary ? `HKD ${(n / 1e6).toFixed(2)} M`
      : `${(n * (percent ? 100 : 1)).toFixed(2)}${percent ? '%' : ''}`);
    const details = item.passed === null ? 'N/A' : formatted.join(' / ');
    return { ...item, metrics: values, displayCurrency: monetary ? 'HKD' : null,
      detail: details, detail_zh: `${details}（評分按原始報告幣別比較，金額以 HKD 顯示）`,
      detail_en: `${details} (scored on comparable native-currency reports; displayed amounts in HKD)` };
  });
}

function priceHistory(evidence) {
  const tradingCurrency = registered.get(evidence.ticker)?.tradingCurrency;
  if (tradingCurrency && tradingCurrency !== 'HKD') {
    throw new TypeError(`${evidence.ticker}: unsupportedTradingCurrency (${tradingCurrency}); original prices are not HKD quotes`);
  }
  const rows = new Map();
  for (const name of ['prices_older', 'prices_recent']) {
    const sourceRows = readRows(evidence, name);
    if (sourceRows.length >= 5000) throw new TypeError(`${evidence.ticker}: potentially truncated price response`);
    for (const row of sourceRows) {
      if (row.symbol !== evidence.ticker || !day(row.date) || row.date > evidence.capturedAt.slice(0, 10)
          || !finite(row.close) || row.close <= 0 || row.volume != null && (!Number.isSafeInteger(row.volume) || row.volume < 0)) {
        throw new TypeError(`${evidence.ticker}: invalid daily price evidence`);
      }
      const record = [row.date, row.close, row.volume ?? null];
      if (rows.has(row.date) && JSON.stringify(rows.get(row.date)) !== JSON.stringify(record)) throw new TypeError('Conflicting price dates');
      rows.set(row.date, record);
    }
  }
  if (!rows.size) throw new TypeError(`${evidence.ticker}: no genuine price history`);
  const ordered = [...rows.values()].sort((a, b) => a[0].localeCompare(b[0]));
  return { version: 1, ticker: evidence.ticker, providerSymbol: evidence.ticker, currency: 'HKD',
    source: 'FMP historical-price-eod/full', priceBasis: 'splitAdjustedClose', volumeBasis: 'providerReported',
    fetchedAt: evidence.capturedAt, requestedFrom: ordered[0][0], requestedTo: evidence.capturedAt.slice(0, 10),
    columns: ['date', 'close', 'volume'], rows: ordered };
}

function forwardPriceEarnings(item, evidence, rates, shareSource, price, annualIncome = null) {
  const asOf = evidence.capturedAt.slice(0, 10);
  const unavailable = reason => ({ value: null, reason, asOf, source: 'FMP analyst-estimates',
    basis: 'nextFiscalYearConsensusEps', fetchedAt: evidence.capturedAt });
  if (!finite(price) || price <= 0) return unavailable('missingQuote');
  const annual = (annualIncome || readRows(evidence, 'annual_income')).filter(row => row.symbol === item.ticker
    && day(row.date) && row.date <= asOf && ['filingDate', 'acceptedDate'].every(field =>
      !row[field] || (typeof row[field] === 'string' && day(row[field].slice(0, 10))
        && row[field].slice(0, 10) <= asOf)))
    .sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  const estimates = readRows(evidence, 'estimates');
  if (!annual || !/^[A-Z]{3}$/.test(annual.reportedCurrency)) return unavailable('forecastCurrencyUnverified');
  if (estimates.some(row => row.symbol !== item.ticker)) return unavailable('forecastSymbolMismatch');
  const year = Number(asOf.slice(0, 4)), end = annual.date.slice(4);
  const expected = `${year}${end}` > asOf ? `${year}${end}` : `${year + 1}${end}`;
  const next = estimates.filter(row => day(row.date) && row.date > asOf
    && Math.abs(Date.parse(row.date) - Date.parse(expected)) <= 10 * 86400000);
  if (next.length !== 1) return unavailable(next.length ? 'ambiguousForecast' : 'missingNextFiscalForecast');
  const forecast = next[0];
  if (!finite(forecast.epsAvg) || forecast.epsAvg <= 0 || !Number.isInteger(forecast.numAnalystsEps)
      || forecast.numAnalystsEps <= 0) {
    return unavailable('nonPositiveOrMissingForecastEps');
  }
  const matched = estimates.filter(row => day(row.date)
    && Math.abs(Date.parse(row.date) - Date.parse(annual.date)) <= 10 * 86400000);
  const scaleField = item.financial ? 'netIncome' : 'revenue';
  const actual = annual[scaleField], historical = matched.length === 1 ? matched[0][`${scaleField}Avg`] : null;
  const currencyScale = finite(actual) && actual > 0 && finite(historical) ? historical / actual : null;
  if (currencyScale === null || currencyScale < 0.75 || currencyScale > 1.25) {
    return unavailable('forecastCurrencyScaleUnverified');
  }
  const impliedShares = finite(forecast.netIncomeAvg) ? forecast.netIncomeAvg / forecast.epsAvg : null;
  const shareScale = impliedShares !== null && finite(shareSource?.shares) && shareSource.shares > 0
    ? impliedShares / (shareSource.shares * 1e6) : null;
  if (shareScale === null || shareScale < 0.75 || shareScale > 1.25) return unavailable('forecastShareScaleUnverified');
  const fx = forecastFxRate(rates, annual.reportedCurrency, 'HKD', asOf);
  if (fx.reason || !finite(fx.rate) || fx.rate <= 0) return unavailable('missingForecastFx');
  const epsHkd = forecast.epsAvg * fx.rate;
  const value = price / epsHkd;
  if (!finite(value) || value <= 0) return unavailable('invalidForecastMultiple');
  const currencyNoteZh = annual.reportedCurrency === 'HKD'
    ? `預測 EPS 已以 HKD 列示：${epsHkd.toFixed(4)}，無須匯率換算。`
    : `EPS ${annual.reportedCurrency} ${forecast.epsAvg.toFixed(4)} 換算為 HKD ${epsHkd.toFixed(4)}；匯率觀察日 ${fx.observationDate}。`;
  const currencyNoteEn = annual.reportedCurrency === 'HKD'
    ? `Forecast EPS is already HKD ${epsHkd.toFixed(4)}; no FX conversion is needed.`
    : `EPS ${annual.reportedCurrency} ${forecast.epsAvg.toFixed(4)} converts to HKD ${epsHkd.toFixed(4)}; FX observation ${fx.observationDate}.`;
  return { ...unavailable(null), value, fiscalDate: forecast.date, eps: forecast.epsAvg, epsHkd,
    currency: annual.reportedCurrency, fx, analysts: forecast.numAnalystsEps,
    currencyScaleCheck: { date: annual.date, field: scaleField, ratio: currencyScale },
    shareScaleCheck: { impliedForecastShares: impliedShares, currentOutstandingShares: shareSource.shares * 1e6, ratio: shareScale },
    epsBasis: 'Provider analyst EPS; basic/diluted and adjusted/GAAP definitions are not independently certified',
    noteZh: `下一財年截至 ${forecast.date}：股價 ÷ 分析師預測 EPS。${currencyNoteZh}這是分析師預測，基本／攤薄及經調整／會計準則口徑未獨立核實，不是已公布盈利或 DCF 股數分母。`,
    noteEn: `FY1 ends ${forecast.date}: price / analyst forecast EPS. ${currencyNoteEn} Analyst forecast, not reported earnings or the DCF share denominator; basic/diluted and adjusted/GAAP definitions are not independently certified.` };
}

function applyForecastTaxAssumption(snapshot, item) {
  const assumption = item.forecastTaxAssumption;
  if (!assumption) return snapshot;
  if (!finite(assumption.rate) || assumption.rate < 0 || assumption.rate > 100
      || assumption.basis !== 'userApprovedHongKongStatutoryForecastScenario') {
    throw new TypeError(`${item.ticker}: invalid forecast tax assumption`);
  }
  if (snapshot.defaults?.tax !== null) return snapshot;
  return { ...snapshot,
    defaults: { ...snapshot.defaults, tax: assumption.rate },
    forecastTaxAssumption: { ...assumption, observedEffectiveTax: null },
    provenance: { ...snapshot.provenance,
      tax: 'User-approved Hong Kong statutory forecast scenario, adjustable; not an observed group effective tax rate or a jurisdiction-weighted forecast' }
  };
}

function applyNoncontrollingClaimAssumption(snapshot, item) {
  const assumption = item.noncontrollingClaimAssumption;
  if (!assumption) return snapshot;
  if (assumption.value !== 0 || assumption.basis !== 'userApprovedZeroNoncontrollingClaimScenario') {
    throw new TypeError(`${item.ticker}: invalid noncontrolling claim assumption`);
  }
  const reportedBookValue = snapshot.defaults?.minority;
  if (!finite(reportedBookValue) || reportedBookValue >= 0) return snapshot;
  return { ...snapshot,
    defaults: { ...snapshot.defaults, minority: assumption.value },
    noncontrollingClaimAssumption: { ...assumption, reportedBookValue,
      scope: 'noncontrollingEquityOnlyExcludingShareholderLoans' },
    provenance: { ...snapshot.provenance,
      priority: 'Preferred book proxy; noncontrolling equity uses a user-approved adjustable zero-value scenario, not verified fair value. Common equity may be overstated if the actual equity claim has positive value. Shareholder loans and other financing liabilities are not waived by this equity scenario.' }
  };
}

function compileStock(item, evidence, rates, moatReports = {}, previousStock = {}, treasury = null, options = {}) {
  const profile = readRows(evidence, 'profile'), quotes = readRows(evidence, 'quote');
  if (profile.length !== 1 || profile[0].symbol !== item.ticker || profile[0].currency !== 'HKD'
      || quotes.length !== 1 || quotes[0].symbol !== item.ticker || !finite(quotes[0].price) || quotes[0].price <= 0
      || !finite(quotes[0].marketCap) || quotes[0].marketCap <= 0 || !finite(quotes[0].timestamp)) {
    throw new TypeError(`${item.ticker}: HKD quote identity cannot be verified`);
  }
  const p = profile[0], observedQuote = quotes[0];
  const quoteDate = new Date(observedQuote.timestamp * 1000).toISOString().slice(0, 10);
  if (quoteDate > evidence.capturedAt.slice(0, 10)) throw new TypeError(`${item.ticker}: future quote`);
  const quoteAgeDays = (Date.parse(evidence.capturedAt.slice(0, 10)) - Date.parse(quoteDate)) / 86400000;
  const staleQuote = quoteAgeDays > 14;
  const quote = staleQuote ? { ...observedQuote, price: null, marketCap: null } : observedQuote;
  const reported = applyOfficialRevenue(applyOfficialCashflows(applyOfficialBalance(prepareStatements(evidence, options), item.ticker),
    item.ticker, reviewedSource(item.ticker)), item.ticker);
  if (item.reviewedPeriodsRequired) {
    reported.providerReportedBalance = structuredClone({
      annual: reported.annual.balance, quarterly: reported.quarterly.balance
    });
    const closing = new Map([...reported.quarterly.balance, ...reported.annual.balance].map(row => [row.date, row]));
    for (const period of ['annual', 'quarterly']) {
      const aligned = new Map();
      const anchors = period === 'annual' ? reported.annual.income
        : [...reported.annual.income.map(row => ({ ...row, period: 'Q4' })), ...reported.quarterly.income];
      for (const income of anchors) {
        const balance = closing.get(income.date);
        if (balance && balance.reportedCurrency === income.reportedCurrency) aligned.set(income.date, { ...balance, period: income.period, fiscalYear: income.fiscalYear,
          reportType: income.reportType, derivation: 'reportedExactDateClosingBalance' });
      }
      reported[period].balance = sorted([...aligned.values()]);
    }
    reported.statementFrequencies.balance = 'semiannual';
    const usedDates = new Set([...reported.annual.balance, ...reported.quarterly.balance].map(row => row.date));
    if ([...closing.keys()].some(date => !usedDates.has(date))) reported.qualityWarnings.push({
      code: 'unmatchedProviderBalanceArchived',
      message: 'Provider balances without an exact reviewed reporting-date/currency match remain archived, not used as certified current or annual closing balances.'
    });
  }
  const raw = applyPropertyFv(reported, item.ticker);
  const data = convertStatements(raw, rates);
  const chart = options.allowIncomplete && !['prices_older', 'prices_recent'].some(name => readRows(evidence, name).length)
    ? { version: 1, ticker: item.ticker, currency: 'HKD', priceBasis: 'splitAdjustedClose', rows: [], reason: 'sourceUnavailable' }
    : priceHistory(evidence);
  const latest = sorted(data.quarterly.income).at(-1),
    bs = sorted([...data.annual.balance, ...data.quarterly.balance]).at(-1);
  const balance = field => value(bs, field), flow = (type, field) => flowValue(data, type, field);
  const shareSource = valuationShares(item, evidence);
  const shareClassUnverified = item.shareClassReviewRequired && shareSource.scope !== 'issuerWideOrdinaryShares';
  const treasuryCurve = treasury?.ok && Array.isArray(treasury.rows) ? sorted(treasury.rows.filter(row =>
    day(row.date) && row.date <= evidence.capturedAt.slice(0, 10) && finite(row.year10)
    && (Date.parse(evidence.capturedAt.slice(0, 10)) - Date.parse(row.date)) / 86400000 <= 14)).at(-1) : null;
  const currentRatioNotApplicable = require('../cache/pf_applicability.json').tickers[item.ticker] || null;
  const table = statementTable(data), score = scores.calculate(reported, { currentRatioNotApplicable });
  const scoreHash = hash({ annual: reported.annual, interim: reported.quarterly,
    ...(score.applicability ? { applicability: score.applicability } : {}) });
  const previousScore = previousStock.ratingSources?.fScore;
  const scoreRelease = readRows(evidence, 'transcript_dates').find(row => {
    const sourceRow = [...raw.quarterly.income, ...raw.annual.income].find(row => row.date === score.date);
    return sourceRow && Number(row.fiscalYear) === Number(sourceRow.fiscalYear || sourceRow.calendarYear)
      && Number(row.quarter) === (sourceRow.period === 'FY' ? 4 : Number(sourceRow.period[1]))
      && day(row.date?.slice(0, 10)) && row.date.slice(0, 10) <= evidence.capturedAt.slice(0, 10);
  });
  const release = scoreRelease && readRows(evidence, 'earnings_releases').find(row => row.symbol === item.ticker
    && row.date === scoreRelease.date && (finite(row.epsActual) || finite(row.revenueActual)));
  const transcripts = readRows(evidence, 'transcript_latest').filter(row => row.symbol === item.ticker && day(row.date?.slice(0, 10))
    && row.date.slice(0, 10) <= evidence.capturedAt.slice(0, 10));
  const moatInput = { methodVersion: 'hkex-qualitative-evidence-v2', ticker: item.ticker,
    profile: { companyName: p.companyName, description: p.description, industry: item.industry },
    reportingCurrency: latest?.sourceReportedCurrency || data.annual.income.at(-1)?.sourceReportedCurrency || null,
    statements: { ...raw, fetchedAt: undefined },
    displayStatements: { ...data, fetchedAt: undefined }, fScore: score, transcripts };
  const fingerprint = hash(moatInput), candidate = moatReports[item.ticker];
  const moat = candidate?.evidenceHash === fingerprint ? candidate.report : null;
  const priorMoat = moat || candidate?.report || null;
  const legacyKeys = ['m1_brand_pricing', 'm2_patents_regulatory', 'm3_high_switching_costs', 'm4_network_effects',
    'm5_cost_advantage_scale', 'm6_unique_geography_assets', 'm7_operational_efficiency', 'm8_capital_allocation',
    'm9_customer_retention', 'm10_durability'];
  if (priorMoat && !legacyKeys.every(key => priorMoat[key] && (priorMoat[key].score === null
      || Number.isInteger(priorMoat[key].score) && priorMoat[key].score >= 0 && priorMoat[key].score <= 10))) {
    throw new TypeError(`${item.ticker}: invalid moat score report`);
  }
  const stock = {
    name: item.name, company_name: p.companyName, ticker: item.ticker, displayCode: item.displayCode,
    market: 'HKEX', exchange: 'HKEX', sector: item.sector, industry: item.industry, fmp_symbol: item.ticker,
    reportedCurrency: latest?.sourceReportedCurrency || data.annual.income.at(-1)?.sourceReportedCurrency || null,
    calculationCurrency: 'HKD',
    reportingFrequency: raw.reportingFrequency, statementFrequencies: raw.statementFrequencies,
    balanceClassificationSource: raw.balanceClassificationSource, cashflowProvenance: raw.cashflowProvenance,
    revenueProvenance: raw.revenueProvenance,
    universeMembership: item.universeMembership || 'Hang Seng Index',
    businessScopeNote: item.businessScopeNote || null,
    ...(item.corporateDcfApplicability ? { corporateDcfApplicability: item.corporateDcfApplicability } : {}),
    propertyFvProvenance: raw.propertyFvProvenance,
    qualityWarnings: raw.qualityWarnings, price: quote.price, quoteDate, shares: shareClassUnverified ? null : shareSource.shares,
    quoteAvailability: { reason: staleQuote ? 'staleQuote' : null, ageDays: quoteAgeDays, capturedAt: evidence.capturedAt },
    ...(staleQuote ? { lastTrade: { date: quoteDate, price: observedQuote.price,
      marketCap: observedQuote.marketCap, currency: 'HKD' } } : {}),
    shares_display: shareSource.shares, shares_outstanding: shareClassUnverified || shareSource.shares === null ? null
      : shareSource.outstandingShares ?? Math.round(shareSource.shares * 1e6),
    shareSource, shareBasis: shareClassUnverified ? 'unverifiedMixedShareClasses' : shareSource.basis,
    mcap: millions(quote.marketCap), debt: millions(balance('totalDebt')), cash: millions(balance('cashAndCashEquivalents')),
    short_term_investments: millions(balance('shortTermInvestments')), cash_and_short_term: millions(balance('cashAndShortTermInvestments')),
    beta: finite(p.beta) ? p.beta : null, beta_5y: null, rf: treasuryCurve?.year10 ?? null, erp: 4.75, kd: null, tax: null,
    rateSource: { currency: 'USD', date: treasuryCurve?.date || null, year10: treasuryCurve?.year10 ?? null,
      basis: 'userDirectedUsdTreasuryProxyUnderHkdUsdPeg' },
    growth_10y: Array(10).fill(null), g1: null, g2: null, g: 2.25, wacc: null,
    fcf0: millions(flow('cashflow', 'freeCashFlow')), f_score: score.score,
    f_score_breakdown: scoreBreakdown(score, raw.propertyFvProvenance ? convertStatements(reported, rates) : data), moat: priorMoat,
    fair_val: null, default_fair_val: null, premium_pct: null, is_undervalued: null,
    pe_forward: null, pb_forward: null, target_price: null, dcf_model_ev: null,
    statements_raw: table, reported_growth: reportedGrowth(data, rates), real_history: {},
    peers: readRows(evidence, 'peers').map(row => row.symbol).filter(symbol => typeof symbol === 'string'),
    fin_valuation: { is_financial: !!item.financial }, image: p.image || null, logo: p.image || null,
    website: p.website || null, ceo: p.ceo || null, full_time_employees: Number(p.fullTimeEmployees) > 0 ? Number(p.fullTimeEmployees) : null,
    description: p.description || null, description_en: p.description || null, description_zh: priorMoat?.description_zh || null,
    address: p.address || null, city: p.city || null, state: p.state || null, zip: p.zip || null, country: p.country || null,
    phone: p.phone || null, full_address: [p.address, p.city, p.state, p.zip, p.country].filter(Boolean).join(', '),
    year_high: staleQuote ? null : quote.yearHigh ?? null, year_low: staleQuote ? null : quote.yearLow ?? null, range_52w: staleQuote ? null : p.range || null,
    all_time_high: null, all_time_low: null, inst_ownership_pct: null, insider_ownership_pct: null,
    top_holders: [], insider_trades: [], stock_splits: readRows(evidence, 'splits').filter(row => row.symbol === item.ticker),
    news: readRows(evidence, 'news').filter(row => row.symbol === item.ticker && row.publishedDate?.slice(0, 10) <= evidence.capturedAt.slice(0, 10)),
    historical_dcf_series: null, real_5y_prices: [],
    dataAvailability: { currentPrice: staleQuote ? 'staleQuote' : null,
      hkdRiskFreeRate: treasuryCurve ? 'usdTreasuryProxyNotObservedHkdYield' : 'missingHkdRiskFreeRate', asReportedLeases: readRows(evidence, 'balance_as_reported').length ? null : 'sourceUnavailable',
      ownership: 'Provider coverage has not been verified for HKEX', historicalDcf: 'No point-in-time historical valuations are available' },
    ratingSources: {
      fScore: { asOfDate: score.date, period: score.period, basis: score.basis, evaluatedTests: score.evaluatedTests,
        passedTests: score.passedTests, reason: score.reason, evidenceHash: scoreHash, checkedAt: evidence.capturedAt,
        ...(score.assessmentType ? { assessmentType: score.assessmentType, applicableTests: score.applicableTests,
          standardScore: score.standardScore, currentRatioApplicability: score.applicability } : {}),
        releaseDate: release?.date || null, relatedCallDate: scoreRelease?.date || null,
        scoringCurrency: raw.annual.income.at(-1)?.reportedCurrency || null,
        updatedAt: previousScore?.evidenceHash === scoreHash ? previousScore.updatedAt : evidence.capturedAt,
        applicability: item.financial ? 'Financial-sector accounting limits comparability of standard nonfinancial-company tests' : null },
      moat: { asOfDate: latest?.date || null, period: latest ? `${latest.fiscalYear || latest.calendarYear}${latest.period}` : null,
        evidenceHash: candidate?.evidenceHash || null, currentEvidenceHash: fingerprint, updatedAt: candidate?.updatedAt || null,
        reason: moat ? null : priorMoat ? 'staleEvidence' : 'analysisUnavailable',
        checkedAt: evidence.capturedAt, lastError: candidate?.lastError || null,
        ...(candidate?.businessResearch ? { businessResearch: candidate.businessResearch } : {}),
        ...(candidate?.assessmentPolicy ? { assessmentPolicy: candidate.assessmentPolicy, provider: candidate.provider, model: candidate.model } : {}),
        statementDate: latest?.date || null, transcriptDate: transcripts[0]?.date || null,
        method: 'AI qualitative assessment anchored to dated financial statements and available transcript; not a reported accounting measure' }
    }
  };
  stock.net_debt = finite(stock.debt) && finite(stock.cash_and_short_term) ? stock.debt - stock.cash_and_short_term : null;
  stock.ev = finite(stock.mcap) && finite(stock.net_debt) ? stock.mcap + stock.net_debt : null; stock.fmp_official_ev = stock.ev;
  Object.assign(stock, marketMultiples(data, stock.price, shareSource, shareClassUnverified));
  stock.pe_forward_source = forwardPriceEarnings(item, evidence, rates, shareSource, stock.price, raw.annual.income);
  stock.pe_forward = stock.pe_forward_source.value;
  stock.ps_ratio = item.shareClassReviewRequired ? null : divide(stock.mcap, millions(flow('income', 'revenue')));
  stock.ev_to_ebitda = divide(stock.ev, millions(flow('income', 'ebitda')));
  stock.debt_to_ebitda = divide(stock.debt, millions(flow('income', 'ebitda')));
  stock.net_debt_to_ebitda = divide(stock.net_debt, millions(flow('income', 'ebitda')));
  if (!item.financial) Object.assign(stock, marketLeverage(data, stock));
  stock.fcf_to_ev = divide(stock.fcf0, stock.ev, 100); stock.fcf_to_mcap = divide(stock.fcf0, stock.mcap, 100);
  stock.div_yield = divide(-flow('cashflow', 'dividendsPaid'), quote.marketCap, 100);
  if (flow('cashflow', 'dividendsPaid') === null) stock.div_yield = null;
  stock.liab_to_assets = divide(balance('totalLiabilities'), balance('totalAssets'), 100);
  stock.cash_to_assets = divide(balance('cashAndShortTermInvestments'), balance('totalAssets'), 100);
  stock.current_ratio = divide(balance('totalCurrentAssets'), balance('totalCurrentLiabilities'));
  const returns = ratios.calculateReturns(data).at(-1);
  stock.roe = returns?.ratios.roe.value ?? null; stock.roa = returns?.ratios.roa.value ?? null;
  const annual = annualColumns(data.annual.income);
  for (const [field, type, sourceField] of [
    ['revenue', 'income', 'revenue'], ['net_income', 'income', 'netIncome'], ['gross_profit', 'income', 'grossProfit'],
    ['operating_income', 'income', 'operatingIncome'], ['cfo', 'cashflow', 'operatingCashFlow'],
    ['capex', 'cashflow', 'capitalExpenditure'], ['fcf', 'cashflow', 'freeCashFlow']
  ]) stock.real_history[field] = [...annual.map(date => millions(value(data.annual[type].find(row => row.date === date?.date), sourceField))),
    millions(flow(type, sourceField))];
  const sourceBalance = sorted([...raw.annual.balance, ...raw.quarterly.balance]).at(-1);
  const fx = sourceBalance ? rateFor(rates, sourceBalance.reportedCurrency, null, sourceBalance.date, 'closing', 'HKD')
    : { reason: 'missingBalance' };
  stock.liquidation = { version: 1, ticker: item.ticker, currency: 'HKD',
    source: sourceBalance?.balanceClassificationSource ? 'HKEX official classified balance sheet; FMP quote'
      : 'FMP stable balance-sheet-statement and quote',
    balanceSource: sourceBalance?.balanceClassificationSource || null,
    fetchedAt: evidence.capturedAt, balanceDate: sourceBalance?.date || null, quoteDate, sourceCurrency: sourceBalance?.reportedCurrency || null,
    fx, receivablesBasis: 'trade', shareBasis: stock.shareBasis,
    quote: { currency: 'HKD', date: quoteDate, price: quote.price, marketCap: quote.marketCap,
      availabilityReason: staleQuote ? 'staleQuote' : null },
    sharesOutstanding: stock.shares_outstanding, shareSource,
    amounts: { currentAssets: balance('totalCurrentAssets'), totalLiabilities: balance('totalLiabilities'),
      cashAndShortTermInvestments: balance('cashAndShortTermInvestments'), tradeReceivables: balance('accountsReceivables'),
      inventory: balance('inventory'), preferredStock: balance('preferredStock') } };
  liquidation.calculate(stock.liquidation, item.ticker).values.forEach((value, i) => { stock[`liq_val_${i + 1}`] = value; });
  let snapshot = applyForecastTaxAssumption(reconcileValuation(
    prepareSnapshot(item.ticker, evidence, treasury, rates, null, { statementData: reported, shareSource }), reported, undefined, rates), item);
  snapshot = applyNoncontrollingClaimAssumption(snapshot, item);
  if (item.requiresSegmentValuation) snapshot.reason = 'requiresSegmentValuation';
  if (staleQuote) snapshot.reason = 'staleQuote';
  if (item.generalCorporateValuationWarning) snapshot.valuationCaution = 'generalCorporateFcffNotReitAffoOrNav';
  if (raw.qualityWarnings.some(warning => warning.code === 'annualInterimReconciliation') && !snapshot.reason
      && !['matchedOfficialAnnualComponents', 'matchedOfficialTtmComponents'].includes(snapshot.officialReconciliation?.basis)) {
    snapshot.reason = 'statementReconciliationRequired';
  }
  if (item.financial) {
    const reference = ratios.financialReference(data, { shares: stock.shares });
    if (shareClassUnverified) { reference.reason = 'shareBasisUnverified'; reference.tbvps = null; }
    const annualPayout = sorted(data.annual.cashflow).at(-1);
    const payoutBasis = flow('cashflow', 'dividendsPaid') === null ? annualPayout : null;
    const dividends = payoutBasis ? value(payoutBasis, 'dividendsPaid') : flow('cashflow', 'dividendsPaid');
    const buybacks = payoutBasis ? value(payoutBasis, 'commonStockRepurchased') : flow('cashflow', 'commonStockRepurchased');
    const ke = finite(stock.rf) && finite(stock.beta) ? stock.rf + stock.beta * stock.erp : null;
    stock.fin_valuation = { is_financial: true, reference, tbvps: reference.tbvps, rote: reference.rote,
      bvps: divide(millions(balance('totalStockholdersEquity')), stock.shares), ke, g: 2.25,
      tangibleEquity: finite(balance('totalStockholdersEquity')) && finite(balance('goodwillAndIntangibleAssets'))
        ? millions(balance('totalStockholdersEquity') - balance('goodwillAndIntangibleAssets')) : null,
      totalPayout: finite(dividends) && finite(buybacks)
        ? millions(Math.abs(dividends) + Math.min(Math.abs(buybacks), Math.abs(dividends) * 1.5)) : null,
      dps_total: stock.shares > 0 && finite(dividends) && finite(buybacks)
        ? (Math.abs(dividends) + Math.min(Math.abs(buybacks), Math.abs(dividends) * 1.5)) / (stock.shares * 1e6) : null,
      payoutSource: { basis: payoutBasis ? 'latestReportedAnnualNotCurrentTtm' : 'reportedTtm',
        date: payoutBasis?.date || latest?.date || null },
      excess_return_fair: null, ddm_fair: null, pb_tangible: divide(stock.price, reference.tbvps),
      unavailableReason: shareClassUnverified ? 'shareBasisUnverified' : ke === null ? 'missingHkdRiskFreeRate' : null };
  }
  stock.currencyConversion = { sourceCurrency: stock.reportedCurrency, target: 'HKD', source: rates.source,
    prepared: rates.prepared, income: latest?.currencyConversion, balance: bs?.currencyConversion,
    reason: [latest, bs].find(row => row?.currencyConversion?.reason)?.currencyConversion.reason || null };
  return { stock, statements: raw, chart, snapshot, moatInput, fingerprint };
}

function compile(directory, output, rates, reports = {}, previous = {}, treasury = null) {
  const market = {}, fcff = { version: 1, method: 'FCFF', stocks: {}, betaSources: {}, outcomes: {} }, evidenceInputs = [];
  const write = (file, data, prefix = '') => {
    const target = path.join(output, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, prefix + JSON.stringify(data) + (prefix ? ';' : '') + '\n');
  };
  for (const item of config) {
    const evidence = JSON.parse(fs.readFileSync(path.join(directory, `${item.ticker}.json`), 'utf8'));
    const result = compileStock(item, evidence, rates, reports, previous[item.ticker], treasury);
    market[item.ticker] = result.stock;
    if (!item.financial) fcff.stocks[item.ticker] = result.snapshot;
    fcff.betaSources[item.ticker] = { value: result.stock.beta, source: 'FMP profile beta', lookback: null,
      frequency: null, benchmark: null, capturedAt: evidence.capturedAt };
    const status = result.snapshot.reason || 'operatingInputsAvailable';
    fcff.outcomes[status] = (fcff.outcomes[status] || 0) + 1;
    write(path.join('cache', 'financials', `${item.ticker}_statements_v2.json`), result.statements);
    write(path.join('cache', 'price_charts', `${item.ticker}.json`), result.chart);
    evidenceInputs.push({ ...result.moatInput, evidenceHash: result.fingerprint,
      moatScreen: { calculationCurrency: result.stock.calculationCurrency, marketCapMillions: result.stock.mcap },
      existing: reports[item.ticker] || null });
  }
  write('hk_market_dcf.json', market);
  write('hk_market_data.js', market, 'window.HK_MARKET_DATA = ');
  write('hk_fcff_data.js', fcff, 'window.HK_FCFF_DATA = ');
  return evidenceInputs;
}
if (require.main === module) {
  const root = path.join(__dirname, '..'), input = path.resolve(process.argv[2] || path.join(root, 'hkex-source-output'));
  const output = path.resolve(process.argv[3] || root);
  const reportsPath = process.argv[4] || path.join(root, 'cache', 'hkex_moat.json');
  const reports = fs.existsSync(reportsPath) ? JSON.parse(fs.readFileSync(reportsPath, 'utf8')) : {};
  const rates = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'fx', 'hkd_rates.json'), 'utf8'));
  const previousPath = path.join(root, 'hk_market_dcf.json');
  const previous = fs.existsSync(previousPath) ? JSON.parse(fs.readFileSync(previousPath, 'utf8')) : {};
  const treasuryPath = path.join(input, 'treasury.json');
  const treasury = fs.existsSync(treasuryPath) ? JSON.parse(fs.readFileSync(treasuryPath, 'utf8')) : null;
  const inputs = compile(input, output, rates, reports, previous, treasury);
  if (process.env.MOAT_EVIDENCE_OUTPUT) fs.writeFileSync(process.env.MOAT_EVIDENCE_OUTPUT, JSON.stringify(inputs));
  console.log(`Built ${inputs.length} real HKEX listings in HKD; incomplete evidence remains explicitly unavailable.`);
}
module.exports = { prepareStatements, ttmRows, flowValue, marketMultiples, marketLeverage, statementTable, scoreBreakdown, priceHistory, compileStock, compile, hash, valuationShares, forwardPriceEarnings, applyForecastTaxAssumption, applyNoncontrollingClaimAssumption };
