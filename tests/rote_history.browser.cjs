const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const markets = { US: require('../full_market_dcf.json'), HKEX: require('../hk_market_dcf.json') };
(async () => {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8'
        : file.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'application/json');
      res.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], api = [];
    let captures = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.url().includes('/api/fmp?')) api.push(request.url());
      if (request.url().includes('/cache/rote_history/')) captures++;
    });
    await page.route('https://cdn.jsdelivr.net/npm/chart.js', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.Chart=class {static defaults={font:{}};constructor(canvas,config){this.data=config.data;this.options=config.options;}destroy(){}update(){}};'
    }));
    await page.route('**/s3.tradingview.com/**', route => route.abort());
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const market of ['US', 'HKEX']) {
      await page.goto(`${url}/?market=${market}`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => isAppReady);
      await page.evaluate(() => applyLanguage('en'));
      for (const [ticker, stock] of Object.entries(markets[market]).filter(([, stock]) => stock.fin_valuation?.is_financial)) {
        await page.evaluate(ticker => { openCompanyProfile(ticker); switchSubPage('valuation'); }, ticker);
        await page.waitForFunction(ticker => document.getElementById('fin-rote-history-status').textContent.startsWith(ticker)
          && document.querySelectorAll('[data-rote-year]').length === 10, ticker);
        const saved = require(`../cache/rote_history/${ticker}.json`);
        assert.deepEqual(await page.locator('[data-rote-year]').allTextContents(), saved.years.map(row =>
          row.value === null ? 'N/A' : `${row.value.toFixed(2)}%${row.warnings.length ? ' *' : ''}`), ticker);
        assert.equal(await page.evaluate(ticker => stockUniverse[ticker].fin_valuation.rote, ticker), stock.fin_valuation.rote,
          `${ticker}: loading references must not replace the forecast`);
        assert.match(await page.locator('#fin-rote-history-status').innerText(), /10\/10.*no FMP or AI calls/);
        assert.ok(await page.locator('#fin-rote-history-panel').isVisible());
      }
      const before = captures;
      await page.evaluate(() => applyLanguage('zh'));
      await page.waitForFunction(() => document.querySelectorAll('[data-rote-year]').length === 10);
      assert.equal(captures, before, 'Language changes reuse the saved table request');
      assert.match(await page.locator('#fin-rote-history-panel').innerText(), /最近十年年度 ROTE/);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.locator('#fin-rote-history-panel').isVisible());
      assert.equal(await page.locator('#fin-rote-history-table').evaluate(table =>
        table.parentElement.scrollWidth > table.parentElement.clientWidth), true);
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelectorAll('[data-rote-year]').length === 10, null, { timeout: 5000 })
      .catch(async error => {
        console.error(await page.evaluate(() => ({ url: location.href, status: document.getElementById('fin-rote-history-status').textContent,
          ticker: activeDetailTicker, company: activeCompanyTicker })), errors);
        throw error;
      });
    assert.deepEqual(api, [], 'Viewing historical references makes no FMP calls, including reloads');
    assert.deepEqual(errors, []);
    const financials = Object.values(markets).flatMap(market => Object.values(market))
      .filter(stock => stock.fin_valuation?.is_financial);
    console.log(`ROTE history browser PASS: all ${financials.length} financial models, ${financials.length * 10} exact values, localization, mobile scrolling, unchanged forecasts and no FMP calls.`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
