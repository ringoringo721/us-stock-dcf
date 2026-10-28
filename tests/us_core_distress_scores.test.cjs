'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { applyToStock } = require('../scripts/apply_distress_scores.cjs');

const root = path.join(__dirname, '..');

function loadCoreMarket() {
  return JSON.parse(fs.readFileSync(path.join(root, 'full_market_dcf.json'), 'utf8'));
}

function loadMarketJs() {
  const text = fs.readFileSync(path.join(root, 'market_data.js'), 'utf8');
  const prefix = 'window.FULL_MARKET_DATA = ';
  assert.ok(text.startsWith(prefix));
  return JSON.parse(text.slice(prefix.length).replace(/;\s*$/, ''));
}

test('US core mega-caps publish Altman Z and Beneish M (not N/A)', () => {
  const md = loadCoreMarket();
  const js = loadMarketJs();
  for (const ticker of ['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'TSM', 'AVGO', 'TSLA']) {
    const stock = md[ticker];
    assert.ok(stock, `${ticker} missing from full_market_dcf.json`);
    assert.equal(stock.fin_valuation?.is_financial, false);
    assert.ok(Number.isFinite(stock.z_score), `${ticker} z_score`);
    assert.ok(Number.isFinite(stock.m_score), `${ticker} m_score`);
    assert.ok(Array.isArray(stock.z_score_breakdown) && stock.z_score_breakdown.length === 5);
    assert.ok(Array.isArray(stock.m_score_breakdown) && stock.m_score_breakdown.length === 8);
    assert.equal(js[ticker].z_score, stock.z_score);
    assert.equal(js[ticker].m_score, stock.m_score);
  }
});

test('US core non-financials with statements_v2 get Z; banks stay N/A', () => {
  const md = loadCoreMarket();
  let nonFin = 0;
  let nonFinZ = 0;
  let nonFinM = 0;
  for (const [ticker, stock] of Object.entries(md)) {
    const financial = stock.fin_valuation?.is_financial === true;
    if (financial) {
      assert.equal(stock.z_score, null, ticker);
      assert.equal(stock.m_score, null, ticker);
      assert.equal(stock.ratingSources?.zScore?.reason, 'financialSectorNotApplicable');
      continue;
    }
    nonFin++;
    const statementsPath = path.join(root, 'cache/financials', `${ticker}_statements_v2.json`);
    assert.ok(fs.existsSync(statementsPath), `${ticker} statements`);
    if (Number.isFinite(stock.z_score)) nonFinZ++;
    if (Number.isFinite(stock.m_score)) nonFinM++;
  }
  assert.ok(nonFin >= 200);
  assert.equal(nonFinZ, nonFin, 'every non-financial core name should have Altman Z');
  // Walk-back fills LOW/AZO; every non-financial core name should have M.
  assert.equal(nonFinM, nonFin, `core Beneish M coverage ${nonFinM}/${nonFin}`);
  for (const ticker of ['NEE', 'SO', 'UNH', 'MMC', 'BRK.B', 'UNP', 'CNI', 'ENB', 'LOW', 'AZO']) {
    assert.ok(Number.isFinite(md[ticker].m_score), `${ticker} m_score`);
  }
});

test('applyToStock recomputes NVDA Z/M from statements_v2', () => {
  const md = loadCoreMarket();
  const stock = JSON.parse(JSON.stringify(md.NVDA));
  stock.z_score = null;
  stock.m_score = null;
  const { altman, beneish, financial } = applyToStock(stock, 'NVDA');
  assert.equal(financial, false);
  assert.ok(Number.isFinite(altman.score));
  assert.ok(Number.isFinite(beneish.score));
  assert.equal(stock.z_score, altman.score);
  assert.equal(stock.m_score, beneish.score);
});
