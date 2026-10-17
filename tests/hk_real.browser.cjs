const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const Ratios = require('../fcf_ratios.js');
const Currency = require('../usd_currency.js');
const market = require('../hk_market_dcf.json');
const rates = require('../cache/fx/hkd_rates.json');
const root = path.resolve(process.env.TEST_STATIC_ROOT || path.resolve(__dirname, '..'));
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));

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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], failed = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.url().startsWith(url) && response.status() >= 400) failed.push(response.url());
    });
    if (process.env.CHART_VENDOR) await page.route('https://cdn.jsdelivr.net/npm/chart.js', route =>
      route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(process.env.CHART_VENDOR) }));
    await page.route('**/s3.tradingview.com/**', route => route.abort());
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${url}/?market=HKEX`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => isAppReady);
    await page.evaluate(() => applyLanguage('en'));
    assert.equal(await page.locator('#screener-tbody tr').count(), 6);
    assert.equal(await page.locator('#screener-tbody tr').first().locator('td').count(), 33);
    assert.deepEqual(await page.evaluate(() => Object.keys(stockUniverse)), Object.keys(market));
    for (const [ticker, stock] of Object.entries(market)) {
      const raw = read(`cache\\financials\\${ticker}_statements_v2.json`);
      const statements = Currency.convertStatements(raw, rates);
      const prices = read(`cache\\price_charts\\${ticker}.json`);
      await page.evaluate(ticker => openCompanyProfile(ticker), ticker);
      await page.waitForFunction(({ ticker, date }) =>
        document.getElementById('profile-overview-status').textContent.startsWith(ticker)
        && document.getElementById('profile-overview-retry').hidden
        && document.getElementById('profile-overview-status').textContent.includes(date),
      { ticker, date: statements.quarterly.income.at(-1).date });
      assert.equal(await page.locator('.sub-tab-btn').count(), 9);
      assert.equal(await page.locator('#profile-quote-price').innerText(),
        `HKD ${stock.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      assert.match(await page.locator('#cmp-currency-note').innerText(), new RegExp(stock.reportedCurrency));
      await page.waitForFunction(() => !document.getElementById('price-history-plots').hidden);
      assert.equal(await page.evaluate(() => Chart.getChart('price-chart').options.scales.y.title.text), 'HKD');
      assert.equal(prices.currency, 'HKD');
      await page.evaluate(() => switchSubPage('rating'));
      assert.equal(await page.locator('#moat-breakdown-body tr').count(), 10);
      assert.equal(await page.locator('#fscore-breakdown-body tr').count(), 9);
      assert.equal(await page.locator('#fsc-total-score').innerText(), stock.f_score == null ? 'N/A' : `${stock.f_score} / 9`);
      await page.evaluate(() => switchSubPage('charts'));
      await page.selectOption('#balance-period', 'quarterly');
      await page.waitForFunction(() => document.getElementById('balance-body').children.length === 9);
      const balances = Ratios.calculateBalances(statements);
      assert.equal(await page.locator('#balance-date option').count(), balances.length, ticker);
      if (stock.reportingFrequency === 'semiannual') {
        assert.doesNotMatch(await page.locator('#balance-head').innerText(), /\bQ[1-4]\b/);
        assert.match(await page.locator('#balance-head').innerText(), /H1|H2/);
        await page.selectOption('#earnings-period', 'quarterly');
        await page.selectOption('#earnings-flow', 'ttm');
        await page.waitForFunction(() => document.getElementById('earnings-cards').children.length === 3);
        const expected = Ratios.calculateEarnings(statements).at(-1).amounts.eps;
        const annual = statements.annual.income.find(row => row.date === statements.quarterly.income.at(-1).date);
        assert.equal(expected.value, annual.epsDiluted);
        assert.equal(await page.locator('#earnings-cards strong').first().innerText(),
          annual.epsDiluted.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
        assert.equal(raw.quarterly.income.at(-1).epsDiluted, null);
      }
      if (stock.statementFrequencies.cashflow === 'annual') {
        const fcf = Ratios.calculate(statements).at(-1);
        assert.equal(fcf.ratios.assets.reason, 'annualCashflowOnly');
      }
      for (const tab of ['financials', 'ratios', 'peers', 'valuation', 'news', 'chart']) {
        await page.evaluate(tab => switchSubPage(tab), tab);
        if (tab === 'valuation' && stock.fin_valuation.is_financial) {
          assert.equal(await page.locator('#det-res-fair').innerText(), 'N/A');
          assert.equal(await page.locator('#disp-fin-ke').innerText(), 'N/A');
          assert.equal(await page.locator('#slider-fin-ke').isDisabled(), true);
          await page.locator('#slider-fin-g').evaluate(input => {
            input.value = '2.5'; input.dispatchEvent(new Event('input', { bubbles: true }));
          });
          assert.equal(await page.locator('#disp-fin-ke').innerText(), 'N/A');
          assert.equal(await page.locator('#det-res-fair').innerText(), 'N/A');
          assert.equal(await page.evaluate(ticker => stockUniverse[ticker].fin_valuation.ke, ticker), null);
        }
        if (tab === 'news' && !stock.news.length) assert.match(await page.locator('#cmp-news-list').innerText(), /N\/A/);
      }
      assert.doesNotMatch(await page.locator('#company-view').innerText(), /\bNaN\b|\bundefined\b/);
    }
    await page.goto(`${url}/#0823.HK/charts`, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#market-select').inputValue(), 'HKEX');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width && rect.right > innerWidth + 1 && getComputedStyle(element).position !== 'fixed';
      }).slice(0, 20).map(element => ({ tag: element.tagName, id: element.id, class: element.className,
        width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right })))));
    assert.deepEqual(errors, []);
    assert.deepEqual(failed, []);
    console.log('PASS: six genuine HKEX securities, HKD charts, 33 columns/nine tabs, source ratings, Link annual EPS, provenance and bank unavailability.');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
