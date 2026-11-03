#!/usr/bin/env node
/**
 * WhaleCreep-style Smart Money capture.
 * 1) Per-ticker broad FMP extract-analytics/holder → cache/smart-money/{TICKER}.json
 * 2) Curated (and optional extra) fund books via extract → cache/smart-money/funds/{slug}.json
 *
 * Usage:
 *   FMP_API_KEY=… node scripts/capture_smart_money.cjs [TICKER,TICKER] [quarters=4] [holderPages=3]
 *   FMP_API_KEY=… node scripts/capture_smart_money.cjs --funds-only 12
 *   FMP_API_KEY=… node scripts/capture_smart_money.cjs --stocks-only STZ 2 2
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

const fundsOnly = process.argv.includes('--funds-only');
const stocksOnly = process.argv.includes('--stocks-only');
const args = process.argv.slice(2).filter(a => a !== '--funds-only' && a !== '--stocks-only');
const tickersArg = fundsOnly ? '' : args[0];
const quarterCount = Math.max(2, Math.min(12, Number(fundsOnly ? args[0] : args[1]) || 4));
const holderPages = Math.max(1, Math.min(8, Number(fundsOnly ? args[1] : args[2]) || 3));
const focusTickers = fundsOnly ? [] : (tickersArg
  ? tickersArg.split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
  : ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'BRK.B', 'TSM']);
const captureFunds = !stocksOnly;

const outDir = path.join(root, 'cache', 'smart-money');
const fundsDir = path.join(outDir, 'funds');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(fundsDir, { recursive: true });

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

function providerSymbol(symbol) {
  return symbol.endsWith('.HK') ? symbol : symbol.replaceAll('.', '-');
}

async function holderPagesFor(symbol, year, quarter) {
  const rows = [];
  for (let page = 0; page < holderPages; page += 1) {
    const chunk = await fmp('institutional-ownership/extract-analytics/holder', {
      symbol: providerSymbol(symbol),
      year,
      quarter,
      page,
      limit: 100,
    });
    const list = Array.isArray(chunk) ? chunk : [];
    rows.push(...list);
    if (list.length < 100) break;
    await sleep(120);
  }
  return rows;
}

async function extract(cik, year, quarter) {
  const rows = await fmp('institutional-ownership/extract', { cik, year, quarter });
  return Array.isArray(rows) ? rows : [];
}

async function datesFor(cik) {
  const rows = await fmp('institutional-ownership/dates', { cik });
  if (!Array.isArray(rows)) return [];
  return rows
    .map(row => ({
      year: Number(row.year),
      quarter: Number(row.quarter),
      date: String(row.date || '').slice(0, 10),
    }))
    .filter(row => Number.isInteger(row.year) && row.quarter >= 1 && row.quarter <= 4)
    .sort((a, b) => (b.year - a.year) || (b.quarter - a.quarter));
}

function normalizeHolderRows(ticker, year, quarter, rows) {
  const merged = SmartMoney.mergeRowsByCik(rows.map(row => ({
    ...row,
    cik: SmartMoney.padCik(row.cik),
    shares: row.sharesNumber ?? row.shares,
    lastShares: row.lastSharesNumber,
    marketValue: row.marketValue ?? row.value,
    filingDate: row.filingDate,
    securityCusip: row.securityCusip || row.cusip || null,
  }))).map(row => ({
    date: row.date,
    filingDate: row.filingDate,
    cik: row.cik,
    investorName: row.investorName,
    symbol: ticker,
    sharesNumber: row.shares,
    lastSharesNumber: row.lastShares,
    changeInSharesNumber: row.changeInShares
      ?? (row.shares != null && row.lastShares != null ? row.shares - row.lastShares : null),
    changeInSharesNumberPercentage: row.changeInSharesPct ?? row.changeInSharesNumberPercentage ?? null,
    marketValue: row.marketValue,
    lastMarketValue: row.lastMarketValue ?? null,
    weight: row.weight,
    ownership: row.ownership,
    securityCusip: row.securityCusip || null,
    year,
    quarter,
    isNew: row.isNew === true,
    isSoldOut: row.isSoldOut === true,
    isCurated: Boolean(SmartMoney.allowedCik(row.cik)),
  }));
  return merged;
}

(async () => {
  const capturedAt = new Date().toISOString();
  // Anchor on Berkshire filing calendar so we skip incomplete newest calendar quarters.
  let specs = SmartMoney.recentQuarterSpecs(quarterCount);
  try {
    const brkDates = await datesFor('0001067983');
    specs = SmartMoney.quarterSpecsFromDates(brkDates, quarterCount);
    console.log(`Anchored quarters on Berkshire filings: ${specs.map(s => s.key).join(', ')}`);
  } catch (error) {
    console.warn(`Berkshire dates unavailable (${error.message}); using calendar priors`);
  }
  if (focusTickers.length) {
    console.log(`Capturing broad holders for ${focusTickers.join(',')} · ${specs.map(s => s.key).join(', ')} · pages≤${holderPages}`);
  } else {
    console.log(`Funds-only capture · up to ${quarterCount} quarters per manager`);
  }

  for (const ticker of focusTickers) {
    const quarters = [];
    for (const spec of specs) {
      let rows = [];
      try {
        rows = await holderPagesFor(ticker, spec.year, spec.quarter);
      } catch (error) {
        console.warn(`${ticker} ${spec.key} holders failed: ${error.message}`);
        await sleep(300);
        continue;
      }
      await sleep(150);
      const normalized = normalizeHolderRows(ticker, spec.year, spec.quarter, rows);
      if (!normalized.length) {
        console.warn(`${ticker} ${spec.key}: empty holders — skip incomplete quarter`);
        continue;
      }
      quarters.push({ year: spec.year, quarter: spec.quarter, key: spec.key, rows: normalized });
      console.log(`${ticker} ${spec.key}: ${normalized.length} holders`);
    }
    if (quarters.length < 1) {
      console.warn(`${ticker}: no usable quarters`);
      continue;
    }
    const snapshot = SmartMoney.buildStockSnapshot(
      ticker,
      quarters[0].rows,
      quarters[1]?.rows || [],
      { year: quarters[0].year, quarter: quarters[0].quarter },
    );
    const payload = {
      ticker,
      capturedAt,
      source: {
        provider: 'FMP',
        method: 'institutional-ownership/extract-analytics/holder',
        quarters: quarters.length,
        holderPages,
      },
      quarters,
      snapshot,
      disclaimer: '13F filings lag up to ~45 days after quarter-end; not real-time holdings.',
    };
    const target = path.join(outDir, `${ticker}.json`);
    fs.writeFileSync(target, `${JSON.stringify(payload)}\n`);
    console.log(`Wrote ${target} holders=${snapshot.holders.length} exits=${snapshot.exits.length} curated=${snapshot.kpis.curatedHolders}`);
  }

  // Fund books: curated 20 (skip when --stocks-only so a ticker capture cannot wipe multi-Q seeds).
  const fundTargets = captureFunds
    ? SmartMoney.INVESTORS.map(row => ({
      cik: row.cik,
      slug: SmartMoney.slugify(row.nameEn),
      investorName: row.nameEn,
    }))
    : [];

  if (captureFunds) {
    console.log(`Capturing fund books for ${fundTargets.length} managers × ${quarterCount} quarters`);
  } else {
    console.log('Skipping fund books (--stocks-only)');
  }
  for (const fund of fundTargets) {
    let filings;
    try {
      filings = (await datesFor(fund.cik)).slice(0, quarterCount + 1);
    } catch (error) {
      console.warn(`${fund.slug} dates failed: ${error.message}`);
      await sleep(250);
      continue;
    }
    await sleep(120);
    const quarters = [];
    for (const filing of filings.slice(0, quarterCount)) {
      let rows;
      try {
        rows = await extract(fund.cik, filing.year, filing.quarter);
      } catch (error) {
        console.warn(`${fund.slug} ${filing.year}Q${filing.quarter} extract failed: ${error.message}`);
        await sleep(300);
        continue;
      }
      await sleep(120);
      const capped = rows.slice(0, SmartMoney.FUND_EXTRACT_MAX).map(row => ({
        ...row,
        cik: fund.cik,
        year: filing.year,
        quarter: filing.quarter,
      }));
      if (!capped.length) continue;
      quarters.push({
        year: filing.year,
        quarter: filing.quarter,
        key: SmartMoney.quarterKey(filing.year, filing.quarter),
        rows: capped,
      });
      console.log(`${fund.slug} ${filing.year}-Q${filing.quarter}: ${capped.length} positions`);
    }
    if (!quarters.length) continue;
    const history = quarters.map(q => {
      const summary = SmartMoney.summarizeFundQuarter(q.rows);
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
    const payload = {
      cik: fund.cik,
      slug: fund.slug,
      investorName: fund.investorName,
      capturedAt,
      source: { provider: 'FMP', method: 'institutional-ownership/extract', cappedAt: SmartMoney.FUND_EXTRACT_MAX },
      quarters,
      history,
      disclaimer: '13F filings lag up to ~45 days after quarter-end; not real-time holdings.',
    };
    const bySlug = path.join(fundsDir, `${fund.slug}.json`);
    const byCik = path.join(fundsDir, `${fund.cik}.json`);
    fs.writeFileSync(bySlug, `${JSON.stringify(payload)}\n`);
    fs.writeFileSync(byCik, `${JSON.stringify(payload)}\n`);
    console.log(`Wrote ${bySlug} quarters=${quarters.length}`);
  }

  if (captureFunds) {
    // WhaleCreep-style funds directory index
    const managers = [];
    for (const filename of fs.readdirSync(fundsDir)) {
      if (!/^[a-z][a-z0-9.-]*\.json$/.test(filename) || filename === 'index.json') continue;
      try {
        const payload = JSON.parse(fs.readFileSync(path.join(fundsDir, filename), 'utf8'));
        const entry = SmartMoney.buildFundDirectoryEntry(payload);
        if (entry) managers.push(entry);
      } catch (error) {
        console.warn(`index skip ${filename}: ${error.message}`);
      }
    }
    managers.sort((a, b) => (b.book ?? 0) - (a.book ?? 0));
    const indexPayload = {
      capturedAt,
      source: { provider: 'FMP', method: 'institutional-ownership/extract-summaries' },
      latestKey: managers[0]?.key || null,
      count: managers.length,
      managers,
      disclaimer: '13F filings lag up to ~45 days after quarter-end; not real-time holdings.',
    };
    const indexPath = path.join(fundsDir, 'index.json');
    fs.writeFileSync(indexPath, `${JSON.stringify(indexPayload)}\n`);
    console.log(`Wrote funds directory ${indexPath} managers=${managers.length}`);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
