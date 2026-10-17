const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { calculate } = require('../fcff.js');
const sources = require('../cache/fcff_sources.json');
const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:8766';
const money = value => '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('RADAR_LANG', 'en');
      localStorage.setItem('M7_CUSTOM_VALUATIONS', JSON.stringify({
        CSCO: { targetPrice: 123, savedAt: '2025-01-01', params: { fcf0: 999, growth_10y: Array(10).fill(50) } }
      }));
    });
    await page.goto(`${baseUrl}/#CSCO/valuation`, { waitUntil: 'networkidle' });
    const baseline = calculate(sources.stocks.CSCO);
    assert.equal(await page.locator('#det-res-fair').innerText(), money(baseline.fairVal));
    assert.match(await page.locator('#fcff-legacy').innerText(), /legacy target|legacy FCF/i);
    assert.equal(await page.locator('#fcff-table thead th').count(), baseline.periods.length + 1);
    assert.equal(await page.locator('#fcff-sensitivity .sens-base').innerText(), money(baseline.fairVal));
    assert.ok(!(await page.locator('#fcff-workspace').innerText()).match(/[\u3400-\u9fff]|NaN|undefined|Infinity/));
    assert.equal(await page.locator('#panel-general-dcf').isVisible(), false);
    assert.equal(await page.locator('#inp-fcf0').isVisible(), false);

    const browserResults = await page.evaluate(() => Object.fromEntries(Object.keys(window.FCFF_DATA.stocks)
      .map(ticker => {
        const result = computeDCF(stockUniverse[ticker], ticker);
        return [ticker, { fairVal: result.fairVal, reason: result.reason, premiumPct: result.premiumPct }];
      })));
    for (const [ticker, source] of Object.entries(sources.stocks)) {
      const expected = calculate(source);
      assert.deepEqual(browserResults[ticker], {
        fairVal: expected.fairVal, reason: expected.reason,
        premiumPct: expected.fairVal > 0
          ? (await page.evaluate(ticker => stockUniverse[ticker].price, ticker) / expected.fairVal - 1) * 100 : null
      }, ticker);
    }

    await page.locator('#fcff-input-controls summary').click();
    for (const [key, value] of [['beta', '0'], ['tax', '0'], ['g', '0'], ['kd', '0'], ['cash', '0']]) {
      await page.locator(`#fcff-${key}`).fill(value);
    }
    const zeroScenario = { beta: 0, tax: 0, g: 0, kd: 0, cash: 0 };
    assert.equal(await page.locator('#det-res-fair').innerText(), money(calculate(sources.stocks.CSCO, zeroScenario).fairVal));
    assert.equal(await page.locator('#fcff-sensitivity .sens-base').innerText(), await page.locator('#det-res-fair').innerText());
    await page.locator('#fcff-beta').fill('-0.047');
    assert.equal(await page.locator('#det-res-fair').innerText(),
      money(calculate(sources.stocks.CSCO, { ...zeroScenario, beta: -0.047 }).fairVal));
    assert.equal(await page.evaluate(() => window.FCFF_DATA.stocks.CSCO.defaults.beta),
      sources.stocks.CSCO.defaults.beta, 'Manual beta is not written back to provider data');
    const fair = await page.locator('#det-res-fair').innerText();
    await page.evaluate(() => { switchSubPage('basic'); switchSubPage('valuation'); applyLanguage('zh'); });
    assert.equal(await page.locator('#fcff-beta').inputValue(), '-0.047');
    assert.equal(await page.locator('#det-res-fair').innerText(), fair);
    await page.evaluate(() => applyLanguage('en'));
    assert.equal(await page.locator('#fcff-beta').inputValue(), '-0.047');
    await page.locator('[onclick="saveCustomModel()"]').click();
    const stored = await page.evaluate(() => ({
      model: getSavedModels().CSCO,
      archive: JSON.parse(localStorage.getItem('M7_LEGACY_VALUATIONS')).CSCO
    }));
    assert.equal(stored.model.params.modelVersion, 'fcff-v1');
    assert.equal(stored.model.params.beta, -0.047);
    assert.equal(stored.model.params.tax, 0);
    assert.equal(stored.archive[0].params.fcf0, 999);
    await page.evaluate(() => { delete stockUniverse.CSCO.fcffScenario; loadDetailTicker('CSCO'); });
    assert.equal(await page.locator('#fcff-beta').inputValue(), '-0.047');
    await page.locator('[onclick="resetToFmpDefaults()"]').click();
    assert.equal(await page.locator('#det-res-fair').innerText(), money(baseline.fairVal));
    assert.equal(await page.evaluate(() => getSavedModels().CSCO), undefined);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('M7_LEGACY_VALUATIONS')).CSCO[0].targetPrice), 123);

    for (const language of ['en', 'zh']) {
      await page.evaluate(language => applyLanguage(language), language);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => SiteTheme.set(theme), theme);
        for (const width of [390, 1440]) {
          await page.setViewportSize({ width, height: 1000 });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
          assert.ok(await page.locator('#fcff-workspace').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
          assert.equal(await page.locator('#fcff-sensitivity .sens-base').innerText(), money(baseline.fairVal));
          if (process.env.UI_SCREENSHOT_DIR && language === 'en') {
            await page.screenshot({ path: require('node:path').join(process.env.UI_SCREENSHOT_DIR,
              `fcff-${theme}-${width}.png`), fullPage: true });
          }
        }
      }
    }
    await page.locator('#fcff-input-controls summary').click();
    await page.locator('#fcff-shares').fill('');
    assert.equal(await page.locator('#det-res-fair').innerText(), 'N/A');
    assert.equal(await page.locator('[onclick="saveCustomModel()"]').isDisabled(), true);
    assert.equal(await page.locator('#fcff-table thead th').count(), 1, 'Invalid inputs clear the previous forecast');
    await page.locator('[onclick="resetToFmpDefaults()"]').click();
    assert.equal(await page.locator('#det-res-fair').innerText(), money(baseline.fairVal));
    for (const ticker of ['NVDA', 'TSM', 'BRK.B']) {
      await page.evaluate(ticker => openDetail(ticker), ticker);
      assert.equal(await page.locator('#det-res-fair').innerText(), 'N/A', ticker);
      assert.equal(await page.locator('[onclick="saveCustomModel()"]').isDisabled(), true);
      assert.ok(await page.locator('#fcff-status').innerText());
      assert.equal(await page.locator('#fcff-sensitivity td').innerText(), 'N/A');
    }
    await page.evaluate(() => { openCompanyProfile('GIS'); applyLanguage('en'); });
    assert.equal(await page.locator('#cmp-meta-beta').innerText(), String(sources.betaSources.GIS.value));
    assert.match(await page.locator('[data-i18n="lbl_beta_5y"]').innerText(), /unspecified/);
    assert.deepEqual(errors, []);
    console.log('PASS: 214 browser/core defaults; FCFF components and sensitivity, lease N/A, zero/negative beta, legacy archive, save/reset, tabs/language, mobile and both themes.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
