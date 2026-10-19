const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..', 'public');
const percent = (fcf, equity, unavailable) => !unavailable && Number.isFinite(fcf)
  && Number.isFinite(equity) && equity !== 0 && Number.isFinite(fcf / equity * 100)
  ? (fcf / equity * 100).toFixed(2) + '%' : 'N/A';

(async () => {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (error, bytes) => {
      if (error) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8'
        : file.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'application/json');
      res.end(bytes);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const market of ['US', 'HKEX']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/s3.tradingview.com/**', route => route.abort());
      if (process.env.CHART_VENDOR) await page.route('https://cdn.jsdelivr.net/npm/chart.js', route =>
        route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(process.env.CHART_VENDOR) }));
      await page.goto(`${base}/?market=${market}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => typeof isAppReady !== 'undefined' && isAppReady);
      const stocks = await page.evaluate(() => structuredClone(stockUniverse));
      for (const lang of ['en', 'zh']) {
        await page.evaluate(lang => applyLanguage(lang), lang);
        await page.selectOption('#screener-columns', 'financial');
        assert.equal(await page.locator('#screener-table thead th:visible').count(), 20);
        const fields = await page.locator('#screener-table thead th').evaluateAll(headers =>
          headers.map(header => header.getAttribute('onclick')));
        const index = fields.indexOf("sortTable('fcf_to_equity')");
        assert.equal(fields[index - 1], "sortTable('fcf_to_ev')");
        assert.equal(fields[index + 1], "sortTable('fcf_to_mcap')");
        assert.match(await page.locator('th[onclick="sortTable(\'fcf_to_equity\')"]').innerText(),
          lang === 'en' ? /Parent equity/ : /股東應佔權益/);
        for (const [ticker, stock] of Object.entries(stocks)) {
          const raw = stock.statements_raw;
          const row = page.locator('#screener-tbody tr').filter({
            has: page.locator(`a[onclick="openCompanyProfile('${ticker}')"]`)
          });
          assert.equal(await row.locator('[data-metric="fcf_to_equity"]').innerText(),
            percent(raw.cashflow.freeCashFlow.at(-1), raw.balance.totalStockholdersEquity.at(-1),
              raw.fxUnavailable?.at(-1) || stock.currencyConversion?.reason === 'dateMismatch'), ticker);
        }
        for (const ascending of [true, false]) {
          await page.locator('th[onclick="sortTable(\'fcf_to_equity\')"]').click();
          assert.equal(await page.evaluate(() => sortAsc), ascending);
          const values = await page.locator('[data-metric="fcf_to_equity"]').allTextContents();
          const finite = values.filter(value => value !== 'N/A').map(parseFloat);
          assert.ok(finite.every((value, i) => i === 0
            || (ascending ? value >= finite[i - 1] : value <= finite[i - 1])));
          const firstMissing = values.indexOf('N/A');
          assert.ok(firstMissing < 0 || values.slice(firstMissing).every(value => value === 'N/A'));
        }
      }
      const tickers = market === 'US' ? ['NVDA'] : ['0700.HK', '0388.HK', '0823.HK'];
      for (const ticker of tickers) {
        await page.evaluate(ticker => { openCompanyProfile(ticker); switchSubPage('ratios'); }, ticker);
        const stock = stocks[ticker];
        const modes = market === 'US' ? ['annual', 'quarterly']
          : stock.reportingFrequency === 'semiannual'
            ? ['annual', 'semiannual'] : ['annual', 'quarterly', 'semiannual'];
        for (const lang of ['en', 'zh']) {
          await page.evaluate(lang => applyLanguage(lang), lang);
          for (const period of modes) {
            await page.selectOption('#ratio-period', period);
            const raw = stock.statements_raw;
            const table = period === 'annual' ? raw
              : period === 'quarterly' ? raw.quarterly_raw : raw.semiannual_raw;
            const row = page.locator('#cmp-ratio-tbody tr').filter({
              hasText: /FCF \/ (?:Equity attributable|本公司股東應佔權益)/
            });
            assert.equal(await row.count(), 1);
            assert.match(await row.evaluate(row => row.previousElementSibling.textContent), /FCF Growth/);
            assert.match(await row.locator('td').first().getAttribute('title'),
              lang === 'en' ? /excluding noncontrolling interests/ : /不含非控股權益/);
            const cells = await row.locator('td').allTextContents();
            const expected = table.balance.totalStockholdersEquity.map((equity, i) => percent(
              period !== 'annual' && stock.statementFrequencies?.cashflow === 'annual'
                ? null : table.cashflow.freeCashFlow[i], equity,
              table.fxUnavailable?.[i] || period === 'annual' && i === 5
                && stock.currencyConversion?.reason === 'dateMismatch'));
            assert.deepEqual(cells.slice(1, -1), expected, `${ticker} ${lang} ${period}`);
          }
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('FCF/equity browser passed: both markets, bilingual headers, exact column/row positions, sorting, actual TTM, annual/quarter/half-year values, missing flows and mobile overflow.');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
