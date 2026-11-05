#!/usr/bin/env node
/**
 * Capture slim Form 4 seeds under cache/smart-money/form4/{TICKER}.json
 * for Smart Money Preview (no Vercel FMP key required).
 *
 * Usage:
 *   FMP_API_KEY=… node scripts/seed_form4.cjs SIRI,AAPL
 *   FMP_API_KEY=… node scripts/seed_form4.cjs   # defaults SIRI,AAPL
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const SmartMoney = require('../smart_money.js');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'cache', 'smart-money', 'form4');
const DEFAULTS = ['SIRI', 'AAPL'];
const LIMIT = SmartMoney.FORM4_TRADE_CAP || 40;

async function fetchTrades(symbol, apiKey) {
  const url = new URL('https://financialmodelingprep.com/stable/insider-trading/search');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('page', '0');
  url.searchParams.set('limit', String(LIMIT));
  url.searchParams.set('apikey', apiKey);
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`FMP ${response.status} for ${symbol}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error(`Non-array Form 4 payload for ${symbol}`);
  return SmartMoney.slimForm4Trades(rows, symbol, { limit: LIMIT });
}

async function main() {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    console.error('FMP_API_KEY required');
    process.exit(1);
  }
  const arg = process.argv[2];
  const tickers = (arg ? arg.split(',') : DEFAULTS)
    .map(s => String(s || '').trim().toUpperCase())
    .filter(Boolean);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const ticker of tickers) {
    const trades = await fetchTrades(ticker, apiKey);
    const payload = {
      ticker,
      capturedAt: new Date().toISOString(),
      seed: true,
      source: {
        provider: 'FMP',
        endpoint: 'insider-trading/search',
        limit: LIMIT,
      },
      disclaimer: 'Form 4 / Section 16 and 10%+ owner filings (FMP). Not a full 13F book; typically days of lag, not ~45-day 13F lag. Not investment advice.',
      trades,
    };
    const outPath = path.join(OUT_DIR, `${ticker}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    const curated = trades.filter(t => t.isCurated).length;
    const buys = trades.filter(t => t.is_buy === true).length;
    console.log(`${ticker}: ${trades.length} trades (${buys} buys, ${curated} curated) → ${path.relative(ROOT, outPath)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
