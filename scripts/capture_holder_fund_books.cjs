#!/usr/bin/env node
/**
 * Capture full 13F books for managers that appear in committed stock holder seeds.
 * Writes cache/smart-money/funds/fund-{cik}.json (letter prefix → gitallow).
 *
 * Usage:
 *   FMP_API_KEY=… node scripts/capture_holder_fund_books.cjs [maxFunds=40] [quarters=8]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const SmartMoney = require('../smart_money.js');

const root = path.resolve(__dirname, '..');
const env = path.join(root, '.env.local');
if (fs.existsSync(env)) process.loadEnvFile(env);
const key = process.env.FMP_API_KEY;
if (!key) throw new Error('FMP_API_KEY is required');

const maxFunds = Math.max(5, Math.min(120, Number(process.argv[2]) || 40));
const quarterCount = Math.max(2, Math.min(12, Number(process.argv[3]) || 8));
const outDir = path.join(root, 'cache', 'smart-money');
const fundsDir = path.join(outDir, 'funds');
fs.mkdirSync(fundsDir, { recursive: true });

/** Prefer existing holder-funds names / prior captures over bare CIK. */
function loadNameHints() {
  const hints = Object.create(null);
  Object.assign(hints, PRIORITY_NAMES);
  const holderPath = path.join(fundsDir, 'holder-funds.json');
  if (fs.existsSync(holderPath)) {
    try {
      const body = JSON.parse(fs.readFileSync(holderPath, 'utf8'));
      Object.assign(hints, body.names || {});
    } catch { /* ignore */ }
  }
  for (const filename of fs.readdirSync(fundsDir)) {
    if (!/^fund-\d{10}\.json$/.test(filename)) continue;
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(fundsDir, filename), 'utf8'));
      const cik = SmartMoney.padCik(payload.cik || filename);
      if (cik && payload.investorName && !SmartMoney.looksLikeBareCik(payload.investorName, cik)) {
        hints[cik] = payload.investorName;
      }
    } catch { /* ignore */ }
  }
  return hints;
}

async function lookupCikName(cik) {
  try {
    const rows = await fmp('search-cik', { cik });
    const hit = Array.isArray(rows) ? rows.find(row => SmartMoney.padCik(row.cik) === cik) : null;
    const name = hit?.companyName || hit?.name || null;
    if (name && !SmartMoney.looksLikeBareCik(name, cik)) return name;
  } catch { /* optional */ }
  return null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fmp(pathname, params) {
  const url = new URL(`https://financialmodelingprep.com/stable/${pathname}`);
  for (const [name, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(name, String(value));
  }
  url.searchParams.set('apikey', key);
  const response = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
  if (!response.ok) {
    const err = new Error(`FMP_${response.status}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

async function datesFor(cik) {
  const rows = await fmp('institutional-ownership/dates', { cik });
  if (!Array.isArray(rows)) return [];
  return rows
    .map(row => ({
      year: Number(row.year),
      quarter: Number(row.quarter),
    }))
    .filter(row => Number.isInteger(row.year) && row.quarter >= 1 && row.quarter <= 4)
    .sort((a, b) => (b.year - a.year) || (b.quarter - a.quarter));
}

async function extract(cik, year, quarter) {
  const rows = await fmp('institutional-ownership/extract', { cik, year, quarter });
  return Array.isArray(rows) ? rows : [];
}

/** Skip mega custodians / banks — prefer WhaleCreep-style conviction managers. */
const MEGA_CUSTODIAN = new Set([
  '0002012383', '0000312069', '0001330387', '0000831001', '0000072971',
  '0000070858', '0001166588', '0001610520', '0001446194', '0000102909',
  '0001364742', '0000093751', '000102909', '0000352541', '0000093410',
  '0000080255', '0001426967', '0001102113', '0000913760',
]);
/** Always capture (GOOGL / demo managers users click). */
const PRIORITY_CIKS = [
  '0001484150', // Lindsell Train
  '0002147005', // Fenelon
  '0001848138', // Greenwoods
  '0001622346', // Shanda
  '0001759760', // H&H International
  '0001532262', // Greenbrier
  '0000937729', // Fayez Sarofim
  '0001731012', // Alphinity
  '0001475365', // Sumitomo Mitsui Trust (CIK-title bug example)
  '0000902528', // Bank Hapoalim (2Q bug example)
];
/** Hard names when stock seeds / search-cik omit the 13F manager title. */
const PRIORITY_NAMES = {
  '0001622346': 'SHANDA ASSET MANAGEMENT HOLDINGS LTD',
  '0001475365': 'SUMITOMO MITSUI TRUST GROUP, INC.',
  '0000902528': 'BANK HAPOALIM BM',
};

function collectTargets(nameHints) {
  const byCik = new Map();
  for (const filename of fs.readdirSync(outDir)) {
    if (!/^[A-Z0-9][A-Z0-9.-]*\.json$/.test(filename)) continue;
    let payload;
    try { payload = JSON.parse(fs.readFileSync(path.join(outDir, filename), 'utf8')); }
    catch { continue; }
    const ticker = payload.ticker || filename.replace(/\.json$/, '');
    // Scan all seeded stock quarters so older-quarter managers still get full books.
    for (const q of (payload.quarters || [])) {
      for (const row of q.rows || []) {
        const cik = SmartMoney.padCik(row.cik);
        if (!cik || SmartMoney.isCuratedCik(cik) || MEGA_CUSTODIAN.has(cik)) continue;
        const hinted = nameHints[cik];
        const rowName = row.investorName && !SmartMoney.looksLikeBareCik(row.investorName, cik)
          ? row.investorName
          : null;
        if (!byCik.has(cik)) {
          byCik.set(cik, {
            cik,
            investorName: rowName || hinted || null,
            maxWeight: 0,
            maxValue: 0,
            tickers: new Set(),
            priority: PRIORITY_CIKS.includes(cik) ? 1 : 0,
          });
        }
        const entry = byCik.get(cik);
        entry.tickers.add(ticker);
        if (rowName) entry.investorName = rowName;
        else if (!entry.investorName && hinted) entry.investorName = hinted;
        entry.maxWeight = Math.max(entry.maxWeight, Number(row.weight) || 0);
        entry.maxValue = Math.max(entry.maxValue, Number(row.marketValue) || 0);
        if (PRIORITY_CIKS.includes(cik)) entry.priority = 1;
      }
    }
  }
  for (const cik of PRIORITY_CIKS) {
    if (byCik.has(cik) || MEGA_CUSTODIAN.has(cik) || SmartMoney.isCuratedCik(cik)) continue;
    byCik.set(cik, {
      cik,
      investorName: nameHints[cik] || null,
      maxWeight: 0,
      maxValue: 0,
      tickers: new Set(),
      priority: 1,
    });
  }
  return [...byCik.values()]
    .sort((a, b) => b.priority - a.priority
      || b.maxWeight - a.maxWeight
      || b.maxValue - a.maxValue)
    .slice(0, maxFunds);
}

(async () => {
  const nameHints = loadNameHints();
  const targets = collectTargets(nameHints);
  console.log(`Capturing ${targets.length} non-curated fund books × ${quarterCount}Q`);
  for (const fund of targets) {
    const outPath = path.join(fundsDir, `fund-${fund.cik}.json`);
    if (!fund.investorName) {
      const lookedUp = await lookupCikName(fund.cik);
      if (lookedUp) fund.investorName = lookedUp;
      await sleep(120);
    }
    let filings;
    try {
      filings = (await datesFor(fund.cik)).slice(0, quarterCount + 1);
    } catch (error) {
      console.warn(`${fund.cik} dates failed: ${error.message}`);
      await sleep(250);
      continue;
    }
    await sleep(150);
    const quarters = [];
    for (const filing of filings.slice(0, quarterCount)) {
      let rows;
      try {
        rows = await extract(fund.cik, filing.year, filing.quarter);
      } catch (error) {
        console.warn(`${fund.cik} ${filing.year}Q${filing.quarter}: ${error.message}`);
        await sleep(350);
        continue;
      }
      await sleep(150);
      const capped = rows.slice(0, SmartMoney.FUND_EXTRACT_MAX).map(row => ({
        symbol: row.symbol,
        nameOfIssuer: row.nameOfIssuer || row.securityName,
        industryTitle: row.industryTitle || row.sector,
        shares: row.shares ?? row.sharesNumber,
        value: row.value ?? row.marketValue,
        weight: row.weight,
        filingDate: row.filingDate,
        date: row.date,
        securityCusip: row.securityCusip || row.cusip,
        titleOfClass: row.titleOfClass,
      }));
      if (!capped.length) continue;
      quarters.push({
        year: filing.year,
        quarter: filing.quarter,
        key: SmartMoney.quarterKey(filing.year, filing.quarter),
        rows: capped,
      });
      console.log(`fund-${fund.cik} ${filing.year}-Q${filing.quarter}: ${capped.length} positions (${fund.investorName || 'unnamed'})`);
    }
    if (!quarters.length) continue;
    const history = quarters.map(q => {
      const summary = SmartMoney.summarizeFundQuarter(q.rows);
      return {
        year: q.year, quarter: q.quarter,
        positions: summary.positions, book: summary.book,
        largestWeight: summary.topWeight, top10Weight: summary.top10Weight,
        effectiveN: summary.effectiveN, topSymbol: summary.topSymbol,
      };
    });
    const investorName = SmartMoney.resolveInvestorName({
      cik: fund.cik,
      investorName: fund.investorName || nameHints[fund.cik],
    });
    const payload = {
      cik: fund.cik,
      slug: `fund-${fund.cik}`,
      investorName,
      capturedAt: new Date().toISOString(),
      source: {
        provider: 'FMP',
        method: 'institutional-ownership/extract',
        cappedAt: SmartMoney.FUND_EXTRACT_MAX,
        fullBook: true,
        quartersRequested: quarterCount,
      },
      quarters,
      history,
      disclaimer: '13F filings lag up to ~45 days after quarter-end; not real-time holdings.',
    };
    fs.writeFileSync(outPath, `${JSON.stringify(payload)}\n`);
    console.log(`Wrote ${outPath} name=${investorName || '—'} q=${quarters.length} bytes=${fs.statSync(outPath).size}`);
  }
  console.log('Done. Run: node scripts/seed_smart_money.cjs --from-cache');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
