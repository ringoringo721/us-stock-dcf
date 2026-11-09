#!/usr/bin/env node
/**
 * Browser smoke: TradingView-style screener layout (DCF-76).
 * Confirms row pagination, clickable undervalued screen, and key DCF columns stay present.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');

(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
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
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await page.goto(`${base}/?market=US`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof isAppReady !== 'undefined' && isAppReady
      && Object.keys(stockUniverse || {}).length > 0, null, { timeout: 120000 });
    await page.evaluate(() => applyLanguage('zh'));

    const universe = await page.evaluate(() => Object.keys(stockUniverse).length);
    const expectedRows = universe > 200 ? 100 : universe;
    assert.ok(universe > 0, 'US universe hydrated');
    assert.equal(await page.locator('#screener-tbody tr').count(), expectedRows);
    assert.equal(await page.locator('#screener-all').count(), 0);

    // Default overview: primary market + scores; catalogue fair gone; FMP DCF headers exist but hidden.
    assert.equal(await page.locator('#screener-columns').inputValue(), 'overview');
    assert.equal(await page.locator('#screener-view-chips .view-chip.active').getAttribute('data-view'), 'overview');
    assert.equal(await page.locator('#screener-table thead th:visible').count(), 8);
    assert.equal(await page.locator('#screener-table th[data-i18n="th_catalogue_fair"]').count(), 0);
    assert.equal(await page.locator('#screener-table th[data-i18n="th_catalogue_premium"]').count(), 0);
    assert.equal(await page.locator('#screener-table th[onclick="sortTable(\'price\')"]:visible').count(), 1);
    assert.equal(await page.locator('#screener-table th[onclick="sortTable(\'mcap\')"]:visible').count(), 1);
    assert.equal(await page.locator('#screener-table th[data-i18n="th_fmp_dcf"]:visible').count(), 0);
    assert.ok(await page.locator('.tv-filter-bar').count());
    assert.equal(await page.locator('#screener-tbody [data-catalogue-fair]').count(), 0);
    assert.equal(await page.locator('#screener-tbody [data-fmp-reference="dcf"]').count(), expectedRows);
    // Hidden columns still in every row DOM (no data loss of remaining columns).
    assert.equal(await page.locator('#screener-tbody tr').first().locator('td').count(), 41);

    for (const [preset, columns] of [['overview', 8], ['valuation', 15], ['financial', 24], ['all', 41]]) {
      await page.locator(`#screener-view-chips .view-chip[data-view="${preset}"]`).click();
      assert.equal(await page.locator('#screener-columns').inputValue(), preset);
      assert.equal(await page.locator('#screener-table thead th:visible').count(), columns);
      assert.equal(await page.locator('#screener-tbody tr').first().locator('td:visible').count(), columns);
      assert.equal(await page.locator('#screener-tbody tr').first().locator('td').count(), 41);
    }

    // Valuation view: FMP + site target groups visible; catalogue fair fully removed.
    await page.locator('#screener-view-chips .view-chip[data-view="valuation"]').click();
    assert.equal(await page.locator('#screener-table th[data-i18n="th_fmp_dcf"]:visible').count(), 1);
    assert.equal(await page.locator('#screener-table th[data-i18n="th_fmp_levered"]:visible').count(), 1);
    assert.equal(await page.locator('#screener-table th[data-i18n="th_target"]:visible').count(), 1);
    assert.equal(await page.locator('#screener-table th[data-i18n="th_target_spread"]:visible').count(), 1);
    assert.equal(await page.locator('#screener-valuation-key').isVisible(), true);
    assert.equal(await page.locator('#screener-tbody tr').evaluateAll(rows => rows.every(row =>
      row.querySelectorAll('[data-fmp-reference]').length === 2
      && row.querySelectorAll('[data-catalogue-fair]').length === 0)), true);
    // Sticky offsets: ticker 168px; name follows (exchange hidden in valuation → 168).
    assert.equal(await page.evaluate(() =>
      getComputedStyle(document.querySelector('#screener-table .col-fixed-1')).width), '168px');
    assert.equal(await page.evaluate(() =>
      getComputedStyle(document.querySelector('#screener-table .col-fixed-3')).left), '168px');
    await page.locator('#screener-view-chips .view-chip[data-view="all"]').click();
    assert.equal(await page.evaluate(() =>
      getComputedStyle(document.querySelector('#screener-table .col-fixed-2')).left), '168px');
    assert.equal(await page.evaluate(() =>
      getComputedStyle(document.querySelector('#screener-table .col-fixed-3')).left), '240px');
    // Row click opens drawer; a post-drag click (flag set, no fresh mousedown) must not.
    await page.locator('#screener-view-chips .view-chip[data-view="overview"]').click();
    await page.locator('#screener-tbody tr').first().locator('td').nth(5).click();
    assert.equal(await page.locator('#screener-detail-drawer').isVisible(), true);
    assert.equal(await page.locator('#tv-drawer-fair').count(), 0);
    await page.locator('#screener-detail-drawer .tv-drawer-close').click();
    assert.equal(await page.locator('#screener-detail-drawer').isHidden(), true);
    const openedAfterDrag = await page.evaluate(() => {
      window.__screenerDragMoved = true;
      document.getElementById('main-scroll-box').dataset.dragMoved = '1';
      // Dispatch click only — Playwright's full click() sends mousedown first and clears the flag.
      document.querySelectorAll('#screener-tbody tr')[1]?.querySelectorAll('td')[5]
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const drawer = document.getElementById('screener-detail-drawer');
      return drawer && !drawer.hidden;
    });
    assert.equal(openedAfterDrag, false);

    // Clickable FMP DCF undervalued screen filters rows; does not wipe columns.
    // Stat HTML is `${n}<small>…%</small>` — read the leading text node, not innerText.
    const underCount = await page.locator('#stat-fmp-under').evaluate(el =>
      Number((el.childNodes[0]?.textContent || '').trim()));
    await page.locator('#stat-fmp-under-box').click();
    assert.equal(await page.evaluate(() => currentValFilter), 'FMP_UNDER');
    assert.ok(await page.locator('#stat-fmp-under-box').evaluate(el => el.classList.contains('active')));
    const filtered = await page.locator('#screener-tbody tr').count();
    if (underCount === 0) {
      assert.equal(filtered, 0);
    } else {
      // Same pagination rule as renderScreenerTable: page only when filtered list > 200.
      const expectedFiltered = underCount > 200 ? 100 : underCount;
      assert.equal(filtered, expectedFiltered);
      assert.equal(await page.locator('#screener-tbody [data-catalogue-fair]').count(), 0);
      assert.equal(await page.locator('#screener-tbody [data-fmp-reference="dcf"]').count(), filtered);
    }

    await page.locator('button[onclick="resetScreenerFilters()"]').click();
    assert.equal(await page.evaluate(() => currentValFilter), 'ALL');
    assert.equal(await page.locator('#screener-tbody tr').count(), expectedRows);

    if (universe > 200) {
      assert.equal(await page.locator('#screener-more').isVisible(), true);
      await page.locator('#screener-more').click();
      assert.equal(await page.locator('#screener-tbody tr').count(), 200);
      assert.equal(await page.locator('#screener-tbody [data-fmp-reference="dcf"]').count(), 200);
      assert.equal(await page.locator('#screener-tbody [data-catalogue-fair]').count(), 0);
    }

    console.log(`tradingview_screener_layout.browser.cjs OK (universe=${universe}, page=${expectedRows})`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
