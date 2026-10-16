const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { calculate, calculateReturns, financialReference, trend } = require('../fcf_ratios.js');

const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:8765';

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
    for (const ticker of ['NVDA', 'AAPL', 'JPM', 'DE', 'HD', 'PFE', 'PGR', 'AZO']) {
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
      assert.equal(await page.locator('#detail-view #return-ratio-panel').count(), 0);
      assert.equal(statementRequests.filter(url => url.endsWith(`/${ticker}_statements_v2.json`)).length, 1,
        'Both panels share one statement request per ticker');
    }
    await page.evaluate(() => openCompanyProfile('NVDA'));
    await page.locator('button[onclick="switchSubPage(\'charts\')"]').click();
    await page.waitForFunction(() => document.querySelector('#fcf-ratio-status').textContent.startsWith('NVDA'));
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
      if (tab === 'ratios') await page.locator('#btn-ratio-period-quarterly').click();
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
    await page.evaluate(() => openCompanyProfile('JPM'));
    await page.locator('button[onclick="switchSubPage(\'financials\')"]').click();
    for (const period of ['annual', 'quarterly']) {
      await page.locator(`#btn-stmt-period-${period}`).click();
      for (const type of ['income', 'balance', 'cashflow']) {
        await page.locator(`#btn-stmt-${type}`).click();
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
    console.log('PASS: shared financial DCF/Trend ROTE including negative/zero cases and reset, persistent dark/light themes and TradingView locale, consistent typography, translated financial statements and continuous grids, all existing FCF/return controls, navigation, mobile and retry regressions.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
