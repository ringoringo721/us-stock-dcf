'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PeerComparison = require('../peer_comparison.js');

function loadMarketContext() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'market_context.js'), 'utf8');
  const context = {
    module: { exports: {} },
    exports: {},
    URLSearchParams,
    location: { search: '?market=HKEX', hash: '' }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.module.exports;
}

function loadCompany(ticker) {
  return JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'hk_companies', `${ticker}.json`), 'utf8')).stock;
}

function loadStatements(ticker) {
  return JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'financials', `${ticker}_statements_v2.json`), 'utf8'));
}

test('statementsPackEmpty / statementsPackUnavailable detect empty provider packs', () => {
  const MarketContext = loadMarketContext();
  const empty = loadStatements('6082.HK');
  assert.equal(PeerComparison.statementsPackEmpty(empty), true);
  assert.equal(MarketContext.statementsPackUnavailable(empty), true);
  assert.equal(PeerComparison.statementsPackEmpty(loadStatements('0600.HK')), false);
  assert.equal(MarketContext.statementsPackUnavailable(loadStatements('0600.HK')), false);
  assert.match(MarketContext.statementsUnavailableShortMessage('zh'), /供應商無財報/);
});

test('0600.HK peers: empty-provider columns flag unavailable; filled FY columns keep real levels', () => {
  const cases = {
    '0600.HK': { empty: false, expectRevenue: true, expectNegFcf: true },
    '2533.HK': { empty: false, expectRevenue: true, expectNegFcf: true },
    '6675.HK': { empty: false, expectRevenue: true, expectNegFcf: true },
    '6082.HK': { empty: true },
    '3223.HK': { empty: true },
    '9903.HK': { empty: true }
  };
  for (const [ticker, expect] of Object.entries(cases)) {
    const stock = loadCompany(ticker);
    const data = loadStatements(ticker);
    const view = PeerComparison.annualView(stock, data);
    assert.equal(!!view.peerAnnual.providerStatementsUnavailable, expect.empty, ticker);
    if (expect.empty) {
      assert.equal(view.peerAnnual.date, null, ticker);
      assert.equal(view.peerAnnual.income.revenue, null, ticker);
      assert.equal(view.peerAnnual.reason, 'missingFullFiscalYear', ticker);
    } else {
      assert.ok(view.peerAnnual.date, ticker);
      assert.ok(Number.isFinite(view.peerAnnual.income.revenue), `${ticker} revenue`);
      assert.ok(view.peerAnnual.income.revenue > 0, `${ticker} revenue positive`);
      if (expect.expectNegFcf) {
        assert.ok(Number.isFinite(view.peerAnnual.cashflow.freeCashFlow), `${ticker} fcf`);
        assert.ok(view.peerAnnual.cashflow.freeCashFlow < 0, `${ticker} fcf negative`);
        // Positive-denominator multiples stay null — not a blanking bug.
        assert.equal(view.ev_to_ebitda, null, `${ticker} EV/EBITDA`);
      }
    }
  }
});

test('2533.HK recovers P/B with verified shares; 0600 keeps P/B N/A when share basis unverified', () => {
  const filled = PeerComparison.annualView(loadCompany('2533.HK'), loadStatements('2533.HK'));
  assert.ok(Number.isFinite(filled.pb_trailing), '2533 P/B');
  const unverified = PeerComparison.annualView(loadCompany('0600.HK'), loadStatements('0600.HK'));
  assert.equal(unverified.pb_trailing, null);
  assert.equal(unverified.shareBasis, 'unverifiedMixedShareClasses');
  // Revenue / EV / EV-Revenue remain available from FY pack — not wiped.
  assert.ok(Number.isFinite(unverified.peerAnnual.income.revenue));
  assert.ok(Number.isFinite(unverified.EV));
  const evRev = unverified.EV / unverified.peerAnnual.income.revenue;
  assert.ok(Number.isFinite(evRev) && evRev > 0);
});
