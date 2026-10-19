(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TechnicalIndicators = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  const Cache = typeof module === 'object' && module.exports ? require('./fmp_cache.js') : root.FmpCache;
  const catalog = [
    { id: 'sma', zh: '簡單移動平均', en: 'Simple moving average', period: 20, overlay: true },
    { id: 'ema', zh: '指數移動平均', en: 'Exponential moving average', period: 20, overlay: true },
    { id: 'wma', zh: '加權移動平均', en: 'Weighted moving average', period: 20, overlay: true },
    { id: 'dema', zh: '雙重指數移動平均', en: 'Double exponential moving average', period: 20, overlay: true },
    { id: 'tema', zh: '三重指數移動平均', en: 'Triple exponential moving average', period: 20, overlay: true },
    { id: 'rsi', zh: '相對強弱指標', en: 'Relative strength index', period: 14, bounds: [0, 100] },
    { id: 'adx', zh: '平均趨向指標', en: 'Average directional index', period: 14, bounds: [0, 100] },
    { id: 'williams', zh: '威廉指標', en: 'Williams %R', period: 14, bounds: [-100, 0] },
    { id: 'standarddeviation', zh: '標準差', en: 'Standard deviation', period: 20 }
  ];
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const field = indicator => indicator === 'standarddeviation' ? 'standardDeviation' : indicator;
  function validRequest(indicator, period, from, to) {
    return catalog.some(item => item.id === indicator) && Number.isInteger(period) && period >= 1 && period <= 500
      && validDate(from) && validDate(to) && from <= to && Date.parse(to) - Date.parse(from) <= 8000 * 86400000;
  }
  function normalize(rows, indicator, symbol, from, to) {
    const seen = new Set(), key = field(indicator);
    return rows.map(row => {
      const date = row?.date?.slice(0, 10);
      if (!validDate(date) || !/^\d{4}-\d{2}-\d{2}(?:[ T]00:00:00(?:Z)?)?$/.test(row.date)
          || date < from || date > to || seen.has(date) || row.symbol != null && row.symbol !== symbol
          || !finite(row.close) || row.close <= 0 || row[key] !== null && !finite(row[key])) {
        throw new Error('FMP_INVALID_TECHNICAL_RESPONSE');
      }
      seen.add(date);
      return { date, value: row[key], close: row.close };
    }).sort((a, b) => a.date.localeCompare(b.date));
  }
  function align(rows, prices) {
    const closes = new Map(prices.map(row => [row[0], row[1]]));
    const matched = rows.filter(row => closes.has(row.date));
    if (rows.length && !matched.length) throw new Error('TECHNICAL_NO_MATCHING_SESSIONS');
    if (matched.some(row => Math.abs(closes.get(row.date) - row.close) > Math.max(0.005, Math.abs(row.close) * 1e-8))) {
      throw new Error('TECHNICAL_PRICE_BASIS_MISMATCH');
    }
    return new Map(matched.map(row => [row.date, row.value]));
  }
  const cache = new Map();
  function load(symbol, indicator, periodLength, from, to, reload = false) {
    if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(symbol)
        || !validRequest(indicator, periodLength, from, to)) return Promise.reject(new Error('INVALID_TECHNICAL_REQUEST'));
    const query = new URLSearchParams({ action: 'technical', symbol, indicator, periodLength, from, to });
    const key = query.toString();
    if (reload || !cache.has(key)) {
      const promise = (async () => {
        const result = await Cache.request(query, { refresh: reload });
        if (result.source?.symbol !== symbol || result.source.indicator !== indicator
            || result.source.periodLength !== periodLength || result.source.timeframe !== '1day'
            || result.source.from !== from || result.source.to !== to || !Array.isArray(result.data)) {
          throw new Error('FMP_INVALID_TECHNICAL_RESPONSE');
        }
        const upstream = result.data.map(row => ({ date: row.date, close: row.close, [field(indicator)]: row.value }));
        return { rows: normalize(upstream, indicator, symbol, from, to), source: result.source, cache: result.cache };
      })();
      cache.set(key, promise);
      while (cache.size > 36) cache.delete(cache.keys().next().value);
      promise.catch(() => { if (cache.get(key) === promise) cache.delete(key); });
    }
    return cache.get(key);
  }
  return { catalog, validDate, validRequest, normalize, align, load, cacheNote: Cache.note };
});
