const { test } = require('node:test');
const assert = require('node:assert/strict');
const { select } = require('../peer_comparison.js');
const market = require('../full_market_dcf.json');

test('CAT has related machinery references rather than falsely implying no competitors', () => {
  const result = select({ ...market, CAT: { ...market.CAT, peers: [] } }, 'CAT');
  assert.equal(result.peers.length, 5);
  assert.ok(result.peers.some(peer => peer.ticker === 'DE'));
  assert.equal(result.counts.industry, 0);
  assert.ok(result.peers.every(peer => peer.basis !== 'industry'));
});

test('All covered stocks have real, unique comparison companies with honest basis labels', () => {
  let previouslyEmpty = 0;
  const coverage = { industry: 0, provider: 0, related: 0 };
  for (const [ticker, stock] of Object.entries(market)) {
    if (!Object.entries(market).some(([other, candidate]) => other !== ticker
      && candidate.sector === stock.sector && candidate.industry === stock.industry)) previouslyEmpty++;
    const result = select(market, ticker);
    assert.ok(result.peers.length > 0 && result.peers.length <= 5, ticker);
    assert.equal(new Set(result.peers.map(peer => peer.ticker)).size, result.peers.length);
    assert.equal(Object.values(result.counts).reduce((sum, count) => sum + count, 0), result.peers.length);
    for (const peer of result.peers) {
      assert.notEqual(peer.ticker, ticker);
      assert.equal(peer.stock, market[peer.ticker]);
      assert.ok(peer.stock.statements_raw, `${ticker}/${peer.ticker} has real financial data`);
      assert.ok(['industry', 'provider', 'related'].includes(peer.basis));
      if (peer.basis === 'industry') {
        assert.equal(peer.stock.sector, stock.sector);
        assert.equal(peer.stock.industry, stock.industry);
      } else if (peer.basis === 'related') {
        assert.equal(peer.stock.sector, stock.sector, 'Related references never silently cross sectors');
        assert.notEqual(peer.stock.industry, stock.industry);
      } else {
        assert.ok(stock.peers.some(value => value.toUpperCase().replace(/[.-]/g, '') === peer.ticker.replace(/[.-]/g, '')));
      }
      coverage[peer.basis]++;
    }
  }
  console.log(`Peer health: ${Object.keys(market).length} stocks; ${previouslyEmpty} empty exact-industry groups; ${JSON.stringify(coverage)}`);
});

test('Provider peers are not discarded by industry labels or truncation before universe matching', () => {
  const stock = (industry, mcap, peers = []) => ({ sector: 'Sector', industry, mcap, peers });
  const universe = {
    A: stock('One', 100, ['OUT1', 'OUT2', 'OUT3', 'OUT4', 'OUT5', 'b', 'BRKB']),
    B: stock('Two', 80), 'BRK.B': stock('Three', 90), C: stock('One', 50)
  };
  const result = select(universe, 'a');
  assert.deepEqual(result.peers.map(peer => peer.ticker), ['C', 'BRK.B', 'B']);
  assert.deepEqual(result.peers.map(peer => peer.basis), ['industry', 'provider', 'provider']);
  assert.equal(result.unavailable.length, 5);
});

test('Alphabet share classes are not counted as competing companies or duplicated as references', () => {
  assert.ok(!select(market, 'GOOG').peers.some(peer => peer.ticker === 'GOOGL'));
  assert.ok(!select(market, 'GOOGL').peers.some(peer => peer.ticker === 'GOOG'));
  for (const ticker of Object.keys(market)) {
    const peers = select(market, ticker).peers.map(peer => peer.ticker);
    assert.ok(!(peers.includes('GOOG') && peers.includes('GOOGL')));
  }
});

test('Unknown industries do not fall back to arbitrary sector companies; ordering is stable', () => {
  const universe = {
    A: { sector: 'One', industry: 'Unknown', mcap: 50 },
    B: { sector: 'One', industry: 'Unrelated', mcap: 50 }
  };
  assert.deepEqual(select(universe, 'A').peers, []);
  assert.deepEqual(select(market, 'CAT'), select(Object.fromEntries(Object.entries(market).reverse()), 'CAT'));
  assert.throws(() => select(market, 'MISSING'), /Unknown comparison ticker/);
  assert.throws(() => select(market, 'CAT', 6), /Peer limit/);
});
