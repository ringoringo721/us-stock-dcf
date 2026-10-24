#!/usr/bin/env node
'use strict';
/**
 * Rewrite statements_raw for HK company snapshots whose provider financials are
 * completely empty. Replaces the legacy six-null "N/A (duration unverified)"
 * skeleton with an explicit empty table (providerStatementsUnavailable).
 * Does not invent income/balance/cashflow rows.
 */
const fs = require('node:fs');
const path = require('node:path');
const { statementTable } = require('./build_hkex.cjs');

const root = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

function isEmptyStatements(data) {
  return ['annual', 'quarterly'].every(period => ['income', 'balance', 'cashflow']
    .every(type => Array.isArray(data?.[period]?.[type]) && data[period][type].length === 0));
}

function main() {
  const finDir = path.join(root, 'cache', 'financials');
  const companyDir = path.join(root, 'cache', 'hk_companies');
  const tickers = fs.readdirSync(finDir)
    .filter(name => name.endsWith('.HK_statements_v2.json'))
    .map(name => name.replace(/_statements_v2\.json$/, ''))
    .filter(ticker => isEmptyStatements(JSON.parse(fs.readFileSync(
      path.join(finDir, `${ticker}_statements_v2.json`), 'utf8'))));
  let rewritten = 0;
  for (const ticker of tickers) {
    const companyPath = path.join(companyDir, `${ticker}.json`);
    if (!fs.existsSync(companyPath)) continue;
    const record = JSON.parse(fs.readFileSync(companyPath, 'utf8'));
    const statements = JSON.parse(fs.readFileSync(
      path.join(finDir, `${ticker}_statements_v2.json`), 'utf8'));
    const table = statementTable(statements);
    if (!table.providerStatementsUnavailable) {
      throw new Error(`${ticker}: expected empty statement table`);
    }
    const before = JSON.stringify(record.stock.statements_raw);
    record.stock.statements_raw = table;
    if (!Array.isArray(record.stock.qualityWarnings) || !record.stock.qualityWarnings.length) {
      record.stock.qualityWarnings = statements.qualityWarnings || [];
    }
    if (JSON.stringify(record.stock.statements_raw) === before) continue;
    rewritten += 1;
    if (!dryRun) fs.writeFileSync(companyPath, `${JSON.stringify(record)}\n`);
  }
  console.log(JSON.stringify({
    emptyStatementTickers: tickers.length,
    companySnapshotsRewritten: rewritten,
    dryRun
  }, null, 2));
}

main();
