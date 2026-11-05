  /**
   * Smart Money helpers — WhaleCreep-style 13F holders/fund books + timely Form 4 moves.
   * Curated 20 remain an optional 13F highlight; Form 4 is a separate near-real-time lane.
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
  /** Extra extract-allowlisted CIKs (from committed stock-seed holders) — not open scrape. */
  const EXTRA_CIK_SET = new Set();
  /** CIK → display name from holder-funds / stock seeds (never use bare CIK as title). */
  const HOLDER_NAME_BY_CIK = Object.create(null);
  const FUND_EXTRACT_MAX = 400;
  /** Live fund books: pull this many recent filing quarters when seed is thin/missing. */
  const LIVE_FUND_QUARTERS = 8;
  /** Live stock holder walk upper bound (seed still slim; Preview uses committed quarters). */
  const LIVE_STOCK_QUARTERS = 8;
  /** Form 4 / Section 16 timely trades shown on #TICKER/smart-money (not a full 13F book). */
  const FORM4_TRADE_CAP = 40;
  const FORM4_LIVE_LIMIT = 40;

  const FORM4_SIDE_LABELS = {
    zh: { buy: '買入', sell: '賣出', other: '其他' },
    en: { buy: 'Buy', sell: 'Sell', other: 'Other' },
  };

  function padCik(value) {
    const digits = String(value == null ? '' : value).replace(/\D/g, '');
    if (!digits) return null;
    return digits.padStart(10, '0').slice(-10);
  }

  /** True when a label is missing or is just the padded CIK digits (never show as primary title). */
  function looksLikeBareCik(label, cik) {
    const raw = String(label == null ? '' : label).trim();
    if (!raw) return true;
    const digits = raw.replace(/\D/g, '');
    if (!digits || digits.length < 7 || digits.length > 10) return false;
    if (!/^\d+$/.test(raw.replace(/^#/, '').trim())) return false;
    const padded = padCik(raw);
    if (!padded) return false;
    if (cik) return padded === padCik(cik);
    return true;
  }

  function registerHolderNames(names) {
    if (!names || typeof names !== 'object') return Object.keys(HOLDER_NAME_BY_CIK).length;
    for (const [key, value] of Object.entries(names)) {
      const cik = padCik(key);
      const name = String(value == null ? '' : value).trim();
      if (!cik || !name || looksLikeBareCik(name, cik)) continue;
      HOLDER_NAME_BY_CIK[cik] = name;
    }
    return Object.keys(HOLDER_NAME_BY_CIK).length;
  }

  function holderNameForCik(cik) {
    const padded = padCik(cik);
    if (!padded) return null;
    return HOLDER_NAME_BY_CIK[padded] || null;
  }

  /**
   * Resolve a human manager title. Prefer curated → explicit name → holder-funds map.
   * Never returns a bare CIK digit string (falls back to "Fund {cik}" only as last resort
   * when even that would be digits-only — returns null so UI can show a generic label).
   */
  function resolveInvestorName(opts = {}) {
    const cik = padCik(opts.cik);
    const curated = opts.curated || (cik && BY_CIK[cik]) || null;
    if (curated?.nameEn) return curated.nameEn;
    const candidates = [
      opts.investorName,
      opts.name,
      cik ? HOLDER_NAME_BY_CIK[cik] : null,
      opts.slug && !looksLikeBareCik(opts.slug, cik) && !/^fund-\d{10}$/i.test(String(opts.slug))
        ? String(opts.slug).replace(/-/g, ' ')
        : null,
    ];
    for (const candidate of candidates) {
      const name = String(candidate == null ? '' : candidate).trim();
      if (!name || looksLikeBareCik(name, cik)) continue;
      if (/^fund-\d{10}$/i.test(name)) continue;
      return name;
    }
    return null;
  }

  function fundSlugForCik(cik, curated) {
    if (curated?.nameEn) return slugify(curated.nameEn);
    const padded = padCik(cik);
    return padded ? `fund-${padded}` : 'fund';
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

  const BY_SLUG = Object.fromEntries(INVESTORS.flatMap(row => [
    [slugify(row.nameEn), row],
    [row.id, row],
  ]));

  function isUsListed(stock) {
    const ticker = String(stock?.ticker || stock?.symbol || '');
    if (/\.HK$/i.test(ticker)) return false;
    if (String(stock?.calculationCurrency || '').toUpperCase() === 'HKD') return false;
    if (/HKEX|HONG KONG/i.test(String(stock?.exchange || ''))) return false;
    return true;
  }

  function registerExtractAllowlist(ciks) {
    for (const value of ciks || []) {
      const padded = padCik(value);
      if (padded) EXTRA_CIK_SET.add(padded);
    }
    return EXTRA_CIK_SET.size;
  }

  function resetHolderNameMap() {
    for (const key of Object.keys(HOLDER_NAME_BY_CIK)) delete HOLDER_NAME_BY_CIK[key];
  }

  function allowedCik(cik) {
    const padded = padCik(cik);
    if (!padded) return null;
    if (CIK_SET.has(padded) || EXTRA_CIK_SET.has(padded)) return padded;
    return null;
  }

  function isCuratedCik(cik) {
    const padded = padCik(cik);
    return Boolean(padded && CIK_SET.has(padded));
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
    // Top-N / holderCap slices are not a closed universe — synthesizing −100% exits
    // for CIKs that merely dropped off the cap invents false churn (Bugbot MEDIUM).
    const truncated = meta.truncated === true;
    const priorActive = prior.filter(row => row.shares > 0);
    const coverage = priorActive.length
      ? currentCiks.size / priorActive.length : 1;
    const allowSyntheticExits = !truncated && coverage >= 0.45;
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
      exitsIncomplete: truncated,
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

  function fundSeedFilename(cik) {
    const padded = padCik(cik);
    return padded ? `fund-${padded}.json` : null;
  }

  function loadFundCache(slugOrCik) {
    const raw = String(slugOrCik || '').trim();
    const asCik = padCik(raw);
    const keys = [];
    // Curated slug, bare CIK, then committed fund-{cik} full-book seed (letter prefix for git).
    if (raw) keys.push(encodeURIComponent(raw.toLowerCase()));
    if (asCik && /^\d{10}$/.test(asCik)) {
      keys.push(encodeURIComponent(asCik));
      keys.push(encodeURIComponent(`fund-${asCik}`));
    }
    const tryNext = (index) => {
      if (index >= keys.length) return Promise.reject(new Error('FUND_CACHE_MISS'));
      return fetch(`cache/smart-money/funds/${keys[index]}.json`, { cache: 'no-store' }).then(async (response) => {
        if (!response.ok) return tryNext(index + 1);
        return response.json();
      }).catch(() => tryNext(index + 1));
    };
    return tryNext(0);
  }

  /**
   * Invert curated fund books → per-ticker holder rows (Preview without FMP).
   * `funds` is [{ cik, slug, investorName, quarters:[{year,quarter,rows}] }].
   */
  function buildCuratedByTickerIndex(funds, { quarters = 2 } = {}) {
    const tickers = Object.create(null);
    const keyCounts = Object.create(null);
    for (const fund of funds || []) {
      const cik = padCik(fund.cik);
      if (!cik) continue;
      const investorName = fund.investorName || BY_CIK[cik]?.nameEn || cik;
      const kept = (fund.quarters || []).slice(0, Math.max(1, quarters));
      kept.forEach((q, qi) => {
        const year = finite(q.year);
        const quarter = finite(q.quarter);
        const key = q.key || quarterKey(year, quarter);
        if (qi === 0 && key) keyCounts[key] = (keyCounts[key] || 0) + 1;
        for (const row of q.rows || []) {
          const symbol = String(row.symbol || '').toUpperCase();
          if (!symbol) continue;
          if (!tickers[symbol]) tickers[symbol] = { current: [], prior: [] };
          const bucket = qi === 0 ? 'current' : 'prior';
          tickers[symbol][bucket].push({
            cik,
            investorName,
            symbol,
            sharesNumber: finite(row.shares ?? row.sharesNumber),
            marketValue: finite(row.value ?? row.marketValue),
            weight: finite(row.weight),
            year,
            quarter,
            filingDate: row.filingDate || null,
            date: row.date || null,
            securityCusip: row.securityCusip || row.cusip || null,
            isCurated: true,
          });
        }
      });
    }
    const rankedKeys = Object.keys(keyCounts).sort((a, b) => keyCounts[b] - keyCounts[a]);
    const latestKey = rankedKeys[0] || null;
    const prior = latestKey ? priorQuarter(
      Number(String(latestKey).slice(0, 4)),
      Number(String(latestKey).slice(6)),
    ) : null;
    // Slim payload for git / static Preview (~50KB for curated-20 × ~22 holdings).
    const slim = Object.create(null);
    for (const symbol of Object.keys(tickers).sort()) {
      const entry = tickers[symbol];
      if (!entry.current.length && !entry.prior.length) continue;
      slim[symbol] = {
        c: entry.current.map(compactCuratedHolderRow),
        p: entry.prior.map(compactCuratedHolderRow),
      };
    }
    return {
      capturedAt: new Date().toISOString(),
      seed: true,
      source: {
        provider: 'FMP',
        method: 'curated-fund-invert',
        note: 'Curated-20 books inverted for Preview when institutional-holders live is unavailable',
      },
      latestKey,
      priorKey: prior ? quarterKey(prior.year, prior.quarter) : null,
      count: Object.keys(slim).length,
      tickers: slim,
      disclaimer: 'Curated managers only — not a full 13F holder universe. Filings lag up to ~45 days.',
    };
  }

  function compactCuratedHolderRow(row) {
    return {
      cik: row.cik,
      n: row.investorName,
      s: row.sharesNumber,
      v: row.marketValue,
      w: row.weight,
      y: row.year,
      q: row.quarter,
      d: row.date || undefined,
      f: row.filingDate || undefined,
      u: row.securityCusip || undefined,
    };
  }

  function expandCuratedHolderRow(row, symbol) {
    if (!row || typeof row !== 'object') return null;
    return {
      cik: row.cik,
      investorName: row.n || row.investorName,
      symbol,
      sharesNumber: row.s ?? row.sharesNumber,
      marketValue: row.v ?? row.marketValue,
      weight: row.w ?? row.weight,
      year: row.y ?? row.year,
      quarter: row.q ?? row.quarter,
      date: row.d || row.date || null,
      filingDate: row.f || row.filingDate || null,
      securityCusip: row.u || row.securityCusip || null,
      isCurated: true,
    };
  }

  let curatedByTickerPromise = null;

  function loadCuratedByTickerIndex() {
    if (curatedByTickerPromise) return curatedByTickerPromise;
    curatedByTickerPromise = fetch('cache/smart-money/curated-by-ticker.json', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`CURATED_INDEX_MISS:${response.status}`);
        return response.json();
      })
      .catch((error) => {
        curatedByTickerPromise = null;
        throw error;
      });
    return curatedByTickerPromise;
  }

  /** Reset memo (tests). */
  function resetCuratedByTickerCache() {
    curatedByTickerPromise = null;
  }

  function snapshotFromCuratedIndex(symbol, index) {
    const entry = index?.tickers?.[symbol];
    if (!entry) return null;
    const currentRows = (entry.c || entry.current || [])
      .map(row => expandCuratedHolderRow(row, symbol)).filter(Boolean);
    const priorRows = (entry.p || entry.prior || [])
      .map(row => expandCuratedHolderRow(row, symbol)).filter(Boolean);
    if (!currentRows.length && !priorRows.length) return null;
    // Prefer modal filing quarter among current rows for the page header key.
    const keyCounts = Object.create(null);
    for (const row of currentRows) {
      const key = quarterKey(row.year, row.quarter);
      if (key) keyCounts[key] = (keyCounts[key] || 0) + 1;
    }
    const topKey = Object.keys(keyCounts).sort((a, b) => keyCounts[b] - keyCounts[a])[0]
      || index.latestKey
      || null;
    const parsed = topKey ? parseQuarterKey(topKey) : null;
    const snapshot = buildStockSnapshot(symbol, currentRows, priorRows, {
      year: parsed?.year ?? currentRows[0]?.year ?? null,
      quarter: parsed?.quarter ?? currentRows[0]?.quarter ?? null,
    });
    return snapshot;
  }

  function emptyStockResult(symbol, notice, liveErrors) {
    return {
      ticker: symbol,
      source: 'empty',
      notice: notice || 'SMART_MONEY_NO_CURATED',
      capturedAt: null,
      liveErrors: liveErrors || [],
      snapshot: buildStockSnapshot(symbol, [], [], {}),
    };
  }

  function safeHttpUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function form4SideLabel(isBuy, lang = 'zh') {
    const dict = lang === 'en' ? FORM4_SIDE_LABELS.en : FORM4_SIDE_LABELS.zh;
    if (isBuy === true) return dict.buy;
    if (isBuy === false) return dict.sell;
    return dict.other;
  }

  /**
   * Normalize FMP insider-trading/search (Form 4) rows into the Smart Money Form 4 shape.
   * Marks curated-20 when reportingCik matches (e.g. Berkshire as 10% owner on SIRI).
   */
  function normalizeForm4Trade(row, symbol) {
    const ticker = String(symbol || row?.symbol || '').toUpperCase();
    if (!ticker || !row || typeof row !== 'object') return null;
    if (row.symbol && String(row.symbol).toUpperCase() !== ticker) return null;
    // Already-slim seed / meta shape
    if (row.name && (row.filingDate || row.transactionDate || row.date)
        && (row.action || row.is_buy != null) && row.securitiesTransacted == null
        && row.reportingName == null) {
      const cik = padCik(row.reportingCik);
      const shares = finite(row.shares);
      const price = finite(row.price);
      let isBuy = row.is_buy;
      if (isBuy !== true && isBuy !== false) {
        const action = String(row.action || '');
        isBuy = /^P(?:-|$)/.test(action) ? true : /^S(?:-|$)/.test(action) ? false : null;
      }
      return {
        symbol: ticker,
        filingDate: row.filingDate || null,
        transactionDate: row.transactionDate || null,
        date: row.date || row.filingDate || row.transactionDate || null,
        name: String(row.name || 'Filer'),
        title: row.title || null,
        reportingCik: cik,
        companyCik: padCik(row.companyCik),
        formType: row.formType || '4',
        is_buy: isBuy,
        action: row.action || null,
        acquisitionOrDisposition: row.acquisitionOrDisposition || null,
        shares: shares == null ? null : Math.abs(shares),
        price,
        total_val: finite(row.total_val) ?? (price != null && shares != null
          ? Math.abs(shares) * price / 1e6 : null),
        securitiesOwned: finite(row.securitiesOwned),
        url: safeHttpUrl(row.url),
        isCurated: row.isCurated === true || isCuratedCik(cik),
        securityName: row.securityName || null,
      };
    }
    const sharesRaw = finite(row.securitiesTransacted);
    if (sharesRaw == null) return null;
    const price = finite(row.price);
    const action = String(row.transactionType || row.action || '');
    const isBuy = /^P(?:-|$)/.test(action) ? true
      : /^S(?:-|$)/.test(action) ? false : null;
    const cik = padCik(row.reportingCik);
    return {
      symbol: ticker,
      filingDate: row.filingDate || null,
      transactionDate: row.transactionDate || null,
      date: row.filingDate || row.transactionDate || null,
      name: String(row.reportingName || row.name || 'Filer'),
      title: row.typeOfOwner || row.title || null,
      reportingCik: cik,
      companyCik: padCik(row.companyCik),
      formType: row.formType || '4',
      is_buy: isBuy,
      action: action || null,
      acquisitionOrDisposition: row.acquisitionOrDisposition || null,
      shares: Math.abs(sharesRaw),
      price,
      total_val: price != null ? Math.abs(sharesRaw) * price / 1e6 : null,
      securitiesOwned: finite(row.securitiesOwned),
      url: safeHttpUrl(row.url),
      isCurated: isCuratedCik(cik),
      securityName: row.securityName || null,
    };
  }

  function slimForm4Trades(rows, symbol, { limit = FORM4_TRADE_CAP } = {}) {
    const ticker = String(symbol || '').toUpperCase();
    const out = [];
    const seen = new Set();
    for (const row of rows || []) {
      const trade = normalizeForm4Trade(row, ticker);
      if (!trade) continue;
      const key = [
        trade.filingDate || '', trade.transactionDate || '', trade.reportingCik || '',
        trade.action || '', trade.shares ?? '', trade.price ?? '', trade.url || '',
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trade);
      if (out.length >= limit) break;
    }
    return out;
  }

  function loadForm4Cache(ticker) {
    const symbol = encodeURIComponent(String(ticker || '').toUpperCase());
    return fetch(`cache/smart-money/form4/${symbol}.json`, { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error(`FORM4_CACHE_MISS:${response.status}`);
      const body = await response.json();
      if (!body || body.ticker !== String(ticker).toUpperCase()) throw new Error('FORM4_CACHE_MISMATCH');
      const trades = slimForm4Trades(body.trades || body.insider_trades || [], body.ticker);
      return {
        ticker: body.ticker,
        source: body.seed ? 'cache' : (body.source?.provider || 'cache'),
        seed: body.seed === true,
        capturedAt: body.capturedAt || null,
        disclaimer: body.disclaimer || null,
        trades,
        raw: body,
      };
    });
  }

  function loadForm4Live(ticker, options = {}) {
    const symbol = String(ticker || '').toUpperCase();
    const limit = Math.max(1, Math.min(FORM4_LIVE_LIMIT, Number(options.limit) || FORM4_LIVE_LIMIT));
    const qs = new URLSearchParams({
      action: 'insider-trading',
      symbol,
      page: '0',
      limit: String(limit),
    });
    return fetch(`/api/fmp?${qs}`).then(async (response) => {
      if (!response.ok) {
        let detail = String(response.status);
        try {
          const body = await response.json();
          if (body?.error) detail = `${response.status}:${body.error}`;
        } catch { /* ignore */ }
        throw new Error(`FORM4_LIVE_FAILED:${detail}`);
      }
      const body = await response.json();
      const rows = Array.isArray(body) ? body : body?.data || [];
      return {
        ticker: symbol,
        source: 'live',
        seed: false,
        capturedAt: body?.source?.capturedAt || new Date().toISOString(),
        disclaimer: null,
        trades: slimForm4Trades(rows, symbol, { limit }),
        raw: body,
      };
    });
  }

  /**
   * Form 4 load order: committed seed → live FMP proxy → empty (honest).
   * Optional `stock.insider_trades` / `fallbackTrades` can fill when both miss (Profile meta).
   */
  function loadForm4(ticker, options = {}) {
    const symbol = String(ticker || '').toUpperCase();
    const skipLive = options.skipLive === true;
    const fallback = slimForm4Trades(
      options.fallbackTrades || options.stock?.insider_trades || [],
      symbol,
    );
    return loadForm4Cache(symbol).then((cached) => {
      if (cached.trades.length) return cached;
      throw new Error('FORM4_CACHE_EMPTY');
    }).catch((cacheError) => {
      if (skipLive) {
        if (fallback.length) {
          return {
            ticker: symbol,
            source: 'stock-meta',
            seed: false,
            capturedAt: null,
            disclaimer: null,
            trades: fallback,
            notice: String(cacheError.message || cacheError),
          };
        }
        return {
          ticker: symbol,
          source: 'empty',
          seed: false,
          capturedAt: null,
          trades: [],
          notice: String(cacheError.message || cacheError),
        };
      }
      return loadForm4Live(symbol, options).then((live) => {
        if (live.trades.length) return live;
        if (fallback.length) {
          return { ...live, source: 'stock-meta', trades: fallback, notice: 'FORM4_LIVE_EMPTY' };
        }
        return { ...live, source: 'empty', notice: 'FORM4_LIVE_EMPTY' };
      }).catch((liveError) => {
        if (fallback.length) {
          return {
            ticker: symbol,
            source: 'stock-meta',
            seed: false,
            capturedAt: null,
            trades: fallback,
            notice: String(liveError.message || liveError),
            cacheError: String(cacheError.message || cacheError),
          };
        }
        return {
          ticker: symbol,
          source: 'empty',
          seed: false,
          capturedAt: null,
          trades: [],
          notice: String(liveError.message || liveError),
          cacheError: String(cacheError.message || cacheError),
        };
      });
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
    const curated = BY_CIK[cik]
      || INVESTORS.find(row => slugify(row.nameEn) === slugify(payload.slug || payload.investorName || ''))
      || null;
    const slug = curated
      ? slugify(curated.nameEn)
      : (payload.slug && !looksLikeBareCik(payload.slug, cik)
        ? slugify(payload.slug)
        : fundSlugForCik(cik, curated));
    if (payload.investorName) registerHolderNames({ [cik]: payload.investorName });
    const quarters = payload.quarters || [];
    const latest = quarters[0];
    const summary = summarizeFundQuarter(latest?.rows || []);
    const history = payload.history || quarters.map(q => ({
      year: q.year, quarter: q.quarter, positions: (q.rows || []).length,
    }));
    return {
      cik,
      slug,
      investorName: resolveInvestorName({
        cik, curated, investorName: payload.investorName, slug,
      }),
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

  function loadStockFromCuratedOrEmpty(symbol, liveErrors, cacheError) {
    return loadCuratedByTickerIndex().then((index) => {
      const snapshot = snapshotFromCuratedIndex(symbol, index);
      if (snapshot && (snapshot.holders?.length || snapshot.exits?.length)) {
        return {
          ticker: symbol,
          source: 'curated-index',
          notice: 'CURATED_INVERT',
          capturedAt: index.capturedAt || null,
          snapshot,
          liveErrors: liveErrors || [],
          cacheError: cacheError ? String(cacheError.message || cacheError) : null,
        };
      }
      return emptyStockResult(
        symbol,
        'SMART_MONEY_NO_CURATED',
        liveErrors,
      );
    }).catch(() => emptyStockResult(
      symbol,
      liveErrors?.[0]
        ? `SMART_MONEY_NO_CURATED:${liveErrors[0]}`
        : 'SMART_MONEY_NO_CURATED',
      liveErrors,
    ));
  }

  function registerNamesFromStockRows(rows) {
    for (const row of rows || []) {
      const cik = padCik(row.cik);
      if (cik && row.investorName && !looksLikeBareCik(row.investorName, cik)) {
        registerHolderNames({ [cik]: row.investorName });
      }
    }
  }

  function loadStock(ticker, options = {}) {
    const symbol = String(ticker || '').toUpperCase();
    const skipLive = options.skipLive === true;
    // Warm CIK→name map so holder links never fall back to digits.
    const warmNames = loadHolderFundsIndex().catch(() => null);
    return warmNames.then(() => loadStockCache(symbol)).then((cached) => {
      for (const q of cached.quarters || []) registerNamesFromStockRows(q.rows);
      const current = (cached.quarters || [])[0];
      const prior = (cached.quarters || [])[1];
      const truncated = cached.source?.truncated === true
        || current?.truncated === true
        || cached.seed === true;
      if (current?.rows?.length) {
        const snapshot = buildStockSnapshot(symbol, current.rows, prior?.rows || [], {
          year: current.year, quarter: current.quarter, truncated,
        });
        return {
          ticker: symbol,
          source: 'cache',
          capturedAt: cached.capturedAt || null,
          snapshot,
          raw: cached,
          quartersOnFile: (cached.quarters || []).length,
        };
      }
      if (cached.snapshot?.holders?.length) {
        let snapshot = cached.snapshot;
        // Stale slim seeds may have invented −100% exits under per-Q caps — drop them.
        if (truncated && Array.isArray(snapshot.exits) && snapshot.exits.length) {
          const holders = snapshot.holders || [];
          snapshot = {
            ...snapshot,
            exits: [],
            exitsIncomplete: true,
            kpis: buildStockKpis(holders, []),
          };
        }
        return {
          ticker: symbol,
          source: 'cache',
          capturedAt: cached.capturedAt || null,
          snapshot,
          raw: cached,
        };
      }
      throw new Error('SMART_MONEY_CACHE_EMPTY');
    }).catch((cacheError) => {
      if (skipLive || options.preferCurated === true) {
        return loadStockFromCuratedOrEmpty(symbol, [], cacheError);
      }
      // Walk several filing quarters — newest calendar quarter is often sparse/empty.
      // Keep walking so holder timelines / allowlist names cover ≥8Q when FMP is live.
      const want = Math.max(2, Math.min(12, Number(options.liveQuarters) || LIVE_STOCK_QUARTERS));
      const needUsable = Math.max(2, Math.min(want, Number(options.needUsableQuarters) || 2));
      const specs = recentQuarterSpecs(want);
      // Sequential walk so we stop once we have enough usable quarters (saves shared FMP quota).
      const loaded = [];
      const liveErrors = [];
      const step = (index) => {
        if (index >= specs.length) return Promise.resolve();
        if (loaded.filter(q => q.rows?.length).length >= needUsable) return Promise.resolve();
        const spec = specs[index];
        return loadQuarterLive(symbol, spec.year, spec.quarter)
          .then((quarter) => {
            loaded.push(quarter);
            for (const row of quarter.rows || []) {
              const cik = padCik(row.cik);
              if (cik && row.investorName) registerHolderNames({ [cik]: row.investorName });
            }
          })
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
          // Preview / no FMP: never hard-fail common US names on FMP_NOT_CONFIGURED —
          // invert curated-20 seeds, or return an honest empty snapshot.
          return loadStockFromCuratedOrEmpty(symbol, liveErrors, cacheError);
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
          quartersOnFile: usable.length,
        };
      });
    });
  }

  function resolveFundIdentity(slugOrCik) {
    const raw = String(slugOrCik || '').trim();
    // fund-{cik} seed slug → treat as CIK identity with letter-prefixed route.
    const fundPrefixed = /^fund-(\d{7,10})$/i.exec(raw);
    if (fundPrefixed) {
      const asCik = padCik(fundPrefixed[1]);
      const curated = BY_CIK[asCik] || null;
      return {
        cik: asCik,
        slug: fundSlugForCik(asCik, curated),
        curated,
        openable: true,
        investorName: resolveInvestorName({ cik: asCik, curated }),
      };
    }
    const asCik = padCik(raw);
    if (asCik && /^\d{10}$/.test(asCik) && raw.replace(/\D/g, '').length >= 7) {
      const curated = BY_CIK[asCik] || null;
      // Any bare CIK is openable (seed / allowlisted live / honest empty).
      // Non-curated use fund-{cik} slug so titles/links never present digits as the route brand.
      return {
        cik: asCik,
        slug: fundSlugForCik(asCik, curated),
        curated,
        openable: true,
        investorName: resolveInvestorName({ cik: asCik, curated }),
      };
    }
    const slug = slugify(raw);
    const curated = BY_SLUG[slug] || null;
    if (curated) {
      return {
        cik: curated.cik,
        slug: slugify(curated.nameEn),
        curated,
        openable: true,
        investorName: curated.nameEn,
      };
    }
    // Unknown slug without CIK — not openable (no identity to load).
    return { cik: null, slug, curated: null, openable: false, investorName: null };
  }

  /** Every holder with a CIK links to #fund — curated use name slug; others use fund-{cik}. */
  function fundLinkForHolder(row) {
    if (!row || typeof row !== 'object') return null;
    const cik = padCik(row.cik);
    if (!cik) return null;
    if (row.investorName && !looksLikeBareCik(row.investorName, cik)) {
      registerHolderNames({ [cik]: row.investorName });
    }
    const curated = BY_CIK[cik] || row.curated
      || (row.slug ? BY_SLUG[slugify(row.slug)] : null)
      || (row.investorName ? BY_SLUG[slugify(row.investorName)] : null)
      || null;
    const slug = fundSlugForCik(cik, curated);
    return {
      slug,
      cik: curated?.cik || cik,
      href: fundHref(slug),
      curated: curated || null,
      investorName: resolveInvestorName({
        cik, curated, investorName: row.investorName, slug,
      }),
    };
  }

  function isOpenableFundKey(slugOrCik) {
    return Boolean(resolveFundIdentity(slugOrCik).openable);
  }

  /**
   * Invert stock holder seeds → per-CIK partial fund books (Preview without FMP).
   * Only symbols present in the stock seeds appear (not a full 13F universe).
   */
  function buildHolderFundIndex(stockPayloads) {
    const funds = Object.create(null);
    for (const payload of stockPayloads || []) {
      const symbol = String(payload?.ticker || '').toUpperCase();
      if (!symbol) continue;
      for (const q of payload.quarters || []) {
        const year = finite(q.year);
        const quarter = finite(q.quarter);
        const key = q.key || quarterKey(year, quarter);
        if (!key) continue;
        for (const row of q.rows || []) {
          const cik = padCik(row.cik);
          if (!cik) continue;
          if (!funds[cik]) {
            funds[cik] = {
              n: row.investorName || cik,
              q: Object.create(null),
            };
          }
          if (row.investorName) funds[cik].n = row.investorName;
          if (!funds[cik].q[key]) {
            funds[cik].q[key] = { y: year, q: quarter, r: [] };
          }
          funds[cik].q[key].r.push({
            s: symbol,
            sh: finite(row.sharesNumber ?? row.shares),
            v: finite(row.marketValue ?? row.value),
            w: finite(row.weight),
            d: row.date || undefined,
            f: row.filingDate || undefined,
          });
        }
      }
    }
    const slim = Object.create(null);
    for (const cik of Object.keys(funds).sort()) {
      const entry = funds[cik];
      const quarters = Object.keys(entry.q)
        .sort((a, b) => b.localeCompare(a))
        .map(key => entry.q[key]);
      slim[cik] = { n: entry.n, q: quarters };
    }
    return {
      capturedAt: new Date().toISOString(),
      seed: true,
      source: {
        provider: 'FMP',
        method: 'stock-holder-invert',
        note: 'Partial fund books inverted from committed stock holder seeds (Preview w/o FMP)',
      },
      count: Object.keys(slim).length,
      funds: slim,
      disclaimer: 'Partial books from stock demos only — not a full 13F filing. Filings lag up to ~45 days.',
    };
  }

  function expandHolderFundEntry(entry, cik) {
    if (!entry) return null;
    const padded = padCik(cik);
    if (entry.n) registerHolderNames({ [padded]: entry.n });
    const quarters = (entry.q || entry.quarters || []).map(q => ({
      year: q.y ?? q.year,
      quarter: q.q ?? q.quarter,
      key: quarterKey(q.y ?? q.year, q.q ?? q.quarter),
      rows: (q.r || q.rows || []).map(row => ({
        symbol: row.s || row.symbol,
        nameOfIssuer: row.s || row.symbol,
        shares: row.sh ?? row.shares,
        value: row.v ?? row.value ?? row.marketValue,
        marketValue: row.v ?? row.marketValue ?? row.value,
        weight: row.w ?? row.weight,
        date: row.d || row.date || null,
        filingDate: row.f || row.filingDate || null,
      })),
    })).filter(q => q.rows.length);
    if (!quarters.length) return null;
    return {
      cik: padded,
      slug: fundSlugForCik(padded),
      investorName: resolveInvestorName({
        cik: padded, investorName: entry.n || entry.investorName,
      }),
      capturedAt: null,
      seed: true,
      source: { method: 'stock-holder-invert', seed: true, partial: true },
      quarters,
      history: quarters.map(q => {
        const summary = summarizeFundQuarter(q.rows);
        return {
          year: q.year, quarter: q.quarter,
          positions: summary.positions, book: summary.book,
          largestWeight: summary.topWeight, top10Weight: summary.top10Weight,
          effectiveN: summary.effectiveN, topSymbol: summary.topSymbol,
        };
      }),
      disclaimer: 'Partial book from stock holder seeds — not the manager’s full 13F.',
    };
  }

  let holderFundsPromise = null;

  function loadHolderFundsIndex() {
    if (holderFundsPromise) return holderFundsPromise;
    holderFundsPromise = fetch('cache/smart-money/funds/holder-funds.json', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HOLDER_FUNDS_MISS:${response.status}`);
        const body = await response.json();
        registerExtractAllowlist(body.ciks || Object.keys(body.funds || {}));
        if (body.names) registerHolderNames(body.names);
        // Legacy invert payloads: funds[cik].n
        if (body.funds && typeof body.funds === 'object') {
          const fromFunds = {};
          for (const [cik, entry] of Object.entries(body.funds)) {
            if (entry?.n) fromFunds[cik] = entry.n;
            else if (entry?.investorName) fromFunds[cik] = entry.investorName;
          }
          registerHolderNames(fromFunds);
        }
        return body;
      })
      .catch((error) => {
        holderFundsPromise = null;
        throw error;
      });
    return holderFundsPromise;
  }

  function resetHolderFundsCache() {
    holderFundsPromise = null;
  }

  function emptyFundResult(identity, notice, liveErrors) {
    const compared = compareFundHoldings([], []);
    return {
      source: 'empty',
      notice: notice || 'FUND_BOOK_EMPTY',
      cik: identity.cik,
      slug: identity.slug,
      investorName: resolveInvestorName({
        cik: identity.cik,
        curated: identity.curated,
        investorName: identity.investorName,
        slug: identity.slug,
      }),
      curated: identity.curated,
      capturedAt: null,
      liveErrors: liveErrors || [],
      year: null,
      quarter: null,
      vsYear: null,
      vsQuarter: null,
      history: [],
      ...compared,
      kpis: { ...compared.kpis, quartersOnFile: 0 },
      concentration: concentrationFromHistory([]),
    };
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

    function titledMeta(partial, cachedName, liveName) {
      const cik = partial.cik || identity.cik;
      const curated = partial.curated || identity.curated || BY_CIK[cik] || null;
      const slug = partial.slug || identity.slug || fundSlugForCik(cik, curated);
      return {
        ...partial,
        cik,
        slug,
        curated,
        investorName: resolveInvestorName({
          cik,
          curated,
          investorName: cachedName || liveName || identity.investorName,
          slug,
        }),
      };
    }

    // Ensure holder-funds names are warm before resolving titles (no-op if already loaded).
    const ensureNames = loadHolderFundsIndex().catch(() => null);

    const fromCache = ensureNames.then(() => loadFundCache(identity.slug)
      .catch(() => (identity.cik ? loadFundCache(identity.cik) : Promise.reject(new Error('FUND_CACHE_MISS')))));

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
      if (cached.investorName) {
        registerHolderNames({ [cached.cik || identity.cik]: cached.investorName });
      }
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
      return packFundResult(titledMeta({
        source: 'cache',
        cik: cached.cik || identity.cik,
        slug: cached.slug || identity.slug,
        curated: identity.curated || BY_CIK[cached.cik] || null,
        capturedAt: cached.capturedAt || null,
      }, cached.investorName), current, prior, compared, historySource);
    }).catch((cacheError) => {
      // Invalid ?vs= must not fall through to "latest" — surface the parse error.
      if (String(cacheError?.message || '').startsWith('FUND_QUARTER_INVALID:')) {
        throw cacheError;
      }
      if (String(cacheError?.message || '').startsWith('FUND_QUARTER_NOT_FOUND:')) {
        throw cacheError;
      }
      if (!identity.cik) throw new Error('FUND_IDENTITY_UNKNOWN');

      // Prefer dedicated fund-{cik} / slug seeds (already tried above) or live extract.
      // Last resort: stock-holder invert from holder-funds.funds (Preview without Vercel
      // FMP_API_KEY). Clearly labeled partial — only symbols present in stock demo seeds.
      function packCachedBook(cached, liveErrors, sourceTag) {
        if (cached.investorName) {
          registerHolderNames({ [cached.cik || identity.cik]: cached.investorName });
        }
        const quarters = cached.quarters || [];
        const current = selectFundQuarter(quarters, vsParsed);
        if (!current) return emptyFundResult(identity, 'FUND_BOOK_EMPTY', liveErrors);
        const idx = quarters.indexOf(current);
        const prior = idx >= 0 ? quarters[idx + 1] : quarters[1];
        const currentHoldings = (current?.rows || []).map(row => normalizeFundHolding(row, cached.cik || identity.cik)).filter(Boolean);
        const priorHoldings = (prior?.rows || []).map(row => normalizeFundHolding(row, cached.cik || identity.cik)).filter(Boolean);
        const compared = compareFundHoldings(currentHoldings, priorHoldings);
        return packFundResult(titledMeta({
          source: sourceTag || 'cache',
          cik: cached.cik || identity.cik,
          slug: cached.slug || identity.slug,
          curated: identity.curated,
          capturedAt: cached.capturedAt || null,
          partial: Boolean(cached.source?.partial || sourceTag === 'seed-partial'),
          liveErrors: liveErrors || [],
        }, cached.investorName), current, prior, compared, cached.history?.length ? cached.history : quarters);
      }

      function fromPartialInvert(liveErrors) {
        return loadHolderFundsIndex().then((index) => {
          const entry = index?.funds?.[identity.cik];
          const expanded = expandHolderFundEntry(entry, identity.cik);
          if (!expanded?.quarters?.length) {
            return emptyFundResult(identity, 'FUND_BOOK_EMPTY', liveErrors);
          }
          return packCachedBook(expanded, liveErrors, 'seed-partial');
        }).catch(() => emptyFundResult(identity, 'FUND_BOOK_EMPTY', liveErrors));
      }

      function fromFullSeedOrEmpty(liveErrors) {
        return loadFundCache(`fund-${identity.cik}`).then((cached) => packCachedBook(cached, liveErrors, 'cache'))
          .catch(() => fromPartialInvert(liveErrors));
      }

      const liveCount = Math.max(2, Math.min(12, Number(options.liveQuarters) || LIVE_FUND_QUARTERS));
      const specs = vsParsed
        ? [vsParsed, priorQuarter(vsParsed.year, vsParsed.quarter)]
        : recentQuarterSpecs(liveCount);
      return ensureNames.then(() => Promise.all(specs.map(spec => loadFundLive(identity.cik, spec.year, spec.quarter)
        .catch(error => ({ year: spec.year, quarter: spec.quarter, rows: [], error, incomplete: true }))))
        .then((quarters) => {
          if (vsParsed) {
            const usableForVs = quarters.filter(q => !q.incomplete && !q.error);
            if (!usableForVs.length) {
              return fromFullSeedOrEmpty(quarters.filter(q => q.error).map(q => String(q.error.message || q.error)));
            }
            const current = selectFundQuarter(usableForVs, vsParsed);
            const priorSpec = priorQuarter(vsParsed.year, vsParsed.quarter);
            const prior = quarters.find(q => !q.incomplete && !q.error
              && Number(q.year) === priorSpec.year && Number(q.quarter) === priorSpec.quarter) || null;
            const currentHoldings = (current.rows || []).map(row => normalizeFundHolding(row, identity.cik)).filter(Boolean);
            const priorHoldings = (prior?.rows || []).map(row => normalizeFundHolding(row, identity.cik)).filter(Boolean);
            const compared = compareFundHoldings(currentHoldings, priorHoldings);
            const usable = quarters.filter(q => !q.incomplete && !q.error);
            return packFundResult(titledMeta({
              source: 'live',
              cik: identity.cik,
              slug: identity.slug,
              curated: identity.curated,
              capturedAt: new Date().toISOString(),
              liveErrors: quarters.filter(q => q.error).map(q => String(q.error.message || q.error)),
            }, null, current.investorName), current, prior, compared, usable);
          }
          const usable = quarters.filter(q => !q.incomplete && !q.error);
          if (!usable.length) {
            return fromFullSeedOrEmpty(quarters.filter(q => q.error).map(q => String(q.error.message || q.error)));
          }
          const current = usable[0];
          const prior = usable[1];
          const currentHoldings = current.rows.map(row => normalizeFundHolding(row, identity.cik)).filter(Boolean);
          const priorHoldings = (prior?.rows || []).map(row => normalizeFundHolding(row, identity.cik)).filter(Boolean);
          const compared = compareFundHoldings(currentHoldings, priorHoldings);
          return packFundResult(titledMeta({
            source: 'live',
            cik: identity.cik,
            slug: identity.slug,
            curated: identity.curated,
            capturedAt: new Date().toISOString(),
            liveErrors: quarters.filter(q => q.error).map(q => String(q.error.message || q.error)),
          }, null, current.investorName), current, prior, compared, usable);
        }));
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
    EXTRA_CIK_SET,
    HOLDER_NAME_BY_CIK,
    BY_CIK,
    BY_SLUG,
    FUND_EXTRACT_MAX,
    LIVE_FUND_QUARTERS,
    LIVE_STOCK_QUARTERS,
    FORM4_TRADE_CAP,
    FORM4_LIVE_LIMIT,
    padCik,
    finite,
    slugify,
    looksLikeBareCik,
    registerHolderNames,
    resetHolderNameMap,
    holderNameForCik,
    resolveInvestorName,
    fundSlugForCik,
    isUsListed,
    registerExtractAllowlist,
    allowedCik,
    isCuratedCik,
    fundLinkForHolder,
    isOpenableFundKey,
    buildHolderFundIndex,
    expandHolderFundEntry,
    loadHolderFundsIndex,
    resetHolderFundsCache,
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
    normalizeForm4Trade,
    slimForm4Trades,
    form4SideLabel,
    loadForm4Cache,
    loadForm4Live,
    loadForm4,
    fundSeedFilename,
    loadCuratedByTickerIndex,
    resetCuratedByTickerCache,
    buildCuratedByTickerIndex,
    snapshotFromCuratedIndex,
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
