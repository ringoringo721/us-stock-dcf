'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isDistressFinancial } = require('../scripts/distress_score_fields.cjs');

const root = path.join(__dirname, '..');

function loadExpansion() {
  const text = fs.readFileSync(path.join(root, 'us_expansion_data.js'), 'utf8');
  const prefix = 'window.US_EXPANSION = ';
  assert.ok(text.startsWith(prefix));
  return JSON.parse(text.slice(prefix.length).replace(/;\s*$/, '')).stocks;
}

test('expansion non-financials keep high Z/M coverage; WSM rescued', () => {
  const stocks = loadExpansion();
  let nonFin = 0, z = 0, m = 0;
  for (const [ticker, stock] of Object.entries(stocks)) {
    if (!stock || typeof stock !== 'object') continue;
    if (isDistressFinancial(stock, ticker)) continue;
    nonFin++;
    if (Number.isFinite(stock.z_score)) z++;
    if (Number.isFinite(stock.m_score)) m++;
  }
  assert.ok(nonFin >= 600);
  assert.ok(z / nonFin >= 0.98, `Z coverage ${z}/${nonFin}`);
  assert.ok(m / nonFin >= 0.95, `M coverage ${m}/${nonFin}`);
  assert.ok(Number.isFinite(stocks.WSM.z_score), 'WSM z');
  assert.ok(Number.isFinite(stocks.WSM.m_score), 'WSM m');
});
