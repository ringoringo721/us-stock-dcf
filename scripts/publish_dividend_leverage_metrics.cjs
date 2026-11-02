#!/usr/bin/env node
'use strict';
/**
 * Publish compact front-table metrics for ALL US+HK stocks that have statement
 * and/or dividend caches:
 *   - cont_div_growth  (TradingView Cont div growth; prefer FMP dividend cache)
 *   - debt_to_fcf / net_debt_to_fcf (from catalogue debt/net_debt/fcf0)
 *
 * Does not call FMP. Optional cache/dividends/{ticker}.json improves coverage.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const DividendHistory = require('../dividend_history.js');

const root = path.resolve(__dirname, '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadWindow(filename) {
  const code = fs.readFileSync(path.join(root, filename), 'utf8');
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.window;
}

function catalogueTickers() {
  const out = new Map();
  const us = loadWindow('market_data.js');
  const usExp = loadWindow('us_expansion_data.js');
  const hk = loadWindow('hk_market_data.js');
  const hkExp = loadWindow('hkex_expansion_data.js');
  const addMap = (entries, market) => {
    if (!entries || typeof entries !== 'object') return;
    for (const [ticker, stock] of Object.entries(entries)) {
      if (!stock || typeof stock !== 'object') continue;
      out.set(ticker, { market, stock });
    }
  };
  addMap(us.FULL_MARKET_DATA, 'US');
  addMap(usExp.US_EXPANSION?.stocks, 'US');
  addMap(hk.HK_MARKET_DATA, 'HKEX');
  addMap(hkExp.HKEX_EXPANSION?.stocks, 'HKEX');
  return out;
}

function loadStatements(ticker) {
  const file = path.join(root, 'cache', 'financials', `${ticker}_statements_v2.json`);
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

function loadDividendCache(ticker) {
  const file = path.join(root, 'cache', 'dividends', `${ticker}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return DividendHistory.validateCache(readJson(file), ticker);
  } catch {
    return null;
  }
}

function publish() {
  const catalogue = catalogueTickers();
  const stocks = {};
  let fromDividends = 0;
  let fromStatements = 0;
  let leverageOnly = 0;

  for (const [ticker, { stock }] of catalogue) {
    const leverage = DividendHistory.leverageToFcf(stock);
    const dividendCache = loadDividendCache(ticker);
    let growth = null;
    if (dividendCache?.rows?.length) {
      growth = DividendHistory.metricsFromPayments(dividendCache.rows, stock);
      fromDividends += 1;
    } else {
      const statements = loadStatements(ticker);
      if (statements) {
        growth = DividendHistory.metricsFromStatements(statements, stock);
        if (growth.cont_div_growth > 0) fromStatements += 1;
      }
    }
    const row = {
      ...leverage,
      cont_div_growth: Number.isFinite(growth?.cont_div_growth) ? growth.cont_div_growth : null,
    };
    const hasLeverage = row.debt_to_fcf != null || row.net_debt_to_fcf != null;
    const hasGrowth = row.cont_div_growth != null;
    if (!hasLeverage && !hasGrowth) {
      leverageOnly += 1;
      continue;
    }
    stocks[ticker] = row;
  }

  const payload = {
    version: 2,
    generatedAt: new Date().toISOString(),
    source: {
      dividends: 'cache/dividends/*.json when present → cont_div_growth',
      statements: 'cache/financials/*_statements_v2.json DPS proxy when no dividend cache',
      leverage: 'catalogue debt / net_debt / fcf0',
    },
    counts: {
      catalogue: catalogue.size,
      published: Object.keys(stocks).length,
      fromDividends,
      fromStatements,
      emptySkipped: leverageOnly,
    },
    stocks,
  };

  const js = `window.DIVIDEND_LEVERAGE_METRICS = ${JSON.stringify(payload)};\n`;
  const target = path.join(root, 'dividend_leverage_metrics_data.js');
  fs.writeFileSync(target, js);
  console.log(JSON.stringify(payload.counts));
  return payload;
}

if (require.main === module) publish();
module.exports = { publish };
