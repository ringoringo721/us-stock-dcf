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
    await page.evaluate(() => FmpModels.showLegacy());
    const baseline = calculate(sources.stocks.CSCO);
    assert.equal(await page.locator('#det-res-fair').innerText(), money(baseline.fairVal));
    assert.deepEqual(await page.locator('#fcff-workspace input[type="number"]').evaluateAll(inputs =>
      inputs.filter(input => input.value !== '' && !/^-?\d+\.\d{2}$/.test(input.value)).map(input => input.id)), []);
    assert.equal(await page.locator('#fcff-shares').inputValue(), sources.stocks.CSCO.defaults.shares.toFixed(2));
    assert.equal(await page.evaluate(() => stockUniverse.CSCO.fcffScenario.shares), sources.stocks.CSCO.defaults.shares,
      'Formatting source amounts must not round the underlying valuation shares');
    assert.match(await page.locator('#fcff-legacy').innerText(), /legacy target|legacy FCF/i);
    assert.equal(await page.locator('#fcff-table thead th').count(), baseline.periods.length + 1);
    assert.equal(await page.locator('#fcff-sensitivity .sens-base').innerText(), money(baseline.fairVal));
    assert.ok(!(await page.locator('#fcff-workspace').innerText()).match(/[\u3400-\u9fff]|NaN|undefined|Infinity/));
    assert.equal(await page.locator('#panel-general-dcf').isVisible(), false);
    assert.equal(await page.locator('#inp-fcf0').isVisible(), false);

    const browserResults = await page.evaluate(() => Object.fromEntries(Object.keys(window.FCFF_DATA.stocks)
      .map(ticker => {
        const result = Fcff.calculate(FCFF_DATA.stocks[ticker]);
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
    assert.equal(await page.locator('#fcff-beta').inputValue(), '-0.05');
    assert.equal(await page.locator('#det-res-fair').innerText(), fair);
    await page.evaluate(() => applyLanguage('en'));
    assert.equal(await page.locator('#fcff-beta').inputValue(), '-0.05');
    await page.locator('[onclick="saveCustomModel()"]').click();
    const stored = await page.evaluate(() => ({
      model: getSavedModels().CSCO,
      archive: JSON.parse(localStorage.getItem('M7_LEGACY_VALUATIONS')).CSCO
    }));
    assert.equal(stored.model.params.modelVersion, 'fcff-v2');
    assert.equal(stored.model.params.beta, -0.047);
    assert.equal(stored.model.params.tax, 0);
    assert.equal(stored.archive[0].params.fcf0, 999);
    await page.evaluate(() => { delete stockUniverse.CSCO.fcffScenario; loadDetailTicker('CSCO'); FmpModels.showLegacy(); });
    assert.equal(await page.locator('#fcff-beta').inputValue(), '-0.05');
    await page.locator('#fcff-input-controls summary').click();
    await page.locator('#fcff-beta').fill('-0.05');
    assert.equal(await page.evaluate(() => stockUniverse.CSCO.fcffScenario.beta), -0.05,
      'Explicitly entering the rounded displayed value replaces the previous full-precision scenario');
    await page.locator('[onclick="resetToFmpDefaults()"]').click();
    assert.equal(await page.locator('#det-res-fair').innerText(), money(baseline.fairVal));
    assert.equal(await page.evaluate(() => getSavedModels().CSCO), undefined);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('M7_LEGACY_VALUATIONS')).CSCO[0].targetPrice), 123);

    assert.equal(await page.locator('#fcff-driver-tabs button').count(), 7);
    assert.equal(await page.locator('#fcff-support-tabs button').count(), 7);
    const editedYear = baseline.annuals[1].end;
    const changedEbitda = baseline.annuals[1].ebitda + 100;
    await page.locator(`.fcff-year-input[data-end="${editedYear}"][data-key="ebitda"]`).fill(String(changedEbitda));
    await page.locator(`.fcff-year-input[data-end="${editedYear}"][data-key="ebitda"]`).blur();
    assert.equal(await page.locator('#det-res-fair').innerText(),
      money(calculate(sources.stocks.CSCO, { years: { [editedYear]: { ebitda: changedEbitda } } }).fairVal));
    await page.locator('#fcff-driver-tabs [data-tab="capex"]').click();
    const rate = page.locator(`.fcff-year-input[data-end="${editedYear}"][data-key="capexRate"]`);
    await rate.fill('0');
    await rate.blur();
    await page.locator('#fcff-driver-tabs [data-tab="workingCapital"]').click();
    const nwc = page.locator(`.fcff-year-input[data-end="${editedYear}"][data-key="workingCapitalRate"]`);
    await nwc.fill('-1');
    await nwc.blur();
    await page.locator('#fcff-driver-tabs [data-tab="tax"]').click();
    const tax = page.locator(`.fcff-year-input[data-end="${editedYear}"][data-key="tax"]`);
    await tax.fill('0');
    await tax.blur();
    await page.evaluate(() => { applyLanguage('zh'); applyLanguage('en'); });
    assert.equal(await page.locator(`.fcff-year-input[data-end="${editedYear}"][data-key="tax"]`).inputValue(), '0.00');
    const annualScenario = await page.evaluate(() => stockUniverse.CSCO.fcffScenario);
    assert.equal(annualScenario.years[editedYear].ebitda, changedEbitda);
    assert.equal(annualScenario.years[editedYear].capexRate, 0);
    assert.equal(annualScenario.years[editedYear].workingCapitalRate, -0.01);
    assert.equal(annualScenario.years[editedYear].tax, 0);
    assert.equal(await page.locator('#det-res-fair').innerText(), money(calculate(sources.stocks.CSCO, annualScenario).fairVal));
    for (const tab of ['revenue', 'capex', 'workingCapital', 'depreciation', 'tax']) {
      await page.locator(`#fcff-driver-tabs [data-tab="${tab}"]`).click();
      assert.deepEqual(await page.locator('#fcff-driver-detail input[type="number"]').evaluateAll(inputs =>
        inputs.filter(input => input.value !== '' && !/^-?\d+\.\d{2}$/.test(input.value))
          .map(input => input.getAttribute('aria-label'))), [], tab);
    }
    await page.locator('#fcff-support-tabs [data-tab="periods"]').click();
    const periodSchedule = await page.locator('#fcff-support-other').innerText();
    assert.ok(periodSchedule.includes(baseline.periods[0].discountDate));
    await page.locator('#fcff-support-tabs [data-tab="factors"]').click();
    const factorSchedule = await page.locator('#fcff-support-other').innerText();
    assert.notEqual(factorSchedule, periodSchedule);
    assert.match(factorSchedule, /WACC.*Discount exponent.*Discount factor.*FCFF.*Present value/s);
    const edited = calculate(sources.stocks.CSCO, annualScenario);
    assert.ok(factorSchedule.includes(edited.periods[0].df.toFixed(6)));
    assert.ok(factorSchedule.includes(edited.periods[0].pv.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })));
    await page.locator('#fcff-support-tabs [data-tab="history"]').click();
    assert.ok((await page.locator('#fcff-support-other').innerText()).includes('4 annual periods'));
    for (const tab of ['discount', 'terminal']) {
      await page.locator(`#fcff-driver-tabs [data-tab="${tab}"]`).click();
      assert.match(await page.locator('#fcff-driver-detail').innerText(), /Lower value.*Base.*Higher value/s);
    }
    await page.locator('#fcff-terminalMethod').selectOption('components');
    await page.locator('#fcff-discountTiming').selectOption('periodEnd');
    await page.locator('#fcff-input-controls summary').click();
    await page.locator('#fcff-discountRate').fill('9');
    await page.locator('#fcff-terminalEbitdaMargin').fill('30');
    await page.locator('#fcff-terminalCapex').fill('0');
    const componentScenario = await page.evaluate(() => stockUniverse.CSCO.fcffScenario);
    assert.equal(componentScenario.discountRate, 0.09);
    assert.equal(componentScenario.terminalEbitdaMargin, 0.3);
    assert.equal(componentScenario.terminalCapex, 0);
    assert.equal(componentScenario.discountTiming, 'periodEnd');
    assert.match(await page.locator('#fcff-terminal-note').innerText(), /Warning: growth is positive/);
    assert.equal(await page.locator('#det-res-fair').innerText(), money(calculate(sources.stocks.CSCO, componentScenario).fairVal));
    await page.locator('[onclick="saveCustomModel()"]').click();
    await page.evaluate(() => { delete stockUniverse.CSCO.fcffScenario; loadDetailTicker('CSCO'); FmpModels.showLegacy(); });
    assert.deepEqual(await page.evaluate(() => getSavedModels().CSCO.params.years), annualScenario.years);
    await page.locator('[onclick="resetToFmpDefaults()"]').click();
    assert.equal(await page.locator('#fcff-terminalMethod').inputValue(), 'roic');
    await page.locator('#fcff-driver-tabs [data-tab="capex"]').click();
    const observedRatios = sources.stocks.CSCO.history.annual.filter(row => Number.isFinite(row.capex) && row.revenue > 0)
      .map(row => row.capex / row.revenue);
    const historicalMean = observedRatios.reduce((sum, value) => sum + value, 0) / observedRatios.length;
    await page.locator('#fcff-driver-detail p button').click();
    assert.equal(await page.locator('#fcff-capex').inputValue(), (historicalMean * 100).toFixed(2));
    assert.ok(Math.abs(await page.evaluate(() => stockUniverse.CSCO.fcffScenario.capex) - historicalMean) < 1e-12);
    assert.equal(await page.locator('#det-res-fair').innerText(), money(calculate(sources.stocks.CSCO, { capex: historicalMean }).fairVal));
    await page.locator('[onclick="resetToFmpDefaults()"]').click();
    await page.locator('#fcff-driver-tabs [data-tab="revenue"]').click();
    await page.locator('#fcff-support-tabs [data-tab="cashflow"]').click();

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
    assert.equal(await page.locator('#fcff-table thead th').count(), 11, 'Valid operating projections remain visible when capital inputs are missing');
    await page.locator('[onclick="resetToFmpDefaults()"]').click();
    assert.equal(await page.locator('#det-res-fair').innerText(), money(baseline.fairVal));
    await page.locator('#fcff-input-controls summary').click();
    await page.locator('#fcff-preferred').fill('1000000000');
    assert.ok((await page.locator('#det-res-fair').innerText()).startsWith('$-'));
    assert.ok((await page.locator('#det-res-fair').getAttribute('class')).includes('text-red'));
    assert.equal(await page.locator('#det-res-premium').innerText(), 'N/A');
    await page.evaluate(() => openDetail('JPM'));
    assert.ok((await page.locator('#det-res-fair').getAttribute('class')).includes('text-green'));
    await page.evaluate(() => { openDetail('CSCO'); FmpModels.showLegacy(); });
    await page.locator('[onclick="resetToFmpDefaults()"]').click();
    for (const ticker of ['NVDA', 'TSM', 'BRK.B']) {
      await page.evaluate(ticker => { openDetail(ticker); FmpModels.showLegacy(); }, ticker);
      assert.equal(await page.locator('#det-res-fair').innerText(), 'N/A', ticker);
      assert.equal(await page.locator('[onclick="saveCustomModel()"]').isDisabled(), true);
      assert.ok(await page.locator('#fcff-status').innerText());
      assert.equal(await page.locator('#fcff-sensitivity td').innerText(), 'N/A');
      if (ticker === 'NVDA' || ticker === 'TSM') {
        assert.equal(await page.locator('#fcff-table thead th').count(), 11,
          'Available operating projections remain visible without certifying lease-adjusted valuation');
      }
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
