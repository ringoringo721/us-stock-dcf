const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const market = require('../hk_market_dcf.json');
const usMarket = require('../full_market_dcf.json');
const root = path.resolve(__dirname, '..', 'public');

(async () => {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
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
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], api = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://cdn.jsdelivr.net/npm/chart.js', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.Chart=class {static defaults={font:{}};constructor(c,x){this.data=x.data;this.options=x.options;}destroy(){}update(){}};',
    }));
    await page.route('**/s3.tradingview.com/**', route => route.abort());
    await page.route('**/api/fmp?**', route => {
      api.push(new URL(route.request().url()).searchParams.get('action'));
      return route.fulfill({ json: { data: [], page: 0, hasMore: false } });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const verifyAllMoatPages = async stocks => {
      for (const language of ['zh', 'en']) {
        await page.evaluate(language => applyLanguage(language), language);
        for (const [ticker, stock] of Object.entries(stocks)) {
          await page.evaluate(ticker => { openCompanyProfile(ticker); switchSubPage('rating'); }, ticker);
          await page.waitForFunction(ticker => stockUniverse[ticker].companyDataLoaded, ticker);
          const actual = await page.evaluate(() => {
            const panel = document.getElementById('moat-ai-comment');
            return {
              ticker: document.getElementById('moat-ticker').innerText,
              date: document.getElementById('moat-updated-date').innerText,
              text: panel.innerText,
              externalContent: panel.querySelectorAll('a, iframe, pre, details').length,
              rows: document.querySelectorAll('#moat-breakdown-body tr').length,
              commentLinks: document.querySelectorAll('#moat-breakdown-body a').length,
            };
          });
          const date = stock.ratingSources?.moat?.updatedAt?.slice(0, 10) || 'N/A';
          assert.equal(actual.ticker, ticker);
          assert.equal(actual.date, `${language === 'en' ? 'Updated' : '更新日期'}: ${date}`, `${ticker}/${language}`);
          assert.equal(actual.externalContent, 0, `${ticker}: no reference links, frames or source drawers`);
          assert.equal(actual.commentLinks, 0, `${ticker}: no links beneath comments`);
          assert.equal(actual.rows, 10, ticker);
          assert.doesNotMatch(actual.text, /[a-f\d]{64}|T\d{2}:\d{2}/i, `${ticker}: no evidence hashes or full timestamps`);
        }
      }
    };
    await page.goto(`${base}/?market=HKEX`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => isAppReady);
    const assertBlackTheme = async () => {
      const colors = await page.evaluate(() => {
        const css = getComputedStyle(document.documentElement);
        return {
          body: getComputedStyle(document.body).backgroundColor,
          surfaces: ['--bg', '--card-bg', '--card-border', '--sticky-bg', '--surface-bg',
            '--header-bg', '--group-bg', '--button-bg', '--row-hover-bg'].map(name => css.getPropertyValue(name).trim()),
          grid: css.getPropertyValue('--chart-grid').trim(),
          green: css.getPropertyValue('--green').trim(),
          red: css.getPropertyValue('--red').trim(),
        };
      });
      assert.equal(colors.body, 'rgb(0, 0, 0)');
      for (const color of colors.surfaces) {
        assert.match(color, /^#[\da-f]{6}$/i);
        assert.equal(color.slice(1, 3), color.slice(3, 5), color);
        assert.equal(color.slice(3, 5), color.slice(5, 7), color);
      }
      assert.equal(colors.grid, 'rgba(64, 64, 64, 0.4)');
      assert.equal(colors.green, '#4ade80');
      assert.equal(colors.red, '#f87171');
    };
    await page.evaluate(() => SiteTheme.set('dark'));
    await assertBlackTheme();
    await page.locator('#btn-theme-toggle').click();
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(241, 245, 249)');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => isAppReady);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', 'Light mode survives reload');
    await page.locator('#btn-theme-toggle').click();
    await assertBlackTheme();
    const researched = Object.entries(market).filter(([, stock]) => stock.ratingSources?.moat?.businessResearch);
    assert.ok(researched.length > 0, 'Saved researched assessments must be applied before this check');
    for (const language of ['zh', 'en']) {
      await page.evaluate(value => applyLanguage(value), language);
      for (const ticker of ['1299.HK', '2318.HK', '2628.HK', '1398.HK']) {
        await page.evaluate(ticker => { openCompanyProfile(ticker); switchSubPage('rating'); }, ticker);
        await page.waitForFunction(ticker => stockUniverse[ticker].companyDataLoaded, ticker);
        assert.match(await page.locator('#fsc-total-score').innerText(), /N\/A/);
        assert.match(await page.locator('#fsc-health-level').innerText(),
          language === 'en' ? /Not applicable \(financials\)/i : /金融業不適用/);
        assert.equal(await page.locator('[data-i18n="fsc_health_bands"]').isVisible(), false);
        const score = await page.evaluate(ticker => financialHealthAssessment(stockUniverse[ticker].f_score,
          stockUniverse[ticker].f_score_breakdown, stockUniverse[ticker].ratingSources.fScore,
          stockUniverse[ticker]), ticker);
        assert.equal(score.financialNa, true);
        assert.equal(score.validScore, false);
        assert.match(await page.locator('#zsc-total-score').innerText(), /N\/A/);
        assert.match(await page.locator('#msc-total-score').innerText(), /N\/A/);
        await page.evaluate(() => navigateBack());
        const row = page.locator('#screener-tbody tr').filter({ hasText: ticker });
        assert.match(await row.locator('.badge-fscore').innerText(), /N\/A/);
        assert.match(await row.locator('.badge-zscore').innerText(), /N\/A/);
        assert.match(await row.locator('.badge-mscore').innerText(), /N\/A/);
      }
      for (const ticker of ['1398.HK', '3988.HK']) {
        await page.evaluate(ticker => { openCompanyProfile(ticker); switchSubPage('valuation'); }, ticker);
        await page.waitForFunction(ticker => stockUniverse[ticker].companyDataLoaded, ticker);
        for (const id of ['fin-excess-val', 'fin-ddm-val', 'fin-tbvps', 'fin-dps', 'det-res-fair'])
          assert.ok(Number.isFinite(Number((await page.locator(`#${id}`).innerText()).replace(/[^\d.-]/g, '')))
            && !(await page.locator(`#${id}`).innerText()).includes('N/A'), `${ticker}/${id}`);
        assert.ok((await page.locator('#fin-reference-note').innerText())
          .includes(market[ticker].shares_outstanding.toLocaleString('en-US')));
        assert.equal(await page.locator('#fin-reference-note a').getAttribute('href'), market[ticker].shareSource.providerSource);
        assert.match(await page.locator('#fin-reference-note').innerText(), language === 'en' ? /FMP share count disagrees/ : /FMP 股數與官方/);
      }
      for (const [ticker, stock] of researched) {
        await page.evaluate(ticker => { openCompanyProfile(ticker); switchSubPage('rating'); }, ticker);
        await page.waitForFunction(ticker => stockUniverse[ticker].companyDataLoaded, ticker);
        const updatedDate = stock.ratingSources.moat.updatedAt.slice(0, 10);
        assert.equal(await page.locator('#moat-breakdown-body tr').count(), 10);
        assert.ok((await page.locator('#moat-overall-text').innerText())
          .includes(stock.moat[`overall_moat_verdict_${language}`]), ticker);
        assert.equal(await page.locator('#moat-updated-date').innerText(), `${language === 'en' ? 'Updated' : '更新日期'}: ${updatedDate}`);
        assert.doesNotMatch(await page.locator('#moat-updated-date').innerText(), /[a-f\d]{64}|T\d{2}:/i);
        assert.equal(await page.locator('#moat-search-suggestions').count(), 0, 'No Google suggestion links');
        assert.equal(await page.locator('#moat-breakdown-body a').count(), 0, 'No repeated website lists beneath individual comments');
        assert.equal(await page.locator('#moat-business-sources').count(), 0, 'No source drawer or raw research dump');
        assert.equal(await page.locator('#moat-ai-comment a, #moat-ai-comment pre, #moat-ai-comment iframe, #moat-ai-comment details').count(), 0);
        assert.match(await page.locator('#moat-research-note').innerText(), language === 'en' ? /point-in-time historical rating/ : /不是當時可得資訊/);
        const actual = await page.locator('#moat-breakdown-body tr').allTextContents();
        const dimensions = Object.keys(stock.moat).filter(key => /^m\d+_/.test(key));
        for (const [index, key] of dimensions.entries())
          assert.ok(actual[index].includes(stock.moat[key][`comment_${language}`]), `${ticker}/${key}/${language}`);
      }
      for (const [updatedAt, expected] of [[undefined, 'N/A'], ['not-a-date', 'N/A'],
        ['2026-10-19', '2026-10-19'], ['2026-10-19T03:04:15.730306+00:00', '2026-10-19']]) {
        const ref = await page.evaluate(updatedAt => evaluateMoat({ ticker: 'TEST',
          ratingSources: { moat: { updatedAt, evidenceHash: 'INTERNAL_ONLY', asOfDate: '2026-06-30', period: '2026H1' } } }, 'TEST').ref, updatedAt);
        assert.equal(ref, `${language === 'en' ? 'Updated' : '更新日期'}: ${expected}`);
      }
    }
    await verifyAllMoatPages(market);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => isAppReady);
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', 'Black dark mode survives reload');
    await assertBlackTheme();
    await page.evaluate(() => { openCompanyProfile('1211.HK'); switchSubPage('rating'); });
    assert.equal(await page.locator('#moat-search-suggestions').count(), 0);
    assert.equal(await page.locator('#fscore-breakdown-body tr').count(), 9);
    assert.equal(await page.locator('#moat-breakdown-body a').count(), 0);
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => isAppReady);
    assert.equal(await page.evaluate(() => MarketContext.market), 'US');
    await assertBlackTheme();
    await verifyAllMoatPages(usMarket);
    assert.deepEqual(errors, []);
    assert.ok(api.every(action => action === 'news'), 'Rendering and reload cannot call a valuation or generation API');
    console.log(`PASS: all ${Object.keys(market).length} HK and ${Object.keys(usMarket).length} US Moat pages in both languages with date-only update labels (N/A if unavailable), no reference links, search suggestions, source drawers, full timestamps or evidence hashes; saved comments, insurer PF, bank denominators and persistent black/light themes preserved.`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
