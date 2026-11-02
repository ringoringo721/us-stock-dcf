/**
 * Company filings / documents helpers (TradingView Documents tab).
 * Prefer FMP SEC filings + transcript dates; always expose public SEC EDGAR
 * search links so Preview without FMP_API_KEY still opens statements immediately.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanyDocuments = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

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
    const market = String(stock?.calculationCurrency || stock?.exchange || '').toUpperCase();
    if (/\.HK$/.test(String(stock?.ticker || ''))) return false;
    if (market === 'HKD' || /HKEX|HONG KONG/i.test(String(stock?.exchange || ''))) return false;
    return true;
  }

  function publicLinks(ticker, stock = null) {
    const links = [];
    if (isUsListed(stock || { ticker })) {
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
    }
    return links;
  }

  function loadFilings(ticker, options = {}) {
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
        source: body?.source?.provider || 'FMP',
        rows: normalizeFilings(rows, ticker),
      };
    });
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

  /** URL that immediately fetches one transcript via our proxy (open in new tab). */
  function transcriptOpenUrl(ticker, year, quarter) {
    const qs = new URLSearchParams({
      action: 'earning-call-transcript',
      symbol: ticker,
      year: String(year),
      quarter: String(quarter),
    });
    return `/api/fmp?${qs}`;
  }

  return {
    edgarSearchUrl,
    edgarBrowseUrl,
    publicLinks,
    normalizeFilings,
    normalizeTranscriptDates,
    isUsListed,
    loadFilings,
    loadTranscriptDates,
    transcriptOpenUrl,
  };
}));
