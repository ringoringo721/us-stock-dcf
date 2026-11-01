#!/usr/bin/env node
'use strict';
/**
 * Audit US DCF five-year history + optional TTM history row after PR #80/#81.
 * Simulates production: statements via UsdCurrency.convertStatements, company
 * forecastBase/currencyCheck from cache or derived from filings.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const Scenario = require(path.join(root, 'fmp_scenario.js'));
const UsdCurrency = require(path.join(root, 'usd_currency.js'));

const fullAnnualPeriod = Scenario.fullAnnualPeriod;
const rates = JSON.parse(fs.readFileSync(path.join(root, 'cache/fx/usd_rates.json'), 'utf8'));

function loadWindow(file) {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  return context.window;
}

const market = JSON.parse(fs.readFileSync(path.join(root, 'full_market_dcf.json'), 'utf8'));
const expansion = loadWindow('us_expansion_data.js').US_EXPANSION.stocks;
const tickers = [...new Set([...Object.keys(market), ...Object.keys(expansion)])]
  .filter(t => !t.endsWith('.HK'))
  .sort();

function annualIncome(statements) {
  return (statements?.annual?.income || []).filter(fullAnnualPeriod);
}

function deriveCompany(ticker, statements) {
  const companyPath = path.join(root, 'cache/company', `${ticker}.json`);
  if (fs.existsSync(companyPath)) {
    const data = JSON.parse(fs.readFileSync(companyPath, 'utf8'));
    if (!Number.isInteger(data.forecastBase?.year) || data.forecastBase?.reason) {
      const recovered = Scenario.resolveForecastBase(data);
      if (Number.isInteger(recovered?.year) && !recovered.reason) data.forecastBase = recovered;
    }
    return { data, source: 'company-cache' };
  }
  const stock = market[ticker] || expansion[ticker] || {};
  const rows = annualIncome(statements)
    .filter(row => row.revenue > 0)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || Number(a.fiscalYear || a.calendarYear) - Number(b.fiscalYear || b.calendarYear));
  if (!rows.length) {
    return {
      data: {
        symbol: ticker, currency: 'USD',
        forecastBase: { reason: 'HISTORY_BASE_UNAVAILABLE' },
        currencyCheck: { sourceCurrency: stock.reportedCurrency || null }
      },
      source: 'no-annual-income'
    };
  }
  // Prefer the stock's reportedCurrency cohort when present (matches hydrate intent).
  const preferred = stock.reportedCurrency
    ? rows.filter(row => row.reportedCurrency === stock.reportedCurrency)
    : rows;
  const cohort = preferred.length ? preferred : rows;
  const latest = cohort.at(-1);
  const sourceCurrency = latest.reportedCurrency || stock.reportedCurrency || null;
  return {
    data: {
      symbol: ticker,
      currency: stock.calculationCurrency || 'USD',
      forecastBase: {
        year: Number(latest.fiscalYear || latest.calendarYear),
        date: latest.date,
        source: 'derived-from-statements',
        reason: null
      },
      currencyCheck: {
        reason: null,
        sourceCurrency,
        currency: stock.calculationCurrency || 'USD',
        sourceDate: latest.date,
        financialSource: 'audit-derived'
      }
    },
    source: 'derived'
  };
}

function convert(statements) {
  try {
    return {
      statements: UsdCurrency.convertStatements(
        { ...statements, calculationCurrency: 'USD' }, rates, 'USD'
      ),
      error: null
    };
  } catch (error) {
    return { statements: null, error: error.message };
  }
}

function diagnoseIncomplete(statements, data) {
  const base = data?.forecastBase;
  if (!base || !Number.isInteger(base.year)) return { reason: 'HISTORY_BASE_UNAVAILABLE', years: [] };
  if (!statements?.annual?.income) return { reason: 'HISTORY_STATEMENTS_UNAVAILABLE', years: [] };
  const currency = data.currencyCheck?.sourceCurrency;
  const detail = [];
  for (let offset = 4; offset >= 0; offset--) {
    const year = base.year - offset;
    const incomeMatches = statements.annual.income.filter(row =>
      Number(row.fiscalYear || row.calendarYear) === year
      && fullAnnualPeriod(row)
      && (!currency
        || row.reportedCurrency === currency
        || row.sourceReportedCurrency === currency));
    const currencies = [...new Set(
      statements.annual.income
        .filter(row => Number(row.fiscalYear || row.calendarYear) === year && fullAnnualPeriod(row))
        .map(row => `${row.reportedCurrency || '∅'}/${row.sourceReportedCurrency || '∅'}`)
    )];
    detail.push({
      year,
      matchCount: incomeMatches.length,
      revenueOk: incomeMatches[0]?.revenue > 0,
      revenue: incomeMatches[0]?.revenue ?? null,
      currenciesPresent: currencies
    });
  }
  return { reason: 'HISTORY_FIVE_YEAR_INCOMPLETE', years: detail };
}

function quartersAfterFy(statements, latestFyDate, sourceCurrency) {
  const income = (statements?.quarterly?.income || [])
    .filter(row => /^Q[1-4]$/.test(row?.period) && row.date > latestFyDate);
  // Production TTM filter (pre-fix): reportedCurrency === sourceCurrency only.
  const matchingStrict = income.filter(row => !sourceCurrency || row.reportedCurrency === sourceCurrency);
  // Post #81-style: accept sourceReportedCurrency too.
  const matchingLoose = income.filter(row => !sourceCurrency
    || row.reportedCurrency === sourceCurrency
    || row.sourceReportedCurrency === sourceCurrency);
  return {
    anyAfterFy: income.length > 0,
    strictMatchCount: matchingStrict.length,
    looseMatchCount: matchingLoose.length,
    latestQuarterDate: income.slice().sort((a, b) => a.date.localeCompare(b.date)).at(-1)?.date || null,
    sampleCurrencies: [...new Set(income.map(row =>
      `${row.reportedCurrency || '∅'}/${row.sourceReportedCurrency || '∅'}`))].slice(0, 5)
  };
}

const results = {
  scanned: 0,
  missingStatements: [],
  convertErrors: [],
  historyIncompleteRaw: [],
  historyIncompleteNormalized: [],
  historyOtherRaw: [],
  historyOtherNormalized: [],
  historyOkNormalized: 0,
  ttmIncluded: [],
  ttmOmittedCorrectly: [], // no newer quarters, or intentional omit reasons
  ttmMissingBug: [], // quarters after FY exist but TTM not shown (and should)
  ttmReasons: {},
  foreignAdr: {
    total: 0,
    incompleteNormalized: [],
    incompleteRaw: [],
    ttmMissingBug: []
  }
};

for (const ticker of tickers) {
  const stmtPath = path.join(root, 'cache/financials', `${ticker}_statements_v2.json`);
  if (!fs.existsSync(stmtPath)) {
    results.missingStatements.push(ticker);
    continue;
  }
  results.scanned += 1;
  const raw = JSON.parse(fs.readFileSync(stmtPath, 'utf8'));
  const { data, source } = deriveCompany(ticker, raw);
  const stock = market[ticker] || expansion[ticker] || {};
  const filingCurrencies = [...new Set(annualIncome(raw).map(r => r.reportedCurrency).filter(Boolean))];
  const isForeign = filingCurrencies.some(c => c !== 'USD')
    || (stock.reportedCurrency && stock.reportedCurrency !== 'USD');
  if (isForeign) results.foreignAdr.total += 1;

  const rawHistory = Scenario.fiveYearHistory(raw, data, 'advanced');
  if (rawHistory.reason === 'HISTORY_FIVE_YEAR_INCOMPLETE') {
    const diag = diagnoseIncomplete(raw, data);
    results.historyIncompleteRaw.push({ ticker, source, isForeign, diag, sourceCurrency: data.currencyCheck?.sourceCurrency });
    if (isForeign) results.foreignAdr.incompleteRaw.push(ticker);
  } else if (rawHistory.reason) {
    results.historyOtherRaw.push({ ticker, reason: rawHistory.reason, source, isForeign });
  }

  const converted = convert(raw);
  if (converted.error) {
    results.convertErrors.push({ ticker, error: converted.error, isForeign });
    continue;
  }
  const normHistory = Scenario.fiveYearHistory(converted.statements, data, 'advanced');
  if (normHistory.reason === 'HISTORY_FIVE_YEAR_INCOMPLETE') {
    const diag = diagnoseIncomplete(converted.statements, data);
    results.historyIncompleteNormalized.push({
      ticker, source, isForeign, diag,
      sourceCurrency: data.currencyCheck?.sourceCurrency,
      baseYear: data.forecastBase?.year
    });
    if (isForeign) results.foreignAdr.incompleteNormalized.push(ticker);
    continue;
  }
  if (normHistory.reason) {
    results.historyOtherNormalized.push({ ticker, reason: normHistory.reason, source, isForeign });
    continue;
  }

  results.historyOkNormalized += 1;
  const latestFy = normHistory.years.at(-1);
  const ttm = normHistory.ttm;
  const qInfo = quartersAfterFy(converted.statements, latestFy.date, data.currencyCheck?.sourceCurrency);
  const reason = ttm?.reason || null;
  results.ttmReasons[reason || 'INCLUDED'] = (results.ttmReasons[reason || 'INCLUDED'] || 0) + 1;

  if (ttm?.included) {
    results.ttmIncluded.push(ticker);
    continue;
  }

  // Intentional / expected omits when there is no newer quarter window.
  const intentional = new Set([
    'TTM_NOT_NEWER_THAN_LATEST_FY',
    'TTM_EQUALS_LATEST_FY',
    'TTM_US_ONLY',
    'TTM_LATEST_FY_UNAVAILABLE'
  ]);
  // Quarters exist after FY but gate failed — product bug candidates.
  // Especially: TTM_QUARTERS_UNAVAILABLE / NON_CONSECUTIVE / CASHFLOW when loose match finds post-FY qs.
  const shouldHaveTtm = qInfo.anyAfterFy && qInfo.looseMatchCount > 0;
  if (shouldHaveTtm && !intentional.has(reason)) {
    const entry = {
      ticker, reason, isForeign, sourceCurrency: data.currencyCheck?.sourceCurrency,
      latestFyDate: latestFy.date, ...qInfo
    };
    results.ttmMissingBug.push(entry);
    if (isForeign) results.foreignAdr.ttmMissingBug.push(ticker);
  } else if (shouldHaveTtm && reason === 'TTM_NOT_NEWER_THAN_LATEST_FY') {
    // date skew / ordering quirk despite anyAfterFy — still flag
    results.ttmMissingBug.push({
      ticker, reason, isForeign, note: 'quartersAfterFy but gate says not newer',
      latestFyDate: latestFy.date, ...qInfo
    });
  } else {
    results.ttmOmittedCorrectly.push({ ticker, reason, latestFyDate: latestFy.date, anyAfterFy: qInfo.anyAfterFy });
  }
}

function summarizeDiag(list) {
  const patterns = {};
  for (const item of list) {
    const years = item.diag?.years || [];
    const bad = years.filter(y => y.matchCount !== 1 || !y.revenueOk);
    const key = bad.map(y => `${y.year}:n=${y.matchCount},rev=${y.revenueOk}`).join('|') || 'unknown';
    patterns[key] = (patterns[key] || 0) + 1;
  }
  return Object.entries(patterns).sort((a, b) => b[1] - a[1]).slice(0, 15);
}

const summary = {
  universe: tickers.length,
  scanned: results.scanned,
  missingStatements: results.missingStatements.length,
  convertErrors: results.convertErrors.length,
  history: {
    incompleteRaw: results.historyIncompleteRaw.length,
    incompleteNormalized: results.historyIncompleteNormalized.length,
    otherRaw: results.historyOtherRaw.length,
    otherNormalized: results.historyOtherNormalized.length,
    okNormalized: results.historyOkNormalized,
    incompleteNormalizedTickers: results.historyIncompleteNormalized.map(x => x.ticker),
    incompleteRawTickers: results.historyIncompleteRaw.map(x => x.ticker),
    otherNormalizedByReason: results.historyOtherNormalized.reduce((acc, x) => {
      acc[x.reason] = (acc[x.reason] || 0) + 1;
      return acc;
    }, {}),
    incompleteNormalizedDiagTop: summarizeDiag(results.historyIncompleteNormalized),
    incompleteRawDiagTop: summarizeDiag(results.historyIncompleteRaw)
  },
  ttm: {
    included: results.ttmIncluded.length,
    omittedCorrectly: results.ttmOmittedCorrectly.length,
    missingBug: results.ttmMissingBug.length,
    reasons: results.ttmReasons,
    missingBugTickers: results.ttmMissingBug.map(x => x.ticker),
    missingBugByReason: results.ttmMissingBug.reduce((acc, x) => {
      acc[x.reason] = (acc[x.reason] || 0) + 1;
      return acc;
    }, {}),
    missingBugSamples: results.ttmMissingBug.slice(0, 40)
  },
  foreignAdr: {
    total: results.foreignAdr.total,
    incompleteNormalized: results.foreignAdr.incompleteNormalized,
    incompleteRaw: results.foreignAdr.incompleteRaw,
    ttmMissingBug: results.foreignAdr.ttmMissingBug
  },
  convertErrorSamples: results.convertErrors.slice(0, 20)
};

const outDir = path.join(root, 'scripts/data');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'history_five_year_ttm_audit.json');
fs.writeFileSync(outPath, JSON.stringify({ summary, details: {
  historyIncompleteNormalized: results.historyIncompleteNormalized,
  historyIncompleteRaw: results.historyIncompleteRaw,
  historyOtherNormalized: results.historyOtherNormalized,
  ttmMissingBug: results.ttmMissingBug,
  ttmOmittedCorrectly: results.ttmOmittedCorrectly,
  convertErrors: results.convertErrors,
  missingStatements: results.missingStatements
} }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.error(`Wrote ${outPath}`);
