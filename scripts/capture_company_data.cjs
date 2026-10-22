const fs = require('node:fs');
const path = require('node:path');
const { newsRows } = require('../company_data.js');
const { baseSource, verifiedRevenueCorrection, fullAnnualPeriod } = require('../fmp_scenario.js');
const { sourceReview } = require('./fmp_source_review.cjs');
const { buildAnalystSources } = require('./analyst_sources.cjs');
const reconciliations = require('../cache/hkex_valuation_reconciliations.json').stocks;
const root = path.resolve(__dirname, '..');
const env = path.join(root, '.env.local');
if (fs.existsSync(env)) process.loadEnvFile(env);
const key = process.env.FMP_API_KEY;
const repack = process.argv[2] === '--repack';
if (!key && !repack) throw new Error('FMP_API_KEY is required; no embedded fallback credential is used');
const markets = { ...require('../full_market_dcf.json'), ...require('../hk_market_dcf.json') };
if (process.env.CAPTURE_MARKET_FILE) {
  const extra = JSON.parse(fs.readFileSync(process.env.CAPTURE_MARKET_FILE, 'utf8'));
  const hkex = new Set(require('../cache/hkex_universe.json').stocks.map(item => item.ticker));
  const us = fs.existsSync(path.join(root, 'cache', 'us_universe.json'))
    ? new Set(require('../cache/us_universe.json').stocks.map(item => item.ticker)) : new Set();
  for (const [ticker, stock] of Object.entries(extra)) {
    // build_full_market may omit stock.ticker; treat object key as identity when currency is USD.
    const identity = stock?.ticker == null ? ticker : stock.ticker;
    if (!stock || identity !== ticker) throw new Error(`Unregistered capture identity: ${ticker}`);
    const usCompany = fs.existsSync(path.join(root, 'cache', 'us_companies', `${ticker}.json`));
    if (hkex.has(ticker)) {
      markets[ticker] = stock;
    } else if (us.has(ticker) || usCompany) {
      // Accept catalogue members or already-ingested expansion snapshots (Actions / local resume).
      markets[ticker] = { ...stock, ticker, calculationCurrency: stock.calculationCurrency || 'USD' };
    } else {
      throw new Error(`Unregistered capture identity: ${ticker}`);
    }
  }
}
const symbols = repack ? [] : process.argv[2] ? process.argv[2].split(',') : Object.keys(markets);
if (symbols.some(symbol => !Object.hasOwn(markets, symbol))) throw new Error('Requested symbol is not in the configured universe');
const target = path.resolve(process.argv[3] || path.join(root, 'fmp_model_data.js'));
const existing = fs.existsSync(target) ? (() => {
  const vm = require('node:vm'), context = { window: {} };
  vm.runInNewContext(fs.readFileSync(target, 'utf8'), context);
  return context.window.FMP_MODEL_DATA?.stocks || {};
})() : {};
const stocks = { ...existing };
const fx = new Map();
function filedQuarter(date) {
  let year = date.getUTCFullYear(), quarter = Math.floor(date.getUTCMonth() / 3);
  if (quarter === 0) { year--; quarter = 4; }
  while (Date.UTC(year, quarter * 3, 0) + 46 * 86400000 > date.getTime()) {
    if (--quarter === 0) { year--; quarter = 4; }
  }
  return { year: String(year), quarter: String(quarter) };
}

async function request(endpoint, symbol, parameters = {}) {
  const provider = symbol.endsWith('.HK') ? symbol : symbol.replaceAll('.', '-');
  const url = new URL(`https://financialmodelingprep.com/stable/${endpoint}`);
  url.searchParams.set(endpoint === 'news/stock' ? 'symbols' : 'symbol', provider);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  url.searchParams.set('apikey', key);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (process.env.FMP_REQUEST_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.FMP_REQUEST_DELAY) * 1000));
    let response;
    try { response = await fetch(url, { signal: AbortSignal.timeout(25000), redirect: 'error' }); }
    catch (error) {
      if (attempt < 2) { await new Promise(resolve => setTimeout(resolve, 1500)); continue; }
      return { data: [], reason: error.name === 'TimeoutError' ? 'FMP_TIMEOUT' : 'FMP_NETWORK_ERROR' };
    }
    if ([401, 403].includes(response.status)) throw new Error('FMP_UNAUTHORIZED; refresh aborted without replacing the existing asset');
    if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 2500 * (attempt + 1))); continue;
    }
    if (!response.ok) return { data: [], reason: `FMP_HTTP_${response.status}` };
    let data;
    try { data = await response.json(); }
    catch { return { data: [], reason: 'FMP_INVALID_RESPONSE' }; }
    if (!Array.isArray(data)) return { data: [], reason: 'FMP_INVALID_RESPONSE' };
    if (data.some(row => !row || row.symbol !== provider)) return { data: [], reason: 'FMP_SECURITY_MISMATCH' };
    if (provider !== symbol) data = data.map(row => ({ ...row, symbol, providerSymbol: provider }));
    return { data, reason: data.length ? null : 'FMP_NO_COVERAGE' };
  }
}

async function currencyEvidence(symbol, stock, currency, models) {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'financials', `${symbol}_statements_v2.json`)));
  const rows = models.advanced.data;
  const matchesYear = row => row.revenue > 0 && fullAnnualPeriod(row)
    && rows.some(model => Number(model.year) === Number(row.fiscalYear || row.calendarYear));
  let actual = source.annual.income.slice().sort((a, b) => b.date.localeCompare(a.date)).find(matchesYear);
  let financialSource = 'storedAnnualFinancials';
  if (!actual) {
    const fresh = await request('income-statement', symbol, { period: 'annual', limit: '10' });
    actual = fresh.data.find(matchesYear);
    financialSource = 'FMP income-statement annual';
  }
  if (!actual) return { reason: 'FMP_MODEL_CURRENCY_UNVERIFIED' };
  const original = actual.reportedCurrency;
  let conversion = { price: 1, symbol: `${original}${currency}` };
  if (original !== currency) {
    const pair = `${original}${currency}`;
    if (!fx.has(pair)) fx.set(pair, request('quote', pair));
    conversion = (await fx.get(pair)).data[0];
    if (!conversion || !(conversion.price > 0)) return { reason: 'FMP_MODEL_FX_UNAVAILABLE' };
  }
  const model = rows.find(row => Number(row.year) === Number(actual.fiscalYear || actual.calendarYear));
  const correction = actual.revenueCorrection;
  if (correction && !verifiedRevenueCorrection(symbol, actual, source.revenueProvenance)) {
    return { reason: 'FMP_OFFICIAL_REVENUE_SOURCE_UNVERIFIED' };
  }
  const reportedRatio = model.revenue / actual.revenue;
  const originalRevenue = Math.abs(reportedRatio / conversion.price - 1) < 0.005 ? actual.revenue
    : actual.revenueCorrection?.providerRevenue ?? actual.revenue;
  const ratio = model.revenue / originalRevenue;
  return { reason: Math.abs(ratio / conversion.price - 1) < 0.005 ? null : 'FMP_MODEL_CURRENCY_UNVERIFIED',
    sourceCurrency: original, currency, sourceDate: actual.date, sourcePeriodLength: actual.periodLength,
    financialSource, originalRevenue,
    ...(actual.revenueCorrection ? { officialReportedRevenue: actual.revenue, revenueCorrection: actual.revenueCorrection } : {}),
    modelRevenue: model.revenue, impliedRate: ratio, fx: conversion,
    basis: original === currency ? 'matchingHistoricalRevenue' : 'matchingHistoricalRevenueAtFmpCurrentSpotNotHistoricalFx' };
}

async function capture(symbol) {
  const stock = markets[symbol], capturedAt = new Date().toISOString();
  const currency = stock.calculationCurrency || 'USD';
  const names = { dcf: 'discounted-cash-flow', levered: 'levered-discounted-cash-flow' };
  if (!stock.fin_valuation?.is_financial) Object.assign(names, {
    advanced: 'custom-discounted-cash-flow', customLevered: 'custom-levered-discounted-cash-flow'
  });
  const models = {};
  for (const [name, endpoint] of Object.entries(names)) models[name] = {
    ...(await request(endpoint, symbol)), endpoint
  };
  const profile = (await request('profile', symbol)).data[0];
  const currencyCheck = models.advanced?.data.length
    ? await currencyEvidence(symbol, stock, currency, models) : { reason: 'FMP_MODEL_CURRENCY_UNVERIFIED' };
  if (stock.fin_valuation?.is_financial && profile?.currency === currency
      && models.dcf.data[0]?.['Stock Price'] === stock.price) Object.assign(currencyCheck, {
    reason: null, currency, basis: 'providerReferenceInMatchingQuoteCurrencyNotABankValuation'
  });
  if (profile?.currency !== currency) currencyCheck.reason = 'FMP_MODEL_CURRENCY_UNVERIFIED';
  const news = await request('news/stock', symbol, { limit: '50', page: '0' });
  const filing = filedQuarter(new Date(capturedAt));
  const ownership = await request('institutional-ownership/symbol-positions-summary', symbol, filing);
  const holders = await request('institutional-ownership/extract-analytics/holder', symbol,
    { ...filing, page: '0', limit: '50' });
  const insiders = await request('insider-trading/search', symbol, { page: '0', limit: '50' });
  stocks[symbol] = { symbol, currency, capturedAt, models, currencyCheck,
    news: { ...news, data: newsRows(news.data, symbol).map(({ symbol, title, url, publisher, site, publishedDate, image }) =>
      ({ symbol, title, url, publisher, site, publishedDate, image })) },
    ownership, holders, insiders };
  if (models.advanced?.data.length) {
    stocks[symbol].analystResponse = await request('analyst-estimates', symbol, { period: 'annual', limit: '12' });
  }
  console.log(`${symbol}: ${Object.entries(models).map(([name, result]) => `${name}=${result.reason || 'available'}`).join(', ')}; currency=${currencyCheck.reason || 'verified'}`);
}

(async () => {
  const parallelism = Number(process.env.CAPTURE_PARALLELISM || 3);
  if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 3) throw new Error('Capture parallelism must be 1-3');
  for (let i = 0; i < symbols.length; i += parallelism) await Promise.all(symbols.slice(i, i + parallelism).map(capture));
  const companyDirectory = path.join(path.dirname(target), 'cache', 'company');
  fs.mkdirSync(companyDirectory, { recursive: true });
  const ordered = Object.fromEntries(Object.keys(markets).filter(symbol => stocks[symbol]).map(symbol => {
    if (!repack && !symbols.includes(symbol)) return [symbol, stocks[symbol]];
    const companyPath = path.join(companyDirectory, `${symbol}.json`);
    if (repack && !fs.existsSync(companyPath)) throw new Error(`Full company cache required for repack: ${symbol}`);
    const data = repack ? JSON.parse(fs.readFileSync(companyPath, 'utf8')) : stocks[symbol];
    if (data.symbol !== symbol) throw new Error('Company cache security mismatch');
    if (data.models.advanced?.data.length) {
      const financials = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'financials', `${symbol}_statements_v2.json`)));
      data.forecastBase = baseSource(data, financials);
      const review = sourceReview(data, financials, reconciliations?.[symbol]);
      if (review) data.sourceReview = review;
      else delete data.sourceReview;
      if (data.analystResponse) {
        Object.assign(data, buildAnalystSources(data, financials, data.analystResponse, data.capturedAt));
        delete data.analystResponse;
      }
    }
    if (data.holders || data.news) fs.writeFileSync(path.join(companyDirectory, `${symbol}.json`), JSON.stringify(data) + '\n');
    const { news, ownership, holders, insiders, analystEstimates, forecastActuals, ...summary } = data;
    summary.models = Object.fromEntries(Object.entries(data.models).map(([name, model]) => [name, { ...model,
      data: model.data.length ? [model.data.slice().sort((a, b) => Number(b.year || 0) - Number(a.year || 0))[0]] : []
    }]));
    return [symbol, summary];
  }));
  const temporary = `${target}.tmp`;
  try {
    fs.writeFileSync(temporary, `window.FMP_MODEL_DATA = ${JSON.stringify({ version: 1, stocks: ordered })};\n`);
    fs.renameSync(temporary, target);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  console.log(`Captured ${symbols.length} securities without publishing, changing valuations or exposing API credentials.`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
