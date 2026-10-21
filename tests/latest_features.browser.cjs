const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const Technical = require('../technical_indicators.js');
const root = path.resolve(__dirname, '..', 'public');
const priceRows = ticker => JSON.parse(fs.readFileSync(path.join(root, 'cache', 'price_charts', `${ticker}.json`))).rows;

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    fs.readFile(file, (error, bytes) => {
      if (error) return res.writeHead(404).end();
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
    const errors = [], queries = [];
    let mode = 'valid', release = null;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/fmp?**', async route => {
      const q = new URL(route.request().url()).searchParams, symbol = q.get('symbol');
      if (q.get('action') !== 'technical') return route.fulfill({ json: {
        data: [], page: Number(q.get('page') || 0), hasMore: false, source: { provider: 'FMP', symbol }
      } });
      const indicator = q.get('indicator'), periodLength = Number(q.get('periodLength'));
      const from = q.get('from'), to = q.get('to');
      assert.ok(Technical.validRequest(indicator, periodLength, from, to));
      queries.push({ symbol, indicator, periodLength, from, to });
      if (periodLength === 7 && !release) await new Promise(resolve => { release = resolve; });
      const rows = priceRows(symbol).filter(row => row[0] >= from && row[0] <= to);
      const data = mode === 'empty' ? [] : rows.map((row, index) => ({
        date: row[0], close: mode === 'mismatch' ? row[1] * 2 : row[1],
        value: index === 0 ? null : Technical.catalog.find(item => item.id === indicator).overlay ? row[1] * 0.98 : 0
      }));
      await route.fulfill({ json: { data, source: { provider: 'FMP', symbol, indicator, periodLength,
        timeframe: '1day', from, to, capturedAt: '2026-10-17T00:00:00Z' } } });
    });
    await page.route('**/s3.tradingview.com/**', route => route.abort());
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/?market=HKEX`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => isAppReady);
    await page.evaluate(() => applyLanguage('en'));
    assert.equal(await page.locator('#screener-table th[data-i18n="th_fmp_dcf"], #screener-table th[data-i18n="th_fmp_dcf_upside"], #screener-table th[data-i18n="th_fmp_levered"], #screener-table th[data-i18n="th_fmp_levered_upside"]').count(), 0);
    assert.equal(await page.locator('#screener-table [onclick="sortTable(\'fmp_dcf\')"], #screener-table [onclick="sortTable(\'fmp_dcf_upside\')"], #screener-table [onclick="sortTable(\'fmp_levered\')"], #screener-table [onclick="sortTable(\'fmp_levered_upside\')"]').count(), 0);
    assert.equal(await page.locator('#screener-tbody [data-fmp-reference], #screener-tbody [data-price-difference]').count(), 0);
    assert.equal(await page.locator('#screener-table th[data-i18n="th_premium"]').count(), 0);
    assert.equal(await page.locator('#screener-tbody .badge-undervalued, #screener-tbody .badge-overvalued').count(), 0);
    for (const [preset, expected] of [['overview', 7], ['valuation', 14], ['financial', 20], ['all', 32]]) {
      await page.selectOption('#screener-columns', preset);
      assert.equal(await page.locator('#screener-table thead th:visible').count(), expected);
      assert.equal(await page.locator('#screener-tbody tr').first().locator('td:visible').count(), expected);
    }
    await page.goto(`${base}/#AAPL/profile`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => isAppReady && !document.getElementById('price-history-plots').hidden);
    await page.evaluate(() => applyLanguage('en'));
    await page.locator('#price-technical-controls summary').click();
    for (const item of Technical.catalog) await page.locator(`[data-technical="${item.id}"]`).check();
    await page.waitForFunction(() => Chart.getChart('price-chart')?.data.datasets.length === 6
      && document.querySelectorAll('#price-indicator-plots canvas').length === 4);
    assert.equal(await page.locator('#price-technical-choices input[type=checkbox]:checked').count(), 9);
    assert.ok(queries.some(query => query.from === priceRows('AAPL')[0][0]),
      'Request the complete available saved price period, not an arbitrarily shortened indicator range');
    const aligned = await page.evaluate(() => {
      const charts = ['price-chart', 'price-volume-chart', 'price-indicator-rsi', 'price-indicator-adx',
        'price-indicator-williams', 'price-indicator-standarddeviation'].map(id => Chart.getChart(id));
      return charts.map(chart => ({ min: chart.scales.x.min, max: chart.scales.x.max,
        left: chart.chartArea.left, right: chart.chartArea.right,
        points: chart.data.datasets.at(-1).data }));
    });
    for (const chart of aligned) {
      assert.equal(chart.min, aligned[0].min); assert.equal(chart.max, aligned[0].max);
      assert.ok(Math.abs(chart.left - aligned[0].left) < 1);
      assert.ok(Math.abs(chart.right - aligned[0].right) < 1);
    }
    assert.ok(aligned[2].points.some(point => point.y === 0), 'Do not erase actual zero oscillator values');
    await page.locator('[data-period="all"]').click();
    assert.equal(await page.evaluate(() => Chart.getChart('price-chart').data.datasets[0].data.length), priceRows('AAPL').length);
    assert.equal(await page.evaluate(() => Chart.getChart('price-indicator-rsi').data.datasets[0].data[0].y), null,
      'Unavailable warmup is a gap, not zero');
    await page.locator('[data-period="3m"]').click();
    assert.equal(await page.evaluate(() => Chart.getChart('price-indicator-rsi').data.datasets[0].data.length),
      await page.evaluate(() => Chart.getChart('price-chart').data.datasets[0].data.length));
    const count = queries.length;
    const delayed = page.waitForRequest(request => request.url().includes('indicator=rsi') && request.url().includes('periodLength=7'));
    await page.locator('[data-technical-period="rsi"]').fill('7');
    await page.locator('[data-technical-period="rsi"]').dispatchEvent('change');
    await delayed;
    await page.locator('[data-technical-period="rsi"]').fill('14');
    await page.locator('[data-technical-period="rsi"]').dispatchEvent('change');
    while (!release) await new Promise(resolve => setImmediate(resolve));
    release();
    await page.waitForLoadState('networkidle');
    assert.match(await page.locator('#price-technical-status').innerText(), /RSI.*\(14\)/);
    assert.doesNotMatch(await page.locator('#price-technical-status').innerText(), /\(7\)/);
    assert.ok(queries.length > count);
    mode = 'empty';
    await page.locator('[data-technical-period="standarddeviation"]').fill('21');
    await page.locator('[data-technical-period="standarddeviation"]').dispatchEvent('change');
    await page.waitForFunction(() => document.getElementById('price-technical-status').textContent.includes('FMP_NO_TECHNICAL_COVERAGE'));
    assert.equal(await page.locator('#price-indicator-standarddeviation').count(), 0);
    mode = 'mismatch';
    await page.locator('[data-technical-period="rsi"]').fill('15');
    await page.locator('[data-technical-period="rsi"]').dispatchEvent('change');
    await page.waitForFunction(() => document.getElementById('price-technical-status').textContent.includes('TECHNICAL_PRICE_BASIS_MISMATCH'));
    assert.equal(await page.locator('#price-indicator-rsi').count(), 0);
    mode = 'valid';
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.getElementById('price-history-plots').hidden);
    await page.locator('#price-technical-controls summary').click();
    const beforeReloadSelections = queries.length;
    for (const item of Technical.catalog) await page.locator(`[data-technical="${item.id}"]`).check();
    await page.waitForFunction(() => Chart.getChart('price-chart')?.data.datasets.length === 6
      && document.querySelectorAll('#price-indicator-plots canvas').length === 4);
    assert.equal(queries.length, beforeReloadSelections, 'Browser reload reuses persisted FMP responses, including empty chunks');
    for (const lang of ['zh', 'en']) {
      await page.evaluate(lang => applyLanguage(lang), lang);
      await page.waitForFunction(() => document.querySelectorAll('#price-indicator-plots canvas').length === 4);
      for (const theme of ['dark', 'light']) await page.evaluate(theme => SiteTheme.set(theme), theme);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => Chart.getChart('price-chart').width < 400);
    const overflowing = await page.evaluate(() => [...document.querySelectorAll('#company-view *')]
      .filter(element => element.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 12).map(element => [element.tagName, element.id, element.className, element.getBoundingClientRect().right]));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, JSON.stringify(overflowing));
    release = null;
    const oldTickerRequest = page.waitForRequest(request => request.url().includes('indicator=ema') && request.url().includes('periodLength=7'));
    await page.locator('[data-technical-period="ema"]').fill('7');
    await page.locator('[data-technical-period="ema"]').dispatchEvent('change');
    await oldTickerRequest;
    await page.evaluate(() => openCompanyProfile('MSFT'));
    await page.waitForFunction(() => document.getElementById('price-company').textContent.startsWith('MSFT')
      && !document.getElementById('price-history-plots').hidden);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    release();
    await page.waitForLoadState('networkidle');
    assert.equal(await page.evaluate(() => Chart.getChart('price-chart').data.datasets.length), 1);
    assert.equal(await page.locator('#price-indicator-plots canvas').count(), 0);
    assert.deepEqual(errors, []);
    console.log('Latest feature browser PASS: nine indicators, bounded historical requests, alignment, lookback races, empty/mismatched coverage, persistent reloads, themes/mobile and adjacent/sorted valuation percentages.');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
