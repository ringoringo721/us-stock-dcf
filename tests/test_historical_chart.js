const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const functionStart = html.indexOf('  function renderDetailHistoricalChart(s) {');
const functionEnd = html.indexOf('\n  // ========================================================\n  // 7.', functionStart);
assert.notEqual(functionStart, -1, 'chart renderer exists');
assert.notEqual(functionEnd, -1, 'chart renderer section ends');
const rendererSource = html.slice(functionStart, functionEnd);

function chartHarness() {
  const elements = {
    detailDcfHistoricalChart: { style: {}, getContext: () => ({}) },
    'det-chart-status-badge': { textContent: '' },
    'det-chart-empty-state': { style: {}, textContent: '' }
  };
  const charts = [];
  class FakeChart {
    constructor(context, config) {
      this.config = config;
      charts.push(this);
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const context = vm.createContext({
    Date,
    document: { getElementById: id => elements[id] || null },
    currentLang: 'zh',
    I18N_DICT: { zh: {}, en: {} },
    Chart: FakeChart
  });
  vm.runInContext(`let detailHistoricalChartInstance = null;\n${rendererSource}\nthis.renderChart = renderDetailHistoricalChart;`, context);
  return { context, elements, charts };
}

test('renders only sourced, chronological prices and maps weekends to the prior close', () => {
  const { context, charts } = chartHarness();
  context.renderChart({
    price: 999,
    price_history_metadata: {
      status: 'fresh',
      adjustment_semantics_verified: true,
      price_basis: 'fixture split-normalized close'
    },
    real_5y_prices: [
      { date: '2025-01-06', close: 103 },
      { date: '2025-01-03', close: 100 },
      { date: '2025-01-03', close: 102 },
      { date: '2025-02-31', close: 999 },
      { date: '2025-01-07', close: Infinity }
    ],
    historical_valuations: [
      { valuation_date: '2025-01-05', fiscal_end_date: '2024-12-31', status: 'available', value_per_share: 110 },
      { valuation_date: '2025-04-01', status: 'unavailable', missing_reason: 'no input' }
    ]
  });
  const datasets = charts[0].config.data.datasets;
  assert.deepEqual(JSON.parse(JSON.stringify(datasets[1].data.map(point => [point.x, point.y]))), [
    ['2025-01-03', 102],
    ['2025-01-06', 103]
  ]);
  assert.equal(datasets[0].data[0].stockPriceDate, '2025-01-03');
  assert.equal(datasets[0].data[0].stockPriceOnDate, 102);
  assert.equal(datasets[0].data[1].y, null);
  assert.equal(datasets[0].spanGaps, false);
  assert.equal(datasets[1].data.some(point => point.y === 999), false);
});

test('switching tickers destroys the old chart and does not reuse its points', () => {
  const { context, charts } = chartHarness();
  const stock = (ticker, price) => ({
    ticker,
    price_history_metadata: { status: 'fresh', adjustment_semantics_verified: true },
    real_5y_prices: [{ date: '2025-02-03', close: price }],
    historical_valuations: []
  });
  context.renderChart(stock('AAA', 10));
  context.renderChart(stock('BBB', 20));
  assert.equal(charts.length, 2);
  assert.equal(charts[0].destroyed, true);
  assert.deepEqual(JSON.parse(JSON.stringify(charts[1].config.data.datasets[1].data.map(point => point.y))), [20]);
});

test('withholds prices and displays an honest notice when adjustment semantics are unknown', () => {
  const { context, elements, charts } = chartHarness();
  context.renderChart({
    price_history_metadata: { status: 'fresh', adjustment_semantics_verified: false },
    real_5y_prices: [{ date: '2025-01-03', close: 12 }],
    historical_valuations: []
  });
  assert.equal(charts.length, 0);
  assert.equal(elements.detailDcfHistoricalChart.style.display, 'none');
  assert.match(elements['det-chart-empty-state'].textContent, /拆股調整語義/);
});

test('chart renderer has no synthetic price or current-value history fallback', () => {
  assert.doesNotMatch(rendererSource, /Math\.sin\s*\(|\bbaseline\b|\bhistFair\b|Math\.pow\s*\(\s*0\.89/);
  assert.doesNotMatch(rendererSource, /curFairVal\s*\*\s*\(\s*0\.2(?:2)?\s*\+\s*0\.78/);
  assert.match(rendererSource, /normalizeSeries\(s\.real_5y_prices,\s*'close'\)/);
  assert.match(rendererSource, /Array\.isArray\(s\.historical_valuations\)/);
});
