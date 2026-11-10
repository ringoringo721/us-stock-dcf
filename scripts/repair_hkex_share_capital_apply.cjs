#!/usr/bin/env node
'use strict';
/**
 * Apply cache/hkex_share_capital.json issuer-wide ordinary shares to:
 * - core HK market (hk_market_dcf.json / hk_market_data.js / hk_fcff_data.js)
 * - expansion pack (hkex_expansion_data.js)
 * - per-company caches (cache/hk_companies/*.json)
 *
 * Does not invent capital and does not substitute diluted weighted-average shares.
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const capital = require('../cache/hkex_share_capital.json');
const config = require('../hkex_stocks.json');
const { valuationShares } = require('./build_hkex.cjs');
const { applyShareSource, evidenceFromStock } = require('./repair_hkex_share_reviews.cjs');
const FinancialModels = require('../financial_models.js');

const finite = value => typeof value === 'number' && Number.isFinite(value);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data) + '\n');
const writeJs = (file, name, data) => fs.writeFileSync(file, `window.${name} = ${JSON.stringify(data)};\n`);
const loadWindowJson = (file, name) => {
  const text = fs.readFileSync(file, 'utf8');
  const prefix = `window.${name} = `;
  if (!text.startsWith(prefix)) throw new TypeError(`${file}: missing ${name}`);
  return JSON.parse(text.slice(prefix.length).replace(/;?\s*$/, ''));
};

function itemFor(ticker, stock) {
  const configured = config.find(row => row.ticker === ticker);
  if (configured) return configured;
  const classes = (capital[ticker]?.classes || []).map(row => row.name);
  return {
    ticker,
    // Mixed-class review applies only when the monthly return itself discloses 2+ ordinary classes.
    shareClassReviewRequired: classes.length >= 2,
    ordinaryShareClasses: classes.length ? classes : ['A', 'H'],
    industry: stock?.industry,
    financial: /Banks|Insurance|Financial Conglomerates/i.test(stock?.industry || '')
  };
}

function evidenceForCapital(item, stock, record) {
  // Repair runs after the monthly return is already filed. Provider/quote snapshots
  // may still carry an older as-of date; lift evidence.capturedAt to at least the
  // filing date so valuationShares does not treat a filed return as "not yet available".
  // Incomplete expansion stubs may also lack provider/quote dates — use filingDate.
  let evidence;
  try {
    evidence = evidenceFromStock(item, stock);
  } catch (error) {
    if (!record?.filingDate || !/missing provider\/as-of date/.test(error.message)) throw error;
    evidence = {
      ticker: item.ticker,
      providerSymbol: item.ticker,
      capturedAt: `${record.filingDate}T23:59:59.000Z`,
      responses: { shares_float: { ok: false, rows: [] } }
    };
  }
  const filingDate = record?.filingDate;
  if (typeof filingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(filingDate)
      && evidence.capturedAt.slice(0, 10) < filingDate) {
    evidence.capturedAt = `${filingDate}T23:59:59.000Z`;
  }
  return evidence;
}

function applyOne(ticker, stock) {
  if (!capital[ticker]) return { status: 'skipped', reason: 'noCapital' };
  const item = itemFor(ticker, stock);
  let shareSource;
  try {
    shareSource = valuationShares(item, evidenceForCapital(item, stock, capital[ticker]));
  } catch (error) {
    return { status: 'blocked', reason: error.message };
  }
  const next = applyShareSource(stock, shareSource);
  // Non-financial expansion/core stocks: keep runtime FMP equity÷issued-shares path honest.
  if (!next.fin_valuation?.is_financial && finite(shareSource.shares)) {
    if (next.shareSource?.reason) delete next.shareSource.reason;
  }
  if (!finite(shareSource.shares)) {
    return { status: 'blocked', reason: shareSource.reason || 'unavailable', stock: next };
  }
  return { status: 'restored', shares: shareSource.shares, outstandingShares: shareSource.outstandingShares, stock: next };
}

function repairFcff(fcff, market) {
  if (!fcff?.stocks) return 0;
  let n = 0;
  for (const [ticker, snap] of Object.entries(fcff.stocks)) {
    const stock = market[ticker];
    if (!stock?.shareSource || !finite(stock.shares)) continue;
    fcff.stocks[ticker] = {
      ...snap,
      defaults: { ...(snap.defaults || {}), shares: stock.shares },
      provenance: { ...(snap.provenance || {}), shares: stock.shareSource }
    };
    n++;
  }
  return n;
}

// Share-capital repair must never replace company-cache moat comments / score
// breakdowns with the expansion catalogue's score-only compact moat.
const SHARE_PATCH_KEYS = [
  'shares', 'shares_display', 'shares_outstanding', 'shareBasis', 'shareSource',
  'fair_val', 'default_fair_val', 'premium_pct', 'is_undervalued', 'fin_valuation',
  'liquidation', 'mcap'
];

function repairCompanyCache(ticker, stock) {
  const file = path.join(root, 'cache', 'hk_companies', `${ticker}.json`);
  if (!fs.existsSync(file)) return false;
  const record = read(file);
  if (record.ticker !== ticker || record.stock?.ticker !== ticker) {
    throw new TypeError(`${ticker}: invalid company cache identity`);
  }
  const nextStock = { ...record.stock };
  for (const key of SHARE_PATCH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(stock, key)) nextStock[key] = stock[key];
  }
  let snapshot = record.snapshot;
  if (snapshot?.defaults) {
    snapshot = {
      ...snapshot,
      defaults: { ...snapshot.defaults, shares: stock.shares },
      provenance: { ...(snapshot.provenance || {}), shares: stock.shareSource }
    };
  }
  writeJson(file, { ...record, stock: nextStock, snapshot });
  return true;
}

if (require.main === module) {
  const summary = { core: { restored: [], blocked: [], skipped: [] },
    expansion: { restored: [], blocked: [], skipped: [] }, companyCaches: 0, fcffUpdated: 0 };

  const marketPath = path.join(root, 'hk_market_dcf.json');
  const market = read(marketPath);
  for (const ticker of Object.keys(capital)) {
    if (!market[ticker]) continue;
    const beforeReason = market[ticker].shareSource?.reason || null;
    const result = applyOne(ticker, market[ticker]);
    if (result.status === 'restored') {
      market[ticker] = result.stock;
      summary.core.restored.push({ ticker, shares: result.shares, previousReason: beforeReason });
      if (repairCompanyCache(ticker, result.stock)) summary.companyCaches++;
    } else if (result.status === 'blocked') {
      if (result.stock) market[ticker] = result.stock;
      summary.core.blocked.push({ ticker, reason: result.reason });
    } else summary.core.skipped.push({ ticker, reason: result.reason });
  }
  writeJson(marketPath, market);
  writeJs(path.join(root, 'hk_market_data.js'), 'HK_MARKET_DATA', market);

  const fcff = loadWindowJson(path.join(root, 'hk_fcff_data.js'), 'HK_FCFF_DATA');
  summary.fcffUpdated = repairFcff(fcff, market);
  writeJs(path.join(root, 'hk_fcff_data.js'), 'HK_FCFF_DATA', fcff);

  const expansionPath = path.join(root, 'hkex_expansion_data.js');
  const expansion = loadWindowJson(expansionPath, 'HKEX_EXPANSION');
  for (const ticker of Object.keys(capital)) {
    const stock = expansion.stocks?.[ticker];
    if (!stock) continue;
    const beforeReason = stock.shareSource?.reason || null;
    const result = applyOne(ticker, stock);
    if (result.status === 'restored') {
      expansion.stocks[ticker] = result.stock;
      summary.expansion.restored.push({ ticker, shares: result.shares, previousReason: beforeReason });
      if (repairCompanyCache(ticker, result.stock)) summary.companyCaches++;
    } else if (result.status === 'blocked') {
      if (result.stock) expansion.stocks[ticker] = result.stock;
      summary.expansion.blocked.push({ ticker, reason: result.reason });
    } else summary.expansion.skipped.push({ ticker, reason: result.reason });
  }
  // Keep expansion snapshots share defaults aligned when present.
  if (expansion.snapshots) {
    for (const [ticker, snap] of Object.entries(expansion.snapshots)) {
      const stock = expansion.stocks[ticker];
      if (!stock?.shareSource || !finite(stock.shares) || !snap) continue;
      expansion.snapshots[ticker] = {
        ...snap,
        defaults: { ...(snap.defaults || {}), shares: stock.shares },
        provenance: { ...(snap.provenance || {}), shares: stock.shareSource }
      };
    }
  }
  writeJs(expansionPath, 'HKEX_EXPANSION', expansion);

  console.log(JSON.stringify({
    coreRestored: summary.core.restored.length,
    coreBlocked: summary.core.blocked.length,
    expansionRestored: summary.expansion.restored.length,
    expansionBlocked: summary.expansion.blocked.length,
    companyCaches: summary.companyCaches,
    fcffUpdated: summary.fcffUpdated,
    sample: {
      core: summary.core.restored.slice(0, 12),
      expansion: summary.expansion.restored.filter(row => row.ticker === '1766.HK').concat(
        summary.expansion.restored.slice(0, 8))
    },
    blockedSample: {
      core: summary.core.blocked.slice(0, 12),
      expansion: summary.expansion.blocked.slice(0, 12)
    }
  }, null, 2));
}

module.exports = { applyOne, itemFor, repairCompanyCache, SHARE_PATCH_KEYS };
