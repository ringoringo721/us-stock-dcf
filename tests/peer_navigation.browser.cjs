const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..', 'public');

(async () => {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) return response.writeHead(403).end();
    fs.readFile(file, (error, bytes) => {
      if (error) return response.writeHead(404).end();
      response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8'
        : file.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'application/json');
      response.end(bytes);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://cdn.jsdelivr.net/npm/chart.js', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.Chart=class {static defaults={font:{}};constructor(canvas,config){this.data=config.data;this.options=config.options;}destroy(){}update(){}};'
    }));
    await page.route('**/s3.tradingview.com/**', route => route.abort());
    await page.route('**/api/fmp?**', route => route.fulfill({ json: { data: [], hasMore: false } }));
    let lazyPeerOpened = false;
    for (const [market, source] of [['HKEX', '0005.HK'], ['HKEX', '2145.HK'], ['US', 'CAT']]) {
      await page.goto(`http://127.0.0.1:${server.address().port}/?market=${market}#${source}/peers`,
        { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(source => typeof isAppReady !== 'undefined' && isAppReady
        && document.querySelector('#cmp-peers-table th.peer-current')?.dataset.peerTicker === source, source);
      for (const language of ['zh', 'en']) {
        await page.evaluate(language => applyLanguage(language), language);
        for (const nameLink of [false, true]) {
          await page.waitForFunction(source =>
            document.querySelector('#cmp-peers-table th.peer-current')?.dataset.peerTicker === source, source);
          const target = await page.evaluate(() => {
            const tickers = [...document.querySelectorAll('#cmp-peers-table th[data-peer-ticker]')]
              .slice(1).map(header => header.dataset.peerTicker);
            const ticker = tickers.find(ticker => stockUniverse[ticker]?.expansion?.status === 'available') || tickers[0];
            return { ticker, lazy: stockUniverse[ticker]?.expansion?.status === 'available' };
          });
          assert.ok(target.ticker, `${source}: actual peer available`);
          const link = page.locator(`#cmp-peers-table th[data-peer-ticker="${target.ticker}"] a${nameLink
            ? '.peer-company-name' : '.peer-company-link:not(.peer-company-name)'}`);
          assert.equal(await link.getAttribute('href'), `#${encodeURIComponent(target.ticker)}/profile`);
          if (nameLink) await link.click();
          else { await link.focus(); await page.keyboard.press('Enter'); }
          await page.waitForFunction(ticker => activeCompanyTicker === ticker
            && document.querySelector('#company-view').style.display !== 'none'
            && (!stockUniverse[ticker].expansion || stockUniverse[ticker].expansion.status === 'loaded'), target.ticker);
          assert.equal(new URL(page.url()).hash, `#${target.ticker}/profile`);
          assert.match(await page.locator('.sub-tab-btn.active').getAttribute('onclick'), /'basic'/);
          lazyPeerOpened ||= target.lazy;
          await page.goBack();
          await page.waitForFunction(source => activeCompanyTicker === source
            && document.querySelector('#cmp-peers-table th.peer-current')?.dataset.peerTicker === source
            && document.querySelector('#subpage-peers')?.classList.contains('active'), source);
          assert.equal(new URL(page.url()).hash, `#${source}/peers`);
        }
      }
    }
    assert.ok(lazyPeerOpened, 'New HK company records are lazy-loaded through normal company navigation');
    assert.deepEqual(errors, []);
    console.log('PASS: peer codes (keyboard), names (mouse), company-profile routes, browser Back, lazy HK companies, both languages and US/HK markets.');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
