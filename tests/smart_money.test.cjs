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

test('classifyAction covers WhaleCreep new/added/reduced/exited/held', () => {
  assert.equal(SmartMoney.classifyAction({ isNew: true, shares: 100, lastShares: 0 }), 'new');
  assert.equal(SmartMoney.classifyAction({ isSoldOut: true, shares: 0, lastShares: 50 }), 'exited');
  assert.equal(SmartMoney.classifyAction({ shares: 120, lastShares: 100, changeInShares: 20 }), 'added');
  assert.equal(SmartMoney.classifyAction({ shares: 80, lastShares: 100, changeInShares: -20 }), 'reduced');
  assert.equal(SmartMoney.classifyAction({ shares: 100, lastShares: 100, changeInShares: 0 }), 'held');
});

test('finite treats null as missing, not zero', () => {
  assert.equal(SmartMoney.finite(null), null);
  assert.equal(SmartMoney.finite(undefined), null);
  assert.equal(SmartMoney.finite(''), null);
  assert.equal(SmartMoney.finite(0), 0);
  assert.equal(SmartMoney.finite('12.5'), 12.5);
});

test('mergeRowsByCik merges true split lots but not amendment restatements', () => {
  const split = SmartMoney.mergeRowsByCik([
    { cik: '0001067983', symbol: 'AAPL', shares: 1e6, marketValue: 10, date: '2025-06-30' },
    { cik: '0001067983', symbol: 'AAPL', shares: 500e3, marketValue: 5, date: '2025-06-30' },
    { cik: '0002012383', symbol: 'AAPL', shares: 9e9, investorName: 'BLACKROCK' },
  ]);
  assert.equal(split.length, 2);
  const brk = split.find(row => row.cik === '0001067983');
  assert.equal(brk.shares, 1.5e6);
  assert.equal(brk.marketValue, 15);

  // Same shares+value, newer filingDate = amendment restatement, not a second lot.
  const amended = SmartMoney.mergeRowsByCik([
    { cik: '0001709323', symbol: 'AAPL', shares: 110600, marketValue: 28162078,
      filingDate: '2025-11-12', date: '2025-09-30' },
    { cik: '0001709323', symbol: 'AAPL', shares: 110600, marketValue: 28162078,
      filingDate: '2026-02-17', date: '2025-12-31' },
  ]);
  assert.equal(amended.length, 1);
  assert.equal(amended[0].shares, 110600);
  assert.equal(amended[0].marketValue, 28162078);
  assert.equal(amended[0].filingDate, '2026-02-17');
});

test('buildStockSnapshot synthesizes exits only across observed quarters', () => {
  const snap = SmartMoney.buildStockSnapshot('AAPL', [
    { cik: '0001067983', symbol: 'AAPL', sharesNumber: 280e6, lastSharesNumber: 300e6,
      changeInSharesNumber: -20e6, marketValue: 57e9, weight: 12.5, date: '2025-06-30',
      year: 2025, quarter: 2, investorName: 'Berkshire Hathaway' },
  ], [
    { cik: '0001067983', symbol: 'AAPL', sharesNumber: 300e6, marketValue: 60e9,
      date: '2025-03-31', year: 2025, quarter: 1, investorName: 'Berkshire Hathaway' },
    { cik: '0001656456', symbol: 'AAPL', sharesNumber: 835e3, marketValue: 200e6,
      date: '2025-03-31', year: 2025, quarter: 1, investorName: 'Appaloosa' },
  ], { year: 2025, quarter: 2 });

  assert.equal(snap.key, '2025-Q2');
  assert.equal(snap.holders.length, 1);
  assert.equal(snap.holders[0].cik, '0001067983');
  assert.equal(snap.holders[0].action, 'reduced');
  assert.equal(snap.holders[0].isCurated, true);
  assert.equal(snap.exits.length, 1);
  assert.equal(snap.exits[0].cik, '0001656456');
  assert.equal(snap.exits[0].action, 'exited');
  assert.equal(snap.kpis.holders, 1);
  assert.equal(snap.kpis.exitedCount, 1);
});

test('incomplete prior does not invent exits when prior rows empty', () => {
  const snap = SmartMoney.buildStockSnapshot('AAPL', [
    { cik: '0001067983', symbol: 'AAPL', sharesNumber: 300e6, marketValue: 60e9,
      year: 2025, quarter: 1, investorName: 'Berkshire' },
  ], [], { year: 2025, quarter: 1 });
  assert.equal(snap.holders.length, 1);
  assert.equal(snap.exits.length, 0);
});

test('recentQuarterSpecs skips filing-window incomplete quarter', () => {
  // 2026-11-02 is within ~45d of 2026-Q3 end → start at 2026-Q2
  const specs = SmartMoney.recentQuarterSpecs(2, new Date(Date.UTC(2026, 10, 2)));
  assert.deepEqual(specs.map(s => s.key), ['2026-Q2', '2026-Q1']);
  const fromDates = SmartMoney.quarterSpecsFromDates([
    { year: 2026, quarter: 2 }, { year: 2026, quarter: 1 }, { year: 2025, quarter: 4 },
  ], 2);
  assert.deepEqual(fromDates.map(s => s.key), ['2026-Q2', '2026-Q1']);
});

test('sparse coverage suppresses mass synthetic exits', () => {
  const current = Array.from({ length: 20 }, (_, i) => ({
    cik: String(1000000000 + i).padStart(10, '0'), symbol: 'AAPL',
    sharesNumber: 1000, marketValue: 1e6, weight: 1, year: 2025, quarter: 2,
    investorName: `F${i}`,
  }));
  const prior = Array.from({ length: 100 }, (_, i) => ({
    cik: String(1000000000 + i).padStart(10, '0'), symbol: 'AAPL',
    sharesNumber: 1000, marketValue: 50e6, weight: 5, year: 2025, quarter: 1,
    investorName: `F${i}`,
  }));
  const snap = SmartMoney.buildStockSnapshot('AAPL', current, prior, { year: 2025, quarter: 2 });
  assert.equal(snap.exits.length, 0);
});

test('compareFundHoldings marks new/added/reduced/exited vs prior quarter', () => {
  const compared = SmartMoney.compareFundHoldings([
    { symbol: 'TSM', nameOfIssuer: 'TSMC', shares: 81800, marketValue: 39.1e6, weight: 63.7, sector: 'Technology' },
    { symbol: 'BABA', nameOfIssuer: 'Alibaba', shares: 50000, marketValue: 9e6, weight: 14.7, sector: 'Consumer Cyclical' },
  ], [
    { symbol: 'TSM', nameOfIssuer: 'TSMC', shares: 79400, marketValue: 50e6, weight: 50, sector: 'Technology' },
    { symbol: 'BABA', nameOfIssuer: 'Alibaba', shares: 100000, marketValue: 20e6, weight: 30, sector: 'Consumer Cyclical' },
    { symbol: 'MNSO', nameOfIssuer: 'MINISO', shares: 10, marketValue: 1e6, weight: 5, sector: 'Consumer Cyclical' },
  ]);
  assert.equal(compared.holdings.find(r => r.symbol === 'TSM').action, 'added');
  assert.equal(compared.holdings.find(r => r.symbol === 'BABA').action, 'reduced');
  assert.equal(compared.exited.length, 1);
  assert.equal(compared.exited[0].symbol, 'MNSO');
  assert.equal(compared.kpis.exitedCount, 1);
  assert.ok(compared.kpis.book > 0);
});

test('compareFundHoldings keys dual-class lots by CUSIP / class not symbol alone', () => {
  const compared = SmartMoney.compareFundHoldings([
    { symbol: 'GOOG', securityCusip: '02079K107', titleOfClass: 'CAP STK CL C', shares: 100, marketValue: 10e6, weight: 60 },
    { symbol: 'GOOG', securityCusip: '02079K305', titleOfClass: 'CAP STK CL A', shares: 50, marketValue: 5e6, weight: 30 },
  ], [
    { symbol: 'GOOG', securityCusip: '02079K107', titleOfClass: 'CAP STK CL C', shares: 80, marketValue: 8e6, weight: 50 },
    { symbol: 'GOOG', securityCusip: '02079K305', titleOfClass: 'CAP STK CL A', shares: 50, marketValue: 5e6, weight: 30 },
    { symbol: 'GOOG', securityCusip: '02079K999', titleOfClass: 'CAP STK CL B', shares: 10, marketValue: 1e6, weight: 5 },
  ]);
  assert.equal(compared.holdings.length, 2);
  assert.equal(compared.holdings.find(r => r.securityCusip === '02079K107').action, 'added');
  assert.equal(compared.holdings.find(r => r.securityCusip === '02079K305').action, 'held');
  assert.equal(compared.exited.length, 1);
  assert.equal(compared.exited[0].securityCusip, '02079K999');
  // Without CUSIP, symbol + titleOfClass still keeps dual-class lots distinct.
  const byClass = SmartMoney.compareFundHoldings([
    { symbol: 'BRK', titleOfClass: 'CL A', shares: 1, marketValue: 100 },
    { symbol: 'BRK', titleOfClass: 'CL B', shares: 200, marketValue: 50 },
  ], [
    { symbol: 'BRK', titleOfClass: 'CL A', shares: 1, marketValue: 90 },
    { symbol: 'BRK', titleOfClass: 'CL B', shares: 100, marketValue: 40 },
  ]);
  assert.equal(byClass.holdings.length, 2);
  assert.equal(byClass.holdings.find(r => r.titleOfClass === 'CL A').action, 'held');
  assert.equal(byClass.holdings.find(r => r.titleOfClass === 'CL B').action, 'added');
});

test('selectFundQuarter rejects missing / invalid ?vs= instead of silent latest', () => {
  const quarters = [
    { year: 2025, quarter: 2, rows: [{ symbol: 'AAPL' }] },
    { year: 2025, quarter: 1, rows: [{ symbol: 'AAPL' }] },
  ];
  assert.equal(SmartMoney.selectFundQuarter(quarters, null).quarter, 2);
  assert.equal(SmartMoney.selectFundQuarter(quarters, { year: 2025, quarter: 1 }).quarter, 1);
  assert.throws(
    () => SmartMoney.selectFundQuarter(quarters, { year: 2024, quarter: 4 }),
    /FUND_QUARTER_NOT_FOUND:2024-Q4/,
  );
  assert.match(SmartMoney.parseQuarterKey('2025-q2') && 'ok', /ok/);
  assert.equal(SmartMoney.parseQuarterKey('2025-q9'), null);
});

test('HK listings are not US 13F eligible', () => {
  assert.equal(SmartMoney.isUsListed({ ticker: '0700.HK', calculationCurrency: 'HKD' }), false);
  assert.equal(SmartMoney.isUsListed({ ticker: 'AAPL', calculationCurrency: 'USD' }), true);
});

test('allowedCik / resolveFundIdentity / fundHref', () => {
  assert.equal(SmartMoney.allowedCik('0001067983'), '0001067983');
  assert.equal(SmartMoney.allowedCik('1067983'), '0001067983');
  assert.equal(SmartMoney.allowedCik('0002012383'), null);
  const id = SmartMoney.resolveFundIdentity('berkshire-hathaway');
  assert.equal(id.cik, '0001067983');
  assert.equal(id.slug, 'berkshire-hathaway');
  assert.equal(SmartMoney.fundHref('berkshire-hathaway', '2025-Q4'), '#fund/berkshire-hathaway?vs=2025-q4');
  assert.equal(SmartMoney.slugify('HCEP Management Ltd'), 'hcep-management-ltd');
});

test('effectivePositions treats percent-of-book weights like WhaleCreep', () => {
  const n = SmartMoney.effectivePositions([22, 17, 11, 9, 9, 5, 4, 4, 4, 3]);
  assert.ok(n > 7 && n < 12);
  const compared = SmartMoney.compareFundHoldings([
    { symbol: 'AAPL', shares: 100, marketValue: 22, weight: 22 },
    { symbol: 'AXP', shares: 50, marketValue: 17, weight: 17 },
  ], [
    { symbol: 'AAPL', shares: 100, marketValue: 20, weight: 20 },
    { symbol: 'STZ', shares: 10, marketValue: 1, weight: 1 },
  ]);
  assert.equal(compared.exited[0].symbol, 'STZ');
  assert.ok(compared.exited[0].priorWeight != null);
  assert.ok(compared.kpis.effectiveN > 1);
});
