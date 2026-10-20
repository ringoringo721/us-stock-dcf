const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const Models = require('../fmp_models.js');
const Liquidation = require('../liquidation.js');
const market = require('../hk_market_dcf.json');
const config = require('../hkex_stocks.json');
const Peers = require('../peer_comparison.js');
const Currency = require('../usd_currency.js');
const hkdRates = require('../cache/fx/hkd_rates.json');
const Overview = require('../profile_overview.js');
const root = path.resolve(__dirname, '..', 'public');
const catalogue = require('../cache/hkex_universe.json');
const HkUniverse = require('../hkex_universe.js');
const annualViews = new Map();
function annualView(ticker) {
  if (!annualViews.has(ticker)) {
    const financialFile = path.join(root, 'cache', 'financials', `${ticker}_statements_v2.json`);
    const companyFile = path.join(root, 'cache', 'hk_companies', `${ticker}.json`);
    const stock = market[ticker] || (fs.existsSync(companyFile)
      ? JSON.parse(fs.readFileSync(companyFile)).stock
      : HkUniverse.listingStock(catalogue.stocks.find(item => item.ticker === ticker)));
    const data = fs.existsSync(financialFile) ? JSON.parse(fs.readFileSync(financialFile)) : HkUniverse.emptyStatements(ticker);
    const rates = data.hkdFxSource ? JSON.parse(fs.readFileSync(path.join(root, data.hkdFxSource.path))) : hkdRates;
    annualViews.set(ticker, Peers.annualView(stock, Currency.convertStatements(data, rates)));
  }
  return annualViews.get(ticker);
}

function expectedAnnualCells(stock) {
  const fy = stock.peerAnnual;
  const number = (type, field) => Number.isFinite(fy[type][field]) ? fy[type][field] : NaN;
  const money = value => Number.isFinite(value) ? `HKD ${Math.round(value).toLocaleString('en-US')}M` : 'N/A';
  const multiple = value => Number.isFinite(value) ? `${value.toFixed(2)}x` : 'N/A';
  const percent = value => Number.isFinite(value) ? `${value.toFixed(2)}%` : 'N/A';
  const ratio = (a, b) => Number.isFinite(a) && b > 0 ? a / b : NaN;
  const rev = number('income', 'revenue'), ni = number('income', 'netIncome');
  const eb = number('income', 'ebitda'), op = number('income', 'operatingIncome');
  const fcf = number('cashflow', 'freeCashFlow'), debt = number('balance', 'totalDebt');
  const eq = number('balance', 'totalStockholdersEquity'), assets = number('balance', 'totalAssets');
  const net = number('balance', 'netDebt'), interest = Math.abs(number('income', 'interestExpense'));
  const totalIntangibles = number('balance', 'goodwillAndIntangibleAssets');
  const intangibles = Number.isFinite(totalIntangibles) ? totalIntangibles
    : number('balance', 'goodwill') + number('balance', 'intangibleAssets');
  const cells = {
    'Market Cap ($M)': money(stock.mcap), 'Enterprise Value EV ($M)': money(stock.EV),
    'EV / FCF': multiple(ratio(stock.EV, fcf)), 'EV / EBITDA': multiple(stock.ev_to_ebitda),
    'EV / Revenue': multiple(ratio(stock.EV, rev)), 'Market Cap / FCF': multiple(ratio(stock.mcap, fcf)),
    'Market Cap / EBITDA': multiple(ratio(stock.mcap, eb)),
    'P/E (latest full FY)': Number.isFinite(stock.pe_trailing) ? `${stock.pe_trailing.toFixed(1)}x` : 'N/A',
    'P/B (latest FY-end)': multiple(stock.pb_trailing),
    'FY Cash Dividends / Current Market Cap %': percent(stock.div_yield),
    'Revenue ($M)': money(rev), 'Gross Profit ($M)': money(number('income', 'grossProfit')),
    'Gross Profit Margin %': percent(number('income', 'grossProfit') / rev * 100),
    'Operating Profit ($M)': money(op), 'Operating Margin %': percent(op / rev * 100),
    'Net Profit ($M)': money(ni), 'Net Profit Margin %': percent(ni / rev * 100),
    'EBITDA ($M)': money(eb), 'EBITDA Margin %': percent(eb / rev * 100),
    'Operating Cash Flow ($M)': money(number('cashflow', 'netCashProvidedByOperatingActivities')),
    'Capital Expenditure ($M)': money(Math.abs(number('cashflow', 'capitalExpenditure'))),
    'Free Cash Flow ($M)': money(fcf), 'FCF / Revenue %': percent(fcf / rev * 100),
    'FCF / Net Income %': percent(fcf / ni * 100), 'FCF / Equity %': percent(fcf / eq * 100),
    'ROE %': percent(stock.roe), 'ROA %': percent(stock.roa),
    'ROIC % (Est.)': percent(ratio(op * 0.79, debt + eq) * 100),
    'Debt / EBITDA': multiple(stock.debt_to_ebitda), 'Net Debt / EBITDA': multiple(stock.net_debt_to_ebitda),
    'Debt / FCF': multiple(ratio(debt, fcf)), 'Net Debt / FCF': multiple(ratio(net, fcf)),
    'Current Ratio': Number.isFinite(stock.current_ratio) ? stock.current_ratio.toFixed(2) : 'N/A',
    'EBITDA Interest Coverage': !Number.isFinite(interest) || !Number.isFinite(eb) ? 'N/A'
      : interest === 0 ? 'No interest expense' : multiple(eb / interest),
    'Total Assets ($M)': money(assets), 'Total Debt ($M)': money(debt),
    'Total Equity ($M)': money(eq), 'Tangible Net Worth ($M)': money(eq - intangibles),
    'Total Debt / Equity %': percent(ratio(debt, eq) * 100),
    'Net Debt / Equity %': percent(ratio(net, eq) * 100),
    'Total Debt / Total Assets %': percent(ratio(debt, assets) * 100)
  };
  for (const [label, field] of [['Revenue Growth YoY %', 'revenue'], ['Gross Profit Growth YoY %', 'grossProfit'],
    ['Operating Profit YoY %', 'operatingIncome'], ['Net Profit Growth YoY %', 'netIncome'],
    ['EBITDA Growth YoY %', 'ebitda'], ['Operating Cashflow YoY %', 'operatingCashFlow'],
    ['Free Cash Flow YoY %', 'freeCashFlow']]) {
    const { value, transition } = fy.growth[field];
    cells[label] = transition === 'positiveToNegative' ? 'Positive to negative'
      : transition === 'negativeToPositive' ? 'Negative to positive'
        : Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}% (FY)` : 'N/A';
  }
  return cells;
}

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
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], failures = [], api = [];
    const base = `http://127.0.0.1:${server.address().port}`;
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.url().startsWith(base) && response.status() >= 400) failures.push(response.url());
    });
    await page.route('https://cdn.jsdelivr.net/npm/chart.js', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.Chart=class {static defaults={font:{}};constructor(canvas,config){this.data=config.data;this.options=config.options;}destroy(){}update(){}};'
    }));
    await page.route('**/s3.tradingview.com/**', route => route.abort());
    await page.route('**/api/fmp?**', route => {
      api.push(new URL(route.request().url()).searchParams.get('action'));
      return route.fulfill({ json: { data: [], page: 0, hasMore: false } });
    });
    await page.goto(`${base}/?market=HKEX`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => isAppReady);
    assert.equal(await page.locator('#screener-tbody tr').count(), 100);
    assert.equal(await page.locator('#stat-total').innerText(), '2787');
    await page.locator('#screener-more').click();
    assert.equal(await page.locator('#screener-tbody tr').count(), 200);
    await page.evaluate(() => {
      document.getElementById('search-ticker').value = '87001';
      renderScreenerTable();
    });
    assert.equal(await page.locator('#screener-tbody tr').count(), 1);
    assert.match(await page.locator('#screener-tbody').innerText(), /87001\.HK/);
    await page.evaluate(tickers => {
      document.getElementById('search-ticker').value = '';
      localStorage.setItem('M7_FAVORITES', JSON.stringify(tickers));
      currentValFilter = 'FAVORITES'; renderScreenerTable();
    }, config.map(item => item.ticker));
    assert.equal(await page.locator('#screener-tbody tr').count(), config.length);
    assert.equal(await page.locator('#screener-table thead th').count(), 36);
    assert.equal(await page.locator('[data-i18n="th_premium"]').count(), 0);
    for (const language of ['zh', 'en']) {
      await page.evaluate(language => applyLanguage(language), language);
      assert.equal(await page.locator('#screener-tbody tr').count(), config.length);
      const metrics = await page.locator('#screener-tbody tr').evaluateAll(rows => rows.map(row => ({
        ticker: row.cells[0].textContent.match(/\b\d{4}\.HK\b/)[0],
        pe: row.querySelector('[data-metric="pe_trailing"]').textContent.trim(),
        pb: row.querySelector('[data-metric="pb_trailing"]').textContent.trim(),
        peNote: row.querySelector('[data-metric="pe_trailing"]').title,
        pbNote: row.querySelector('[data-metric="pb_trailing"]').title,
        leverage: [...row.querySelectorAll('[data-metric$="_to_ebitda"]')].map(cell => ({
          metric: cell.dataset.metric, text: cell.textContent.trim(), note: cell.title, style: cell.getAttribute('style')
        })),
        liquidation: [...row.querySelectorAll('.liquidation-value')].map(cell => cell.dataset.value === '' ? null : Number(cell.dataset.value))
      })));
      for (const row of metrics) {
        const stock = market[row.ticker];
        assert.ok(stock, row.ticker);
        for (const [label, key] of [['pe', 'pe_trailing'], ['pb', 'pb_trailing']]) {
          assert.equal(row[label], Number.isFinite(stock[key]) ? stock[key].toFixed(1) : 'N/A', row.ticker);
          assert.ok(row[label + 'Note'].length, `${row.ticker}/${language}/${label}: basis or gap explanation`);
        }
        assert.deepEqual(row.liquidation, Liquidation.calculate(stock.liquidation, row.ticker).values
          .map(value => value === null ? null : Number(value.toFixed(2))), `${row.ticker}/${language}/liquidation`);
        if (stock.reportedMultiples) {
          assert.equal(row.leverage.length, 3, row.ticker);
          for (const cell of row.leverage) {
            const value = stock[cell.metric], digits = cell.metric === 'ev_to_ebitda' ? 1 : 2;
            assert.equal(cell.text, Number.isFinite(value) ? `${value.toFixed(digits)}x` : 'N/A',
              `${row.ticker}/${language}/${cell.metric}`);
            assert.ok(cell.note.includes(stock.reportedMultiples.balanceDate), row.ticker);
            if (stock.reportedMultiples.reasons[cell.metric] === 'nonPositiveEbitda') {
              assert.match(cell.note, language === 'en' ? /zero or negative.*not meaningful/ : /零或負數.*不具可比性/);
              assert.ok(!cell.style.includes('var(--green)'), `${row.ticker}: N/A is not net cash`);
            }
            if (cell.metric === 'net_debt_to_ebitda' && Number.isFinite(value) && value < 0) {
              assert.ok(cell.style.includes('var(--green)'), `${row.ticker}: genuine net cash`);
            }
            if (stock.reportedMultiples.reasons[cell.metric] === 'currentMarketCapUnavailable') {
              assert.match(cell.note, language === 'en' ? /quote is stale/ : /報價已過期/);
            }
          }
        }
      }
    }
    for (const [ticker, stock] of Object.entries(market)) {
      const company = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'company', `${ticker}.json`)));
      const expected = stock.fin_valuation.is_financial ? null : Models.value(company, 'advanced', stock);
      await page.evaluate(ticker => openCompanyProfile(ticker), ticker);
      await page.waitForFunction(ticker => stockUniverse[ticker].companyDataLoaded
        && document.getElementById('profile-overview-status').textContent.startsWith(ticker), ticker);
      assert.equal(await page.locator('.sub-tab-btn').count(), 9, ticker);
      assert.equal(await page.locator('#profile-quote-price').innerText(),
        stock.price === null ? 'N/A'
          : `HKD ${stock.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, ticker);
      if (stock.quoteAvailability?.reason === 'staleQuote') {
        assert.match(await page.locator('#profile-quote-ticker').innerText(), /last trade.*not current/i);
      }
      for (const tab of ['financials', 'ratios', 'peers', 'charts', 'rating', 'valuation', 'news', 'chart']) {
        await page.evaluate(tab => switchSubPage(tab), tab);
        if (tab === 'peers') {
          await page.waitForFunction(ticker => document.querySelector('#cmp-peers-table[data-peer-period="annual"]')
            ?.querySelector('th.peer-current')?.dataset.peerTicker === ticker, ticker);
          assert.match(await page.locator('#subpage-peers .panel-title').innerText(), /Latest Full Fiscal Year/);
          assert.equal(await page.locator('[data-peer-label="Forward P/E"]').count(), 0);
          const cells = await page.locator('#subpage-peers').evaluate(root => {
            const tickers = [...root.querySelectorAll('[data-peer-ticker]')].map(th => th.dataset.peerTicker);
            return [...root.querySelectorAll('tbody tr[data-peer-label]')].flatMap(row =>
              [...row.cells].slice(1).map((cell, index) => ({
                ticker: tickers[index], metric: row.dataset.peerLabel,
                text: cell.textContent.trim(), note: cell.title,
                growthReason: cell.querySelector('[data-peer-growth]')?.title
              })));
          });
          assert.ok(cells.length >= 3, ticker);
          for (const cell of cells) {
            const stock = annualView(cell.ticker);
            assert.ok(stock, `${ticker}: peer column ${cell.ticker}`);
            const expected = expectedAnnualCells(stock)[cell.metric];
            if (expected !== undefined) assert.equal(cell.text, expected, `${ticker}/${cell.ticker}/${cell.metric}/FY peer`);
            if (stock.peerAnnual.date) assert.ok(cell.note.includes(stock.peerAnnual.date), `${ticker}: FY peer source date`);
            else assert.ok(cell.note.length, `${ticker}: unavailable FY explanation`);
            if (cell.growthReason) assert.doesNotMatch(cell.growthReason, /^Could not load or parse original statements/,
              `${ticker}/${cell.ticker}: unavailable annual growth is not a loading failure`);
          }
        }
        if (tab === 'financials' && stock.revenueProvenance) {
          await page.selectOption('#statement-type', 'income');
          await page.selectOption('#statement-period', 'annual');
          for (const [label, key, percent] of [['Revenue', 'revenue'], ['Gross Profit', 'grossProfit'],
            ['Net Income', 'netIncome'], ['Gross Profit Ratio', 'grossProfitRatio', true],
            ['Net Income Ratio', 'netIncomeRatio', true]]) {
            const cells = await page.evaluate(label => {
              const row = [...document.querySelectorAll('#cmp-fin-tbody tr')]
                .find(row => row.cells[0].textContent.trim() === label);
              return row ? [...row.cells].slice(1, 7).map(cell => cell.textContent.trim()) : null;
            }, label);
            assert.ok(cells, `${ticker}/${label}: rendered row`);
            assert.deepEqual(cells.map(text => text === 'N/A' ? null : Number(text.replace(/[^\d.-]/g, ''))),
              (stock.statements_raw.income[key] || Array(6).fill(null)).map(value => !Number.isFinite(value) ? null
                : percent ? Number((value * 100).toFixed(2)) : Math.round(value)), `${ticker}/${label}`);
          }
          assert.match(await page.locator('#statement-status').innerText(), /cited issuer reports/);
          assert.ok(await page.locator('#statement-status a').count(), `${ticker}: visible report links`);
          if (stock.revenueProvenance.interimPeriods?.length) {
            await page.selectOption('#statement-period', 'semiannual');
            assert.match(await page.locator('#cmp-fin-thead').innerText(), /I2.*12M/s, ticker);
            for (const row of stock.revenueProvenance.interimPeriods.filter(row =>
              stock.statements_raw.quarterly_raw.dates.includes(row.date.slice(0, 7)))) {
              const url = stock.revenueProvenance.documents[row.sourceId].url;
              assert.ok((await page.locator('#statement-status a').evaluateAll(links => links.map(link => link.href))).includes(url),
                `${ticker}/${row.date}: second-interim source link`);
            }
            await page.selectOption('#statement-period', 'annual');
          }
          for (const [type, label, key] of [['balance', 'Total Assets', 'totalAssets'],
            ['cashflow', 'Net Cash from Operating Activities', 'netCashProvidedByOperatingActivities']]) {
            await page.selectOption('#statement-type', type);
            await page.selectOption('#statement-period', 'annual');
            const rendered = await page.evaluate(label => {
              const row = [...document.querySelectorAll('#cmp-fin-tbody tr')]
                .find(row => row.cells[0].textContent.trim() === label);
              return row ? [...row.cells].slice(1, 7).map(cell => cell.textContent.trim()) : null;
            }, label);
            const expected = stock.statements_raw[type][key];
            assert.ok(rendered, `${ticker}/${type}: annual statement rendered`);
            assert.ok(expected.some(Number.isFinite), `${ticker}/${type}: saved actual financials`);
            assert.deepEqual(rendered.map(text => text === 'N/A' ? null : Number(text.replace(/[^\d.-]/g, ''))),
              expected.map(value => Number.isFinite(value) ? Math.round(value) : null), `${ticker}/${type}`);
          }
          await page.selectOption('#statement-type', 'income');
        }
        if (tab === 'rating' && stock.ratingSources?.moat?.reason === 'staleEvidence') {
          assert.equal(await page.locator('#moat-total-score').innerText(), 'N/A', ticker);
          assert.match(await page.locator('#moat-updated-date').innerText(), /Archived assessment; not refreshed/);
          assert.equal(await page.locator('#moat-previous-assessment').count(), stock.moat ? 1 : 0);
        } else if (tab === 'rating') {
          const dimensions = Object.entries(stock.moat).filter(([key]) => /^m\d+_/.test(key));
          assert.equal(dimensions.filter(([, item]) => Number.isFinite(item.score)).length, 10, ticker);
          assert.equal(await page.locator('#moat-total-score').innerText(),
            `${dimensions.reduce((total, [, item]) => total + item.score, 0)} / 100`, ticker);
          assert.equal(await page.locator('#moat-previous-assessment').count(), 0, ticker);
          assert.ok((await page.locator('#moat-overall-text').innerText()).length, ticker);
        }
        if (tab === 'valuation') {
          if (stock.fin_valuation.is_financial) {
            await page.waitForFunction(ticker => document.getElementById('fin-rote-history-status').textContent.startsWith(ticker)
              && document.querySelectorAll('[data-rote-year]').length === 10, ticker);
            const saved = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'rote_history', `${ticker}.json`)));
            assert.deepEqual(await page.locator('[data-rote-year]').allTextContents(), saved.years.map(row =>
              `${row.value.toFixed(2)}%${row.warnings.length ? ' *' : ''}`), ticker);
            assert.equal(await page.locator('#fmp-workspace:visible').count(), 0);
          } else {
            await page.waitForFunction(value => {
              const text = document.getElementById('det-res-fair').textContent;
              return value === null ? text.trim() === 'N/A' : Math.abs(Number(text.replace(/[^\d.-]/g, '')) - value) < 0.011;
            }, expected.fairVal);
            if (stock.corporateDcfApplicability === 'requiresSegmentValuation') {
              assert.equal(await page.locator('#fmp-workspace:visible').count(), 0);
              assert.match(await page.locator('#det-res-status').innerText(), /segment valuation/i);
            }
          }
        }
      }
      assert.doesNotMatch(await page.locator('#company-view').innerText(), /\bNaN\b|\bundefined\b/, ticker);
    }
    for (const language of ['en', 'zh']) {
      await page.evaluate(language => applyLanguage(language), language);
      for (const [ticker, field, transition] of [
        ['0296.HK', 'ebitda', 'negativeToPositive'],
        ['0487.HK', 'netIncome', 'positiveToNegative'],
        ['1680.HK', 'freeCashFlow', 'positiveToNegative']
      ]) {
        await page.evaluate(ticker => { openCompanyProfile(ticker); switchSubPage('peers'); }, ticker);
        await page.waitForFunction(ticker => document.querySelector('#cmp-peers-table[data-peer-period="annual"]')
          ?.querySelector('th.peer-current')?.dataset.peerTicker === ticker, ticker);
        const cell = page.locator(`td.peer-current [data-peer-growth="${field}"]`);
        const text = language === 'zh'
          ? transition === 'negativeToPositive' ? '負轉正' : '正轉負'
          : transition === 'negativeToPositive' ? 'Negative to positive' : 'Positive to negative';
        assert.equal(await cell.innerText(), text, `${ticker}/${language}/sign change`);
        assert.equal(await cell.getAttribute('data-growth-transition'), transition);
        const record = annualView(ticker).peerAnnual.growth[field];
        const title = await cell.getAttribute('title');
        assert.ok(title.includes(record.previousDate) && title.includes(record.date),
          `${ticker}/${language}: both fiscal-year dates remain disclosed`);
      }
    }
    await page.evaluate(() => { openCompanyProfile('3918.HK'); switchSubPage('peers'); applyLanguage('zh'); });
    await page.waitForFunction(() => document.querySelector('#cmp-peers-table[data-peer-period="annual"]')
      ?.querySelector('th.peer-current')?.dataset.peerTicker === '3918.HK');
    assert.match(await page.locator('#subpage-peers .panel-title').innerText(), /最新完整財年/);
    assert.match(await page.locator('#cmp-peers-table th.peer-current').innerText(), /FY 2025.*2025-12-31/s);
    assert.equal(await page.locator('[data-peer-label="Free Cash Flow ($M)"] td.peer-current').innerText(), 'HKD 2,364M');
    await page.evaluate(() => applyLanguage('en'));
    await page.waitForFunction(() => document.querySelector('#cmp-peers-table[data-peer-period="annual"]'));

    const nagaPath = '**/cache/financials/3918.HK_statements_v2.json';
    await page.route(nagaPath, route => route.abort('failed'));
    await page.evaluate(() => renderPeersSubPage({ ...stockUniverse['3918.HK'], ticker: '3918.HK' }, true));
    assert.match(await page.locator('#subpage-peers [role="alert"]').innerText(), /No TTM values are substituted/);
    assert.equal(await page.locator('#cmp-peers-table').count(), 0);
    await page.unroute(nagaPath);
    await page.locator('#peer-annual-retry').click();
    await page.waitForFunction(() => document.querySelector('#cmp-peers-table[data-peer-period="annual"]'));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(nagaPath, async route => { await gate; await route.continue(); });
    const requested = page.waitForRequest(request => request.url().endsWith('/cache/financials/3918.HK_statements_v2.json'));
    await page.evaluate(() => {
      window.pendingPeerRender = renderPeersSubPage({ ...stockUniverse['3918.HK'], ticker: '3918.HK' }, true);
    });
    await requested;
    assert.ok(!Peers.select(market, '0005.HK').peers.some(peer => peer.ticker === '3918.HK'));
    await page.evaluate(() => renderPeersSubPage({ ...stockUniverse['0005.HK'], ticker: '0005.HK' }));
    assert.equal(await page.locator('#cmp-peers-table th.peer-current').getAttribute('data-peer-ticker'), '0005.HK');
    release();
    await page.evaluate(() => window.pendingPeerRender);
    assert.equal(await page.locator('#cmp-peers-table th.peer-current').getAttribute('data-peer-ticker'), '0005.HK',
      'An older delayed annual request cannot overwrite the newer company');
    await page.unroute(nagaPath);

    await page.evaluate(() => { openCompanyProfile('0027.HK'); switchSubPage('rating'); applyLanguage('zh'); });
    assert.equal(await page.locator('#moat-total-score').innerText(),
      `${Object.entries(market['0027.HK'].moat).filter(([key]) => /^m\d+_/.test(key))
        .reduce((total, [, item]) => total + item.score, 0)} / 100`);
    assert.equal(await page.locator('#moat-previous-assessment').count(), 0);
    assert.match(await page.locator('#moat-overall-text').innerText(), /[\u3400-\u9fff]/);
    await page.evaluate(() => applyLanguage('en'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { location.hash = ''; renderScreenerTable(); });
    await page.selectOption('#screener-columns', 'all');
    assert.ok(await page.locator('#main-scroll-box').evaluate(element => element.scrollWidth > element.clientWidth));
    const usMarket = require('../full_market_dcf.json');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/?market=US`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => isAppReady && Object.keys(stockUniverse).length === 230);
    for (const language of ['en', 'zh']) {
      await page.evaluate(language => applyLanguage(language), language);
      const rendered = await page.locator('#screener-tbody tr').evaluateAll(rows => rows.map(row => ({
        ticker: row.cells[0].textContent.match(/\b[A-Z][A-Z0-9.-]*\b/)[0],
        metrics: Object.fromEntries(['pb_trailing', 'current_ratio', 'roe', 'roa', 'cash_to_assets', 'liab_to_assets']
          .map(field => {
            const cell = row.querySelector(`[data-metric="${field}"]`);
            return [field, { text: cell.textContent.trim(), title: cell.title }];
          }))
      })));
      assert.equal(rendered.length, 230);
      for (const row of rendered) {
        const stock = usMarket[row.ticker];
        assert.ok(stock, row.ticker);
        for (const [field, cell] of Object.entries(row.metrics)) {
          const percent = !['pb_trailing', 'current_ratio'].includes(field);
          assert.equal(cell.text, Number.isFinite(stock[field])
            ? stock[field].toFixed(field === 'current_ratio' ? 2 : 1) + (percent ? '%' : '') : 'N/A',
          `${row.ticker}/${language}/${field}`);
          assert.ok(cell.title.length, `${row.ticker}/${language}/${field}: visible basis and date`);
        }
      }
      const ms = rendered.find(row => row.ticker === 'MS');
      assert.equal(ms.metrics.current_ratio.text, '1.24');
      assert.equal(ms.metrics.roe.text, '18.7%');
      assert.doesNotMatch(ms.metrics.roe.text, /2022600000000/);
    }
    await page.evaluate(() => applyLanguage('en'));
    const usPeers = await page.evaluate(() => Object.keys(stockUniverse).map(ticker => {
      renderPeersSubPage({ ...stockUniverse[ticker], ticker });
      return { ticker, period: document.getElementById('cmp-peers-table').dataset.peerPeriod,
        growth: [...document.querySelectorAll('td.peer-current [data-peer-growth]')].map(cell => ({
          field: cell.dataset.peerGrowth, value: cell.dataset.growthValue, text: cell.textContent.trim()
        })) };
    }));
    for (const row of usPeers) {
      assert.equal(row.period, 'ttm', row.ticker);
      assert.equal(row.growth.length, 7, row.ticker);
      for (const cell of row.growth) {
        const record = Overview.storedGrowth(usMarket[row.ticker], cell.field);
        const available = record && !record.reason && Number.isFinite(record.value);
        assert.equal(cell.text, available ? `${record.value >= 0 ? '+' : ''}${record.value.toFixed(2)}%${record.basis === 'annual' ? ' (FY)' : ''}` : 'N/A',
          `${row.ticker}: US peer growth unchanged`);
        assert.equal(cell.value, available ? String(record.value) : '');
      }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(failures, []);
    assert.ok(api.every(action => action === 'news'), 'No live model, history or indicator API request is required');
    console.log(`Browser PASS: all ${config.length} HK company pages/nine tabs, full-FY peer financial values/growth/multiples and source dates, annual load failure/retry/race guards, unchanged TTM screener, all 230 US peer growth and balance/return rows including MS, native models, saved ROTE, both languages and mobile scrolling.`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
