#!/usr/bin/env node
/**
 * Repair US expansion FCF/parent-equity blanks and absurd trailing P/B values.
 *
 * - Persist fcf_to_equity onto company caches + compact catalogue (statements_raw
 *   is stripped from us_expansion_data.js, so the screener needs the scalar).
 * - Null out P/B that equals mcap×1e6 from the legacy `equity or 1.0` bug
 *   (AMRO-class). Prefer statement-backed marketBalanceRatios when available.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { storedTtmFcfToEquity } = require('../fcf_ratios.js');
const { convertStatements } = require('../usd_currency.js');
const { marketBalanceRatios } = require('./usd_financials.cjs');
const { compactForExpansion } = require('./expansion_financial_models.cjs');

const root = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

function readJsWindow(file, key) {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  return context.window[key];
}

/** True when P/B was computed with equity≈$1 → pb ≈ mcap×1e6. */
function looksLikeRawMcapPb(pb, mcap) {
  if (!Number.isFinite(pb) || !Number.isFinite(mcap) || mcap <= 0) return false;
  const expected = mcap * 1e6;
  return Math.abs(pb - expected) / expected < 0.001;
}

function absurdRoe(roe) {
  return Number.isFinite(roe) && Math.abs(roe) > 1e6;
}

function recomputeBalanceRatios(stock, ticker) {
  const statementsPath = path.join(root, 'cache', 'financials', `${ticker}_statements_v2.json`);
  const ratesPath = path.join(root, 'cache', 'fx', 'usd_rates.json');
  if (!fs.existsSync(statementsPath) || !fs.existsSync(ratesPath)) return null;
  try {
    const statements = JSON.parse(fs.readFileSync(statementsPath, 'utf8'));
    const rates = JSON.parse(fs.readFileSync(ratesPath, 'utf8'));
    return marketBalanceRatios(stock, convertStatements(statements, rates));
  } catch {
    return null;
  }
}

const expansion = readJsWindow(path.join(root, 'us_expansion_data.js'), 'US_EXPANSION');
const summary = {
  dryRun,
  fcfEquityFilled: 0,
  pbFixed: 0,
  roeNulled: 0,
  samples: { amro: null, pb: [], fcfEquity: [] }
};

for (const [ticker, compact] of Object.entries(expansion.stocks || {})) {
  const companyPath = path.join(root, 'cache', 'us_companies', `${ticker}.json`);
  if (!fs.existsSync(companyPath)) {
    // Still clear compact-only absurd P/B if present without a company cache.
    if (looksLikeRawMcapPb(compact.pb_trailing, compact.mcap)) {
      expansion.stocks[ticker] = { ...compact, pb_trailing: null, pb_forward: null };
      summary.pbFixed++;
    }
    continue;
  }
  const record = JSON.parse(fs.readFileSync(companyPath, 'utf8'));
  const stock = record.stock || record;
  let changed = false;
  const beforePb = stock.pb_trailing;

  const fcfEquity = storedTtmFcfToEquity(stock.statements_raw, stock.currencyConversion?.reason);
  const nextFcfEquity = Number.isFinite(fcfEquity) ? Math.round(fcfEquity * 100) / 100 : null;
  if (stock.fcf_to_equity !== nextFcfEquity) {
    stock.fcf_to_equity = nextFcfEquity;
    changed = true;
    if (Number.isFinite(nextFcfEquity)) {
      summary.fcfEquityFilled++;
      if (summary.samples.fcfEquity.length < 8) {
        summary.samples.fcfEquity.push({ ticker, fcf_to_equity: nextFcfEquity });
      }
    }
  }

  const ratios = recomputeBalanceRatios(stock, ticker);
  const corruptedPb = looksLikeRawMcapPb(beforePb, stock.mcap);
  if (corruptedPb) {
    const nextPb = ratios && Number.isFinite(ratios.pb_trailing) ? ratios.pb_trailing : null;
    stock.pb_trailing = nextPb;
    stock.pb_forward = nextPb === null ? null : Math.round(nextPb * 0.9 * 10) / 10;
    if (ratios?.marketRatioSources) {
      stock.marketRatioSources = { ...stock.marketRatioSources, ...ratios.marketRatioSources };
    }
    if (ratios) {
      for (const field of ['current_ratio', 'cash_to_assets', 'liab_to_assets', 'roe', 'roa']) {
        if (ratios[field] !== undefined) stock[field] = ratios[field];
      }
    }
    changed = true;
    summary.pbFixed++;
    summary.samples.pb.push({
      ticker, before: beforePb, after: stock.pb_trailing, mcap: stock.mcap,
      reason: ratios?.marketRatioSources?.pb?.reason || 'missingEquity'
    });
  }

  if (absurdRoe(stock.roe)) {
    stock.roe = ratios && Number.isFinite(ratios.roe) ? ratios.roe : null;
    changed = true;
    summary.roeNulled++;
  }

  if (ticker === 'AMRO') {
    summary.samples.amro = {
      beforePb, afterPb: stock.pb_trailing, mcap: stock.mcap,
      fcf_to_equity: stock.fcf_to_equity, roe: stock.roe
    };
  }

  if (!dryRun && changed) {
    record.stock = stock;
    fs.writeFileSync(companyPath, `${JSON.stringify(record)}\n`);
  }
  expansion.stocks[ticker] = compactForExpansion(stock);
}

if (!dryRun) {
  fs.writeFileSync(path.join(root, 'us_expansion_data.js'),
    `window.US_EXPANSION = ${JSON.stringify(expansion)};\n`);
}

console.log(JSON.stringify(summary, null, 2));
