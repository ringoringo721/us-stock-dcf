#!/usr/bin/env node
/**
 * Backfill slim FMP discounted-cash-flow + levered-discounted-cash-flow rows into
 * us_expansion_data.js → models[ticker] so the shared screener can show FMP DCF /
 * Levered DCF reference prices (and premium vs latest price) for every US expansion
 * name — matching baseline coverage already embedded in fmp_model_data.js.
 *
 * Uses the site /api/fmp proxy (or FMP_API_KEY against financialmodelingprep.com).
 * Does not invent valuations: empty/error payloads become reason-tagged N/A models.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const expansionPath = path.join(root, 'us_expansion_data.js');

function parseArgs(argv) {
  const options = {
    base: process.env.FMP_PROXY_BASE || 'https://us-stock-dcf.vercel.app',
    concurrency: Number(process.env.BACKFILL_CONCURRENCY || 6),
    limit: null,
    dryRun: false
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--dry-run') options.dryRun = true;
    else if (key === '--base') options.base = argv[++i];
    else if (key === '--concurrency') options.concurrency = Number(argv[++i]);
    else if (key === '--limit') options.limit = Number(argv[++i]);
    else throw new Error(`Unknown arg ${key}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 12) {
    throw new Error('concurrency must be 1–12');
  }
  if (options.limit != null && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('limit must be a positive integer');
  }
  return options;
}

function loadExpansion() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(expansionPath, 'utf8'), context);
  const expansion = context.window.US_EXPANSION;
  if (!expansion?.stocks || typeof expansion.stocks !== 'object') {
    throw new Error('us_expansion_data.js missing US_EXPANSION.stocks');
  }
  if (!expansion.models || typeof expansion.models !== 'object') expansion.models = {};
  return expansion;
}

function writeExpansion(expansion) {
  const temporary = `${expansionPath}.tmp`;
  fs.writeFileSync(temporary, `window.US_EXPANSION = ${JSON.stringify(expansion)};\n`);
  fs.renameSync(temporary, expansionPath);
}

function hasReference(model, kind) {
  const row = model?.models?.[kind]?.data?.[0];
  return !model?.models?.[kind]?.reason
    && row?.symbol === model?.symbol
    && typeof row?.dcf === 'number'
    && Number.isFinite(row.dcf);
}

async function fetchModel(base, action, symbol) {
  const url = new URL('/api/fmp', base);
  url.searchParams.set('action', action);
  url.searchParams.set('symbol', symbol);
  const response = await fetch(url);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch {
    return { data: [], reason: `FMP_HTTP_${response.status}_NON_JSON`, endpoint: action };
  }
  if (!response.ok) {
    return {
      data: [],
      reason: body?.error || `FMP_HTTP_${response.status}`,
      endpoint: action === 'dcf' ? 'discounted-cash-flow' : 'levered-discounted-cash-flow'
    };
  }
  const rows = Array.isArray(body?.data) ? body.data : [];
  const row = rows.find(item => item?.symbol === symbol && Number.isFinite(Number(item.dcf)));
  return {
    data: row ? [{
      symbol: row.symbol,
      date: row.date || null,
      dcf: Number(row.dcf),
      'Stock Price': Number.isFinite(Number(row['Stock Price'])) ? Number(row['Stock Price']) : null
    }] : [],
    reason: row ? null : (rows.length ? 'FMP_INVALID_RESPONSE' : 'FMP_NO_COVERAGE'),
    endpoint: action === 'dcf' ? 'discounted-cash-flow' : 'levered-discounted-cash-flow',
    capturedAt: body?.source?.capturedAt || new Date().toISOString()
  };
}

async function captureTicker(base, ticker, stock) {
  const capturedAt = new Date().toISOString();
  const [dcf, levered] = await Promise.all([
    fetchModel(base, 'dcf', ticker),
    fetchModel(base, 'levered-dcf', ticker)
  ]);
  return {
    symbol: ticker,
    currency: stock.calculationCurrency || 'USD',
    capturedAt,
    models: {
      dcf: { data: dcf.data, reason: dcf.reason, endpoint: dcf.endpoint, capturedAt: dcf.capturedAt || capturedAt },
      levered: { data: levered.data, reason: levered.reason, endpoint: levered.endpoint, capturedAt: levered.capturedAt || capturedAt }
    }
  };
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const expansion = loadExpansion();
  const candidates = Object.entries(expansion.stocks)
    .filter(([, stock]) => stock && stock.fin_valuation?.is_financial !== true
      && stock.corporateDcfApplicability !== 'requiresSegmentValuation')
    .map(([ticker]) => ticker)
    .sort();
  const missing = candidates.filter(ticker => {
    const model = expansion.models[ticker];
    return !(hasReference(model, 'dcf') && hasReference(model, 'levered'));
  });
  const targets = options.limit ? missing.slice(0, options.limit) : missing;
  console.log(JSON.stringify({
    expansionStocks: Object.keys(expansion.stocks).length,
    nonFinancialCandidates: candidates.length,
    alreadyCovered: candidates.length - missing.length,
    toFetch: targets.length,
    base: options.base,
    concurrency: options.concurrency,
    dryRun: options.dryRun
  }));
  if (!targets.length || options.dryRun) return;

  const summary = { ok: 0, partial: 0, failed: 0, errors: [] };
  await mapPool(targets, options.concurrency, async (ticker) => {
    try {
      const model = await captureTicker(options.base, ticker, expansion.stocks[ticker]);
      expansion.models[ticker] = model;
      const dcfOk = hasReference(model, 'dcf');
      const levOk = hasReference(model, 'levered');
      if (dcfOk && levOk) summary.ok++;
      else if (dcfOk || levOk) summary.partial++;
      else summary.failed++;
      if ((summary.ok + summary.partial + summary.failed) % 50 === 0) {
        console.log(`progress ${summary.ok + summary.partial + summary.failed}/${targets.length}`);
      }
    } catch (error) {
      summary.failed++;
      summary.errors.push({ ticker, message: error.message });
      expansion.models[ticker] = {
        symbol: ticker,
        currency: expansion.stocks[ticker].calculationCurrency || 'USD',
        capturedAt: new Date().toISOString(),
        models: {
          dcf: { data: [], reason: 'FMP_SOURCE_UNAVAILABLE', endpoint: 'discounted-cash-flow' },
          levered: { data: [], reason: 'FMP_SOURCE_UNAVAILABLE', endpoint: 'levered-discounted-cash-flow' }
        }
      };
    }
  });

  writeExpansion(expansion);
  console.log(JSON.stringify({ written: expansionPath, models: Object.keys(expansion.models).length, summary }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
