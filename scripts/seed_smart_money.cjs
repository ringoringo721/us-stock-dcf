#!/usr/bin/env node
/**
 * Write small demo Smart Money seeds for git (WhaleCreep UX preview).
 * Full captures stay local / CI-only via capture_smart_money.cjs — do not commit megabyte books.
 *
 * Prefer FMP live + these seeds:
 *   cache/smart-money/TSM.json          (top holders × 2 quarters)
 *   cache/smart-money/funds/berkshire-hathaway.json
 *   cache/smart-money/funds/index.json  (curated directory summaries)
 *
 * Usage:
 *   FMP_API_KEY=… node scripts/seed_smart_money.cjs
 *   node scripts/seed_smart_money.cjs --from-cache   # slim existing local captures
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

const STOCK_HOLDER_CAP = 60;
const STOCK_QUARTERS = 2;
const FUND_QUARTERS = 4;
const SEED_FIELDS = [
  'date', 'filingDate', 'cik', 'investorName', 'symbol',
  'sharesNumber', 'lastSharesNumber', 'changeInSharesNumber',
  'changeInSharesNumberPercentage', 'marketValue', 'lastMarketValue',
  'weight', 'ownership', 'year', 'quarter', 'isNew', 'isSoldOut', 'isCurated',
];
const FUND_FIELDS = [
  'symbol', 'nameOfIssuer', 'industryTitle', 'sector', 'shares', 'value',
  'marketValue', 'weight', 'filingDate', 'date', 'securityCusip', 'cusip',
  'titleOfClass', 'cik', 'year', 'quarter',
];

function pick(row, fields) {
  const out = {};
  for (const key of fields) {
    if (row[key] != null && row[key] !== '') out[key] = row[key];
  }
  return out;
}

function slimStockPayload(payload, { holderCap = STOCK_HOLDER_CAP, quarters = STOCK_QUARTERS } = {}) {
  const kept = (payload.quarters || []).slice(0, quarters).map(q => {
    const rows = [...(q.rows || [])]
      .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0)
        || (Number(b.marketValue) || 0) - (Number(a.marketValue) || 0));
    const curated = rows.filter(row => SmartMoney.allowedCik(row.cik));
    const top = rows.slice(0, holderCap);
    const byCik = new Map();
    for (const row of [...top, ...curated]) {
      const cik = SmartMoney.padCik(row.cik);
      if (!cik) continue;
      if (!byCik.has(cik)) byCik.set(cik, pick(row, SEED_FIELDS));
    }
    const slimRows = [...byCik.values()];
    return { year: q.year, quarter: q.quarter, key: q.key || SmartMoney.quarterKey(q.year, q.quarter), rows: slimRows };
  }).filter(q => q.rows.length);

  const snapshot = kept.length
    ? SmartMoney.buildStockSnapshot(payload.ticker, kept[0].rows, kept[1]?.rows || [], {
      year: kept[0].year, quarter: kept[0].quarter,
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
      note: 'Demo seed — full books via capture_smart_money.cjs or live FMP',
    },
    quarters: kept,
    snapshot,
    disclaimer: '13F filings lag up to ~45 days after quarter-end; not real-time holdings.',
  };
}

function slimFundPayload(payload, { quarters = FUND_QUARTERS } = {}) {
  const kept = (payload.quarters || []).slice(0, quarters).map(q => ({
    year: q.year,
    quarter: q.quarter,
    key: q.key || SmartMoney.quarterKey(q.year, q.quarter),
    rows: (q.rows || []).map(row => pick(row, FUND_FIELDS)),
  })).filter(q => q.rows.length);

  const history = kept.map(q => {
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
      note: 'Demo seed — full history via capture_smart_money.cjs or live FMP',
    },
    quarters: kept,
    history,
    disclaimer: '13F filings lag up to ~45 days after quarter-end; not real-time holdings.',
  };
}

function writeIndex(managers) {
  managers.sort((a, b) => (b.book ?? 0) - (a.book ?? 0));
  const index = {
    capturedAt: new Date().toISOString(),
    seed: true,
    source: { provider: 'FMP', method: 'seed-directory', note: 'Summaries only; fund books load from seed or live extract' },
    latestKey: managers[0]?.key || null,
    count: managers.length,
    managers,
    disclaimer: '13F filings lag up to ~45 days after quarter-end; not real-time holdings.',
  };
  fs.writeFileSync(path.join(fundsDir, 'index.json'), `${JSON.stringify(index)}\n`);
  return index;
}

(async () => {
  const key = process.env.FMP_API_KEY;
  if (!fromCacheOnly && !key) throw new Error('FMP_API_KEY required unless --from-cache');

  // --- TSM stock seed ---
  let tsmSrc;
  const tsmPath = path.join(outDir, 'TSM.json');
  if (fromCacheOnly || fs.existsSync(tsmPath)) {
    tsmSrc = JSON.parse(fs.readFileSync(tsmPath, 'utf8'));
  } else {
    // Minimal inline capture for TSM only
    const { spawnSync } = require('node:child_process');
    const run = spawnSync(process.execPath, [
      path.join(__dirname, 'capture_smart_money.cjs'), 'TSM', String(STOCK_QUARTERS), '2',
    ], { env: process.env, encoding: 'utf8' });
    if (run.status !== 0) {
      console.error(run.stderr || run.stdout);
      throw new Error('capture_smart_money failed for TSM seed');
    }
    tsmSrc = JSON.parse(fs.readFileSync(tsmPath, 'utf8'));
  }
  const tsmSeed = slimStockPayload(tsmSrc);
  fs.writeFileSync(tsmPath, `${JSON.stringify(tsmSeed)}\n`);
  console.log(`Wrote ${tsmPath} holders=${tsmSeed.quarters[0]?.rows.length || 0} bytes=${fs.statSync(tsmPath).size}`);

  // --- Berkshire fund seed ---
  const brkSlugPath = path.join(fundsDir, 'berkshire-hathaway.json');
  let brkSrc;
  if (fs.existsSync(brkSlugPath)) {
    brkSrc = JSON.parse(fs.readFileSync(brkSlugPath, 'utf8'));
  } else if (!fromCacheOnly) {
    // Fetch a few quarters directly
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    async function fmp(pathname, params) {
      const url = new URL(`https://financialmodelingprep.com/stable/${pathname}`);
      for (const [n, v] of Object.entries(params)) if (v != null) url.searchParams.set(n, String(v));
      url.searchParams.set('apikey', key);
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`FMP_${res.status}`);
      return res.json();
    }
    const cik = '0001067983';
    const dates = await fmp('institutional-ownership/dates', { cik });
    const filings = (dates || [])
      .map(r => ({ year: Number(r.year), quarter: Number(r.quarter) }))
      .filter(r => r.year && r.quarter >= 1 && r.quarter <= 4)
      .sort((a, b) => (b.year - a.year) || (b.quarter - a.quarter))
      .slice(0, FUND_QUARTERS);
    const quarters = [];
    for (const f of filings) {
      const rows = await fmp('institutional-ownership/extract', { cik, year: f.year, quarter: f.quarter });
      await sleep(120);
      const list = Array.isArray(rows) ? rows.slice(0, SmartMoney.FUND_EXTRACT_MAX) : [];
      if (!list.length) continue;
      quarters.push({
        year: f.year, quarter: f.quarter, key: SmartMoney.quarterKey(f.year, f.quarter),
        rows: list.map(row => ({ ...row, cik, year: f.year, quarter: f.quarter })),
      });
    }
    brkSrc = {
      cik, slug: 'berkshire-hathaway', investorName: 'Berkshire Hathaway',
      capturedAt: new Date().toISOString(), quarters,
    };
  } else {
    throw new Error('Missing berkshire-hathaway.json for --from-cache');
  }
  const brkSeed = slimFundPayload(brkSrc);
  fs.writeFileSync(brkSlugPath, `${JSON.stringify(brkSeed)}\n`);
  console.log(`Wrote ${brkSlugPath} positions=${brkSeed.quarters[0]?.rows.length || 0} q=${brkSeed.quarters.length} bytes=${fs.statSync(brkSlugPath).size}`);

  // --- Directory index: curated 20 summaries (Berkshire from seed; others stub/live) ---
  const managers = [];
  for (const inv of SmartMoney.INVESTORS) {
    const slug = SmartMoney.slugify(inv.nameEn);
    if (slug === 'berkshire-hathaway') {
      managers.push(SmartMoney.buildFundDirectoryEntry(brkSeed));
      continue;
    }
    const local = path.join(fundsDir, `${slug}.json`);
    if (fs.existsSync(local) && !String(fs.readFileSync(local, 'utf8')).includes('"seed": true')) {
      // Optional: summarize a local full capture without committing it
      try {
        const full = JSON.parse(fs.readFileSync(local, 'utf8'));
        const entry = SmartMoney.buildFundDirectoryEntry(slimFundPayload(full, { quarters: 1 }));
        if (entry) {
          managers.push(entry);
          continue;
        }
      } catch { /* fall through */ }
    }
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
  }
  const index = writeIndex(managers.filter(Boolean));
  console.log(`Wrote funds/index.json managers=${index.count} bytes=${fs.statSync(path.join(fundsDir, 'index.json')).size}`);
  console.log('Seed complete — commit only TSM.json, funds/berkshire-hathaway.json, funds/index.json');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
