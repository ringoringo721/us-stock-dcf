#!/usr/bin/env node
/**
 * Boot regressions for US screener load:
 * 1) Default bootWaitMs must NOT be Number(null)===0 (locks at baseline 230).
 * 2) Hung us_expansion_data.js must not leave counts at 0; listings+baseline merge.
 * 3) Late-arriving expansion must upgrade a premature baseline lock.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');

function startServer(handlers = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    for (const [needle, handler] of Object.entries(handlers)) {
      if (pathname.includes(needle)) return handler(req, res, url);
    }
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8'
        : file.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'application/json');
      res.end(data);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function withPage(server, pathAndQuery, fn) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('https://cdn.jsdelivr.net/npm/chart.js', route => route.fulfill({
      contentType: 'application/javascript',
      body: 'window.Chart=class {static defaults={font:{}};constructor(){ }destroy(){}update(){}};',
    }));
    await page.route('**/s3.tradingview.com/**', route => route.abort());
    const port = server.address().port;
    await page.goto(`http://127.0.0.1:${port}${pathAndQuery}`, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await fn(page, errors);
  } finally {
    await browser.close();
  }
}

(async () => {
  // --- 1) Happy path: absent bootWaitMs must default to 20s, not 0 ---
  {
    const server = await startServer();
    try {
      await withPage(server, '/?market=US', async (page, errors) => {
        await page.waitForFunction(
          () => isAppReady && window.US_EXPANSION && Object.keys(stockUniverse).length > 500,
          null,
          { timeout: 60000 },
        );
        const probe = await page.evaluate(() => ({
          waitMs: window.__bootExpansionWaitMs,
          universe: Object.keys(stockUniverse).length,
          expansion: Object.keys(window.US_EXPANSION.stocks).length,
          listings: window.US_LISTINGS.stocks.length,
          stat: document.getElementById('stat-total').textContent,
        }));
        assert.equal(probe.waitMs, 20000, `bootWaitMs must default to 20000, got ${probe.waitMs}`);
        assert.ok(probe.universe > 900, `expected ~966, got ${probe.universe}`);
        assert.ok(!/^230\b/.test(probe.stat.trim()), `still baseline: ${probe.stat}`);
        assert.equal(errors.length, 0, errors.join('\n'));
        console.log('happy', probe);
      });
    } finally {
      server.close();
    }
  }

  // --- 2) Hung expansion: recover above 0 via listings merge ---
  {
    const server = await startServer({
      'us_expansion_data.js': () => { /* hang */ },
    });
    try {
      await withPage(server, '/?market=US&bootWaitMs=1500', async (page, errors) => {
        await page.waitForFunction(() => isAppReady, null, { timeout: 20000 });
        const probe = await page.evaluate(() => ({
          expansion: !!window.US_EXPANSION,
          listings: window.US_LISTINGS?.stocks?.length || 0,
          universe: Object.keys(stockUniverse || {}).length,
          stat: document.getElementById('stat-total')?.textContent || '',
        }));
        assert.equal(probe.expansion, false);
        assert.ok(probe.listings > 200, `expected listings, got ${probe.listings}`);
        assert.ok(probe.universe > 200, `expected merged universe, got ${probe.universe}`);
        assert.ok(!/^0\b/.test(probe.stat.trim()), `stat still blank: ${probe.stat}`);
        assert.equal(errors.length, 0, errors.join('\n'));
        console.log('hung-expansion', probe);
      });
    } finally {
      server.close();
    }
  }

  // --- 3) Late expansion upgrade after premature baseline ---
  {
    let releaseExpansion;
    const expansionGate = new Promise(resolve => { releaseExpansion = resolve; });
    const server = await startServer({
      'us_expansion_data.js': async (req, res) => {
        await expansionGate;
        const file = path.join(root, 'us_expansion_data.js');
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.end(fs.readFileSync(file));
      },
      // Delay listings slightly so first ready can be baseline if wait is tiny — then
      // release both; with bootWaitMs=0 intentionally via bug would lock at 230, but
      // we use bootWaitMs=500 and delay expansion only: listings arrive, merge ~966
      // stubs, then expansion upgrades rich rows. Also cover upgrade from baseline:
      // delay BOTH listings and expansion past a short wait.
      'us_universe_data.js': async (req, res) => {
        await new Promise(r => setTimeout(r, 800));
        const file = path.join(root, 'us_universe_data.js');
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.end(fs.readFileSync(file));
      },
    });
    try {
      await withPage(server, '/?market=US&bootWaitMs=300', async (page, errors) => {
        // Short wait + delayed listings → may lock baseline first.
        await page.waitForFunction(() => isAppReady, null, { timeout: 20000 });
        const early = await page.evaluate(() => Object.keys(stockUniverse).length);
        // Release expansion (and listings may already be in).
        releaseExpansion();
        await page.waitForFunction(
          () => window.US_EXPANSION && Object.keys(stockUniverse).length > 500,
          null,
          { timeout: 30000 },
        );
        const late = await page.evaluate(() => ({
          universe: Object.keys(stockUniverse).length,
          expansion: Object.keys(window.US_EXPANSION.stocks).length,
          stat: document.getElementById('stat-total').textContent,
        }));
        assert.ok(late.universe > 900, `late upgrade failed: early=${early} late=${late.universe}`);
        assert.equal(errors.length, 0, errors.join('\n'));
        console.log('late-upgrade', { early, late });
      });
    } finally {
      server.close();
    }
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
