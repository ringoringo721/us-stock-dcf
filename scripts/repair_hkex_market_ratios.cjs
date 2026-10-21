#!/usr/bin/env node
'use strict';
/**
 * Recompute HK trailing/forward multiples that were blocked solely by unverified
 * A/H share classes, using issuer-wide market-cap and provider share cross-checks.
 * Does not invent statements: tickers without provider financials stay N/A.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const { marketMultiples, forwardPriceEarnings, flowValue } = require('./build_hkex.cjs');
const { convertStatements } = require('../usd_currency.js');
const rates = require('../cache/fx/hkd_rates.json');

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data) + '\n');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const millions = value => finite(value) ? value / 1e6 : null;
const divide = (a, b) => finite(a) && finite(b) && b !== 0 ? a / b : null;

function needsRepair(stock) {
  if (stock.shareBasis !== 'unverifiedMixedShareClasses') {
    return stock.pe_forward_source?.reason === 'forecastShareScaleUnverified'
      && finite(stock.shareSource?.providerComparison?.shares);
  }
  return stock.pe_trailing == null || stock.pb_trailing == null || stock.ps_ratio == null
    || stock.pe_forward_source?.reason === 'forecastShareScaleUnverified';
}

function loadStatements(ticker) {
  const file = path.join(root, 'cache', 'financials', `${ticker}_statements_v2.json`);
  if (!fs.existsSync(file)) return null;
  const statements = read(file);
  if (!['annual', 'quarterly'].some(period => ['income', 'balance', 'cashflow']
    .some(type => Array.isArray(statements?.[period]?.[type]) && statements[period][type].length))) {
    return null;
  }
  return convertStatements(statements, rates);
}

function repairForward(stock, ticker) {
  const source = stock.pe_forward_source;
  if (!source || source.value != null || source.reason !== 'forecastShareScaleUnverified') return false;
  const providerShares = stock.shareSource?.providerComparison?.shares;
  if (!finite(providerShares) || providerShares <= 0 || !finite(stock.price) || stock.price <= 0) return false;
  const companyFile = path.join(root, 'cache', 'company', `${ticker}.json`);
  const statementsFile = path.join(root, 'cache', 'financials', `${ticker}_statements_v2.json`);
  if (!fs.existsSync(companyFile) || !fs.existsSync(statementsFile)) return false;
  const company = read(companyFile);
  const estimates = company.analystEstimates?.rows;
  const annual = read(statementsFile).annual?.income;
  if (!Array.isArray(estimates) || !estimates.length || !Array.isArray(annual) || !annual.length) return false;
  const item = { ticker, financial: /Banks|Insurance|Financial Conglomerates/.test(stock.industry || '') };
  const evidence = {
    capturedAt: stock.shareSource?.capturedAt || company.capturedAt || source.fetchedAt,
    responses: {
      estimates: { ok: true, rows: estimates.map(row => ({ ...row, symbol: ticker })) },
      annual_income: { ok: true, rows: annual.map(row => ({
        ...row,
        symbol: ticker,
        reportedCurrency: row.sourceReportedCurrency || row.reportedCurrency
      })) }
    }
  };
  const shareSource = {
    ...stock.shareSource,
    shares: null,
    providerComparison: { shares: providerShares, date: stock.shareSource?.providerComparison?.date || null }
  };
  const repaired = forwardPriceEarnings(item, evidence, rates, shareSource, stock.price,
    evidence.responses.annual_income.rows);
  if (repaired.value == null) return false;
  stock.pe_forward_source = repaired;
  stock.pe_forward = repaired.value;
  return true;
}

function repairStock(stock, ticker) {
  if (!needsRepair(stock)) return null;
  const before = {
    pe: stock.pe_trailing, pb: stock.pb_trailing, fwd: stock.pe_forward, ps: stock.ps_ratio
  };
  let changed = false;
  const shareClassUnverified = stock.shareBasis === 'unverifiedMixedShareClasses';
  if (shareClassUnverified && finite(stock.mcap) && stock.mcap > 0
      && (stock.pe_trailing == null || stock.pb_trailing == null || stock.ps_ratio == null)) {
    const data = loadStatements(ticker);
    if (data) {
      const multiples = marketMultiples(data, stock.price, stock.shareSource || {}, true, stock.mcap);
      if (stock.pe_trailing !== multiples.pe_trailing || stock.pb_trailing !== multiples.pb_trailing
          || JSON.stringify(stock.marketRatioSources?.pe) !== JSON.stringify(multiples.marketRatioSources.pe)
          || JSON.stringify(stock.marketRatioSources?.pb) !== JSON.stringify(multiples.marketRatioSources.pb)) {
        stock.pe_trailing = multiples.pe_trailing;
        stock.pb_trailing = multiples.pb_trailing;
        stock.marketRatioSources = { ...stock.marketRatioSources, ...multiples.marketRatioSources };
        changed = true;
      }
      if (stock.ps_ratio == null) {
        const ps = divide(stock.mcap, millions(flowValue(data, 'income', 'revenue')));
        if (finite(ps)) { stock.ps_ratio = ps; changed = true; }
      }
    }
  }
  if (repairForward(stock, ticker)) changed = true;
  return changed ? { ticker, before, after: {
    pe: stock.pe_trailing, pb: stock.pb_trailing, fwd: stock.pe_forward, ps: stock.ps_ratio,
    peBasis: stock.marketRatioSources?.pe?.basis, fwdReason: stock.pe_forward_source?.reason
  } } : null;
}

function patchExpansion(changedTickers) {
  if (!changedTickers.length) return 0;
  const file = path.join(root, 'hkex_expansion_data.js');
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  const expansion = context.window.HKEX_EXPANSION;
  let updated = 0;
  const wanted = new Set(changedTickers);
  for (const ticker of wanted) {
    const compact = expansion.stocks?.[ticker];
    const companyFile = path.join(root, 'cache', 'hk_companies', `${ticker}.json`);
    if (!compact || !fs.existsSync(companyFile)) continue;
    const full = read(companyFile).stock;
    for (const field of ['pe_trailing', 'pb_trailing', 'pe_forward', 'pe_forward_source', 'ps_ratio', 'marketRatioSources']) {
      compact[field] = full[field];
    }
    updated++;
  }
  fs.writeFileSync(file, `window.HKEX_EXPANSION = ${JSON.stringify(expansion)};\n`);
  return updated;
}

function main() {
  const directory = path.join(root, 'cache', 'hk_companies');
  const files = fs.readdirSync(directory).filter(file => file.endsWith('.HK.json'));
  const results = [];
  let scanned = 0;
  for (const name of files) {
    scanned++;
    if (scanned % 200 === 0) process.stderr.write(`scanned ${scanned}/${files.length}\n`);
    const file = path.join(directory, name);
    const record = read(file);
    const change = repairStock(record.stock, record.ticker || name.replace(/\.json$/, ''));
    if (!change) continue;
    write(file, record);
    results.push(change);
  }
  process.stderr.write(`patching expansion for ${results.length} tickers\n`);
  const expansionUpdated = patchExpansion(results.map(row => row.ticker));
  const summary = {
    scanned,
    repairedCompanies: results.length,
    expansionUpdated,
    peRecovered: results.filter(row => row.before.pe == null && row.after.pe != null).length,
    pbRecovered: results.filter(row => row.before.pb == null && row.after.pb != null).length,
    forwardRecovered: results.filter(row => row.before.fwd == null && row.after.fwd != null).length,
    examples: results.filter(row => row.before.pe == null && row.after.pe != null).slice(0, 12)
  };
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main();
module.exports = { repairStock, loadStatements, needsRepair };
