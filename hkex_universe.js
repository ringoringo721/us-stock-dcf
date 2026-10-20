(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HkUniverse = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  let cached, previousMarket, previousList, previousExpansion;
  const pending = new Map();
  function belowMoatMarketCap(stock, ticker = stock?.ticker) {
    return /^\d{4,5}\.HK$/.test(ticker || '') && stock?.calculationCurrency === 'HKD'
      && Number.isFinite(stock.mcap) && stock.mcap > 0 && stock.mcap < 1000;
  }
  function emptyStatements(ticker) {
    return { ticker, calculationCurrency: 'HKD', sourceAvailability: 'pendingCapture',
      annual: { income: [], balance: [], cashflow: [] }, quarterly: { income: [], balance: [], cashflow: [] } };
  }
  function listingStock(item) {
    return { ticker: item.ticker, displayCode: item.displayCode, name: item.name, name_zh: item.name_zh, name_en: item.name_en,
      company_name: item.name_en, market: 'HKEX', exchange: 'HKEX',
      sector: item.sector || 'Unclassified', industry: item.industry || 'Unclassified',
      calculationCurrency: 'HKD', tradingCurrency: item.tradingCurrency, universeMembership: item.universeMembership,
      price: null, mcap: null, shares: null, shares_outstanding: null, debt: null, cash: null,
      cash_and_short_term: null, fcf0: null, f_score: null, f_score_breakdown: [], moat: null,
      pe_trailing: null, pb_trailing: null, div_yield: null, beta: null,
      fair_val: null, reportingFrequency: 'annual', statementFrequencies: { income: 'annual', balance: 'annual', cashflow: 'annual' },
      statements_raw: { annual_dates: [], income: {}, balance: {}, cashflow: {},
        quarterly_raw: { dates: [], income: {}, balance: {}, cashflow: {} } },
      fin_valuation: { is_financial: false }, real_history: {}, real_5y_prices: [],
      peers: [], top_holders: [], insider_trades: [], stock_splits: [], news: [],
      dataAvailability: { currentPrice: 'pendingCapture', financials: 'pendingCapture' },
      ratingSources: { moat: { reason: 'analysisUnavailable' }, fScore: { reason: 'pendingCapture' } },
      expansion: { status: 'pendingCapture', source: item.universeMembership } };
  }
  function listingNames(stock, item) {
    return item?.name_zh ? { ...stock, name_zh: item.name_zh, name_en: stock.name_en || item.name_en } : stock;
  }
  function merge(market, list = root.HKEX_LISTINGS, expansion = root.HKEX_EXPANSION) {
    if (!market || !list) return market;
    if (cached && market === previousMarket && list === previousList && expansion === previousExpansion) return cached;
    const result = Object.fromEntries(list.stocks.map(item => [item.ticker,
      listingNames(expansion?.stocks?.[item.ticker] || listingStock(item), item)]));
    Object.assign(result, market);
    previousMarket = market; previousList = list; previousExpansion = expansion; cached = result;
    return result;
  }
  function install() {
    if (!root.HKEX_EXPANSION) return;
    if (root.FMP_MODEL_DATA?.stocks) Object.assign(root.FMP_MODEL_DATA.stocks, root.HKEX_EXPANSION.models || {});
    if (root.HK_FCFF_DATA?.stocks) Object.assign(root.HK_FCFF_DATA.stocks, root.HKEX_EXPANSION.snapshots || {});
  }
  function uncaptured(ticker) {
    if (root.HK_MARKET_DATA?.[ticker]) return false;
    const known = root.HKEX_LISTINGS?.stocks.some(item => item.ticker === ticker);
    return !!known && root.HKEX_EXPANSION?.stocks?.[ticker]?.expansion?.status !== 'available';
  }
  function load(ticker, refresh = false) {
    if (!/^\d{4,5}\.HK$/.test(ticker)) return Promise.reject(new Error('INVALID_HK_TICKER'));
    if (refresh) pending.delete(ticker);
    if (!pending.has(ticker)) {
      const request = root.fetch(`cache/hk_companies/${ticker}.json`, { cache: refresh ? 'reload' : 'default' })
        .then(response => {
          if (!response.ok) throw new Error(`HK_COMPANY_HTTP_${response.status}`);
          return response.json();
        }).then(record => {
          if (record.version !== 1 || record.ticker !== ticker || record.stock?.ticker !== ticker
              || record.stock.calculationCurrency !== 'HKD') throw new Error('INVALID_HK_COMPANY_SNAPSHOT');
          if (record.model && root.FMP_MODEL_DATA?.stocks) root.FMP_MODEL_DATA.stocks[ticker] = record.model;
          if (record.snapshot && root.HK_FCFF_DATA?.stocks) root.HK_FCFF_DATA.stocks[ticker] = record.snapshot;
          return listingNames(record.stock, root.HKEX_LISTINGS?.stocks.find(item => item.ticker === ticker));
        }).catch(error => { pending.delete(ticker); throw error; });
      pending.set(ticker, request);
    }
    return pending.get(ticker);
  }
  return { merge, listingStock, emptyStatements, install, load, uncaptured, belowMoatMarketCap };
});
