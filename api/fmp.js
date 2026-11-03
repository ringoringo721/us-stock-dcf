const fs = require('node:fs');
const path = require('node:path');
const technicals = require('../technical_indicators.js');
const SmartMoney = require('../smart_money.js');
// Seed-holder CIKs (committed invert) may use institutional-extract; arbitrary CIKs stay 403.
try {
  const holderFundsPath = path.join(__dirname, '..', 'cache', 'smart-money', 'funds', 'holder-funds.json');
  if (fs.existsSync(holderFundsPath)) {
    const body = JSON.parse(fs.readFileSync(holderFundsPath, 'utf8'));
    SmartMoney.registerExtractAllowlist(body.ciks || Object.keys(body.funds || {}));
  }
} catch { /* optional seed */ }
const endpoints = {
  technical: 'technical-indicators',
  news: 'news/stock',
  dcf: 'discounted-cash-flow',
  'levered-dcf': 'levered-discounted-cash-flow',
  'custom-dcf': 'custom-discounted-cash-flow',
  'custom-levered-dcf': 'custom-levered-discounted-cash-flow',
  'historical-price': 'historical-price-eod/full',
  'analyst-estimates': 'analyst-estimates',
  dividends: 'dividends',
  'revenue-product-segmentation': 'revenue-product-segmentation',
  'revenue-geographic-segmentation': 'revenue-geographic-segmentation',
  'sec-filings': 'sec-filings-search/symbol',
  // Metadata only — full earning-call-transcript bodies are NOT proxied (paid scrape risk).
  'transcript-dates': 'earning-call-transcript-dates',
  // 13F / institutional — Smart Money (WhaleCreep-style) rate-limited proxy.
  'institutional-holders': 'institutional-ownership/extract-analytics/holder',
  // Fund book extract — capped + rate-limited (used by #fund/SLUG manager page).
  'institutional-extract': 'institutional-ownership/extract',
};

/** In-memory per-IP budgets for document + 13F metadata actions (best-effort on serverless). */
const documentRateBuckets = new Map();
const DOCUMENT_RATE_WINDOW_MS = 60_000;
const DOCUMENT_RATE_MAX = 40;
const INSTITUTIONAL_RATE_MAX = 30;
/** Tight cap — extract is allowlisted (curated ∪ seed-holder CIKs); still budget shared FMP quota. */
const INSTITUTIONAL_EXTRACT_RATE_MAX = 4;
const RATE_LIMITED_ACTIONS = new Set([
  'sec-filings', 'transcript-dates', 'institutional-holders', 'institutional-extract',
]);

function clientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || req.headers?.['x-real-ip'] || 'unknown';
}

function documentRateLimited(req, action) {
  if (!RATE_LIMITED_ACTIONS.has(action)) return false;
  const key = `${clientIp(req)}:${action}`;
  const now = Date.now();
  let bucket = documentRateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + DOCUMENT_RATE_WINDOW_MS };
    documentRateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (documentRateBuckets.size > 5000) {
    for (const [id, entry] of documentRateBuckets) {
      if (now >= entry.resetAt) documentRateBuckets.delete(id);
    }
  }
  const max = action === 'institutional-extract' ? INSTITUTIONAL_EXTRACT_RATE_MAX
    : action === 'institutional-holders' ? INSTITUTIONAL_RATE_MAX
      : DOCUMENT_RATE_MAX;
  return bucket.count > max;
}
const customParameters = {
  revenueGrowthPct: [-0.9, 2], ebitdaPct: [-1, 1], ebitPct: [-1, 1],
  depreciationAndAmortizationPct: [0, 1], cashAndShortTermInvestmentsPct: [0, 5],
  receivablesPct: [0, 5], inventoriesPct: [0, 5], payablePct: [0, 5],
  capitalExpenditurePct: [-1, 0], operatingCashFlowPct: [-2, 2],
  costOfDebt: [0, 100], costOfEquity: [0.01, 100], riskFreeRate: [0, 100],
  marketRiskPremium: [0, 100], beta: [-5, 10], longTermGrowthRate: [-10, 10],
};
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

function createHandler({ fetch: fetcher = globalThis.fetch, apiKey = () => process.env.FMP_API_KEY } = {}) {
  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)); };
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(405, { error: 'METHOD_NOT_ALLOWED' });
    }
    const query = new URL(req.url, 'http://localhost').searchParams;
    const action = query.get('action'), symbol = query.get('symbol');
    const custom = ['custom-dcf', 'custom-levered-dcf'].includes(action);
    const technical = action === 'technical';
    const historical = action === 'historical-price';
    const estimates = action === 'analyst-estimates';
    const dividends = action === 'dividends';
    const revenueSegments = action === 'revenue-product-segmentation'
      || action === 'revenue-geographic-segmentation';
    const secFilings = action === 'sec-filings';
    const transcriptDates = action === 'transcript-dates';
    const institutionalHolders = action === 'institutional-holders';
    const institutionalExtract = action === 'institutional-extract';
    // Reject legacy full-transcript action explicitly (was a paid-content scrape surface).
    if (action === 'earning-call-transcript') {
      return send(403, {
        error: 'TRANSCRIPT_BODY_NOT_PROXIED',
        hint: 'Full FMP earning-call-transcript text is not exposed. Open SEC EDGAR 8-K instead.',
      });
    }
    const cikParam = SmartMoney.padCik(query.get('cik'));
    if (institutionalExtract && !/^\d{10}$/.test(cikParam || '')) {
      return send(400, { error: 'INVALID_INSTITUTIONAL_CIK' });
    }
    // Public extract is curated ∪ committed stock-seed holder CIKs only — no open scrape.
    if (institutionalExtract && !SmartMoney.allowedCik(cikParam)) {
      return send(403, {
        error: 'INSTITUTIONAL_CIK_NOT_ALLOWLISTED',
        hint: 'institutional-extract accepts curated or seed-holder allowlisted CIKs only.',
      });
    }
    // institutional-extract is CIK-primary (fund book); symbol is not required.
    const symbolOk = institutionalExtract
      || /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(symbol || '');
    if (!Object.hasOwn(endpoints, action) || !symbolOk
        || [...new Set(query.keys())].some(key => query.getAll(key).length !== 1)
        || [...query.keys()].some(key => !['action', 'symbol', 'page'].includes(key)
          && !(technical && ['indicator', 'periodLength', 'from', 'to'].includes(key))
          && !(historical && ['from', 'to'].includes(key))
          && !(estimates && ['period', 'limit'].includes(key))
          && !(dividends && ['limit', 'from', 'to'].includes(key))
          && !(revenueSegments && ['period', 'structure'].includes(key))
          && !(secFilings && ['from', 'to', 'limit', 'page'].includes(key))
          && !(transcriptDates && [].includes(key))
          && !(institutionalHolders && ['year', 'quarter', 'limit', 'page'].includes(key))
          && !(institutionalExtract && ['cik', 'year', 'quarter'].includes(key))
          && !(custom && Object.hasOwn(customParameters, key)))) {
      return send(400, { error: 'INVALID_REQUEST' });
    }
    if (documentRateLimited(req, action)) {
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Retry-After', '60');
      return send(429, { error: institutionalHolders || institutionalExtract
        ? 'INSTITUTIONAL_RATE_LIMITED' : 'DOCUMENT_RATE_LIMITED' });
    }
    const page = query.get('page') || '0';
    if (!/^\d{1,4}$/.test(page) || Number(page) > 1000
        || (action !== 'news' && action !== 'sec-filings' && action !== 'institutional-holders'
          && query.has('page'))) {
      return send(400, { error: 'INVALID_PAGE' });
    }
    const indicator = query.get('indicator'), period = query.get('periodLength');
    const from = query.get('from'), to = query.get('to');
    const estimatePeriod = query.get('period'), estimateLimit = query.get('limit');
    const segmentPeriod = query.get('period');
    const segmentStructure = query.get('structure');
    const filingsLimit = query.get('limit');
    const instYear = query.get('year');
    const instQuarter = query.get('quarter');
    const instLimit = query.get('limit');
    if (technical && (!/^\d{1,3}$/.test(period || '')
        || !technicals.validRequest(indicator, Number(period), from, to))) {
      return send(400, { error: 'INVALID_TECHNICAL_REQUEST' });
    }
    if (historical && (!validDate(from) || !validDate(to) || from > to
        || Date.parse(to) - Date.parse(from) > 8000 * 86400000)) {
      return send(400, { error: 'INVALID_HISTORICAL_PRICE_REQUEST' });
    }
    if (estimates && (estimatePeriod !== 'annual' || !/^\d{1,2}$/.test(estimateLimit || '')
        || Number(estimateLimit) < 1 || Number(estimateLimit) > 40)) {
      return send(400, { error: 'INVALID_ANALYST_ESTIMATES_REQUEST' });
    }
    if (dividends && query.has('limit') && (!/^\d{1,3}$/.test(estimateLimit || '')
        || Number(estimateLimit) < 1 || Number(estimateLimit) > 500)) {
      return send(400, { error: 'INVALID_DIVIDENDS_REQUEST' });
    }
    if (dividends && ((from && !validDate(from)) || (to && !validDate(to))
        || (from && to && from > to))) {
      return send(400, { error: 'INVALID_DIVIDENDS_REQUEST' });
    }
    // FMP stable segmentation requires period=annual|quarter and structure=flat.
    if (revenueSegments && ((segmentPeriod && segmentPeriod !== 'annual' && segmentPeriod !== 'quarter')
        || (segmentStructure && segmentStructure !== 'flat'))) {
      return send(400, { error: 'INVALID_REVENUE_SEGMENT_REQUEST' });
    }
    if (secFilings && ((from && !validDate(from)) || (to && !validDate(to))
        || (from && to && from > to)
        || (filingsLimit && (!/^\d{1,3}$/.test(filingsLimit) || Number(filingsLimit) < 1
          || Number(filingsLimit) > 100)))) {
      return send(400, { error: 'INVALID_SEC_FILINGS_REQUEST' });
    }
    if ((institutionalHolders || institutionalExtract)
        && (!/^\d{4}$/.test(instYear || '') || Number(instYear) < 1999 || Number(instYear) > 2100
          || !/^[1-4]$/.test(instQuarter || ''))) {
      return send(400, { error: 'INVALID_INSTITUTIONAL_REQUEST' });
    }
    if (institutionalHolders && instLimit && (!/^\d{1,3}$/.test(instLimit)
        || Number(instLimit) < 1 || Number(instLimit) > 100)) {
      return send(400, { error: 'INVALID_INSTITUTIONAL_REQUEST' });
    }
    if (institutionalHolders && Number(page) > 20) {
      return send(400, { error: 'INVALID_PAGE' });
    }
    const key = apiKey();
    if (!key) return send(503, { error: 'FMP_NOT_CONFIGURED' });
    const endpoint = technical ? `${endpoints[action]}/${indicator}` : endpoints[action];
    const url = new URL(`https://financialmodelingprep.com/stable/${endpoint}`);
    const provider = symbol
      ? (symbol.endsWith('.HK') ? symbol : symbol.replaceAll('.', '-'))
      : null;
    if (institutionalExtract) {
      url.searchParams.set('cik', cikParam);
    } else {
      url.searchParams.set(action === 'news' ? 'symbols' : 'symbol', provider);
    }
    if (technical) {
      for (const [name, value] of Object.entries({ periodLength: period, timeframe: '1day', from, to })) {
        url.searchParams.set(name, value);
      }
    }
    if (historical) {
      url.searchParams.set('from', from);
      url.searchParams.set('to', to);
    }
    if (estimates) {
      url.searchParams.set('period', estimatePeriod);
      url.searchParams.set('limit', estimateLimit);
    }
    if (dividends) {
      // Prefer a long lookback so 30y tables get real quarterly payments when FMP has them.
      if (estimateLimit) url.searchParams.set('limit', estimateLimit);
      else url.searchParams.set('limit', '500');
      if (from) url.searchParams.set('from', from);
      else {
        const start = new Date();
        start.setUTCFullYear(start.getUTCFullYear() - 40);
        url.searchParams.set('from', start.toISOString().slice(0, 10));
      }
      if (to) url.searchParams.set('to', to);
    }
    if (revenueSegments) {
      url.searchParams.set('period', segmentPeriod || 'annual');
      url.searchParams.set('structure', 'flat');
    }
    if (secFilings) {
      const end = to || new Date().toISOString().slice(0, 10);
      const start = from || (() => {
        const d = new Date(`${end}T00:00:00Z`);
        d.setUTCFullYear(d.getUTCFullYear() - 5);
        return d.toISOString().slice(0, 10);
      })();
      url.searchParams.set('from', start);
      url.searchParams.set('to', end);
      url.searchParams.set('page', page);
      url.searchParams.set('limit', filingsLimit || '40');
    }
    if (institutionalHolders) {
      url.searchParams.set('year', instYear);
      url.searchParams.set('quarter', instQuarter);
      url.searchParams.set('page', page);
      url.searchParams.set('limit', instLimit || '100');
    }
    if (institutionalExtract) {
      url.searchParams.set('year', instYear);
      url.searchParams.set('quarter', instQuarter);
    }
    for (const [name, [minimum, maximum]] of Object.entries(customParameters)) {
      if (!query.has(name)) continue;
      const raw = query.get(name), value = raw.trim() ? Number(raw) : NaN;
      if (!Number.isFinite(value) || value < minimum || value > maximum) return send(400, { error: 'INVALID_MODEL_INPUT' });
      if (action === 'custom-levered-dcf' && ['ebitdaPct', 'ebitPct', 'depreciationAndAmortizationPct',
        'cashAndShortTermInvestmentsPct', 'receivablesPct', 'inventoriesPct', 'payablePct'].includes(name)) {
        return send(400, { error: 'UNSUPPORTED_MODEL_INPUT' });
      }
      if (action === 'custom-dcf' && name === 'operatingCashFlowPct') return send(400, { error: 'UNSUPPORTED_MODEL_INPUT' });
      url.searchParams.set(name, String(value));
    }
    if (action === 'news') {
      url.searchParams.set('page', page);
      url.searchParams.set('limit', '50');
    }
    url.searchParams.set('apikey', key);
    let response;
    try {
      response = await fetcher(url, { signal: AbortSignal.timeout(historical ? 45000 : 20000), redirect: 'error' });
    } catch (error) {
      const timeout = ['TimeoutError', 'AbortError'].includes(error.name);
      console.error('FMP request failed', { action, symbol, reason: timeout ? 'timeout' : 'network' });
      return send(timeout ? 504 : 502, { error: timeout ? 'FMP_TIMEOUT' : 'FMP_NETWORK_ERROR' });
    }
    if (!response.ok) {
      const error = response.status === 401 || response.status === 403 ? 'FMP_UNAUTHORIZED'
        : response.status === 402 ? 'FMP_PLAN_REQUIRED' : response.status === 429 ? 'FMP_RATE_LIMITED' : 'FMP_UPSTREAM_ERROR';
      console.error('FMP upstream rejected request', { action, symbol, status: response.status });
      return send(502, { error, upstreamStatus: response.status });
    }
    let payload;
    try { payload = await response.json(); }
    catch {
      console.error('FMP returned invalid JSON', { action, symbol });
      return send(502, { error: 'FMP_INVALID_RESPONSE' });
    }
    // Stable dividends occasionally wrap rows; segmentation must remain a list.
    let rows = Array.isArray(payload) ? payload
      : Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.historical) ? payload.historical
      : null;
    if (!Array.isArray(rows)) {
      console.error('FMP returned a non-array response', { action, symbol,
        message: payload && typeof payload === 'object' ? payload['Error Message'] || payload.error : null });
      return send(502, { error: 'FMP_INVALID_RESPONSE' });
    }
    let data;
    if (technical) {
      try { data = technicals.normalize(rows, indicator, provider, from, to); }
      catch (error) {
        console.error('FMP technical response failed validation', { symbol, indicator, reason: error.message });
        return send(502, { error: 'FMP_INVALID_TECHNICAL_RESPONSE' });
      }
    } else if (historical) {
      data = rows.filter(row => row && (row.symbol === provider || row.symbol === symbol));
      if (data.length !== rows.length) {
        console.error('FMP returned another security', { action, symbol });
        return send(502, { error: 'FMP_SECURITY_MISMATCH' });
      }
      data = data.map(row => ({
        symbol, providerSymbol: provider, date: String(row.date).slice(0, 10),
        close: row.close, volume: row.volume == null ? null : row.volume
      }));
    } else if (institutionalExtract) {
      // Cap fund books — WhaleCreep-style manager page needs the portfolio, not infinite scrape.
      data = rows.slice(0, SmartMoney.FUND_EXTRACT_MAX).map(row => ({
        ...row,
        cik: cikParam,
        year: Number(instYear),
        quarter: Number(instQuarter),
      }));
    } else {
      // Dividends / segment / filings / transcript-dates / 13F analytics sometimes omit symbol.
      const softSymbol = revenueSegments || dividends || secFilings || transcriptDates
        || institutionalHolders;
      data = rows.filter(row => row && (row.symbol == null || row.symbol === ''
        || row.symbol === provider || row.symbol === symbol));
      if (!softSymbol && data.length !== rows.length) {
        console.error('FMP returned another security', { action, symbol });
        return send(502, { error: 'FMP_SECURITY_MISMATCH' });
      }
      if (softSymbol && rows.some(row => row?.symbol
          && row.symbol !== provider && row.symbol !== symbol)) {
        console.error('FMP returned another security', { action, symbol });
        return send(502, { error: 'FMP_SECURITY_MISMATCH' });
      }
      if (provider !== symbol) data = data.map(row => ({ ...row, symbol, providerSymbol: provider }));
      else if (softSymbol) {
        data = data.map(row => ({ ...row, symbol }));
      }
      // Never forward accidental transcript body fields on metadata endpoints.
      if (transcriptDates) {
        data = data.map(row => {
          const { content, transcript, ...meta } = row || {};
          return meta;
        });
      }
      // Broad WhaleCreep holders — annotate curated CIKs; do not drop non-curated managers.
      if (institutionalHolders) {
        data = data.map(row => ({
          ...row,
          cik: SmartMoney.padCik(row.cik),
          year: Number(instYear),
          quarter: Number(instQuarter),
          // Curated-20 badge only — extract allowlist (holder-funds) must not inflate isCurated.
          isCurated: SmartMoney.isCuratedCik(row?.cik),
        }));
      }
    }
    // Paid / document / 13F metadata must not be edge-cached publicly.
    if (secFilings || transcriptDates || institutionalHolders || institutionalExtract) {
      res.setHeader('Cache-Control', 'private, no-store');
    } else {
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    }
    return send(200, { data, source: { provider: 'FMP', endpoint,
      symbol: symbol || null,
      capturedAt: new Date().toISOString(),
      ...(technical ? { indicator, periodLength: Number(period),
        timeframe: '1day', from, to, priceBasis: 'FMP technical-indicator OHLC close; alignment checked against the displayed price history' } : {}),
      ...(historical ? { from, to, priceBasis: 'splitAdjustedClose' } : {}),
      ...(institutionalHolders || institutionalExtract
        ? { year: Number(instYear), quarter: Number(instQuarter),
          ...(institutionalExtract ? { cik: cikParam, cappedAt: SmartMoney.FUND_EXTRACT_MAX } : {}) } : {}) },
      ...(action === 'news' ? {
        page: Number(page), hasMore: rows.length === 50 && Number(page) < 1000,
        limitReached: rows.length === 50 && Number(page) === 1000
      } : {}) });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.customParameters = customParameters;
