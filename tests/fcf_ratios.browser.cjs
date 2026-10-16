const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { calculate } = require('../fcf_ratios.js');

const baseUrl = process.env.TEST_BASE_URL || 'http://127.0.0.1:8765';

async function checkTable(page, ticker, options) {
  await page.waitForFunction(() => document.querySelector('#fcf-ratio-body').children.length === 4);
  const source = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'financials', `${ticker}_statements_v2.json`), 'utf8'));
  const columns = calculate(source, options);
  const headings = await page.locator('#fcf-ratio-head th').allTextContents();
  assert.equal(headings.length, columns.length + 1);
  for (let i = 0; i < columns.length; i++) {
    assert.ok(headings[i + 1].includes(columns[i].label));
    assert.ok(headings[i + 1].includes(columns[i].date));
  }
  for (const [i, metric] of ['equity', 'assets', 'sales', 'ebitda'].entries()) {
    const expected = columns.map(column => {
      const ratio = column.ratios[metric];
      return ratio.value === null ? 'N/A' : `${ratio.value.toFixed(2)}%${ratio.warnings.length ? ' !' : ''}`;
    });
    assert.deepEqual(await page.locator('#fcf-ratio-body tr').nth(i).locator('td').allTextContents(), expected);
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
      await page.locator(`button[onclick="openDetail('${ticker}')"]`).click();
      await page.waitForFunction(ticker => document.querySelector('#fcf-ratio-status').textContent.startsWith(ticker), ticker);
      assert.equal(await page.locator('#det-ticker').innerText(), ticker);
      assert.match(await page.locator('#det-res-fair').innerText(), /^\$\d/);
      await checkTable(page, ticker, {});
    }
    await page.evaluate(() => openDetail('NVDA'));
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
    for (const metric of ['equity', 'assets', 'sales', 'ebitda']) {
      await page.uncheck(`#fcf-ratio-${metric}`);
    }
    assert.equal(await page.locator('#fcf-ratio-body tr').count(), 0);
    assert.ok((await page.locator('#fcf-ratio-status').innerText()).length > 0);
    await page.check('#fcf-ratio-sales');
    await page.waitForFunction(() => document.querySelector('#fcf-ratio-body').children.length === 1);
    assert.equal(await page.locator('#fcf-ratio-balance').isDisabled(), true);
    await page.check('#fcf-ratio-equity');
    assert.equal(await page.locator('#fcf-ratio-balance').isDisabled(), false);
    await page.check('#fcf-ratio-assets');
    await page.check('#fcf-ratio-ebitda');
    await page.locator('#btn-lang-toggle').click();
    await page.waitForFunction(() => document.querySelector('#fcf-ratio-body tr th').textContent === 'FCF / Equity');
    assert.equal(await page.locator('#fcf-ratio-title').innerText(), 'Free Cash Flow (FCF) Ratios');
    await page.locator('#btn-lang-toggle').click();
    await page.waitForFunction(() => document.querySelector('#fcf-ratio-body tr th').textContent.includes('股東權益'));
    const historical = await page.locator('#fcf-ratio-body').innerText();
    const originalFair = await page.locator('#det-res-fair').innerText();
    await page.locator('#inp-fcf0').fill('100');
    await page.waitForFunction(before => document.querySelector('#det-res-fair').textContent !== before, originalFair);
    assert.equal(await page.locator('#fcf-ratio-body').innerText(), historical);
    assert.equal(await page.locator('#dcf-fcf td').count(), 11);
    assert.equal(await page.locator('#sens-body tr').count(), 3);
    assert.equal(await page.locator('#detailDcfHistoricalChart').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    const widths = await page.locator('#fcf-ratio-panel .table-scroll-wrapper')
      .evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }));
    assert.ok(widths.scroll > widths.client, 'Historical columns scroll horizontally on narrow viewports');
    assert.deepEqual(errors, []);
    assert.deepEqual(firstPartyFailures, []);

    const failurePage = await browser.newPage();
    await failurePage.route('**/cache/financials/AAPL_statements_v2.json', route => route.abort());
    await failurePage.goto(`${baseUrl}/#AAPL`, { waitUntil: 'networkidle' });
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
    await racePage.goto(`${baseUrl}/#NVDA`, { waitUntil: 'domcontentloaded' });
    await racePage.waitForFunction(() => document.querySelector('#det-ticker').textContent === 'NVDA');
    await racePage.evaluate(() => openDetail('AAPL'));
    await racePage.waitForLoadState('networkidle');
    assert.match(await racePage.locator('#fcf-ratio-status').innerText(), /^AAPL/);
    await checkTable(racePage, 'AAPL', {});
    console.log('PASS: real-browser rows/stats, eight stocks, all ratio controls and displayed values, localization, DCF isolation, mobile scrolling, fetch-failure retry and stale-request protection.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
