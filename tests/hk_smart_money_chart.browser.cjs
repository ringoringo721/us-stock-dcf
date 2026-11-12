#!/usr/bin/env node
/**
 * HK Smart Money southbound Chart.js reuse (any ticker):
 * overlapping renderHkSmartMoneySubPage() must destroy/reuse the shared canvas
 * without throwing, and must not poison the DI timeline with「載入 DI 時間線失敗」.
 * Covers every committed seed under cache/hk-smart-money/*.HK.json.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const seedDir = path.join(root, 'cache', 'hk-smart-money');
const TICKERS = fs.readdirSync(seedDir)
  .filter((name) => /^\d+\.HK\.json$/i.test(name))
  .map((name) => name.replace(/\.json$/i, ''))
  .sort();

const CHART_STUB = `
(() => {
  const byCanvas = new WeakMap();
  let nextId = 1;
  class Chart {
    static defaults = { font: {} };
    static getChart(canvas) {
      const el = typeof canvas === 'string' ? document.getElementById(canvas) : canvas;
      return el ? byCanvas.get(el) : undefined;
    }
    constructor(ctx, config) {
      const canvas = ctx && ctx.canvas ? ctx.canvas : ctx;
      if (byCanvas.has(canvas)) {
        throw new Error(
          "Canvas is already in use. Chart with ID '" + byCanvas.get(canvas).id
          + "' must be destroyed before the canvas with ID '"
          + (canvas.id || '') + "' can be reused."
        );
      }
      this.id = nextId++;
      this.canvas = canvas;
      this.data = config?.data;
      this.options = config?.options;
      byCanvas.set(canvas, this);
    }
    destroy() {
      if (this.canvas) byCanvas.delete(this.canvas);
      this.canvas = null;
    }
    update() {}
  }
  window.Chart = Chart;
})();
`;

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8'
        : file.endsWith('.js') ? 'application/javascript; charset=utf-8'
          : file.endsWith('.json') ? 'application/json' : 'text/plain');
      res.end(data);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  assert.ok(TICKERS.length >= 2, `expected ≥2 HK smart-money seeds, got ${TICKERS.join(',')}`);
  const server = await startServer();
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));

    await page.route('https://cdn.jsdelivr.net/npm/chart.js**', route => route.fulfill({
      contentType: 'application/javascript',
      body: CHART_STUB,
    }));
    await page.route('**/s3.tradingview.com/**', route => route.abort());
    // Avoid live HKEX/SFC during the race test — seed is enough for chart+DI path.
    await page.route('**/api/hk-smart-money**', route => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'TEST_STUB_NO_LIVE' }),
    }));

    const port = server.address().port;
    await page.goto(`http://127.0.0.1:${port}/#${TICKERS[0]}/smart-money`, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await page.waitForFunction(() => typeof isAppReady !== 'undefined' && isAppReady
      && typeof renderHkSmartMoneySubPage === 'function'
      && typeof Chart !== 'undefined' && typeof Chart.getChart === 'function', null, { timeout: 90000 });

    await page.evaluate(() => {
      if (typeof setLanguage === 'function') setLanguage('zh');
      else if (typeof currentLang !== 'undefined') currentLang = 'zh';
    });

    const results = [];
    for (const ticker of TICKERS) {
      const race = await page.evaluate(async (sym) => {
        const stock = stockUniverse[sym] || { ticker: sym, exchange: 'HKEX' };
        const dict = (typeof I18N_DICT !== 'undefined' && I18N_DICT.zh) || {};
        // Match real navigation: activeCompanyTicker gates the loadStock().then() body.
        activeCompanyTicker = sym;
        // Overlap two renders the way tab re-entry / hash navigation can.
        renderHkSmartMoneySubPage(sym, stock, false, dict);
        renderHkSmartMoneySubPage(sym, stock, false, dict);
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const status = document.getElementById('smart-money-hk-status')?.textContent || '';
          const di = document.getElementById('cmp-smart-money-hk-di-tbody')?.textContent || '';
          const chart = Chart.getChart(document.getElementById('smart-money-hk-sb-chart'));
          const loading = /載入港股智資|Loading HK Smart Money/i.test(status);
          if (!loading && (chart || /DI|南向|暫無|未見|incomplete|unavailable/i.test(status + di))) {
            break;
          }
          await new Promise(r => setTimeout(r, 50));
        }
        const canvas = document.getElementById('smart-money-hk-sb-chart');
        const diText = document.getElementById('cmp-smart-money-hk-di-tbody')?.textContent || '';
        const status = document.getElementById('smart-money-hk-status')?.textContent || '';
        return {
          ticker: sym,
          status,
          diFail: /載入 DI 時間線失敗/.test(diText),
          hasChart: !!Chart.getChart(canvas),
          chartId: Chart.getChart(canvas)?.id ?? null,
          gen: window._hkSbChartGen || 0,
          canvasReuseMsg: /Canvas is already in use/i.test(status),
        };
      }, ticker);

      assert.equal(race.diFail, false, `${ticker} DI poisoned`);
      assert.equal(race.canvasReuseMsg, false, `${ticker} status shows canvas reuse`);
      assert.ok(race.hasChart, `${ticker} expected southbound chart; status=${race.status}`);
      results.push(race);
      console.log('hk_smart_money_chart_ok', race);
    }

    // Cross-ticker navigation: leave one chart instance, then race on another ticker.
    const [a, b] = TICKERS;
    await page.evaluate(async (pair) => {
      const dict = (typeof I18N_DICT !== 'undefined' && I18N_DICT.zh) || {};
      const sa = stockUniverse[pair[0]] || { ticker: pair[0], exchange: 'HKEX' };
      const sb = stockUniverse[pair[1]] || { ticker: pair[1], exchange: 'HKEX' };
      activeCompanyTicker = pair[0];
      renderHkSmartMoneySubPage(pair[0], sa, false, dict);
      await new Promise(r => setTimeout(r, 80));
      activeCompanyTicker = pair[1];
      renderHkSmartMoneySubPage(pair[1], sb, false, dict);
      renderHkSmartMoneySubPage(pair[1], sb, false, dict);
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const status = document.getElementById('smart-money-hk-status')?.textContent || '';
        if (!/載入港股智資|Loading HK Smart Money/i.test(status)
          && Chart.getChart(document.getElementById('smart-money-hk-sb-chart'))) {
          break;
        }
        await new Promise(r => setTimeout(r, 50));
      }
    }, [a, b]);
    const cross = await page.evaluate(() => {
      const diText = document.getElementById('cmp-smart-money-hk-di-tbody')?.textContent || '';
      const status = document.getElementById('smart-money-hk-status')?.textContent || '';
      return {
        diFail: /載入 DI 時間線失敗/.test(diText),
        canvasReuseMsg: /Canvas is already in use/i.test(status),
        hasChart: !!Chart.getChart(document.getElementById('smart-money-hk-sb-chart')),
        status,
      };
    });
    assert.equal(cross.diFail, false, `cross-ticker DI poisoned: ${cross.status}`);
    assert.equal(cross.canvasReuseMsg, false, `cross-ticker canvas reuse: ${cross.status}`);
    assert.ok(cross.hasChart, `cross-ticker expected chart; status=${cross.status}`);
    console.log('hk_smart_money_chart_cross_ok', { from: a, to: b, ...cross });

    assert.equal(errors.filter(e => /Canvas is already in use/i.test(e)).length, 0,
      errors.join('\n'));
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('hk_smart_money_chart_all_ok', { tickers: TICKERS, n: results.length });
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
