const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const config = require('../hkex_stocks.json');
const source = require('../cache/hsi_constituents.json');
const market = require('../hk_market_dcf.json');
const gaming = require('../cache/hkex_gaming_universe.json');

test('HK universe preserves exactly 95 official HSI members and a separately sourced gaming extension', () => {
  assert.equal(source.index, 'Hang Seng Index');
  assert.equal(source.announcedDate, '2026-08-21');
  assert.equal(source.effectiveDate, '2026-09-07');
  assert.match(source.sourceUrl, /^https:\/\/www\.hsi\.com\.hk\/.*20260821T174500\.pdf$/);
  assert.match(source.sourceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(source.pdfPages, [1, 5, 6]);
  assert.equal(source.constituentCount, 95);
  assert.equal(source.constituents.length, 95);
  const hsi = config.filter(stock => !stock.universeMembership);
  const extension = config.filter(stock => stock.universeMembership === 'HK gaming extension');
  assert.equal(hsi.length, 95);
  assert.equal(extension.length, 19);
  assert.equal(config.length, 114);
  assert.equal(new Set(config.map(stock => stock.ticker)).size, 114);
  assert.deepEqual(hsi.map(stock => stock.ticker).sort(),
    source.constituents.map(stock => stock.ticker).sort());
  assert.match(gaming.listingSource.url, /ListOfSecurities\.xlsx$/);
  assert.match(gaming.listingSource.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual([...gaming.officialHsiMembers, ...extension.map(stock => stock.ticker)].sort(), gaming.symbols.slice().sort());
  assert.ok(extension.every(stock => stock.reviewedPeriodsRequired));
  assert.ok(gaming.exclusions.every(stock => !config.some(item => item.ticker === stock.symbol)));
  for (const stock of config) {
    assert.match(stock.ticker, /^\d{4}\.HK$/);
    assert.equal(stock.displayCode, stock.ticker.slice(0, 4).padStart(5, '0'));
    assert.ok(stock.name && stock.name_en && stock.sector && stock.industry, stock.ticker);
  }
});

test('all constituents have matching saved financials, actual daily prices and native company/model records', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'hk_market_data.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'fmp_model_data.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(market).sort(), config.map(stock => stock.ticker).sort());
  assert.deepEqual(Object.keys(context.window.HK_MARKET_DATA).sort(), Object.keys(market).sort());
  for (const item of config) {
    const stock = market[item.ticker];
    assert.equal(stock.ticker, item.ticker);
    assert.equal(stock.name, item.name);
    assert.equal(stock.calculationCurrency, 'HKD');
    const asOf = stock.quoteAvailability?.capturedAt?.slice(0, 10) || stock.quoteDate;
    if (stock.quoteAvailability?.reason === 'staleQuote') {
      assert.equal(stock.price, null);
      assert.equal(stock.mcap, null);
      assert.ok(stock.lastTrade.price > 0);
      assert.equal(stock.lastTrade.date, stock.quoteDate);
      assert.ok((Date.parse(asOf) - Date.parse(stock.quoteDate)) / 86400000 > 14);
      for (const field of ['pe_trailing', 'pe_forward', 'pb_trailing', 'ps_ratio', 'ev_to_ebitda']) assert.equal(stock[field], null);
    } else assert.ok(stock.price > 0);
    assert.equal(stock.fin_valuation.is_financial, !!item.financial);
    const read = (directory, filename) => JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'cache', directory, filename || `${item.ticker}.json`), 'utf8'));
    const financials = read('financials', `${item.ticker}_statements_v2.json`);
    for (const type of ['income', 'balance', 'cashflow']) {
      assert.ok(financials.annual[type].length > 0
        || financials.qualityWarnings.some(warning => warning.code === 'providerStatementUnavailable' && warning.type === type),
      `${item.ticker}/${type}: absent statements require an explicit source warning`);
      for (const row of [...financials.annual[type], ...financials.quarterly[type]]) {
        assert.equal(row.symbol, item.ticker);
        assert.ok(row.date <= asOf, `${item.ticker}: no financials after the actual capture date, including when trading is stale`);
      }
    }
    const prices = read('price_charts');
    assert.equal(prices.currency, 'HKD');
    assert.ok(prices.rows.length > 0);
    assert.equal(new Set(prices.rows.map(row => row[0])).size, prices.rows.length);
    assert.ok(prices.rows.every((row, i) => row[0] <= prices.fetchedAt.slice(0, 10) && row[1] > 0
      && (!i || row[0] > prices.rows[i - 1][0])), item.ticker);
    const company = read('company');
    assert.equal(company.symbol, item.ticker);
    assert.equal(company.currency, 'HKD');
    assert.equal(context.window.FMP_MODEL_DATA.stocks[item.ticker].symbol, item.ticker);
    for (const model of Object.values(company.models)) {
      assert.ok(model.data.length || model.reason, `${item.ticker}: missing model reason`);
      assert.ok(model.data.every(row => row.symbol === item.ticker));
    }
    if (item.shareClassReviewRequired && stock.shareSource.scope !== 'issuerWideOrdinaryShares') {
      assert.equal(stock.shares, null);
      assert.equal(stock.shares_outstanding, null);
      assert.equal(stock.shareSource.reason, 'shareBasisUnverified');
    }
    if (item.financial) {
      const history = read('rote_history');
      assert.equal(history.symbol, item.ticker);
      assert.equal(history.years.length, 10);
      assert.ok(history.years.every(row => Number.isFinite(row.value)));
    }
  }
});

test('banks and insurers retain financial valuation applicability, including new members', () => {
  assert.deepEqual(config.filter(stock => stock.financial).map(stock => stock.ticker).sort(),
    ['0005.HK', '0939.HK', '1299.HK', '1398.HK', '2318.HK', '2388.HK', '2628.HK', '3968.HK', '3988.HK']);
  assert.notEqual(config.find(stock => stock.ticker === '0388.HK').financial, true);
});

test('mixed-class constituents require an issuer-wide share review and preserve original HK safeguards', () => {
  for (const stock of source.constituents.filter(stock => stock.hShare)) {
    assert.equal(config.find(item => item.ticker === stock.ticker).shareClassReviewRequired, true, stock.ticker);
  }
  for (const ticker of ['0883.HK', '0941.HK', '0981.HK', '1347.HK']) {
    assert.equal(config.find(stock => stock.ticker === ticker).shareClassReviewRequired, true, ticker);
  }
  const link = config.find(stock => stock.ticker === '0823.HK');
  assert.equal(link.forecastTaxAssumption.rate, 16.5);
  assert.equal(link.noncontrollingClaimAssumption.value, 0);
  assert.equal(link.generalCorporateValuationWarning, true);
});
