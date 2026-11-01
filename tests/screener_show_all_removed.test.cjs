'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('screener no longer exposes show-all; keeps +100 pagination', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.equal(html.includes('function showAllStocks'), false);
  assert.equal(/screenerVisibleRows\s*=\s*Infinity/.test(html), false);
  assert.match(html, /function showMoreStocks\(\)\s*\{\s*screenerVisibleRows\s*\+=\s*100/);
  assert.match(html, /screener-all.*\?\.remove\(\)/s);
  assert.match(html, /screener-page-tip/);
  assert.match(html, /v=show-all-1/);
});

test('fcf_ratios browser suite does not assume full-universe paint', () => {
  const source = fs.readFileSync(path.join(__dirname, 'fcf_ratios.browser.cjs'), 'utf8');
  assert.equal(/values\.length,\s*stockCount\s*\*\s*3/.test(source), false);
  assert.match(source, /paintedRows\s*\*\s*3/);
  assert.match(source, /openCompanyProfile\(ticker\)/);
  assert.equal(/locator\(`a\[onclick="openCompanyProfile\('\$\{ticker\}'\)"\]`\)\.click\(\)/.test(source), false);
});

test('large market payloads keep long-cache headers after the HTML catch-all', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const headers = config.headers || [];
  assert.ok(headers.length >= 2);
  assert.equal(headers[0].source, '/(.*)');
  assert.match(headers[0].headers[0].value, /max-age=0/);
  const data = headers.find(entry => String(entry.source).includes('market_data'));
  assert.ok(data, 'data JS cache rule missing');
  assert.match(data.headers[0].value, /max-age=86400/);
  assert.ok(headers.indexOf(data) > 0, 'data cache must override catch-all');
});
