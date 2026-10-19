const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let calls = 0, failure = false;
    await page.route('http://saved-fmp.test/**', route => {
      const url = new URL(route.request().url()), query = url.searchParams;
      if (url.pathname === '/cache/company/0939.HK.json') return route.fulfill({ contentType: 'application/json',
        body: JSON.stringify({ symbol: '0939.HK', capturedAt: '2026-10-16T00:00:00Z',
          news: { data: [], reason: 'FMP_NO_COVERAGE' } }) });
      if (!url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'text/html', body: '<main>Cache test</main>' });
      calls++;
      const symbol = query.get('symbol'), technical = query.get('action') === 'technical';
      return route.fulfill({ status: failure ? 503 : 200, contentType: 'application/json',
        body: JSON.stringify(failure ? { error: 'TEST_UPSTREAM_FAILURE' } : {
          data: technical ? [{ date: '2026-10-16', close: 100, value: 95 }]
            : ['0005.HK', '0939.HK'].includes(symbol) ? [] : [{ symbol, equityValuePerShare: 123 }],
          source: { provider: 'FMP', symbol, capturedAt: '2026-10-17T00:00:00Z',
            ...(technical ? { indicator: query.get('indicator'), periodLength: Number(query.get('periodLength')),
              timeframe: '1day', from: query.get('from'), to: query.get('to') } : {}) },
          ...(query.get('action') === 'news' ? { page: Number(query.get('page')), hasMore: false } : {})
        }) });
    });
    const scripts = async () => {
      for (const name of ['fmp_cache.js', 'technical_indicators.js']) await page.addScriptTag({ path: path.resolve(__dirname, '..', name) });
    };
    await page.goto('http://saved-fmp.test/');
    await scripts();
    const request = (query, options) => page.evaluate(({ query, options }) => FmpCache.request(query, options), { query, options });
    const query = 'action=custom-dcf&symbol=AAPL&revenuePercentage=1.25';
    let result = await request(query);
    assert.equal(calls, 1);
    assert.equal(result.cache.persisted, true);
    assert.equal(result.cache.hit, false);
    await page.reload(); await scripts();
    result = await request('symbol=AAPL&revenuePercentage=1.25&action=custom-dcf');
    assert.equal(calls, 1, 'Identical parameters survive a full page reload without another API request');
    assert.equal(result.cache.hit, true);
    assert.equal(result.source.capturedAt, '2026-10-17T00:00:00Z', 'Original capture time must not become the cache read time');
    await request(query.replace('1.25', '1.26'));
    assert.equal(calls, 2, 'A new assumption needs its own result');
    await request(query, { scope: 'new-source-snapshot' });
    assert.equal(calls, 3, 'Changed underlying data uses a separate cache namespace');
    await request(query, { refresh: true });
    assert.equal(calls, 4, 'Only explicit refresh bypasses the saved response');
    failure = true;
    await assert.rejects(() => request(query, { refresh: true }), /TEST_UPSTREAM_FAILURE/);
    result = await request(query);
    assert.equal(result.cache.hit, true, 'A failed refresh does not overwrite the last actual successful snapshot');
    failure = false;
    const empty = 'action=news&symbol=0005.HK&page=0';
    await request(empty);
    const beforeEmpty = calls;
    assert.deepEqual((await request(empty)).data, []);
    assert.equal(calls, beforeEmpty, 'Genuine empty provider coverage is saved, not repeatedly probed');
    const technical = () => page.evaluate(() => TechnicalIndicators.load('AAPL', 'sma', 20, '2026-10-01', '2026-10-16'));
    result = await technical();
    assert.equal(result.rows[0].value, 95);
    assert.equal(result.cache.persisted, true);
    const beforeReload = calls;
    await page.reload(); await scripts();
    assert.equal((await technical()).cache.hit, true);
    assert.equal(calls, beforeReload, 'Technical data survives both module and page reloads');
    await page.addScriptTag({ path: path.resolve(__dirname, '..', 'company_data.js') });
    await page.evaluate(async () => {
      document.body.innerHTML = '<div id="news"></div>';
      await CompanyData.load('0939.HK');
      await CompanyData.renderNews(document.getElementById('news'), '0939.HK', [], 'en');
    });
    assert.equal(calls, beforeReload, 'Already saved empty company-news coverage is reused without another FMP probe');
    assert.match(await page.locator('#news').innerText(), /2026-10-16T00:00:00Z/);
    await page.getByRole('button', { name: 'Refresh FMP news' }).click();
    await page.waitForFunction(() => !document.querySelector('#news button:last-child').disabled);
    assert.equal(calls, beforeReload + 1, 'The explicit news refresh still requests the provider');
    await page.evaluate(() => Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true }));
    await page.addScriptTag({ path: path.resolve(__dirname, '..', 'fmp_cache.js') });
    result = await request(query);
    assert.equal(result.cache.persisted, false);
    assert.match(result.cache.warning, /UNAVAILABLE/);
    assert.match(await page.evaluate(result => FmpCache.note(result, 'en'), result), /may need to be fetched again/);
    assert.deepEqual(errors, []);
    console.log('Persistent FMP cache browser PASS: real IndexedDB reloads, exact query/source keys, empty coverage, explicit refresh, failures and unavailable-storage warning.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
