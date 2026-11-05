'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('makeScrollable / ensureTableDragPan support RMB hold-drag with natural pan', () => {
  assert.match(html, /function makeScrollable\s*\(/);
  assert.match(html, /function ensureTableDragPan\s*\(/);
  assert.match(html, /function endTableDrag\s*\(/);
  assert.match(html, /e\.button !== 0 && e\.button !== 2/);
  assert.match(html, /isRightButton: e\.button === 2/);
  // Natural grab-to-pan: drag right decreases scrollLeft.
  assert.match(html, /active\.box\.scrollLeft = active\.scrollLeft - dx \* TABLE_PAN_SCALE/);
  assert.match(html, /active\.box\.scrollTop = active\.scrollTop - dy \* TABLE_PAN_SCALE/);
  // Post-pan menu suppression must not linger via a stale dragMoved closure flag.
  assert.match(html, /dataset\.suppressContextMenu/);
  assert.match(html, /suppressContextMenu !== '1'/);
  assert.match(html, /isTableDragInteractiveTarget/);
  assert.match(html, /TEXTAREA/);
  assert.match(html, /TABLE_DRAG_THRESHOLD_PX/);
  assert.match(html, /window\.makeScrollable = makeScrollable/);
  assert.match(html, /__tableDragPanReady/);
  // Single shared window controller — no per-box window.addEventListener mousemove.
  assert.match(html, /window\.__tableDragPanReady/);
  const makeScrollableBody = html.slice(
    html.indexOf('function makeScrollable(box)'),
    html.indexOf('window.makeScrollable = makeScrollable')
  );
  assert.equal(/window\.addEventListener\(\s*['"]mousemove['"]/.test(makeScrollableBody), false);
  assert.equal(/window\.addEventListener\(\s*['"]mouseup['"]/.test(makeScrollableBody), false);
});

test('table-scroll-wrapper remains the shared overflow surface for statements and valuation grids', () => {
  assert.match(html, /class="table-scroll-wrapper"/);
  assert.match(html, /id="dcf-table"/);
  assert.match(html, /#fmp-workspace \.table-scroll-wrapper/);
  assert.match(html, /#subpage-valuation \.table-scroll-wrapper/);
});
