#!/usr/bin/env node
/**
 * HK Smart Money southbound Chart.js reuse:
 * overlapping renderHkSmartMoneySubPage() must destroy/reuse the canvas without
 * throwing, and must not poison the DI timeline with「載入 DI 時間線失敗」.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');

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
    // 1398.HK is seeded with ≥2 southbound history points (chart path).
    await page.goto(`http://127.0.0.1:${port}/#1398.HK/smart-money`, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await page.waitForFunction(() => typeof isAppReady !== 'undefined' && isAppReady
      && typeof renderHkSmartMoneySubPage === 'function'
      && typeof Chart !== 'undefined' && typeof Chart.getChart === 'function', null, { timeout: 90000 });

    // Force Traditional Chinese for DI error-string checks.
    await page.evaluate(() => {
      if (typeof setLanguage === 'function') setLanguage('zh');
      else if (typeof currentLang !== 'undefined') currentLang = 'zh';
    });

    const race = await page.evaluate(async () => {
      const stock = stockUniverse['1398.HK'] || { ticker: '1398.HK', exchange: 'HKEX' };
      const dict = (typeof I18N_DICT !== 'undefined' && I18N_DICT.zh) || {};
      // Overlap two renders the way tab re-entry / hash navigation can.
      renderHkSmartMoneySubPage('1398.HK', stock, false, dict);
      renderHkSmartMoneySubPage('1398.HK', stock, false, dict);
      // Wait until status settles and chart exists (or DI empty message — not load failure).
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
      return {
        status: document.getElementById('smart-money-hk-status')?.textContent || '',
        diText,
        hasChart: !!Chart.getChart(canvas),
        chartId: Chart.getChart(canvas)?.id ?? null,
        gen: window._hkSbChartGen || 0,
        diFail: /載入 DI 時間線失敗/.test(diText),
        canvasReuse: false,
      };
    });

    assert.equal(race.diFail, false, `DI poisoned: ${race.diText}`);
    assert.ok(race.gen >= 2, `expected ≥2 chart gens after double render, got ${race.gen}`);
    assert.ok(race.hasChart, `expected southbound chart after seed load; status=${race.status}`);
    assert.equal(errors.filter(e => /Canvas is already in use/i.test(e)).length, 0,
      errors.join('\n'));
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('hk_smart_money_chart_ok', race);
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
