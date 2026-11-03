#!/usr/bin/env node
/**
 * Write slim Smart Money demo seeds for git (WhaleCreep UX preview).
 * Full captures stay local / CI-only via capture_smart_money.cjs.
 *
 * Seeds:
 *   cache/smart-money/{NVDA,AAPL,MSFT,…}.json  (liquid US holders × 2Q — richer demos)
 *   cache/smart-money/curated-by-ticker.json    (curated-20 invert → all US tickers they hold)
 *   cache/smart-money/funds/{slug}.json         (all curated 20, multi-quarter)
 *   cache/smart-money/funds/index.json
 *
 * Usage:
 *   FMP_API_KEY=… node scripts/seed_smart_money.cjs
 *   node scripts/seed_smart_money.cjs --from-cache
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const SmartMoney = require('../smart_money.js');

const root = path.resolve(__dirname, '..');
const env = path.join(root, '.env.local');
if (fs.existsSync(env)) process.loadEnvFile(env);

const fromCacheOnly = process.argv.includes('--from-cache');
const outDir = path.join(root, 'cache', 'smart-money');
const fundsDir = path.join(outDir, 'funds');
fs.mkdirSync(fundsDir, { recursive: true });

const STOCK_HOLDER_CAP = 65;
const STOCK_QUARTERS = 2;
// Curated funds: 8–12Q; non-curated full books: 2Q × deep holdings (WhaleCreep detail).
const FUND_QUARTERS = 8;
const FUND_HOLDING_CAP = 22;
const EXTRA_FUND_QUARTERS = 2;
const EXTRA_FUND_HOLDING_CAP = 150;
/** Liquid / mega-cap US — full holder tables on Preview without FMP_API_KEY. */
const STOCK_SEEDS = [
  'NVDA', 'AAPL', 'MSFT', 'META', 'GOOGL', 'AMZN', 'TSLA', 'TSM', 'STZ',
  'JPM', 'V', 'MA', 'BRK-B', 'JNJ', 'WMT', 'XOM', 'UNH', 'HD', 'BAC',
  'AVGO', 'COST', 'KO', 'PEP', 'ABBV', 'CRM', 'AMD', 'ORCL', 'NFLX', 'PLTR',
];
const SEED_FIELDS = [
  'date', 'filingDate', 'cik', 'investorName', 'symbol',
  'sharesNumber', 'lastSharesNumber', 'changeInSharesNumber',
  'changeInSharesNumberPercentage', 'marketValue', 'lastMarketValue',
  'weight', 'ownership', 'year', 'quarter', 'isNew', 'isSoldOut', 'isCurated',
];
const FUND_FIELDS = [
  'symbol', 'nameOfIssuer', 'industryTitle', 'sector', 'shares', 'value',
  'marketValue', 'weight', 'filingDate', 'date', 'securityCusip', 'cusip',
  'titleOfClass',
];

function pick(row, fields) {
  const out = {};
  for (const key of fields) {
    if (row[key] != null && row[key] !== '') out[key] = row[key];
  }
  return out;
}

function slimStockPayload(payload, { holderCap = STOCK_HOLDER_CAP, quarters = STOCK_QUARTERS } = {}) {
  const sourceQuarters = (payload.quarters || []).slice(0, quarters);
  // Union CIKs across quarters first (top-N per Q + curated). Independent per-quarter
  // caps invent false −100% exits when a manager only drops off the newer top-N.
  const seedCiks = new Set();
  for (const q of sourceQuarters) {
    const ranked = [...(q.rows || [])]
      .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0)
        || (Number(b.marketValue) || 0) - (Number(a.marketValue) || 0));
    for (const row of ranked.slice(0, holderCap)) {
      const cik = SmartMoney.padCik(row.cik);
      if (cik) seedCiks.add(cik);
    }
    for (const row of ranked) {
      if (!SmartMoney.isCuratedCik(row.cik)) continue;
      const cik = SmartMoney.padCik(row.cik);
      if (cik) seedCiks.add(cik);
    }
  }

  const kept = sourceQuarters.map(q => {
    const byCik = new Map();
    for (const row of q.rows || []) {
      const cik = SmartMoney.padCik(row.cik);
      if (!cik || !seedCiks.has(cik) || byCik.has(cik)) continue;
      byCik.set(cik, pick(row, SEED_FIELDS));
    }
    const slimRows = [...byCik.values()]
      .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0)
        || (Number(b.marketValue) || 0) - (Number(a.marketValue) || 0));
    return {
      year: q.year, quarter: q.quarter,
      key: q.key || SmartMoney.quarterKey(q.year, q.quarter),
      rows: slimRows,
      truncated: true,
    };
  }).filter(q => q.rows.length);

  // Truncated books: never synthesize exits (−100%) — union above keeps continuity
  // for still-held names; true full-universe exits need live/uncapped captures.
  const snapshot = kept.length
    ? SmartMoney.buildStockSnapshot(payload.ticker, kept[0].rows, kept[1]?.rows || [], {
      year: kept[0].year, quarter: kept[0].quarter, truncated: true,
    })
    : null;

  return {
    ticker: payload.ticker,
    capturedAt: payload.capturedAt || new Date().toISOString(),
    seed: true,
    source: {
      ...(payload.source || {}),
      seed: true,
      holderCap,
      quarters: kept.length,
      truncated: true,
      seedCikCount: seedCiks.size,
      note: 'Demo seed — CIKs unioned across quarters; exits incomplete under holderCap (no false −100%)',
    },
    quarters: kept,
    snapshot,
    disclaimer: '13F filings lag up to ~45 days after quarter-end; not real-time holdings.',
  };
}

function slimFundPayload(payload, {
  quarters = FUND_QUARTERS,
  holdingCap = FUND_HOLDING_CAP,
} = {}) {
  const kept = (payload.quarters || []).slice(0, quarters).map(q => {
    const ranked = [...(q.rows || [])]
      .sort((a, b) => (Number(b.value ?? b.marketValue) || 0) - (Number(a.value ?? a.marketValue) || 0)
        || (Number(b.weight) || 0) - (Number(a.weight) || 0));
    // Small books stay whole; large books truncate to keep PR slim.
    const rows = ranked.slice(0, holdingCap).map(row => pick(row, FUND_FIELDS));
    return {
      year: q.year,
      quarter: q.quarter,
      key: q.key || SmartMoney.quarterKey(q.year, q.quarter),
      rows,
    };
  }).filter(q => q.rows.length);

  // History must align with seeded quarters so ?vs= options always resolve to a book.
  const fullHistory = Array.isArray(payload.history) ? payload.history : [];
  const historyOut = kept.map(q => {
    const fromFull = fullHistory.find(h => Number(h.year) === Number(q.year)
      && Number(h.quarter) === Number(q.quarter));
    if (fromFull && (fromFull.positions != null || fromFull.book != null)) {
      return {
        year: q.year, quarter: q.quarter,
        positions: fromFull.positions,
        book: fromFull.book,
        largestWeight: fromFull.largestWeight,
        top10Weight: fromFull.top10Weight,
        effectiveN: fromFull.effectiveN,
        topSymbol: fromFull.topSymbol,
      };
    }
    const summary = SmartMoney.summarizeFundQuarter(q.rows);
    return {
      year: q.year, quarter: q.quarter,
      positions: summary.positions, book: summary.book,
      largestWeight: summary.topWeight, top10Weight: summary.top10Weight,
      effectiveN: summary.effectiveN, topSymbol: summary.topSymbol,
    };
  });

  return {
    cik: payload.cik,
    slug: payload.slug,
    investorName: payload.investorName,
    capturedAt: payload.capturedAt || new Date().toISOString(),
    seed: true,
    source: {
      ...(payload.source || {}),
      seed: true,
      quarters: kept.length,
      holdingCap,
      note: 'Demo seed — holdings capped per quarter; full books via capture or allowlisted live',
    },
    quarters: kept,
    history: historyOut,
    disclaimer: '13F filings lag up to ~45 days after quarter-end; not real-time holdings.',
  };
}

function writeIndex(managers) {
  managers.sort((a, b) => (b.book ?? 0) - (a.book ?? 0));
  const index = {
    capturedAt: new Date().toISOString(),
    seed: true,
    source: {
      provider: 'FMP',
      method: 'seed-directory',
      note: 'Summaries for curated 20; fund books load from seed JSON then allowlisted live extract',
    },
    latestKey: managers[0]?.key || null,
    count: managers.length,
    managers,
    disclaimer: '13F filings lag up to ~45 days after quarter-end; not real-time holdings.',
  };
  fs.writeFileSync(path.join(fundsDir, 'index.json'), `${JSON.stringify(index)}\n`);
  return index;
}

function readFundSource(inv) {
  const slug = SmartMoney.slugify(inv.nameEn);
  const slugPath = path.join(fundsDir, `${slug}.json`);
  const cikPath = path.join(fundsDir, `${inv.cik}.json`);
  let best = null;
  for (const candidate of [cikPath, slugPath]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const payload = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const q = (payload.quarters || []).filter(row => (row.rows || []).length);
      if (!q.length) continue;
      // Prefer fuller (usually non-seed CIK) captures when re-sliming.
      if (!best || q.length > (best.payload.quarters || []).length
          || (q.length === (best.payload.quarters || []).length && !payload.seed && best.payload.seed)) {
        best = { slug, payload, path: candidate };
      }
    } catch { /* try next */ }
  }
  return best || { slug, payload: null, path: null };
}

(async () => {
  const key = process.env.FMP_API_KEY;
  if (!fromCacheOnly && !key) throw new Error('FMP_API_KEY required unless --from-cache');

  // --- Stock seeds (liquid US demos; other tickers use live when FMP is configured) ---
  for (const ticker of STOCK_SEEDS) {
    const stockPath = path.join(outDir, `${ticker}.json`);
    let src = null;
    if (fs.existsSync(stockPath)) {
      src = JSON.parse(fs.readFileSync(stockPath, 'utf8'));
    } else if (!fromCacheOnly) {
      const { spawnSync } = require('node:child_process');
      const run = spawnSync(process.execPath, [
        path.join(__dirname, 'capture_smart_money.cjs'),
        '--stocks-only', ticker, String(STOCK_QUARTERS), '2',
      ], { env: process.env, encoding: 'utf8' });
      if (run.status !== 0) {
        console.warn(run.stderr || run.stdout);
        console.warn(`skip stock seed ${ticker}: capture failed`);
        continue;
      }
      src = JSON.parse(fs.readFileSync(stockPath, 'utf8'));
    } else {
      console.warn(`skip stock seed ${ticker}: missing cache`);
      continue;
    }
    const seed = slimStockPayload(src);
    fs.writeFileSync(stockPath, `${JSON.stringify(seed)}\n`);
    console.log(`Wrote ${stockPath} holders=${seed.quarters[0]?.rows.length || 0} q=${seed.quarters.length} bytes=${fs.statSync(stockPath).size}`);
  }

  // --- Curated fund seeds (all 20, multi-quarter, holdings capped) ---
  const managers = [];
  const missing = [];
  for (const inv of SmartMoney.INVESTORS) {
    const { slug, payload } = readFundSource(inv);
    if (!payload) {
      missing.push(slug);
      managers.push({
        cik: inv.cik,
        slug,
        investorName: inv.nameEn,
        curated: inv,
        isCurated: true,
        style: inv.style,
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
      });
      continue;
    }
    // Berkshire gets deeper history (WhaleCreep-style); others stay 8Q for PR size.
    const quarterBudget = slug === 'berkshire-hathaway' ? 12 : FUND_QUARTERS;
    const seeded = slimFundPayload({
      ...payload,
      cik: payload.cik || inv.cik,
      slug,
      investorName: payload.investorName || inv.nameEn,
    }, { quarters: quarterBudget });
    const outPath = path.join(fundsDir, `${slug}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(seeded)}\n`);
    console.log(`Wrote ${outPath} positions=${seeded.quarters[0]?.rows.length || 0} q=${seeded.quarters.length} hist=${seeded.history.length} bytes=${fs.statSync(outPath).size}`);
    managers.push(SmartMoney.buildFundDirectoryEntry(seeded));
  }

  const index = writeIndex(managers.filter(Boolean));
  console.log(`Wrote funds/index.json managers=${index.count} bytes=${fs.statSync(path.join(fundsDir, 'index.json')).size}`);

  // Invert curated fund books → per-ticker index so Preview without FMP covers
  // every US name the curated 20 hold (not just a mega-cap seed list).
  const fundPayloads = [];
  for (const inv of SmartMoney.INVESTORS) {
    const slug = SmartMoney.slugify(inv.nameEn);
    const slugPath = path.join(fundsDir, `${slug}.json`);
    if (!fs.existsSync(slugPath)) continue;
    try {
      fundPayloads.push(JSON.parse(fs.readFileSync(slugPath, 'utf8')));
    } catch { /* skip */ }
  }
  const byTicker = SmartMoney.buildCuratedByTickerIndex(fundPayloads, { quarters: 2 });
  const byTickerPath = path.join(outDir, 'curated-by-ticker.json');
  fs.writeFileSync(byTickerPath, `${JSON.stringify(byTicker)}\n`);
  console.log(`Wrote ${byTickerPath} tickers=${byTicker.count} bytes=${fs.statSync(byTickerPath).size}`);

  // Allowlist + optional partial invert index (links / extract gate — not shown as full books).
  const stockPayloads = [];
  for (const ticker of STOCK_SEEDS) {
    const stockPath = path.join(outDir, `${ticker}.json`);
    if (!fs.existsSync(stockPath)) continue;
    try { stockPayloads.push(JSON.parse(fs.readFileSync(stockPath, 'utf8'))); }
    catch { /* skip */ }
  }
  // Slim allowlist index (CIKs only) — full books live in fund-{cik}.json, not stock-invert stubs.
  const holderFunds = SmartMoney.buildHolderFundIndex(stockPayloads);
  const allowCiks = Object.keys(holderFunds.funds || {}).sort();
  // Also allow every committed fund-{cik} book.
  for (const filename of fs.readdirSync(fundsDir)) {
    const m = /^fund-(\d{10})\.json$/.exec(filename);
    if (m) allowCiks.push(m[1]);
  }
  const uniqueAllow = [...new Set(allowCiks)];
  const holderFundsPath = path.join(fundsDir, 'holder-funds.json');
  const holderFundsSlim = {
    capturedAt: new Date().toISOString(),
    seed: true,
    source: {
      provider: 'FMP',
      method: 'extract-allowlist',
      note: 'CIK allowlist for institutional-extract; full books in fund-{cik}.json / curated slugs',
    },
    count: uniqueAllow.length,
    ciks: uniqueAllow,
    // Keep compact name map for fund page titles when opening by CIK.
    names: Object.fromEntries(
      uniqueAllow.map(cik => [cik, holderFunds.funds?.[cik]?.n || null]).filter(([, n]) => n),
    ),
    disclaimer: 'Allowlist only — open fund-{cik} seeds or live extract for full 13F books.',
  };
  fs.writeFileSync(holderFundsPath, `${JSON.stringify(holderFundsSlim)}\n`);
  SmartMoney.registerExtractAllowlist(uniqueAllow);
  console.log(`Wrote ${holderFundsPath} ciks=${holderFundsSlim.count} bytes=${fs.statSync(holderFundsPath).size}`);

  // Slim full 13F books for non-curated managers: funds/fund-{cik}.json
  // (from capture_holder_fund_books.cjs / local CIK captures).
  let extraFundCount = 0;
  const seenExtra = new Set();
  for (const filename of fs.readdirSync(fundsDir)) {
    const cikMatch = /^(?:fund-)?(\d{10})\.json$/.exec(filename);
    if (!cikMatch) continue;
    const cik = cikMatch[1];
    if (seenExtra.has(cik) || SmartMoney.isCuratedCik(cik)) continue;
    seenExtra.add(cik);
    let payload;
    try { payload = JSON.parse(fs.readFileSync(path.join(fundsDir, filename), 'utf8')); }
    catch { continue; }
    if (!(payload.quarters || []).length) continue;
    const seeded = slimFundPayload({
      ...payload,
      cik,
      slug: payload.slug || `fund-${cik}`,
      investorName: payload.investorName || holderFunds.funds?.[cik]?.n || cik,
    }, { quarters: EXTRA_FUND_QUARTERS, holdingCap: EXTRA_FUND_HOLDING_CAP });
    // Keep deeper books for WhaleCreep fund detail (not the curated 22-cap).
    const outName = `fund-${cik}.json`;
    const outPath = path.join(fundsDir, outName);
    fs.writeFileSync(outPath, `${JSON.stringify(seeded)}\n`);
    extraFundCount += 1;
    console.log(`Wrote ${outPath} positions=${seeded.quarters[0]?.rows.length || 0} q=${seeded.quarters.length} bytes=${fs.statSync(outPath).size}`);
  }

  if (missing.length) {
    console.warn(`Missing fund captures (need capture_smart_money.cjs --funds-only): ${missing.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`Seed complete — stocks + curated-by-ticker (${byTicker.count}) + holder-funds (${holderFunds.count}) + curated (${SmartMoney.INVESTORS.length}) + fund-CIK books (${extraFundCount})`);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
