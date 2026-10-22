const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { calculate } = require('../liquidation.js');
const market = require('../full_market_dcf.json');
const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:8766';
const amount = value => value === null ? 'N/A' : value < 0
  ? `-$${Math.abs(value).toFixed(2)}` : `$${value.toFixed(2)}`;

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof isAppReady !== 'undefined' && isAppReady
      && document.querySelectorAll('#screener-tbody tr').length === 982);
    await page.locator('#screener-columns').selectOption('valuation');
    const readRows = () => page.evaluate(() => [...document.querySelectorAll('#screener-tbody tr')].map(row => ({
      ticker: row.querySelector('.ticker-link').textContent,
      cells: [...row.querySelectorAll('.liquidation-value')].map(cell => ({
        amount: cell.querySelector('.liquidation-amount').textContent,
        date: cell.querySelector('.liquidation-asof').textContent,
        title: cell.title, classes: cell.className
      }))
    })));
    for (const lang of ['zh', 'en']) {
      await page.evaluate(lang => applyLanguage(lang), lang);
      const rows = await readRows();
      assert.equal(rows.length, 982);
      const baselineRows = rows.filter(row => market[row.ticker]);
      assert.equal(baselineRows.length, 230);
      for (const row of baselineRows) {
        const source = market[row.ticker].liquidation, result = calculate(source, row.ticker);
        row.cells.forEach((cell, index) => {
          const rounded = result.values[index] === null ? null : Number(result.values[index].toFixed(2));
          assert.equal(cell.amount, amount(rounded), row.ticker);
          assert.equal(cell.date, result.balanceDate + (result.warnings.length ? ' *' : ''), row.ticker);
          assert.ok(cell.title.includes(source.quoteDate), row.ticker);
          assert.ok(cell.title.includes(source.fetchedAt), row.ticker);
          assert.ok(cell.title.includes(String(source.quote.price)), row.ticker);
          assert.ok(cell.title.includes(String(source.quote.marketCap)), row.ticker);
          assert.ok(cell.classes.includes(rounded > 0 ? 'text-green' : rounded < 0 ? 'text-red' : 'text-muted'));
          assert.ok(!/undefined|NaN|Infinity/.test(cell.title + cell.amount));
          if (lang === 'en') assert.ok(!/[\u3400-\u9fff]/.test(cell.title));
        });
      }
      assert.ok(await page.locator('#screener-liquidation-method').isVisible());
      await page.locator('#screener-liquidation-method summary').click();
      const method = await page.locator('#screener-liquidation-method p').innerText();
      assert.ok(/80%/.test(method) && /50%/.test(method));
      if (lang === 'en') {
        assert.ok(!/[\u3400-\u9fff]/.test(method));
        assert.match(method, /not reported diluted|not.*diluted weighted-average/i);
        assert.match(method, /before preferred priority claims/i);
      }
      await page.locator('#screener-liquidation-method summary').click();
      for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => SiteTheme.set(theme), theme);
        for (const width of [390, 1440]) {
          await page.setViewportSize({ width, height: 1100 });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
          assert.ok(await page.evaluate(() => [...document.querySelectorAll('.liquidation-asof')]
            .every(el => el.scrollWidth <= el.clientWidth + 1)));
          if (process.env.UI_SCREENSHOT_DIR) {
            await page.locator('#search-ticker').fill('TSM');
            await page.locator('#search-ticker').dispatchEvent('input');
            await page.locator('#main-scroll-box').evaluate(box => { box.scrollLeft = box.scrollWidth; });
            await page.locator('#main-scroll-box').screenshot({
              path: path.join(process.env.UI_SCREENSHOT_DIR, `liquidation-${lang}-${theme}-${width}.png`)
            });
            await page.locator('#search-ticker').fill('');
            await page.locator('#search-ticker').dispatchEvent('input');
          }
        }
      }
    }
    const probes = await page.evaluate(() => {
      const source = structuredClone(stockUniverse.NVDA.liquidation);
      const read = () => {
        const row = [...document.querySelectorAll('#screener-tbody tr')]
          .find(row => row.querySelector('.ticker-link').textContent === 'NVDA');
        return [...row.querySelectorAll('.liquidation-amount')].map(el => el.textContent);
      };
      stockUniverse.NVDA.liq_val_2 = 99999;
      delete stockUniverse.NVDA.liquidation.amounts.tradeReceivables;
      renderScreenerTable(); const missingTrade = read();
      delete stockUniverse.NVDA.liquidation;
      renderScreenerTable(); const missingSnapshot = read();
      stockUniverse.NVDA.liquidation = source;
      renderScreenerTable(); const restored = read();
      return { missingTrade, missingSnapshot, restored };
    });
    const nvdaAmounts = calculate(market.NVDA.liquidation, 'NVDA').values
      .map(value => amount(value === null ? null : Number(value.toFixed(2))));
    assert.equal(probes.missingTrade[1], 'N/A');
    assert.equal(probes.missingTrade[0], nvdaAmounts[0]);
    assert.equal(probes.missingTrade[2], nvdaAmounts[2]);
    assert.deepEqual(probes.missingSnapshot, ['N/A', 'N/A', 'N/A']);
    assert.deepEqual(probes.restored, nvdaAmounts);
    assert.deepEqual(errors, []);
    console.log(`Liquidation browser: 982 screener rows / 230 baseline liquidation checks, dates, source details, languages, themes, mobile and N/A checks passed (${baseUrl})`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
