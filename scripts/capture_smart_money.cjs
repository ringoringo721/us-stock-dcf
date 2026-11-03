#!/usr/bin/env node
/**
 * Invert curated 13F books into per-ticker Smart Money cache files.
 * Usage:
 *   FMP_API_KEY=… node scripts/capture_smart_money.cjs [TICKER,TICKER] [quarters=5]
 * With no tickers: builds for a small demo universe (AAPL,MSFT,NVDA,GOOGL,AMZN,META,BRK.B).
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

const tickersArg = process.argv[2];
const quarterCount = Math.max(2, Math.min(6, Number(process.argv[3]) || 5));
const focusTickers = tickersArg
  ? tickersArg.split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
  : ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'BRK.B'];

const outDir = path.join(root, 'cache', 'smart-money');
fs.mkdirSync(outDir, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fmp(pathname, params) {
  const url = new URL(`https://financialmodelingprep.com/stable/${pathname}`);
  for (const [name, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(name, String(value));
  }
  url.searchParams.set('apikey', key);
  const response = await fetch(url, { signal: AbortSignal.timeout(45000), redirect: 'error' });
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

async function extract(cik, year, quarter) {
  const rows = await fmp('institutional-ownership/extract', { cik, year, quarter });
  return Array.isArray(rows) ? rows : [];
}

(async () => {
  const focus = new Set(focusTickers);
  /** @type {Map<string, Map<string, object[]>>} ticker -> quarterKey -> rows */
  const byTicker = new Map();
  for (const ticker of focus) byTicker.set(ticker, new Map());

  const investors = SmartMoney.INVESTORS;
  console.log(`Capturing Smart Money for ${[...focus].join(',')} across up to ${quarterCount} quarters × ${investors.length} CIKs`);

  for (const investor of investors) {
    let filings;
    try {
      filings = (await datesFor(investor.cik)).slice(0, quarterCount + 1);
    } catch (error) {
      console.warn(`${investor.id} dates failed: ${error.message}`);
      await sleep(250);
      continue;
    }
    await sleep(120);
    for (const filing of filings.slice(0, quarterCount)) {
      let rows;
      try {
        rows = await extract(investor.cik, filing.year, filing.quarter);
      } catch (error) {
        console.warn(`${investor.id} ${filing.year}Q${filing.quarter} extract failed: ${error.message}`);
        await sleep(300);
        continue;
      }
      await sleep(120);
      const key = SmartMoney.quarterKey(filing.year, filing.quarter);
      for (const ticker of focus) {
        const matched = rows.filter(row => {
          const sym = String(row.symbol || '').toUpperCase();
          return sym === ticker || sym === providerSymbol(ticker);
        });
        if (!matched.length) continue;
        const bucket = byTicker.get(ticker);
        if (!bucket.has(key)) bucket.set(key, []);
        // Dedupe amendment restatements (same shares+value / cusip), then sum true split lots.
        const mergedLots = SmartMoney.mergeRowsByCik(matched.map(row => ({
          cik: investor.cik,
          shares: row.shares,
          marketValue: row.value,
          filingDate: row.filingDate,
          date: row.date,
          securityCusip: row.securityCusip || row.cusip || null,
          investorName: investor.nameEn,
        })));
        const first = mergedLots[0];
        const shares = mergedLots.reduce((sum, row) => sum + (Number(row.shares) || 0), 0);
        const marketValue = mergedLots.reduce((sum, row) => sum + (Number(row.marketValue) || 0), 0);
        const existing = bucket.get(key).find(row => row.cik === investor.cik);
        if (existing) {
          // Same CIK already stored for this quarter — keep the later filing, don't double-count.
          if (String(first.filingDate || '') >= String(existing.filingDate || '')) {
            existing.sharesNumber = shares;
            existing.marketValue = marketValue;
            existing.filingDate = first.filingDate || existing.filingDate;
            existing.date = first.date || existing.date;
          }
        } else {
          bucket.get(key).push({
            date: first.date,
            filingDate: first.filingDate,
            cik: investor.cik,
            investorName: investor.nameEn,
            symbol: ticker,
            sharesNumber: shares,
            lastSharesNumber: null,
            changeInSharesNumber: null,
            marketValue,
            weight: null,
            ownership: null,
            year: filing.year,
            quarter: filing.quarter,
            isNew: false,
            isSoldOut: false,
          });
        }
      }
      console.log(`${investor.id} ${key}: ${rows.length} positions`);
    }
  }

  // Enrich QoQ change fields within each ticker cache.
  const capturedAt = new Date().toISOString();
  for (const ticker of focus) {
    const quarterMap = byTicker.get(ticker);
    const keys = [...quarterMap.keys()].sort((a, b) => b.localeCompare(a));
    const quarters = keys.map(key => {
      const { year, quarter } = SmartMoney.parseQuarterKey(key);
      const rows = quarterMap.get(key) || [];
      const prior = SmartMoney.priorQuarter(year, quarter);
      const priorKey = SmartMoney.quarterKey(prior.year, prior.quarter);
      const priorRows = quarterMap.get(priorKey) || [];
      // Dedupe any residual multi-lot rows; buildSnapshot also merges + synthesizes exits.
      const merged = SmartMoney.mergeRowsByCik(rows.map(row => ({
        ...row,
        shares: row.sharesNumber,
        lastShares: row.lastSharesNumber,
        marketValue: row.marketValue,
      }))).map(row => ({
        date: row.date,
        filingDate: row.filingDate,
        cik: row.cik,
        investorName: row.investorName,
        symbol: ticker,
        sharesNumber: row.shares,
        lastSharesNumber: null,
        changeInSharesNumber: null,
        marketValue: row.marketValue,
        weight: row.weight,
        ownership: row.ownership,
        year,
        quarter,
        isNew: false,
        isSoldOut: false,
      }));
      const priorByCik = new Map(priorRows.map(row => [row.cik, row]));
      const enriched = merged.map(row => {
        const prev = priorByCik.get(row.cik);
        const lastShares = prev && Number.isFinite(Number(prev.sharesNumber))
          ? Number(prev.sharesNumber) : null;
        const shares = Number.isFinite(Number(row.sharesNumber)) ? Number(row.sharesNumber) : null;
        return {
          ...row,
          lastSharesNumber: lastShares,
          changeInSharesNumber: shares != null && lastShares != null ? shares - lastShares : null,
          isNew: lastShares == null && shares > 0,
          isSoldOut: false,
        };
      });
      return { year, quarter, key, rows: enriched };
    });

    const snapshot = SmartMoney.buildSnapshot(ticker, quarters);
    const payload = {
      ticker,
      capturedAt,
      source: { provider: 'FMP', method: 'institutional-ownership/extract-inverted', quarters: quarterCount },
      quarters,
      snapshot,
      disclaimer: '13F filings lag up to ~45 days after quarter-end; not real-time holdings.',
    };
    const target = path.join(outDir, `${ticker}.json`);
    fs.writeFileSync(target, `${JSON.stringify(payload)}\n`);
    console.log(`Wrote ${target} holders=${snapshot.holders.length} quarters=${quarters.length}`);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
