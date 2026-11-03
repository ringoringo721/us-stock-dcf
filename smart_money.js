/**
 * Curated Smart Money / 13F helpers for the #TICKER/smart-money subpage.
 * Tracks 20 intelligent investors only — not the full institutional holder board.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SmartMoney = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  /** Curated 13F filers — CIK zero-padded to 10 digits. */
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

  function padCik(value) {
    const digits = String(value == null ? '' : value).replace(/\D/g, '');
    if (!digits) return null;
    return digits.padStart(10, '0').slice(-10);
  }

  function finite(value) {
    // Number(null) === 0 — treat null/undefined/'' as missing, not zero.
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

  function lotIdentity(row) {
    const cusip = String(row?.securityCusip || row?.cusip || '').trim();
    if (cusip) return `cusip:${cusip}`;
    // Amendment restatements repeat the same shares+value with a newer filingDate.
    return `sv:${finite(row?.shares)}|${finite(row?.marketValue)}`;
  }

  /**
   * Collapse same-CIK rows: drop amendment duplicates (same lot identity, keep latest
   * filingDate), then sum remaining true split lots.
   */
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
        if (!prev || String(lot.filingDate || '') > String(prev.filingDate || '')) {
          bestByLot.set(id, lot);
        }
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
        if (String(row.filingDate || '') > String(merged.filingDate || '')) {
          merged.filingDate = row.filingDate;
        }
      }
      merged.changeInShares = sumFinite(distinct.map(row => row.changeInShares))
        ?? (merged.shares != null && merged.lastShares != null
          ? merged.shares - merged.lastShares : null);
      out.push(merged);
    }
    return out;
  }

  function isUsListed(stock) {
    const ticker = String(stock?.ticker || stock?.symbol || '');
    if (/\.HK$/i.test(ticker)) return false;
    const market = String(stock?.calculationCurrency || '').toUpperCase();
    if (market === 'HKD') return false;
    if (/HKEX|HONG KONG/i.test(String(stock?.exchange || ''))) return false;
    return true;
  }

  function allowedCik(cik) {
    const padded = padCik(cik);
    return padded && CIK_SET.has(padded) ? padded : null;
  }

  function investorLabel(investor, lang = 'zh') {
    if (!investor) return '';
    const zh = lang === 'zh' || lang === 'zh-TW';
    const fund = zh ? investor.nameZh : investor.nameEn;
    const mgr = zh ? investor.managerZh : investor.managerEn;
    return mgr && mgr !== fund ? `${fund}（${mgr}）` : fund;
  }

  function normalizeHolderRow(row, ticker) {
    if (!row || typeof row !== 'object') return null;
    const cik = allowedCik(row.cik);
    if (!cik) return null;
    const symbol = String(row.symbol || ticker || '').toUpperCase();
    if (ticker && symbol && symbol !== String(ticker).toUpperCase()) return null;
    const shares = finite(row.sharesNumber ?? row.shares);
    const lastShares = finite(row.lastSharesNumber);
    const date = String(row.date || '').slice(0, 10);
    const filingDate = String(row.filingDate || '').slice(0, 10);
    return {
      cik,
      investor: BY_CIK[cik],
      ticker: symbol || String(ticker || '').toUpperCase(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      filingDate: /^\d{4}-\d{2}-\d{2}$/.test(filingDate) ? filingDate : null,
      year: finite(row.year) ?? (date ? Number(date.slice(0, 4)) : null),
      quarter: finite(row.quarter) ?? (date ? Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1 : null),
      shares,
      lastShares,
      changeInShares: finite(row.changeInSharesNumber) ?? (shares != null && lastShares != null ? shares - lastShares : null),
      marketValue: finite(row.marketValue ?? row.value),
      weight: finite(row.weight),
      ownership: finite(row.ownership ?? row.ownershipPercent),
      securityCusip: row.securityCusip || row.cusip || null,
      isNew: row.isNew === true,
      isSoldOut: row.isSoldOut === true,
      investorName: row.investorName || BY_CIK[cik]?.nameEn || cik,
    };
  }

  function classifyAction(row) {
    if (!row) return 'none';
    if (row.isSoldOut || (row.shares === 0 && row.lastShares > 0)) return 'exit';
    if (row.isNew || (row.lastShares === 0 && row.shares > 0)) return 'new';
    const delta = row.changeInShares;
    if (delta == null && row.shares != null && row.lastShares != null) {
      const d = row.shares - row.lastShares;
      if (d > 0) return 'add';
      if (d < 0) return 'trim';
      return 'hold';
    }
    if (delta > 0) return 'add';
    if (delta < 0) return 'trim';
    if (row.shares > 0) return 'hold';
    if (row.shares === 0 && row.lastShares == null) return 'none';
    return 'none';
  }

  const ACTION_LABELS = {
    zh: { new: '新建倉', add: '加碼', trim: '減碼', exit: '出清', hold: '持有', none: '—' },
    en: { new: 'New', add: 'Add', trim: 'Trim', exit: 'Exit', hold: 'Hold', none: '—' },
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
    const match = /^(\d{4})-Q([1-4])$/.exec(String(key || ''));
    return match ? { year: Number(match[1]), quarter: Number(match[2]) } : null;
  }

  function priorQuarter(year, quarter) {
    if (quarter <= 1) return { year: year - 1, quarter: 4 };
    return { year, quarter: quarter - 1 };
  }

  function recentQuarterSpecs(count = 5, fromDate = new Date()) {
    const n = Math.max(1, Math.min(8, Number(count) || 5));
    // 13F lag ≈ 45 days: start from the latest quarter that should already be filed.
    let year = fromDate.getUTCFullYear();
    let quarter = Math.floor(fromDate.getUTCMonth() / 3) + 1;
    const elapsed = fromDate.getUTCDate();
    // If we are still inside the filing window of the prior quarter, prefer that quarter.
    const { year: py, quarter: pq } = priorQuarter(year, quarter);
    // Use prior calendar quarter as "latest expected" when current quarter just started.
    year = py;
    quarter = pq;
    void elapsed;
    const out = [];
    for (let i = 0; i < n; i += 1) {
      out.push({ year, quarter, key: quarterKey(year, quarter) });
      ({ year, quarter } = priorQuarter(year, quarter));
    }
    return out;
  }

  function filterCurated(rows, ticker) {
    if (!Array.isArray(rows)) return [];
    return mergeRowsByCik(rows.map(row => normalizeHolderRow(row, ticker)).filter(Boolean));
  }

  function synthesizeExit(investor, priorRow, year, quarter) {
    const lastShares = priorRow?.shares ?? null;
    return {
      cik: investor.cik,
      investor,
      ticker: priorRow?.ticker || null,
      date: null,
      filingDate: null,
      year,
      quarter,
      shares: 0,
      lastShares,
      changeInShares: lastShares != null ? -lastShares : null,
      marketValue: 0,
      weight: null,
      ownership: null,
      isNew: false,
      isSoldOut: true,
      investorName: priorRow?.investorName || investor.nameEn,
    };
  }

  /**
   * Build per-investor series across quarters.
   * Synthesizes sold-out rows when a CIK vanishes between consecutive quarters
   * (live FMP analytics only returns names still on the book).
   * @param {Array<{year:number,quarter:number,rows:object[]}>} quarters
   */
  function buildSnapshot(ticker, quarters) {
    const ordered = (quarters || [])
      .map(q => ({
        year: Number(q.year),
        quarter: Number(q.quarter),
        key: quarterKey(q.year, q.quarter),
        // Failed / incomplete live fetches must not invent mass exits.
        incomplete: Boolean(q.error || q.incomplete),
        rows: filterCurated(q.rows || q.data || [], ticker),
      }))
      .filter(q => q.key && !q.incomplete)
      .sort((a, b) => (b.year - a.year) || (b.quarter - a.quarter));

    // Fill gaps: held in older quarter Q+1, missing in newer Q → synthetic exit in Q.
    // Only when the newer quarter was successfully observed (incomplete already filtered).
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const newer = ordered[i];
      const older = ordered[i + 1];
      const newerByCik = new Map(newer.rows.map(row => [row.cik, row]));
      for (const prior of older.rows) {
        if (!(prior.shares > 0)) continue;
        if (newerByCik.has(prior.cik)) continue;
        const investor = BY_CIK[prior.cik];
        if (!investor) continue;
        const exitRow = synthesizeExit(investor, prior, newer.year, newer.quarter);
        newer.rows.push(exitRow);
        newerByCik.set(prior.cik, exitRow);
      }
    }

    const byInvestor = INVESTORS.map(investor => {
      const history = ordered.map(q => {
        const row = q.rows.find(r => r.cik === investor.cik) || null;
        const action = classifyAction(row);
        return {
          key: q.key,
          year: q.year,
          quarter: q.quarter,
          row,
          action,
          shares: row?.shares ?? null,
          marketValue: row?.marketValue ?? null,
          weight: row?.weight ?? null,
          ownership: row?.ownership ?? null,
          filingDate: row?.filingDate ?? null,
        };
      });
      // Current status is always the newest quarter cell — never an older still-held lot.
      const latest = history[0] || null;
      return {
        investor,
        cik: investor.cik,
        history,
        latestAction: latest?.action || 'none',
        latestShares: latest?.shares ?? null,
        latestMarketValue: latest?.marketValue ?? null,
        latestWeight: latest?.weight ?? null,
        latestOwnership: latest?.ownership ?? null,
        holding: Boolean(latest && latest.shares > 0),
      };
    });

    const holders = byInvestor.filter(row => row.holding);
    const exits = byInvestor.filter(row => row.latestAction === 'exit');
    return {
      ticker: String(ticker || '').toUpperCase(),
      quarters: ordered.map(q => q.key),
      investors: byInvestor,
      holders,
      exits,
      curatedCount: INVESTORS.length,
    };
  }

  function loadCache(ticker) {
    const symbol = encodeURIComponent(String(ticker || '').toUpperCase());
    return fetch(`cache/smart-money/${symbol}.json`, { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error(`SMART_MONEY_CACHE_MISS:${response.status}`);
      const body = await response.json();
      if (!body || body.ticker !== String(ticker).toUpperCase()) {
        throw new Error('SMART_MONEY_CACHE_MISMATCH');
      }
      return body;
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
      return {
        year,
        quarter,
        rows,
        source: body?.source?.provider || 'FMP',
      };
    });
  }

  /**
   * Prefer static cache; fall back to live analytics for recent quarters.
   */
  function load(ticker, options = {}) {
    const symbol = String(ticker || '').toUpperCase();
    const quarterCount = Math.max(2, Math.min(6, Number(options.quarters) || 5));
    return loadCache(symbol).then((cached) => {
      const snapshot = cached.snapshot || buildSnapshot(symbol, cached.quarters || []);
      return {
        ticker: symbol,
        source: 'cache',
        capturedAt: cached.capturedAt || null,
        lagNote: true,
        snapshot,
        raw: cached,
      };
    }).catch(() => {
      const specs = recentQuarterSpecs(quarterCount);
      return Promise.all(specs.map(spec => loadQuarterLive(symbol, spec.year, spec.quarter)
        .catch(error => ({
          year: spec.year, quarter: spec.quarter, rows: [], error, incomplete: true,
        }))))
        .then((quarters) => {
          const usable = quarters.filter(q => !q.incomplete && !q.error);
          const snapshot = buildSnapshot(symbol, usable);
          const liveErrors = quarters.filter(q => q.error).map(q => String(q.error.message || q.error));
          return {
            ticker: symbol,
            source: 'live',
            capturedAt: new Date().toISOString(),
            lagNote: true,
            snapshot,
            liveErrors,
          };
        });
    });
  }

  return {
    INVESTORS,
    CIK_SET,
    padCik,
    allowedCik,
    isUsListed,
    investorLabel,
    normalizeHolderRow,
    filterCurated,
    mergeRowsByCik,
    finite,
    classifyAction,
    actionLabel,
    quarterKey,
    parseQuarterKey,
    priorQuarter,
    recentQuarterSpecs,
    buildSnapshot,
    loadCache,
    loadQuarterLive,
    load,
  };
}));
