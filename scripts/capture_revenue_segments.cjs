#!/usr/bin/env node
'use strict';
/**
 * Capture FMP product + geographic revenue segmentation into
 * cache/revenue_segments/{ticker}.json (annual) or {ticker}.quarter.json
 * (PERIOD=quarter) for the financials subpage.
 *
 * Usage:
 *   FMP_API_KEY=… node scripts/capture_revenue_segments.cjs AAPL,NVDA,MCD,MSFT
 *   FMP_API_KEY=… CAPTURE_ALL=1 node scripts/capture_revenue_segments.cjs
 *   PERIOD=quarter FMP_API_KEY=… node scripts/capture_revenue_segments.cjs AAPL
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const RevenueSegments = require('../revenue_segments.js');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'cache', 'revenue_segments');
const key = process.env.FMP_API_KEY;
const period = process.env.PERIOD === 'quarter' ? 'quarter' : 'annual';
if (!key) {
  console.error('FMP_API_KEY is required');
  process.exit(1);
}

function loadWindow(filename) {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, filename), 'utf8'), ctx);
  return ctx.window;
}

function allTickers() {
  const tickers = new Set();
  const add = (entries) => {
    if (!entries) return;
    for (const ticker of Object.keys(entries)) tickers.add(ticker);
  };
  add(loadWindow('market_data.js').FULL_MARKET_DATA);
  add(loadWindow('us_expansion_data.js').US_EXPANSION?.stocks);
  add(loadWindow('hk_market_data.js').HK_MARKET_DATA);
  add(loadWindow('hkex_expansion_data.js').HKEX_EXPANSION?.stocks);
  return [...tickers].sort();
}

function providerSymbol(ticker) {
  return ticker.endsWith('.HK') ? ticker : ticker.replaceAll('.', '-');
}

async function fetchSegments(ticker, kind) {
  const endpoint = kind === 'product' ? 'revenue-product-segmentation' : 'revenue-geographic-segmentation';
  const url = new URL(`https://financialmodelingprep.com/stable/${endpoint}`);
  url.searchParams.set('symbol', providerSymbol(ticker));
  url.searchParams.set('period', period);
  url.searchParams.set('structure', 'flat');
  url.searchParams.set('apikey', key);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${kind} HTTP ${response.status}`);
  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.historical) ? payload.historical
    : null;
  if (!Array.isArray(rows)) throw new Error(`${kind} InvalidJSON`);
  return rows;
}

async function captureOne(ticker) {
  let product = [];
  let geographic = [];
  let productError = null;
  let geoError = null;
  try { product = await fetchSegments(ticker, 'product'); }
  catch (error) { productError = error.message; }
  await new Promise(resolve => setTimeout(resolve, Number(process.env.CAPTURE_REQUEST_DELAY || 120)));
  try { geographic = await fetchSegments(ticker, 'geographic'); }
  catch (error) { geoError = error.message; }
  // HTTP/parse errors are hard failures — do NOT fold them into soft "Empty"
  // (the old `empty (…HTTP 503…)` message matched /empty/i and exited 0).
  if (productError && geoError) {
    throw new Error(`BothFailed:${productError}/${geoError}`);
  }
  if (!product.length && !geographic.length) {
    if (productError || geoError) {
      throw new Error(`PartialFailed:${productError || 'ok'}/${geoError || 'ok'}`);
    }
    throw new Error('Empty');
  }
  const record = RevenueSegments.validateCache({
    version: 1,
    ticker,
    source: `FMP revenue segmentation (${period})`,
    period,
    product,
    geographic,
    capturedAt: new Date().toISOString(),
  }, ticker);
  if (!record.product.length && !record.geographic.length) {
    throw new Error('NormalizedEmpty');
  }
  fs.mkdirSync(outDir, { recursive: true });
  // Keep annual `{ticker}.json` untouched when capturing quarters.
  const outName = period === 'quarter' ? `${ticker}.quarter.json` : `${ticker}.json`;
  fs.writeFileSync(path.join(outDir, outName), `${JSON.stringify(record, null, 2)}\n`);
  return {
    product: record.product.length,
    geographic: record.geographic.length,
    productError,
    geoError,
    file: outName,
  };
}

async function main() {
  const supplied = process.argv[2];
  const tickers = process.env.CAPTURE_ALL === '1' ? allTickers()
    : (supplied || '').split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
  if (!tickers.length) {
    console.error('Pass tickers or CAPTURE_ALL=1');
    process.exit(1);
  }
  let ok = 0, fail = 0, empty = 0;
  for (const ticker of tickers) {
    try {
      const counts = await captureOne(ticker);
      console.log(JSON.stringify({ ticker, period, ...counts }));
      ok += 1;
    } catch (error) {
      // Soft miss = genuine empty coverage only (exact tokens). HTTP/InvalidJSON stay hard.
      const miss = /^(Empty|NormalizedEmpty)$/i.test(error.message);
      console.error(JSON.stringify({ ticker, period, error: error.message, empty: miss }));
      if (miss) empty += 1;
      else fail += 1;
    }
    await new Promise(resolve => setTimeout(resolve, Number(process.env.CAPTURE_REQUEST_DELAY || 160)));
  }
  console.log(JSON.stringify({ ok, fail, empty, total: tickers.length, period }));
  // Empty FMP coverage is not a hard failure — some tickers genuinely lack segments.
  if (fail) process.exitCode = 1;
}

main();
