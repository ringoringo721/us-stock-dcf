#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { attachDistressScores, stripCompactBreakdowns } = require('./distress_score_fields.cjs');

const root = path.join(__dirname, '..');
const checkedAt = new Date().toISOString();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data)}\n`);
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

function enrichMarketFile(relPath) {
  const file = path.join(root, relPath);
  if (!fs.existsSync(file)) {
    console.warn(`skip missing ${relPath}`);
    return null;
  }
  const payload = readJson(file);
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
  writeJson(file, payload);
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

function main() {
  enrichMarketFile('full_market_dcf.json');
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

module.exports = { applyToStock, enrichMarketFile };
