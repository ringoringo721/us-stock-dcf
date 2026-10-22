(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UsUniverse = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  let cached, previousMarket, previousList, previousExpansion;
  const pending = new Map();
  const US_TICKER = /^[A-Z][A-Z0-9.-]{0,14}$/;

  function listingStock(item) {
    return {
      ticker: item.ticker, name: item.name || item.name_en, name_en: item.name_en || item.name,
      company_name: item.name_en || item.name, market: 'US', exchange: item.exchange,
      sector: item.sector || 'Unclassified', industry: item.industry || 'Unclassified',
      calculationCurrency: 'USD', tradingCurrency: 'USD',
      universeMembership: item.universeMembership,
      price: null, mcap: item.marketCap != null ? item.marketCap / 1e6 : null,
      shares: null, shares_outstanding: null, debt: null, cash: null,
      cash_and_short_term: null, fcf0: null, f_score: null, f_score_breakdown: [], moat: null,
      pe_trailing: null, pb_trailing: null, div_yield: null, beta: null,
      fair_val: null, reportingFrequency: 'quarterly',
      statementFrequencies: { income: 'quarterly', balance: 'quarterly', cashflow: 'quarterly' },
      statements_raw: { annual_dates: [], income: {}, balance: {}, cashflow: {},
        quarterly_raw: { dates: [], income: {}, balance: {}, cashflow: {} } },
      fin_valuation: { is_financial: false }, real_history: {}, real_5y_prices: [],
      peers: [], top_holders: [], insider_trades: [], stock_splits: [], news: [],
      dataAvailability: { currentPrice: 'pendingCapture', financials: 'pendingCapture' },
      ratingSources: { moat: { reason: 'analysisUnavailable' }, fScore: { reason: 'pendingCapture' } },
      expansion: { status: 'pendingCapture', source: item.universeMembership }
    };
  }

  function merge(market, list = root.US_LISTINGS, expansion = root.US_EXPANSION) {
    if (!market || !list) return market;
    if (cached && market === previousMarket && list === previousList && expansion === previousExpansion) {
      return cached;
    }
    const result = Object.fromEntries(list.stocks.map(item => [item.ticker,
      expansion?.stocks?.[item.ticker] || listingStock(item)]));
    Object.assign(result, market);
    previousMarket = market; previousList = list; previousExpansion = expansion; cached = result;
    return result;
  }

  function install() {
    if (!root.US_EXPANSION) return;
    if (root.FMP_MODEL_DATA?.stocks) Object.assign(root.FMP_MODEL_DATA.stocks, root.US_EXPANSION.models || {});
    if (root.FCFF_DATA?.stocks) Object.assign(root.FCFF_DATA.stocks, root.US_EXPANSION.snapshots || {});
  }

  function uncaptured(ticker) {
    if (root.FULL_MARKET_DATA?.[ticker]) return false;
    const known = root.US_LISTINGS?.stocks.some(item => item.ticker === ticker);
    return !!known && root.US_EXPANSION?.stocks?.[ticker]?.expansion?.status !== 'available';
  }

  function load(ticker, refresh = false) {
    if (!US_TICKER.test(ticker) || /\.HK$/i.test(ticker)) {
      return Promise.reject(new Error('INVALID_US_TICKER'));
    }
    if (refresh) pending.delete(ticker);
    if (!pending.has(ticker)) {
      const request = root.fetch(`cache/us_companies/${ticker}.json`, { cache: refresh ? 'reload' : 'default' })
        .then(response => {
          if (!response.ok) throw new Error(`US_COMPANY_HTTP_${response.status}`);
          return response.json();
        }).then(record => {
          if (record.version !== 1 || record.ticker !== ticker || record.stock?.ticker !== ticker
              || record.stock.calculationCurrency !== 'USD') {
            throw new Error('INVALID_US_COMPANY_SNAPSHOT');
          }
          if (record.model && root.FMP_MODEL_DATA?.stocks) root.FMP_MODEL_DATA.stocks[ticker] = record.model;
          if (record.snapshot && root.FCFF_DATA?.stocks) root.FCFF_DATA.stocks[ticker] = record.snapshot;
          return record.stock;
        }).catch(error => { pending.delete(ticker); throw error; });
      pending.set(ticker, request);
    }
    return pending.get(ticker);
  }

  return { merge, listingStock, install, load, uncaptured };
});
