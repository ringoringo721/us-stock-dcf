const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:8766';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {})
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${baseUrl}/#CAT/peers`, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#subpage-peers').isVisible(), true);
    assert.equal(await page.locator('#cmp-peers-table th.peer-current').getAttribute('data-peer-ticker'), 'CAT');
    const tickers = await page.evaluate(() => Object.keys(stockUniverse));
    assert.ok(tickers.length > 0);
    let references = 0;
    for (const ticker of tickers) {
      const result = await page.evaluate(ticker => {
        renderPeersSubPage({ ...stockUniverse[ticker], ticker });
        const table = document.getElementById('cmp-peers-table');
        const headers = [...table.querySelectorAll('thead th[data-peer-ticker]')];
        return {
          count: Number(document.getElementById('peer-comparison-count').textContent),
          current: headers[0].dataset.peerTicker,
          peers: headers.slice(1).map(cell => ({ ticker: cell.dataset.peerTicker, basis: cell.dataset.peerBasis })),
          aligned: [...table.querySelectorAll('tbody tr')].every(row => row.cells.length === headers.length + 1),
          invalid: /\b(?:undefined|NaN|Infinity)\b/.test(table.textContent)
        };
      }, ticker);
      assert.equal(result.current, ticker);
      assert.ok(result.count > 0 && result.count <= 5, `${ticker} comparison coverage`);
      assert.equal(result.count, result.peers.length, ticker);
      assert.equal(new Set(result.peers.map(peer => peer.ticker)).size, result.count, ticker);
      assert.ok(result.aligned && !result.invalid, `${ticker}: real, aligned comparison cells`);
      assert.ok(result.peers.every(peer => peer.ticker !== ticker && tickers.includes(peer.ticker)));
      assert.ok(result.peers.every(peer => ['industry', 'provider', 'related'].includes(peer.basis)));
      references += result.peers.filter(peer => peer.basis === 'related').length;
    }
    await page.evaluate(() => { openCompanyProfile('CAT'); switchSubPage('peers'); });
    assert.equal(await page.locator('#peer-comparison-count').innerText(), '5');
    if (!(await page.evaluate(() => stockUniverse.CAT.peers?.length))) {
      assert.match(await page.locator('#cmp-peers-table thead').innerText(), /DE/);
    }
    for (const lang of ['zh', 'en']) {
      await page.evaluate(lang => applyLanguage(lang), lang);
      assert.ok((await page.locator('#peer-coverage-note').innerText()).length > 0);
      if (lang === 'en') assert.ok(!/[\u3400-\u9fff]/.test(await page.locator('#subpage-peers').innerText()));
      for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => SiteTheme.set(theme), theme);
        for (const width of [390, 1440]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.locator('#cmp-peers-table').evaluate(table => {
            table.closest('.table-scroll-wrapper').scrollTop = 240;
          });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
          const labels = await page.locator('#cmp-peers-table thead th[data-peer-basis="related"]').allTextContents();
          assert.ok(labels.every(label => label.includes(lang === 'en' ? 'Related-industry reference' : '相關產業參考')));
          if (process.env.UI_SCREENSHOT_DIR) {
            await page.locator('#subpage-peers').screenshot({
              path: path.join(process.env.UI_SCREENSHOT_DIR, `cat-peers-${lang}-${theme}-${width}.png`)
            });
          }
        }
      }
    }
    await page.evaluate(() => {
      stockUniverse.CAT = { ...stockUniverse.CAT, industry: 'Unknown test industry', peers: [] };
      renderPeersSubPage({ ...stockUniverse.CAT, ticker: 'CAT' });
    });
    assert.equal(await page.locator('#peer-comparison-count').innerText(), '0');
    assert.match(await page.locator('#peer-coverage-note').innerText(), /not mean.*no competitors/);
    assert.deepEqual(errors, []);
    console.log(`PASS: all ${tickers.length} live stock comparison tables; ${references} clearly classified related references; CAT routes, bilingual labels, themes, mobile and honest empty coverage.`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
