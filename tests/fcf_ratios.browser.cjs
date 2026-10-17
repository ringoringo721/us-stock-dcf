const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { calculate, calculateReturns, calculateBalances, calculateEarnings, financialReference, trend } = require('../fcf_ratios.js');

const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:8765';

async function checkBalances(page, ticker, period = 'quarterly') {
  await page.waitForFunction(ticker => document.querySelector('#balance-status').textContent.startsWith(ticker)
    && document.querySelector('#balance-body').children.length === 9, ticker);
  const data = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'financials', `${ticker}_statements_v2.json`), 'utf8'));
  const columns = calculateBalances(data, { period });
  assert.equal(await page.locator('#balance-head th').count(), columns.length + 1);
  assert.equal(await page.locator('#balance-date option').count(), columns.length);
  const selectedIndex = Number(await page.locator('#balance-date').inputValue());
  const selected = columns[selectedIndex];
  const locale = await page.locator('html').getAttribute('lang') === 'en' ? 'en-US' : 'zh-TW';
  const format = result => result.value === null ? 'N/A'
    : `${(result.value / 1e6).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${result.warnings.length ? ' !' : ''}`;
  for (const [i, metric] of Object.keys(selected.amounts).entries()) {
    const row = page.locator('#balance-body tr').nth(i);
    assert.deepEqual(await row.locator('td').allTextContents(), columns.map(column => format(column.amounts[metric])));
    const titles = await row.locator('td').evaluateAll(cells => cells.map(cell => cell.title));
    assert.ok(titles.every(title => !title.includes('undefined')));
  }
  assert.deepEqual(await page.locator('#balance-cards strong').allTextContents(),
    ['assets', 'liabilities', 'equity', 'cash'].map(metric => format(selected.amounts[metric])));
  assert.equal(await page.locator('#balance-head .balance-selected').count(), 1);
  if (await page.locator('#balance-table-wrap').isVisible()) {
    const bounds = await page.locator('#balance-table-wrap').evaluate(box => ({
      right: box.getBoundingClientRect().right,
      sticky: box.querySelector('.table-sticky-col').getBoundingClientRect().right,
      selected: box.querySelector('.balance-selected').getBoundingClientRect().toJSON()
    }));
    assert.ok(bounds.selected.right <= bounds.right + 2 && bounds.selected.left >= bounds.sticky - 2,
      'The selected statement column is revealed next to the sticky labels');
  }
  if (await page.locator('#balance-chart-wrap').isVisible()) {
    const series = await page.locator('#balance-chart').evaluate(canvas =>
      Chart.getChart(canvas).data.datasets.map(series => series.data));
    assert.deepEqual(series, ['assets', 'liabilities', 'equity'].map(metric => columns.map(column =>
      column.currency === selected.currency && column.amounts[metric].value !== null
        ? column.amounts[metric].value / 1e6 : null)));
  }
}

async function checkTable(page, ticker, options, prefix = 'fcf-ratio') {
  const returns = prefix === 'return-ratio';
  const metrics = returns ? ['roa', 'roe', 'rote'] : ['equity', 'assets', 'sales', 'ebitda', 'netIncome'];
  await page.waitForFunction(({ prefix, count }) => document.querySelector(`#${prefix}-body`).children.length === count,
    { prefix, count: metrics.length });
  const source = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'financials', `${ticker}_statements_v2.json`), 'utf8'));
  const columns = (returns ? calculateReturns : calculate)(source, options);
  const headings = await page.locator(`#${prefix}-head th`).allTextContents();
  assert.equal(headings.length, columns.length + 2);
  for (let i = 0; i < columns.length; i++) {
    assert.ok(headings[i + 1].includes(columns[i].label));
    assert.ok(headings[i + 1].includes(columns[i].date));
  }
  for (const [i, metric] of metrics.entries()) {
    const expected = columns.map(column => {
      const ratio = column.ratios[metric];
      return ratio.value === null ? 'N/A' : `${ratio.value.toFixed(2)}%${ratio.warnings.length ? ' !' : ''}`;
    });
    const row = page.locator(`#${prefix}-body tr`).nth(i);
    assert.deepEqual(await row.locator('td:not(.fcf-trend-col)').allTextContents(), expected);
    const titles = await row.locator('td:not(.fcf-trend-col)').evaluateAll(cells => cells.map(cell => cell.title));
    columns.forEach((column, index) => {
      const ratio = column.ratios[metric];
      if (ratio.reason || ratio.warnings.length) assert.ok(titles[index] && !titles[index].includes('undefined'));
    });
    const spark = trend(columns.map(column => column.ratios[metric].value));
    assert.equal(await row.locator('.fcf-trend-col svg').count(), spark ? 1 : 0);
    if (spark) {
      assert.equal(await row.locator('.fcf-trend-col path').count(), spark.segments.length);
      assert.equal(await row.locator('.fcf-trend-col circle').getAttribute('fill'), spark.color);
    }
  }
}

async function checkEarnings(page, ticker, period = 'quarterly', flow = 'ttm') {
  await page.waitForFunction(ticker => document.querySelector('#earnings-status').textContent.startsWith(ticker)
    && document.querySelector('#earnings-body').children.length === 3, ticker);
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'financials', `${ticker}_statements_v2.json`), 'utf8'));
  const columns = calculateEarnings(data, { period, flow });
  assert.equal(await page.locator('#earnings-head th').count(), columns.length + 1);
  const locale = await page.locator('html').getAttribute('lang') === 'en' ? 'en-US' : 'zh-TW';
  for (const [index, metric] of ['eps', 'fcf', 'dividend'].entries()) {
    assert.deepEqual(await page.locator('#earnings-body tr').nth(index).locator('td').allTextContents(),
      columns.map(column => column.amounts[metric].value === null ? 'N/A'
        : column.amounts[metric].value.toLocaleString(locale, {
          minimumFractionDigits: 2, maximumFractionDigits: metric === 'dividend' ? 4 : 2
        })));
  }
  assert.ok(!(await page.locator('#earnings-notes').innerText()).includes('undefined'));
  if (await page.locator('#earnings-chart-wrap').isVisible()) {
    const selected = columns[Number(await page.locator('#earnings-date').inputValue())];
    assert.deepEqual(await page.locator('#earnings-chart').evaluate(canvas =>
      Chart.getChart(canvas).data.datasets.map(series => series.data)),
    ['eps', 'fcf', 'dividend'].map(metric => columns.map(column =>
      column.currency !== selected.currency || column.amounts[metric].value === null ? null
        : column.amounts[metric].value)));
    assert.deepEqual(await page.locator('#earnings-chart').evaluate(canvas => Object.keys(Chart.getChart(canvas).options.scales).sort()),
      ['x', 'y'], 'All three metrics share one per-diluted-share axis');
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {})
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    const firstPartyFailures = [];
    const statementRequests = [];
    page.on('request', request => {
      if (request.url().includes('_statements_v2.json')) statementRequests.push(request.url());
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.status() >= 400 && response.url().startsWith(baseUrl)) {
        firstPartyFailures.push(`${response.status()} ${response.url()}`);
      }
    });
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#screener-tbody').children.length > 0);
    const stockCount = await page.evaluate(() => Object.keys(window.FULL_MARKET_DATA).length);
    assert.ok(stockCount > 0);
    assert.equal(await page.locator('#screener-tbody tr').count(), stockCount);
    assert.ok((await page.locator('#stat-total').innerText()).includes(String(stockCount)));
    const initialTickers = await page.locator('#screener-tbody .ticker-link').allTextContents();
    for (const [preset, count] of [['overview', 9], ['valuation', 16], ['financial', 19], ['all', 33]]) {
      await page.selectOption('#screener-columns', preset);
      assert.equal(await page.locator('#screener-table thead th:visible').count(), count);
      assert.equal(await page.locator('#screener-tbody tr').first().locator('td:visible').count(), count);
      assert.deepEqual(await page.locator('#screener-tbody .ticker-link').allTextContents(), initialTickers);
    }
    await page.selectOption('#screener-columns', 'overview');
    const overviewFits = await page.locator('#main-scroll-box').evaluate(box =>
      box.scrollWidth <= box.clientWidth + 1);
    assert.ok(overviewFits, 'Essential overview fits on a desktop without a 4,280px table');
    await page.locator('#screener-table th[onclick="sortTable(\'price\')"]').click();
    const priceOrder = await page.locator('#screener-tbody .ticker-link').allTextContents();
    assert.ok(await page.evaluate(tickers => tickers.every((ticker, i) =>
      i === 0 || stockUniverse[ticker].price <= stockUniverse[tickers[i - 1]].price), priceOrder));
    await page.selectOption('#screener-columns', 'financial');
    assert.deepEqual(await page.locator('#screener-tbody .ticker-link').allTextContents(), priceOrder);
    await page.selectOption('#screener-columns', 'overview');
    await page.locator('button[onclick="toggleFavorite(\'NVDA\', event)"]').click();
    await page.locator('#val-filters button[onclick="setValFilter(\'FAVORITES\')"]').click();
    assert.deepEqual(await page.locator('#screener-tbody .ticker-link').allTextContents(), ['NVDA']);
    await page.locator('button[onclick="resetScreenerFilters()"]').click();
    await page.locator('button[onclick="toggleFavorite(\'NVDA\', event)"]').click();
    await page.locator('#search-ticker').fill('NVDA');
    assert.equal(await page.locator('#screener-tbody tr').count(), 1);
    await page.locator('#search-ticker').fill('NO_MATCH_12345');
    assert.equal(await page.locator('#screener-tbody tr').count(), 0);
    assert.ok((await page.locator('#screener-results').innerText()).length > 0);
    await page.locator('button[onclick="resetScreenerFilters()"]').click();
    assert.equal(await page.locator('#screener-tbody tr').count(), stockCount);
    await page.locator('.screener-industries summary').click();
    for (const [lang, width] of ['zh', 'en'].flatMap(lang => [390, 768, 1440, 1920].map(width => [lang, width]))) {
      await page.evaluate(lang => applyLanguage(lang), lang);
      await page.setViewportSize({ width, height: 1080 });
      const alignment = await page.locator('.screener-industries').evaluate(panel => {
        const rows = [...panel.querySelectorAll('.filter-row')];
        const rect = element => element.getBoundingClientRect();
        return rows.map(row => ({
          label: rect(row.querySelector('.filter-title')).toJSON(),
          grid: rect(row.querySelector('.filter-btns')).toJSON(),
          buttons: [...row.querySelectorAll('button')].map(button => ({
            ...rect(button).toJSON(), fits: button.scrollWidth <= button.clientWidth + 1
              && button.scrollHeight <= button.clientHeight + 1
          }))
        }));
      });
      assert.ok(Math.abs(alignment[0].grid.left - alignment[1].grid.left) < 1,
        'Sector and industry grids start on the same vertical line');
      assert.ok(Math.abs(alignment[0].grid.width - alignment[1].grid.width) < 1);
      for (const row of alignment) {
        const widths = row.buttons.map(button => button.width);
        const heights = row.buttons.map(button => button.height);
        assert.ok(Math.max(...widths) - Math.min(...widths) < 1, 'Filter buttons share equal column widths');
        assert.ok(Math.max(...heights) - Math.min(...heights) < 1, 'Filter button rows share equal heights');
        assert.ok(row.buttons.every(button => button.fits), 'Long bilingual industry labels stay within their buttons');
        if (width > 600) assert.ok(row.label.top < row.grid.top + 18,
          'Multi-row industry labels align at the top instead of the vertical center');
      }
      assert.ok(Math.abs(alignment[0].buttons[0].width - alignment[1].buttons[0].width) < 1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await page.evaluate(() => applyLanguage('zh'));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#sector-filters button').nth(1).click();
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('#screener-tbody .ticker-link')]
      .every(link => stockUniverse[link.textContent].sector === currentSectorFilter)), true);
    await page.locator('#subindustry-filters button').nth(1).click();
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('#screener-tbody .ticker-link')]
      .every(link => stockUniverse[link.textContent].industry === currentSubIndustryFilter)), true);
    await page.locator('button[onclick="resetScreenerFilters()"]').click();
    await page.locator('.screener-industries summary').click();
    await page.selectOption('#screener-columns', 'all');
    for (const lang of ['en', 'zh', 'en', 'zh']) {
      await page.evaluate(lang => applyLanguage(lang), lang);
      assert.equal(await page.locator('#screener-table thead .screener-heading').count(), 33);
      const headers = await page.locator('#screener-table thead th').evaluateAll(cells => cells.map(cell => {
        const heading = cell.querySelector('.screener-heading');
        const label = heading.querySelector('.screener-heading-label');
        const rect = label.getBoundingClientRect();
        const box = cell.getBoundingClientRect();
        return {
          height: box.height, labelTop: rect.top, center: getComputedStyle(cell).textAlign,
          fits: label.scrollWidth <= label.clientWidth + 1, children: heading.children.length,
          infoTop: heading.querySelector('.info-circle-btn')?.getBoundingClientRect().top
        };
      }));
      assert.ok(headers.every(header => header.height === headers[0].height && header.center === 'center'));
      assert.ok(headers.every(header => header.children === 2 && header.fits),
        'All headers keep one aligned label area and one aligned unit/info area');
      const info = headers.filter(header => header.infoTop !== undefined);
      assert.equal(info.length, 3);
      assert.ok(Math.max(...info.map(header => header.infoTop)) - Math.min(...info.map(header => header.infoTop)) < 1);
      const values = await page.locator('#screener-tbody .liquidation-value').evaluateAll(cells => cells.map(cell => ({
        value: Number(cell.textContent.replace(/[$,\s]/g, '')),
        positive: cell.classList.contains('text-green'), negative: cell.classList.contains('text-red'),
        neutral: cell.classList.contains('text-muted')
      })));
      assert.equal(values.length, stockCount * 3);
      assert.ok(values.every(cell => cell.value > 0 ? cell.positive : cell.value < 0 ? cell.negative : cell.neutral));
      assert.ok(await page.locator('#screener-liquidation-key').isVisible());
    }
    const priorLiquidation = await page.evaluate(() => {
      const fields = ['liq_val_1', 'liq_val_2', 'liq_val_3'];
      const original = fields.map(field => stockUniverse.NVDA[field]);
      fields.forEach((field, i) => { stockUniverse.NVDA[field] = [12.34, -5.67, 0][i]; });
      renderScreenerTable();
      return original;
    });
    const nvdaValues = page.locator('#screener-tbody tr').filter({ has: page.locator('a[onclick="openCompanyProfile(\'NVDA\')"]') })
      .locator('.liquidation-value');
    assert.deepEqual((await nvdaValues.allTextContents()).map(text => text.trim()), ['$12.34', '-$5.67', '$0.00']);
    assert.deepEqual(await nvdaValues.evaluateAll(cells => cells.map(cell => cell.className)),
      ['liquidation-value text-green', 'liquidation-value text-red', 'liquidation-value text-muted']);
    await page.evaluate(original => {
      ['liq_val_1', 'liq_val_2', 'liq_val_3'].forEach((field, i) => { stockUniverse.NVDA[field] = original[i]; });
      renderScreenerTable();
    }, priorLiquidation);
    await page.locator('#main-scroll-box').evaluate(box => { box.scrollLeft = 1500; });
    const formulaInfo = page.locator('#screener-table .info-circle-btn').nth(1);
    await formulaInfo.focus();
    assert.equal(await formulaInfo.locator('.tooltip-box').evaluate(node => getComputedStyle(node).visibility), 'visible');
    await page.keyboard.press('Tab');
    await page.evaluate(() => SiteTheme.set('light'));
    const rowCell = page.locator('#screener-tbody tr').nth(1).locator('.liquidation-value').nth(1);
    await rowCell.hover();
    const hoverStyles = await rowCell.evaluate(cell => {
      const row = cell.closest('tr');
      const background = getComputedStyle(cell).backgroundColor;
      return {
        background, stickyBackground: getComputedStyle(row.cells[0]).backgroundColor,
        border: getComputedStyle(cell).boxShadow, cursor: getComputedStyle(cell).cursor,
        normal: getComputedStyle(row.nextElementSibling.cells[16]).backgroundColor
      };
    });
    assert.equal(hoverStyles.background, 'rgb(219, 234, 254)');
    assert.equal(hoverStyles.stickyBackground, hoverStyles.background);
    assert.notEqual(hoverStyles.normal, hoverStyles.background);
    assert.notEqual(hoverStyles.border, 'none');
    assert.match(hoverStyles.cursor, /data:image\/svg\+xml/);
    const cursorImage = await rowCell.evaluate(async cell => {
      const source = getComputedStyle(cell).cursor.match(/url\("([^"]+)"\)/)[1];
      const image = new Image();
      image.src = source;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    });
    assert.deepEqual(cursorImage, { width: 32, height: 32 }, 'High-contrast cursor SVG loads as a valid cursor image');
    await page.mouse.down();
    assert.match(await rowCell.evaluate(cell => getComputedStyle(cell).cursor), /16 16.*grabbing/);
    await page.mouse.up();
    await page.evaluate(() => SiteTheme.set('dark'));
    assert.doesNotMatch(await rowCell.evaluate(cell => getComputedStyle(cell).cursor), /data:image\/svg\+xml/);
    await page.selectOption('#screener-columns', 'overview');
    assert.equal(await page.locator('#screener-liquidation-key').isVisible(), false);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `Homepage must not overflow the viewport at ${width}px`);
    }
    for (const ticker of ['NVDA', 'AAPL', 'JPM', 'DE', 'HD', 'PFE', 'PGR', 'AZO', 'TSM']) {
      await page.evaluate(() => showView('screener', false));
      await page.locator(`a[onclick="openCompanyProfile('${ticker}')"]`).click();
      assert.equal(await page.locator('#fcf-ratio-panel').isVisible(), false);
      await page.locator('button[onclick="switchSubPage(\'charts\')"]').click();
      await page.waitForFunction(ticker => document.querySelector('#fcf-ratio-status').textContent.startsWith(ticker), ticker);
      assert.equal(await page.locator('#cmp-ticker').innerText(), ticker);
      assert.equal(await page.locator('#company-view #subpage-charts #fcf-ratio-panel').count(), 1);
      assert.equal(await page.locator('#detail-view #fcf-ratio-panel').count(), 0);
      await checkTable(page, ticker, {});
      await checkTable(page, ticker, {}, 'return-ratio');
      await checkBalances(page, ticker);
      if (ticker === 'AZO') assert.match(await page.locator('#balance-cards strong').nth(2).innerText(), /^-/);
      if (ticker === 'TSM') assert.match(await page.locator('#balance-status').innerText(), /TWD/);
      assert.equal(await page.locator('#subpage-ratios #balance-panel').count(), 0);
      assert.equal(await page.locator('#ratioReturnChart').count(), 0);
      assert.equal(await page.locator('#ratioAssetChart').count(), 0);
      assert.equal(await page.locator('#detail-view #return-ratio-panel').count(), 0);
      assert.equal(statementRequests.filter(url => url.endsWith(`/${ticker}_statements_v2.json`)).length, 1,
        'Both panels share one statement request per ticker');
    }
    await page.evaluate(() => openCompanyProfile('NVDA'));
    assert.deepEqual(await page.locator('.sub-tab-btn').evaluateAll(buttons => buttons.map(button => button.getAttribute('onclick'))),
      ['basic', 'rating', 'financials', 'ratios', 'peers', 'charts', 'news', 'chart'].map(key => `switchSubPage('${key}')`));
    assert.equal(await page.locator('#subpage-dividend').count(), 0);
    assert.equal(await page.locator('#moat-total-score').isVisible(), false);
    assert.equal(await page.locator('#fscore-breakdown-body').isVisible(), false);
    for (const ticker of ['NVDA', 'JPM']) {
      await page.evaluate(ticker => openMoat(ticker), ticker);
      assert.equal(await page.locator('#subpage-rating').isVisible(), true);
      assert.equal(await page.locator('#moat-ticker').innerText(), ticker);
      assert.equal(await page.locator('#fsc-ticker').innerText(), ticker);
      assert.equal(await page.locator('#moat-breakdown-body tr').count(), 10);
      assert.equal(await page.locator('#fscore-breakdown-body tr').count(), 9);
      assert.equal(await page.locator('#subpage-rating #moat-breakdown-body').count(), 1);
      assert.equal(await page.locator('#subpage-rating #fscore-breakdown-body').count(), 1);
      assert.equal(await page.locator('#moat-total-score').isVisible(), true);
      assert.equal(await page.locator('#fscore-breakdown-body').isVisible(), true);
      assert.match(await page.locator('#fsc-header-sub').innerText(), /PF score/);
      const ratingScore = await page.evaluate(ticker => stockUniverse[ticker].f_score, ticker);
      const ratingClass = ratingScore >= 7 ? 'fscore-green' : ratingScore >= 4 ? 'fscore-yellow' : 'fscore-red';
      assert.ok((await page.locator('#fsc-health-level').getAttribute('class')).includes(ratingClass));
      assert.ok((await page.locator('#fsc-health-comment').innerText()).includes(ticker));
      await page.evaluate(() => toggleLanguage());
      assert.equal(await page.locator('#subpage-rating').isVisible(), true);
      assert.equal(await page.locator('#fsc-ticker').innerText(), ticker);
      assert.ok(!(await page.locator('#fsc-health-comment').innerText()).includes('undefined'));
      await page.evaluate(() => toggleLanguage());
    }
    const originalRating = await page.evaluate(() => ({
      score: stockUniverse.NVDA.f_score, details: stockUniverse.NVDA.f_score_breakdown, lang: currentLang
    }));
    for (const score of [0, 3, 4, 6, 7, 8, 9]) {
      await page.evaluate(score => {
        stockUniverse.NVDA.f_score = score;
        stockUniverse.NVDA.f_score_breakdown = Array.from({ length: 9 }, (_, i) => ({
          id: i + 1, category: i < 4 ? '盈利能力' : i < 7 ? '槓桿與償債' : '營運效率',
          passed: i < score ? 1 : 0, desc: `檢驗 ${i + 1}`, detail: 'Test data'
        }));
        openFScore('NVDA');
      }, score);
      for (const lang of ['zh', 'en']) {
        await page.evaluate(lang => applyLanguage(lang), lang);
        const level = score >= 7 ? 'strong' : score >= 4 ? 'moderate' : 'weak';
        assert.equal(await page.locator('#fsc-health-level').innerText(),
          await page.evaluate(level => I18N_DICT[currentLang][`fsc_health_${level}`], level));
        const comment = await page.locator('#fsc-health-comment').innerText();
        assert.ok(comment.includes('NVDA'));
        assert.equal(comment.includes(lang === 'en' ? 'Review these failed tests:' : '待留意（未通過）：'), score < 9);
        assert.equal(comment.includes(lang === 'en' ? 'Passed tests:' : '已通過：'), score > 0);
        if (lang === 'en') assert.ok(!/[\u3400-\u9fff]/.test(comment));
      }
    }
    await page.evaluate(() => {
      stockUniverse.NVDA.f_score_breakdown = [];
      loadFScoreView('NVDA');
    });
    assert.match(await page.locator('#fsc-health-comment').innerText(), /incomplete/);
    await page.evaluate(() => { stockUniverse.NVDA.f_score_breakdown = [null]; loadFScoreView('NVDA'); });
    assert.match(await page.locator('#fsc-health-comment').innerText(), /incomplete/);
    await page.evaluate(() => { stockUniverse.NVDA.f_score = null; loadFScoreView('NVDA'); });
    assert.equal(await page.locator('#fsc-total-score').innerText(), 'N/A');
    assert.match(await page.locator('#fsc-health-level').innerText(), /Insufficient/);
    await page.evaluate(original => {
      stockUniverse.NVDA.f_score = original.score;
      stockUniverse.NVDA.f_score_breakdown = original.details;
      applyLanguage(original.lang);
      openFScore('NVDA');
    }, originalRating);
    if (process.env.UI_SCREENSHOT_DIR) {
      await page.locator('#subpage-rating').screenshot({ path: path.join(process.env.UI_SCREENSHOT_DIR, 'company-rating.png') });
    }
    await page.evaluate(() => openCompanyProfile('NVDA'));
    await page.locator('button[onclick="switchSubPage(\'charts\')"]').click();
    await page.waitForFunction(() => document.querySelector('#fcf-ratio-status').textContent.startsWith('NVDA'));
    assert.equal(await page.locator('#moat-total-score').isVisible(), false);
    assert.equal(await page.locator('#fscore-breakdown-body').isVisible(), false);
    assert.ok(await page.evaluate(() => document.querySelector('#earnings-panel').getBoundingClientRect().top
      >= document.querySelector('#balance-panel').getBoundingClientRect().bottom));
    for (const period of ['quarterly', 'annual']) {
      await page.selectOption('#earnings-period', period);
      assert.equal(await page.locator('#earnings-flow').isDisabled(), period === 'annual');
      for (const flow of period === 'annual' ? ['ttm'] : ['single', 'ttm']) {
        if (period === 'quarterly') await page.selectOption('#earnings-flow', flow);
        for (const view of ['table', 'chart']) {
          await page.selectOption('#earnings-view', view);
          await checkEarnings(page, 'NVDA', period, flow);
        }
        await page.selectOption('#earnings-date', '0');
        await checkEarnings(page, 'NVDA', period, flow);
        assert.equal(await page.locator('#earnings-date').inputValue(), '0');
      }
    }
    await page.selectOption('#earnings-period', 'quarterly');
    for (const ticker of ['DE', 'HD', 'PFE', 'PGR', 'TSM', 'NVDA']) {
      await page.evaluate(ticker => { openCompanyProfile(ticker); switchSubPage('charts'); }, ticker);
      await checkEarnings(page, ticker);
    }
    await page.evaluate(() => toggleLanguage());
    await checkEarnings(page, 'NVDA');
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.selectOption('#earnings-view', 'table');
      await checkEarnings(page, 'NVDA');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        'Earnings table remains within the page and scrolls internally');
      if (process.env.UI_SCREENSHOT_DIR) {
        await page.locator('#earnings-panel').screenshot({ path: path.join(process.env.UI_SCREENSHOT_DIR, `earnings-${width}.png`) });
      }
    }
    await page.selectOption('#earnings-view', 'chart');
    await page.evaluate(() => toggleLanguage());
    await checkEarnings(page, 'NVDA');
    const beforeBalance = await page.locator('#return-ratio-body').textContent();
    for (const period of ['annual', 'quarterly']) {
      await page.selectOption('#balance-period', period);
      await checkBalances(page, 'NVDA', period);
      await page.selectOption('#balance-view', 'table');
      await checkBalances(page, 'NVDA', period);
      await page.selectOption('#balance-view', 'chart');
      await checkBalances(page, 'NVDA', period);
      await page.selectOption('#balance-date', '0');
      await checkBalances(page, 'NVDA', period);
      assert.equal(await page.locator('#balance-date').inputValue(), '0');
      for (const view of ['table', 'chart']) {
        await page.selectOption('#balance-view', view);
        await checkBalances(page, 'NVDA', period);
        assert.equal(await page.locator('#balance-table-wrap').isVisible(), view === 'table');
        assert.equal(await page.locator('#balance-chart-wrap').isVisible(), view === 'chart');
        assert.equal(await page.locator('#balance-date').inputValue(), '0', 'View changes preserve the selected report date');
      }
      assert.equal(await page.locator('#return-ratio-body').textContent(), beforeBalance);
    }
    const panelsOrdered = await page.evaluate(() => document.querySelector('#balance-panel').getBoundingClientRect().top
      >= document.querySelector('#return-ratio-panel').getBoundingClientRect().bottom);
    assert.ok(panelsOrdered);
    for (const period of ['quarterly', 'annual']) {
      await page.selectOption('#fcf-ratio-period', period);
      assert.equal(await page.locator('#fcf-ratio-flow').isDisabled(), period === 'annual');
      for (const flow of period === 'quarterly' ? ['single', 'ttm'] : ['ttm']) {
        if (period === 'quarterly') await page.selectOption('#fcf-ratio-flow', flow);
        for (const balance of ['beginning', 'ending', 'average']) {
          await page.selectOption('#fcf-ratio-balance', balance);
          await checkTable(page, 'NVDA', { period, flow, balance });
        }
      }
    }
    const fcfBeforeReturns = await page.locator('#fcf-ratio-body').textContent();
    assert.equal(await page.locator('#return-ratio-period').inputValue(), 'quarterly');
    assert.equal(await page.locator('#return-ratio-flow').inputValue(), 'ttm');
    assert.equal(await page.locator('#return-ratio-balance').inputValue(), 'beginning');
    const placement = await page.evaluate(() => ({
      fcfBottom: document.querySelector('#fcf-ratio-panel').getBoundingClientRect().bottom,
      returnsTop: document.querySelector('#return-ratio-panel').getBoundingClientRect().top
    }));
    assert.ok(placement.returnsTop >= placement.fcfBottom, 'Returns table appears below FCF table');
    assert.equal(await page.locator('#return-ratio-roic').count(), 0);
    for (const period of ['quarterly', 'annual']) {
      await page.selectOption('#return-ratio-period', period);
      assert.equal(await page.locator('#return-ratio-flow').isDisabled(), period === 'annual');
      for (const flow of period === 'quarterly' ? ['single', 'ttm'] : ['ttm']) {
        if (period === 'quarterly') await page.selectOption('#return-ratio-flow', flow);
        for (const balance of ['beginning', 'ending', 'average']) {
          await page.selectOption('#return-ratio-balance', balance);
          await checkTable(page, 'NVDA', { period, flow, balance }, 'return-ratio');
          assert.equal(await page.locator('#fcf-ratio-body').textContent(), fcfBeforeReturns);
        }
      }
    }
    for (const metric of ['roa', 'roe', 'rote']) await page.uncheck(`#return-ratio-${metric}`);
    assert.equal(await page.locator('#return-ratio-body tr').count(), 0);
    assert.equal(await page.locator('#return-ratio-balance').isDisabled(), true);
    await page.check('#return-ratio-rote');
    await page.waitForFunction(() => document.querySelector('#return-ratio-body').children.length === 1);
    assert.ok((await page.locator('#return-ratio-body tr th').innerText()).includes('ROTE'));
    assert.equal(await page.locator('#return-ratio-balance').isDisabled(), false);
    await page.check('#return-ratio-roa');
    await page.check('#return-ratio-roe');
    await checkTable(page, 'NVDA', { period: 'annual', flow: 'ttm', balance: 'average' }, 'return-ratio');
    await checkBalances(page, 'NVDA');
    await page.locator('#btn-theme-toggle').click();
    await checkBalances(page, 'NVDA');
    assert.equal(await page.locator('#balance-chart').evaluate(canvas => Chart.getChart(canvas).data.datasets[0].borderColor),
      await page.evaluate(() => SiteTheme.color('--accent')));
    await page.locator('#btn-theme-toggle').click();
    for (const metric of ['equity', 'assets', 'sales', 'ebitda', 'netIncome']) {
      await page.uncheck(`#fcf-ratio-${metric}`);
    }
    assert.equal(await page.locator('#fcf-ratio-body tr').count(), 0);
    assert.ok((await page.locator('#fcf-ratio-status').innerText()).length > 0);
    await page.check('#fcf-ratio-netIncome');
    await page.waitForFunction(() => document.querySelector('#fcf-ratio-body').children.length === 1);
    assert.equal(await page.locator('#fcf-ratio-balance').isDisabled(), true);
    assert.ok((await page.locator('#fcf-ratio-body tr th').innerText()).includes('淨利'));
    await page.check('#fcf-ratio-sales');
    await page.check('#fcf-ratio-equity');
    assert.equal(await page.locator('#fcf-ratio-balance').isDisabled(), false);
    await page.check('#fcf-ratio-assets');
    await page.check('#fcf-ratio-ebitda');
    await page.locator('#btn-lang-toggle').click();
    await page.waitForFunction(() => document.querySelector('#fcf-ratio-body tr th').textContent === 'FCF / Equity');
    assert.equal(await page.locator('#fcf-ratio-title').innerText(), 'Free Cash Flow (FCF) Ratios');
    assert.equal(await page.locator('#fcf-ratio-body tr th').last().innerText(), 'FCF / Net Income');
    assert.equal(await page.locator('#return-ratio-title').innerText(), 'Returns on Capital (ROA / ROE / ROTE)');
    await checkBalances(page, 'NVDA');
    assert.doesNotMatch(await page.locator('#balance-panel').innerText(), /[\u3400-\u9fff]/);
    assert.equal(await page.locator('#return-ratio-body tr th').last().innerText(), 'Return on Tangible Equity (ROTE)');
    await checkTable(page, 'NVDA', { period: 'annual', flow: 'ttm', balance: 'average' }, 'return-ratio');
    assert.equal(await page.locator('#subpage-charts').getAttribute('class'), 'subpage-content active');
    await page.locator('#btn-lang-toggle').click();
    await page.waitForFunction(() => document.querySelector('#fcf-ratio-body tr th').textContent.includes('股東權益'));
    const historical = await page.locator('#fcf-ratio-body').textContent();
    await page.locator('button[onclick="switchSubPage(\'basic\')"]').click();
    assert.equal(await page.locator('#fcf-ratio-panel').isVisible(), false);
    await page.locator('button[onclick="switchSubPage(\'charts\')"]').click();
    await checkTable(page, 'NVDA', { period: 'annual', flow: 'ttm', balance: 'average' });
    await checkTable(page, 'NVDA', { period: 'annual', flow: 'ttm', balance: 'average' }, 'return-ratio');
    for (const end of [false, true]) {
      const bounds = await page.locator('#fcf-ratio-panel .table-scroll-wrapper').evaluate((box, end) => {
        box.scrollLeft = end ? box.scrollWidth : 0;
        return {
          edge: box.getBoundingClientRect().right,
          trend: box.querySelector('tbody .fcf-trend-col').getBoundingClientRect().right
        };
      }, end);
      assert.ok(Math.abs(bounds.edge - bounds.trend) < 3, 'Trend remains pinned to the right edge');
    }
    assert.equal(await page.locator('#fcf-ratio-period').inputValue(), 'annual');
    assert.equal(await page.locator('#fcf-ratio-balance').inputValue(), 'average');
    const returnsBeforeDcf = await page.locator('#return-ratio-body').textContent();
    await page.evaluate(() => openDetail('NVDA'));
    assert.equal(await page.locator('#fcf-ratio-panel').isVisible(), false);
    assert.equal(await page.locator('#detail-view #fcf-ratio-panel').count(), 0);
    assert.equal(await page.locator('#det-ticker').getAttribute('type'), 'button');
    const originalFair = await page.locator('#det-res-fair').innerText();
    await page.locator('#inp-fcf0').fill('100');
    await page.waitForFunction(before => document.querySelector('#det-res-fair').textContent !== before, originalFair);
    assert.equal(await page.locator('#fcf-ratio-body').textContent(), historical);
    assert.equal(await page.locator('#return-ratio-body').textContent(), returnsBeforeDcf);
    assert.equal(await page.locator('#dcf-fcf td').count(), 11);
    assert.equal(await page.locator('#sens-body tr').count(), 3);
    assert.equal(await page.locator('#detailDcfHistoricalChart').count(), 0);
    await page.locator('#det-ticker').click();
    assert.equal(await page.locator('#company-view').isVisible(), true);
    assert.equal(await page.locator('#cmp-ticker').innerText(), 'NVDA');
    await page.locator('button[onclick="switchSubPage(\'charts\')"]').click();
    await checkTable(page, 'NVDA', { period: 'annual', flow: 'ttm', balance: 'average' });
    await page.setViewportSize({ width: 390, height: 844 });
    const widths = await page.locator('#fcf-ratio-panel .table-scroll-wrapper')
      .evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }));
    assert.ok(widths.scroll > widths.client, 'Historical columns scroll horizontally on narrow viewports');
    const returnWidths = await page.locator('#return-ratio-panel .table-scroll-wrapper')
      .evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }));
    assert.ok(returnWidths.scroll > returnWidths.client, 'Return columns scroll on mobile');
    await page.selectOption('#balance-view', 'table');
    await checkBalances(page, 'NVDA');
    assert.ok(await page.locator('#balance-panel').evaluate(panel =>
      panel.getBoundingClientRect().right <= innerWidth), 'Balance controls and cards fit on mobile');
    await page.selectOption('#balance-view', 'chart');
    await checkBalances(page, 'NVDA');
    const metricWidth = await page.locator('#return-ratio-body th').first()
      .evaluate(node => node.getBoundingClientRect().width);
    assert.ok(metricWidth <= 155 && returnWidths.client - metricWidth >= 125,
      'Mobile metric labels must leave room for a complete numeric column');
    assert.equal(await page.locator('#return-ratio-table .fcf-trend-col').first()
      .evaluate(node => getComputedStyle(node).position), 'static');
    assert.equal(await page.locator('#chart-bars-wrap').count(), 0);
    for (const width of [390, 1024, 1822]) {
      await page.setViewportSize({ width, height: 1000 });
      const layout = await page.locator('.subpage-nav-bar').evaluate(nav => {
        const box = nav.getBoundingClientRect();
        return {
          overflow: nav.scrollWidth > nav.clientWidth,
          buttons: [...nav.querySelectorAll('button')].map(button => {
            const rect = button.getBoundingClientRect();
            return rect.left >= box.left && rect.right <= box.right + 1 && rect.bottom <= box.bottom + 1;
          })
        };
      });
      assert.equal(layout.overflow, false, `Navigation must not clip at ${width}px`);
      assert.equal(layout.buttons.length, 8);
      assert.ok(layout.buttons.every(Boolean), `Every company tab must fit at ${width}px`);
    }
    await page.locator('#btn-lang-toggle').click();
    for (const tab of ['ratios', 'peers']) {
      await page.locator(`button[onclick="switchSubPage('${tab}')"]`).click();
      const table = tab === 'ratios' ? '#cmp-ratio-table' : '#cmp-peers-table';
      if (tab === 'ratios') await page.selectOption('#ratio-period', 'quarterly');
      const sizes = await page.locator(table).evaluate(table => {
        const row = table.querySelector('tbody tr:not(.fin-group-header-row)');
        return {
          first: row.cells[0].getBoundingClientRect().width,
          data: row.cells[1].getBoundingClientRect().width,
          label: table.querySelector('.financial-group-label').getBoundingClientRect().width,
          labelsLeftAligned: getComputedStyle(table.querySelector('.fin-group-header-row td')).textAlign === 'left'
        };
      });
      assert.ok(sizes.first >= 270 && sizes.first < 400, `${tab} metric column should be readable and bounded`);
      assert.ok(sizes.data >= 120, `${tab} data columns must not collapse`);
      assert.ok(sizes.label > 0 && sizes.labelsLeftAligned, `${tab} group labels must be visible on the left`);
      if (tab === 'peers') {
        const peerWidths = await page.locator('#cmp-peers-table thead th:not(:first-child)')
          .evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width));
        assert.ok(Math.max(...peerWidths) - Math.min(...peerWidths) < 2, 'Peer columns should have equal widths');
      }
    }
    const presentationState = await page.evaluate(() => ({ lang: currentLang, theme: SiteTheme.current }));
    for (const lang of ['zh', 'en']) {
      await page.evaluate(lang => applyLanguage(lang), lang);
      for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => SiteTheme.set(theme), theme);
        for (const width of [390, 1440]) {
          await page.setViewportSize({ width, height: 1000 });
          for (const [tab, id] of [['financials', 'cmp-fin-table'], ['ratios', 'cmp-ratio-table'], ['peers', 'cmp-peers-table']]) {
            await page.evaluate(tab => switchSubPage(tab), tab);
            const layout = await page.locator(`#${id}`).evaluate(table => {
              const wrapper = table.closest('.table-scroll-wrapper');
              const head = table.querySelector('thead tr');
              const before = table.querySelector('tbody tr:not(.fin-group-header-row)').cells[0].getBoundingClientRect().left;
              wrapper.scrollLeft = 300;
              const after = table.querySelector('tbody tr:not(.fin-group-header-row)').cells[0].getBoundingClientRect().left;
              return {
                complete: [...table.querySelectorAll('tbody tr')].every(row => row.cells.length === head.cells.length),
                inPanel: wrapper.getBoundingClientRect().right <= innerWidth + 1,
                sticky: Math.abs(before - after) < 2,
                font: getComputedStyle(table).fontFamily,
                rows: table.querySelectorAll('tbody tr:not(.fin-group-header-row)').length,
                grid: [...table.querySelectorAll('tbody tr:not(.fin-group-header-row) td')].every(cell =>
                  getComputedStyle(cell).borderRightWidth !== '0px')
              };
            });
            assert.ok(layout.complete && layout.inPanel && layout.sticky && layout.grid && layout.rows > 0,
              `${tab}: aligned grid and frozen labels at ${width}px (${theme}/${lang})`);
            assert.equal(layout.font, await page.locator('#fcf-ratio-table').evaluate(table => getComputedStyle(table).fontFamily));
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
              `${tab} must scroll within its panel, not overflow the page`);
            if (process.env.UI_SCREENSHOT_DIR && width === 1440 && lang === 'en') {
              await page.locator(`#${id}`).evaluate(table => { table.closest('.table-scroll-wrapper').scrollLeft = 0; });
              await page.locator(`#subpage-${tab}`).screenshot({
                path: path.join(process.env.UI_SCREENSHOT_DIR, `company-${tab}-${theme}.png`)
              });
            }
          }
        }
      }
    }
    await page.evaluate(state => { SiteTheme.set(state.theme); applyLanguage(state.lang); }, presentationState);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => openCompanyProfile('JPM'));
    await page.locator('button[onclick="switchSubPage(\'financials\')"]').click();
    for (const period of ['annual', 'quarterly']) {
      await page.selectOption('#statement-period', period);
      for (const type of ['income', 'balance', 'cashflow']) {
        await page.selectOption('#statement-type', type);
        assert.doesNotMatch(await page.locator('#cmp-fin-table').innerText(), /[\u3400-\u9fff]/,
          'English financial statements must not retain Chinese headings or group labels');
        const layout = await page.locator('#cmp-fin-table').evaluate(table => {
          const head = [...table.querySelector('thead tr').cells];
          const rows = [...table.querySelectorAll('tbody tr')];
          return {
            metric: head[0].getBoundingClientRect().width,
            data: head[1].getBoundingClientRect().width,
            trend: head.at(-1).getBoundingClientRect().width,
            complete: rows.every(row => row.cells.length === head.length),
            dividers: rows.every(row => [...row.cells].every((cell, i) =>
              cell.classList.contains('year-divider-cell') === head[i].classList.contains('year-divider-cell'))),
            groups: [...table.querySelectorAll('.fin-group-header-row td:first-child')].every(cell =>
              getComputedStyle(cell).textAlign === 'left' && cell.textContent.trim())
          };
        });
        assert.ok(layout.metric >= 270 && layout.metric <= 300);
        assert.ok(layout.data >= 125 && layout.trend >= 125);
        assert.ok(layout.complete && layout.dividers && layout.groups, 'Statement grids and fiscal dividers stay continuous');
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileStatement = await page.locator('#cmp-fin-table').evaluate(table => {
      const head = table.querySelector('thead .fcf-trend-col');
      const body = table.querySelector('tbody tr:not(.fin-group-header-row) .fcf-trend-col');
      return {
        heading: head.getBoundingClientRect().left,
        body: body.getBoundingClientRect().left,
        label: table.querySelector('tbody tr:not(.fin-group-header-row) td').getBoundingClientRect().width
      };
    });
    assert.ok(Math.abs(mobileStatement.heading - mobileStatement.body) < 2,
      'Mobile trend heading must scroll with its data instead of overlapping historical columns');
    assert.ok(mobileStatement.label <= 155);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#btn-lang-toggle').click();
    assert.ok(await page.locator('#subpage-financials').evaluate(node => node.classList.contains('active')));
    assert.match(await page.locator('#cmp-fin-thead th').first().innerText(), /會計項目/);
    await page.locator('#btn-lang-toggle').click();
    assert.match(await page.locator('#cmp-fin-thead th').first().innerText(), /Accounting/);
    const statementBeforeTheme = await page.locator('#cmp-fin-tbody').textContent();
    assert.equal(await page.locator('#btn-theme-toggle').innerText(), 'Light mode');
    await page.locator('#btn-theme-toggle').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await page.locator('#btn-theme-toggle').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#btn-theme-toggle').innerText(), 'Dark mode');
    assert.equal(await page.locator('#cmp-fin-tbody').textContent(), statementBeforeTheme);
    const styles = await page.evaluate(() => {
      const computed = selector => getComputedStyle(document.querySelector(selector));
      return {
        body: computed('body').backgroundColor,
        text: computed('#cmp-fin-tbody td').color,
        label: computed('#cmp-fin-tbody td').backgroundColor,
        fonts: ['#fcf-ratio-table', '#return-ratio-table', '#cmp-fin-table', '#cmp-ratio-table',
          '#cmp-peers-table', '#dcf-table', 'button', 'input',
          '#cmp-fin-tbody tr:not(.fin-group-header-row) td:nth-child(2)',
          '#fcf-ratio-body td', '#return-ratio-body td', '#dcf-fcf td'].map(selector => computed(selector).fontFamily),
        sizes: ['#fcf-ratio-table', '#return-ratio-table', '#cmp-fin-table', '#cmp-ratio-table',
          '#cmp-peers-table'].map(selector => computed(selector).fontSize)
      };
    });
    assert.equal(styles.body, 'rgb(241, 245, 249)');
    assert.ok(styles.fonts.every(font => font === styles.fonts[0]), 'Financial tables and controls share one font family');
    assert.ok(styles.sizes.every(size => size === styles.sizes[0]), 'Company tables share one table type size');
    assert.notEqual(styles.text, styles.label);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', 'Theme survives reload');
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    await page.locator('button[onclick="switchSubPage(\'chart\')"]').click();
    assert.match(await page.locator('#tradingview_widget_container iframe').getAttribute('src'), /theme=light/);
    assert.match(await page.locator('#tradingview_widget_container iframe').getAttribute('src'), /locale=en/);
    await page.locator('#btn-theme-toggle').click();
    assert.match(await page.locator('#tradingview_widget_container iframe').getAttribute('src'), /theme=dark/);
    const financials = await page.evaluate(() => Object.entries(stockUniverse)
      .filter(([, stock]) => stock.fin_valuation.is_financial).map(([ticker]) => ticker));
    for (const ticker of financials) {
      const source = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'financials',
        `${ticker}_statements_v2.json`), 'utf8'));
      const shares = await page.evaluate(ticker => stockUniverse[ticker].shares, ticker);
      const reference = financialReference(source, { shares });
      await page.evaluate(ticker => openDetail(ticker), ticker);
      assert.equal(await page.locator('#disp-fin-rote').innerText(), `${reference.rote.toFixed(2)}%`, ticker);
      assert.ok(Math.abs(Number(await page.locator('#slider-fin-rote').inputValue()) - reference.rote) < 1e-10, ticker);
      assert.ok((await page.locator('#fin-reference-note').innerText()).includes(reference.date), ticker);
      assert.equal(await page.locator('#det-res-fair').innerText() === 'N/A', Boolean(reference.reason), ticker);
    }
    await page.evaluate(() => openDetail('JPM'));
    const baselineRote = await page.evaluate(() => stockUniverse.JPM.fin_valuation.reference.rote);
    await page.locator('#slider-fin-rote').evaluate(input => {
      input.value = '0';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await page.locator('#disp-fin-rote').innerText(), '0.00%');
    assert.equal(await page.evaluate(() => stockUniverse.JPM.fin_valuation.rote), 0);
    assert.equal(await page.evaluate(() => stockUniverse.JPM.fin_valuation.reference.rote), baselineRote);
    await page.evaluate(() => resetToFmpDefaults());
    assert.ok(Math.abs(Number(await page.locator('#slider-fin-rote').inputValue()) - baselineRote) < 1e-10);
    await page.evaluate(() => openCompanyProfile('JPM'));
    await page.locator('button[onclick="switchSubPage(\'charts\')"]').click();
    await page.selectOption('#return-ratio-period', 'quarterly');
    await page.selectOption('#return-ratio-flow', 'ttm');
    await page.selectOption('#return-ratio-balance', 'beginning');
    await checkTable(page, 'JPM', {}, 'return-ratio');
    assert.equal(await page.locator('#return-ratio-body tr').last().locator('td:not(.fcf-trend-col)').last().innerText(),
      `${baselineRote.toFixed(2)}%`);
    assert.deepEqual(errors, []);
    assert.deepEqual(firstPartyFailures, []);

    const failurePage = await browser.newPage();
    await failurePage.route('**/cache/financials/AAPL_statements_v2.json', route => route.abort());
    await failurePage.goto(`${baseUrl}/#AAPL/profile`, { waitUntil: 'networkidle' });
    await failurePage.locator('button[onclick="switchSubPage(\'charts\')"]').click();
    await failurePage.waitForFunction(() => !document.querySelector('#fcf-ratio-retry').hidden);
    assert.equal(await failurePage.locator('#fcf-ratio-body tr').count(), 0);
    await failurePage.unroute('**/cache/financials/AAPL_statements_v2.json');
    await failurePage.locator('#fcf-ratio-retry').click();
    await checkTable(failurePage, 'AAPL', {});
    await failurePage.locator('#return-ratio-retry').click();
    await checkTable(failurePage, 'AAPL', {}, 'return-ratio');
    await failurePage.locator('#balance-retry').click();
    await checkBalances(failurePage, 'AAPL');
    await failurePage.locator('#earnings-retry').click();
    await checkEarnings(failurePage, 'AAPL');

    const racePage = await browser.newPage();
    await racePage.route('**/cache/financials/NVDA_statements_v2.json', async route => {
      await new Promise(resolve => setTimeout(resolve, 600));
      await route.continue();
    });
    await racePage.goto(`${baseUrl}/#NVDA/profile`, { waitUntil: 'domcontentloaded' });
    await racePage.waitForFunction(() => document.querySelector('#company-view').style.display === 'block');
    await racePage.locator('button[onclick="switchSubPage(\'charts\')"]').click();
    await racePage.evaluate(() => openCompanyProfile('AAPL'));
    await racePage.locator('button[onclick="switchSubPage(\'charts\')"]').click();
    await racePage.waitForLoadState('networkidle');
    assert.match(await racePage.locator('#fcf-ratio-status').innerText(), /^AAPL/);
    await checkTable(racePage, 'AAPL', {});
    await checkTable(racePage, 'AAPL', {}, 'return-ratio');
    await checkBalances(racePage, 'AAPL');
    await checkEarnings(racePage, 'AAPL');
    console.log('PASS: company rating navigation, complete moat/PF score relocation, earnings trends/controls/units/mobile/localization/retry/races; existing screener, balance, DCF, ROTE, themes and financial tables.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
