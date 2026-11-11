'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CompanyData = require('../company_data.js');

test('metadata preserves pack-embedded insiders when hydrate stub is CACHE_MISSING', () => {
  const stock = {
    ticker: 'PR',
    price: 21.72,
    insider_trades: [
      { date: '2026-09-03', name: 'Oliphint Guy M', title: 'officer', is_buy: false,
        action: 'S-Sale', shares: 5103, price: 23.75, total_val: 0.12 }
    ],
    top_holders: [],
    inst_ownership_pct: null
  };
  const stub = {
    capturedAt: '2026-11-11T00:00:00.000Z',
    ownership: { data: [], reason: 'FMP_COMPANY_CACHE_MISSING' },
    holders: { data: [], reason: 'FMP_COMPANY_CACHE_MISSING' },
    insiders: { data: [], reason: 'FMP_COMPANY_CACHE_MISSING' },
    news: { data: [], reason: 'FMP_COMPANY_CACHE_MISSING' }
  };
  const meta = CompanyData.metadata(stub, stock);
  assert.equal(meta.insider_trades.length, 1);
  assert.equal(meta.insider_trades[0].name, 'Oliphint Guy M');
  assert.deepEqual(meta.top_holders, []);
  assert.equal(meta.inst_ownership_pct, null);
});

test('metadata prefers live FMP holders/insiders over pack when rows exist', () => {
  const stock = {
    ticker: 'PR', price: 20,
    insider_trades: [{ date: '2020-01-01', name: 'Old', title: 'x', is_buy: true,
      action: 'P', shares: 1, price: 1, total_val: 0 }],
    top_holders: []
  };
  const live = {
    capturedAt: '2026-11-11T00:00:00.000Z',
    ownership: { data: [{ symbol: 'PR', ownershipPercent: 55.5, date: '2026-06-30' }], reason: null },
    holders: { data: [{
      symbol: 'PR', putCallShare: 'Share', sharesNumber: 1e6, investorName: 'BlackRock',
      ownership: 1.2, date: '2026-06-30', changeInSharesNumberPercentage: 2
    }], reason: null },
    insiders: { data: [{
      symbol: 'PR', transactionDate: '2026-09-01', reportingName: 'New Insider',
      typeOfOwner: 'officer', transactionType: 'P-Purchase', securitiesTransacted: 100, price: 10
    }], reason: null },
    news: { data: [] }
  };
  const meta = CompanyData.metadata(live, stock);
  assert.equal(meta.inst_ownership_pct, 55.5);
  assert.equal(meta.top_holders.length, 1);
  assert.equal(meta.top_holders[0].name, 'BlackRock');
  assert.equal(meta.insider_trades.length, 1);
  assert.equal(meta.insider_trades[0].name, 'New Insider');
});
