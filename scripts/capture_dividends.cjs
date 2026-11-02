#!/usr/bin/env node
'use strict';
/**
 * Capture FMP dividend payment history into cache/dividends/{ticker}.json
 * for long-window Div CAGR and the 30y dividend subpage.
 *
 * Usage:
 *   FMP_API_KEY=... node scripts/capture_dividends.cjs AAPL,KO,0700.HK
 *   FMP_API_KEY=... CAPTURE_ALL=1 node scripts/capture_dividends.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const DividendHistory = require('../dividend_history.js');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'cache', 'dividends');
const key = process.env.FMP_API_KEY;
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

async function captureOne(ticker) {
  const url = new URL('https://financialmodelingprep.com/stable/dividends');
  url.searchParams.set('symbol', providerSymbol(ticker));
  url.searchParams.set('limit', '400');
  url.searchParams.set('apikey', key);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('InvalidJSON');
  const record = DividendHistory.validateCache({
    version: 1,
    ticker,
    source: 'FMP dividends',
    capturedAt: new Date().toISOString(),
    rows,
  }, ticker);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${ticker}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record.rows.length;
}

async function main() {
  const supplied = process.argv[2];
  const tickers = process.env.CAPTURE_ALL === '1' ? allTickers()
    : (supplied || '').split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
  if (!tickers.length) {
    console.error('Pass tickers or CAPTURE_ALL=1');
    process.exit(1);
  }
  let ok = 0, fail = 0;
  for (const ticker of tickers) {
    try {
      const count = await captureOne(ticker);
      console.log(JSON.stringify({ ticker, rows: count }));
      ok += 1;
    } catch (error) {
      console.error(JSON.stringify({ ticker, error: error.message }));
      fail += 1;
    }
    await new Promise(resolve => setTimeout(resolve, Number(process.env.CAPTURE_REQUEST_DELAY || 160)));
  }
  console.log(JSON.stringify({ ok, fail, total: tickers.length }));
  if (fail) process.exitCode = 1;
}

main();
