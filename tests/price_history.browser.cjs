const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const Price = require('../price_history.js');
const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:8766';
const source = ticker => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'price_charts', `${ticker}.json`)));

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {})
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${baseUrl}/#GOOGL/profile`, { waitUntil: 'networkidle' });
    await page.evaluate(() => applyLanguage('en'));
    await page.waitForFunction(() => document.getElementById('price-history-status').textContent.includes('Available history'));
    const tickers = await page.evaluate(() => Object.keys(stockUniverse));
    for (const ticker of tickers) {
      await page.evaluate(ticker => openCompanyProfile(ticker), ticker);
      await page.waitForFunction(ticker =>
        document.getElementById('price-company').textContent.startsWith(ticker + ' ·')
        && !document.getElementById('price-history-plots').hidden, ticker);
      const record = source(ticker);
      const rows = Price.select(record.rows, ...Price.periodRange(record.rows, '5y'));
      const result = await page.evaluate(() => ({
        rows: Chart.getChart('price-chart').data.datasets[0].data,
        volume: Chart.getChart('price-volume-chart').data.datasets[0].data,
        navigator: Chart.getChart('price-navigator').data.datasets[0].data.length,
        axes: ['price-chart', 'price-volume-chart', 'price-navigator'].map(id => {
          const chart = Chart.getChart(id);
          return { min: chart.scales.x.min, max: chart.scales.x.max, left: chart.chartArea.left, right: chart.chartArea.right };
        }),
        change: document.getElementById('price-return').textContent,
        status: document.getElementById('price-history-status').textContent
      }));
      assert.equal(result.rows.length, rows.length, ticker);
      assert.deepEqual(result.rows, rows.map(row => ({ x: Date.parse(row[0]), y: row[1] })), ticker);
      assert.deepEqual(result.volume, rows.map(row => ({ x: Date.parse(row[0]), y: row[2] })), ticker);
      assert.equal(result.navigator, record.rows.length, ticker);
      assert.equal(result.axes[0].min, result.axes[1].min, ticker);
      assert.equal(result.axes[0].max, result.axes[1].max, ticker);
      assert.ok(Math.abs(result.axes[0].left - result.axes[1].left) < 1, `${ticker} price/volume left alignment: ${JSON.stringify(result.axes)}`);
      assert.ok(Math.abs(result.axes[0].right - result.axes[1].right) < 1, `${ticker} price/volume right alignment: ${JSON.stringify(result.axes)}`);
      assert.equal(result.axes[2].min, Date.parse(record.rows[0][0]), ticker);
      assert.equal(result.axes[2].max, Date.parse(record.rows.at(-1)[0]), ticker);
      assert.ok(result.status.includes(record.rows[0][0]), ticker);
      const change = Price.summarize(rows).change;
      assert.equal(result.change, `${change >= 0 ? '+' : ''}${change.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`, ticker);
    }
    await page.evaluate(() => openCompanyProfile('GOOGL'));
    await page.waitForFunction(() => !document.getElementById('price-history-plots').hidden);
    for (const period of ['3m', '6m', 'ytd', '1y', '3y', '5y', '10y', 'all']) {
      await page.locator(`[data-period="${period}"]`).click();
      const rows = Price.select(source('GOOGL').rows, ...Price.periodRange(source('GOOGL').rows, period));
      assert.equal(await page.locator(`[data-period="${period}"]`).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.evaluate(() => Chart.getChart('price-chart').data.datasets[0].data.length), rows.length);
      if (['3m', '6m', 'ytd'].includes(period)) assert.equal(await page.locator('#price-cagr').innerText(), 'N/A');
    }
    await page.locator('#price-from').fill('2024-01-01');
    await page.locator('#price-to').fill('2025-01-01');
    await page.locator('#price-custom button').click();
    const custom = Price.select(source('GOOGL').rows, '2024-01-01', '2025-01-01');
    assert.equal(await page.evaluate(() => Chart.getChart('price-chart').data.datasets[0].data.length), custom.length);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#price-download').click();
    const download = await downloadPromise;
    const stream = await download.createReadStream(), chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''), Price.csv(custom));
    assert.match(download.suggestedFilename(), /^GOOGL-2024-01-02-2024-12-31\.csv$/);
    await page.locator('#price-chart').focus();
    await page.keyboard.press('Home');
    assert.match(await page.locator('#price-point').innerText(), /^2024-01-02/);
    await page.keyboard.press('End');
    assert.match(await page.locator('#price-point').innerText(), /^2024-12-31/);
    await page.locator('#price-range-start').evaluate(input => {
      input.value = Number(input.value) + 10; input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await page.evaluate(() => Chart.getChart('price-chart').data.datasets[0].data.length), custom.length - 10);
    if (!(await page.locator('#price-fullscreen').isDisabled())) {
      await page.locator('#price-fullscreen').click();
      await page.waitForFunction(() => document.fullscreenElement?.id === 'price-history-panel'
        && document.getElementById('price-fullscreen').textContent === '⛶ Exit fullscreen');
      assert.equal(await page.locator('#price-fullscreen').innerText(), '⛶ Exit fullscreen');
      await page.evaluate(() => document.exitFullscreen());
    }
    for (const lang of ['zh', 'en']) {
      await page.evaluate(lang => applyLanguage(lang), lang);
      await page.waitForFunction(() => !document.getElementById('price-history-plots').hidden);
      for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => SiteTheme.set(theme), theme);
        for (const width of [390, 1440]) {
          await page.setViewportSize({ width, height: 1100 });
          await page.locator('[data-period="10y"]').click();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
          assert.equal(await page.evaluate(() => Chart.getChart('price-chart').data.datasets[0].borderColor), await page.evaluate(() => SiteTheme.color('--gold')));
          if (lang === 'en') assert.ok(!/[\u3400-\u9fff]/.test(await page.locator('#price-history-panel').innerText()));
          if (process.env.UI_SCREENSHOT_DIR) await page.locator('#price-history-panel').screenshot({
            path: path.join(process.env.UI_SCREENSHOT_DIR, `profile-price-${lang}-${theme}-${width}.png`)
          });
        }
      }
    }
    await page.evaluate(() => switchSubPage('peers'));
    assert.equal(await page.evaluate(() => Chart.getChart('price-chart') === undefined), true);
    await page.evaluate(() => switchSubPage('basic'));
    await page.waitForFunction(() => !document.getElementById('price-history-plots').hidden);
    assert.equal(await page.locator('[data-period="10y"]').getAttribute('aria-pressed'), 'true');

    const failure = await browser.newPage();
    await failure.route('**/cache/price_charts/GOOGL.json', route => route.fulfill({ status: 403, body: 'restricted' }));
    await failure.goto(`${baseUrl}/#GOOGL/profile`, { waitUntil: 'networkidle' });
    await failure.waitForFunction(() => !document.getElementById('price-retry').hidden);
    assert.equal(await failure.locator('#price-history-plots').isVisible(), false);
    assert.equal(await failure.locator('#price-last-close').innerText(), 'N/A');
    await failure.unroute('**/cache/price_charts/GOOGL.json');
    await failure.locator('#price-retry').click();
    await failure.waitForFunction(() => !document.getElementById('price-history-plots').hidden);
    await failure.close();

    const empty = await browser.newPage();
    await empty.route('**/cache/price_charts/GOOGL.json', route => route.fulfill({
      json: { ...source('GOOGL'), rows: [] }
    }));
    await empty.goto(`${baseUrl}/#GOOGL/profile`, { waitUntil: 'networkidle' });
    await empty.waitForFunction(() => !document.getElementById('price-retry').hidden);
    assert.equal(await empty.locator('#price-history-plots').isVisible(), false);
    assert.equal(await empty.locator('#price-download').isDisabled(), true);
    await empty.close();

    const race = await browser.newPage();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await race.route('**/cache/price_charts/GOOGL.json', async route => {
      await pending; await route.fulfill({ json: source('GOOGL') });
    });
    await race.goto(baseUrl, { waitUntil: 'networkidle' });
    await race.evaluate(() => { openCompanyProfile('GOOGL'); openCompanyProfile('MU'); });
    await race.waitForFunction(() => !document.getElementById('price-history-plots').hidden);
    release();
    await race.waitForLoadState('networkidle');
    assert.match(await race.locator('#price-company').innerText(), /^MU ·/);
    assert.equal(await race.evaluate(() => Chart.getChart('price-chart').data.datasets[0].data.at(-1).y), source('MU').rows.at(-1)[1]);
    await race.close();
    assert.deepEqual(errors, []);
    console.log(`PASS: ${tickers.length} real Profile price/volume charts; eight periods, custom range, navigator, exact CSV, keyboard, fullscreen, themes/languages/mobile, retry, empty data and cross-stock races.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
