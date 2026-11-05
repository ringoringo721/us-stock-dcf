'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('makeScrollable supports RMB hold-drag pan with natural scroll direction', () => {
  assert.match(html, /function makeScrollable\s*\(/);
  assert.match(html, /e\.button !== 0 && e\.button !== 2/);
  assert.match(html, /isRightButton = e\.button === 2/);
  // Natural grab-to-pan: drag right decreases scrollLeft.
  assert.match(html, /box\.scrollLeft = scrollLeft - dx \* PAN_SCALE/);
  assert.match(html, /box\.scrollTop = scrollTop - dy \* PAN_SCALE/);
  assert.match(html, /suppressContextMenu/);
  assert.match(html, /contextmenu/);
  assert.match(html, /isInteractiveTarget/);
  assert.match(html, /TEXTAREA/);
  assert.match(html, /DRAG_THRESHOLD_PX/);
  assert.match(html, /window\.makeScrollable = makeScrollable/);
  assert.match(html, /__tableScrollObserver/);
  assert.match(html, /bindTableScrollWrappers/);
});

test('table-scroll-wrapper remains the shared overflow surface for statements and valuation grids', () => {
  assert.match(html, /class="table-scroll-wrapper"/);
  assert.match(html, /id="dcf-table"/);
  assert.match(html, /#fmp-workspace \.table-scroll-wrapper/);
  assert.match(html, /#subpage-valuation \.table-scroll-wrapper/);
});
