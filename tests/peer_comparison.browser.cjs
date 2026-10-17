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
    await page.evaluate(() => {
      applyLanguage('en');
      document.getElementById('ratio-period').value = 'annual';
    });
    const tickers = await page.evaluate(() => Object.keys(stockUniverse));
    assert.ok(tickers.length > 0);
    let references = 0;
    for (const ticker of tickers) {
      const result = await page.evaluate(ticker => {
        renderPeersSubPage({ ...stockUniverse[ticker], ticker });
        renderRatiosSubPage(stockUniverse[ticker]);
        const table = document.getElementById('cmp-peers-table');
        const headers = [...table.querySelectorAll('thead th[data-peer-ticker]')];
        const growthCells = [...table.querySelectorAll('td.peer-current [data-peer-growth]')];
        const ratioRow = [...document.querySelectorAll('#cmp-ratio-table tbody tr')]
          .find(row => row.cells[0].textContent === 'Revenue Growth % (YoY)');
        const expectedGrowth = stockUniverse[ticker].reported_growth.fields.revenue;
        return {
          count: Number(document.getElementById('peer-comparison-count').textContent),
          current: headers[0].dataset.peerTicker,
          peers: headers.slice(1).map(cell => ({ ticker: cell.dataset.peerTicker, basis: cell.dataset.peerBasis })),
          aligned: [...table.querySelectorAll('tbody tr')].every(row => row.cells.length === headers.length + 1),
          invalid: /\b(?:undefined|NaN|Infinity)\b/.test(table.textContent),
          growthValid: growthCells.length === 7 && growthCells.every(cell => {
            const record = stockUniverse[ticker].reported_growth.fields[cell.dataset.peerGrowth];
            return record.value === null ? cell.textContent === 'N/A'
              : Number(cell.dataset.growthValue) === record.value && cell.textContent === `${record.value >= 0 ? '+' : ''}${record.value.toFixed(2)}%`;
          }),
          ratioValid: ratioRow.cells[ratioRow.cells.length - 2].textContent
            === (expectedGrowth.value === null ? 'N/A' : `${expectedGrowth.value.toFixed(2)}%`)
        };
      }, ticker);
      assert.equal(result.current, ticker);
      assert.ok(result.count > 0 && result.count <= 5, `${ticker} comparison coverage`);
      assert.equal(result.count, result.peers.length, ticker);
      assert.equal(new Set(result.peers.map(peer => peer.ticker)).size, result.count, ticker);
      assert.ok(result.aligned && !result.invalid, `${ticker}: real, aligned comparison cells`);
      assert.ok(result.growthValid && result.ratioValid, `${ticker}: correctly reported TTM growth in peers and key ratios`);
      assert.ok(result.peers.every(peer => peer.ticker !== ticker && tickers.includes(peer.ticker)));
      assert.ok(result.peers.every(peer => ['industry', 'provider', 'related'].includes(peer.basis)));
      references += result.peers.filter(peer => peer.basis === 'related').length;
    }
    for (const ticker of ['MU', 'LRCX']) {
      await page.evaluate(ticker => { openCompanyProfile(ticker); switchSubPage('peers'); }, ticker);
      const expected = await page.evaluate(ticker => stockUniverse[ticker].reported_growth.fields.revenue.value, ticker);
      assert.ok(expected > 0);
      assert.equal(await page.locator('td.peer-current [data-peer-growth="revenue"]').innerText(), `+${expected.toFixed(2)}%`);
      if (process.env.UI_SCREENSHOT_DIR) {
        await page.locator('#cmp-peers-table').evaluate(table => {
          const wrapper = table.closest('.table-scroll-wrapper');
          const row = table.querySelector('[data-peer-growth="revenue"]').closest('tr');
          wrapper.scrollTop += row.getBoundingClientRect().top - wrapper.getBoundingClientRect().top
            - table.tHead.getBoundingClientRect().height - 48;
        });
        await page.locator('#subpage-peers').screenshot({
          path: path.join(process.env.UI_SCREENSHOT_DIR, `${ticker.toLowerCase()}-growth-corrected.png`)
        });
      }
      await page.evaluate(() => switchSubPage('basic'));
      await page.waitForFunction(ticker => document.getElementById('profile-overview-status').textContent.startsWith(ticker), ticker);
      const profileGrowth = await page.locator('.profile-metric-group').last().locator('td').first().innerText();
      assert.equal(Number(profileGrowth.replace(/[,%]/g, '')), Number(expected.toFixed(2)));
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
    console.log(`PASS: all ${tickers.length} live stock comparison tables and TTM growth; ${references} clearly classified related references; MU/LRCX source growth, key ratios, Profile consistency; CAT routes, bilingual labels, themes, mobile and honest empty coverage.`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
