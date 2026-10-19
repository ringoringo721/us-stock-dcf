const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const articles = require('../cache/company/AAPL.json').news.data.slice(0, 3);
const savedTranslations = require('../cache/news_translations.json');
const translatedArticle = articles.find(article => Object.hasOwn(savedTranslations.titles, article.title));

(async () => {
  assert.equal(articles.length, 3, 'Use actual captured news as test fixtures');
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let mode = 'pages';
    let translationRequests = 0, translationFailure = false;
    assert.ok(translatedArticle, 'Use a genuinely translated and saved Vertex headline as the fixture');
    await page.route('http://company-news.test/cache/news_translations.json', route => {
      translationRequests++;
      return route.fulfill({ status: translationFailure ? 503 : 200, contentType: 'application/json',
        body: JSON.stringify({ ...savedTranslations, titles: {
          [translatedArticle.title]: savedTranslations.titles[translatedArticle.title]
        } }) });
    });
    const pages = [];
    await page.route('http://company-news.test/api/fmp?**', route => {
      const number = Number(new URL(route.request().url()).searchParams.get('page'));
      pages.push(number);
      return route.fulfill({ status: mode === 'error' ? 503 : 200, contentType: 'application/json',
        body: JSON.stringify(mode === 'error' ? { error: 'FMP_NOT_CONFIGURED' } : {
          data: mode === 'empty' ? [] : number === 0 ? articles.slice(0, 2) : articles.slice(1),
          source: { symbol: 'AAPL', provider: 'FMP' }, page: number, hasMore: mode === 'pages' && number === 0
        }) });
    });
    await page.setContent('<base href="http://company-news.test/"><div id="news"></div>');
    await page.addScriptTag({ path: path.resolve(__dirname, '..', 'fmp_cache.js') });
    await page.addScriptTag({ path: path.resolve(__dirname, '..', 'company_data.js') });
    const render = language => page.evaluate(async ({ articles, language }) =>
      CompanyData.renderNews(document.getElementById('news'), 'AAPL', articles, language), { articles, language });
    await render('en');
    assert.equal(translationRequests, 0, 'English view needs no translation cache');
    assert.equal(await page.locator('#news article').count(), 2);
    await page.getByRole('button', { name: 'Load more FMP company news' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#news article').length === 3);
    assert.deepEqual(pages, [0, 1]);
    assert.match(await page.locator('#news').innerText(), /3 articles loaded/);
    assert.equal(await page.locator('#news [data-news-more]').isVisible(), false);
    for (const anchor of await page.locator('#news article a').all()) {
      assert.match(await anchor.getAttribute('href'), /^https?:\/\//);
      assert.equal(await anchor.getAttribute('rel'), 'noopener noreferrer');
    }
    mode = 'empty';
    await render('en');
    assert.equal(await page.locator('#news article').count(), 3);
    assert.match(await page.locator('#news').innerText(), /previously captured articles, not a refreshed feed/);
    mode = 'error';
    await render('en');
    assert.match(await page.locator('#news').innerText(), /FMP_NOT_CONFIGURED/);
    assert.match(await page.locator('#news').innerText(), /not a successful live refresh/);
    assert.equal(await page.getByRole('button', { name: 'Retry FMP news' }).isEnabled(), true);
    mode = 'empty';
    await render('zh');
    assert.match(await page.locator('#news').innerText(), /\u5148\u524d\u64f7\u53d6/);
    assert.match(await page.locator('[data-news-language]').innerText(), /AI.*Vertex AI/);
    const translatedRow = page.locator('#news article').filter({ hasText: savedTranslations.titles[translatedArticle.title].text });
    assert.equal(await translatedRow.locator('a').innerText(), savedTranslations.titles[translatedArticle.title].text);
    assert.equal(await translatedRow.locator('details p').textContent(), translatedArticle.title);
    assert.equal(await translatedRow.locator('a').getAttribute('href'), translatedArticle.url);
    assert.equal(translationRequests, 1);
    await render('en');
    assert.ok((await page.locator('#news article a').allTextContents()).includes(translatedArticle.title));
    await render('zh');
    assert.equal(translationRequests, 1, 'Language toggles reuse saved cache, with no Vertex inference request');
    assert.match(await page.locator('#news').innerText(), /\u5c1a\u7121\u7ffb\u8b6f/);
    translationFailure = true;
    await page.addScriptTag({ path: path.resolve(__dirname, '..', 'company_data.js') });
    await render('zh');
    assert.match(await page.locator('[data-news-language]').innerText(), /NEWS_TRANSLATION_HTTP_503/);
    assert.deepEqual(await page.locator('#news article a').allTextContents(), articles.map(article => article.title));
    assert.deepEqual(errors, []);
    const hk = await browser.newPage(), requests = [];
    let release = null, hold = false;
    await hk.route('http://hk-company-news.test/**', async route => {
      const u = new URL(route.request().url());
      if (u.pathname === '/cache/news_translations.json') return route.fulfill({ json: savedTranslations });
      if (!u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'text/html', body: '<div id="news"></div>' });
      const symbol = u.searchParams.get('symbol'), number = Number(u.searchParams.get('page'));
      requests.push({ symbol, page: number });
      if (hold && symbol === 'HKXCY') await new Promise(resolve => { release = resolve; });
      const data = symbol === 'HKXCY' ? (number ? articles.slice(1) : articles.slice(0, 2))
        .map(row => ({ ...row, symbol })) : [];
      return route.fulfill({ json: { data, page: number, hasMore: symbol === 'HKXCY' && number === 0,
        source: { symbol, provider: 'FMP', capturedAt: '2026-10-17T00:00:00Z' } } });
    });
    await hk.goto('http://hk-company-news.test/');
    for (const name of ['fmp_cache.js', 'company_data.js']) await hk.addScriptTag({ path: path.resolve(__dirname, '..', name) });
    await hk.evaluate(() => CompanyData.renderNews(document.getElementById('news'), '0388.HK', [], 'en'));
    assert.deepEqual(requests.map(row => row.symbol), ['0388.HK'], 'Empty HK coverage never automatically substitutes an ADR');
    assert.match(await hk.locator('#news').innerText(), /no company news/);
    await hk.selectOption('[data-news-listing-select]', 'HKXCY');
    await hk.waitForFunction(() => document.querySelectorAll('#news article').length === 2);
    assert.match(await hk.locator('[data-news-listing]').innerText(), /Same issuer, different listing: HKXCY/);
    assert.match(await hk.locator('#news article').first().innerText(), /HKXCY/);
    await hk.getByRole('button', { name: 'Load more FMP company news' }).click();
    await hk.waitForFunction(() => document.querySelectorAll('#news article').length === 3);
    const beforeLanguage = requests.length;
    await hk.evaluate(() => CompanyData.renderNews(document.getElementById('news'), '0388.HK', [], 'zh'));
    assert.equal(await hk.locator('[data-news-listing-select]').inputValue(), 'HKXCY', 'Language changes preserve the explicitly chosen listing');
    assert.equal(requests.length, beforeLanguage, 'Listing responses reuse the persistent cache');
    await assert.rejects(() => hk.evaluate(() =>
      CompanyData.renderNews(document.getElementById('news'), '0388.HK', [], 'en', 'AAPL')), /UNVERIFIED_NEWS_LISTING/);
    hold = true;
    const started = hk.waitForRequest(request => request.url().includes('symbol=HKXCY'));
    await hk.getByRole('button', { name: '重新查詢 FMP 新聞' }).click();
    await started;
    await hk.evaluate(() => CompanyData.renderNews(document.getElementById('news'), '0939.HK', [], 'en'));
    while (!release) await new Promise(resolve => setImmediate(resolve));
    release();
    await hk.waitForLoadState('networkidle');
    assert.equal(await hk.locator('[data-news-listing-select]').inputValue(), '0939.HK');
    assert.equal(await hk.locator('#news article').count(), 0, 'A delayed old-listing response cannot overwrite the next issuer');
    console.log('Company news browser PASS: actual captured articles, pagination, deduplication, safe links, dated archive fallback and explicit API errors.');
    console.log('HK listing browser PASS (routing fixtures): explicit same-issuer selection, original-symbol provenance, language persistence, cached pagination and stale-response protection.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
