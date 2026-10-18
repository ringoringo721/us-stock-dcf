const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { createHandler } = require('../api/fmp.js');
const Models = require('../fmp_models.js');
const root = path.resolve(__dirname, '..');
const live = process.env.TEST_LIVE_FMP === '1';
if (live) process.loadEnvFile(path.join(root, '.env.local'));
const read = symbol => JSON.parse(fs.readFileSync(path.join(root, 'cache', 'company', `${symbol}.json`)));
const queries = [];
const handler = createHandler(live ? {} : { apiKey: () => 'test-placeholder', fetch: async url => {
  queries.push(new URL(url));
  const symbol = url.searchParams.get('symbol') || url.searchParams.get('symbols');
  const data = read(symbol);
  const kinds = { 'custom-discounted-cash-flow': 'advanced', 'custom-levered-discounted-cash-flow': 'customLevered' };
  const endpoint = url.pathname.slice('/stable/'.length);
  return { ok: true, json: async () => endpoint === 'news/stock'
    ? data.news.data : data.models[kinds[endpoint]].data };
} });

(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/fmp') { handler(req, res).catch(error => { res.writeHead(500).end(); console.error(error.name); }); return; }
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
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/s3.tradingview.com/**', route => route.abort());
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [market, ticker, count] of [['US', 'AAPL', 230], ['HKEX', '0700.HK', 6]]) {
      await page.goto(`${base}/?market=${market}`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => isAppReady);
      await page.evaluate(() => applyLanguage('en'));
      assert.equal(await page.locator('#screener-tbody tr').count(), count);
      assert.equal(await page.locator('#screener-tbody tr').first().locator('td').count(), 36);
      assert.notEqual(await page.locator('#screener-tbody tr').filter({ hasText: ticker }).locator('[data-fmp-reference="dcf"]').innerText(), 'N/A');
      await page.evaluate(ticker => openCompanyProfile(ticker), ticker);
      await page.waitForFunction(ticker => stockUniverse[ticker].companyDataLoaded, ticker);
      await page.evaluate(() => switchSubPage('valuation'));
      await page.waitForSelector('#fmp-model');
      const record = read(ticker);
      const sourceStock = await page.evaluate(ticker => stockUniverse[ticker], ticker);
      const advanced = Models.value(record, 'advanced', sourceStock);
      let displayed = Number((await page.locator('#det-res-fair').innerText()).replace(/[^\d.-]/g, ''));
      assert.ok(Math.abs(displayed - advanced.fairVal) < 0.011);
      assert.equal(await page.locator('#det-badge').innerText(),
        `${sourceStock.price >= advanced.fairVal ? '+' : ''}${((sourceStock.price / advanced.fairVal - 1) * 100).toFixed(1)}%`);
      assert.equal(await page.locator('#fmp-model').inputValue(), 'advanced');
      assert.equal(await page.locator('#fmp-revenueGrowthPct').inputValue(), '', 'Blank overrides preserve actual FMP defaults');
      assert.ok(await page.locator('#fmp-workspace tbody tr').count() > 10, 'Detailed model rows load lazily');
      await page.selectOption('#fmp-model', 'customLevered');
      const levered = Models.value(record, 'customLevered', sourceStock);
      displayed = Number((await page.locator('#det-res-fair').innerText()).replace(/[^\d.-]/g, ''));
      assert.ok(Math.abs(displayed - levered.fairVal) < 0.011);
      await page.locator('[onclick="saveCustomModel()"]').click();
      const saved = await page.evaluate(ticker => getSavedModels()[ticker], ticker);
      assert.equal(saved.modelType, 'FMP_CUSTOM_DCF');
      assert.equal(saved.kind, 'customLevered');
      assert.equal(saved.targetPrice, levered.fairVal);
      assert.equal(saved.issuedShares, sourceStock.shares_outstanding);
      await page.locator('#fmp-revenueGrowthPct').fill('9');
      assert.equal(await page.locator('[onclick="saveCustomModel()"]').isDisabled(), true);
      await page.selectOption('#fmp-model', 'advanced');
      await page.selectOption('#fmp-model', 'customLevered');
      assert.equal(await page.locator('[onclick="saveCustomModel()"]').isDisabled(), true, 'Switching models cannot save stale results');
      await page.locator('#fmp-calculate').click();
      await page.waitForFunction(() => !document.getElementById('fmp-calculate').disabled);
      assert.equal(await page.locator('[onclick="saveCustomModel()"]').isDisabled(), false);
      if (!live) assert.equal(queries.at(-1).searchParams.get('revenueGrowthPct'), '0.09');
      await page.locator('[onclick="saveCustomModel()"]').click();
      const scenario = await page.evaluate(ticker => getSavedModels()[ticker], ticker);
      assert.equal(scenario.params.revenueGrowthPct, 0.09);
      if (live) assert.notEqual(scenario.targetPrice, saved.targetPrice, 'Actual FMP recalculation changes the valuation');
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForFunction(() => isAppReady && document.getElementById('fmp-model'));
      assert.equal(await page.locator('#fmp-model').inputValue(), 'customLevered');
      assert.equal(await page.locator('#fmp-revenueGrowthPct').inputValue(), '9');
      displayed = Number((await page.locator('#det-res-fair').innerText()).replace(/[^\d.-]/g, ''));
      assert.ok(Math.abs(displayed - scenario.targetPrice) < 0.011, 'Saved custom model does not silently become the latest default');
      await page.evaluate(() => navigateBack());
      const savedCell = page.locator('#screener-tbody tr').filter({ hasText: ticker }).locator('.badge-target');
      assert.ok(Math.abs(Number((await savedCell.innerText()).replace(/[^\d.-]/g, '')) - scenario.targetPrice) < 0.011,
        'The saved scenario is actually displayed as the homepage target price');
      await page.evaluate(ticker => { openCompanyProfile(ticker); switchSubPage('valuation'); }, ticker);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        'Detailed model tables scroll internally on mobile');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.evaluate(() => resetToFmpDefaults());
      assert.equal(await page.locator('#fmp-revenueGrowthPct').inputValue(), '');
      await page.evaluate(() => applyLanguage('zh'));
      assert.match(await page.locator('#fmp-workspace').innerText(), /用戶情境/);
      if (market === 'HKEX') {
        await page.evaluate(() => navigateBack());
        await page.locator('#search-ticker').waitFor({ state: 'visible' });
        for (const query of ['Tecent', '700', '0700', '00700', '\u9a30']) {
          await page.locator('#search-ticker').fill(query);
          assert.equal(await page.locator('#screener-tbody tr').count(), 1, query);
        }
        await page.evaluate(() => openCompanyProfile('0005.HK'));
        await page.evaluate(() => switchSubPage('charts'));
        await page.waitForFunction(() => document.getElementById('fcf-ratio-period')?.value === 'annual');
        assert.equal(await page.locator('#fcf-ratio-period option[value="quarterly"]').getAttribute('hidden'), '');
        await page.evaluate(() => openCompanyProfile('0823.HK'));
        await page.evaluate(() => switchSubPage('financials'));
        assert.equal(await page.locator('#statement-period option[value="quarterly"]').getAttribute('hidden'), '');
      }
    }
    let receivedSource;
    const pendingSource = new Promise(resolve => { receivedSource = resolve; });
    await page.route('**/cache/company/CSCO.json', route => { receivedSource(route); });
    await page.goto(`${base}/?market=US#CSCO/valuation`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => isAppReady && document.getElementById('fmp-model'));
    const sourceRoute = await pendingSource;
    await page.evaluate(() => FmpModels.showLegacy());
    const legacyPrice = await page.locator('#det-res-fair').innerText();
    await sourceRoute.continue();
    await page.waitForFunction(() => stockUniverse.CSCO.companyDataLoaded);
    assert.equal(await page.locator('#fcff-workspace').isVisible(), true);
    assert.equal(await page.locator('#det-res-fair').innerText(), legacyPrice,
      'Late FMP source loading cannot overwrite a separately selected legacy valuation');
    assert.deepEqual(errors, []);
    console.log(`FMP browser PASS (${live ? 'actual FMP API' : 'recorded-source mock'}): both markets, both Custom models, issued shares, overrides, saved homepage targets, persistence, search, cadence and localization.`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
