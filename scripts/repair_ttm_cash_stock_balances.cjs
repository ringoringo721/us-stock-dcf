#!/usr/bin/env node
'use strict';
/**
 * Repair TTM cashAtBeginningOfPeriod / cashAtEndOfPeriod when they were incorrectly
 * summed across the last four quarters. Stock balances use the TTM window endpoints:
 * beginning = oldest quarter begin, ending = newest quarter end.
 *
 * Targets:
 *   - market_data.js (FULL_MARKET_DATA)
 *   - cache/us_companies/*.json
 *
 * HK builders already treat these as stock balances; this script is US-oriented.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function repairStatements(raw) {
  if (!raw?.cashflow || !raw?.quarterly_raw?.cashflow) return null;
  const qBeg = raw.quarterly_raw.cashflow.cashAtBeginningOfPeriod;
  const qEnd = raw.quarterly_raw.cashflow.cashAtEndOfPeriod;
  if (!Array.isArray(qBeg) || !Array.isArray(qEnd) || qBeg.length < 4 || qEnd.length < 4) return null;
  const windowBeg = qBeg.slice(-4);
  const windowEnd = qEnd.slice(-4);
  if (windowBeg.some(v => !finite(v)) || windowEnd.some(v => !finite(v))) return null;
  const correctBeg = windowBeg[0];
  const correctEnd = windowEnd.at(-1);
  const begSeries = raw.cashflow.cashAtBeginningOfPeriod;
  const endSeries = raw.cashflow.cashAtEndOfPeriod;
  if (!Array.isArray(begSeries) || !Array.isArray(endSeries) || !begSeries.length || !endSeries.length) {
    return null;
  }
  const beforeBeg = begSeries.at(-1);
  const beforeEnd = endSeries.at(-1);
  if (!finite(beforeBeg) || !finite(beforeEnd)) return null;
  const sumBeg = windowBeg.reduce((a, b) => a + b, 0);
  const sumEnd = windowEnd.reduce((a, b) => a + b, 0);
  const looksSummed = Math.abs(beforeBeg - sumBeg) < 0.15 && Math.abs(beforeEnd - sumEnd) < 0.15;
  const alreadyCorrect = Math.abs(beforeBeg - correctBeg) < 0.15 && Math.abs(beforeEnd - correctEnd) < 0.15;
  if (!looksSummed || alreadyCorrect) return null;
  const next = structuredClone(raw);
  next.cashflow.cashAtBeginningOfPeriod = [...begSeries.slice(0, -1), correctBeg];
  next.cashflow.cashAtEndOfPeriod = [...endSeries.slice(0, -1), correctEnd];
  return {
    before: { cashAtBeginningOfPeriod: beforeBeg, cashAtEndOfPeriod: beforeEnd },
    after: { cashAtBeginningOfPeriod: correctBeg, cashAtEndOfPeriod: correctEnd },
    statements_raw: next
  };
}

function repairMarketData() {
  const file = path.join(root, 'market_data.js');
  const source = fs.readFileSync(file, 'utf8');
  const ctx = { window: {} };
  vm.runInNewContext(source, ctx);
  const market = ctx.window.FULL_MARKET_DATA;
  if (!market || typeof market !== 'object') throw new Error('FULL_MARKET_DATA missing');
  const changed = [];
  for (const [ticker, stock] of Object.entries(market)) {
    const result = repairStatements(stock.statements_raw);
    if (!result) continue;
    stock.statements_raw = result.statements_raw;
    changed.push({ ticker, ...result.before, ...Object.fromEntries(
      Object.entries(result.after).map(([k, v]) => [`${k}Fixed`, v])) });
  }
  if (!dryRun && changed.length) {
    fs.writeFileSync(file, `window.FULL_MARKET_DATA = ${JSON.stringify(market, null, 2)};\n`);
  }
  return { file: 'market_data.js', changed: changed.length, samples: changed.slice(0, 5) };
}

function repairUsCompanies() {
  const dir = path.join(root, 'cache', 'us_companies');
  const changed = [];
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const stock = record.stock;
    if (!stock?.statements_raw) continue;
    const result = repairStatements(stock.statements_raw);
    if (!result) continue;
    stock.statements_raw = result.statements_raw;
    changed.push({ ticker: record.ticker || path.basename(name, '.json'),
      before: result.before, after: result.after });
    if (!dryRun) fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
  }
  return { file: 'cache/us_companies', changed: changed.length, samples: changed.slice(0, 5) };
}

function main() {
  const report = {
    dryRun,
    marketData: repairMarketData(),
    usCompanies: repairUsCompanies()
  };
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main();

module.exports = { repairStatements, repairMarketData, repairUsCompanies };
