#!/usr/bin/env node
/**
 * Boot regressions for US / HKEX screener load:
 * 1) Default bootWaitMs must NOT be Number(null)===0.
 * 2) Hung us_expansion_data.js must hydrate from listings immediately (no「載入中…」wait).
 * 3) Late-arriving US expansion must upgrade a premature baseline lock.
 * 4) Late-arriving HKEX expansion must upgrade listingStock stubs (e.g. 3983.HK),
 *    matching the US late-upgrade path — HK listings already cover the full count,
 *    so ticker-count checks alone cannot detect the premature stub lock.
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
  // --- 1) Happy path: absent bootWaitMs defaults to 8s, merges ~966 ---
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
          rows: document.querySelectorAll('#screener-tbody tr').length,
          moreHidden: document.getElementById('screener-more')?.hidden,
          showAllPresent: !!document.getElementById('screener-all'),
          tip: document.getElementById('screener-page-tip')?.textContent || '',
        }));
        assert.equal(probe.waitMs, 8000, `bootWaitMs must default to 8000, got ${probe.waitMs}`);
        assert.ok(probe.universe > 900, `expected ~966, got ${probe.universe}`);
        assert.ok(!/載入|Load/i.test(probe.stat), `still loading: ${probe.stat}`);
        assert.ok(String(probe.stat).includes('966') || Number(probe.stat) > 900, `stat ${probe.stat}`);
        // US screener must paginate — rendering all ~966 rows (~4MB HTML) freezes paint.
        assert.equal(probe.rows, 100, `expected first page 100 rows, got ${probe.rows}`);
        assert.equal(probe.moreHidden, false);
        assert.equal(probe.showAllPresent, false, 'show-all must stay removed (Chrome unresponsive)');
        assert.match(probe.tip, /\+100/);
        await page.locator('#screener-more').click();
        assert.equal(await page.locator('#screener-tbody tr').count(), 200);
        assert.equal(errors.length, 0, errors.join('\n'));
        console.log('happy', probe);
      });
    } finally {
      server.close();
    }
  }

  // --- 2) Hung expansion: listings alone must clear「載入中…」quickly (<2s) ---
  {
    const server = await startServer({
      'us_expansion_data.js': () => { /* hang */ },
    });
    try {
      await withPage(server, '/?market=US', async (page, errors) => {
        const t0 = Date.now();
        await page.waitForFunction(
          () => isAppReady && Object.keys(stockUniverse || {}).length > 200
            && !/載入|Load/i.test(document.getElementById('stat-total')?.textContent || ''),
          null,
          { timeout: 15000 },
        );
        const elapsed = Date.now() - t0;
        const probe = await page.evaluate(() => ({
          expansion: !!window.US_EXPANSION,
          listings: window.US_LISTINGS?.stocks?.length || 0,
          universe: Object.keys(stockUniverse || {}).length,
          stat: document.getElementById('stat-total')?.textContent || '',
        }));
        assert.equal(probe.expansion, false);
        assert.ok(probe.listings > 200, `expected listings, got ${probe.listings}`);
        assert.ok(probe.universe > 200, `expected merged universe, got ${probe.universe}`);
        assert.ok(elapsed < 5000, `listings hydrate took too long: ${elapsed}ms`);
        assert.equal(errors.length, 0, errors.join('\n'));
        console.log('hung-expansion', { elapsed, probe });
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
      'us_universe_data.js': async (req, res) => {
        await new Promise(r => setTimeout(r, 800));
        const file = path.join(root, 'us_universe_data.js');
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.end(fs.readFileSync(file));
      },
    });
    try {
      await withPage(server, '/?market=US&bootWaitMs=300', async (page, errors) => {
        await page.waitForFunction(() => isAppReady, null, { timeout: 20000 });
        const early = await page.evaluate(() => Object.keys(stockUniverse).length);
        releaseExpansion();
        await page.waitForFunction(
          () => window.US_EXPANSION && Object.keys(stockUniverse).length > 500
            && !/載入|Load/i.test(document.getElementById('stat-total')?.textContent || ''),
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

  // --- 4) HKEX late expansion upgrade: 3983.HK must leave listingStock N/A ---
  {
    const vm = require('node:vm');
    const expansionCode = fs.readFileSync(path.join(root, 'hkex_expansion_data.js'), 'utf8');
    const expansionCtx = { window: {} };
    vm.runInNewContext(expansionCode, expansionCtx, { timeout: 60000 });
    const pack = expansionCtx.window.HKEX_EXPANSION;
    assert.ok(pack?.stocks?.['3983.HK']?.price, 'fixture requires packed 3983.HK');
    const miniExpansion = 'window.HKEX_EXPANSION = ' + JSON.stringify({
      version: pack.version || 1,
      stocks: { '3983.HK': pack.stocks['3983.HK'] },
      models: { '3983.HK': pack.models['3983.HK'] },
      snapshots: { '3983.HK': pack.snapshots['3983.HK'] },
    }) + ';\n';

    let releaseExpansion;
    const expansionGate = new Promise(resolve => { releaseExpansion = resolve; });
    const server = await startServer({
      'hkex_expansion_data.js': async (req, res) => {
        await expansionGate;
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.end(miniExpansion);
      },
    });
    try {
      await withPage(server, '/?market=HKEX&bootWaitMs=300', async (page, errors) => {
        await page.waitForFunction(
          () => isAppReady && window.HKEX_LISTINGS?.stocks?.length > 1000
            && !!stockUniverse['3983.HK'],
          null,
          { timeout: 60000 },
        );
        const early = await page.evaluate(() => {
          const s = stockUniverse['3983.HK'];
          return {
            price: s?.price,
            mcap: s?.mcap,
            expansionStatus: s?.expansion?.status,
            hadExpansion: !!window.HKEX_EXPANSION,
            fmp: !!window.FMP_MODEL_DATA?.stocks?.['3983.HK'],
          };
        });
        assert.equal(early.hadExpansion, false, 'expansion must still be gated');
        assert.equal(early.price, null, `stub price expected null, got ${early.price}`);
        assert.equal(early.expansionStatus, 'pendingCapture');
        assert.equal(early.fmp, false);

        releaseExpansion();
        await page.waitForFunction(
          () => window.HKEX_EXPANSION
            && stockUniverse['3983.HK']?.price != null
            && stockUniverse['3983.HK']?.expansion?.status === 'available'
            && !!window.FMP_MODEL_DATA?.stocks?.['3983.HK']?.models?.dcf,
          null,
          { timeout: 60000 },
        );
        const late = await page.evaluate(() => {
          const s = stockUniverse['3983.HK'];
          const dcf = window.FmpModels?.reference?.(
            window.FmpModels.record('3983.HK'), 'dcf', s
          );
          return {
            price: s?.price,
            mcap: s?.mcap,
            shares: s?.shares,
            expansionStatus: s?.expansion?.status,
            fmpDcf: dcf,
            wacc: (() => {
              try {
                const row = window.FmpModels.value(
                  window.FmpModels.record('3983.HK'), 'advanced', s
                );
                return row?.WACC ?? null;
              } catch {
                return null;
              }
            })(),
          };
        });
        assert.equal(late.expansionStatus, 'available');
        assert.ok(Number.isFinite(late.price) && late.price > 0, `price ${late.price}`);
        assert.ok(Number.isFinite(late.mcap) && late.mcap > 0, `mcap ${late.mcap}`);
        assert.ok(Number.isFinite(late.shares) && late.shares > 0, `shares ${late.shares}`);
        assert.ok(Number.isFinite(late.fmpDcf) && late.fmpDcf > 0, `fmpDcf ${late.fmpDcf}`);
        assert.ok(Number.isFinite(late.wacc) && late.wacc > 0, `wacc ${late.wacc}`);
        assert.equal(errors.length, 0, errors.join('\n'));
        console.log('hk-late-upgrade', { early, late });
      });
    } finally {
      server.close();
    }
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
