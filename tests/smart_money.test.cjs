'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SmartMoney = require('../smart_money.js');

test('curated list is exactly 20 unique CIKs', () => {
  assert.equal(SmartMoney.INVESTORS.length, 20);
  const cik = SmartMoney.INVESTORS.map(row => row.cik);
  assert.equal(new Set(cik).size, 20);
  for (const row of SmartMoney.INVESTORS) {
    assert.match(row.cik, /^000\d{7}$/);
    assert.ok(row.nameEn && row.nameZh);
  }
});

test('classifyAction covers new/add/trim/exit/hold', () => {
  assert.equal(SmartMoney.classifyAction({ isNew: true, shares: 100, lastShares: 0 }), 'new');
  assert.equal(SmartMoney.classifyAction({ isSoldOut: true, shares: 0, lastShares: 50 }), 'exit');
  assert.equal(SmartMoney.classifyAction({ shares: 120, lastShares: 100, changeInShares: 20 }), 'add');
  assert.equal(SmartMoney.classifyAction({ shares: 80, lastShares: 100, changeInShares: -20 }), 'trim');
  assert.equal(SmartMoney.classifyAction({ shares: 100, lastShares: 100, changeInShares: 0 }), 'hold');
});

test('finite treats null as missing, not zero', () => {
  assert.equal(SmartMoney.finite(null), null);
  assert.equal(SmartMoney.finite(undefined), null);
  assert.equal(SmartMoney.finite(''), null);
  assert.equal(SmartMoney.finite(0), 0);
  assert.equal(SmartMoney.finite('12.5'), 12.5);
});

test('filterCurated merges true split lots but not amendment restatements', () => {
  const split = SmartMoney.filterCurated([
    { cik: '0001067983', symbol: 'AAPL', sharesNumber: 1e6, marketValue: 10, date: '2025-06-30' },
    { cik: '0001067983', symbol: 'AAPL', sharesNumber: 500e3, marketValue: 5, date: '2025-06-30' },
    { cik: '0002012383', symbol: 'AAPL', sharesNumber: 9e9, investorName: 'BLACKROCK' },
  ], 'AAPL');
  assert.equal(split.length, 1);
  assert.equal(split[0].shares, 1.5e6);
  assert.equal(split[0].marketValue, 15);

  // Same shares+value, newer filingDate = amendment restatement, not a second lot.
  const amended = SmartMoney.filterCurated([
    { cik: '0001709323', symbol: 'AAPL', sharesNumber: 110600, marketValue: 28162078,
      filingDate: '2025-11-12', date: '2025-09-30' },
    { cik: '0001709323', symbol: 'AAPL', sharesNumber: 110600, marketValue: 28162078,
      filingDate: '2026-02-17', date: '2025-12-31' },
  ], 'AAPL');
  assert.equal(amended.length, 1);
  assert.equal(amended[0].shares, 110600);
  assert.equal(amended[0].marketValue, 28162078);
  assert.equal(amended[0].filingDate, '2026-02-17');
});

test('buildSnapshot synthesizes exits only across observed quarters', () => {
  const snap = SmartMoney.buildSnapshot('AAPL', [
    {
      year: 2025, quarter: 2, rows: [
        { cik: '0001067983', symbol: 'AAPL', sharesNumber: 280e6, lastSharesNumber: 300e6,
          changeInSharesNumber: -20e6, marketValue: 57e9, date: '2025-06-30' },
      ],
    },
    {
      year: 2025, quarter: 1, rows: [
        { cik: '0001067983', symbol: 'AAPL', sharesNumber: 300e6, lastSharesNumber: 300e6,
          changeInSharesNumber: 0, marketValue: 60e9, date: '2025-03-31' },
        // Appaloosa held Q1 but missing from Q2 analytics → must become exit, not stale holder.
        { cik: '0001656456', symbol: 'AAPL', sharesNumber: 835e3, marketValue: 200e6, date: '2025-03-31' },
      ],
    },
  ]);
  assert.deepEqual(snap.quarters, ['2025-Q2', '2025-Q1']);
  assert.equal(snap.holders.length, 1);
  assert.equal(snap.holders[0].cik, '0001067983');
  assert.equal(snap.holders[0].latestAction, 'trim');
  const brk = snap.investors.find(row => row.cik === '0001067983');
  assert.equal(brk.history[0].action, 'trim');
  assert.equal(brk.history[1].action, 'hold');
  const app = snap.investors.find(row => row.cik === '0001656456');
  assert.equal(app.holding, false);
  assert.equal(app.latestAction, 'exit');
  assert.equal(app.history[0].action, 'exit');
  assert.equal(app.history[0].shares, 0);
  assert.equal(snap.exits.some(row => row.cik === '0001656456'), true);

  // Failed / incomplete newest quarter must not wipe holders via mass synthetic exits.
  const partial = SmartMoney.buildSnapshot('AAPL', [
    { year: 2025, quarter: 2, rows: [], error: new Error('429'), incomplete: true },
    {
      year: 2025, quarter: 1, rows: [
        { cik: '0001067983', symbol: 'AAPL', sharesNumber: 300e6, marketValue: 60e9 },
      ],
    },
  ]);
  assert.deepEqual(partial.quarters, ['2025-Q1']);
  assert.equal(partial.holders.length, 1);
  assert.equal(partial.holders[0].cik, '0001067983');
  assert.equal(partial.exits.length, 0);
});

test('HK listings are not US 13F eligible', () => {
  assert.equal(SmartMoney.isUsListed({ ticker: '0700.HK', calculationCurrency: 'HKD' }), false);
  assert.equal(SmartMoney.isUsListed({ ticker: 'AAPL', calculationCurrency: 'USD' }), true);
});

test('allowedCik rejects unknown managers', () => {
  assert.equal(SmartMoney.allowedCik('0001067983'), '0001067983');
  assert.equal(SmartMoney.allowedCik('1067983'), '0001067983');
  assert.equal(SmartMoney.allowedCik('0002012383'), null);
});
