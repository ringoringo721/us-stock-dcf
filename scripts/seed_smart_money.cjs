#!/usr/bin/env node
/**
 * Write slim Smart Money demo seeds for git (WhaleCreep UX preview).
 * Full captures stay local / CI-only via capture_smart_money.cjs.
 *
 * Seeds:
 *   cache/smart-money/TSM.json, STZ.json   (stock holders × 2 quarters)
 *   cache/smart-money/funds/{slug}.json    (all curated 20, multi-quarter)
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

const STOCK_HOLDER_CAP = 60;
const STOCK_QUARTERS = 2;
// 8–12 filing quarters; holdings capped so the PR stays Bugbot-reviewable.
const FUND_QUARTERS = 8;
const FUND_HOLDING_CAP = 22;
const STOCK_SEEDS = ['TSM', 'STZ'];
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
    return {
      year: q.year, quarter: q.quarter,
      key: q.key || SmartMoney.quarterKey(q.year, q.quarter),
      rows: slimRows,
    };
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

  // --- Stock seeds (TSM + STZ demo; arbitrary tickers use live path) ---
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
  if (missing.length) {
    console.warn(`Missing fund captures (need capture_smart_money.cjs --funds-only): ${missing.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`Seed complete — commit TSM/STZ + funds/[a-z]*.json + index (${SmartMoney.INVESTORS.length} managers)`);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
