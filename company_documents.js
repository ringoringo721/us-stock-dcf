/**
 * Company filings / documents helpers (TradingView Documents tab).
 * US: FMP SEC filings + transcript dates; public SEC EDGAR search links.
 * HK: HKEXNEWS financial-statement filings; transcript dates still from FMP
 * metadata only — open HKEXnews (never SEC 8-K / EDGAR).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanyDocuments = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Remember stock-scoped HKEXnews search URLs after a successful filings load. */
  const hkexSearchByTicker = new Map();

  function finite(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function edgarSearchUrl(ticker, forms = '10-K,10-Q,8-K') {
    const symbol = encodeURIComponent(String(ticker || '').trim());
    const formList = encodeURIComponent(forms);
    return `https://www.sec.gov/edgar/search/#/category=custom&entityName=${symbol}&forms=${formList}`;
  }

  function edgarBrowseUrl(ticker) {
    const symbol = encodeURIComponent(String(ticker || '').trim());
    return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${symbol}&type=&dateb=&owner=exclude&count=40`;
  }

  function hkexStockCode(ticker) {
    const match = String(ticker || '').trim().toUpperCase().match(/^(\d{4,5})\.HK$/);
    return match ? match[1].padStart(5, '0') : null;
  }

  function hkexLang(lang = 'zh') {
    return String(lang).toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }

  function hkexNewsTitleSearchUrl(lang = 'zh') {
    return `https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=${hkexLang(lang)}`;
  }

  function hkexQuoteUrl(ticker, lang = 'zh') {
    const code = hkexStockCode(ticker);
    if (!code) {
      return `https://www.hkex.com.hk/Market-Data/Securities-Prices/Equities?sc_lang=${
        hkexLang(lang) === 'zh' ? 'zh-HK' : 'en'}`;
    }
    const sym = String(Number(code));
    const scLang = hkexLang(lang) === 'zh' ? 'zh-HK' : 'en';
    return `https://www.hkex.com.hk/Market-Data/Securities-Prices/Equities/Equities-Quote?sc_lang=${scLang}&sym=${encodeURIComponent(sym)}`;
  }

  /** Rewrite titlesearch.xhtml lang= without dropping stockId (or other) params. */
  function withHkexNewsLang(url, lang = 'zh') {
    try {
      const parsed = new URL(url);
      if (!/hkexnews\.hk$/i.test(parsed.hostname)) return hkexNewsTitleSearchUrl(lang);
      parsed.searchParams.set('lang', hkexLang(lang));
      return parsed.toString();
    } catch {
      return hkexNewsTitleSearchUrl(lang);
    }
  }

  function rememberHkexSearch(ticker, url) {
    const key = String(ticker || '').trim().toUpperCase();
    if (key && typeof url === 'string' && /^https?:\/\//i.test(url)) {
      // Store stock-scoped URL; lang is applied later via withHkexNewsLang.
      hkexSearchByTicker.set(key, url);
    }
  }

  function hkexSearchUrlFor(ticker, lang = 'zh') {
    const key = String(ticker || '').trim().toUpperCase();
    const cached = hkexSearchByTicker.get(key);
    if (cached) return withHkexNewsLang(cached, lang);
    return hkexNewsTitleSearchUrl(lang);
  }

  function normalizeFiling(row, ticker) {
    if (!row || typeof row !== 'object') return null;
    const form = String(row.formType || row.type || row.form || '').trim();
    const filingDate = String(row.filingDate || row.acceptedDate || row.date || '').slice(0, 10);
    const link = row.finalLink || row.link || row.url || row.htmlLink || null;
    if (!form && !link) return null;
    return {
      kind: 'filing',
      ticker,
      form: form || 'Filing',
      filingDate: /^\d{4}-\d{2}-\d{2}$/.test(filingDate) ? filingDate : null,
      acceptedDate: row.acceptedDate ? String(row.acceptedDate).slice(0, 10) : null,
      title: row.title || row.description || form || 'SEC filing',
      link: typeof link === 'string' && /^https?:\/\//i.test(link) ? link : null,
      cik: row.cik != null ? String(row.cik) : null,
      source: row.source || null,
    };
  }

  function normalizeFilings(rows, ticker) {
    if (!Array.isArray(rows)) return [];
    return rows.map(row => normalizeFiling(row, ticker)).filter(Boolean)
      .sort((a, b) => String(b.filingDate || '').localeCompare(String(a.filingDate || '')));
  }

  function normalizeTranscriptDate(row, ticker) {
    if (!row || typeof row !== 'object') return null;
    const year = finite(row.fiscalYear ?? row.year);
    const quarter = finite(row.quarter ?? row.period);
    const date = String(row.date || row.transcriptDate || '').slice(0, 10);
    if (!year || !quarter) return null;
    return {
      kind: 'transcript',
      ticker,
      year: Math.trunc(year),
      quarter: Math.trunc(quarter),
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      label: `FY${Math.trunc(year)} Q${Math.trunc(quarter)}`,
    };
  }

  function normalizeTranscriptDates(rows, ticker) {
    if (!Array.isArray(rows)) return [];
    return rows.map(row => normalizeTranscriptDate(row, ticker)).filter(Boolean)
      .sort((a, b) => (b.year - a.year) || (b.quarter - a.quarter));
  }

  function isUsListed(stock) {
    const ticker = String(stock?.ticker || '');
    if (/\.HK$/i.test(ticker)) return false;
    const market = String(stock?.market || '').toUpperCase();
    if (market === 'HKEX') return false;
    const exchange = String(stock?.exchange || '');
    if (/HKEX|HONG KONG/i.test(exchange)) return false;
    const currency = String(stock?.calculationCurrency || '').toUpperCase();
    if (currency === 'HKD') return false;
    return true;
  }

  function publicLinks(ticker, stock = null, lang = 'zh') {
    const links = [];
    const resolved = stock || { ticker };
    if (isUsListed(resolved)) {
      links.push({
        id: 'sec-search',
        labelEn: 'SEC EDGAR search (10-K / 10-Q / 8-K)',
        labelZh: 'SEC EDGAR 搜尋（10-K／10-Q／8-K）',
        url: edgarSearchUrl(ticker),
      });
      links.push({
        id: 'sec-browse',
        labelEn: 'SEC company filings browser',
        labelZh: 'SEC 公司申報瀏覽',
        url: edgarBrowseUrl(ticker),
      });
      return links;
    }
    links.push({
      id: 'hkexnews-search',
      labelEn: 'HKEXnews title search',
      labelZh: '披露易標題搜尋',
      url: hkexSearchUrlFor(ticker, lang),
    });
    links.push({
      id: 'hkex-quote',
      labelEn: 'HKEX equities quote',
      labelZh: '港交所報價頁',
      url: hkexQuoteUrl(ticker, lang),
    });
    return links;
  }

  function loadSecFilings(ticker, options = {}) {
    const years = Math.max(1, Math.min(10, Number(options.years) || 5));
    const to = new Date();
    const from = new Date(to);
    from.setUTCFullYear(from.getUTCFullYear() - years);
    const qs = new URLSearchParams({
      action: 'sec-filings',
      symbol: ticker,
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      limit: String(Math.max(1, Math.min(100, Number(options.limit) || 40))),
      page: '0',
    });
    return fetch(`/api/fmp?${qs}`).then(async (response) => {
      if (!response.ok) {
        let detail = String(response.status);
        try {
          const body = await response.json();
          if (body?.error) detail = `${response.status}:${body.error}`;
        } catch { /* ignore */ }
        throw new Error(`FILINGS_API_FAILED:${detail}`);
      }
      const body = await response.json();
      const rows = Array.isArray(body) ? body : body?.data || [];
      return {
        ticker,
        market: 'US',
        source: body?.source?.provider || 'FMP',
        rows: normalizeFilings(rows, ticker),
      };
    });
  }

  function loadHkexFilings(ticker, options = {}) {
    const years = Math.max(1, Math.min(10, Number(options.years) || 5));
    const to = new Date();
    const from = new Date(to);
    from.setUTCFullYear(from.getUTCFullYear() - years);
    const qs = new URLSearchParams({
      action: 'filings',
      symbol: ticker,
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      limit: String(Math.max(1, Math.min(100, Number(options.limit) || 40))),
    });
    return fetch(`/api/hkexnews?${qs}`).then(async (response) => {
      if (!response.ok) {
        let detail = String(response.status);
        try {
          const body = await response.json();
          if (body?.error) detail = `${response.status}:${body.error}`;
        } catch { /* ignore */ }
        throw new Error(`HKEX_FILINGS_API_FAILED:${detail}`);
      }
      const body = await response.json();
      const rows = Array.isArray(body) ? body : body?.data || [];
      if (body?.source?.searchUrl) rememberHkexSearch(ticker, body.source.searchUrl);
      return {
        ticker,
        market: 'HKEX',
        source: body?.source?.provider || 'HKEXNEWS',
        searchUrl: body?.source?.searchUrl || null,
        stockId: body?.source?.stockId || null,
        rows: normalizeFilings(rows, ticker),
      };
    });
  }

  function loadFilings(ticker, options = {}) {
    const stock = options.stock || { ticker };
    if (!isUsListed(stock) || /\.HK$/i.test(String(ticker || ''))) {
      return loadHkexFilings(ticker, options);
    }
    return loadSecFilings(ticker, options);
  }

  function loadTranscriptDates(ticker) {
    const qs = new URLSearchParams({ action: 'transcript-dates', symbol: ticker });
    return fetch(`/api/fmp?${qs}`).then(async (response) => {
      if (!response.ok) {
        let detail = String(response.status);
        try {
          const body = await response.json();
          if (body?.error) detail = `${response.status}:${body.error}`;
        } catch { /* ignore */ }
        throw new Error(`TRANSCRIPT_DATES_API_FAILED:${detail}`);
      }
      const body = await response.json();
      const rows = Array.isArray(body) ? body : body?.data || [];
      return {
        ticker,
        source: body?.source?.provider || 'FMP',
        rows: normalizeTranscriptDates(rows, ticker),
      };
    });
  }

  /**
   * Open target for an earnings-call row.
   * US: public SEC 8-K search. HK: HKEXnews (stock-scoped when known).
   * Never hit `/api/fmp?action=earning-call-transcript` — full paid text is not proxied.
   */
  function transcriptOpenUrl(ticker, year, quarter, date = null, lang = 'zh') {
    void year;
    void quarter;
    void date;
    if (/\.HK$/i.test(String(ticker || ''))) {
      return hkexSearchUrlFor(ticker, lang);
    }
    return edgarSearchUrl(ticker, '8-K');
  }

  return {
    edgarSearchUrl,
    edgarBrowseUrl,
    hkexStockCode,
    hkexLang,
    hkexNewsTitleSearchUrl,
    hkexQuoteUrl,
    withHkexNewsLang,
    hkexSearchUrlFor,
    rememberHkexSearch,
    publicLinks,
    normalizeFilings,
    normalizeTranscriptDates,
    isUsListed,
    loadFilings,
    loadHkexFilings,
    loadSecFilings,
    loadTranscriptDates,
    transcriptOpenUrl,
  };
}));
