/**
 * HKEXNEWS title-search proxy for HK filings / documents.
 * Does not use SEC EDGAR. Lookup stockId via HKEX active-stock list, then
 * titleSearchServlet for Financial Statements / ESG (t1code 40000) plus
 * quarterly results announcements (t1code 10000, filtered).
 * `lang=zh|en` selects Traditional Chinese vs English HKEXnews labels/titles
 * (servlet expects lang=zh for Chinese — lang=C is NOT Chinese).
 */
'use strict';

const HOST = 'https://www1.hkexnews.hk';
const SESSION_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; us-stock-dcf-hkexnews)',
  Accept: 'application/json,text/plain,*/*',
};

const documentRateBuckets = new Map();
const DOCUMENT_RATE_WINDOW_MS = 60_000;
const DOCUMENT_RATE_MAX = 40;

/** Cache active-stock lookup briefly — list is large but stable within a day. */
let activeStockCache = { at: 0, byCode: null };
const ACTIVE_STOCK_TTL_MS = 6 * 60 * 60 * 1000;

function clientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || req.headers?.['x-real-ip'] || 'unknown';
}

function rateLimited(req) {
  const key = `${clientIp(req)}:hkex-filings`;
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
  return bucket.count > DOCUMENT_RATE_MAX;
}

function hkexStockCode(symbol) {
  const match = String(symbol || '').trim().toUpperCase().match(/^(\d{4,5})\.HK$/);
  return match ? match[1].padStart(5, '0') : null;
}

/** Map UI locale → HKEXnews servlet lang (zh for Trad. Chinese; E for English). */
function hkexServletLang(lang) {
  return String(lang || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'E';
}

function toHkexDate(isoOrDigits) {
  const raw = String(isoOrDigits || '').trim();
  if (/^\d{8}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw.replaceAll('-', '');
  return null;
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseFilingDate(dateTime) {
  const match = String(dateTime || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function formFromLongText(longText) {
  const decoded = decodeEntities(longText);
  const bracket = decoded.match(/\[([^\]]+)\]/);
  if (bracket) return bracket[1].replace(/\s*\/\s*/g, '/').trim();
  const dash = decoded.split(' - ').pop();
  return (dash || decoded || 'HKEX filing').trim();
}

/** Quarterly results / 季度業績 filings (exclude AGM poll results & briefing invites). */
function isQuarterlyResultsRow(row) {
  const long = decodeEntities(row?.LONG_TEXT || row?.SHORT_TEXT || '');
  const title = decodeEntities(row?.TITLE || '');
  if (/Results of\s+(AGM|EGM|SGM)|股東大會|說明會|Convening|Results Release/i.test(`${long} ${title}`)) {
    return false;
  }
  if (/\[(?:季度業績|Quarterly Results)/i.test(long)) return true;
  if (/季度報告|Quarterly Report|第[一二三四]季度報告/i.test(title)) return true;
  return false;
}

function normalizeFiling(row, ticker) {
  if (!row || typeof row !== 'object') return null;
  const relative = String(row.FILE_LINK || '').trim();
  if (!relative.startsWith('/')) return null;
  const title = decodeEntities(row.TITLE || '');
  const form = formFromLongText(row.LONG_TEXT || row.SHORT_TEXT || '');
  const filingDate = parseFilingDate(row.DATE_TIME);
  return {
    kind: 'filing',
    ticker,
    form: form || 'HKEX filing',
    filingDate,
    acceptedDate: null,
    title: title || form || 'HKEX filing',
    link: `${HOST}${relative}`,
    source: 'HKEXNEWS',
  };
}

function mergeFilings(statementRows, quarterlyRows, ticker, limit) {
  const byLink = new Map();
  for (const row of [...statementRows, ...quarterlyRows]) {
    const normalized = normalizeFiling(row, ticker);
    if (!normalized?.link) continue;
    if (!byLink.has(normalized.link)) byLink.set(normalized.link, normalized);
  }
  return [...byLink.values()]
    .sort((a, b) => String(b.filingDate || '').localeCompare(String(a.filingDate || '')))
    .slice(0, limit);
}

async function loadActiveStocks(fetcher) {
  const now = Date.now();
  if (activeStockCache.byCode && now - activeStockCache.at < ACTIVE_STOCK_TTL_MS) {
    return activeStockCache.byCode;
  }
  const response = await fetcher(`${HOST}/ncms/script/eds/activestock_sehk_e.json`, {
    headers: SESSION_HEADERS,
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  });
  if (!response.ok) {
    const error = new Error('HKEX_ACTIVE_STOCK_UPSTREAM');
    error.status = response.status;
    throw error;
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('HKEX_ACTIVE_STOCK_INVALID');
  const byCode = new Map();
  for (const row of rows) {
    if (row?.c != null && row?.i != null) byCode.set(String(row.c).padStart(5, '0'), row);
  }
  activeStockCache = { at: now, byCode };
  return byCode;
}

function buildTitleSearchUrl({ stockId, fromDigits, toDigits, t1code, lang, title = '' }) {
  const searchUrl = new URL(`${HOST}/search/titleSearchServlet.do`);
  for (const [name, value] of Object.entries({
    sortDir: '0',
    sortByOptions: 'DateTime',
    category: '0',
    market: 'SEHK',
    stockId: String(stockId),
    documentType: '-1',
    fromDate: fromDigits,
    toDate: toDigits,
    title: String(title || ''),
    searchType: '1',
    t1code: String(t1code),
    t2Gcode: '-2',
    t2code: '-2',
    lang,
  })) searchUrl.searchParams.set(name, value);
  return searchUrl;
}

async function fetchTitleSearch(fetcher, params) {
  const searchUrl = buildTitleSearchUrl(params);
  let upstream;
  try {
    upstream = await fetcher(searchUrl, {
      headers: SESSION_HEADERS,
      signal: AbortSignal.timeout(25000),
      redirect: 'error',
    });
  } catch (error) {
    const timeout = ['TimeoutError', 'AbortError'].includes(error.name);
    const wrapped = new Error(timeout ? 'HKEX_TIMEOUT' : 'HKEX_NETWORK_ERROR');
    wrapped.cause = error;
    throw wrapped;
  }
  if (!upstream.ok) {
    const wrapped = new Error('HKEX_UPSTREAM_ERROR');
    wrapped.upstreamStatus = upstream.status;
    throw wrapped;
  }
  let payload;
  try { payload = await upstream.json(); }
  catch {
    throw new Error('HKEX_INVALID_RESPONSE');
  }
  let rawRows;
  try {
    rawRows = JSON.parse(payload?.result || '[]');
  } catch {
    throw new Error('HKEX_INVALID_RESPONSE');
  }
  if (!Array.isArray(rawRows)) throw new Error('HKEX_INVALID_RESPONSE');
  return rawRows;
}

function createHandler({ fetch: fetcher = globalThis.fetch } = {}) {
  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    const send = (status, value) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(405, { error: 'METHOD_NOT_ALLOWED' });
    }
    if (rateLimited(req)) {
      res.setHeader('Retry-After', '60');
      return send(429, { error: 'DOCUMENT_RATE_LIMITED' });
    }
    const query = new URL(req.url, 'http://localhost').searchParams;
    const action = query.get('action');
    const symbol = query.get('symbol');
    const allowedKeys = new Set(['action', 'symbol', 'from', 'to', 'limit', 'lang']);
    if (action !== 'filings'
        || !hkexStockCode(symbol)
        || [...new Set(query.keys())].some(key => query.getAll(key).length !== 1)
        || [...query.keys()].some(key => !allowedKeys.has(key))) {
      return send(400, { error: 'INVALID_REQUEST' });
    }
    const code = hkexStockCode(symbol);
    const limitRaw = query.get('limit') || '40';
    if (!/^\d{1,3}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 100) {
      return send(400, { error: 'INVALID_LIMIT' });
    }
    const limit = Number(limitRaw);
    const langParam = query.get('lang') || 'zh';
    if (!/^(zh|en)$/i.test(langParam)) return send(400, { error: 'INVALID_LANG' });
    const servletLang = hkexServletLang(langParam);
    const toDigits = toHkexDate(query.get('to'))
      || new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const fromDigits = toHkexDate(query.get('from')) || (() => {
      const end = new Date(`${toDigits.slice(0, 4)}-${toDigits.slice(4, 6)}-${toDigits.slice(6, 8)}T00:00:00Z`);
      end.setUTCFullYear(end.getUTCFullYear() - 5);
      return end.toISOString().slice(0, 10).replaceAll('-', '');
    })();
    if (fromDigits > toDigits) return send(400, { error: 'INVALID_DATE_RANGE' });

    let security;
    try {
      const byCode = await loadActiveStocks(fetcher);
      security = byCode.get(code);
    } catch (error) {
      const timeout = ['TimeoutError', 'AbortError'].includes(error.name)
        || error.message === 'HKEX_TIMEOUT';
      console.error('HKEX active-stock lookup failed', { symbol, reason: timeout ? 'timeout' : error.message });
      return send(timeout ? 504 : 502, {
        error: timeout ? 'HKEX_TIMEOUT' : 'HKEX_ACTIVE_STOCK_ERROR',
      });
    }
    if (!security) return send(404, { error: 'HKEX_STOCK_NOT_FOUND', symbol, code });

    const shared = {
      stockId: security.i,
      fromDigits,
      toDigits,
      lang: servletLang,
    };
    // Keyword search recovers older 季度業績 when the unfiltered announcements
    // page (≤100) buries them — Tencent often has 0 hits on 季度, so keep both.
    const quarterlyTitle = servletLang === 'zh' ? '季度' : 'Quarterly';
    let statementRows;
    let announcementRows;
    let titledQuarterlyRows;
    try {
      [statementRows, announcementRows, titledQuarterlyRows] = await Promise.all([
        fetchTitleSearch(fetcher, { ...shared, t1code: '40000', title: '' }),
        fetchTitleSearch(fetcher, { ...shared, t1code: '10000', title: '' }),
        fetchTitleSearch(fetcher, { ...shared, t1code: '10000', title: quarterlyTitle }),
      ]);
    } catch (error) {
      const timeout = error.message === 'HKEX_TIMEOUT';
      console.error('HKEX title search failed', { symbol, reason: error.message });
      return send(timeout ? 504 : 502, {
        error: error.message || 'HKEX_NETWORK_ERROR',
        ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
      });
    }

    const quarterlyRows = [...announcementRows, ...titledQuarterlyRows]
      .filter(isQuarterlyResultsRow);
    const data = mergeFilings(statementRows, quarterlyRows, symbol, limit);

    // stockId only — client sets titlesearch.xhtml lang=zh|en from UI locale.
    const publicSearchUrl = `${HOST}/search/titlesearch.xhtml?stockId=${encodeURIComponent(String(security.i))}`;
    return send(200, {
      data,
      source: {
        provider: 'HKEXNEWS',
        endpoint: 'search/titleSearchServlet.do',
        symbol,
        stockCode: code,
        stockId: String(security.i),
        stockName: security.n || null,
        searchUrl: publicSearchUrl,
        lang: servletLang,
        t1codes: ['40000', '10000'],
        includesQuarterlyResults: true,
        from: fromDigits,
        to: toDigits,
        capturedAt: new Date().toISOString(),
      },
    });
  };
}

function resetActiveStockCacheForTests() {
  activeStockCache = { at: 0, byCode: null };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.hkexStockCode = hkexStockCode;
module.exports.hkexServletLang = hkexServletLang;
module.exports.normalizeFiling = normalizeFiling;
module.exports.parseFilingDate = parseFilingDate;
module.exports.decodeEntities = decodeEntities;
module.exports.isQuarterlyResultsRow = isQuarterlyResultsRow;
module.exports.mergeFilings = mergeFilings;
module.exports.resetActiveStockCacheForTests = resetActiveStockCacheForTests;
