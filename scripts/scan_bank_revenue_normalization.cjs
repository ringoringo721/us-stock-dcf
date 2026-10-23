#!/usr/bin/env node
'use strict';
/**
 * Scan HK+US statements caches for bank revenue periods framed as gross interest income.
 * Usage: node scripts/scan_bank_revenue_normalization.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  usesFinancialValuationModel, isInsuranceIndustry, bankRevenueUsesGrossInterest,
  bankOperatingRevenue
} = require('../financial_industry.js');

const root = path.join(__dirname, '..');
const financials = path.join(root, 'cache', 'financials');

function loadUniverseIndustry() {
  const map = new Map();
  const add = (ticker, industry) => {
    if (ticker && industry) map.set(ticker, industry);
  };
  try {
    const hk = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'hkex_universe.json'), 'utf8'));
    for (const item of hk.stocks || hk || []) add(item.ticker, item.industry);
  } catch { /* optional */ }
  try {
    for (const item of require('../hkex_stocks.json')) add(item.ticker, item.industry);
  } catch { /* optional */ }
  for (const file of ['full_market_dcf.json', 'hk_market_dcf.json']) {
    try {
      const market = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
      for (const [ticker, stock] of Object.entries(market)) add(ticker, stock.industry);
    } catch { /* optional */ }
  }
  try {
    const expansion = JSON.parse(fs.readFileSync(path.join(root, 'us_expansion_data.js'), 'utf8')
      .replace(/^window\.US_EXPANSION\s*=\s*/, '').replace(/;\s*$/, ''));
    for (const [ticker, stock] of Object.entries(expansion.stocks || {})) add(ticker, stock.industry);
  } catch { /* optional */ }
  try {
    const expansion = JSON.parse(fs.readFileSync(path.join(root, 'hkex_expansion_data.js'), 'utf8')
      .replace(/^window\.HKEX_EXPANSION\s*=\s*/, '').replace(/;\s*$/, ''));
    for (const [ticker, stock] of Object.entries(expansion.stocks || {})) add(ticker, stock.industry);
  } catch { /* optional */ }
  return map;
}

function marketOf(ticker) {
  return /\.HK$/i.test(ticker) ? 'HK' : 'US';
}

function scan() {
  const industries = loadUniverseIndustry();
  const files = fs.readdirSync(financials).filter(name => name.endsWith('_statements_v2.json'));
  const summary = { scanned: 0, bankLike: 0, affectedTickers: 0, affectedPeriods: 0, byMarket: { HK: 0, US: 0 } };
  const offenders = [];

  for (const file of files) {
    const ticker = file.replace(/_statements_v2\.json$/, '');
    const industry = industries.get(ticker) || '';
    if (isInsuranceIndustry(industry)) continue;
    if (industry && !usesFinancialValuationModel(industry, ticker)) continue;
    summary.scanned += 1;
    const data = JSON.parse(fs.readFileSync(path.join(financials, file), 'utf8'));
    const annual = data.annual?.income || [];
    const hits = [];
    for (const row of annual) {
      if (!bankRevenueUsesGrossInterest(row)) continue;
      // If industry unknown, still require interestIncome to dominate like a bank row.
      if (!industry && !(row.interestIncome > row.revenue * 0.4)) continue;
      const operating = bankOperatingRevenue(row);
      hits.push({
        date: row.date,
        providerRevenue: row.revenue,
        operatingRevenue: operating,
        interestIncome: row.interestIncome,
        netInterestIncome: row.netInterestIncome,
        yoyHint: null
      });
    }
    if (!hits.length) continue;
    if (industry || hits.some(hit => hit.interestIncome > hit.providerRevenue * 0.5)) {
      summary.bankLike += 1;
    }
    summary.affectedTickers += 1;
    summary.affectedPeriods += hits.length;
    summary.byMarket[marketOf(ticker)] += 1;
    const prior = annual.filter(row => row.date < hits.at(-1).date).at(-1);
    const last = hits.at(-1);
    if (prior?.revenue > 0) {
      last.brokenYoY = last.providerRevenue / prior.revenue - 1;
      last.fixedYoY = last.operatingRevenue / (bankOperatingRevenue(prior) || prior.revenue) - 1;
    }
    offenders.push({ ticker, industry: industry || null, market: marketOf(ticker), periods: hits });
  }

  offenders.sort((a, b) => b.periods.length - a.periods.length || a.ticker.localeCompare(b.ticker));
  return { summary, offenders };
}

const report = scan();
const out = path.join(root, 'cache', 'bank_revenue_normalization_scan.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary, null, 2));
console.log(`Wrote ${out} (${report.offenders.length} tickers with ≥1 gross-interest revenue period)`);
console.log('Sample:', report.offenders.slice(0, 12).map(item => {
  const last = item.periods.at(-1);
  return `${item.ticker} ${last.date} brokenYoY=${last.brokenYoY != null ? (last.brokenYoY * 100).toFixed(1) + '%' : 'n/a'} fixedYoY=${last.fixedYoY != null ? (last.fixedYoY * 100).toFixed(1) + '%' : 'n/a'}`;
}).join('\n'));
