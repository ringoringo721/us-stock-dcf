#!/usr/bin/env node
/**
 * Repair US expansion EV fields left in reportedCurrency after USD statement translation.
 * Rewrites cache/us_companies/<TICKER>.json and regenerates us_expansion_data.js compact catalogue.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { applyEnterpriseValue, computedEnterpriseValue, needsTranslatedMarketEv, storedEnterpriseValue } =
  require('../market_ev.js');

const root = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

function readJsWindow(file, key) {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  return context.window[key];
}

function writeExpansion(data) {
  const target = path.join(root, 'us_expansion_data.js');
  fs.writeFileSync(target, `window.US_EXPANSION = ${JSON.stringify(data)};\n`);
}

const expansion = readJsWindow(path.join(root, 'us_expansion_data.js'), 'US_EXPANSION');
const repaired = [];
const skipped = [];

for (const [ticker, compact] of Object.entries(expansion.stocks || {})) {
  const companyPath = path.join(root, 'cache', 'us_companies', `${ticker}.json`);
  if (!fs.existsSync(companyPath)) {
    skipped.push({ ticker, reason: 'missingCompanyCache' });
    continue;
  }
  const record = JSON.parse(fs.readFileSync(companyPath, 'utf8'));
  const stock = record.stock || record;
  if (!needsTranslatedMarketEv(stock)) {
    skipped.push({ ticker, reason: 'usdReported' });
    continue;
  }
  const before = storedEnterpriseValue(stock);
  const computed = computedEnterpriseValue(stock);
  if (!Number.isFinite(computed)) {
    skipped.push({ ticker, reason: 'missingMcapOrNetDebt' });
    continue;
  }
  if (Number.isFinite(before) && Math.abs(before - computed) < 0.15) {
    skipped.push({ ticker, reason: 'alreadyAligned' });
    continue;
  }
  applyEnterpriseValue(stock, computed);
  repaired.push({
    ticker,
    reportedCurrency: stock.reportedCurrency,
    before,
    after: stock.ev,
    mcap: stock.mcap,
    net_debt: stock.net_debt
  });
  if (!dryRun) {
    record.stock = stock;
    fs.writeFileSync(companyPath, JSON.stringify(record) + '\n');
    // Keep compact catalogue fields in sync (omit heavy statements_raw etc. already absent).
    const next = { ...compact, ...Object.fromEntries([
      'ev', 'fmp_official_ev', 'enterpriseValueBasis', 'ev_to_ebitda', 'fcf_to_ev',
      'debt', 'cash', 'cash_and_short_term', 'net_debt', 'mcap', 'reportedCurrency', 'calculationCurrency'
    ].filter(key => stock[key] !== undefined).map(key => [key, stock[key]])) };
    expansion.stocks[ticker] = next;
  }
}

if (!dryRun) writeExpansion(expansion);

const summary = {
  dryRun,
  repaired: repaired.length,
  skipped: skipped.length,
  sample: repaired.slice(0, 12),
  skhy: repaired.find(row => row.ticker === 'SKHY') || null,
  asx: repaired.find(row => row.ticker === 'ASX') || null
};
console.log(JSON.stringify(summary, null, 2));
if (!repaired.length && !dryRun) {
  console.error('No foreign-currency EV rows needed repair');
}
