const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Beta = require('../beta_lookback.js');
const Price = require('../price_history.js');

const near = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);

/** Independent OLS slope: β = Σ(x−x̄)(y−ȳ) / Σ(x−x̄)² on total returns [y=stock, x=bench]. */
function independentOlsSlope(stockReturns, benchReturns) {
  assert.equal(stockReturns.length, benchReturns.length);
  const n = stockReturns.length;
  const meanX = benchReturns.reduce((a, b) => a + b, 0) / n;
  const meanY = stockReturns.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varX = 0;
  for (let i = 0; i < n; i++) {
    const dx = benchReturns[i] - meanX, dy = stockReturns[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
  }
  return varX > 0 ? cov / varX : null;
}

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

function loadChart(folder, ticker) {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', folder, `${ticker}.json`), 'utf8'));
  return folder === 'price_charts' ? Price.validate(raw, ticker) : Beta.validateSeries(raw, ticker, { allowBootstrap: true });
}

test('OLS beta recovers exact known slope (stock = a + b·bench, zero noise)', () => {
  const market = series('2020-01-01', 800, 100, i => 0.001 * ((i % 7) - 3));
  for (const b of [0.5, 1.0, 1.5, 2.25]) {
    const stock = [[market[0][0], 50, 1000]];
    for (let i = 1; i < market.length; i++) {
      const rm = market[i][1] / market[i - 1][1] - 1;
      stock.push([market[i][0], stock[i - 1][1] * (1 + b * rm), 1000]);
    }
    const result = Beta.olsBeta(stock, market, 2);
    assert.equal(result.reason, null);
    near(result.beta, b, 1e-9);
    near(result.r2, 1, 1e-9);
    const aligned = Beta.alignedReturns(stock, market, 2);
    const indep = independentOlsSlope(aligned.returns.map(r => r[0]), aligned.returns.map(r => r[1]));
    near(result.beta, indep, 1e-12);
  }
});

test('OLS with additive noise recovers slope within tolerance and matches independent slope', () => {
  const market = series('2019-01-01', 1200, 100, i => 0.0012 * Math.sin(i / 5) + 0.0004 * ((i % 11) - 5));
  const stock = [[market[0][0], 40, 1000]];
  const trueBeta = 1.35;
  for (let i = 1; i < market.length; i++) {
    const rm = market[i][1] / market[i - 1][1] - 1;
    const noise = 0.0003 * Math.sin(i * 1.7);
    stock.push([market[i][0], stock[i - 1][1] * (1 + trueBeta * rm + noise), 1000]);
  }
  const result = Beta.olsBeta(stock, market, 3);
  assert.equal(result.reason, null);
  assert.ok(Math.abs(result.beta - trueBeta) < 0.05, `beta ${result.beta} far from ${trueBeta}`);
  const aligned = Beta.alignedReturns(stock, market, 3);
  const indep = independentOlsSlope(aligned.returns.map(r => r[0]), aligned.returns.map(r => r[1]));
  near(result.beta, indep, 1e-12);
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

test('AAPL/0700 spot OLS matches independent slope and stays in sane equity ranges', () => {
  const aapl = loadChart('price_charts', 'AAPL');
  const spy = loadChart('beta_benchmarks', 'SPY');
  const tencent = loadChart('price_charts', '0700.HK');
  const trahk = loadChart('beta_benchmarks', '2800.HK');
  const report = {};
  for (const years of Beta.WINDOWS) {
    const us = Beta.olsBeta(aapl.rows, spy.rows, years);
    assert.equal(us.reason, null, `AAPL ${years}y: ${us.reason}`);
    const usAligned = Beta.alignedReturns(aapl.rows, spy.rows, years);
    near(us.beta, independentOlsSlope(usAligned.returns.map(r => r[0]), usAligned.returns.map(r => r[1])), 1e-12);
    assert.ok(us.beta > 0.2 && us.beta < 2.5, `AAPL ${years}y outlier β=${us.beta}`);

    const hk = Beta.olsBeta(tencent.rows, trahk.rows, years);
    assert.equal(hk.reason, null, `0700 ${years}y: ${hk.reason}`);
    const hkAligned = Beta.alignedReturns(tencent.rows, trahk.rows, years);
    near(hk.beta, independentOlsSlope(hkAligned.returns.map(r => r[0]), hkAligned.returns.map(r => r[1])), 1e-12);
    assert.ok(hk.beta > 0.2 && hk.beta < 2.8, `0700 ${years}y outlier β=${hk.beta}`);

    report[`AAPL_${years}y`] = { beta: +us.beta.toFixed(4), n: us.n, r2: +us.r2.toFixed(3) };
    report[`0700_${years}y`] = { beta: +hk.beta.toFixed(4), n: hk.n, r2: +hk.r2.toFixed(3) };
  }
  console.log('SPOT_OLS', JSON.stringify(report));
});

test('currency mismatch and missing history reject without inventing beta', () => {
  const usd = series('2020-01-01', 400, 100, 0.001);
  const shortStock = series('2024-06-01', 30, 10, 0.01);
  assert.equal(Beta.olsBeta(shortStock, usd, 5).reason, 'insufficientOverlappingReturns');
  assert.equal(Beta.olsBeta(shortStock, usd, 5).beta, null);
  // resolve() rejects mismatched currencies before OLS; reasonText must stay explicit.
  assert.match(Beta.reasonText('currencyMismatch', 'en'), /currenc/i);
  assert.match(Beta.reasonText('insufficientOverlappingReturns', 'en'), /overlapping/i);
});

test('cache keys encode ticker, benchmark and lookback window', () => {
  assert.equal(Beta.cacheKey('AAPL', 3, 'SPY'), 'beta:v1:AAPL|SPY|3y|ols-daily');
  assert.equal(Beta.cacheKey('0700.HK', 5, '2800.HK'), 'beta:v1:0700.HK|2800.HK|5y|ols-daily');
});

test('FmpModels.applyBetaLookback writes the same OLS β into every scenario year', () => {
  const Scenario = require('../fmp_scenario.js');
  // Minimal stub scenario with 2 years of CAPM fields.
  const scenario = {
    version: 1, kind: 'advanced', symbol: 'AAPL', currency: 'USD', shares: 1,
    baseYear: 2024, baseRevenue: 100, openingNwc: 0, netDebt: 0, terminalGrowth: 2.5,
    workingCapitalMethod: 'cash-change-to-revenue',
    years: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(offset => ({
      year: 2024 + offset,
      values: {
        growth: 5, ebitda: 30, ebit: 25, da: 5, nwcChange: 0, capex: -8, tax: 21,
        beta: 1.07, rf: 4.3, erp: 4.75, kd: 5, ke: 4.3 + 1.07 * 4.75, debtWeight: 10
      },
      origins: { beta: 'retained-capital', ke: 'capm', rf: 'retained-capital', erp: 'retained-capital' }
    }))
  };
  const ols = 1.1635;
  for (let i = 0; i < 10; i++) Scenario.update(scenario, i, 'beta', ols);
  scenario.years.forEach(year => {
    near(year.values.beta, ols, 1e-12);
    near(year.values.ke, 4.3 + ols * 4.75, 1e-9);
    assert.equal(year.origins.ke, 'capm');
    assert.equal(year.origins.beta, 'user');
  });
});

test('valuation HTML sources expose 1–5y + FMP default beta lookback controls', () => {
  const modelsSrc = fs.readFileSync(path.join(__dirname, '..', 'fmp_models.js'), 'utf8');
  assert.match(modelsSrc, /id="fmp-beta-lookback-panel"/);
  assert.match(modelsSrc, /id="fmp-beta-row-lookback"/);
  assert.match(modelsSrc, /data-beta-lookback-select/);
  assert.match(modelsSrc, /betaProvenanceText/);
  assert.match(modelsSrc, /1y OLS|1 年 OLS/);
  for (const year of ['1', '2', '3', '4', '5']) {
    assert.match(modelsSrc, new RegExp(`\\['${year}'`));
  }
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(indexSrc, /id="profile-beta-lookback-panel"/);
  assert.match(indexSrc, /FmpModels\.applyBetaLookback/);
  // Guard against the layout regression that stacked year cells vertically.
  assert.doesNotMatch(indexSrc, /#fmp-ten-year-inputs \.fmp-assumption-cell \{\s*display:\s*flex/s);
  assert.match(indexSrc, /#fmp-workspace #fmp-ten-year-inputs > tbody > tr \{\s*[\s\S]*?display:\s*table-row !important/);
  assert.match(indexSrc, /#fmp-workspace #fmp-ten-year-inputs > tbody > tr > td \{\s*[\s\S]*?display:\s*table-cell !important/);
  assert.match(modelsSrc, /fmp-assumption-stack/);
  assert.match(modelsSrc, /data-year-index/);
});

test('spot-check liquid US/HK names and random cached charts yield finite OLS or honest reason', () => {
  const spy = loadChart('beta_benchmarks', 'SPY');
  const trahk = loadChart('beta_benchmarks', '2800.HK');
  const required = ['AAPL', 'GOOGL', 'TSM', 'NVDA', 'MSFT', 'JPM', '0700.HK', '1398.HK'];
  for (const ticker of required) {
    const chart = loadChart('price_charts', ticker);
    const bench = /\.HK$/i.test(ticker) ? trahk : spy;
    for (const years of [1, 3, 5]) {
      const result = Beta.olsBeta(chart.rows, bench.rows, years);
      assert.equal(result.reason, null, `${ticker} ${years}y: ${result.reason}`);
      assert.ok(Number.isFinite(result.beta), `${ticker} ${years}y beta`);
      assert.ok(result.beta > -1 && result.beta < 5, `${ticker} ${years}y outlier β=${result.beta}`);
    }
  }
  const chartDir = path.join(__dirname, '..', 'cache', 'price_charts');
  const usAll = fs.readdirSync(chartDir)
    .filter(name => /^[A-Z][A-Z0-9.-]*\.json$/.test(name) && !name.includes('.HK.'))
    .sort();
  const hkAll = fs.readdirSync(chartDir)
    .filter(name => /^\d{4}\.HK\.json$/.test(name))
    .sort();
  // Deterministic stride samples (≥10 US, ≥5 HK) across the published chart universe.
  const stride = (list, count) => {
    const step = Math.max(1, Math.floor(list.length / count));
    const out = [];
    for (let i = 0; i < list.length && out.length < count; i += step) out.push(list[i]);
    return out.map(name => name.replace(/\.json$/, ''));
  };
  const usSample = stride(usAll, 12);
  const hkSample = stride(hkAll, 6);
  const report = { usOk: 0, usNa: 0, hkOk: 0, hkNa: 0 };
  for (const ticker of usSample) {
    const chart = loadChart('price_charts', ticker);
    const result = Beta.olsBeta(chart.rows, spy.rows, 3);
    if (result.reason) {
      report.usNa += 1;
      assert.ok(['insufficientStockHistory', 'insufficientOverlappingReturns', 'zeroBenchmarkVariance'].includes(result.reason),
        `${ticker}: unexpected ${result.reason}`);
      assert.equal(result.beta, null);
    } else {
      report.usOk += 1;
      assert.ok(Number.isFinite(result.beta));
    }
  }
  for (const ticker of hkSample) {
    const chart = loadChart('price_charts', ticker);
    const result = Beta.olsBeta(chart.rows, trahk.rows, 3);
    if (result.reason) {
      report.hkNa += 1;
      assert.ok(['insufficientStockHistory', 'insufficientOverlappingReturns', 'zeroBenchmarkVariance'].includes(result.reason),
        `${ticker}: unexpected ${result.reason}`);
      assert.equal(result.beta, null);
    } else {
      report.hkOk += 1;
      assert.ok(Number.isFinite(result.beta));
    }
  }
  assert.ok(usSample.length >= 10, `US sample ${usSample.length}`);
  assert.ok(hkSample.length >= 5, `HK sample ${hkSample.length}`);
  assert.ok(report.usOk + report.usNa === usSample.length);
  assert.ok(report.hkOk + report.hkNa === hkSample.length);
  console.log('SAMPLE_OLS', JSON.stringify({ usSample, hkSample, report }));
});

test('price-load failure reasons distinguish missing chart vs invalid vs API', () => {
  assert.match(Beta.reasonText('priceChartMissing', 'en'), /cache missing|Published daily/i);
  assert.match(Beta.reasonText('priceChartInvalid', 'zh'), /無效|格式/);
  assert.match(Beta.reasonText('priceHistoryApiUnavailable', 'en'), /PriceHistory API/i);
  assert.match(Beta.reasonText('priceChartHttp404', 'en'), /HTTP 404/);
});
