#!/usr/bin/env node
/**
 * Align catalogue / company-cache EV to balance-derived USD millions:
 *   EV = mcap + debt − cash_and_short_term  (= mcap + net_debt)
 *
 * Covers US expansion compact + cache/us_companies. Skips rows that cannot
 * compute (missing mcap or net debt / debt+cash). Idempotent.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  applyEnterpriseValue, computedEnterpriseValue, storedEnterpriseValue
} = require('../market_ev.js');

const root = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const TOL = 0.15;
const COMPACT_EV_KEYS = [
  'ev', 'fmp_official_ev', 'enterpriseValueBasis', 'ev_to_ebitda', 'fcf_to_ev',
  'debt', 'cash', 'cash_and_short_term', 'net_debt', 'mcap',
  'reportedCurrency', 'calculationCurrency'
];

function readJsWindow(file, key) {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  return context.window[key];
}

function writeExpansion(data) {
  fs.writeFileSync(path.join(root, 'us_expansion_data.js'), `window.US_EXPANSION = ${JSON.stringify(data)};\n`);
}

const expansion = readJsWindow(path.join(root, 'us_expansion_data.js'), 'US_EXPANSION');
const repaired = [];
const skipped = [];
const stillNa = [];

for (const [ticker, compact] of Object.entries(expansion.stocks || {})) {
  const companyPath = path.join(root, 'cache', 'us_companies', `${ticker}.json`);
  if (!fs.existsSync(companyPath)) {
    skipped.push({ ticker, reason: 'missingCompanyCache' });
    continue;
  }
  const record = JSON.parse(fs.readFileSync(companyPath, 'utf8'));
  const stock = record.stock || record;
  const before = storedEnterpriseValue(stock);
  const computed = computedEnterpriseValue(stock);
  if (!Number.isFinite(computed)) {
    stillNa.push({
      ticker,
      reason: 'missingMcapOrNetDebt',
      mcap: stock.mcap,
      debt: stock.debt,
      cash: stock.cash_and_short_term ?? stock.cash,
      net_debt: stock.net_debt
    });
    continue;
  }
  const needsWrite = !(Number.isFinite(before) && Math.abs(before - computed) < TOL);
  if (needsWrite) {
    applyEnterpriseValue(stock, computed);
    repaired.push({
      ticker,
      reportedCurrency: stock.reportedCurrency || null,
      before: before ?? null,
      after: stock.ev,
      mcap: stock.mcap,
      net_debt: stock.net_debt
    });
    if (!dryRun) {
      record.stock = stock;
      fs.writeFileSync(companyPath, JSON.stringify(record) + '\n');
    }
  } else {
    skipped.push({ ticker, reason: 'alreadyAligned' });
  }
  if (!dryRun) {
    // Refresh compact catalogue EV fields (and keep other compact keys).
    const next = {
      ...compact,
      ...Object.fromEntries(
        COMPACT_EV_KEYS
          .filter(key => stock[key] !== undefined)
          .map(key => [key, stock[key]])
      )
    };
    expansion.stocks[ticker] = next;
  }
}

if (!dryRun) writeExpansion(expansion);

const summary = {
  dryRun,
  repaired: repaired.length,
  skipped: skipped.length,
  stillNa: stillNa.length,
  stillNaSample: stillNa.slice(0, 20),
  sample: repaired.slice(0, 15),
  screenshot: ['BNTX', 'NTES', 'CBRS', 'PDD', 'SPOT'].map(ticker => {
    const stock = expansion.stocks[ticker];
    if (!stock) return { ticker, missing: true };
    return {
      ticker,
      mcap: stock.mcap,
      debt: stock.debt,
      cash: stock.cash_and_short_term ?? stock.cash,
      net_debt: stock.net_debt,
      ev: stock.ev,
      computed: computedEnterpriseValue(stock)
    };
  })
};
console.log(JSON.stringify(summary, null, 2));
