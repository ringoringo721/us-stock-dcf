#!/usr/bin/env node
'use strict';
/**
 * Restore HK issuer-wide ordinary shares after provider-review date expiry.
 * Recomputes shareSource from cache/hkex_share_capital.json + current provider
 * comparison snapshots, then refreshes per-share financial fields.
 * Does not invent capital: tickers without verified monthly returns stay N/A.
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const config = require('../hkex_stocks.json');
const capital = require('../cache/hkex_share_capital.json');
const { valuationShares } = require('./build_hkex.cjs');
const FinancialModels = require('../financial_models.js');

const finite = value => typeof value === 'number' && Number.isFinite(value);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data) + '\n');
const writeJs = (file, name, data) => fs.writeFileSync(file, `window.${name} = ${JSON.stringify(data)};\n`);

function evidenceFromStock(item, stock) {
  const pc = stock.shareSource?.providerComparison;
  const asOf = pc?.date || stock.shareSource?.date || stock.quoteDate;
  if (!asOf) throw new TypeError(`${item.ticker}: missing provider/as-of date`);
  const outstanding = finite(pc?.shares) && pc.shares > 0 ? Math.round(pc.shares * 1e6) : null;
  return {
    ticker: item.ticker,
    providerSymbol: item.ticker,
    capturedAt: `${asOf}T12:00:00.000Z`,
    responses: {
      shares_float: {
        ok: outstanding != null,
        rows: outstanding != null ? [{
          symbol: item.ticker, date: asOf, outstandingShares: outstanding, floatShares: 1
        }] : []
      }
    }
  };
}

function applyShareSource(stock, shareSource) {
  const next = { ...stock };
  if (!finite(shareSource.shares) || shareSource.shares <= 0) {
    next.shares = null;
    next.shares_outstanding = null;
    next.shares_display = null;
    next.shareBasis = 'unavailable';
    next.shareSource = shareSource;
    return next;
  }
  next.shares = shareSource.shares;
  next.shares_outstanding = shareSource.outstandingShares ?? Math.round(shareSource.shares * 1e6);
  next.shares_display = shareSource.shares;
  next.shareBasis = shareSource.basis;
  next.shareSource = shareSource;
  if (next.fin_valuation?.is_financial) {
    const fin = { ...next.fin_valuation };
    fin.tbvps = finite(fin.tangibleEquity) ? fin.tangibleEquity / next.shares : null;
    fin.dps_total = finite(fin.totalPayout) ? fin.totalPayout / next.shares : null;
    fin.pb_tangible = fin.tbvps > 0 && finite(next.price) ? next.price / fin.tbvps : null;
    if (fin.unavailableReason === 'shareBasisUnverified') fin.unavailableReason = null;
    if (fin.reference?.reason === 'shareBasisUnverified') {
      fin.reference = { ...fin.reference, reason: null, tbvps: fin.tbvps };
    } else if (fin.reference) {
      fin.reference = { ...fin.reference, tbvps: fin.tbvps };
    }
    const valued = FinancialModels.valueFinancial(fin, { industry: next.industry });
    fin.excess_return_fair = valued.excess_return_fair;
    fin.ddm_fair = valued.ddm_fair;
    next.fin_valuation = fin;
    if (finite(valued.fair_val)) {
      next.fair_val = valued.fair_val;
      next.default_fair_val = valued.fair_val;
      next.premium_pct = finite(next.price) && valued.fair_val > 0
        ? (next.price / valued.fair_val - 1) * 100 : null;
      next.is_undervalued = next.premium_pct == null ? null : next.premium_pct < 0;
    }
  }
  if (next.liquidation) {
    next.liquidation = {
      ...next.liquidation,
      sharesOutstanding: next.shares_outstanding,
      shareBasis: shareSource.basis,
      shareSource
    };
  }
  return next;
}

function repairMarket(market) {
  const summary = { restored: [], stillBlocked: [], skipped: [] };
  for (const item of config.filter(row => row.shareClassReviewRequired)) {
    const stock = market[item.ticker];
    if (!stock) { summary.skipped.push(item.ticker); continue; }
    if (!capital[item.ticker]) { summary.skipped.push(item.ticker); continue; }
    const before = stock.shares;
    const beforeReason = stock.shareSource?.reason || null;
    let shareSource;
    try {
      shareSource = valuationShares(item, evidenceFromStock(item, stock));
    } catch (error) {
      summary.stillBlocked.push({ ticker: item.ticker, reason: error.message });
      continue;
    }
    market[item.ticker] = applyShareSource(stock, shareSource);
    if (finite(shareSource.shares)) {
      if (before == null || beforeReason) {
        summary.restored.push({
          ticker: item.ticker,
          shares: shareSource.shares,
          previousReason: beforeReason,
          previousShares: before
        });
      }
    } else {
      summary.stillBlocked.push({ ticker: item.ticker, reason: shareSource.reason || 'unavailable' });
    }
  }
  return summary;
}

function repairFcff(fcff, market) {
  if (!fcff?.stocks) return 0;
  let n = 0;
  for (const [ticker, snap] of Object.entries(fcff.stocks)) {
    const stock = market[ticker];
    if (!stock?.shareSource || !finite(stock.shares)) continue;
    const defaults = { ...(snap.defaults || {}), shares: stock.shares };
    const provenance = { ...(snap.provenance || {}), shares: stock.shareSource };
    fcff.stocks[ticker] = { ...snap, defaults, provenance };
    n++;
  }
  return n;
}

if (require.main === module) {
  const marketPath = path.join(root, 'hk_market_dcf.json');
  const market = read(marketPath);
  const summary = repairMarket(market);
  writeJson(marketPath, market);
  writeJs(path.join(root, 'hk_market_data.js'), 'HK_MARKET_DATA', market);

  const fcffJs = fs.readFileSync(path.join(root, 'hk_fcff_data.js'), 'utf8');
  const fcff = JSON.parse(fcffJs.replace(/^window\.HK_FCFF_DATA\s*=\s*/, '').replace(/;?\s*$/, ''));
  const fcffN = repairFcff(fcff, market);
  writeJs(path.join(root, 'hk_fcff_data.js'), 'HK_FCFF_DATA', fcff);

  console.log(JSON.stringify({ ...summary, fcffShareDefaultsUpdated: fcffN }, null, 2));
}

module.exports = { repairMarket, repairFcff, applyShareSource, evidenceFromStock };
