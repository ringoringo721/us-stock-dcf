const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { convertStatements, rateFor } = require('../usd_currency.js');
const { value } = require('./usd_financials.cjs');
const scores = require('../statement_scores.js');
const ratios = require('../fcf_ratios.js');
const liquidation = require('../liquidation.js');
const { prepareSnapshot } = require('./fcff_sources.cjs');
const config = require('../hkex_stocks.json');

const finite = value => typeof value === 'number' && Number.isFinite(value);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const key = row => Number(row.fiscalYear || row.calendarYear) * 4 + Number(String(row.period)[1]);
const sorted = rows => rows.slice().sort((a, b) => a.date.localeCompare(b.date));
const nextDay = date => new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
const millions = value => finite(value) ? value / 1e6 : null;
const divide = (a, b, scale = 1) => finite(a) && finite(b) && b !== 0 ? a / b * scale : null;
const sum = values => values.length && values.every(finite) ? values.reduce((a, b) => a + b, 0) : null;
const hash = data => crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
const readRows = (evidence, name) => evidence.responses?.[name]?.ok
  && Array.isArray(evidence.responses[name].rows) ? evidence.responses[name].rows : [];
const flowFields = ['operatingCashFlow', 'capitalExpenditure',
  'netCashProvidedByInvestingActivities', 'netCashProvidedByFinancingActivities'];

function prepareStatements(evidence) {
  const ticker = evidence.ticker, today = evidence.capturedAt?.slice(0, 10);
  if (!config.some(stock => stock.ticker === ticker) || evidence.providerSymbol !== ticker || !day(today)) {
    throw new TypeError('Invalid HKEX source identity or capture date');
  }
  const qualityWarnings = [];
  const warn = (code, message, extra = {}) => qualityWarnings.push({ code, message, ...extra });
  const statements = { calculationCurrency: 'HKD', annual: {}, quarterly: {}, qualityWarnings };
  for (const [period, prefix] of [['annual', 'annual_'], ['quarterly', '']]) {
    for (const type of ['income', 'balance', 'cashflow']) {
      const rows = readRows(evidence, `${prefix}${type}`);
      if (!rows.length && period === 'annual') throw new TypeError(`${ticker}: missing annual ${type}`);
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
    && original.every((row, i) => !i || key(row) === key(original[i - 1]) + 2);
  statements.reportingFrequency = semiannual ? 'semiannual' : 'quarterly';
  for (const period of ['annual', 'quarterly']) {
    const annual = period === 'annual';
    for (const type of ['income', 'cashflow']) {
      const rows = statements[period][type];
      rows.forEach((row, i) => {
        const previous = rows[i - 1];
        if (previous && (annual || key(row) === key(previous) + (semiannual ? 2 : 1))) {
          row.periodStartDate = nextDay(previous.date);
        } else {
          const end = new Date(row.date), months = annual ? 12 : semiannual ? 6 : 3;
          const calendarEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate() === end.getUTCDate();
          if (calendarEnd) row.periodStartDate = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1 - months, 1)).toISOString().slice(0, 10);
        }
        row.reportingFrequency = annual ? 'annual' : statements.reportingFrequency;
        row.periodLength = annual ? 12 : semiannual ? 6 : 3;
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
        if (!first || !day(first.periodStartDate)) continue;
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
    statements.quarterly.balance = sorted([
      ...statements.quarterly.balance.filter(row => row.period === 'Q2'),
      ...statements.annual.balance.map(row => ({ ...row, period: 'Q4', derivation: 'reportedAnnualClosingBalance' }))
    ]);
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
  const step = data.reportingFrequency === 'semiannual' ? 2 : 1, count = 4 / step;
  const income = sorted(data.quarterly.income), latest = income.at(-1);
  const recent = income.slice(-count);
  if (!latest || recent.length !== count || recent.some((row, i) => i && (key(row) !== key(recent[i - 1]) + step
      || (Date.parse(row.date) - Date.parse(recent[i - 1].date)) / 86400000 < step * 60
      || (Date.parse(row.date) - Date.parse(recent[i - 1].date)) / 86400000 > step * 120))) return [];
  const matches = recent.map(row => data.quarterly[type].find(other => other.date === row.date && key(other) === key(row)));
  return matches.every(Boolean) ? matches : [];
}
function flowValue(data, type, field) {
  const rows = ttmRows(data, type);
  if (data.reportingFrequency === 'semiannual' && rows.length === 2 && /^eps|^weightedAverageShs/i.test(field)) {
    return value(data.annual[type].find(row => row.date === rows.at(-1).date), field);
  }
  if (field === 'cashAtEndOfPeriod') return value(rows.at(-1), field);
  if (field === 'cashAtBeginningOfPeriod') return value(rows[0], field);
  if (/ratio$/i.test(field)) {
    const numerator = { grossProfitRatio: 'grossProfit', operatingIncomeRatio: 'operatingIncome',
      incomeBeforeTaxRatio: 'incomeBeforeTax', netIncomeRatio: 'netIncome', ebitdaratio: 'ebitda' }[field];
    return numerator ? divide(sum(rows.map(row => value(row, numerator))), sum(rows.map(row => value(row, 'revenue')))) : null;
  }
  const total = sum(rows.map(row => value(row, field)));
  return /^weightedAverageShs/.test(field) && total !== null ? total / rows.length : total;
}
function statementTable(data) {
  const dates = sorted(data.annual.income).slice(-5), quarters = sorted(data.quarterly.income).slice(-20);
  const latest = quarters.at(-1), raw = { annual_dates: [...dates.map(row => row.date.slice(0, 7)), latest?.date.slice(0, 7)],
    calculationCurrency: 'HKD', reportingFrequency: data.reportingFrequency,
    quarterly_raw: { dates: quarters.map(row => row.date.slice(0, 7)),
      periods: quarters.map(row => `${row.fiscalYear || row.calendarYear}${data.reportingFrequency === 'semiannual'
        ? `H${Number(row.period[1]) / 2}` : row.period}`), derivations: quarters.map(row => row.derivation || 'providerReported') } };
  const extras = {
    income: ['epsdiluted', 'grossProfitRatio', 'operatingIncomeRatio', 'incomeBeforeTaxRatio', 'netIncomeRatio', 'ebitdaratio'],
    balance: ['tradeAccountsReceivables', 'vendorNonTradeReceivables'],
    cashflow: ['netCashProvidedByOperatingActivities', 'netCashUsedForInvestingActivites',
      'netCashUsedProvidedByFinancingActivities', 'otherInvestingActivites', 'otherFinancingActivites', 'dividendsPaid']
  };
  for (const type of ['income', 'balance', 'cashflow']) {
    const fields = new Set([...extras[type], ...[...data.annual[type], ...data.quarterly[type]].flatMap(row =>
      Object.keys(row).filter(field => typeof row[field] === 'number' && !['periodLength', 'fiscalYear', 'calendarYear'].includes(field)))]);
    raw[type] = {}; raw.quarterly_raw[type] = {};
    const scale = (field, amount) => !finite(amount) ? null : /^weightedAverageShs|^eps|ratio$/i.test(field) ? amount : amount / 1e6;
    for (const field of fields) {
      raw[type][field] = [...dates.map(date => scale(field, value(data.annual[type].find(row => row.date === date.date), field))),
        scale(field, type === 'balance' ? value(data.quarterly.balance.find(row => row.date === latest?.date), field) : flowValue(data, type, field))];
      raw.quarterly_raw[type][field] = quarters.map(date => scale(field, value(data.quarterly[type].find(row => row.date === date.date), field)));
    }
  }
  for (const field of ['tradeAccountsReceivables', 'vendorNonTradeReceivables']) {
    raw[field] = raw.balance[field]; raw.quarterly_raw[field] = raw.quarterly_raw.balance[field];
  }
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

function compileStock(item, evidence, rates, moatReports = {}, previousStock = {}) {
  const profile = readRows(evidence, 'profile'), quotes = readRows(evidence, 'quote');
  if (profile.length !== 1 || profile[0].symbol !== item.ticker || profile[0].currency !== 'HKD'
      || quotes.length !== 1 || quotes[0].symbol !== item.ticker || !finite(quotes[0].price) || quotes[0].price <= 0
      || !finite(quotes[0].marketCap) || quotes[0].marketCap <= 0 || !finite(quotes[0].timestamp)) {
    throw new TypeError(`${item.ticker}: HKD quote identity cannot be verified`);
  }
  const p = profile[0], quote = quotes[0], raw = prepareStatements(evidence), data = convertStatements(raw, rates);
  const chart = priceHistory(evidence), latest = sorted(data.quarterly.income).at(-1), bs = sorted(data.quarterly.balance).at(-1);
  const quoteDate = new Date(quote.timestamp * 1000).toISOString().slice(0, 10);
  if (quoteDate > evidence.capturedAt.slice(0, 10)) throw new TypeError(`${item.ticker}: future quote`);
  const balance = field => value(bs, field), flow = (type, field) => flowValue(data, type, field);
  const table = statementTable(data), score = scores.calculate(raw);
  const scoreHash = hash({ annual: raw.annual, interim: raw.quarterly });
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
    reportingCurrency: latest?.sourceReportedCurrency, statements: raw, displayStatements: data, fScore: score, transcripts };
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
    reportedCurrency: latest?.sourceReportedCurrency, calculationCurrency: 'HKD',
    reportingFrequency: raw.reportingFrequency, statementFrequencies: raw.statementFrequencies,
    qualityWarnings: raw.qualityWarnings, price: quote.price, quoteDate, shares: quote.marketCap / quote.price / 1e6,
    shares_display: quote.marketCap / quote.price / 1e6, shares_outstanding: quote.marketCap / quote.price,
    shareBasis: item.shareClassReviewRequired ? 'unverifiedMixedShareClasses' : 'marketCapOverPrice',
    mcap: quote.marketCap / 1e6, debt: millions(balance('totalDebt')), cash: millions(balance('cashAndCashEquivalents')),
    short_term_investments: millions(balance('shortTermInvestments')), cash_and_short_term: millions(balance('cashAndShortTermInvestments')),
    beta: finite(p.beta) ? p.beta : null, beta_5y: null, rf: null, kd: null, tax: null,
    growth_10y: Array(10).fill(null), g1: null, g2: null, g: 2.25, wacc: null,
    fcf0: millions(flow('cashflow', 'freeCashFlow')), f_score: score.score, f_score_breakdown: scoreBreakdown(score, data), moat: priorMoat,
    fair_val: null, default_fair_val: null, premium_pct: null, is_undervalued: null,
    pe_forward: null, pb_forward: null, target_price: null, dcf_model_ev: null,
    statements_raw: table, real_history: {}, peers: readRows(evidence, 'peers').map(row => row.symbol).filter(symbol => typeof symbol === 'string'),
    fin_valuation: { is_financial: !!item.financial }, image: p.image || null, logo: p.image || null,
    website: p.website || null, ceo: p.ceo || null, full_time_employees: Number(p.fullTimeEmployees) > 0 ? Number(p.fullTimeEmployees) : null,
    description: p.description || null, description_en: p.description || null, description_zh: priorMoat?.description_zh || null,
    address: p.address || null, city: p.city || null, state: p.state || null, zip: p.zip || null, country: p.country || null,
    phone: p.phone || null, full_address: [p.address, p.city, p.state, p.zip, p.country].filter(Boolean).join(', '),
    year_high: quote.yearHigh ?? null, year_low: quote.yearLow ?? null, range_52w: p.range || null,
    all_time_high: null, all_time_low: null, inst_ownership_pct: null, insider_ownership_pct: null,
    top_holders: [], insider_trades: [], stock_splits: readRows(evidence, 'splits').filter(row => row.symbol === item.ticker),
    news: readRows(evidence, 'news').filter(row => row.symbol === item.ticker && row.publishedDate?.slice(0, 10) <= evidence.capturedAt.slice(0, 10)),
    historical_dcf_series: null, real_5y_prices: [],
    dataAvailability: { hkdRiskFreeRate: 'missingHkdRiskFreeRate', asReportedLeases: readRows(evidence, 'balance_as_reported').length ? null : 'sourceUnavailable',
      ownership: 'Provider coverage has not been verified for HKEX', historicalDcf: 'No point-in-time historical valuations are available' },
    ratingSources: {
      fScore: { asOfDate: score.date, period: score.period, basis: score.basis, evaluatedTests: score.evaluatedTests,
        passedTests: score.passedTests, reason: score.reason, evidenceHash: scoreHash, checkedAt: evidence.capturedAt,
        releaseDate: release?.date || null, relatedCallDate: scoreRelease?.date || null,
        scoringCurrency: raw.annual.income.at(-1)?.reportedCurrency || null,
        updatedAt: previousScore?.evidenceHash === scoreHash ? previousScore.updatedAt : evidence.capturedAt,
        applicability: item.financial ? 'Bank accounting limits comparability of the standard nonfinancial-company tests' : null },
      moat: { asOfDate: latest?.date || null, period: latest ? `${latest.fiscalYear || latest.calendarYear}${latest.period}` : null,
        evidenceHash: candidate?.evidenceHash || null, currentEvidenceHash: fingerprint, updatedAt: candidate?.updatedAt || null,
        reason: moat ? null : priorMoat ? 'staleEvidence' : 'analysisUnavailable',
        checkedAt: evidence.capturedAt, lastError: candidate?.lastError || null,
        statementDate: latest?.date || null, transcriptDate: transcripts[0]?.date || null,
        method: 'AI qualitative assessment anchored to dated financial statements and available transcript; not a reported accounting measure' }
    }
  };
  stock.net_debt = finite(stock.debt) && finite(stock.cash_and_short_term) ? stock.debt - stock.cash_and_short_term : null;
  stock.ev = finite(stock.net_debt) ? stock.mcap + stock.net_debt : null; stock.fmp_official_ev = stock.ev;
  stock.pe_trailing = divide(stock.price, flow('income', 'epsdiluted'));
  stock.pb_trailing = item.shareClassReviewRequired ? null : divide(stock.mcap, millions(balance('totalStockholdersEquity')));
  stock.ps_ratio = item.shareClassReviewRequired ? null : divide(stock.mcap, millions(flow('income', 'revenue')));
  stock.ev_to_ebitda = divide(stock.ev, millions(flow('income', 'ebitda')));
  stock.debt_to_ebitda = divide(stock.debt, millions(flow('income', 'ebitda')));
  stock.net_debt_to_ebitda = divide(stock.net_debt, millions(flow('income', 'ebitda')));
  stock.fcf_to_ev = divide(stock.fcf0, stock.ev, 100); stock.fcf_to_mcap = divide(stock.fcf0, stock.mcap, 100);
  stock.div_yield = divide(-flow('cashflow', 'dividendsPaid'), quote.marketCap, 100);
  if (flow('cashflow', 'dividendsPaid') === null) stock.div_yield = null;
  stock.liab_to_assets = divide(balance('totalLiabilities'), balance('totalAssets'), 100);
  stock.cash_to_assets = divide(balance('cashAndShortTermInvestments'), balance('totalAssets'), 100);
  stock.current_ratio = divide(balance('totalCurrentAssets'), balance('totalCurrentLiabilities'));
  const returns = ratios.calculateReturns(data).at(-1);
  stock.roe = returns?.ratios.roe.value ?? null; stock.roa = returns?.ratios.roa.value ?? null;
  const annual = sorted(data.annual.income).slice(-5);
  for (const [field, type, sourceField] of [
    ['revenue', 'income', 'revenue'], ['net_income', 'income', 'netIncome'], ['gross_profit', 'income', 'grossProfit'],
    ['operating_income', 'income', 'operatingIncome'], ['cfo', 'cashflow', 'operatingCashFlow'],
    ['capex', 'cashflow', 'capitalExpenditure'], ['fcf', 'cashflow', 'freeCashFlow']
  ]) stock.real_history[field] = [...annual.map(date => millions(value(data.annual[type].find(row => row.date === date.date), sourceField))),
    millions(flow(type, sourceField))];
  const sourceBalance = sorted(raw.quarterly.balance).at(-1);
  const fx = rateFor(rates, sourceBalance.reportedCurrency, null, sourceBalance.date, 'closing', 'HKD');
  stock.liquidation = { version: 1, ticker: item.ticker, currency: 'HKD', source: 'FMP stable balance-sheet-statement and quote',
    fetchedAt: evidence.capturedAt, balanceDate: sourceBalance.date, quoteDate, sourceCurrency: sourceBalance.reportedCurrency,
    fx, receivablesBasis: 'trade', shareBasis: stock.shareBasis,
    quote: { currency: 'HKD', date: quoteDate, price: quote.price, marketCap: quote.marketCap },
    amounts: { currentAssets: balance('totalCurrentAssets'), totalLiabilities: balance('totalLiabilities'),
      cashAndShortTermInvestments: balance('cashAndShortTermInvestments'), tradeReceivables: balance('accountsReceivables'),
      inventory: balance('inventory'), preferredStock: balance('preferredStock') } };
  liquidation.calculate(stock.liquidation, item.ticker).values.forEach((value, i) => { stock[`liq_val_${i + 1}`] = value; });
  let snapshot = prepareSnapshot(item.ticker, evidence, null, rates, null, { statementData: raw });
  if (item.requiresSegmentValuation) snapshot.reason = 'requiresSegmentValuation';
  if (raw.qualityWarnings.some(warning => warning.code === 'annualInterimReconciliation') && !snapshot.reason) snapshot.reason = 'statementReconciliationRequired';
  if (item.financial) {
    const reference = ratios.financialReference(data, { shares: stock.shares });
    if (item.shareClassReviewRequired) { reference.reason = 'shareBasisUnverified'; reference.tbvps = null; }
    const dividends = flow('cashflow', 'dividendsPaid'), buybacks = flow('cashflow', 'commonStockRepurchased');
    stock.fin_valuation = { is_financial: true, reference, tbvps: reference.tbvps, rote: reference.rote,
      bvps: stock.pb_trailing === null ? null : divide(stock.price, stock.pb_trailing), ke: null, g: 2.25,
      dps_total: finite(dividends) && finite(buybacks) ? (Math.abs(dividends) + Math.abs(buybacks)) / (stock.shares * 1e6) : null,
      excess_return_fair: null, ddm_fair: null, pb_tangible: divide(stock.price, reference.tbvps),
      unavailableReason: item.shareClassReviewRequired ? 'shareBasisUnverified' : 'missingHkdRiskFreeRate' };
  }
  stock.currencyConversion = { sourceCurrency: stock.reportedCurrency, target: 'HKD', source: rates.source,
    prepared: rates.prepared, income: latest?.currencyConversion, balance: bs?.currencyConversion,
    reason: [latest, bs].find(row => row?.currencyConversion?.reason)?.currencyConversion.reason || null };
  return { stock, statements: raw, chart, snapshot, moatInput, fingerprint };
}

function compile(directory, output, rates, reports = {}, previous = {}) {
  const market = {}, fcff = { version: 1, method: 'FCFF', stocks: {}, betaSources: {}, outcomes: {} }, evidenceInputs = [];
  const write = (file, data, prefix = '') => {
    const target = path.join(output, file); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, prefix + JSON.stringify(data) + (prefix ? ';' : '') + '\n');
  };
  for (const item of config) {
    const evidence = JSON.parse(fs.readFileSync(path.join(directory, `${item.ticker}.json`), 'utf8'));
    const result = compileStock(item, evidence, rates, reports, previous[item.ticker]);
    market[item.ticker] = result.stock;
    if (!item.financial) fcff.stocks[item.ticker] = result.snapshot;
    fcff.betaSources[item.ticker] = { value: result.stock.beta, source: 'FMP profile beta', lookback: null,
      frequency: null, benchmark: null, capturedAt: evidence.capturedAt };
    const status = result.snapshot.reason || 'operatingInputsAvailable';
    fcff.outcomes[status] = (fcff.outcomes[status] || 0) + 1;
    write(path.join('cache', 'financials', `${item.ticker}_statements_v2.json`), result.statements);
    write(path.join('cache', 'price_charts', `${item.ticker}.json`), result.chart);
    evidenceInputs.push({ ...result.moatInput, evidenceHash: result.fingerprint, existing: reports[item.ticker] || null });
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
  const inputs = compile(input, output, rates, reports, previous);
  if (process.env.MOAT_EVIDENCE_OUTPUT) fs.writeFileSync(process.env.MOAT_EVIDENCE_OUTPUT, JSON.stringify(inputs));
  console.log(`Built ${inputs.length} real HKEX listings in HKD; incomplete evidence remains explicitly unavailable.`);
}
module.exports = { prepareStatements, ttmRows, flowValue, statementTable, scoreBreakdown, priceHistory, compileStock, compile, hash };
