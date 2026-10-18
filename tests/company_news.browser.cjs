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
    assert.equal(await page.locator('#news button').isVisible(), false);
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
    console.log('Company news browser PASS: actual captured articles, pagination, deduplication, safe links, dated archive fallback and explicit API errors.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
