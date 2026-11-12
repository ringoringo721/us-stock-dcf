(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UsIndexes = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  /** Curated US index / industry proxies — FMP quote + historical-price-eod symbols. */
  const CATALOG = Object.freeze([
    { id: 'GSPC', symbol: '^GSPC', labelZh: '標普500', labelEn: 'S&P 500', kind: 'major' },
    { id: 'IXIC', symbol: '^IXIC', labelZh: '納斯達克綜合', labelEn: 'NASDAQ Composite', kind: 'major' },
    { id: 'DJI', symbol: '^DJI', labelZh: '道瓊斯', labelEn: 'Dow Jones', kind: 'major' },
    { id: 'RUT', symbol: '^RUT', labelZh: '羅素2000', labelEn: 'Russell 2000', kind: 'major' },
    { id: 'VIX', symbol: '^VIX', labelZh: 'VIX 波動率', labelEn: 'VIX', kind: 'major' },
    { id: 'XLK', symbol: 'XLK', labelZh: '科技', labelEn: 'Technology', kind: 'sector' },
    { id: 'XLF', symbol: 'XLF', labelZh: '金融', labelEn: 'Financials', kind: 'sector' },
    { id: 'XLE', symbol: 'XLE', labelZh: '能源', labelEn: 'Energy', kind: 'sector' },
    { id: 'XLV', symbol: 'XLV', labelZh: '醫療保健', labelEn: 'Health Care', kind: 'sector' },
    { id: 'XLI', symbol: 'XLI', labelZh: '工業', labelEn: 'Industrials', kind: 'sector' },
    { id: 'XLY', symbol: 'XLY', labelZh: '非必需消費', labelEn: 'Consumer Disc.', kind: 'sector' },
    { id: 'XLP', symbol: 'XLP', labelZh: '必需消費', labelEn: 'Consumer Staples', kind: 'sector' },
    { id: 'XLU', symbol: 'XLU', labelZh: '公用事業', labelEn: 'Utilities', kind: 'sector' },
    { id: 'XLB', symbol: 'XLB', labelZh: '原物料', labelEn: 'Materials', kind: 'sector' },
    { id: 'XLRE', symbol: 'XLRE', labelZh: '房地產', labelEn: 'Real Estate', kind: 'sector' },
    { id: 'XLC', symbol: 'XLC', labelZh: '通訊服務', labelEn: 'Communication', kind: 'sector' },
  ]);

  const SYMBOLS = Object.freeze(CATALOG.map(row => row.symbol));
  const BY_SYMBOL = Object.freeze(Object.fromEntries(CATALOG.map(row => [row.symbol, row])));
  const SPARKLINE_POINTS = 40;
  const HISTORY_LOOKBACK_DAYS = 90;

  function isoDaysAgo(days, now = new Date()) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().slice(0, 10);
  }

  function todayIso(now = new Date()) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      .toISOString().slice(0, 10);
  }

  function finiteNumber(value) {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeQuoteRow(row) {
    if (!row || typeof row !== 'object') return null;
    const symbol = String(row.symbol || '');
    if (!BY_SYMBOL[symbol]) return null;
    const changePct = finiteNumber(row.changePercentage ?? row.changesPercentage);
    const price = finiteNumber(row.price);
    if (price == null || price <= 0 || changePct == null) return null;
    return { symbol, price, changePct, previousClose: finiteNumber(row.previousClose) };
  }

  function normalizeHistoryCloses(rows, symbol, limit = SPARKLINE_POINTS) {
    if (!Array.isArray(rows)) return [];
    const closes = [];
    for (const row of rows) {
      if (!row || (row.symbol != null && row.symbol !== symbol && row.symbol !== '')) continue;
      const date = String(row.date || '').slice(0, 10);
      const close = finiteNumber(row.close);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || close == null || close <= 0) continue;
      closes.push({ date, close });
    }
    closes.sort((a, b) => a.date.localeCompare(b.date));
    return closes.slice(-limit).map(row => row.close);
  }

  function buildPayload({ quotes = [], histories = {}, capturedAt = new Date().toISOString(),
    source = 'FMP' } = {}) {
    const quoteBySymbol = new Map();
    for (const row of quotes) {
      const normalized = normalizeQuoteRow(row);
      if (normalized) quoteBySymbol.set(normalized.symbol, normalized);
    }
    const indexes = [];
    for (const meta of CATALOG) {
      const quote = quoteBySymbol.get(meta.symbol);
      const sparkline = normalizeHistoryCloses(histories[meta.symbol] || [], meta.symbol);
      if (!quote || sparkline.length < 8) continue;
      indexes.push({
        id: meta.id,
        symbol: meta.symbol,
        kind: meta.kind,
        labelZh: meta.labelZh,
        labelEn: meta.labelEn,
        price: quote.price,
        changePct: quote.changePct,
        sparkline,
      });
    }
    return {
      version: 1,
      market: 'US',
      source: { provider: source, endpoints: ['batch-quote', 'historical-price-eod/full'] },
      capturedAt,
      indexes,
    };
  }

  function validatePayload(payload) {
    if (!payload || payload.version !== 1 || payload.market !== 'US'
        || !Array.isArray(payload.indexes) || !payload.indexes.length) {
      throw new TypeError('Unsupported US index belt payload');
    }
    for (const row of payload.indexes) {
      if (!row || !BY_SYMBOL[row.symbol] || row.id !== BY_SYMBOL[row.symbol].id
          || typeof row.price !== 'number' || !Number.isFinite(row.price) || row.price <= 0
          || typeof row.changePct !== 'number' || !Number.isFinite(row.changePct)
          || !Array.isArray(row.sparkline) || row.sparkline.length < 8
          || row.sparkline.some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
        throw new TypeError('Invalid US index belt row');
      }
    }
    return payload;
  }

  return {
    CATALOG, SYMBOLS, BY_SYMBOL, SPARKLINE_POINTS, HISTORY_LOOKBACK_DAYS,
    isoDaysAgo, todayIso, normalizeQuoteRow, normalizeHistoryCloses, buildPayload, validatePayload,
  };
});
