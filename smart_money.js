/**
 * Smart Money / 13F helpers — WhaleCreep-style stock holders + fund books.
 * Curated 20 remain an optional highlight; primary stock view is broad FMP analytics.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SmartMoney = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const INVESTORS = Object.freeze([
    { id: 'brk', cik: '0001067983', nameEn: 'Berkshire Hathaway', nameZh: '波克夏', managerEn: 'Warren Buffett', managerZh: '華倫·巴菲特', style: 'value' },
    { id: 'himalaya', cik: '0001709323', nameEn: 'Himalaya Capital', nameZh: '喜馬拉雅資本', managerEn: 'Li Lu', managerZh: '李錄', style: 'value' },
    { id: 'pershing', cik: '0001336528', nameEn: 'Pershing Square', nameZh: 'Pershing Square', managerEn: 'Bill Ackman', managerZh: '比爾·阿克曼', style: 'activist' },
    { id: 'baupost', cik: '0001061768', nameEn: 'Baupost Group', nameZh: 'Baupost', managerEn: 'Seth Klarman', managerZh: '賽斯·卡拉曼', style: 'value' },
    { id: 'dalal', cik: '0001549575', nameEn: 'Dalal Street', nameZh: 'Dalal Street', managerEn: 'Mohnish Pabrai', managerZh: '莫尼什·帕伯萊', style: 'value' },
    { id: 'tci', cik: '0001647251', nameEn: 'TCI Fund Management', nameZh: 'TCI', managerEn: 'Chris Hohn', managerZh: '克里斯·霍恩', style: 'activist' },
    { id: 'appaloosa', cik: '0001656456', nameEn: 'Appaloosa', nameZh: 'Appaloosa', managerEn: 'David Tepper', managerZh: '大衛·特珀', style: 'macro' },
    { id: 'thirdpoint', cik: '0001040273', nameEn: 'Third Point', nameZh: 'Third Point', managerEn: 'Dan Loeb', managerZh: '丹·勒布', style: 'activist' },
    { id: 'coatue', cik: '0001135730', nameEn: 'Coatue', nameZh: 'Coatue', managerEn: 'Philippe Laffont', managerZh: '菲利普·拉豐', style: 'growth' },
    { id: 'tiger', cik: '0001167483', nameEn: 'Tiger Global', nameZh: 'Tiger Global', managerEn: 'Chase Coleman', managerZh: '切斯·科爾曼', style: 'growth' },
    { id: 'duquesne', cik: '0001536411', nameEn: 'Duquesne Family Office', nameZh: 'Duquesne', managerEn: 'Stanley Druckenmiller', managerZh: '斯坦利·德魯肯米勒', style: 'macro' },
    { id: 'lonepine', cik: '0001061165', nameEn: 'Lone Pine Capital', nameZh: 'Lone Pine', managerEn: 'Steve Mandel', managerZh: '史蒂夫·曼德爾', style: 'growth' },
    { id: 'icahn', cik: '0000921669', nameEn: 'Icahn Capital', nameZh: 'Icahn Capital', managerEn: 'Carl Icahn', managerZh: '卡爾·伊坎', style: 'activist' },
    { id: 'dme', cik: '0001489933', nameEn: 'DME Capital (Greenlight)', nameZh: 'DME／Greenlight', managerEn: 'David Einhorn', managerZh: '大衛·艾因霍恩', style: 'value' },
    { id: 'fairholme', cik: '0001056831', nameEn: 'Fairholme', nameZh: 'Fairholme', managerEn: 'Bruce Berkowitz', managerZh: '布魯斯·柏克維茨', style: 'value' },
    { id: 'trian', cik: '0001345471', nameEn: 'Trian', nameZh: 'Trian', managerEn: 'Nelson Peltz', managerZh: '納爾遜·佩爾茨', style: 'activist' },
    { id: 'viking', cik: '0001103804', nameEn: 'Viking Global', nameZh: 'Viking Global', managerEn: 'Andreas Halvorsen', managerZh: '安德烈亞斯·哈爾沃森', style: 'l/s' },
    { id: 'scion', cik: '0001649339', nameEn: 'Scion Asset Management', nameZh: 'Scion', managerEn: 'Michael Burry', managerZh: '麥可·貝瑞', style: 'contrarian' },
    { id: 'akre', cik: '0001112520', nameEn: 'Akre Capital', nameZh: 'Akre Capital', managerEn: 'Chuck Akre', managerZh: '查克·阿克爾', style: 'quality' },
    { id: 'valueact', cik: '0001418814', nameEn: 'ValueAct', nameZh: 'ValueAct', managerEn: 'ValueAct', managerZh: 'ValueAct', style: 'activist' },
  ]);

  const CIK_SET = new Set(INVESTORS.map(row => row.cik));
  const BY_CIK = Object.fromEntries(INVESTORS.map(row => [row.cik, row]));
  const FUND_EXTRACT_MAX = 400;

  function padCik(value) {
    const digits = String(value == null ? '' : value).replace(/\D/g, '');
    if (!digits) return null;
    return digits.padStart(10, '0').slice(-10);
  }

  function finite(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function sumFinite(values) {
    let total = 0;
    let any = false;
    for (const value of values) {
      const n = finite(value);
      if (n == null) continue;
      total += n;
      any = true;
    }
    return any ? total : null;
  }

  function slugify(name) {
    return String(name || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'fund';
  }

  function isUsListed(stock) {
    const ticker = String(stock?.ticker || stock?.symbol || '');
    if (/\.HK$/i.test(ticker)) return false;
    if (String(stock?.calculationCurrency || '').toUpperCase() === 'HKD') return false;
    if (/HKEX|HONG KONG/i.test(String(stock?.exchange || ''))) return false;
    return true;
  }

  function allowedCik(cik) {
    const padded = padCik(cik);
    return padded && CIK_SET.has(padded) ? padded : null;
  }

  function isCuratedCik(cik) {
    return Boolean(allowedCik(cik));
  }

  function investorLabel(investor, lang = 'zh') {
    if (!investor) return '';
    const zh = lang === 'zh' || lang === 'zh-TW';
    const fund = zh ? investor.nameZh : investor.nameEn;
    const mgr = zh ? investor.managerZh : investor.managerEn;
    return mgr && mgr !== fund ? `${fund}（${mgr}）` : fund;
  }

  function lotIdentity(row) {
    const cusip = String(row?.securityCusip || row?.cusip || '').trim();
    if (cusip) return `cusip:${cusip}`;
    return `sv:${finite(row?.shares)}|${finite(row?.marketValue)}`;
  }

  /** Stable fund-lot key across quarters — CUSIP first, else symbol+class (not symbol alone). */
  function holdingIdentity(row) {
    const cusip = String(row?.securityCusip || row?.cusip || '').trim().toUpperCase();
    if (cusip) return `cusip:${cusip}`;
    const cls = String(row?.titleOfClass || '').trim().toUpperCase();
    const symbol = String(row?.symbol || '').trim().toUpperCase();
    if (symbol) return `sym:${symbol}|cls:${cls}`;
    const name = String(row?.nameOfIssuer || '').trim().toUpperCase();
    if (name) return `name:${name}|cls:${cls}`;
    return `sv:${finite(row?.shares)}|${finite(row?.marketValue)}`;
  }

  function mergeRowsByCik(rows) {
    const byCik = new Map();
    for (const row of rows || []) {
      if (!row?.cik) continue;
      if (!byCik.has(row.cik)) byCik.set(row.cik, []);
      byCik.get(row.cik).push(row);
    }
    const out = [];
    for (const lots of byCik.values()) {
      const bestByLot = new Map();
      for (const lot of lots) {
        const id = lotIdentity(lot);
        const prev = bestByLot.get(id);
        if (!prev || String(lot.filingDate || '') > String(prev.filingDate || '')) bestByLot.set(id, lot);
      }
      const distinct = [...bestByLot.values()];
      const merged = { ...distinct[0] };
      for (let i = 1; i < distinct.length; i += 1) {
        const row = distinct[i];
        merged.shares = sumFinite([merged.shares, row.shares]);
        merged.lastShares = sumFinite([merged.lastShares, row.lastShares]);
        merged.marketValue = sumFinite([merged.marketValue, row.marketValue]);
        merged.weight = sumFinite([merged.weight, row.weight]);
        merged.ownership = sumFinite([merged.ownership, row.ownership]);
        merged.isNew = merged.isNew === true && row.isNew === true;
        merged.isSoldOut = merged.isSoldOut === true || row.isSoldOut === true;
        if (String(row.filingDate || '') > String(merged.filingDate || '')) merged.filingDate = row.filingDate;
      }
      merged.changeInShares = sumFinite(distinct.map(row => row.changeInShares))
        ?? (merged.shares != null && merged.lastShares != null ? merged.shares - merged.lastShares : null);
      out.push(merged);
    }
    return out;
  }

  /** WhaleCreep action vocabulary. */
  function classifyAction(row) {
    if (!row) return 'none';
    if (row.isSoldOut || (row.shares === 0 && row.lastShares > 0)) return 'exited';
    if (row.isNew || (row.lastShares === 0 && row.shares > 0)) return 'new';
    const delta = row.changeInShares;
    const pct = finite(row.changeInSharesPct);
    if (delta == null && row.shares != null && row.lastShares != null) {
      const d = row.shares - row.lastShares;
      if (d > 0) return 'added';
      if (d < 0) return 'reduced';
      return 'held';
    }
    if (delta > 0 || (pct != null && pct > 0)) return 'added';
    if (delta < 0 || (pct != null && pct < 0)) return 'reduced';
    if (row.shares > 0) return 'held';
    return 'none';
  }

  const ACTION_LABELS = {
    zh: { new: '新建倉', added: '加碼', reduced: '減碼', exited: '出清', held: '持有', none: '—' },
    en: { new: 'new', added: 'added', reduced: 'reduced', exited: 'exited', held: 'held', none: '—' },
  };

  function actionLabel(action, lang = 'zh') {
    const dict = lang === 'en' ? ACTION_LABELS.en : ACTION_LABELS.zh;
    return dict[action] || dict.none;
  }

  function quarterKey(year, quarter) {
    const y = Number(year);
    const q = Number(quarter);
    if (!Number.isInteger(y) || !Number.isInteger(q) || q < 1 || q > 4) return null;
    return `${y}-Q${q}`;
  }

  function parseQuarterKey(key) {
    const match = /^(\d{4})-Q([1-4])$/i.exec(String(key || ''));
    if (match) return { year: Number(match[1]), quarter: Number(match[2]) };
    const alt = /^(\d{4})-q([1-4])$/i.exec(String(key || ''));
    return alt ? { year: Number(alt[1]), quarter: Number(alt[2]) } : null;
  }

  function priorQuarter(year, quarter) {
    if (quarter <= 1) return { year: year - 1, quarter: 4 };
    return { year, quarter: quarter - 1 };
  }

  function recentQuarterSpecs(count = 2, fromDate = new Date()) {
    const n = Math.max(1, Math.min(8, Number(count) || 2));
    const now = fromDate instanceof Date ? fromDate : new Date();
    let { year, quarter } = priorQuarter(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) + 1);
    // 13F may publish up to ~45 days after quarter-end — skip the newest prior
    // quarter while still inside that filing window (avoids sparse incomplete books).
    const quarterEnd = new Date(Date.UTC(year, quarter * 3, 0));
    if ((now.getTime() - quarterEnd.getTime()) < 50 * 86400000) {
      ({ year, quarter } = priorQuarter(year, quarter));
    }
    const out = [];
    for (let i = 0; i < n; i += 1) {
      out.push({ year, quarter, key: quarterKey(year, quarter) });
      ({ year, quarter } = priorQuarter(year, quarter));
    }
    return out;
  }

  /** Prefer FMP filing-date calendars (e.g. Berkshire) so we skip incomplete newest calendar quarters. */
  function quarterSpecsFromDates(dates, count = 2) {
    const n = Math.max(1, Math.min(8, Number(count) || 2));
    const seen = new Set();
    const out = [];
    for (const row of dates || []) {
      const year = Number(row.year);
      const quarter = Number(row.quarter);
      const key = quarterKey(year, quarter);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ year, quarter, key });
      if (out.length >= n) break;
    }
    return out.length ? out : recentQuarterSpecs(n);
  }

  const EXIT_MIN_WEIGHT = 0.5;
  const EXIT_MIN_VALUE = 5e6;

  function normalizeAnalyticsRow(row, ticker) {
    if (!row || typeof row !== 'object') return null;
    const cik = padCik(row.cik);
    if (!cik) return null;
    const symbol = String(row.symbol || ticker || '').toUpperCase();
    if (ticker && symbol && symbol !== String(ticker).toUpperCase()) return null;
    const shares = finite(row.sharesNumber ?? row.shares);
    const lastShares = finite(row.lastSharesNumber);
    const date = String(row.date || '').slice(0, 10);
    const filingDate = String(row.filingDate || '').slice(0, 10);
    const curated = BY_CIK[cik] || null;
    const name = row.investorName || curated?.nameEn || cik;
    return {
      cik,
      slug: slugify(name),
      investorName: name,
      curated,
      isCurated: Boolean(curated),
      ticker: symbol || String(ticker || '').toUpperCase(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      filingDate: /^\d{4}-\d{2}-\d{2}$/.test(filingDate) ? filingDate : null,
      year: finite(row.year) ?? (date ? Number(date.slice(0, 4)) : null),
      quarter: finite(row.quarter) ?? (date ? Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1 : null),
      shares,
      lastShares,
      changeInShares: finite(row.changeInSharesNumber)
        ?? (shares != null && lastShares != null ? shares - lastShares : null),
      changeInSharesPct: finite(row.changeInSharesNumberPercentage),
      marketValue: finite(row.marketValue ?? row.value),
      lastMarketValue: finite(row.lastMarketValue),
      weight: finite(row.weight),
      ownership: finite(row.ownership ?? row.ownershipPercent),
      securityCusip: row.securityCusip || row.cusip || null,
      isNew: row.isNew === true,
      isSoldOut: row.isSoldOut === true,
    };
  }

  function normalizeFundHolding(row, cik) {
    if (!row || typeof row !== 'object') return null;
    const symbol = String(row.symbol || '').toUpperCase() || null;
    const shares = finite(row.shares ?? row.sharesNumber);
    const marketValue = finite(row.value ?? row.marketValue);
    if (shares == null && marketValue == null) return null;
    return {
      cik: padCik(cik || row.cik),
      symbol,
      nameOfIssuer: row.nameOfIssuer || row.securityName || symbol || '—',
      sector: row.industryTitle || row.sector || null,
      shares,
      marketValue,
      weight: finite(row.weight),
      filingDate: row.filingDate ? String(row.filingDate).slice(0, 10) : null,
      date: row.date ? String(row.date).slice(0, 10) : null,
      securityCusip: row.securityCusip || row.cusip || null,
      titleOfClass: row.titleOfClass || null,
    };
  }

  function withActions(rows) {
    return mergeRowsByCik(rows).map(row => {
      const action = classifyAction(row);
      let changeInSharesPct = finite(row.changeInSharesPct);
      if (changeInSharesPct == null && row.shares != null && row.lastShares) {
        changeInSharesPct = ((row.shares - row.lastShares) / row.lastShares) * 100;
      }
      return { ...row, action, changeInSharesPct };
    }).sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1)
      || (b.marketValue ?? 0) - (a.marketValue ?? 0));
  }

  function buildStockKpis(holders, exits = []) {
    const active = holders.filter(row => row.shares > 0);
    const news = active.filter(row => row.action === 'new');
    const exited = exits.filter(row => row.action === 'exited' || row.isSoldOut);
    const inflow = sumFinite(news.map(row => row.marketValue));
    const outflow = sumFinite(exited.map(row => row.lastMarketValue ?? row.marketValue));
    const combined = sumFinite(active.map(row => row.marketValue));
    const top = active[0] || null;
    return {
      holders: active.length,
      newCount: news.length,
      exitedCount: exited.length,
      inflow,
      outflow,
      combinedValue: combined,
      topHolder: top,
      curatedHolders: active.filter(row => row.isCurated).length,
    };
  }

  function buildStockSnapshot(ticker, currentRows, priorRows = [], meta = {}) {
    const holders = withActions((currentRows || []).map(row => normalizeAnalyticsRow(row, ticker)).filter(Boolean));
    const prior = withActions((priorRows || []).map(row => normalizeAnalyticsRow(row, ticker)).filter(Boolean));
    const currentCiks = new Set(holders.filter(row => row.shares > 0).map(row => row.cik));
    // Top-N-by-weight pages are not a closed universe — only treat material / curated
    // disappearances as exits (avoids mass false exits when newest quarter is sparse).
    const priorActive = prior.filter(row => row.shares > 0);
    const coverage = priorActive.length
      ? currentCiks.size / priorActive.length : 1;
    const allowSyntheticExits = coverage >= 0.45;
    const exits = allowSyntheticExits
      ? priorActive
        .filter(row => !currentCiks.has(row.cik) && (
          row.isCurated
          || (finite(row.weight) != null && row.weight >= EXIT_MIN_WEIGHT)
          || (finite(row.marketValue) != null && row.marketValue >= EXIT_MIN_VALUE)
        ))
        .map(row => ({
          ...row,
          shares: 0,
          lastShares: row.shares,
          changeInShares: row.shares != null ? -row.shares : null,
          changeInSharesPct: -100,
          isSoldOut: true,
          action: 'exited',
        }))
      : [];
    const kpis = buildStockKpis(holders, exits);
    return {
      ticker: String(ticker || '').toUpperCase(),
      year: meta.year ?? holders[0]?.year ?? null,
      quarter: meta.quarter ?? holders[0]?.quarter ?? null,
      key: quarterKey(meta.year ?? holders[0]?.year, meta.quarter ?? holders[0]?.quarter),
      holders,
      exits,
      kpis,
    };
  }

  function compareFundHoldings(current, prior) {
    const priorBy = new Map();
    for (const row of prior || []) {
      priorBy.set(holdingIdentity(row), row);
    }
    const currentKeys = new Set();
    const rows = (current || []).map(row => {
      const key = holdingIdentity(row);
      currentKeys.add(key);
      const prev = priorBy.get(key);
      const lastShares = prev?.shares ?? null;
      const changeInShares = row.shares != null && lastShares != null ? row.shares - lastShares : null;
      const changeInSharesPct = changeInShares != null && lastShares
        ? (changeInShares / lastShares) * 100 : null;
      const action = !prev ? 'new'
        : (changeInShares > 0 ? 'added' : changeInShares < 0 ? 'reduced' : 'held');
      return {
        ...row,
        lastShares,
        changeInShares,
        changeInSharesPct,
        action,
      };
    }).sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1)
      || (b.marketValue ?? 0) - (a.marketValue ?? 0));

    const priorBook = sumFinite((prior || []).map(row => row.marketValue));
    const exited = (prior || [])
      .filter(row => {
        const key = holdingIdentity(row);
        return !currentKeys.has(key) && row.shares > 0;
      })
      .map(row => {
        const priorWeight = row.weight != null ? row.weight
          : (priorBook && row.marketValue != null ? (row.marketValue / priorBook) * 100 : null);
        return {
          ...row,
          lastShares: row.shares,
          shares: 0,
          priorWeight,
          priorValue: row.marketValue,
          changeInShares: row.shares != null ? -row.shares : null,
          changeInSharesPct: -100,
          action: 'exited',
        };
      })
      .sort((a, b) => (b.priorValue ?? 0) - (a.priorValue ?? 0));

    const book = sumFinite(rows.map(row => row.marketValue));
    const withWeight = rows.map(row => ({
      ...row,
      weight: row.weight != null ? row.weight
        : (book && row.marketValue != null ? (row.marketValue / book) * 100 : null),
    }));
    const sectorMix = {};
    for (const row of withWeight) {
      const sector = row.sector || 'Unclassified';
      sectorMix[sector] = (sectorMix[sector] || 0) + (row.weight || 0);
    }
    const top10Weight = sumFinite(withWeight.slice(0, 10).map(row => row.weight));
    const effectiveN = effectivePositions(withWeight.map(row => row.weight));
    return {
      holdings: withWeight,
      exited,
      kpis: {
        book,
        positions: withWeight.length,
        largestWeight: withWeight[0]?.weight ?? null,
        topSymbol: withWeight[0]?.symbol || withWeight[0]?.nameOfIssuer || null,
        top10Weight,
        effectiveN,
        newCount: withWeight.filter(row => row.action === 'new').length,
        addedCount: withWeight.filter(row => row.action === 'added').length,
        reducedCount: withWeight.filter(row => row.action === 'reduced').length,
        exitedCount: exited.length,
      },
      sectorMix,
    };
  }

  function concentrationFromHistory(history) {
    const largest = (history || []).map(h => finite(h.largestWeight)).filter(n => n != null);
    const top10 = (history || []).map(h => finite(h.top10Weight)).filter(n => n != null);
    const median = (arr) => {
      if (!arr.length) return null;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    const medianLargest = median(largest);
    const medianTop10 = median(top10);
    let style = null;
    if (medianLargest != null) {
      style = medianLargest >= 15 ? 'concentrated' : medianLargest >= 8 ? 'balanced' : 'diversified';
    }
    return { medianLargest, medianTop10, style };
  }

  function loadStockCache(ticker) {
    const symbol = encodeURIComponent(String(ticker || '').toUpperCase());
    return fetch(`cache/smart-money/${symbol}.json`, { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error(`SMART_MONEY_CACHE_MISS:${response.status}`);
      const body = await response.json();
      if (!body || body.ticker !== String(ticker).toUpperCase()) throw new Error('SMART_MONEY_CACHE_MISMATCH');
      return body;
    });
  }

  function loadFundCache(slugOrCik) {
    const key = encodeURIComponent(String(slugOrCik || '').toLowerCase());
    return fetch(`cache/smart-money/funds/${key}.json`, { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error(`FUND_CACHE_MISS:${response.status}`);
      return response.json();
    });
  }

  function loadQuarterLive(ticker, year, quarter) {
    const qs = new URLSearchParams({
      action: 'institutional-holders',
      symbol: String(ticker).toUpperCase(),
      year: String(year),
      quarter: String(quarter),
      page: '0',
      limit: '100',
    });
    return fetch(`/api/fmp?${qs}`).then(async (response) => {
      if (!response.ok) {
        let detail = String(response.status);
        try {
          const body = await response.json();
          if (body?.error) detail = `${response.status}:${body.error}`;
        } catch { /* ignore */ }
        throw new Error(`INSTITUTIONAL_HOLDERS_FAILED:${detail}`);
      }
      const body = await response.json();
      const rows = Array.isArray(body) ? body : body?.data || [];
      // Empty books are incomplete — walk older quarters instead of treating as success.
      if (!rows.length) {
        const err = new Error(`INSTITUTIONAL_HOLDERS_EMPTY:${year}-Q${quarter}`);
        err.empty = true;
        throw err;
      }
      return {
        year,
        quarter,
        rows,
        source: body?.source?.provider || 'FMP',
      };
    });
  }

  function loadFundLive(cik, year, quarter) {
    const qs = new URLSearchParams({
      action: 'institutional-extract',
      cik: padCik(cik),
      year: String(year),
      quarter: String(quarter),
    });
    return fetch(`/api/fmp?${qs}`).then(async (response) => {
      if (!response.ok) {
        let detail = String(response.status);
        try {
          const body = await response.json();
          if (body?.error) detail = `${response.status}:${body.error}`;
        } catch { /* ignore */ }
        throw new Error(`INSTITUTIONAL_EXTRACT_FAILED:${detail}`);
      }
      const body = await response.json();
      return {
        year,
        quarter,
        rows: Array.isArray(body) ? body : body?.data || [],
        source: body?.source?.provider || 'FMP',
        investorName: body?.source?.investorName || null,
      };
    });
  }

  function fundHref(slug, vs) {
    const base = `#fund/${encodeURIComponent(String(slug || '').toLowerCase())}`;
    if (!vs) return base;
    const parsed = parseQuarterKey(String(vs).toUpperCase().replace(/-q/, '-Q'));
    if (!parsed) return base;
    return `${base}?vs=${parsed.year}-q${parsed.quarter}`;
  }

  function fundsDirectoryHref() {
    return '#funds';
  }

  /** WhaleCreep Effective N ≈ 1 / HHI of portfolio weights (stored as percent of book). */
  function effectivePositions(weights) {
    const nums = (weights || []).map(finite).filter(w => w != null && w > 0);
    if (!nums.length) return null;
    // Our pipeline stores percent-of-book (e.g. 22.0). Only treat as fractions when
    // the whole vector clearly sums near 1 (legacy / external payloads).
    const sum = nums.reduce((a, b) => a + b, 0);
    const asFraction = sum > 0 && sum <= 1.5;
    let hhi = 0;
    for (const w of nums) {
      const frac = asFraction ? w : w / 100;
      hhi += frac * frac;
    }
    if (hhi <= 0) return null;
    return 1 / hhi;
  }

  function summarizeFundQuarter(rows) {
    const holdings = (rows || []).map(row => normalizeFundHolding(row)).filter(Boolean)
      .sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0));
    const book = sumFinite(holdings.map(row => row.marketValue));
    const withWeight = holdings.map(row => ({
      ...row,
      weight: row.weight != null ? row.weight
        : (book && row.marketValue != null ? (row.marketValue / book) * 100 : null),
    }));
    const weights = withWeight.map(row => row.weight).filter(w => w != null);
    return {
      positions: withWeight.length,
      book,
      topWeight: withWeight[0]?.weight ?? null,
      topSymbol: withWeight[0]?.symbol || withWeight[0]?.nameOfIssuer || null,
      top10Weight: sumFinite(withWeight.slice(0, 10).map(row => row.weight)),
      effectiveN: effectivePositions(weights),
    };
  }

  function buildFundDirectoryEntry(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const cik = padCik(payload.cik);
    const slug = payload.slug || slugify(payload.investorName) || cik;
    const curated = BY_CIK[cik] || INVESTORS.find(row => slugify(row.nameEn) === slug) || null;
    const quarters = payload.quarters || [];
    const latest = quarters[0];
    const summary = summarizeFundQuarter(latest?.rows || []);
    const history = payload.history || quarters.map(q => ({
      year: q.year, quarter: q.quarter, positions: (q.rows || []).length,
    }));
    return {
      cik,
      slug,
      investorName: payload.investorName || curated?.nameEn || slug,
      curated,
      isCurated: Boolean(curated),
      style: curated?.style || null,
      year: latest?.year ?? null,
      quarter: latest?.quarter ?? null,
      key: latest ? quarterKey(latest.year, latest.quarter) : null,
      quartersOnFile: history.length,
      ...summary,
      capturedAt: payload.capturedAt || null,
    };
  }

  function loadFundsDirectory() {
    return fetch('cache/smart-money/funds/index.json', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error(`FUNDS_INDEX_MISS:${response.status}`);
      const body = await response.json();
      const managers = Array.isArray(body?.managers) ? body.managers : [];
      return {
        source: 'cache',
        capturedAt: body.capturedAt || null,
        latestKey: body.latestKey || managers[0]?.key || null,
        managers: managers.sort((a, b) => (b.book ?? 0) - (a.book ?? 0)),
      };
    }).catch(() => {
      // Fallback: curated list only (no book stats until caches exist).
      const managers = INVESTORS.map(row => ({
        cik: row.cik,
        slug: slugify(row.nameEn),
        investorName: row.nameEn,
        curated: row,
        isCurated: true,
        style: row.style,
        year: null,
        quarter: null,
        key: null,
        quartersOnFile: 0,
        positions: null,
        book: null,
        topWeight: null,
        topSymbol: null,
        top10Weight: null,
        effectiveN: null,
      }));
      return { source: 'curated-fallback', capturedAt: null, latestKey: null, managers };
    });
  }

  function loadStock(ticker, options = {}) {
    const symbol = String(ticker || '').toUpperCase();
    return loadStockCache(symbol).then((cached) => {
      const current = (cached.quarters || [])[0];
      const prior = (cached.quarters || [])[1];
      if (current?.rows?.length) {
        const snapshot = buildStockSnapshot(symbol, current.rows, prior?.rows || [], {
          year: current.year, quarter: current.quarter,
        });
        return { ticker: symbol, source: 'cache', capturedAt: cached.capturedAt || null, snapshot, raw: cached };
      }
      if (cached.snapshot?.holders?.length) {
        return {
          ticker: symbol,
          source: 'cache',
          capturedAt: cached.capturedAt || null,
          snapshot: cached.snapshot,
          raw: cached,
        };
      }
      throw new Error('SMART_MONEY_CACHE_EMPTY');
    }).catch((cacheError) => {
      // Walk several filing quarters — newest calendar quarter is often sparse/empty.
      const want = Math.max(2, Math.min(6, Number(options.liveQuarters) || 6));
      const specs = recentQuarterSpecs(want);
      // Sequential walk so we stop once we have current+prior (saves shared FMP quota).
      const loaded = [];
      const liveErrors = [];
      const step = (index) => {
        if (index >= specs.length) return Promise.resolve();
        if (loaded.filter(q => q.rows?.length).length >= 2) return Promise.resolve();
        const spec = specs[index];
        return loadQuarterLive(symbol, spec.year, spec.quarter)
          .then((quarter) => { loaded.push(quarter); })
          .catch((error) => {
            liveErrors.push(String(error.message || error));
            loaded.push({
              year: spec.year, quarter: spec.quarter, rows: [], error, incomplete: true,
            });
          })
          .then(() => step(index + 1));
      };
      return step(0).then(() => {
        const usable = loaded.filter(q => !q.incomplete && !q.error && q.rows?.length);
        const current = usable[0];
        const prior = usable[1];
        if (!current) {
          const detail = liveErrors[0] || String(cacheError?.message || 'no-quarters');
          throw new Error(`SMART_MONEY_LIVE_EMPTY:${detail}`);
        }
        const snapshot = buildStockSnapshot(symbol, current.rows, prior?.rows || [], {
          year: current.year, quarter: current.quarter,
        });
        return {
          ticker: symbol,
          source: 'live',
          capturedAt: new Date().toISOString(),
          snapshot,
          liveErrors,
        };
      });
    });
  }

  function resolveFundIdentity(slugOrCik) {
    const raw = String(slugOrCik || '').trim();
    const asCik = padCik(raw);
    if (asCik && /^\d{10}$/.test(asCik) && raw.replace(/\D/g, '').length >= 7) {
      const curated = BY_CIK[asCik];
      return { cik: asCik, slug: curated ? slugify(curated.nameEn) : asCik, curated };
    }
    const slug = slugify(raw);
    const curated = INVESTORS.find(row => slugify(row.nameEn) === slug || row.id === slug);
    if (curated) return { cik: curated.cik, slug: slugify(curated.nameEn), curated };
    return { cik: null, slug, curated: null };
  }

  function selectFundQuarter(quarters, vsParsed) {
    const list = quarters || [];
    if (!vsParsed) return list[0] || null;
    const hit = list.find(q => Number(q.year) === vsParsed.year && Number(q.quarter) === vsParsed.quarter);
    if (!hit) {
      throw new Error(`FUND_QUARTER_NOT_FOUND:${vsParsed.year}-Q${vsParsed.quarter}`);
    }
    return hit;
  }

  function loadFund(slugOrCik, options = {}) {
    const identity = resolveFundIdentity(slugOrCik);
    const vs = options.vs || options.quarterKey || null;
    let vsParsed = null;
    if (vs) {
      vsParsed = parseQuarterKey(String(vs).replace(/^vs=/i, '').toUpperCase().replace(/-q/, '-Q'));
      if (!vsParsed) {
        return Promise.reject(new Error(`FUND_QUARTER_INVALID:${vs}`));
      }
    }

    const fromCache = loadFundCache(identity.slug)
      .catch(() => (identity.cik ? loadFundCache(identity.cik) : Promise.reject(new Error('FUND_CACHE_MISS'))));

    function packFundResult(meta, current, prior, compared, historyRows) {
      const history = (historyRows || []).map(q => {
        if (q.largestWeight != null || q.book != null) return q;
        const summary = summarizeFundQuarter(q.rows || []);
        return {
          year: q.year,
          quarter: q.quarter,
          positions: summary.positions,
          book: summary.book,
          largestWeight: summary.topWeight,
          top10Weight: summary.top10Weight,
          effectiveN: summary.effectiveN,
          topSymbol: summary.topSymbol,
        };
      });
      const concentration = concentrationFromHistory(history);
      return {
        ...meta,
        year: current?.year ?? meta.year ?? null,
        quarter: current?.quarter ?? meta.quarter ?? null,
        vsYear: prior?.year ?? null,
        vsQuarter: prior?.quarter ?? null,
        history,
        ...compared,
        kpis: {
          ...compared.kpis,
          quartersOnFile: history.length,
        },
        concentration,
      };
    }

    return fromCache.then((cached) => {
      const quarters = cached.quarters || [];
      const current = selectFundQuarter(quarters, vsParsed);
      if (!current) throw new Error('FUND_CACHE_EMPTY');
      const idx = quarters.indexOf(current);
      const prior = idx >= 0 ? quarters[idx + 1] : quarters[1];
      const currentHoldings = (current?.rows || []).map(row => normalizeFundHolding(row, cached.cik || identity.cik)).filter(Boolean);
      const priorHoldings = (prior?.rows || []).map(row => normalizeFundHolding(row, cached.cik || identity.cik)).filter(Boolean);
      const compared = compareFundHoldings(currentHoldings, priorHoldings);
      const historySource = cached.history?.length
        ? cached.history
        : quarters;
      return packFundResult({
        source: 'cache',
        cik: cached.cik || identity.cik,
        slug: cached.slug || identity.slug,
        investorName: cached.investorName || identity.curated?.nameEn || identity.slug,
        curated: identity.curated || BY_CIK[cached.cik] || null,
        capturedAt: cached.capturedAt || null,
      }, current, prior, compared, historySource);
    }).catch((cacheError) => {
      // Invalid ?vs= must not fall through to "latest" — surface the parse error.
      if (String(cacheError?.message || '').startsWith('FUND_QUARTER_INVALID:')) {
        throw cacheError;
      }
      if (!identity.cik) throw new Error('FUND_IDENTITY_UNKNOWN');
      const specs = vsParsed
        ? [vsParsed, priorQuarter(vsParsed.year, vsParsed.quarter)]
        : recentQuarterSpecs(2);
      return Promise.all(specs.map(spec => loadFundLive(identity.cik, spec.year, spec.quarter)
        .catch(error => ({ year: spec.year, quarter: spec.quarter, rows: [], error, incomplete: true }))))
        .then((quarters) => {
          if (vsParsed) {
            const current = selectFundQuarter(
              quarters.filter(q => !q.incomplete && !q.error),
              vsParsed,
            );
            const priorSpec = priorQuarter(vsParsed.year, vsParsed.quarter);
            const prior = quarters.find(q => !q.incomplete && !q.error
              && Number(q.year) === priorSpec.year && Number(q.quarter) === priorSpec.quarter) || null;
            const currentHoldings = (current.rows || []).map(row => normalizeFundHolding(row, identity.cik)).filter(Boolean);
            const priorHoldings = (prior?.rows || []).map(row => normalizeFundHolding(row, identity.cik)).filter(Boolean);
            const compared = compareFundHoldings(currentHoldings, priorHoldings);
            const usable = quarters.filter(q => !q.incomplete && !q.error);
            return packFundResult({
              source: 'live',
              cik: identity.cik,
              slug: identity.slug,
              investorName: current.investorName || identity.curated?.nameEn || identity.slug,
              curated: identity.curated,
              capturedAt: new Date().toISOString(),
              liveErrors: quarters.filter(q => q.error).map(q => String(q.error.message || q.error)),
            }, current, prior, compared, usable);
          }
          const usable = quarters.filter(q => !q.incomplete && !q.error);
          if (!usable.length) throw new Error('FUND_LIVE_EMPTY');
          const current = usable[0];
          const prior = usable[1];
          const currentHoldings = current.rows.map(row => normalizeFundHolding(row, identity.cik)).filter(Boolean);
          const priorHoldings = (prior?.rows || []).map(row => normalizeFundHolding(row, identity.cik)).filter(Boolean);
          const compared = compareFundHoldings(currentHoldings, priorHoldings);
          return packFundResult({
            source: 'live',
            cik: identity.cik,
            slug: identity.slug,
            investorName: current.investorName || identity.curated?.nameEn || identity.slug,
            curated: identity.curated,
            capturedAt: new Date().toISOString(),
            liveErrors: quarters.filter(q => q.error).map(q => String(q.error.message || q.error)),
          }, current, prior, compared, usable);
        });
    });
  }

  function formatMoney(value, lang = 'en') {
    const n = finite(value);
    if (n == null) return '—';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}bn`;
    if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}m`;
    if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}k`;
    return `${sign}$${Math.round(abs)}`;
  }

  function formatShares(value) {
    const n = finite(value);
    if (n == null) return '—';
    const abs = Math.abs(n);
    if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}m`;
    if (abs >= 1e4) return `${(n / 1e3).toFixed(2)}k`;
    return Math.round(n).toLocaleString('en-US');
  }

  function formatDeltaPct(value, action) {
    if (action === 'new' || action === 'exited') return '–';
    const n = finite(value);
    if (n == null) return '—';
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(Math.abs(n) >= 10 ? 0 : 1)}%`;
  }

  return {
    INVESTORS,
    CIK_SET,
    FUND_EXTRACT_MAX,
    padCik,
    finite,
    slugify,
    isUsListed,
    allowedCik,
    isCuratedCik,
    investorLabel,
    mergeRowsByCik,
    classifyAction,
    actionLabel,
    quarterKey,
    parseQuarterKey,
    priorQuarter,
    recentQuarterSpecs,
    quarterSpecsFromDates,
    normalizeAnalyticsRow,
    normalizeFundHolding,
    holdingIdentity,
    lotIdentity,
    selectFundQuarter,
    buildStockSnapshot,
    buildStockKpis,
    compareFundHoldings,
    concentrationFromHistory,
    resolveFundIdentity,
    loadStock,
    loadFund,
    loadStockCache,
    loadFundCache,
    loadQuarterLive,
    loadFundLive,
    formatMoney,
    formatShares,
    formatDeltaPct,
    fundHref,
    fundsDirectoryHref,
    effectivePositions,
    summarizeFundQuarter,
    buildFundDirectoryEntry,
    loadFundsDirectory,
  };
}));
