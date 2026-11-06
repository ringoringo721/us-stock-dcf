#!/usr/bin/env node
/**
 * Restore score-only moat onto US expansion compact rows when company cache still
 * holds a complete assessment that compactForExpansion previously nulled because
 * ratingSources.moat.reason was set (typically staleEvidence after financial refresh).
 *
 * Zero Gemini. Does not clear staleEvidence — UI keeps the archived label.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { compactForExpansion } = require('./expansion_financial_models.cjs');

const root = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

function loadExpansion() {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'us_expansion_data.js'), 'utf8'), context);
  return context.window.US_EXPANSION;
}

function dimCount(moat) {
  if (!moat || typeof moat !== 'object') return 0;
  let n = 0;
  for (const [key, value] of Object.entries(moat)) {
    if (!/^m\d+_/.test(key)) continue;
    if (typeof value?.score === 'number' && Number.isFinite(value.score)) n += 1;
  }
  return n;
}

const expansion = loadExpansion();
const companiesDir = path.join(root, 'cache', 'us_companies');
let restored = 0;
let skippedNoCompany = 0;
let skippedNoMoat = 0;
let alreadyPresent = 0;
const examples = [];

for (const [ticker, compact] of Object.entries(expansion.stocks || {})) {
  const companyPath = path.join(companiesDir, `${ticker}.json`);
  if (!fs.existsSync(companyPath)) {
    skippedNoCompany += 1;
    continue;
  }
  let record;
  try {
    record = JSON.parse(fs.readFileSync(companyPath, 'utf8'));
  } catch {
    skippedNoCompany += 1;
    continue;
  }
  const stock = record.stock;
  if (!stock?.moat || dimCount(stock.moat) === 0) {
    skippedNoMoat += 1;
    continue;
  }
  if (dimCount(compact.moat) === dimCount(stock.moat) && compact.moat) {
    alreadyPresent += 1;
    continue;
  }
  const next = compactForExpansion({
    ...compact,
    moat: stock.moat,
    ratingSources: stock.ratingSources || compact.ratingSources,
  });
  if (dimCount(next.moat) === 0) {
    skippedNoMoat += 1;
    continue;
  }
  expansion.stocks[ticker] = {
    ...compact,
    moat: next.moat,
    ratingSources: stock.ratingSources || compact.ratingSources,
  };
  restored += 1;
  if (examples.length < 20) {
    examples.push({
      ticker,
      reason: stock.ratingSources?.moat?.reason || null,
      scored: dimCount(next.moat),
    });
  }
}

const summary = {
  restored,
  alreadyPresent,
  skippedNoCompany,
  skippedNoMoat,
  examples,
  dryRun,
};

if (!dryRun && restored > 0) {
  const target = path.join(root, 'us_expansion_data.js');
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `window.US_EXPANSION = ${JSON.stringify(expansion)};\n`);
  fs.renameSync(temporary, target);
}

console.log(JSON.stringify(summary, null, 2));
