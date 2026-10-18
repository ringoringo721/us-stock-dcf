const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');

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
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/fmp?**', route => route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ data: [], source: { provider: 'FMP' }, hasMore: false }) }));
    await page.route('**/s3.tradingview.com/**', route => route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}/?market=HKEX#0388.HK/financials`,
      { waitUntil: 'networkidle' });
    await page.waitForSelector('#statement-type');
    await page.evaluate(() => applyLanguage('en'));
    await page.selectOption('#statement-type', 'balance');
    const cell = (name, index) => page.locator('#cmp-fin-tbody tr')
      .filter({ has: page.locator('td', { hasText: name }) }).filter({ hasText: name }).first().locator('td').nth(index);
    assert.match(await cell('Total Current Assets', 6).innerText(), /539,820/);
    assert.match(await cell('Total Current Liabilities', 6).innerText(), /513,308/);
    assert.match(await cell('Total Non-Current Liabilities', 6).innerText(), /2,819/);
    assert.match(await cell('Total Current Liabilities', 5).innerText(), /518,875/);
    assert.match(await cell('Participant margin, Mainland', 6).innerText(), /288,066/);
    assert.match(await page.locator('#cmp-fin-thead').innerText(), /Latest balance/);
    assert.match(await page.locator('#statement-status').innerText(), /Earlier unverified classifications are not shown/);
    assert.match(await page.locator('#statement-status a').getAttribute('href'), /2026083100411\.pdf/);
    await page.evaluate(() => switchSubPage('valuation'));
    assert.match(await page.locator('#fmp-official-source-warning').innerText(), /have not been rewritten/);
    await page.evaluate(() => switchSubPage('financials'));
    await page.selectOption('#statement-type', 'cashflow');
    assert.match(await cell('Net Cash from Operating Activities', 6).innerText(), /22,708/);
    assert.match(await cell('Profit before tax', 6).innerText(), /23,600/);
    await page.selectOption('#statement-period', 'semiannual');
    assert.match(await page.locator('#cmp-fin-thead').innerText(), /2026H1/);
    assert.doesNotMatch(await page.locator('#statement-status').innerText(), /Derived from two reported quarters/);
    await page.evaluate(() => applyLanguage('zh'));
    assert.match(await page.locator('#statement-status').innerText(), /不虛構季度/);
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(overflow, false);
    await page.goto(`http://127.0.0.1:${server.address().port}/?market=HKEX#0005.HK/financials`,
      { waitUntil: 'networkidle' });
    await page.evaluate(() => applyLanguage('en'));
    await page.selectOption('#statement-type', 'cashflow');
    await page.selectOption('#statement-period', 'annual');
    assert.match(await page.locator('#statement-status').innerText(), /each half-year/);
    const cfo = await cell('Net Cash from Operating Activities', 6).innerText();
    assert.doesNotMatch(cfo, /N\/A/);
    assert.match(cfo, /769,077/);
    assert.deepEqual(errors, []);
    console.log('Official HKEX classification and HKEX/HSBC TTM: bilingual, sourced, mobile browser checks passed.');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
