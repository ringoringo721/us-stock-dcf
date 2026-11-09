'use strict';

const fs = require('node:fs');
const path = require('node:path');
const HkSmartMoney = require('../hk_smart_money.js');

/** In-memory TTL caches — best-effort on serverless; cuts repeat upstream hits. */
const cache = new Map();
const rateBuckets = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const FLOW_TTL_MS = 60 * 60 * 1000;
const SHORT_TTL_MS = 6 * 60 * 60 * 1000;
const DI_TTL_MS = 3 * 60 * 60 * 1000;
const DI_LIVE_LOOKBACK = 3;

function readSeed(symbol) {
  const ticker = String(symbol || '').toUpperCase();
  const candidates = [
    path.join(__dirname, '..', 'cache', 'hk-smart-money', `${ticker}.json`),
    path.join(process.cwd(), 'cache', 'hk-smart-money', `${ticker}.json`),
    path.join(process.cwd(), 'public', 'cache', 'hk-smart-money', `${ticker}.json`),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const body = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (body && typeof body === 'object') {
        return { ...body, source: body.source || 'seed', ticker };
      }
    } catch { /* ignore corrupt seed */ }
  }
  return null;
}

function clientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || req.headers?.['x-real-ip'] || 'unknown';
}

function rateLimited(req) {
  const key = clientIp(req);
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (rateBuckets.size > 4000) {
    for (const [id, entry] of rateBuckets) {
      if (now >= entry.resetAt) rateBuckets.delete(id);
    }
  }
  return bucket.count > RATE_MAX;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttlMs = DEFAULT_TTL_MS) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (cache.size > 200) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  return value;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchText(url, {
  fetcher = globalThis.fetch,
  method = 'GET',
  body = null,
  headers = {},
  timeoutMs = 25000,
} = {}) {
  const response = await fetcher(url, {
    method,
    body,
    headers: {
      'User-Agent': HkSmartMoney.USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`UPSTREAM_${response.status}`);
    err.status = response.status;
    err.body = text.slice(0, 200);
    throw err;
  }
  return text;
}

function grabHidden(html, name) {
  const byName = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`, 'i'));
  if (byName) return byName[1];
  const byId = html.match(new RegExp(`id="${name}"[^>]*value="([^"]*)"`, 'i'));
  return byId ? byId[1] : '';
}

async function fetchSouthboundSnapshot(dateIso, fetcher) {
  const cacheKey = `sb:${dateIso || 'latest'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = HkSmartMoney.SOUTHBOUND_URL;
  let html = await fetchText(url, { fetcher, timeoutMs: 35000 });
  const wantedSlash = dateIso ? HkSmartMoney.toSlashDate(dateIso) : null;
  const currentSlash = grabHidden(html, 'txtShareholdingDate');
  if (wantedSlash && wantedSlash !== currentSlash) {
    const params = new URLSearchParams({
      __EVENTTARGET: 'btnSearch',
      __EVENTARGUMENT: '',
      __VIEWSTATE: grabHidden(html, '__VIEWSTATE'),
      __VIEWSTATEGENERATOR: grabHidden(html, '__VIEWSTATEGENERATOR'),
      today: grabHidden(html, 'today'),
      sortBy: grabHidden(html, 'sortBy') || 'stockcode',
      sortDirection: grabHidden(html, 'sortDirection') || 'asc',
      originalShareholdingDate: grabHidden(html, 'originalShareholdingDate'),
      alertMsg: '',
      txtShareholdingDate: wantedSlash,
    });
    html = await fetchText(url, {
      fetcher,
      method: 'POST',
      body: params.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: url,
        Origin: 'https://www3.hkexnews.hk',
      },
      timeoutMs: 40000,
    });
  }
  const parsed = HkSmartMoney.parseSouthboundHtml(html);
  return cacheSet(cacheKey, parsed, DEFAULT_TTL_MS);
}

async function fetchDiEventsForCode(stockCode, fetcher, lookback = DI_LIVE_LOOKBACK) {
  const cacheKey = `di:${stockCode}:${lookback}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const days = HkSmartMoney.businessDaysBack(lookback);
  const events = [];
  const errors = [];
  // Sequential + short pause — polite to di.hkex.com.hk; keep lookback small on live path.
  for (const day of days) {
    for (const [cat, role] of [[1, 'substantial'], [2, 'director']]) {
      const dayKey = `di-day:${day}:C${cat}`;
      let dayEvents = cacheGet(dayKey);
      if (!dayEvents) {
        const url = HkSmartMoney.DI_SUMMARY_TMPL
          .replace('{date}', day.replace(/-/g, ''))
          .replace('{cat}', String(cat));
        try {
          const html = await fetchText(url, { fetcher, timeoutMs: 20000 });
          dayEvents = HkSmartMoney.parseDiSummaryHtml(html, role, day);
          cacheSet(dayKey, dayEvents, DI_TTL_MS);
          await sleep(80);
        } catch (error) {
          errors.push({ day, cat, error: error.message || String(error) });
          dayEvents = [];
        }
      }
      for (const event of dayEvents) {
        if (event.stock_code === stockCode) events.push(event);
      }
    }
  }
  events.sort((a, b) => String(b.event_date || '').localeCompare(String(a.event_date || '')));
  const payload = { events, errors };
  return cacheSet(cacheKey, payload, DI_TTL_MS);
}

async function fetchMarketFlow(fetcher) {
  const cached = cacheGet('flow');
  if (cached) return cached;
  const days = HkSmartMoney.businessDaysBack(5);
  let lastError = null;
  for (const day of days) {
    const url = HkSmartMoney.CSM_DAILY_TMPL.replace('{date}', day.replace(/-/g, ''));
    try {
      const text = await fetchText(url, {
        fetcher,
        headers: { Accept: 'application/javascript,text/plain,*/*' },
        timeoutMs: 20000,
      });
      const parsed = HkSmartMoney.parseCsmDailyJs(text);
      if (parsed.southbound?.length) return cacheSet('flow', parsed, FLOW_TTL_MS);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return cacheSet('flow', { as_of: null, southbound: [], net_buy_total: null }, FLOW_TTL_MS);
}

async function fetchShorts(fetcher) {
  const cached = cacheGet('shorts');
  if (cached) return cached;
  const page = await fetchText(HkSmartMoney.SFC_SHORTS_PAGE, { fetcher, timeoutMs: 30000 });
  const links = HkSmartMoney.extractSfcCsvLinks(page);
  if (!links.length) throw new Error('SFC_CSV_NOT_FOUND');
  const weeks = [];
  for (const link of links.slice(0, 2)) {
    const csv = await fetchText(link, {
      fetcher,
      headers: { Accept: 'text/csv,*/*' },
      timeoutMs: 30000,
    });
    weeks.push(HkSmartMoney.parseSfcShortCsv(csv));
    await sleep(80);
  }
  return cacheSet('shorts', weeks, SHORT_TTL_MS);
}

async function buildStockPayload(symbol, fetcher, { refresh = false } = {}) {
  const stockCode = HkSmartMoney.codeFromTicker(symbol);
  if (!stockCode) {
    const err = new Error('INVALID_SYMBOL');
    err.status = 400;
    throw err;
  }
  const ticker = HkSmartMoney.tickerFromCode(stockCode);
  const seed = readSeed(ticker);

  // Default: serve committed seed when present (Preview / cold-start safe).
  // Pass refresh=1 to force a polite live rebuild.
  if (seed && !refresh) {
    return {
      ...seed,
      ticker,
      stock_code: stockCode,
      source: seed.source || 'seed',
    };
  }

  const lookbacks = HkSmartMoney.businessDaysBack(6);
  const dateTargets = [...new Set([lookbacks[0], lookbacks[1]].filter(Boolean))];

  const history = [];
  const sbErrors = [];
  for (const day of dateTargets) {
    try {
      const snap = await fetchSouthboundSnapshot(day, fetcher);
      const row = snap.byCode?.[stockCode];
      if (row) {
        history.push({
          date: snap.as_of || day,
          shares: row.shares,
          pct: row.pct,
          name: row.name,
        });
      }
      await sleep(100);
    } catch (error) {
      sbErrors.push({ day, error: error.message || String(error) });
    }
  }
  if (seed?.southbound?.history?.length) {
    for (const row of seed.southbound.history) {
      if (row?.date && !history.some(item => item.date === row.date)) history.push(row);
    }
  }
  const byDate = new Map();
  for (const row of history) {
    if (!byDate.has(row.date)) byDate.set(row.date, row);
  }
  const southbound = HkSmartMoney.buildSouthboundForCode([...byDate.values()]);

  let di_events = seed?.di_events || [];
  let diErrors = [];
  try {
    const di = await fetchDiEventsForCode(stockCode, fetcher, DI_LIVE_LOOKBACK);
    if (di.events?.length) {
      const merged = new Map();
      for (const event of [...di.events, ...di_events]) {
        const key = `${event.serial || ''}|${event.event_date || ''}|${event.filer || ''}`;
        if (!merged.has(key)) merged.set(key, event);
      }
      di_events = [...merged.values()]
        .sort((a, b) => String(b.event_date || '').localeCompare(String(a.event_date || '')));
    }
    diErrors = di.errors || [];
  } catch (error) {
    diErrors = [{ error: error.message || String(error) }];
  }

  let short = seed?.short || null;
  let shortError = null;
  try {
    const weeks = await fetchShorts(fetcher);
    const current = weeks[0]?.byCode?.[stockCode] || null;
    const previous = weeks[1]?.byCode?.[stockCode] || null;
    const liveShort = HkSmartMoney.buildShortForCode(current, previous, southbound);
    if (liveShort) short = liveShort;
  } catch (error) {
    shortError = error.message || String(error);
  }

  let market_flow = seed?.market_flow || null;
  let flowError = null;
  try {
    market_flow = await fetchMarketFlow(fetcher);
  } catch (error) {
    flowError = error.message || String(error);
  }

  return {
    ticker,
    stock_code: stockCode,
    source: 'live',
    capturedAt: new Date().toISOString(),
    southbound,
    di_events,
    short,
    market_flow,
    notices: {
      zh: '資料來自 HKEX DI 每日摘要、HKEXnews 港股通南向持股、HKEX CSM 南向統計與 SFC 淡倉 CSV 之禮貌轉送；非投資建議。南向為通道合計，不是單一基金流入。',
      en: 'Polite relay of HKEX DI daily summaries, HKEXnews southbound shareholding, HKEX CSM southbound stats, and SFC short CSV. Not investment advice. Southbound is channel aggregate — not per-fund inflow.',
    },
    partialErrors: {
      southbound: sbErrors.length ? sbErrors : undefined,
      di: diErrors.length ? diErrors : undefined,
      short: shortError || undefined,
      flow: flowError || undefined,
    },
  };
}

function createHandler({ fetch: fetcher = globalThis.fetch } = {}) {
  return async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    const send = (status, value) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(405, { error: 'METHOD_NOT_ALLOWED' });
    }
    if (rateLimited(req)) return send(429, { error: 'RATE_LIMITED' });

    const query = new URL(req.url, 'http://localhost').searchParams;
    const action = query.get('action') || 'stock';
    const symbol = query.get('symbol');

    try {
      if (action === 'flow') {
        const flow = await fetchMarketFlow(fetcher);
        return send(200, { source: 'live', ...flow });
      }
      if (action === 'shorts') {
        const weeks = await fetchShorts(fetcher);
        return send(200, {
          source: 'live',
          as_of: weeks[0]?.as_of || null,
          prior_as_of: weeks[1]?.as_of || null,
          rows: weeks[0]?.rows || [],
        });
      }
      if (action === 'southbound') {
        const date = query.get('date');
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return send(400, { error: 'INVALID_DATE' });
        }
        const snap = await fetchSouthboundSnapshot(date || null, fetcher);
        const code = symbol ? HkSmartMoney.codeFromTicker(symbol) : null;
        if (code) {
          return send(200, {
            source: 'live',
            as_of: snap.as_of,
            row: snap.byCode?.[code] || null,
          });
        }
        return send(200, {
          source: 'live',
          as_of: snap.as_of,
          count: snap.rows.length,
          rows: snap.rows,
        });
      }
      if (action === 'di') {
        const code = HkSmartMoney.codeFromTicker(symbol);
        if (!code) return send(400, { error: 'INVALID_SYMBOL' });
        const di = await fetchDiEventsForCode(code, fetcher);
        return send(200, {
          source: 'live',
          stock_code: code,
          events: di.events,
          errors: di.errors,
        });
      }
      if (action === 'stock') {
        if (!symbol) return send(400, { error: 'INVALID_SYMBOL' });
        if (!/\.HK$/i.test(symbol) && !/^\d{1,5}$/.test(symbol)) {
          return send(400, { error: 'HK_SYMBOL_REQUIRED' });
        }
        const refresh = query.get('refresh') === '1' || query.get('refresh') === 'true';
        const payload = await buildStockPayload(symbol, fetcher, { refresh });
        return send(200, payload);
      }
      return send(400, { error: 'INVALID_ACTION' });
    } catch (error) {
      const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 502;
      console.error('HK smart money failed', {
        action,
        symbol,
        reason: error.message || String(error),
      });
      return send(status >= 500 ? 502 : status, {
        error: error.message || 'HK_SMART_MONEY_ERROR',
      });
    }
  };
}

const handler = createHandler();
handler.createHandler = createHandler;
module.exports = handler;
