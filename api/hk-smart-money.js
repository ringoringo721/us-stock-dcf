'use strict';

const fs = require('node:fs');
const path = require('node:path');
const HkSmartMoney = require('../hk_smart_money.js');

/** In-memory TTL caches — best-effort on serverless; cuts repeat upstream hits. */
const cache = new Map();
const rateBuckets = new Map();
const RATE_WINDOW_MS = 60_000;
/** Default budget for seed/stock hits. */
const RATE_MAX = 30;
/** Tight budget for live upstream scrapes (refresh / di / southbound / flow / shorts). */
const LIVE_RATE_MAX = 6;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const FLOW_TTL_MS = 60 * 60 * 1000;
const SHORT_TTL_MS = 6 * 60 * 60 * 1000;
const DI_TTL_MS = 3 * 60 * 60 * 1000;
const DI_LIVE_LOOKBACK = 3;
/** Live stock scrape: horizon Δ first, then sparse chart samples (serverless budget). */
const LIVE_SB_MAX_DATES = 28;
const LIVE_SB_CONCURRENCY = 5;

/** Only `NNNN.HK.json` under seed roots — reject `../` / absolute / odd symbols. */
function seedSafeBasename(symbol) {
  const code = HkSmartMoney.codeFromTicker(symbol);
  // Internal codes are 1–5 digits (HKEX often 5 with leading zeros); filenames use 4-digit tickers.
  if (!code || !/^\d{1,5}$/.test(code)) return null;
  const ticker = HkSmartMoney.tickerFromCode(code);
  if (!ticker || !/^\d{4}\.HK$/i.test(ticker) || /[\\/]/.test(ticker)) return null;
  return `${ticker}.json`;
}

function seedRoots() {
  return [
    path.join(__dirname, '..', 'cache', 'hk-smart-money'),
    path.join(process.cwd(), 'cache', 'hk-smart-money'),
    path.join(process.cwd(), 'public', 'cache', 'hk-smart-money'),
  ];
}

function readJsonUnderSeedRoots(basename) {
  if (!basename || /[\\/]/.test(basename)) return null;
  for (const root of seedRoots()) {
    const rootResolved = path.resolve(root);
    const file = path.resolve(rootResolved, basename);
    if (file !== path.join(rootResolved, basename)) continue;
    try {
      if (!fs.existsSync(file)) continue;
      const body = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (body && typeof body === 'object') return body;
    } catch { /* ignore corrupt */ }
  }
  return null;
}

/** Market-level CSM seed (shared by every stock) — carries dense net_cum_* history. */
function readMarketFlowSeed() {
  const raw = readJsonUnderSeedRoots('market-flow.json');
  if (!raw) return null;
  if (!Array.isArray(raw.history) || !raw.history.length) {
    return {
      ...raw,
      source: raw.source || 'seed',
      turnover_unit: raw.turnover_unit || 'HKD_million',
    };
  }
  const rebuilt = HkSmartMoney.buildMarketFlowFromHistory(raw.history);
  return {
    ...rebuilt,
    source: raw.source || 'seed',
    as_of: raw.as_of || rebuilt.as_of,
    turnover_unit: raw.turnover_unit || rebuilt.turnover_unit || 'HKD_million',
    southbound: Array.isArray(raw.southbound) && raw.southbound.length
      ? raw.southbound
      : rebuilt.southbound,
    net_buy_total: raw.net_buy_total != null ? raw.net_buy_total : rebuilt.net_buy_total,
  };
}

function readSeed(symbol) {
  const basename = seedSafeBasename(symbol);
  if (!basename) return null;
  const body = readJsonUnderSeedRoots(basename);
  if (!body) return null;
  return {
    ...body,
    source: body.source || 'seed',
    ticker: body.ticker || basename.replace(/\.json$/i, ''),
    di_events: HkSmartMoney.normalizeDiEvents(body.di_events || []),
    southbound: body.southbound
      ? HkSmartMoney.buildSouthboundForCode(body.southbound.history || [{
        date: body.southbound.as_of,
        shares: body.southbound.shares,
        pct: body.southbound.pct,
        name: body.southbound.name,
      }])
      : body.southbound,
    market_flow: (() => {
      const raw = body.market_flow;
      if (!raw || !Array.isArray(raw.history) || !raw.history.length) return raw || null;
      const rebuilt = HkSmartMoney.buildMarketFlowFromHistory(raw.history);
      return {
        ...rebuilt,
        as_of: raw.as_of || rebuilt.as_of,
        turnover_unit: raw.turnover_unit || rebuilt.turnover_unit || 'HKD_million',
        southbound: Array.isArray(raw.southbound) && raw.southbound.length
          ? raw.southbound
          : rebuilt.southbound,
        net_buy_total: raw.net_buy_total != null ? raw.net_buy_total : rebuilt.net_buy_total,
      };
    })(),
  };
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) || 1 }, () => run());
  await Promise.all(runners);
  return results;
}

/**
 * Prefer Vercel `x-real-ip`. For X-Forwarded-For, use the rightmost hop
 * (appended by the platform) so clients cannot mint buckets via spoofed left values.
 */
function clientIp(req) {
  const real = req.headers?.['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const parts = forwarded.split(',').map(part => part.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
}

function rateLimited(req, { live = false } = {}) {
  const key = `${clientIp(req)}:${live ? 'live' : 'std'}`;
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
  return bucket.count > (live ? LIVE_RATE_MAX : RATE_MAX);
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
  const payload = {
    events: HkSmartMoney.normalizeDiEvents(events),
    errors,
  };
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
  const seed = readSeed(ticker) || readSeed(symbol);

  // Default: serve committed seed when present (Preview / cold-start safe).
  if (seed && !refresh) {
    return {
      ...seed,
      ticker,
      stock_code: stockCode,
      source: seed.source || 'seed',
    };
  }

  // Live path: probe latest SB as_of, then fetch horizon-critical + weekly chart dates
  // (same plan as capture seeds) so unseeded names get ICBC-style Δ series — not just 1D.
  const history = [];
  const sbErrors = [];
  let asOf = null;
  const probeDays = HkSmartMoney.businessDaysBack(8);
  for (const day of probeDays) {
    try {
      const snap = await fetchSouthboundSnapshot(day, fetcher);
      if (snap?.rows?.length || Object.keys(snap?.byCode || {}).length) {
        asOf = snap.as_of || day;
        const row = snap.byCode?.[stockCode];
        if (row) {
          history.push({
            date: asOf,
            shares: row.shares,
            pct: row.pct,
            name: row.name,
          });
        }
        break;
      }
    } catch (error) {
      sbErrors.push({ day, error: error.message || String(error) });
    }
    await sleep(40);
  }
  if (!asOf) asOf = probeDays[0];

  const dateTargets = HkSmartMoney.planSouthboundHistoryDates(asOf, {
    mode: 'horizons',
    maxDates: LIVE_SB_MAX_DATES,
    weeklyBizSpan: 180,
    weeklyStep: 12,
  }).filter(day => day !== asOf);

  const fetched = await mapPool(dateTargets, LIVE_SB_CONCURRENCY, async (day) => {
    try {
      const snap = await fetchSouthboundSnapshot(day, fetcher);
      const row = snap.byCode?.[stockCode];
      if (!row) return { day, row: null };
      return {
        day,
        row: {
          date: snap.as_of || day,
          shares: row.shares,
          pct: row.pct,
          name: row.name,
        },
      };
    } catch (error) {
      return { day, error: error.message || String(error) };
    }
  });
  for (const item of fetched) {
    if (item?.error) sbErrors.push({ day: item.day, error: item.error });
    if (item?.row) history.push(item.row);
  }

  if (seed?.southbound?.history?.length) {
    for (const row of seed.southbound.history) {
      const date = HkSmartMoney.normalizeIsoDate(row.date) || row.date;
      if (date && !history.some(item => (HkSmartMoney.normalizeIsoDate(item.date) || item.date) === date)) {
        history.push({ ...row, date });
      }
    }
  }
  const byDate = new Map();
  for (const row of history) {
    const date = HkSmartMoney.normalizeIsoDate(row.date) || row.date;
    if (!byDate.has(date)) byDate.set(date, { ...row, date });
  }
  const southbound = HkSmartMoney.buildSouthboundForCode([...byDate.values()]);

  let di_events = HkSmartMoney.normalizeDiEvents(seed?.di_events || []);
  let diErrors = [];
  try {
    const di = await fetchDiEventsForCode(stockCode, fetcher, DI_LIVE_LOOKBACK);
    di_events = HkSmartMoney.normalizeDiEvents([...(di.events || []), ...di_events]);
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

  // Market flow is market-level: prefer committed market-flow.json history (net_cum_*),
  // overlay latest SSE/SZSE boxes from a shallow live CSM hit when available.
  let market_flow = readMarketFlowSeed() || seed?.market_flow || null;
  let flowError = null;
  try {
    const liveFlow = await fetchMarketFlow(fetcher);
    if (liveFlow?.southbound?.length) {
      if (market_flow && Array.isArray(market_flow.history) && market_flow.history.length) {
        market_flow = {
          ...market_flow,
          as_of: liveFlow.as_of || market_flow.as_of,
          southbound: liveFlow.southbound,
          net_buy_total: liveFlow.net_buy_total != null
            ? liveFlow.net_buy_total
            : market_flow.net_buy_total,
          turnover_unit: liveFlow.turnover_unit || market_flow.turnover_unit || 'HKD_million',
        };
      } else {
        market_flow = { source: 'live', ...liveFlow };
      }
    }
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

    const send = (status, value, cacheMode = 'no-store') => {
      if (cacheMode === 'public-seed') {
        res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
      } else if (cacheMode === 'private-live') {
        res.setHeader('Cache-Control', 'private, max-age=60');
      } else {
        res.setHeader('Cache-Control', 'no-store');
      }
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };

    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(405, { error: 'METHOD_NOT_ALLOWED' });
    }

    const query = new URL(req.url, 'http://localhost').searchParams;
    const action = query.get('action') || 'stock';
    const symbol = query.get('symbol');
    const refresh = query.get('refresh') === '1' || query.get('refresh') === 'true';

    /** Charge the tight live budget only when we are about to hit upstream. */
    const requireLiveBudget = () => {
      if (rateLimited(req, { live: true })) {
        send(429, { error: 'RATE_LIMITED' }, 'no-store');
        return false;
      }
      return true;
    };

    try {
      if (action === 'flow') {
        const seedFlow = !refresh ? readMarketFlowSeed() : null;
        if (seedFlow) {
          if (rateLimited(req, { live: false })) return send(429, { error: 'RATE_LIMITED' }, 'no-store');
          return send(200, { ...seedFlow, source: 'seed' }, 'public-seed');
        }
        if (!refresh) {
          if (rateLimited(req, { live: false })) return send(429, { error: 'RATE_LIMITED' }, 'no-store');
          return send(200, {
            source: 'empty',
            as_of: null,
            southbound: [],
            net_buy_total: null,
            notice: 'HK_SMART_MONEY_NO_SEED',
          }, 'no-store');
        }
        if (!requireLiveBudget()) return;
        const flow = await fetchMarketFlow(fetcher);
        return send(200, { source: 'live', ...flow }, 'private-live');
      }
      if (action === 'shorts') {
        if (!symbol) return send(400, { error: 'INVALID_SYMBOL' }, 'no-store');
        const code = HkSmartMoney.codeFromTicker(symbol);
        if (!code) return send(400, { error: 'INVALID_SYMBOL' }, 'no-store');
        const seed = readSeed(symbol);
        if (seed?.short && !refresh) {
          if (rateLimited(req, { live: false })) return send(429, { error: 'RATE_LIMITED' }, 'no-store');
          return send(200, {
            source: 'seed',
            as_of: seed.short.as_of || null,
            row: seed.short,
          }, 'public-seed');
        }
        if (!refresh) {
          if (rateLimited(req, { live: false })) return send(429, { error: 'RATE_LIMITED' }, 'no-store');
          return send(200, {
            source: 'empty',
            as_of: null,
            row: null,
            notice: 'HK_SMART_MONEY_NO_SEED',
          }, 'no-store');
        }
        if (!requireLiveBudget()) return;
        const weeks = await fetchShorts(fetcher);
        const current = weeks[0]?.byCode?.[code] || null;
        const previous = weeks[1]?.byCode?.[code] || null;
        // Match seed shape (as_of / pct_of_issued / shares_chg_wow), not raw CSV columns.
        const southbound = readSeed(symbol)?.southbound || null;
        const row = HkSmartMoney.buildShortForCode(current, previous, southbound);
        return send(200, {
          source: 'live',
          as_of: row?.as_of || weeks[0]?.as_of || null,
          prior_as_of: weeks[1]?.as_of || null,
          row,
        }, 'private-live');
      }
      if (action === 'southbound') {
        if (!symbol) return send(400, { error: 'SYMBOL_REQUIRED' }, 'no-store');
        const date = query.get('date');
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return send(400, { error: 'INVALID_DATE' }, 'no-store');
        }
        const code = HkSmartMoney.codeFromTicker(symbol);
        if (!code) return send(400, { error: 'INVALID_SYMBOL' }, 'no-store');
        const seed = readSeed(symbol);
        if (seed?.southbound && !refresh && !date) {
          if (rateLimited(req, { live: false })) return send(429, { error: 'RATE_LIMITED' }, 'no-store');
          return send(200, {
            source: 'seed',
            as_of: seed.southbound.as_of,
            row: {
              stock_code: code,
              shares: seed.southbound.shares,
              pct: seed.southbound.pct,
              name: seed.southbound.name,
            },
          }, 'public-seed');
        }
        if (!refresh) {
          if (rateLimited(req, { live: false })) return send(429, { error: 'RATE_LIMITED' }, 'no-store');
          return send(200, {
            source: 'empty',
            as_of: null,
            row: null,
            notice: 'HK_SMART_MONEY_NO_SEED',
          }, 'no-store');
        }
        if (!requireLiveBudget()) return;
        const snap = await fetchSouthboundSnapshot(date || null, fetcher);
        return send(200, {
          source: 'live',
          as_of: snap.as_of,
          row: snap.byCode?.[code] || null,
        }, 'private-live');
      }
      if (action === 'di') {
        const code = HkSmartMoney.codeFromTicker(symbol);
        if (!code) return send(400, { error: 'INVALID_SYMBOL' }, 'no-store');
        const seed = readSeed(symbol);
        if (seed?.di_events && !refresh) {
          if (rateLimited(req, { live: false })) return send(429, { error: 'RATE_LIMITED' }, 'no-store');
          return send(200, {
            source: 'seed',
            stock_code: code,
            events: seed.di_events,
          }, 'public-seed');
        }
        if (!refresh) {
          if (rateLimited(req, { live: false })) return send(429, { error: 'RATE_LIMITED' }, 'no-store');
          return send(200, {
            source: 'empty',
            stock_code: code,
            events: [],
            notice: 'HK_SMART_MONEY_NO_SEED',
          }, 'no-store');
        }
        if (!requireLiveBudget()) return;
        const di = await fetchDiEventsForCode(code, fetcher);
        return send(200, {
          source: 'live',
          stock_code: code,
          events: di.events,
          errors: di.errors,
        }, 'private-live');
      }
      if (action === 'stock') {
        if (!symbol) return send(400, { error: 'INVALID_SYMBOL' }, 'no-store');
        if (!/\.HK$/i.test(symbol) && !/^\d{1,5}$/.test(symbol)) {
          return send(400, { error: 'HK_SYMBOL_REQUIRED' }, 'no-store');
        }
        // Seed short-circuit under standard budget (no upstream).
        const seed = readSeed(symbol);
        if (seed && !refresh) {
          if (rateLimited(req, { live: false })) return send(429, { error: 'RATE_LIMITED' }, 'no-store');
          const stockCode = HkSmartMoney.codeFromTicker(symbol);
          return send(200, {
            ...seed,
            ticker: HkSmartMoney.tickerFromCode(stockCode) || seed.ticker,
            stock_code: stockCode,
            source: seed.source || 'seed',
          }, 'public-seed');
        }
        // Unseeded (or explicit refresh): live-scrape under the tight budget so every
        // Connect-eligible .HK stock can populate — not only committed seeds.
        if (!requireLiveBudget()) return;
        const payload = await buildStockPayload(symbol, fetcher, { refresh: true });
        return send(200, payload, 'private-live');
      }
      return send(400, { error: 'INVALID_ACTION' }, 'no-store');
    } catch (error) {
      const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 502;
      console.error('HK smart money failed', {
        action,
        symbol,
        reason: error.message || String(error),
      });
      return send(status >= 500 ? 502 : status, {
        error: error.message || 'HK_SMART_MONEY_ERROR',
      }, 'no-store');
    }
  };
}

const handler = createHandler();
handler.createHandler = createHandler;
handler.resetCachesForTests = function resetCachesForTests() {
  cache.clear();
  rateBuckets.clear();
};
module.exports = handler;
