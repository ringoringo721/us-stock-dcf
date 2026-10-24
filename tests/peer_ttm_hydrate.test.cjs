const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { select } = require('../peer_comparison.js');

const root = path.resolve(__dirname, '..');

function loadMergedUsUniverse() {
  const context = { window: {}, console };
  context.window = context;
  for (const file of ['us_universe_data.js', 'us_expansion_data.js', 'market_data.js',
    'financial_industry.js', 'us_universe.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  }
  return {
    context,
    universe: context.UsUniverse.merge(context.FULL_MARKET_DATA, context.US_LISTINGS, context.US_EXPANSION)
  };
}

test('PYPL in-universe peers ship without statements_raw but company caches have TTM fields', () => {
  const { universe } = loadMergedUsUniverse();
  const selection = select(universe, 'PYPL');
  assert.deepEqual(selection.peers.map(peer => peer.ticker), ['GPN', 'AFRM', 'SOFI', 'IX', 'SYF']);
  assert.ok(selection.unavailable.length >= 5, 'supplier tickers outside universe are reported');
  for (const peer of selection.peers) {
    assert.equal(peer.stock.expansion?.status, 'available');
    assert.equal(peer.stock.statements_raw, undefined,
      `${peer.ticker} compact catalogue must omit statements_raw`);
    const record = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'us_companies', `${peer.ticker}.json`), 'utf8'));
    const revenue = record.stock.statements_raw.income.revenue;
    const fcf = record.stock.statements_raw.cashflow.freeCashFlow;
    const equity = record.stock.statements_raw.balance.totalStockholdersEquity;
    assert.ok(Array.isArray(revenue) && revenue.some(Number.isFinite), `${peer.ticker} revenue`);
    assert.ok(Array.isArray(fcf) && fcf.some(Number.isFinite), `${peer.ticker} fcf`);
    assert.ok(Array.isArray(equity) && equity.some(Number.isFinite), `${peer.ticker} equity`);
  }
});

test('UsUniverse.load restores statements_raw for PYPL peer GPN', async () => {
  const { context } = loadMergedUsUniverse();
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep)) return response.writeHead(403).end();
    fs.readFile(file, (error, bytes) => {
      if (error) return response.writeHead(404).end();
      response.setHeader('Content-Type', 'application/json');
      response.end(bytes);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  context.fetch = (url, options) => fetch(`http://127.0.0.1:${port}/${String(url).replace(/^\//, '')}`, options);
  try {
    const stock = await context.UsUniverse.load('GPN');
    assert.equal(stock.ticker, 'GPN');
    assert.ok(stock.statements_raw.income.revenue.some(Number.isFinite));
    assert.ok(stock.statements_raw.cashflow.freeCashFlow.at(-1) > 0);
    assert.ok(stock.statements_raw.balance.totalStockholdersEquity.some(Number.isFinite));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
