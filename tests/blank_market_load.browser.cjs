#!/usr/bin/env node
/**
 * Regression: hung us_expansion_data.js must not leave the US screener at 0 forever.
 * Uses ?bootWaitMs= to shorten the soft timeout in index.html.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.includes('us_expansion_data.js')) {
      // Never respond — reproduces the production blank-load gate.
      return;
    }
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname.split('?')[0]));
    if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8'
        : file.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'application/json');
      res.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('https://cdn.jsdelivr.net/npm/chart.js', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.Chart=class {static defaults={font:{}};constructor(){ }destroy(){}update(){}};',
    }));
    await page.route('**/s3.tradingview.com/**', route => route.abort());

    await page.goto(`http://127.0.0.1:${port}/?market=US&bootWaitMs=1500`, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });

    await page.waitForFunction(() => typeof isAppReady !== 'undefined' && isAppReady, null, {
      timeout: 20000,
    });
    const probe = await page.evaluate(() => ({
      ready: isAppReady,
      expansion: !!window.US_EXPANSION,
      listings: window.US_LISTINGS?.stocks?.length || 0,
      universe: Object.keys(stockUniverse || {}).length,
      statTotal: document.getElementById('stat-total')?.textContent || '',
    }));
    assert.equal(probe.ready, true);
    assert.equal(probe.expansion, false);
    assert.ok(probe.listings > 200, `expected listings, got ${probe.listings}`);
    assert.ok(probe.universe > 200, `expected merged universe, got ${probe.universe}`);
    assert.ok(!/^0\b/.test(probe.statTotal.trim()), `statTotal still blank: ${probe.statTotal}`);
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log(JSON.stringify({ ok: true, probe }, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
