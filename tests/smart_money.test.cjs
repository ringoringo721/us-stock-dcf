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
  assert.equal(SmartMoney.recentQuarterSpecs(6, new Date(Date.UTC(2026, 10, 2))).length, 6);
});

test('loadStock live walks empty quarters and surfaces API errors', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('cache/')) return { ok: false, status: 404, json: async () => ({}) };
    calls.push(u);
    const qs = new URL(u, 'http://local').searchParams;
    const year = Number(qs.get('year'));
    const quarter = Number(qs.get('quarter'));
    // Newest two quarters empty / failing — older one succeeds.
    if (year === 2026 && quarter === 2) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    if (year === 2026 && quarter === 1) {
      return {
        ok: false, status: 503,
        json: async () => ({ error: 'FMP_NOT_CONFIGURED' }),
      };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        data: [{
          cik: '0001067983', investorName: 'Berkshire Hathaway', symbol: 'NKE',
          sharesNumber: 100, marketValue: 1e6, weight: 1, year, quarter,
          date: `${year}-0${quarter * 3}-28`,
        }],
      }),
    };
  };
  const result = await SmartMoney.loadStock('NKE', { liveQuarters: 4 });
  assert.equal(result.source, 'live');
  assert.ok(result.snapshot.holders.length >= 1);
  assert.ok(calls.some(u => u.includes('year=2025') || u.includes('quarter=4')
    || u.includes('year=2026')));
  // No usable live quarters + no curated hit → honest empty (not FMP_NOT_CONFIGURED throw).
  SmartMoney.resetCuratedByTickerCache();
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('curated-by-ticker.json')) {
      return { ok: true, status: 200, json: async () => ({ tickers: {} }) };
    }
    if (u.startsWith('cache/')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: false, status: 503, json: async () => ({ error: 'FMP_NOT_CONFIGURED' }) };
  };
  const empty = await SmartMoney.loadStock('ZZZ');
  assert.equal(empty.source, 'empty');
  assert.equal(empty.snapshot.holders.length, 0);
  assert.match(String(empty.notice), /SMART_MONEY_NO_CURATED/);
  assert.ok((empty.liveErrors || []).some(msg => /FMP_NOT_CONFIGURED/.test(msg)));
});

test('loadStock falls back to curated-by-ticker invert when FMP is down', async () => {
  SmartMoney.resetCuratedByTickerCache();
  const index = SmartMoney.buildCuratedByTickerIndex([{
    cik: '0001067983',
    slug: 'berkshire-hathaway',
    investorName: 'Berkshire Hathaway',
    quarters: [
      {
        year: 2026, quarter: 2, key: '2026-Q2',
        rows: [{ symbol: 'KO', shares: 4e8, value: 32e9, weight: 12 }],
      },
      {
        year: 2026, quarter: 1, key: '2026-Q1',
        rows: [{ symbol: 'KO', shares: 4e8, value: 30e9, weight: 11 }],
      },
    ],
  }]);
  assert.ok(index.tickers.KO);
  assert.equal(index.count, 1);

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('curated-by-ticker.json')) {
      return { ok: true, status: 200, json: async () => index };
    }
    if (u.startsWith('cache/')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: false, status: 503, json: async () => ({ error: 'FMP_NOT_CONFIGURED' }) };
  };
  const result = await SmartMoney.loadStock('KO', { liveQuarters: 2 });
  assert.equal(result.source, 'curated-index');
  assert.ok(result.snapshot.holders.some(row => row.cik === '0001067983'));
  assert.equal(result.snapshot.holders[0].investorName, 'Berkshire Hathaway');
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

test('truncated books do not invent −100% exits from holderCap churn', () => {
  const current = [
    { cik: '0001067983', symbol: 'AAPL', sharesNumber: 200e6, marketValue: 50e9,
      weight: 20, year: 2025, quarter: 2, investorName: 'Berkshire Hathaway' },
  ];
  const prior = [
    { cik: '0001067983', symbol: 'AAPL', sharesNumber: 200e6, marketValue: 48e9,
      weight: 19, year: 2025, quarter: 1, investorName: 'Berkshire Hathaway' },
    { cik: '0002012383', symbol: 'AAPL', sharesNumber: 1e6, marketValue: 200e6,
      weight: 0.6, year: 2025, quarter: 1, investorName: 'BLACKROCK, INC.' },
  ];
  const snap = SmartMoney.buildStockSnapshot('AAPL', current, prior, {
    year: 2025, quarter: 2, truncated: true,
  });
  assert.equal(snap.exits.length, 0);
  assert.equal(snap.exitsIncomplete, true);
  assert.equal(snap.kpis.exitedCount, 0);
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
  assert.equal(SmartMoney.allowedCik('0009999998'), null);
  SmartMoney.registerExtractAllowlist(['0002147005']);
  assert.equal(SmartMoney.allowedCik('0002147005'), '0002147005');
  // Extract allowlist ≠ curated-20 badge set.
  assert.equal(SmartMoney.isCuratedCik('0002147005'), false);
  assert.equal(SmartMoney.isCuratedCik('0001067983'), true);
  const id = SmartMoney.resolveFundIdentity('berkshire-hathaway');
  assert.equal(id.cik, '0001067983');
  assert.equal(id.slug, 'berkshire-hathaway');
  assert.equal(id.openable, true);
  assert.equal(SmartMoney.resolveFundIdentity('brk').cik, '0001067983');
  assert.equal(SmartMoney.fundHref('berkshire-hathaway', '2025-Q4'), '#fund/berkshire-hathaway?vs=2025-q4');
  assert.equal(SmartMoney.slugify('HCEP Management Ltd'), 'hcep-management-ltd');
  // Bare CIK is always openable — non-curated slug is fund-{cik}, never digits-as-title route.
  assert.equal(SmartMoney.resolveFundIdentity('0002147005').openable, true);
  assert.equal(SmartMoney.resolveFundIdentity('0002147005').slug, 'fund-0002147005');
  assert.equal(SmartMoney.resolveFundIdentity('fund-0001475365').cik, '0001475365');
  assert.equal(SmartMoney.isOpenableFundKey('framtiden-holdings-management-co-llc'), false);
});

test('resolveInvestorName never returns bare CIK as primary title', () => {
  SmartMoney.resetHolderNameMap();
  SmartMoney.registerHolderNames({
    '0001475365': 'SUMITOMO MITSUI TRUST GROUP, INC.',
    '0000902528': 'BANK HAPOALIM BM',
  });
  assert.equal(SmartMoney.looksLikeBareCik('0001475365', '0001475365'), true);
  assert.equal(SmartMoney.looksLikeBareCik('BANK HAPOALIM BM', '0000902528'), false);
  assert.equal(
    SmartMoney.resolveInvestorName({ cik: '0001475365', investorName: '0001475365' }),
    'SUMITOMO MITSUI TRUST GROUP, INC.',
  );
  assert.equal(
    SmartMoney.resolveInvestorName({ cik: '0000902528', slug: 'fund-0000902528' }),
    'BANK HAPOALIM BM',
  );
  assert.equal(
    SmartMoney.resolveInvestorName({ cik: '0001067983', investorName: '0001067983' }),
    'Berkshire Hathaway',
  );
  // Unknown CIK with only digit label → null (UI shows generic, not digits).
  assert.equal(SmartMoney.resolveInvestorName({ cik: '0009999991', investorName: '0009999991' }), null);
});

test('fundLinkForHolder links every CIK (curated slug; others fund-{cik})', () => {
  const brk = SmartMoney.fundLinkForHolder({
    cik: '0001067983', investorName: 'Berkshire Hathaway', isCurated: true,
  });
  assert.equal(brk.slug, 'berkshire-hathaway');
  assert.match(brk.href, /#fund\/berkshire-hathaway/);
  assert.ok(brk.curated);
  // Broad holders get fund-{cik} routes — titles resolve from investorName / holder-funds.
  const fenelon = SmartMoney.fundLinkForHolder({
    cik: '0002147005',
    investorName: 'FENELON OPPORTUNITY FUND INC.',
    isCurated: false,
  });
  assert.equal(fenelon.slug, 'fund-0002147005');
  assert.match(fenelon.href, /#fund\/fund-0002147005/);
  assert.equal(fenelon.curated, null);
  assert.equal(fenelon.investorName, 'FENELON OPPORTUNITY FUND INC.');
  const framtiden = SmartMoney.fundLinkForHolder({
    cik: '0002112734',
    investorName: 'FRAMTIDEN HOLDINGS MANAGEMENT CO LLC',
    isCurated: false,
  });
  assert.equal(framtiden.slug, 'fund-0002112734');
  assert.equal(SmartMoney.fundLinkForHolder({ investorName: 'No CIK Inc' }), null);
  assert.equal(SmartMoney.isOpenableFundKey('lone-pine-capital'), true);
  for (const inv of SmartMoney.INVESTORS) {
    const slug = SmartMoney.slugify(inv.nameEn);
    const bySlug = SmartMoney.resolveFundIdentity(slug);
    const byCik = SmartMoney.resolveFundIdentity(inv.cik);
    assert.equal(bySlug.cik, inv.cik, slug);
    assert.equal(byCik.slug, slug, inv.cik);
    assert.equal(bySlug.openable, true);
  }
});

test('buildHolderFundIndex inverts stock seeds into partial fund books', () => {
  const index = SmartMoney.buildHolderFundIndex([
    {
      ticker: 'GOOGL',
      quarters: [{
        year: 2026, quarter: 2, key: '2026-Q2',
        rows: [
          { cik: '0002147005', investorName: 'FENELON OPPORTUNITY FUND INC.',
            sharesNumber: 1000, marketValue: 2e6, weight: 1.2 },
          { cik: '0001709323', investorName: 'Himalaya Capital',
            sharesNumber: 500, marketValue: 1e6, weight: 0.5 },
        ],
      }],
    },
    {
      ticker: 'AAPL',
      quarters: [{
        year: 2026, quarter: 2, key: '2026-Q2',
        rows: [
          { cik: '0002147005', investorName: 'FENELON OPPORTUNITY FUND INC.',
            sharesNumber: 2000, marketValue: 3e6, weight: 0.8 },
        ],
      }],
    },
  ]);
  assert.equal(index.count, 2);
  assert.ok(index.funds['0002147005']);
  const expanded = SmartMoney.expandHolderFundEntry(index.funds['0002147005'], '0002147005');
  assert.equal(expanded.quarters[0].rows.length, 2);
  assert.ok(expanded.quarters[0].rows.some(r => r.symbol === 'GOOGL'));
  assert.ok(expanded.quarters[0].rows.some(r => r.symbol === 'AAPL'));
});

test('slimFundPayload unions holding identities across quarters (no false top-N exits)', () => {
  const { slimFundPayload } = require('../scripts/seed_smart_money.cjs');
  const payload = {
    cik: '0000902528',
    slug: 'fund-0000902528',
    investorName: 'BANK HAPOALIM BM',
    quarters: [
      {
        year: 2026, quarter: 2,
        rows: [
          { symbol: 'AAPL', securityCusip: '037833100', value: 100, shares: 1 },
          { symbol: 'MSFT', securityCusip: '594918104', value: 90, shares: 1 },
          // Still held, but outside independent top-2 — must not become a false exit.
          { symbol: 'OLD', securityCusip: 'OLDOLDOLD1', value: 50, shares: 1 },
        ],
      },
      {
        year: 2026, quarter: 1,
        rows: [
          { symbol: 'AAPL', securityCusip: '037833100', value: 95, shares: 1 },
          { symbol: 'OLD', securityCusip: 'OLDOLDOLD1', value: 88, shares: 1 },
          { symbol: 'MSFT', securityCusip: '594918104', value: 70, shares: 1 },
        ],
      },
    ],
  };
  const seeded = slimFundPayload(payload, { quarters: 2, holdingCap: 2 });
  // Top-2 union = {AAPL,MSFT} ∪ {AAPL,OLD} → keep all three when present in source.
  const q2 = seeded.quarters[0].rows.map(r => r.securityCusip).sort();
  const q1 = seeded.quarters[1].rows.map(r => r.securityCusip).sort();
  assert.deepEqual(q2, ['037833100', '594918104', 'OLDOLDOLD1']);
  assert.deepEqual(q1, ['037833100', '594918104', 'OLDOLDOLD1']);
  const compared = SmartMoney.compareFundHoldings(
    seeded.quarters[0].rows.map(r => SmartMoney.normalizeFundHolding(r)),
    seeded.quarters[1].rows.map(r => SmartMoney.normalizeFundHolding(r)),
  );
  assert.equal(compared.exited.length, 0);
  assert.equal(compared.holdings.find(r => r.securityCusip === 'OLDOLDOLD1').action, 'held');
  assert.equal(compared.holdings.find(r => r.securityCusip === '037833100').action, 'held');
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
