'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('company page exposes adjacent stock navigation helpers and controls', () => {
  assert.match(html, /function companyNavTickers\s*\(/);
  assert.match(html, /function navigateAdjacentCompany\s*\(/);
  assert.match(html, /function syncCompanyNavControls\s*\(/);
  assert.match(html, /function getActiveCompanyTab\s*\(/);
  assert.match(html, /id="cmp-nav-prev"/);
  assert.match(html, /id="cmp-nav-next"/);
  assert.match(html, /btn_prev_stock/);
  assert.match(html, /btn_next_stock/);
  assert.match(html, /window\.__screenerLastList/);
  assert.match(html, /event\.key !== 'ArrowLeft' && event\.key !== 'ArrowRight'/);
  assert.match(html, /event\.ctrlKey \|\| event\.metaKey \|\| event\.altKey/);
  assert.match(html, /isCompanyNavTypingTarget/);
  // Prefer no wrap: disable at ends rather than modular wrap.
  assert.match(html, /prev\.disabled = !onCompany \|\| idx <= 0/);
  assert.match(html, /next\.disabled = !onCompany \|\| idx < 0 \|\| idx >= list\.length - 1/);
  assert.equal(/nextIdx\s*%\s*list\.length/.test(html), false);
});

test('adjacent navigation preserves the active company sub-route tab', () => {
  assert.match(html, /const tab = getActiveCompanyTab\(\);\s*const nextTicker = list\[nextIdx\];[\s\S]*?switchSubPage\(tab, true\)/);
});
