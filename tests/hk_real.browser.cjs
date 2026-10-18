const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const Ratios = require('../fcf_ratios.js');
const Currency = require('../usd_currency.js');
const market = require('../hk_market_dcf.json');
const rates = require('../cache/fx/hkd_rates.json');
const { calculate: calculateFcff } = require('../fcff.js');
const root = path.resolve(process.env.TEST_STATIC_ROOT || path.resolve(__dirname, '..'));
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));

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
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], failed = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.url().startsWith(url) && response.status() >= 400) failed.push(response.url());
    });
    if (process.env.CHART_VENDOR) await page.route('https://cdn.jsdelivr.net/npm/chart.js', route =>
      route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(process.env.CHART_VENDOR) }));
    await page.route('**/s3.tradingview.com/**', route => route.abort());
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${url}/?market=HKEX`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => isAppReady);
    await page.evaluate(() => applyLanguage('en'));
    assert.match(await page.locator('#market-select').innerText(), /🇺🇸 United States \(USD\)/);
    assert.match(await page.locator('#market-select').innerText(), /🇭🇰 Hong Kong \(HKD\)/);
    assert.equal(await page.locator('#screener-tbody tr').count(), 6);
    assert.equal(await page.locator('#screener-tbody tr').first().locator('td').count(), 34);
    assert.deepEqual(await page.evaluate(() => Object.keys(stockUniverse)), Object.keys(market));
    for (const [ticker, stock] of Object.entries(market)) {
      const forecast = stock.pe_forward_source;
      assert.equal(forecast.reason, null, `${ticker}: supported analyst forecast`);
      assert.equal(forecast.basis, 'nextFiscalYearConsensusEps');
      assert.ok(forecast.fiscalDate > forecast.asOf);
      const fx = Currency.rateFor(rates, stock.reportedCurrency, null,
        forecast.fx.observationDate, 'closing', 'HKD');
      const forwardPe = stock.price / (forecast.eps * fx.rate);
      assert.ok(Math.abs(stock.pe_forward - forwardPe) < 1e-10, `${ticker}: price / FY1 EPS in HKD`);
      const forwardCell = page.locator('#screener-tbody tr').filter({ hasText: ticker })
        .locator('[data-metric="pe_forward"]');
      assert.equal(await forwardCell.innerText(), forwardPe.toFixed(1));
      assert.equal(await forwardCell.getAttribute('title'), forecast.noteEn);
      const raw = read(`cache\\financials\\${ticker}_statements_v2.json`);
      const statements = Currency.convertStatements(raw, rates);
      const prices = read(`cache\\price_charts\\${ticker}.json`);
      await page.evaluate(ticker => openCompanyProfile(ticker), ticker);
      await page.waitForFunction(({ ticker, date }) =>
        document.getElementById('profile-overview-status').textContent.startsWith(ticker)
        && document.getElementById('profile-overview-retry').hidden
        && document.getElementById('profile-overview-status').textContent.includes(date),
      { ticker, date: statements.quarterly.income.at(-1).date });
      assert.equal(await page.locator('.sub-tab-btn').count(), 9);
      const overviewForward = page.getByRole('rowheader', { name: 'Forward P/E', exact: true })
        .locator('..').locator('td');
      assert.equal(await overviewForward.innerText(), `${forwardPe.toFixed(2)}×`);
      assert.equal(await overviewForward.getAttribute('title'), forecast.noteEn);
      assert.equal(await page.locator('#profile-quote-price').innerText(),
        `HKD ${stock.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      assert.match(await page.locator('#cmp-currency-note').innerText(), new RegExp(stock.reportedCurrency));
      await page.waitForFunction(() => !document.getElementById('price-history-plots').hidden);
      assert.equal(await page.evaluate(() => Chart.getChart('price-chart').options.scales.y.title.text), 'HKD');
      assert.equal(prices.currency, 'HKD');
      await page.evaluate(() => switchSubPage('rating'));
      assert.equal(await page.locator('#moat-breakdown-body tr').count(), 10);
      assert.equal(await page.locator('#fscore-breakdown-body tr').count(), 9);
      assert.equal(await page.locator('#fsc-total-score').innerText(), stock.f_score == null ? 'N/A' : `${stock.f_score} / 9`);
      assert.equal(await page.locator('#moat-total-score').innerText(),
        await page.evaluate(ticker => evaluateMoat(stockUniverse[ticker]).scoreText, ticker));
      assert.doesNotMatch(await page.locator('#moat-total-score').innerText(), /N\/A.*pt/);
      const moat = await page.evaluate(ticker => evaluateMoat(stockUniverse[ticker]), ticker);
      const moatRows = page.locator('#moat-breakdown-body tr');
      for (let i = 0; i < moat.m.length; i++) {
        const cell = moatRows.nth(i).locator('.moat-score-cell');
        if (moat.m[i] === null) {
          assert.equal(await cell.innerText(), 'Not assessed', `${ticker}: missing dimension ${i + 1}`);
          assert.equal(await cell.locator('.moat-bar-bg').count(), 0, 'Unknown is not a zero-length score bar');
          assert.match(await cell.locator('span').getAttribute('title'), /not a zero score/);
        } else {
          assert.equal((await cell.innerText()).trim(), `${moat.m[i]} / 10`);
          assert.equal(await cell.locator('.moat-bar-bg').count(), 1);
        }
      }
      if (ticker === '0700.HK') {
        assert.equal(moat.m[1], null, 'Do not invent a Tencent patent/regulatory assessment');
        assert.equal(await page.locator('#moat-cat-intangible').innerText(), `${moat.m[0]} / 10 · 1/2`);
        const total = await page.locator('#moat-total-score').innerText();
        await page.evaluate(() => applyLanguage('zh'));
        assert.equal(await moatRows.nth(1).locator('.moat-score-cell').innerText(), '未評分');
        assert.match(await moatRows.nth(1).locator('.moat-score-cell span').getAttribute('title'), /不代表零分/);
        assert.equal(await page.locator('#moat-total-score').innerText(), total);
        assert.ok(await moatRows.nth(1).locator('td').nth(1).evaluate(el => el.getBoundingClientRect().width >= 190));
        assert.ok(await moatRows.nth(1).locator('td').last().evaluate(el => el.getBoundingClientRect().width >= 380));
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(await page.locator('.moat-table').evaluate(el =>
          el.getBoundingClientRect().width >= 1180 && el.parentElement.scrollWidth > el.parentElement.clientWidth));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          'The moat table scrolls inside its wrapper, not the whole mobile page');
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => applyLanguage('en'));
      }
      await page.evaluate(() => switchSubPage('charts'));
      for (const selector of ['#fcf-ratio-period', '#return-ratio-period', '#earnings-period']) {
        await page.selectOption(selector, 'semiannual');
        if (stock.reportingFrequency !== 'semiannual') await page.selectOption(selector, 'quarterly');
      }
      await page.selectOption('#balance-period', stock.reportingFrequency === 'semiannual' ? 'semiannual' : 'quarterly');
      await page.waitForFunction(() => document.getElementById('balance-body').children.length === 9);
      const balances = Ratios.calculateBalances(statements);
      assert.equal(await page.locator('#balance-date option').count(), balances.length, ticker);
      if (stock.reportingFrequency === 'semiannual') {
        assert.doesNotMatch(await page.locator('#balance-head').innerText(), /\bQ[1-4]\b/);
        assert.match(await page.locator('#balance-head').innerText(), /H1|H2/);
        await page.selectOption('#earnings-period', 'semiannual');
        await page.selectOption('#earnings-flow', 'ttm');
        await page.waitForFunction(() => document.getElementById('earnings-cards').children.length === 3);
        const expected = Ratios.calculateEarnings(statements).at(-1).amounts.eps;
        const annual = statements.annual.income.find(row => row.date === statements.quarterly.income.at(-1).date);
        assert.equal(expected.value, annual.epsDiluted);
        assert.equal(await page.locator('#earnings-cards strong').first().innerText(),
          annual.epsDiluted.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
        assert.equal(raw.quarterly.income.at(-1).epsDiluted, null);
      }
      if (stock.reportingFrequency !== 'semiannual') {
        await page.selectOption('#balance-period', 'semiannual');
        const half = Ratios.calculateBalances(statements, { period: 'semiannual' });
        await page.waitForFunction(count => document.querySelectorAll('#balance-date option').length === count, half.length);
        await page.selectOption('#balance-period', 'quarterly');
        await page.waitForFunction(count => document.querySelectorAll('#balance-date option').length === count, balances.length);
      }
      if (stock.statementFrequencies.cashflow === 'annual') {
        const fcf = Ratios.calculate(statements).at(-1);
        assert.equal(fcf.ratios.assets.reason, 'annualCashflowOnly');
      }
      for (const tab of ['financials', 'ratios', 'peers', 'valuation', 'news', 'chart']) {
        await page.evaluate(tab => switchSubPage(tab), tab);
        if (tab === 'peers') {
          const peerForward = page.locator('#cmp-peers-table tbody tr').filter({ hasText: /Forward P\/E/ })
            .locator('td').nth(1).locator('span');
          assert.equal(await peerForward.innerText(), `${forwardPe.toFixed(1)}x`);
          assert.equal(await peerForward.getAttribute('title'), forecast.noteEn);
          await page.evaluate(() => applyLanguage('zh'));
          const localized = page.locator('#cmp-peers-table tbody tr').filter({ hasText: /動態 P\/E/ })
            .locator('td').nth(1).locator('span');
          assert.equal(await localized.getAttribute('title'), forecast.noteZh);
          await page.evaluate(() => switchSubPage('basic'));
          await page.waitForFunction(() => [...document.querySelectorAll('.profile-metric-table th')]
            .some(el => el.textContent === '預估本益比'));
          assert.equal(await page.getByRole('rowheader', { name: '預估本益比', exact: true })
            .locator('..').locator('td').getAttribute('title'), forecast.noteZh);
          await page.evaluate(() => applyLanguage('en'));
          await page.evaluate(() => switchSubPage('peers'));
        }
        if (['financials', 'ratios'].includes(tab)) {
          const selector = tab === 'financials' ? '#statement-period' : '#ratio-period';
          await page.selectOption(selector, 'semiannual');
          assert.match(await page.locator(tab === 'financials' ? '#statement-status' : '#ratio-status').innerText(), /Half year/);
          if (stock.reportingFrequency !== 'semiannual') await page.selectOption(selector, 'quarterly');
        }
        if (tab === 'valuation' && !stock.fin_valuation.is_financial) {
          assert.equal(await page.locator('#det-res-fair').innerText(), 'N/A', 'Source guards remain effective by default');
          await page.locator('#fcff-input-controls summary').click();
          assert.equal(await page.locator('#fcff-openingWorkingCapital').isDisabled(), true);
          await page.locator('#fcff-confirm-financing').check();
          const edits = { leaseOverlap: 0, ...(ticker === '0388.HK'
            ? { openingWorkingCapital: 0, workingCapital: 0, discountRate: 10, cash: 0, investments: 0 } : {}),
          ...(ticker === '0823.HK' ? { tax: 0, minority: 0, investments: 0 } : {}) };
          for (const [key, value] of Object.entries(edits)) await page.locator(`#fcff-${key}`).fill(String(value));
          await page.locator('#fcff-input-controls summary').click();
          const { source, scenario } = await page.evaluate(ticker => ({
            source: HK_FCFF_DATA.stocks[ticker], scenario: stockUniverse[ticker].fcffScenario
          }), ticker);
          const expected = calculateFcff(source, scenario);
          assert.equal(expected.reason, null, `${ticker}: manual scenario ${expected.reason}`);
          assert.equal(await page.locator('#det-res-fair').innerText(),
            'HKD ' + expected.fairVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
          assert.match(await page.locator('#fcff-status').innerText(), /user|assumption/i);
          assert.equal(await page.evaluate(ticker => HK_FCFF_DATA.stocks[ticker].reason, ticker), source.reason);
        }
        if (tab === 'valuation' && stock.fin_valuation.is_financial) {
          assert.equal(await page.locator('#slider-fin-ke').isDisabled(), false);
          assert.equal(await page.locator('#disp-fin-ke').innerText(), `${stock.fin_valuation.ke.toFixed(2)}%`);
          assert.match(await page.locator('#fin-reference-note').innerText(), /USD Treasury 10Y proxy/);
          assert.equal(stock.fin_valuation.unavailableReason, null);
          assert.match(await page.locator('#fin-shares-mode').innerText(), /Source-default shares are applied automatically/);
          assert.equal(await page.locator('details:has(#fin-shares) > summary').innerText(), 'Custom share-count scenario (optional)');
          assert.match(await page.locator('#fin-shares-help').textContent(), /no checkbox confirmation is needed/);
          assert.notEqual(await page.locator('#det-res-fair').innerText(), 'N/A');
          const fin = stock.fin_valuation;
          const excess = fin.tbvps * (1 + (fin.rote - fin.ke) / Math.max(fin.ke - fin.g, 2));
          let dividend = fin.dps_total, ddm = 0;
          for (let year = 1; year <= 5; year++) { dividend *= 1.065; ddm += dividend / (1 + fin.ke / 100) ** year; }
          ddm += dividend * (1 + fin.g / 100) / Math.max((fin.ke - fin.g) / 100, 0.02) / (1 + fin.ke / 100) ** 5;
          const expected = excess * 0.55 + ddm * 0.45;
          const baseline = await page.locator('#det-res-fair').innerText();
          const shown = Number(baseline.replace(/[^\d.-]/g, ''));
          assert.ok(Math.abs(shown - expected) < 0.011, `${ticker}: ${shown} versus ${expected}`);
          if (ticker === '0939.HK') {
            assert.equal(stock.shares_outstanding, 261600381459);
            assert.equal(stock.shares, 261600.381459);
            assert.equal(stock.liquidation.sharesOutstanding, stock.shares_outstanding);
            assert.equal(fin.tbvps, fin.tangibleEquity / stock.shares);
            assert.match(await page.locator('#fin-reference-note').innerText(), /A \+ H.*261,600,381,459.*2026-09-30/);
            assert.equal(await page.locator('#fin-reference-note a').getAttribute('href'), stock.shareSource.providerSource);
            await page.evaluate(() => applyLanguage('zh'));
            assert.match(await page.locator('#fin-reference-note').innerText(), /全公司 A \+ H 普通股合計 261,600,381,459/);
            assert.equal(await page.locator('details:has(#fin-shares) > summary').innerText(), '自訂股數情境（選填）');
            assert.match(await page.locator('#fin-shares-mode').innerText(), /無須勾選或手動確認/);
            assert.match(await page.locator('#fin-shares-confirm + span').textContent(), /這是我的假設/);
            await page.evaluate(() => applyLanguage('en'));
            const missingMode = await page.evaluate(ticker => {
              const stock = stockUniverse[ticker], shares = stock.shares;
              try {
                stock.shares = null;
                renderFinancialReference(stock.fin_valuation);
                return document.getElementById('fin-shares-mode').textContent;
              } finally {
                stock.shares = shares;
                renderFinancialReference(stock.fin_valuation);
              }
            }, ticker);
            assert.match(missingMode, /Source-default shares are unavailable/);
            await page.locator('details:has(#fin-shares) > summary').click();
            await page.locator('#fin-shares').fill('261600');
            await page.evaluate(() => onFinSharesChange());
            assert.equal(await page.locator('#det-res-fair').innerText(), baseline, 'Unconfirmed assumptions cannot replace sourced shares');
            assert.match(await page.locator('#fin-shares-mode').innerText(), /Source-default shares are applied automatically/);
            await page.locator('#fin-shares-confirm').check();
            await page.evaluate(() => onFinSharesChange());
            assert.notEqual(await page.locator('#det-res-fair').innerText(), 'N/A');
            assert.match(await page.locator('#fin-reference-note').innerText(), /user-confirmed scenario/);
            assert.match(await page.locator('#fin-shares-mode').innerText(), /custom share-count scenario is active/);
            assert.equal(await page.locator('#fin-reference-note a').count(), 0, 'A scenario is not attributed to the issuer return');
            assert.equal(await page.evaluate(ticker => stockUniverse[ticker].fin_valuation.tbvps, ticker),
              stock.fin_valuation.tangibleEquity / 261600);
            await page.evaluate(() => saveCustomModel());
            await page.reload({ waitUntil: 'networkidle' });
            assert.equal(await page.locator('#fin-shares').inputValue(), '261600.00');
            assert.notEqual(await page.locator('#det-res-fair').innerText(), 'N/A');
            assert.match(await page.locator('#fin-reference-note').innerText(), /user-confirmed scenario/);
            assert.match(await page.locator('#fin-shares-mode').innerText(), /custom share-count scenario is active/);
            await page.evaluate(() => resetToFmpDefaults());
            assert.equal(await page.locator('#det-res-fair').innerText(), baseline);
            assert.equal(await page.evaluate(ticker => stockUniverse[ticker].shares, ticker), stock.shares);
            assert.match(await page.locator('#fin-reference-note').innerText(), /A \+ H.*261,600,381,459/);
            assert.match(await page.locator('#fin-shares-mode').innerText(), /Source-default shares are applied automatically/);
          }
        }
        if (tab === 'news' && !stock.news.length) assert.match(await page.locator('#cmp-news-list').innerText(), /N\/A/);
      }
      assert.doesNotMatch(await page.locator('#company-view').innerText(), /\bNaN\b|\bundefined\b/);
    }
    await page.goto(`${url}/?market=HKEX&test=forecast-tax#0823.HK/valuation`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => isAppReady && document.getElementById('fcff-tax'));
    await page.evaluate(() => applyLanguage('en'));
    await page.waitForFunction(() => document.getElementById('fcff-status').textContent.includes('Default forecast tax 16.50%'));
    assert.equal(await page.locator('#fcff-tax').inputValue(), '16.50');
    assert.match(await page.locator('label[for="fcff-tax"]').textContent(), /not reported group effective tax/);
    assert.match(await page.locator('#fcff-assumptions').textContent(), /not a reported group effective rate or a jurisdiction-weighted forecast/);
    assert.equal(await page.locator('#det-res-fair').innerText(), 'N/A', 'Tax approval does not waive other reconciliation guards');
    const sourceTax = await page.evaluate(() => ({
      tax: HK_FCFF_DATA.stocks['0823.HK'].defaults.tax,
      reason: HK_FCFF_DATA.stocks['0823.HK'].reason,
      history: HK_FCFF_DATA.stocks['0823.HK'].history
    }));
    await page.locator('#fcff-input-controls summary').click();
    await page.locator('#fcff-tax').fill('20');
    assert.equal(await page.evaluate(() => stockUniverse['0823.HK'].fcffScenario.tax), 20);
    await page.evaluate(() => applyLanguage('zh'));
    assert.equal(await page.locator('#fcff-tax').inputValue(), '20.00');
    assert.match(await page.locator('#fcff-status').innerText(), /預設預測稅率 16.50%.*不是實報集團有效稅率/);
    assert.match(await page.locator('label[for="fcff-tax"]').textContent(), /使用者同意的情境，非實報集團有效稅率/);
    await page.evaluate(() => resetToFmpDefaults());
    assert.equal(await page.locator('#fcff-tax').inputValue(), '16.50');
    assert.deepEqual(await page.evaluate(() => ({
      tax: HK_FCFF_DATA.stocks['0823.HK'].defaults.tax,
      reason: HK_FCFF_DATA.stocks['0823.HK'].reason,
      history: HK_FCFF_DATA.stocks['0823.HK'].history
    })), sourceTax, 'User tax edits and resets cannot rewrite historical tax or issuer evidence');
    await page.goto(`${url}/#0823.HK/charts`, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#market-select').inputValue(), 'HKEX');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width && rect.right > innerWidth + 1 && getComputedStyle(element).position !== 'fixed';
      }).slice(0, 20).map(element => ({ tag: element.tagName, id: element.id, class: element.className,
        width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right })))));
    assert.deepEqual(errors, []);
    assert.deepEqual(failed, []);
    console.log('PASS: six HKEX securities, sourced FY1 P/E across screener/overview/peers, localized missing Moat dimensions and mobile layout, disclosed/resettable Link forecast-tax scenario without changing history or source guards, real half years, HKD prices, HSBC/CCB automatic bank valuations and issuer-wide share scenario reset.');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
