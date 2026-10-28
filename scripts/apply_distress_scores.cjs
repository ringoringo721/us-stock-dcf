#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { attachDistressScores, stripCompactBreakdowns } = require('./distress_score_fields.cjs');

const root = path.join(__dirname, '..');
const checkedAt = new Date().toISOString();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data, { pretty = false } = {}) {
  const body = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  fs.writeFileSync(file, `${body}\n`);
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function loadStatements(ticker) {
  const file = path.join(root, 'cache/financials', `${ticker}_statements_v2.json`);
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

function stockMap(payload) {
  if (!payload || typeof payload !== 'object') return {};
  if (payload.stocks && typeof payload.stocks === 'object') return payload.stocks;
  return payload;
}

function applyToStock(stock, ticker) {
  const statements = loadStatements(ticker);
  const evidenceHash = statements ? hash({
    annual: statements.annual,
    interim: statements.quarterly
  }) : null;
  return attachDistressScores(stock, statements || {}, { ticker, checkedAt, evidenceHash });
}

function summarize(label, counts) {
  console.log(`${label}: total=${counts.total} z=${counts.z} m=${counts.m} financialNa=${counts.financial} missingStatements=${counts.missing}`);
}

function enrichMarketFile(relPath, { pretty = false } = {}) {
  const file = path.join(root, relPath);
  if (!fs.existsSync(file)) {
    console.warn(`skip missing ${relPath}`);
    return null;
  }
  const existingText = fs.readFileSync(file, 'utf8');
  const preservePretty = pretty || /^\s*\{\s*\n\s+"/.test(existingText);
  const payload = JSON.parse(existingText);
  const stocks = stockMap(payload);
  const counts = { total: 0, z: 0, m: 0, financial: 0, missing: 0 };
  for (const [ticker, stock] of Object.entries(stocks)) {
    if (!stock || typeof stock !== 'object') continue;
    counts.total++;
    const beforeStatements = loadStatements(ticker);
    if (!beforeStatements) counts.missing++;
    const { altman, beneish, financial } = applyToStock(stock, ticker);
    if (financial) counts.financial++;
    if (Number.isFinite(altman.score)) counts.z++;
    if (Number.isFinite(beneish.score)) counts.m++;
  }
  writeJson(file, payload, { pretty: preservePretty });
  summarize(relPath, counts);
  return counts;
}

function enrichCompanyDir(dirRel) {
  const dir = path.join(root, dirRel);
  if (!fs.existsSync(dir)) return;
  let updated = 0;
  for (const name of fs.readdirSync(dir).filter(file => file.endsWith('.json'))) {
    const file = path.join(dir, name);
    const record = readJson(file);
    const ticker = record.ticker || path.basename(name, '.json');
    const stock = record.stock;
    if (!stock) continue;
    applyToStock(stock, ticker);
    writeJson(file, record);
    updated++;
  }
  console.log(`${dirRel}: updated ${updated} company records`);
}

function enrichExpansionModule(relPath, { compact = true } = {}) {
  const file = path.join(root, relPath);
  if (!fs.existsSync(file)) return;
  // window.NAME = { ... }  (expansion catalogues or browser market payloads)
  const text = fs.readFileSync(file, 'utf8');
  const assign = text.match(/^window\.(\w+)\s*=\s*/);
  if (!assign) {
    console.warn(`skip unparsable expansion module ${relPath}`);
    return;
  }
  const pretty = /\n\s+"[A-Z0-9]/.test(text);
  const jsonText = text.slice(assign[0].length).replace(/;\s*$/, '');
  const payload = JSON.parse(jsonText);
  const stocks = payload.stocks && typeof payload.stocks === 'object' && !payload.stocks.mcap
    ? payload.stocks
    : payload;
  let zCount = 0, mCount = 0, financial = 0, total = 0;
  for (const [ticker, stock] of Object.entries(stocks)) {
    if (!stock || typeof stock !== 'object') continue;
    if (!('f_score' in stock || 'mcap' in stock || 'price' in stock || 'fin_valuation' in stock)) continue;
    total++;
    const result = applyToStock(stock, ticker);
    if (compact) stripCompactBreakdowns(stock);
    if (result.financial) financial++;
    if (Number.isFinite(result.altman.score)) zCount++;
    if (Number.isFinite(result.beneish.score)) mCount++;
  }
  const body = pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  fs.writeFileSync(file, `window.${assign[1]} = ${body};\n`);
  console.log(`${relPath}: stocks=${total} z=${zCount} m=${mCount} financialNa=${financial}`);
}

function collectUsCorePatch() {
  const file = path.join(root, 'full_market_dcf.json');
  const stocks = readJson(file);
  const patch = {};
  const counts = { total: 0, z: 0, m: 0, financial: 0, missing: 0 };
  for (const [ticker, stock] of Object.entries(stocks)) {
    if (!stock || typeof stock !== 'object') continue;
    counts.total++;
    const clone = JSON.parse(JSON.stringify(stock));
    if (!loadStatements(ticker)) counts.missing++;
    const { altman, beneish, financial } = applyToStock(clone, ticker);
    if (financial) counts.financial++;
    if (Number.isFinite(altman.score)) counts.z++;
    if (Number.isFinite(beneish.score)) counts.m++;
    patch[ticker] = {
      z_score: clone.z_score,
      z_score_model: clone.z_score_model,
      z_score_zone: clone.z_score_zone,
      z_score_breakdown: clone.z_score_breakdown,
      m_score: clone.m_score,
      m_score_zone: clone.m_score_zone,
      m_score_breakdown: clone.m_score_breakdown,
      ratingSources_zScore: clone.ratingSources.zScore,
      ratingSources_mScore: clone.ratingSources.mScore
    };
  }
  return { patch, counts };
}

function enrichUsCoreOnly() {
  // Compute in Node, merge via Python so non-Z/M numeric types stay bit-identical
  // in full_market_dcf.json / market_data.js (avoids EV / valuation field churn).
  const { patch, counts } = collectUsCorePatch();
  const patchFile = path.join(os.tmpdir(), `us-core-zm-patch-${process.pid}.json`);
  fs.writeFileSync(patchFile, JSON.stringify(patch));
  const merge = spawnSync(
    process.env.PYTHON || 'python3',
    [path.join(__dirname, 'merge_distress_score_fields.py'), '--patch', patchFile],
    { cwd: root, encoding: 'utf8' }
  );
  fs.unlinkSync(patchFile);
  if (merge.status !== 0) {
    process.stderr.write(merge.stdout || '');
    process.stderr.write(merge.stderr || '');
    throw new Error(`merge_distress_score_fields.py failed with status ${merge.status}`);
  }
  process.stdout.write(merge.stdout || '');
  summarize('us-core-only', counts);
  return counts;
}

function main(argv = process.argv.slice(2)) {
  const usCoreOnly = argv.includes('--us-core-only');
  if (usCoreOnly) {
    enrichUsCoreOnly();
    console.log(`mode=us-core-only checkedAt=${checkedAt}`);
    return;
  }
  enrichMarketFile('full_market_dcf.json', { pretty: true });
  enrichMarketFile('hk_market_dcf.json');
  enrichCompanyDir('cache/us_companies');
  enrichCompanyDir('cache/hk_companies');
  enrichExpansionModule('us_expansion_data.js', { compact: true });
  enrichExpansionModule('hkex_expansion_data.js', { compact: true });
  // Browser frontpage payloads (keep full Z/M breakdowns for core universes).
  enrichExpansionModule('market_data.js', { compact: false });
  enrichExpansionModule('hk_market_data.js', { compact: false });
  console.log(`checkedAt=${checkedAt}`);
}

if (require.main === module) main();

module.exports = {
  applyToStock,
  enrichMarketFile,
  enrichUsCoreOnly,
  collectUsCorePatch,
  main
};
