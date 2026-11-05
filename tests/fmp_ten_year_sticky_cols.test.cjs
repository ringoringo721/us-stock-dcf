'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const modelsSrc = fs.readFileSync(path.join(root, 'fmp_models.js'), 'utf8');

test('FMP ten-year inputs markup marks first two columns sticky', () => {
  assert.match(modelsSrc, /class="fmp-sticky-col fmp-sticky-label"/);
  assert.match(modelsSrc, /class="fmp-sticky-col fmp-sticky-actual" id="fmp-actual-period"/);
  assert.match(modelsSrc, /class="fmp-sticky-col fmp-sticky-actual" data-actual-key=/);
});

test('CSS freezes assumption + actual-reference columns while years scroll', () => {
  assert.match(indexHtml, /#fmp-workspace #fmp-ten-year-inputs \{[\s\S]*?border-collapse:\s*separate\s*!important/);
  assert.match(indexHtml, /--fmp-sticky-label-w:\s*260px/);
  assert.match(indexHtml, /--fmp-sticky-actual-w:\s*150px/);
  assert.match(indexHtml, /#fmp-ten-year-inputs \.fmp-sticky-label \{[\s\S]*?left:\s*0\s*!important/);
  assert.match(indexHtml, /#fmp-ten-year-inputs \.fmp-sticky-actual \{[\s\S]*?left:\s*var\(--fmp-sticky-label-w\)\s*!important/);
  assert.match(indexHtml, /#fmp-ten-year-inputs \.fmp-sticky-actual \{[\s\S]*?box-shadow:\s*4px 0 8px var\(--shadow\)\s*!important/);
  assert.match(indexHtml, /#fmp-ten-year-inputs thead th\.fmp-sticky-col \{[\s\S]*?z-index:\s*40\s*!important/);
  assert.match(indexHtml, /#fmp-ten-year-inputs \.fmp-sticky-col \{[\s\S]*?background:\s*var\(--sticky-bg\)\s*!important/);
});

test('FCFF valuation driver grids keep a sticky label column', () => {
  assert.match(indexHtml, /#fcff-workspace \.table-scroll-wrapper table tr > :first-child \{[\s\S]*?position:\s*sticky\s*!important/);
  assert.match(indexHtml, /#fcff-workspace \.table-scroll-wrapper table thead th:first-child \{[\s\S]*?z-index:\s*40\s*!important/);
});
