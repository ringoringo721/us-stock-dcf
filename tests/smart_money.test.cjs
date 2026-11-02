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

test('filterCurated keeps only allowlisted CIKs for the ticker', () => {
  const rows = SmartMoney.filterCurated([
    { cik: '0001067983', symbol: 'AAPL', sharesNumber: 1e6, date: '2025-06-30', isNew: false },
    { cik: '0002012383', symbol: 'AAPL', sharesNumber: 9e9, investorName: 'BLACKROCK' },
    { cik: '1067983', symbol: 'MSFT', sharesNumber: 1 },
  ], 'AAPL');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cik, '0001067983');
  assert.equal(SmartMoney.classifyAction(rows[0]), 'hold');
});

test('buildSnapshot builds holder and matrix history', () => {
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
