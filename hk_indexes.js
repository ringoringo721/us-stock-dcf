(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HkIndexes = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  /**
   * Curated HK / China-facing index belt — FMP quote + historical-price-eod symbols.
   *
   * FMP index-list only exposes ^HSI and ^HSCE as true INDEX symbols for Hang Seng.
   * Hang Seng TECH and industry sleeves therefore use liquid HKEX-listed ETF proxies
   * that track those indexes / thematics (same pattern as US sector SPDRs).
   */
  const CATALOG = Object.freeze([
    { id: 'HSI', symbol: '^HSI', labelZh: '恒生指數', labelEn: 'Hang Seng', kind: 'major' },
    {
      id: 'HSTECH', symbol: '3033.HK', labelZh: '恒生科技', labelEn: 'Hang Seng TECH',
      kind: 'major', proxyNote: 'CSOP Hang Seng TECH Index ETF (FMP has no ^HSTECH)',
    },
    { id: 'HSCE', symbol: '^HSCE', labelZh: '恒生國企', labelEn: 'HSCEI', kind: 'major' },
    {
      id: 'HSHD30', symbol: '3466.HK', labelZh: '恒生高息30', labelEn: 'HS High Div 30',
      kind: 'major', proxyNote: 'Hang Seng High Dividend 30 Index ETF',
    },
    {
      id: 'MSCI_CN', symbol: '2801.HK', labelZh: 'MSCI中國', labelEn: 'MSCI China',
      kind: 'major', proxyNote: 'iShares Core MSCI China ETF',
    },
    {
      id: 'A50', symbol: '2823.HK', labelZh: '富時A50', labelEn: 'FTSE China A50',
      kind: 'major', proxyNote: 'iShares FTSE China A50 ETF',
    },
    {
      id: 'CSI300', symbol: '2846.HK', labelZh: '滬深300', labelEn: 'CSI 300',
      kind: 'major', proxyNote: 'iShares Core CSI 300 ETF',
    },
    {
      id: 'CONSUMER', symbol: '2806.HK', labelZh: '消費品牌', labelEn: 'Consumer Brand',
      kind: 'sector', proxyNote: 'Global X China Consumer Brand ETF',
    },
    {
      id: 'BIOTECH', symbol: '2820.HK', labelZh: '生物科技', labelEn: 'Biotech',
      kind: 'sector', proxyNote: 'Global X China Biotech ETF',
    },
    {
      id: 'CLOUD', symbol: '2826.HK', labelZh: '雲計算', labelEn: 'Cloud',
      kind: 'sector', proxyNote: 'Global X China Cloud Computing ETF',
    },
    {
      id: 'AIROBO', symbol: '2807.HK', labelZh: '機械人AI', labelEn: 'Robotics & AI',
      kind: 'sector', proxyNote: 'Global X China Robotics and AI ETF',
    },
    {
      id: 'CLEAN', symbol: '2809.HK', labelZh: '清潔能源', labelEn: 'Clean Energy',
      kind: 'sector', proxyNote: 'Global X China Clean Energy ETF',
    },
    {
      id: 'EVBAT', symbol: '2845.HK', labelZh: '電動車電池', labelEn: 'EV & Battery',
      kind: 'sector', proxyNote: 'Global X China Electric Vehicle and Battery ETF',
    },
    {
      id: 'SEMI', symbol: '3191.HK', labelZh: '半導體', labelEn: 'Semiconductor',
      kind: 'sector', proxyNote: 'Global X China Semiconductor ETF',
    },
    {
      id: 'HKDIV', symbol: '3070.HK', labelZh: '港股高息', labelEn: 'HK Dividend',
      kind: 'sector', proxyNote: 'Ping An of China CSI HK Dividend ETF',
    },
    {
      id: 'HSHDY', symbol: '3110.HK', labelZh: '恒生高息', labelEn: 'HS High Yield',
      kind: 'sector', proxyNote: 'Global X Hang Seng High Dividend Yield ETF',
    },
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
      market: 'HKEX',
      source: { provider: source, endpoints: ['batch-quote', 'historical-price-eod/full'] },
      capturedAt,
      indexes,
    };
  }

  function validatePayload(payload) {
    if (!payload || payload.version !== 1 || payload.market !== 'HKEX'
        || !Array.isArray(payload.indexes) || !payload.indexes.length) {
      throw new TypeError('Unsupported HK index belt payload');
    }
    for (const row of payload.indexes) {
      if (!row || !BY_SYMBOL[row.symbol] || row.id !== BY_SYMBOL[row.symbol].id
          || typeof row.price !== 'number' || !Number.isFinite(row.price) || row.price <= 0
          || typeof row.changePct !== 'number' || !Number.isFinite(row.changePct)
          || !Array.isArray(row.sparkline) || row.sparkline.length < 8
          || row.sparkline.some(value => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
        throw new TypeError('Invalid HK index belt row');
      }
    }
    return payload;
  }

  return {
    CATALOG, SYMBOLS, BY_SYMBOL, SPARKLINE_POINTS, HISTORY_LOOKBACK_DAYS,
    isoDaysAgo, todayIso, normalizeQuoteRow, normalizeHistoryCloses, buildPayload, validatePayload,
  };
});
