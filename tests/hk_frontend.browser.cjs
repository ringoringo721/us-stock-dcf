const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const tickers = ['0700.HK', '9988.HK', '0388.HK', '0005.HK', '0939.HK', '0823.HK'];

// These explicit, isolated arithmetic fixtures never ship as production stock data.
const rows = Array.from({ length: 6 }, (_, i) => ({
  fiscalYear: 2022 + Math.floor(i / 2), period: i % 2 ? 'Q4' : 'Q2',
  date: `${2022 + Math.floor(i / 2)}-${i % 2 ? '12-31' : '06-30'}`,
  reportedCurrency: 'HKD', periodLength: '6M',
  revenue: (i + 1) * 1e6, grossProfit: (i + 1) * 4e5, operatingIncome: (i + 1) * 2e5,
  netIncome: (i + 1) * 1e5, totalAssets: (i + 1) * 1e7,
  totalStockholdersEquity: (i + 1) * 5e6, goodwillAndIntangibleAssets: 0,
  freeCashFlow: (i + 1) * 5e4, epsDiluted: i + 1, weightedAverageShsOutDil: 1e6,
  commonDividendsPaid: -(i + 1) * 1e4
}));
const statements = { calculationCurrency: 'HKD', reportingFrequency: 'semiannual',
  statementFrequencies: { income: 'semiannual', balance: 'semiannual', cashflow: 'semiannual' },
  annual: { income: [], balance: [], cashflow: [] },
  quarterly: { income: rows, balance: rows, cashflow: rows } };
const market = Object.fromEntries(tickers.map(ticker => [ticker, {
  ticker, name: `Integration fixture ${ticker}`, company_name: `Integration fixture ${ticker}`,
  exchange: 'HKEX', sector: 'Real Estate', industry: 'REIT - Retail', price: 100.125,
  mcap: 100, shares: 1, calculationCurrency: 'HKD', reportedCurrency: 'CNY',
  reportingFrequency: 'semiannual', statementFrequencies: statements.statementFrequencies,
  qualityWarnings: ['Fixture: source reconciliation has not been verified'],
  f_score: null, moat: null,
  ...(['0005.HK', '0939.HK'].includes(ticker) ? { fin_valuation: {
    is_financial: true, ke: null, g: null, rote: null, tbvps: null, pb_tangible: null, dps_total: null,
    reason: ticker === '0939.HK' ? 'shareBasisUnverified' : 'missingHkdRiskFreeRate',
    reference: { date: '2024-12-31', label: 'FY 2024 H2', rote: null, warnings: [],
      reason: ticker === '0939.HK' ? 'shareBasisUnverified' : 'missingHkdRiskFreeRate' }
  } } : {}),
  ratingSources: { fScore: { asOfDate: '2024-12-31', period: 'FY 2024', evaluatedTests: 0, reason: 'Fixture: insufficient evidence' },
    moat: { asOfDate: '2024-12-31', reason: 'Fixture: evidence unavailable' } },
  statements_raw: { annual_dates: [], income: {}, balance: {}, cashflow: {},
    quarterly_raw: { dates: rows.map(row => row.date), periods: rows.map(row => `FY ${row.fiscalYear} ${row.period}`),
      income: {}, balance: {}, cashflow: {} } }
}]));
const price = ticker => ({ version: 1, ticker, providerSymbol: ticker, currency: 'HKD',
  source: 'FMP historical-price-eod/full', priceBasis: 'splitAdjustedClose',
  requestedFrom: '2024-01-01', requestedTo: '2024-12-31',
  rows: [['2024-01-02', 90.125, null], ['2024-12-31', 100.125, 0]] });

(async () => {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (error, bytes) => {
      if (error) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8'
        : file.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'application/json');
      res.end(bytes);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/hk_market_data.js*', route => route.fulfill({
      contentType: 'application/javascript', body: `window.HK_MARKET_DATA=${JSON.stringify(market)};`
    }));
    await page.route('**/hk_fcff_data.js', route => route.fulfill({
      contentType: 'application/javascript', body: `window.HK_FCFF_DATA=${JSON.stringify({
        stocks: Object.fromEntries(tickers.map(ticker => [ticker, { reason: 'requiresSegmentValuation' }])), betaSources: {}
      })};`
    }));
    await page.route('**/cache/financials/*HK_statements_v2.json', route =>
      route.fulfill({ json: statements }));
    await page.route('**/cache/price_charts/*.HK.json', route =>
      route.fulfill({ json: price(path.basename(new URL(route.request().url()).pathname, '.json')) }));
    if (process.env.CHART_VENDOR) await page.route('https://cdn.jsdelivr.net/npm/chart.js', route =>
      route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(process.env.CHART_VENDOR) }));
    await page.route('**/s3.tradingview.com/**', route => route.abort());
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${url}/?market=HKEX`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => isAppReady);
    assert.deepEqual(await page.evaluate(() => Object.keys(stockUniverse)), tickers);
    assert.equal(await page.locator('#screener-tbody tr').count(), 6);
    assert.equal(await page.locator('#screener-tbody tr').first().locator('td').count(), 33);
    assert.match(await page.locator('#screener-tbody').innerText(), /HKD/);
    assert.doesNotMatch(await page.locator('#screener-tbody').innerText(), /null|undefined|50 pt/);
    const saved = await page.evaluate(() => {
      localStorage.setItem('M7_CUSTOM_VALUATIONS', JSON.stringify({
        JPM: { targetPrice: 1, currency: 'USD' },
        '0700.HK': { targetPrice: 2, currency: 'USD' }
      }));
      const before = getSavedModels();
      storeSavedModels({ ...before, '0700.HK': { targetPrice: 3, currency: 'HKD' } });
      return { before, after: JSON.parse(localStorage.getItem('M7_CUSTOM_VALUATIONS')),
        archive: JSON.parse(localStorage.getItem('M7_LEGACY_VALUATIONS')) };
    });
    assert.equal(saved.before['0700.HK'], undefined);
    assert.equal(saved.after.JPM.currency, 'USD');
    assert.equal(saved.after['0700.HK'].currency, 'HKD');
    assert.equal(saved.archive['0700.HK'][0].currency, 'USD');
    await page.evaluate(() => applyLanguage('en'));
    for (const ticker of tickers) {
      await page.evaluate(ticker => openCompanyProfile(ticker), ticker);
      await page.waitForFunction(() => document.getElementById('profile-overview-status').textContent.includes('2024-12-31'));
      assert.equal(await page.locator('.sub-tab-btn').count(), 9);
      assert.match(await page.locator('#profile-quote-price').innerText(), /^HKD 100\.13$/);
      assert.match(await page.locator('#cmp-currency-note').innerText(), /CNY/);
      await page.waitForFunction(() => !document.getElementById('price-history-plots').hidden);
      assert.equal(await page.evaluate(() => Chart.getChart('price-chart').options.scales.y.title.text), 'HKD');
      if (ticker === '0700.HK') {
        const downloadPromise = page.waitForEvent('download');
        await page.locator('#price-download').click();
        const download = await downloadPromise;
        const stream = await download.createReadStream(), chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        assert.match(Buffer.concat(chunks).toString('utf8'), /Split-adjusted close \(HKD\)/);
      }
      await page.evaluate(() => switchSubPage('rating'));
      assert.equal(await page.locator('#moat-breakdown-body tr').count(), 10);
      assert.equal(await page.locator('#fscore-breakdown-body tr').count(), 9);
      assert.match(await page.locator('#moat-total-score').innerText(), /N\/A/);
      assert.doesNotMatch(await page.locator('#fscore-breakdown-body').innerText(), /Fail \(0\)|undefined/);
      await page.evaluate(() => switchSubPage('charts'));
      await page.waitForFunction(() => document.getElementById('balance-body').children.length === 9);
      await page.selectOption('#balance-period', 'quarterly');
      await page.waitForFunction(() => document.getElementById('balance-head').textContent.includes('H2'));
      assert.equal(await page.locator('#balance-date option').count(), 6);
      assert.doesNotMatch(await page.locator('#balance-head').innerText(), /\bQ[1-4]\b/);
      for (const tab of ['financials', 'ratios', 'peers', 'valuation', 'news', 'chart']) {
        await page.evaluate(tab => switchSubPage(tab), tab);
        if (tab === 'financials') {
          await page.waitForFunction(() => document.querySelector('#subpage-financials [data-financial-provenance] pre')?.textContent.includes('semiannual'));
          assert.match(await page.locator('#subpage-financials [data-financial-provenance] pre').textContent(), /source reconciliation/);
        }
        if (tab === 'valuation' && ['0005.HK', '0939.HK'].includes(ticker)) {
          assert.equal(await page.locator('#det-res-fair').innerText(), 'N/A');
          assert.equal(await page.locator('#disp-fin-ke').innerText(), 'N/A');
          assert.equal(await page.locator('#slider-fin-ke').isDisabled(), true);
          assert.doesNotMatch(await page.locator('#panel-fin-models').innerText(), /NaN|null|undefined/);
        }
      }
    }
    await page.goto(`${url}/#0823.HK/rating`, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#market-select').inputValue(), 'HKEX');
    await page.setViewportSize({ width: 390, height: 844 });
    for (const lang of ['zh', 'en']) {
      await page.evaluate(lang => applyLanguage(lang), lang);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => SiteTheme.set(theme), theme);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      }
    }
    await page.goto(`${url}/?market=US#JPM/rating`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => isAppReady);
    assert.equal(await page.locator('#market-select').inputValue(), 'US');
    assert.equal(await page.evaluate(() => Object.keys(stockUniverse).length), 230);
    assert.deepEqual(errors, []);
    console.log('HK frontend browser passed: six isolated fixtures, 33 columns, nine tabs, HKD prices, half-year charts, unavailable ratings and US isolation.');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
