#!/usr/bin/env node
/**
 * Backfill US expansion liquidation sources from cached quarterly statements,
 * merge into cache/liquidation_sources.json, then apply shared calculations to
 * core + expansion catalogues.
 *
 * Expansion historically had liq_val_* = null because refresh_liquidation.py only
 * iterated full_market_dcf.json (core ~230). The screener recomputes from the
 * `liquidation` snapshot, so scalars alone are insufficient — snapshots must ship.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { buildSourceRecord, loadStatements } = require('./liquidation_from_financials.cjs');
const { applyToMarket } = require('./apply_liquidation.cjs');

const root = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

function readExpansion() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'us_expansion_data.js'), 'utf8'), context);
  return context.window.US_EXPANSION;
}

function loadCompanyStock(ticker) {
  const file = path.join(root, 'cache', 'us_companies', `${ticker}.json`);
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  return record.stock || record;
}

const expansion = readExpansion();
const sourcesPath = path.join(root, 'cache', 'liquidation_sources.json');
const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
const rates = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'fx', 'usd_rates.json'), 'utf8'));
const capturedAt = new Date().toISOString();

const summary = {
  dryRun,
  expansion: Object.keys(expansion.stocks || {}).length,
  built: 0,
  skipped: {},
  samples: { built: [], skipped: [] }
};

const nextSources = {
  ...sources,
  refreshedAt: capturedAt,
  source: 'FMP stable balance-sheet-statement, quote, profile; expansion backfill from cache/financials',
  stocks: { ...sources.stocks }
};

for (const ticker of Object.keys(expansion.stocks || {})) {
  const stock = loadCompanyStock(ticker) || expansion.stocks[ticker];
  const statements = loadStatements(root, ticker);
  const built = buildSourceRecord(ticker, stock, statements, capturedAt);
  if (!built.record) {
    summary.skipped[built.reason] = (summary.skipped[built.reason] || 0) + 1;
    if (summary.samples.skipped.length < 20) {
      summary.samples.skipped.push({ ticker, reason: built.reason });
    }
    continue;
  }
  nextSources.stocks[ticker] = built.record;
  summary.built++;
  if (summary.samples.built.length < 8) {
    summary.samples.built.push({
      ticker,
      balanceDate: built.record.balance.date,
      currency: built.record.balance.reportedCurrency
    });
  }
}

const subset = Object.fromEntries(
  Object.keys(expansion.stocks).filter(ticker => nextSources.stocks[ticker])
    .map(ticker => [ticker, expansion.stocks[ticker]])
);
const preview = applyToMarket(subset, nextSources, rates);
summary.available = Object.values(preview)
  .filter(update => update.liq_val_1 != null && update.liq_val_2 != null && update.liq_val_3 != null).length;
summary.withSnapshot = Object.keys(preview).length;

if (!dryRun) {
  fs.writeFileSync(sourcesPath, `${JSON.stringify(nextSources)}\n`);
  execFileSync(process.execPath, [path.join(root, 'scripts', 'apply_liquidation.cjs')], {
    cwd: root,
    stdio: 'inherit'
  });
}

console.log(JSON.stringify(summary, null, 2));
