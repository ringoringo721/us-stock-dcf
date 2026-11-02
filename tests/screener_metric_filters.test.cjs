'use strict';
/**
 * Enforce: every numeric All-columns screener indicator/ratio has a top-bar filter entry.
 * When adding a new metric column, append it to TV_METRIC_FILTERS in index.html.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const NON_FILTERABLE = new Set([
  'ticker', 'exchange', 'name', 'sector', 'industry', 'action',
]);

function filterableSortFields(source) {
  const fields = [...source.matchAll(/sortTable\('([^']+)'\)/g)].map(m => m[1]);
  return [...new Set(fields)].filter(field =>
    !NON_FILTERABLE.has(field) && !field.includes('${') && /^[A-Za-z_][\w]*$/.test(field));
}

test('TV_METRIC_FILTERS covers every numeric All-columns sort field', () => {
  assert.match(html, /const TV_METRIC_FILTERS\s*=/);
  assert.match(html, /id="tv-metric-filters"/);
  assert.match(html, /function mountTvMetricFilters/);
  assert.match(html, /function emptyScreenerMetricFilters/);
  const registry = html.match(/const TV_METRIC_FILTERS\s*=\s*\[([\s\S]*?)\];\s*const TV_METRIC_PRESETS/);
  assert.ok(registry, 'TV_METRIC_FILTERS registry present');
  const declared = [...registry[1].matchAll(/field:\s*'([^']+)'/g)].map(m => m[1]);
  assert.ok(declared.length >= 30, `expected broad filter coverage, got ${declared.length}`);
  const missing = filterableSortFields(html).filter(field => !declared.includes(field));
  assert.deepEqual(missing, [], `Add filter presets for: ${missing.join(', ')}`);
});

test('metric filter chips are mounted from registry (not hard-coded subset)', () => {
  assert.match(html, /function tvMetricChipHtml/);
  assert.match(html, /TV_METRIC_FILTERS\s*\n?\s*\.filter\(row => !TV_METRIC_PRIMARY\.has\(row\.field\)\)/);
  assert.equal(/id="tv-filter-price"[^>]*data-i18n="tv_filter_price"/.test(html), false);
  assert.match(html, /screenerMetricFilters = emptyScreenerMetricFilters\(\)/);
});

test('sticky chrome keeps primary chips + more-metrics popover (no display:contents dump)', () => {
  assert.match(html, /const TV_METRIC_PRIMARY_FIELDS\s*=\s*\['price',\s*'premiumPct',\s*'mcap',\s*'pe_trailing'\]/);
  assert.match(html, /id="tv-more-metrics-panel"/);
  assert.match(html, /id="tv-filter-more-metrics"/);
  assert.match(html, /function toggleTvMoreMetrics/);
  assert.match(html, /\.tv-more-metrics-panel\.open\s*\{\s*display:\s*flex/);
  assert.equal(/\.tv-metric-filters\s*\{\s*display:\s*contents/.test(html), false);
  assert.match(html, /\.tv-metric-filters\s*\{[^}]*display:\s*inline-flex/);
});

test('metric menus support custom gt/lt/range and Liq vs-price; more menus portal to body', () => {
  assert.match(html, /function applyTvMetricCustom/);
  assert.match(html, /function applyTvMetricVsPrice/);
  assert.match(html, /kind === 'vsPrice'/);
  assert.match(html, /LIQ_VS_PRICE_FIELDS/);
  assert.match(html, /document\.body\.appendChild\(menu\)/);
  assert.match(html, /tv-metric-menu-portaled/);
  assert.match(html, /function metricFilterMatches/);
  assert.equal(/\.tv-more-metrics-panel \.tv-metric-menu\s*\{\s*position:\s*fixed/.test(html), false);
});
