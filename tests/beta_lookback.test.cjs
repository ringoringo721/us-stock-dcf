const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Beta = require('../beta_lookback.js');
const Price = require('../price_history.js');

const near = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);

function series(start, count, startPrice, dailyReturn) {
  const rows = [];
  let price = startPrice;
  const day = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    const ret = typeof dailyReturn === 'function' ? dailyReturn(i) : dailyReturn;
    if (i) price *= 1 + ret;
    rows.push([day.toISOString().slice(0, 10), price, 1000]);
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return rows;
}

test('OLS beta recovers a known levered relationship on aligned daily returns', () => {
  const market = series('2020-01-01', 800, 100, i => 0.001 * ((i % 7) - 3));
  const stock = [[market[0][0], 50, 1000]];
  for (let i = 1; i < market.length; i++) {
    const rm = market[i][1] / market[i - 1][1] - 1;
    stock.push([market[i][0], stock[i - 1][1] * (1 + 1.5 * rm), 1000]);
  }
  const result = Beta.olsBeta(stock, market, 2);
  assert.equal(result.reason, null);
  near(result.beta, 1.5, 1e-9);
  near(result.r2, 1, 1e-9);
  assert.ok(result.n >= Beta.minReturns(2));
});

test('insufficient overlap and zero benchmark variance stay N/A with reasons', () => {
  const short = series('2024-01-01', 40, 10, 0.01);
  const bench = series('2024-01-01', 40, 100, 0.005);
  assert.equal(Beta.olsBeta(short, bench, 1).reason, 'insufficientOverlappingReturns');
  const stock = series('2023-01-01', 400, 10, i => 0.01 * ((i % 5) - 2));
  const flat = series('2023-01-01', 400, 100, 0);
  assert.equal(Beta.olsBeta(stock, flat, 1).reason, 'zeroBenchmarkVariance');
});

test('provider mode and bank Ke helper preserve HK percent CAPM and US floor', () => {
  assert.equal(Beta.bankKeFromBeta({ ticker: '1398.HK', rf: 5.09, erp: 4.75 }, 0.135), 5.09 + 0.135 * 4.75);
  assert.equal(Beta.bankKeFromBeta({ ticker: 'JPM', fin_valuation: { is_financial: true } }, 0.5), 9);
  assert.equal(Beta.bankKeFromBeta({ ticker: 'AAPL' }, 1.2), 4.3 + 1.2 * 4.75);
});

test('AAPL vs SPY and 0700.HK vs 2800.HK produce finite OLS betas from committed caches', () => {
  const load = (folder, ticker) => {
    const chart = path.join(__dirname, '..', 'cache', folder, `${ticker}.json`);
    const raw = JSON.parse(fs.readFileSync(chart, 'utf8'));
    return folder === 'price_charts' ? Price.validate(raw, ticker) : Beta.validateSeries(raw, ticker, { allowBootstrap: true });
  };
  const aapl = load('price_charts', 'AAPL');
  const spy = load('beta_benchmarks', 'SPY');
  const tencent = load('price_charts', '0700.HK');
  const trahk = load('beta_benchmarks', '2800.HK');
  for (const years of Beta.WINDOWS) {
    const us = Beta.olsBeta(aapl.rows, spy.rows, years);
    assert.equal(us.reason, null, `AAPL ${years}y: ${us.reason}`);
    assert.ok(Number.isFinite(us.beta), `AAPL ${years}y beta`);
    const hk = Beta.olsBeta(tencent.rows, trahk.rows, years);
    assert.equal(hk.reason, null, `0700 ${years}y: ${hk.reason}`);
    assert.ok(Number.isFinite(hk.beta), `0700 ${years}y beta`);
  }
});

test('cache keys encode ticker, benchmark and lookback window', () => {
  assert.equal(Beta.cacheKey('AAPL', 3, 'SPY'), 'beta:v1:AAPL|SPY|3y|ols-daily');
  assert.equal(Beta.cacheKey('0700.HK', 5, '2800.HK'), 'beta:v1:0700.HK|2800.HK|5y|ols-daily');
});
