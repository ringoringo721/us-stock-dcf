/**
 * HK Smart Money — DI (substantial + director), Southbound shareholding,
 * market-level Stock Connect southbound flow, and SFC weekly short positions.
 * Deliberately not a 13F / fund-book clone.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HkSmartMoney = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const DI_LOOKBACK_DAYS = 8;
  const SOUTHBOUND_URL = 'https://www3.hkexnews.hk/sdw/search/mutualmarket.aspx?t=hk';
  const DI_SUMMARY_TMPL = 'https://di.hkex.com.hk/di/summary/DSM{date}C{cat}.htm';
  const CSM_DAILY_TMPL = 'https://www.hkex.com.hk/eng/csm/DailyStat/data_tab_daily_{date}e.js';
  const SFC_SHORTS_PAGE = 'https://www.sfc.hk/en/Regulatory-functions/Market/Short-position-reporting/Aggregated-reportable-short-positions-of-specified-shares';
  const USER_AGENT = 'Mozilla/5.0 (compatible; USStockDCF/1.0; +https://github.com/ringoringo721/us-stock-dcf)';

  function finite(value) {
    if (value == null || value === '') return null;
    const n = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function padStockCode(value) {
    const digits = String(value == null ? '' : value).replace(/\D/g, '');
    if (!digits) return null;
    return digits.padStart(5, '0').slice(-5);
  }

  /**
   * App tickers are 4-digit `.HK` (0700.HK, 0005.HK). Rare natural 5-digit
   * codes (e.g. 87001.HK) keep five digits. Never emit `700.HK` or `00700.HK`.
   */
  function tickerFromCode(code) {
    const digits = String(code == null ? '' : code).replace(/\D/g, '');
    if (!digits) return null;
    const natural = digits.replace(/^0+/, '') || '0';
    if (natural.length >= 5) return `${natural.padStart(5, '0').slice(-5)}.HK`;
    return `${natural.padStart(4, '0').slice(-4)}.HK`;
  }

  function codeFromTicker(ticker) {
    const raw = String(ticker || '');
    const m = raw.match(/^(\d{1,5})(?:\.HK)?$/i);
    if (m) return padStockCode(m[1]);
    return padStockCode(raw);
  }

  function normalizeIsoDate(value) {
    if (value == null || value === '') return null;
    const raw = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    return parseDdMmYyyy(raw) || parseSlashDate(raw) || null;
  }

  function deriveDiAction(event) {
    if (event?.action) return event.action;
    const beforePct = finite(event?.before_pct);
    const afterPct = finite(event?.after_pct);
    if (beforePct == null && afterPct != null) return 'new';
    if (beforePct != null && afterPct == null) return 'exited';
    if (beforePct != null && afterPct != null) {
      if (afterPct > beforePct + 1e-9) return 'added';
      if (afterPct < beforePct - 1e-9) return 'reduced';
    }
    return 'held';
  }

  function normalizeDiEvent(event) {
    if (!event || typeof event !== 'object') return null;
    const event_date = normalizeIsoDate(event.event_date) || event.event_date || null;
    return {
      ...event,
      stock_code: padStockCode(event.stock_code) || event.stock_code || null,
      event_date,
      summary_date: normalizeIsoDate(event.summary_date) || event.summary_date || null,
      action: deriveDiAction({ ...event, event_date }),
    };
  }

  function normalizeDiEvents(events) {
    const merged = new Map();
    for (const raw of events || []) {
      const event = normalizeDiEvent(raw);
      if (!event) continue;
      const key = event.serial
        ? String(event.serial)
        : `${event.event_date || ''}|${event.filer || ''}|${event.reason_code || ''}`;
      if (!merged.has(key)) merged.set(key, event);
    }
    return [...merged.values()].sort((a, b) => {
      const da = normalizeIsoDate(a.event_date) || '';
      const db = normalizeIsoDate(b.event_date) || '';
      if (da !== db) return db.localeCompare(da);
      return String(b.serial || '').localeCompare(String(a.serial || ''));
    });
  }

  function isHkListed(stock) {
    const ticker = String(stock?.ticker || stock?.symbol || '');
    if (/\.HK$/i.test(ticker)) return true;
    if (String(stock?.calculationCurrency || '').toUpperCase() === 'HKD') return true;
    if (/HKEX|HONG KONG/i.test(String(stock?.exchange || ''))) return true;
    if (String(stock?.market || '').toUpperCase() === 'HKEX') return true;
    return false;
  }

  function stripHtml(value) {
    return String(value == null ? '' : value)
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseDdMmYyyy(value) {
    const m = String(value || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    return `${m[3]}-${m[2]}-${m[1]}`;
  }

  function parseSlashDate(value) {
    const m = String(value || '').trim().match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    if (!m) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
  }

  function toSlashDate(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return `${m[1]}/${m[2]}/${m[3]}`;
  }

  function businessDaysBack(count, endDate) {
    const out = [];
    const cursor = endDate ? new Date(`${endDate}T00:00:00Z`) : new Date();
    cursor.setUTCHours(0, 0, 0, 0);
    while (out.length < count) {
      const day = cursor.getUTCDay();
      if (day !== 0 && day !== 6) out.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    return out;
  }

  function parseShareToken(text) {
    const m = String(text || '').match(/([\d,]+)\s*\(([LSP])\)/i);
    if (!m) return { shares: null, position: null };
    return { shares: finite(m[1]), position: m[2].toUpperCase() };
  }

  function parseBalanceTable(html) {
    const cells = [...String(html || '').matchAll(/align=['"]right['"]>([^<]+)/gi)].map(m => m[1].trim());
    if (!cells.length) return { shares: null, pct: null, position: null };
    const token = parseShareToken(cells[0]);
    return {
      shares: token.shares,
      position: token.position,
      pct: finite(cells[1]),
    };
  }

  /** Parse one DI daily-summary HTML (C1 substantial or C2 director). */
  function parseDiSummaryHtml(html, role, summaryDate) {
    const events = [];
    const parts = String(html || '').split(/(?=<TR bgColor="#(?:cccccc|ffffff)">)/i);
    for (const part of parts.slice(1)) {
      if (!/NSForm/i.test(part)) continue;
      const form = part.match(/href="(\/di\/NSForm[^"]+)"[^>]*>([^<]+)<\/a>/i);
      if (!form) continue;
      const codeMatch = part.match(/<TD class="txt" width="52"[^>]*>(\d{4,5})<\/TD>/i);
      if (!codeMatch) continue;
      const corp = part.match(/NSSrchCorpList[^>]*>([^<]*)<\/a>/i);
      const filer = part.match(/NSSrchPersonList[^>]*>([^<]*)<\/a>/i);
      const eventDate = part.match(/NSForm[^>]+>(\d{2}\/\d{2}\/\d{4})<\/a>/i);
      const reason = part.match(/NSStdCode\.htm\?ft=[^#"']+#(\d+)/i);
      const position = part.match(/#\d+['"][^>]*>\d+<\/a>\(([LSP])\)/i);
      const involved = part.match(/>([\d,]+)\(([LSP])\)\s*<br/i);
      const price = part.match(/HKD\s*([\d.]+)/i);
      const tables = [...part.matchAll(/<TABLE cellSpacing=['"]0['"][\s\S]*?<\/TABLE>/gi)].map(m => m[0]);
      const before = parseBalanceTable(tables[0] || '');
      const after = parseBalanceTable(tables[1] || tables[0] || '');
      const beforePct = before.pct;
      const afterPct = after.pct;
      let action = 'held';
      if (beforePct == null && afterPct != null) action = 'new';
      else if (beforePct != null && afterPct == null) action = 'exited';
      else if (beforePct != null && afterPct != null) {
        if (afterPct > beforePct + 1e-9) action = 'added';
        else if (afterPct < beforePct - 1e-9) action = 'reduced';
      } else if (involved) {
        // Direction unknown without balances — keep neutral.
        action = 'held';
      }
      events.push({
        serial: form[2].trim(),
        form_url: `https://di.hkex.com.hk${form[1]}`,
        listed_name: stripHtml(corp?.[1] || ''),
        stock_code: padStockCode(codeMatch[1]),
        filer: stripHtml(filer?.[1] || ''),
        role: role === 'director' ? 'director' : 'substantial',
        event_date: parseDdMmYyyy(eventDate?.[1]) || eventDate?.[1] || null,
        summary_date: summaryDate || null,
        reason_code: reason?.[1] || null,
        position: (position?.[1] || involved?.[2] || before.position || after.position || null),
        shares: involved ? finite(involved[1]) : null,
        avg_price: price ? finite(price[1]) : null,
        before_shares: before.shares,
        before_pct: beforePct,
        after_shares: after.shares,
        after_pct: afterPct,
        action,
      });
    }
    return events;
  }

  function parseSouthboundHtml(html) {
    const asOfRaw = (html.match(/id="txtShareholdingDate"[^>]*value="([^"]*)"/i)
      || html.match(/name="txtShareholdingDate"[^>]*value="([^"]*)"/i)
      || [])[1] || null;
    const rows = [];
    const re = /col-stock-code[\s\S]*?mobile-list-body">\s*(\d{1,5})\s*<[\s\S]*?col-stock-name[\s\S]*?mobile-list-body">([^<]*)<[\s\S]*?col-shareholding[\s\S]*?mobile-list-body">([^<]*)<[\s\S]*?col-shareholding-percent[\s\S]*?mobile-list-body">([\d.]+)%/gi;
    let match;
    while ((match = re.exec(html))) {
      rows.push({
        stock_code: padStockCode(match[1]),
        name: stripHtml(match[2]),
        shares: finite(match[3]),
        pct: finite(match[4]),
      });
    }
    return {
      as_of: parseSlashDate(asOfRaw) || asOfRaw,
      rows,
      byCode: Object.fromEntries(rows.map(row => [row.stock_code, row])),
    };
  }

  function parseCsmDailyJs(text) {
    const jsonText = String(text || '').replace(/^\s*tabData\s*=\s*/i, '').trim().replace(/;?\s*$/, '');
    const data = JSON.parse(jsonText);
    const southbound = [];
    for (const block of data || []) {
      if (!/Southbound/i.test(String(block?.market || ''))) continue;
      let stats = null;
      const top = [];
      for (const content of block.content || []) {
        const table = content?.table;
        if (!table) continue;
        if (content.style === 1) {
          const schema = table.schema?.[0] || [];
          const vals = (table.tr || []).map(row => row?.td?.[0]?.[0]);
          stats = Object.fromEntries(schema.map((key, i) => [key, vals[i] ?? null]));
        } else if (content.style === 2) {
          for (const row of table.tr || []) {
            const cells = row?.td?.[0] || [];
            if (cells.length >= 4) {
              top.push({
                rank: finite(cells[0]),
                stock_code: padStockCode(cells[1]),
                name: cells[2],
                buy: cells[3],
                sell: cells[4],
                total: cells[5] || cells[3],
              });
            }
          }
        }
      }
      const buy = finite(stats?.['Buy Turnover']);
      const sell = finite(stats?.['Sell Turnover']);
      southbound.push({
        market: block.market,
        date: block.date,
        tradingDay: block.tradingDay,
        stats,
        net_buy: buy != null && sell != null ? round4(buy - sell) : null,
        top: top.slice(0, 10),
      });
    }
    return {
      as_of: southbound[0]?.date || null,
      // HKEX CSM DailyStat southbound market turnover is in HK$ million
      // (百萬港元), not 億 and not share count. Top-10 stock legs are raw HKD.
      turnover_unit: 'HKD_million',
      southbound,
      net_buy_total: sumNullable(southbound.map(row => row.net_buy)),
    };
  }

  /** Format CSM southbound net turnover (HK$ million) with an 億港元 gloss. */
  function formatCsmNetTurnover(value, lang = 'zh') {
    const n = finite(value);
    if (n == null) return '—';
    const signed = `${n > 0 ? '+' : ''}${n.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
    const yiAbs = Math.abs(n) / 100;
    const yiSigned = `${n > 0 ? '+' : n < 0 ? '-' : ''}${yiAbs.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
    if (lang === 'en') {
      return `${signed} HK$ million (≈ ${yiSigned} × HK$100m)`;
    }
    return `${signed} 百萬港元（約 ${yiSigned} 億港元）`;
  }

  function parseSfcShortCsv(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    if (lines.length < 2) return { as_of: null, rows: [], byCode: {} };
    const header = lines[0].split(',').map(cell => cell.trim());
    const idx = {
      date: header.indexOf('Date'),
      code: header.indexOf('Stock Code'),
      name: header.indexOf('Stock Name'),
      shares: header.indexOf('Aggregated Reportable Short Positions (Shares)'),
      hkd: header.indexOf('Aggregated Reportable Short Positions (HK$)'),
    };
    const rows = [];
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const cols = line.split(',');
      const code = padStockCode(cols[idx.code]);
      if (!code) continue;
      rows.push({
        date: parseDdMmYyyy(cols[idx.date]) || cols[idx.date],
        stock_code: code,
        name: cols[idx.name],
        shares: finite(cols[idx.shares]),
        hkd: finite(cols[idx.hkd]),
      });
    }
    return {
      as_of: rows[0]?.date || null,
      rows,
      byCode: Object.fromEntries(rows.map(row => [row.stock_code, row])),
    };
  }

  function extractSfcCsvLinks(pageHtml) {
    const links = [...String(pageHtml || '').matchAll(/href="(https:\/\/www\.sfc\.hk\/-\/media\/EN\/pdf\/spr\/[^"]+\.csv[^"]*)"/gi)]
      .map(m => m[1]);
    return [...new Set(links)];
  }

  function round4(n) {
    return Math.round(n * 1e4) / 1e4;
  }

  function sumNullable(values) {
    let total = 0;
    let any = false;
    for (const value of values) {
      const n = finite(value);
      if (n == null) continue;
      total += n;
      any = true;
    }
    return any ? round4(total) : null;
  }

  function pctChange(latest, prior) {
    if (latest == null || prior == null) return null;
    return round4(latest - prior);
  }

  /** Short session windows (business days) + longer calendar-day horizons. */
  const SOUTHBOUND_SHORT_BIZ_DAYS = Object.freeze([1, 5, 20]);
  const SOUTHBOUND_LONG_CAL_DAYS = Object.freeze([30, 60, 90, 120, 150, 180, 270, 360]);

  /** Pick history row on the Nth prior business day vs as_of (exact date match only). */
  function historyRowBusinessDaysAgo(history, asOf, businessDays) {
    const asOfIso = normalizeIsoDate(asOf);
    if (!asOfIso || !businessDays) return null;
    const days = businessDaysBack(businessDays + 1, asOfIso);
    const target = days[businessDays];
    if (!target) return null;
    return (history || []).find(row => normalizeIsoDate(row.date) === target) || null;
  }

  function shiftCalendarDays(iso, calendarDays) {
    const asOfIso = normalizeIsoDate(iso);
    if (!asOfIso || calendarDays == null) return null;
    const cursor = new Date(`${asOfIso}T00:00:00Z`);
    cursor.setUTCDate(cursor.getUTCDate() - Number(calendarDays));
    return cursor.toISOString().slice(0, 10);
  }

  /**
   * Newest history row on/before target calendar day. Null when the gap to target
   * exceeds maxGapDays (weekend/holiday slack only — do not invent distant fills).
   */
  function historyRowCalendarDaysAgo(history, asOf, calendarDays, maxGapDays = 5) {
    const asOfIso = normalizeIsoDate(asOf);
    const target = shiftCalendarDays(asOfIso, calendarDays);
    if (!asOfIso || !target) return null;
    const row = (history || []).find((entry) => {
      const date = normalizeIsoDate(entry.date);
      return date && date <= target;
    });
    if (!row) return null;
    const rowDate = normalizeIsoDate(row.date);
    const gap = (Date.parse(`${target}T00:00:00Z`) - Date.parse(`${rowDate}T00:00:00Z`)) / 86400000;
    if (!Number.isFinite(gap) || gap > maxGapDays) return null;
    return row;
  }

  function buildSouthboundForCode(historyRows) {
    const history = (historyRows || [])
      .filter(row => row && row.pct != null)
      .map(row => ({
        date: normalizeIsoDate(row.date) || row.date,
        shares: row.shares ?? null,
        pct: row.pct,
        name: row.name || null,
      }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const latest = history[0] || null;
    const changes = {};
    for (const days of SOUTHBOUND_SHORT_BIZ_DAYS) {
      const prior = historyRowBusinessDaysAgo(history, latest?.date, days);
      changes[`pct_chg_${days}d`] = pctChange(latest?.pct, prior?.pct);
    }
    for (const days of SOUTHBOUND_LONG_CAL_DAYS) {
      const prior = historyRowCalendarDaysAgo(history, latest?.date, days);
      changes[`pct_chg_${days}d`] = pctChange(latest?.pct, prior?.pct);
    }
    return {
      as_of: latest?.date || null,
      shares: latest?.shares ?? null,
      pct: latest?.pct ?? null,
      name: latest?.name || null,
      // Honest nulls when the matching prior snapshot is missing.
      pct_chg_1d: changes.pct_chg_1d ?? null,
      pct_chg_5d: changes.pct_chg_5d ?? null,
      pct_chg_20d: changes.pct_chg_20d ?? null,
      pct_chg_30d: changes.pct_chg_30d ?? null,
      pct_chg_60d: changes.pct_chg_60d ?? null,
      pct_chg_90d: changes.pct_chg_90d ?? null,
      pct_chg_120d: changes.pct_chg_120d ?? null,
      pct_chg_150d: changes.pct_chg_150d ?? null,
      pct_chg_180d: changes.pct_chg_180d ?? null,
      pct_chg_270d: changes.pct_chg_270d ?? null,
      pct_chg_360d: changes.pct_chg_360d ?? null,
      changes,
      history,
    };
  }

  function buildShortForCode(current, previous, southbound) {
    if (!current) return null;
    let issued = null;
    if (southbound?.shares != null && southbound?.pct) {
      issued = southbound.shares / (southbound.pct / 100);
    }
    return {
      as_of: current.date,
      shares: current.shares,
      hkd: current.hkd,
      name: current.name || null,
      pct_of_issued: issued ? round4((current.shares / issued) * 100) : null,
      shares_chg_wow: previous?.shares != null && current.shares != null
        ? current.shares - previous.shares
        : null,
    };
  }

  function diActionLabel(action, lang) {
    const zh = {
      new: '首次成主要股東／新申報',
      added: '增持',
      reduced: '減持',
      exited: '不再持有／跌破門檻',
      held: '持平／其他',
    };
    const en = {
      new: 'New / first disclosure',
      added: 'Added',
      reduced: 'Reduced',
      exited: 'Exited / below threshold',
      held: 'Unchanged / other',
    };
    return (lang === 'en' ? en : zh)[action] || action;
  }

  function roleLabel(role, lang) {
    if (lang === 'en') return role === 'director' ? 'Director / CEO' : 'Substantial (≥5%)';
    return role === 'director' ? '董事／行政總裁' : '主要股東（≥5%）';
  }

  function formatPct(value, digits = 2) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return `${Number(value).toFixed(digits)}%`;
  }

  function formatDeltaPct(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const n = Number(value);
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(2)} pp`;
  }

  function formatShares(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return Number(value).toLocaleString('en-US');
  }

  function formatHkd(value) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    const n = Number(value);
    const abs = Math.abs(n);
    if (abs >= 1e9) return `HK$${ (n / 1e9).toFixed(2) }B`;
    if (abs >= 1e6) return `HK$${ (n / 1e6).toFixed(2) }M`;
    return `HK$${n.toLocaleString('en-US')}`;
  }

  function emptyPayload(ticker, notice) {
    return {
      ticker,
      stock_code: codeFromTicker(ticker),
      source: 'empty',
      capturedAt: null,
      southbound: buildSouthboundForCode([]),
      di_events: [],
      short: null,
      market_flow: null,
      notice: notice || 'HK_SMART_MONEY_EMPTY',
    };
  }

  function seedLooksUseful(body) {
    if (!body) return false;
    return body.southbound?.pct != null
      || (body.di_events || []).length > 0
      || body.short != null;
  }

  /** Browser: committed seed first (Preview-safe); live API only when seed missing. */
  function loadStockCache(ticker) {
    const symbol = String(ticker || '').toUpperCase();
    return fetch(`cache/hk-smart-money/${symbol}.json`, { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) return null;
      const body = await response.json();
      return { ...body, source: body.source || 'cache', ticker: symbol };
    }).catch(() => null);
  }

  function loadStockLive(ticker) {
    const symbol = encodeURIComponent(String(ticker || '').toUpperCase());
    return fetch(`/api/hk-smart-money?action=stock&symbol=${symbol}`, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          const err = new Error(body.error || `HK_SMART_MONEY_HTTP_${response.status}`);
          err.status = response.status;
          err.body = body;
          throw err;
        }
        return { ...body, source: body.source || 'live' };
      });
  }

  function loadStock(ticker) {
    const symbol = String(ticker || '').toUpperCase();
    return loadStockCache(symbol).then((cached) => {
      if (seedLooksUseful(cached)) return cached;
      return loadStockLive(symbol).then(
        (live) => live,
        (error) => emptyPayload(symbol, error.message || 'HK_SMART_MONEY_UNAVAILABLE'),
      );
    });
  }

  return {
    DI_LOOKBACK_DAYS,
    SOUTHBOUND_URL,
    DI_SUMMARY_TMPL,
    CSM_DAILY_TMPL,
    SFC_SHORTS_PAGE,
    USER_AGENT,
    finite,
    padStockCode,
    tickerFromCode,
    codeFromTicker,
    isHkListed,
    stripHtml,
    parseDdMmYyyy,
    parseSlashDate,
    normalizeIsoDate,
    toSlashDate,
    businessDaysBack,
    parseDiSummaryHtml,
    parseSouthboundHtml,
    parseCsmDailyJs,
    parseSfcShortCsv,
    extractSfcCsvLinks,
    deriveDiAction,
    normalizeDiEvent,
    normalizeDiEvents,
    SOUTHBOUND_SHORT_BIZ_DAYS,
    SOUTHBOUND_LONG_CAL_DAYS,
    shiftCalendarDays,
    historyRowBusinessDaysAgo,
    historyRowCalendarDaysAgo,
    buildSouthboundForCode,
    buildShortForCode,
    diActionLabel,
    roleLabel,
    formatPct,
    formatDeltaPct,
    formatShares,
    formatHkd,
    formatCsmNetTurnover,
    emptyPayload,
    loadStockCache,
    loadStockLive,
    loadStock,
  };
}));
