const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { createHandler } = require('../api/fmp.js');
const Models = require('../fmp_models.js');
const Scenario = require('../fmp_scenario.js');
const root = path.resolve(__dirname, '..');
const live = process.env.TEST_LIVE_FMP === '1';
if (live) process.loadEnvFile(path.join(root, '.env.local'));
const read = symbol => JSON.parse(fs.readFileSync(path.join(root, 'cache', 'company', `${symbol}.json`)));
const queries = [];
let rejectCalculation = false;
async function fillMissingScenario(page) {
  const manual = { growth: 3, ebitda: 30, ebit: 25, da: 5, receivables: 20,
    inventories: 10, payables: 5, nwcChange: 2, cfo: 30, capex: -10, tax: 20, beta: 1,
    rf: 4, erp: 5, kd: 5, ke: 9, debtWeight: 20 };
  for (const input of await page.locator('[data-scenario-key]').all()) {
    if (await input.inputValue() === '') {
      await input.fill(String(manual[await input.getAttribute('data-scenario-key')]));
    }
  }
  if (await page.locator('#fmp-terminal-growth').inputValue() === '') {
    await page.locator('#fmp-terminal-growth').fill('2');
  }
  await page.locator('#fmp-calculate').click();
}
const handler = createHandler(live ? {} : { apiKey: () => 'test-placeholder', fetch: async url => {
  queries.push(new URL(url));
  const symbol = url.searchParams.get('symbol') || url.searchParams.get('symbols');
  const data = read(symbol);
  const kinds = { 'custom-discounted-cash-flow': 'advanced', 'custom-levered-discounted-cash-flow': 'customLevered' };
  const endpoint = url.pathname.slice('/stable/'.length);
  if (rejectCalculation && endpoint !== 'news/stock') return { ok: false, status: 503, json: async () => ({}) };
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
    for (const [market, ticker, count] of [['US', 'AAPL', 982], ['HKEX', '0700.HK', require('../hkex_stocks.json').length]]) {
      await page.goto(`${base}/?market=${market}`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => isAppReady);
      await page.evaluate(() => applyLanguage('en'));
      assert.equal(await page.locator('#screener-tbody tr').count(), count);
      assert.equal(await page.locator('#screener-tbody tr').first().locator('td').count(), 32);
      for (const language of ['zh', 'en']) {
        await page.evaluate(language => applyLanguage(language), language);
        for (const [preset, columns] of [['overview', 7], ['valuation', 14], ['financial', 20], ['all', 32]]) {
          await page.selectOption('#screener-columns', preset);
          assert.equal(await page.locator('#screener-table thead th:visible').count(), columns);
          assert.equal(await page.locator('#screener-table th[data-i18n="th_fair"], #screener-table th[data-i18n="th_fair_upside"]').count(), 0);
          assert.equal(await page.locator('#screener-table th[data-i18n="th_fmp_dcf"], #screener-table th[data-i18n="th_fmp_levered"], #screener-table [onclick="sortTable(\'fmp_dcf\')"], #screener-table [onclick="sortTable(\'fmp_levered\')"]').count(), 0);
          assert.equal(await page.locator('#screener-table [onclick="sortTable(\'fairVal\')"], #screener-table [onclick="sortTable(\'fair_upside\')"], #screener-tbody [data-price-difference="fair"]').count(), 0);
          assert.equal(await page.locator('#screener-tbody tr').evaluateAll((rows, columns) => rows.every(row =>
            row.cells.length === 32 && [...row.cells].filter(cell => !cell.hidden).length === columns
            && row.querySelectorAll('[data-fmp-reference]').length === 0
            && row.querySelectorAll('[data-price-difference]').length === 0), columns), true,
          `${market}/${language}/${preset}: all ${count} stocks have aligned columns without FMP screener references`);
        }
      }
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
      assert.equal(await page.locator('#fmp-legacy, #fcff-workspace, #fmp-return').count(), 0);
      assert.equal(await page.evaluate(() => typeof FmpModels.showLegacy), 'undefined');
      assert.equal(await page.locator('#fmp-vendor-years thead th').nth(3).innerText(), 'EBITDA');
      const sourceFirst = record.models.advanced.data.slice().sort((a, b) => Number(a.year) - Number(b.year))[0];
      const firstEbitda = Number((await page.locator('#fmp-vendor-years tbody tr').first().locator('td').nth(2).innerText()).replace(/[^\d.-]/g, ''));
      assert.ok(Math.abs(firstEbitda - sourceFirst.ebitda) < 0.011, 'Label and actual field both use EBITDA, not EBIT');
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
      assert.equal(await page.locator('[onclick="saveCustomModel()"]').isEnabled(), true);
      await page.selectOption('#fmp-mode', 'ten-year');
      await page.locator('[data-scenario-year="0"][data-scenario-key="growth"]').fill('13');
      await page.locator('#fmp-calculate').click();
      await page.selectOption('#fmp-mode', 'vendor');
      await page.selectOption('#fmp-model', 'advanced');
      await page.selectOption('#fmp-model', 'customLevered');
      assert.equal(await page.locator('[onclick="saveCustomModel()"]').isEnabled(), true, 'Save will calculate pending overrides first');
      await page.locator('[onclick="saveCustomModel()"]').click();
      await page.waitForFunction(ticker => getSavedModels()[ticker]?.params?.revenueGrowthPct === 0.09, ticker);
      assert.equal(await page.locator('[onclick="saveCustomModel()"]').isDisabled(), false);
      if (!live) assert.equal(queries.at(-1).searchParams.get('revenueGrowthPct'), '0.09');
      await page.locator('[onclick="saveCustomModel()"]').click();
      const scenario = await page.evaluate(ticker => getSavedModels()[ticker], ticker);
      assert.equal(scenario.params.revenueGrowthPct, 0.09);
      if (live) assert.notEqual(scenario.targetPrice, saved.targetPrice, 'Actual FMP recalculation changes the valuation');
      if (!live) {
        rejectCalculation = true;
        await page.locator('#fmp-revenueGrowthPct').fill('8');
        await page.locator('[onclick="saveCustomModel()"]').click();
        await page.waitForFunction(() => document.getElementById('fmp-status').textContent.includes('Calculation failed'));
        assert.deepEqual(await page.evaluate(ticker => getSavedModels()[ticker], ticker), scenario, 'Failed calculation cannot overwrite saved target');
        rejectCalculation = false;
      }
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
      await page.selectOption('#fmp-mode', 'ten-year');
      const initial = Scenario.defaults(record, 'customLevered', Models.issuedShares(sourceStock));
      assert.equal(await page.locator('#fmp-ten-year-inputs thead th').count(), 12, 'Actual reference plus ten future fiscal years');
      await page.waitForFunction(() => !document.getElementById('fmp-actual-note').textContent.startsWith('Actual financial reference unavailable'));
      assert.match(await page.locator('#fmp-actual-period').innerText(), new RegExp(initial.baseDate));
      assert.match(await page.locator('[data-actual-key="cfo"]').innerText(), /FMP standardized actual/);
      assert.match(await page.locator('[data-actual-key="beta"]').innerText(), /N\/A/);
      assert.equal(await page.locator('[data-scenario-year="0"][data-scenario-key="growth"]').getAttribute('title'), String(initial.years[0].values.growth));
      for (const control of await page.locator('[data-scenario-key]:not([data-scenario-key="beta"]), #fmp-terminal-growth').all()) {
        const input = await control.inputValue();
        if (input) assert.match(input, /^-?\d+\.\d{2}$/, 'Available percentage inputs display exactly two decimal places');
        else assert.equal(await control.getAttribute('placeholder'), 'N/A');
      }
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#fmp-download-audit').click()]);
      const packet = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
      assert.equal(packet.tenYear.input.years[0].values.growth, initial.years[0].values.growth, 'Formatting/rerender/export must not round internal source values');
      assert.equal(packet.tenYear.result, null);
      assert.equal(packet.tenYear.reason, 'SCENARIO_INCOMPLETE_ASSUMPTIONS');
      assert.equal(await page.locator('#det-res-fair').innerText(), 'N/A');
      assert.equal(await page.locator('[onclick="saveCustomModel()"]').isDisabled(), true);
      assert.equal(packet.actualReference.date, initial.baseDate);
      assert.deepEqual(packet.originalSourceModels.customLevered.data, record.models.customLevered.data);
      assert.equal(await page.locator('#fmp-ten-year-results tbody tr').count(), 0);
      assert.equal(await page.locator('#fmp-ten-year-inputs [data-scenario-key="growth"]').count(), 10);
      assert.equal(await page.locator('[data-origin="5-growth"]').innerText(), 'N/A: forecast unavailable');
      assert.equal(await page.locator('[data-origin="0-capex"]').innerText(), 'Latest FY actual ratio (not consensus)');
      assert.equal(await page.locator('[data-origin="0-beta"]').innerText(), 'Retained capital-cost setting');
      await fillMissingScenario(page);
      assert.equal(await page.locator('#fmp-ten-year-results tbody tr').count(), 10);
      const [completedDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#fmp-download-audit').click()]);
      const completed = JSON.parse(fs.readFileSync(await completedDownload.path(), 'utf8'));
      assert.equal(completed.tenYear.result.targetPrice, Scenario.calculate(completed.tenYear.input).targetPrice);
      assert.equal(completed.tenYear.input.years[5].origins.growth, 'user');
      await page.locator('[data-scenario-year="0"][data-scenario-key="growth"]').fill('12');
      await page.locator('[onclick="saveCustomModel()"]').click();
      await page.waitForFunction(ticker => getSavedModels()[ticker]?.modelType === 'FMP_TEN_YEAR_SCENARIO', ticker);
      const tenYear = await page.evaluate(ticker => getSavedModels()[ticker], ticker);
      assert.equal(tenYear.scenario.years[0].values.growth, 12);
      assert.equal(tenYear.scenario.years.length, 10);
      assert.equal(tenYear.targetPrice, Scenario.calculate(tenYear.scenario).targetPrice);
      assert.notEqual(tenYear.targetPrice, completed.tenYear.result.targetPrice);
      await page.selectOption('#fmp-model', 'advanced');
      await page.locator('[data-scenario-year="0"][data-scenario-key="ebit"]').fill('20');
      assert.equal(await page.locator('[data-scenario-key="cash"], [data-actual-key="cash"]').count(), 0,
        'Unused cash/revenue input and its actual reference are removed');
      assert.equal(await page.locator('[data-scenario-key="receivables"], [data-scenario-key="inventories"], [data-scenario-key="payables"]').count(), 0,
        'Three component inputs are replaced by one change-in-NWC/revenue ratio');
      assert.equal(await page.locator('[data-scenario-key="nwcChange"]').count(), 10);
      assert.equal(await page.locator('[data-actual-key="nwcChange"]').count(), 1);
      assert.doesNotMatch(await page.locator('#fmp-ten-year-results thead').innerText(), /Cash balance|現金餘額/);
      assert.equal(await page.locator('#fmp-snapshot-net-debt').count(), 1, 'The real equity-value cash bridge remains');
      const da = Number(await page.locator('[data-scenario-year="0"][data-scenario-key="da"]').inputValue());
      assert.ok(Math.abs(Number(await page.locator('[data-scenario-year="0"][data-scenario-key="ebitda"]').inputValue()) - 20 - da) < 1e-10);
      await page.locator('[data-scenario-year="1"][data-scenario-key="beta"]').fill('2');
      assert.equal(await page.locator('[data-origin="1-ke"]').innerText(), 'CAPM');
      assert.equal(await page.locator('[data-origin="0-capex"]').innerText(), 'Latest FY actual ratio (not consensus)',
        'Editing an unrelated input must not relabel actual ratios as legacy extensions');
      await page.selectOption('#fmp-model', 'customLevered');
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForFunction(() => isAppReady && document.getElementById('fmp-mode'));
      assert.equal(await page.locator('#fmp-mode').inputValue(), 'ten-year');
      assert.equal(await page.locator('[data-scenario-year="0"][data-scenario-key="growth"]').inputValue(), '12.00');
      assert.equal(await page.locator('#fmp-ten-year-results tbody tr').count(), 10);
      await page.evaluate(() => navigateBack());
      const tenYearCell = page.locator('#screener-tbody tr').filter({ hasText: ticker }).locator('.badge-target');
      assert.match(await tenYearCell.getAttribute('title'), /Site-calculated/);
      assert.ok(Math.abs(Number((await tenYearCell.innerText()).replace(/[^\d.-]/g, '')) - tenYear.targetPrice) < 0.011);
      await page.evaluate(ticker => { openCompanyProfile(ticker); switchSubPage('valuation'); }, ticker);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Ten-year inputs scroll inside the mobile panel');
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
        await page.waitForFunction(() => document.getElementById('fcf-ratio-period')?.value === 'semiannual');
        assert.equal(await page.locator('#fcf-ratio-period option[value="quarterly"]').getAttribute('hidden'), '');
        await page.evaluate(() => openCompanyProfile('0823.HK'));
        await page.evaluate(() => switchSubPage('financials'));
        assert.equal(await page.locator('#statement-period option[value="quarterly"]').getAttribute('hidden'), '');
      }
    }
    for (const ticker of ['0027.HK', '1928.HK']) {
      await page.goto(`${base}/?market=HKEX#${ticker}/valuation`, { waitUntil: 'networkidle' });
      await page.waitForFunction(ticker => isAppReady && stockUniverse[ticker].companyDataLoaded, ticker);
      await page.evaluate(() => applyLanguage('en'));
      await page.selectOption('#fmp-mode', 'ten-year');
      const data = read(ticker);
      assert.equal(await page.locator('[data-scenario-key="nwcChange"]').count(), 10);
      assert.equal(await page.locator('[data-scenario-key="receivables"], [data-scenario-key="inventories"], [data-scenario-key="payables"]').count(), 0);
      assert.equal(await page.locator('[data-scenario-year="0"][data-scenario-key="da"]').getAttribute('title'),
        String(data.forecastActuals.latest.items.da.percent));
      if (ticker === '0027.HK') {
        const firstGrowth = Number(await page.locator('[data-scenario-year="0"][data-scenario-key="growth"]').getAttribute('title'));
        const forecast = data.analystEstimates.rows.find(row => row.date === '2026-12-31');
        assert.ok(Math.abs(data.forecastBase.revenue * (1 + firstGrowth / 100) - forecast.revenueAvg) < 0.0001);
        assert.match(await page.locator('#fmp-revenue-source-warning').innerText(), /unmodified provider figures/);
        assert.doesNotMatch(await page.locator('#fmp-assumption-sources').innerText(), /reconciliation failed/);
        const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#fmp-download-audit').click()]);
        const packet = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        assert.equal(packet.tenYear.input.baseRevenue, 49242325000);
        assert.equal(packet.tenYear.input.baseRevenueSource, 'officialReportedRevenue');
        assert.equal(packet.tenYear.result, null, 'Missing taxes/terminal assumptions still block valuation');
      } else {
        const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#fmp-download-audit').click()]);
        const packet = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        assert.equal(packet.analystEstimates.currency, 'USD');
        assert.equal(packet.currency, 'HKD');
        const forecast = data.analystEstimates.rows.find(row => row.date === '2026-12-31');
        assert.ok(Math.abs(packet.tenYear.input.baseRevenue * (1 + packet.tenYear.input.years[0].values.growth / 100)
          - forecast.revenueAvg * data.analystEstimates.fx.rate) < 0.0001);
      }
      await page.selectOption('#fmp-model', 'customLevered');
      assert.equal(await page.locator('[data-scenario-year="0"][data-scenario-key="cfo"]').getAttribute('title'),
        String(data.forecastActuals.latest.items.cfo.percent));
      assert.equal(await page.locator('[data-scenario-year="0"][data-scenario-key="capex"]').getAttribute('title'),
        String(data.forecastActuals.latest.items.capex.percent));
      assert.equal(await page.locator('[data-scenario-key="nwcChange"]').count(), 0, 'CFO already includes working capital');
      assert.equal(await page.locator('#det-res-fair').innerText(), 'N/A');
      if (ticker === '0027.HK') {
        await page.evaluate(() => switchSubPage('financials'));
        assert.match(await page.locator('#cmp-fin-table').innerText(), /49,242/);
        await page.evaluate(() => switchSubPage('ratios'));
        assert.match(await page.locator('#ratio-status').innerText(), /official revenue before gaming tax/);
        const grossMargin = page.locator('#cmp-ratio-table tr').filter({ hasText: /Gross.*Margin/i });
        assert.equal(await grossMargin.count(), 1);
        assert.doesNotMatch(await grossMargin.locator('td').last().innerText(), /\d/,
          'Unreported gross margin must display unavailable, never zero');
        const retained = Scenario.defaults(data, 'advanced', 4375000000);
        retained.baseRevenue = 29591615000;
        retained.baseRevenueSource = 'nativeHistoricalModelRevenue';
        const saved = { schemaVersion: 2, modelType: 'FMP_TEN_YEAR_SCENARIO', ticker, currency: 'HKD',
          kind: 'advanced', targetPrice: 41, scenario: retained, params: {}, savedAt: '2026-10-18T00:00:00Z' };
        await page.evaluate(saved => storeSavedModels({ ...getSavedModels(), [saved.ticker]: saved }), saved);
        await page.goto(`${base}/?market=HKEX#${ticker}/valuation`, { waitUntil: 'networkidle' });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForFunction(ticker => isAppReady && stockUniverse[ticker].companyDataLoaded, ticker);
        await page.evaluate(() => applyLanguage('en'));
        assert.match(await page.locator('#fmp-stale-revenue-basis').innerText(), /pre-correction revenue baseline/);
        assert.deepEqual(await page.evaluate(ticker => getSavedModels()[ticker], ticker), saved,
          'Official financial correction must not overwrite retained user assumptions or targets');
      } else {
        await page.evaluate(() => switchSubPage('financials'));
        assert.match(await page.locator('#statement-status').innerText(), /Reviewed revenue and specified income lines/);
        assert.equal(await page.locator('#statement-status a[href$="2026033101127.pdf"]').count(), 1);
        await page.evaluate(() => switchSubPage('ratios'));
        assert.match(await page.locator('#ratio-status').innerText(), /official revenue before gaming tax/);
        const grossMargin = page.locator('#cmp-ratio-table tr').filter({ hasText: /Gross.*Margin/i });
        assert.equal(await grossMargin.count(), 1);
        assert.doesNotMatch(await grossMargin.locator('td').last().innerText(), /\d/,
          'Sands has no reported consolidated gross-profit subtotal');
      }
    }
    let receivedSource;
    const pendingSource = new Promise(resolve => { receivedSource = resolve; });
    await page.route('**/cache/company/CSCO.json', route => { receivedSource(route); });
    let receivedActuals;
    const pendingActuals = new Promise(resolve => { receivedActuals = resolve; });
    await page.route('**/cache/financials/CSCO_statements_v2.json', route => { receivedActuals(route); });
    await page.goto(`${base}/?market=US#CSCO/valuation`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => isAppReady && document.getElementById('fmp-model'));
    const sourceRoute = await pendingSource;
    await page.selectOption('#fmp-mode', 'ten-year');
    await sourceRoute.continue();
    await page.waitForFunction(() => stockUniverse.CSCO.companyDataLoaded);
    assert.equal(await page.locator('#fmp-mode').inputValue(), 'ten-year');
    assert.equal(await page.locator('#fmp-ten-year-inputs thead th').count(), 12,
      'Late source load initializes ten annual input columns without switching back to vendor mode');
    assert.equal(await page.locator('#fmp-ten-year-results tbody tr').count(), 0, 'Incomplete consensus does not fabricate a valuation');
    const actualsRoute = await pendingActuals;
    await page.locator('[data-scenario-year="0"][data-scenario-key="growth"]').fill('12.345');
    await page.locator('[data-scenario-year="0"][data-scenario-key="growth"]').press('Tab');
    await actualsRoute.continue();
    await page.waitForFunction(() => !document.getElementById('fmp-actual-note').textContent.startsWith('Actual financial reference unavailable'));
    assert.equal(await page.locator('[data-scenario-year="0"][data-scenario-key="growth"]').inputValue(), '12.35');
    assert.equal(await page.locator('[data-scenario-year="0"][data-scenario-key="growth"]').getAttribute('title'), '12.345',
      'Asynchronous actual-reference loading must not replace or round user input state');
    await page.selectOption('#fmp-mode', 'vendor');
    let holdCalculation;
    const held = new Promise(resolve => { holdCalculation = resolve; });
    await page.route('**/api/fmp?**', route => {
      if (new URL(route.request().url()).searchParams.get('action') === 'custom-dcf') { holdCalculation(route); return; }
      return route.continue();
    });
    await page.locator('#fmp-revenueGrowthPct').fill('7');
    await page.locator('[onclick="saveCustomModel()"]').click();
    const heldRoute = await held;
    await page.evaluate(() => { openCompanyProfile('JPM'); switchSubPage('valuation'); });
    const bankPrice = await page.locator('#det-res-fair').innerText();
    await heldRoute.fulfill({ contentType: 'application/json', body: JSON.stringify({
      data: read('CSCO').models.advanced.data, source: { symbol: 'CSCO', capturedAt: new Date().toISOString() }
    }) });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#det-res-fair').innerText(), bankPrice, 'Late nonfinancial calculation cannot replace bank valuation');
    assert.equal(await page.locator('[onclick="saveCustomModel()"]').isEnabled(), true);
    assert.deepEqual(errors, []);
    console.log(`FMP browser PASS (${live ? 'actual FMP API' : 'recorded-source mock'}): both markets, both Custom models, issued shares, overrides, saved homepage targets, persistence, search, cadence and localization.`);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
