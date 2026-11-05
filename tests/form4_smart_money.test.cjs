'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const SmartMoney = require('../smart_money.js');

const FORM4_DIR = path.join(__dirname, '..', 'cache', 'smart-money', 'form4');

test('normalizeForm4Trade maps FMP Form 4 rows and flags curated reporting CIKs', () => {
  const raw = {
    symbol: 'SIRI',
    filingDate: '2026-11-03',
    transactionDate: '2026-11-02',
    reportingCik: '1067983',
    companyCik: '908937',
    transactionType: 'P-Purchase',
    securitiesOwned: 125618050,
    reportingName: 'BERKSHIRE HATHAWAY INC',
    typeOfOwner: '10 percent owner',
    acquisitionOrDisposition: 'A',
    formType: '4',
    securitiesTransacted: 66968,
    price: 29.466,
    url: 'https://www.sec.gov/Archives/edgar/data/1067983/x.htm',
  };
  const trade = SmartMoney.normalizeForm4Trade(raw, 'SIRI');
  assert.equal(trade.reportingCik, '0001067983');
  assert.equal(trade.is_buy, true);
  assert.equal(trade.isCurated, true);
  assert.equal(trade.shares, 66968);
  assert.ok(Math.abs(trade.total_val - (66968 * 29.466 / 1e6)) < 1e-9);
  assert.match(trade.url, /^https:\/\/www\.sec\.gov\//);
  assert.equal(SmartMoney.form4SideLabel(true, 'en'), 'Buy');
  assert.equal(SmartMoney.form4SideLabel(false, 'zh'), '賣出');
});

test('normalizeForm4Trade drops other symbols and awards without inventing buys', () => {
  assert.equal(SmartMoney.normalizeForm4Trade({
    symbol: 'AAPL', securitiesTransacted: 1, transactionType: 'P-Purchase',
    reportingName: 'x', transactionDate: '2026-01-01',
  }, 'SIRI'), null);
  const award = SmartMoney.normalizeForm4Trade({
    symbol: 'AAPL',
    filingDate: '2026-10-19',
    transactionDate: '2026-10-15',
    reportingName: 'Borders Ben',
    typeOfOwner: 'officer',
    transactionType: 'M-Exempt',
    securitiesTransacted: 1714,
    price: 0,
    formType: '4',
  }, 'AAPL');
  assert.equal(award.is_buy, null);
  assert.equal(award.price, 0);
  assert.equal(award.total_val, 0);
});

test('committed Form 4 seeds exist for SIRI (Berkshire) and AAPL', () => {
  for (const ticker of ['SIRI', 'AAPL']) {
    const body = JSON.parse(fs.readFileSync(path.join(FORM4_DIR, `${ticker}.json`), 'utf8'));
    assert.equal(body.ticker, ticker);
    assert.equal(body.seed, true);
    assert.ok(Array.isArray(body.trades) && body.trades.length > 0);
    const slim = SmartMoney.slimForm4Trades(body.trades, ticker);
    assert.ok(slim.length > 0);
    assert.equal(slim.length, body.trades.length, 'committed seeds should already be slim/deduped');
    assert.ok(slim.length <= SmartMoney.FORM4_TRADE_CAP);
  }
  const siri = JSON.parse(fs.readFileSync(path.join(FORM4_DIR, 'SIRI.json'), 'utf8'));
  const brk = siri.trades.filter(row => row.isCurated || row.reportingCik === '0001067983');
  assert.ok(brk.length >= 1, 'SIRI seed should include Berkshire Form 4 buys');
  assert.ok(brk.some(row => row.is_buy === true));
});

test('loadForm4 prefers seed cache and falls back to stock meta when skipLive', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.includes('cache/smart-money/form4/AAPL.json')) {
      const body = fs.readFileSync(path.join(FORM4_DIR, 'AAPL.json'), 'utf8');
      return { ok: true, json: async () => JSON.parse(body) };
    }
    if (href.includes('cache/smart-money/form4/ZZZZ.json')) {
      return { ok: false, status: 404 };
    }
    throw new Error(`unexpected fetch ${href}`);
  };
  try {
    const cached = await SmartMoney.loadForm4('AAPL', { skipLive: true });
    assert.equal(cached.source, 'cache');
    assert.ok(cached.trades.length > 0);

    const meta = await SmartMoney.loadForm4('ZZZZ', {
      skipLive: true,
      fallbackTrades: [{
        date: '2026-01-02', name: 'Meta Filer', title: 'officer',
        is_buy: true, action: 'P-Purchase', shares: 10, price: 1.5, total_val: 0.000015,
      }],
    });
    assert.equal(meta.source, 'stock-meta');
    assert.equal(meta.trades.length, 1);
    assert.equal(meta.trades[0].name, 'Meta Filer');

    const empty = await SmartMoney.loadForm4('ZZZZ', { skipLive: true });
    assert.equal(empty.source, 'empty');
    assert.equal(empty.trades.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
