const technicals = require('../technical_indicators.js');
const endpoints = {
  technical: 'technical-indicators',
  news: 'news/stock',
  dcf: 'discounted-cash-flow',
  'levered-dcf': 'levered-discounted-cash-flow',
  'custom-dcf': 'custom-discounted-cash-flow',
  'custom-levered-dcf': 'custom-levered-discounted-cash-flow',
  'historical-price': 'historical-price-eod/full',
};
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
    if (!Object.hasOwn(endpoints, action) || !/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(symbol || '')
        || [...new Set(query.keys())].some(key => query.getAll(key).length !== 1)
        || [...query.keys()].some(key => !['action', 'symbol', 'page'].includes(key)
          && !(technical && ['indicator', 'periodLength', 'from', 'to'].includes(key))
          && !(historical && ['from', 'to'].includes(key))
          && !(custom && Object.hasOwn(customParameters, key)))) {
      return send(400, { error: 'INVALID_REQUEST' });
    }
    const page = query.get('page') || '0';
    if (!/^\d{1,4}$/.test(page) || Number(page) > 1000 || action !== 'news' && query.has('page')) {
      return send(400, { error: 'INVALID_PAGE' });
    }
    const indicator = query.get('indicator'), period = query.get('periodLength');
    const from = query.get('from'), to = query.get('to');
    if (technical && (!/^\d{1,3}$/.test(period || '')
        || !technicals.validRequest(indicator, Number(period), from, to))) {
      return send(400, { error: 'INVALID_TECHNICAL_REQUEST' });
    }
    if (historical && (!validDate(from) || !validDate(to) || from > to
        || Date.parse(to) - Date.parse(from) > 8000 * 86400000)) {
      return send(400, { error: 'INVALID_HISTORICAL_PRICE_REQUEST' });
    }
    const key = apiKey();
    if (!key) return send(503, { error: 'FMP_NOT_CONFIGURED' });
    const endpoint = technical ? `${endpoints[action]}/${indicator}` : endpoints[action];
    const url = new URL(`https://financialmodelingprep.com/stable/${endpoint}`);
    const provider = symbol.endsWith('.HK') ? symbol : symbol.replaceAll('.', '-');
    url.searchParams.set(action === 'news' ? 'symbols' : 'symbol', provider);
    if (technical) {
      for (const [name, value] of Object.entries({ periodLength: period, timeframe: '1day', from, to })) {
        url.searchParams.set(name, value);
      }
    }
    if (historical) {
      url.searchParams.set('from', from);
      url.searchParams.set('to', to);
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
    let rows;
    try { rows = await response.json(); }
    catch {
      console.error('FMP returned invalid JSON', { action, symbol });
      return send(502, { error: 'FMP_INVALID_RESPONSE' });
    }
    if (!Array.isArray(rows)) {
      console.error('FMP returned a non-array response', { action, symbol });
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
    } else {
      data = rows.filter(row => row && row.symbol === provider);
      if (data.length !== rows.length) {
        console.error('FMP returned another security', { action, symbol });
        return send(502, { error: 'FMP_SECURITY_MISMATCH' });
      }
      if (provider !== symbol) data = data.map(row => ({ ...row, symbol, providerSymbol: provider }));
    }
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return send(200, { data, source: { provider: 'FMP', endpoint, symbol,
      capturedAt: new Date().toISOString(),
      ...(technical ? { indicator, periodLength: Number(period),
        timeframe: '1day', from, to, priceBasis: 'FMP technical-indicator OHLC close; alignment checked against the displayed price history' } : {}),
      ...(historical ? { from, to, priceBasis: 'splitAdjustedClose' } : {}) },
      ...(action === 'news' ? {
        page: Number(page), hasMore: rows.length === 50 && Number(page) < 1000,
        limitReached: rows.length === 50 && Number(page) === 1000
      } : {}) });
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.customParameters = customParameters;
