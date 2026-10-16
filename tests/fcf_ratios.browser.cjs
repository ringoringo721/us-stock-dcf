const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { calculate, trend } = require('../fcf_ratios.js');

const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:8765';

async function checkTable(page, ticker, options) {
  await page.waitForFunction(() => document.querySelector('#fcf-ratio-body').children.length === 5);
  const source = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'financials', `${ticker}_statements_v2.json`), 'utf8'));
  const columns = calculate(source, options);
  const headings = await page.locator('#fcf-ratio-head th').allTextContents();
  assert.equal(headings.length, columns.length + 2);
  for (let i = 0; i < columns.length; i++) {
    assert.ok(headings[i + 1].includes(columns[i].label));
    assert.ok(headings[i + 1].includes(columns[i].date));
  }
  for (const [i, metric] of ['equity', 'assets', 'sales', 'ebitda', 'netIncome'].entries()) {
    const expected = columns.map(column => {
      const ratio = column.ratios[metric];
      return ratio.value === null ? 'N/A' : `${ratio.value.toFixed(2)}%${ratio.warnings.length ? ' !' : ''}`;
    });
    const row = page.locator('#fcf-ratio-body tr').nth(i);
    assert.deepEqual(await row.locator('td:not(.fcf-trend-col)').allTextContents(), expected);
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
    assert.equal(await page.locator('#subpage-charts').getAttribute('class'), 'subpage-content active');
    await page.locator('#btn-lang-toggle').click();
    await page.waitForFunction(() => document.querySelector('#fcf-ratio-body tr th').textContent.includes('股東權益'));
    const historical = await page.locator('#fcf-ratio-body').textContent();
    await page.locator('button[onclick="switchSubPage(\'basic\')"]').click();
    assert.equal(await page.locator('#fcf-ratio-panel').isVisible(), false);
    await page.locator('button[onclick="switchSubPage(\'charts\')"]').click();
    await checkTable(page, 'NVDA', { period: 'annual', flow: 'ttm', balance: 'average' });
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
    await page.evaluate(() => openDetail('NVDA'));
    assert.equal(await page.locator('#fcf-ratio-panel').isVisible(), false);
    assert.equal(await page.locator('#detail-view #fcf-ratio-panel').count(), 0);
    assert.equal(await page.locator('#det-ticker').getAttribute('type'), 'button');
    const originalFair = await page.locator('#det-res-fair').innerText();
    await page.locator('#inp-fcf0').fill('100');
    await page.waitForFunction(before => document.querySelector('#det-res-fair').textContent !== before, originalFair);
    assert.equal(await page.locator('#fcf-ratio-body').textContent(), historical);
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
    console.log('PASS: real-browser trend sparklines, ticker navigation, eight visible company tabs, tidy key-ratio/peer tables, all ratio controls and values, unchanged DCF, mobile layout, retry and stale-request protection.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
