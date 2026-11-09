'use strict';
/**
 * Static smoke for TradingView-style screener layout (DCF-76 / #102).
 * Guards regressions that hide valuation columns, break pagination, or drop screen chips.
 * Does not require Playwright.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('catalogue fair columns stay removed from screener', () => {
  assert.equal(/data-i18n="th_catalogue_fair"/.test(html), false);
  assert.equal(/data-i18n="th_catalogue_premium"/.test(html), false);
  assert.equal(/sortTable\('fairVal'\)/.test(html), false);
  assert.equal(/sortTable\('premiumPct'\)/.test(html), false);
  assert.equal(/data-catalogue-fair/.test(html), false);
  assert.equal(/data-price-difference="catalogue"/.test(html), false);
  assert.equal(/data-col-group="catalogue"/.test(html), false);
});

test('Overview screener tab/preset removed; Valuation is default first tab', () => {
  assert.equal(/data-view="overview"/.test(html), false);
  assert.equal(/option value="overview"/.test(html), false);
  assert.equal(/overview:\s*\{\s*fields:/.test(html), false);
  assert.match(html, /option value="valuation" selected/);
  assert.match(html, /class="view-chip active"[^>]*data-view="valuation"/);
  assert.match(html, /resolvedMode = presets\[mode\] \? mode : 'valuation'/);
});

test('valuation preset keeps DCF-75 15-column FMP + site-target group', () => {
  const valuation = html.match(/valuation:\s*\{[^}]+\}/)?.[0] || '';
  assert.match(valuation, /fmp_dcf/);
  assert.match(valuation, /fmp_dcf_upside/);
  assert.match(valuation, /fmp_levered/);
  assert.match(valuation, /fmp_levered_upside/);
  assert.match(valuation, /target_price/);
  assert.match(valuation, /target_spread/);
  assert.equal(/liq_val_1/.test(valuation), false);
  const fields = valuation.match(/fields:\s*\[([^\]]+)\]/)?.[1] || '';
  assert.equal(fields.split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean).length, 15);
});

test('financial preset keeps metrics in Symbol sticky; no second sticky name column', () => {
  const financial = html.match(/financial:\s*\{[^}]+\}/)?.[0] || '';
  const fields = financial.match(/fields:\s*\[([^\]]+)\]/)?.[1] || '';
  const list = fields.split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.equal(list.includes('name'), false);
  assert.equal(list.includes('exchange'), false);
  assert.equal(list[0], 'ticker');
  assert.equal(list.length, 24);
  assert.match(html, /table-layout:\s*fixed/);
  assert.match(html, /COLUMN_WIDTHS/);
});

test('screener th/td do not use overflow:hidden (tooltips + badges)', () => {
  assert.match(html, /#screener-table :is\(th, td\)\s*\{[^}]*overflow:\s*visible/);
  assert.equal(/#screener-table :is\(th, td\)\s*\{[^}]*overflow:\s*hidden/.test(html), false);
  assert.match(html, /#screener-table \.badge-moat/);
  assert.match(html, /#screener-table \.badge-fscore/);
  assert.match(html, /td:has\(\.badge-moat\)[\s\S]*?overflow:\s*visible/);
  assert.match(html, /moat_score:\s*190/);
  assert.match(html, /f_score:\s*200/);
  assert.match(html, /z_score:\s*240/);
  assert.match(html, /m_score:\s*220/);
});

test('three fair-value model under/over screens replace catalogue KPI strip', () => {
  for (const screen of ['FMP_UNDER', 'FMP_OVER', 'LEV_UNDER', 'LEV_OVER', 'TARGET_UNDER', 'TARGET_OVER']) {
    assert.match(html, new RegExp(`data-screen="${screen}"[^>]*onclick="setValFilter\\('${screen}'\\)"`));
    assert.match(html, new RegExp(`data-screen-chip="${screen}"`));
  }
  assert.match(html, /id="stat-fmp-under"/);
  assert.match(html, /id="stat-lev-over"/);
  assert.match(html, /id="stat-target-under"/);
  assert.match(html, /function screenFilterMatches/);
  assert.match(html, /fmp_dcf_upside < 0/);
  assert.match(html, /fmp_levered_upside > 0/);
  assert.match(html, /target_spread < 0/);
  assert.equal(/id="stat-undervalued-box"/.test(html), false);
});

test('column view tabs coexist with select; sticky chrome + filter chips present', () => {
  assert.match(html, /id="screener-view-chips"/);
  assert.match(html, /function setScreenerColumnView/);
  assert.match(html, /\.screener-chrome\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/);
  assert.match(html, /id="screener-columns"/);
  assert.match(html, /class="tv-filter-bar"/);
  assert.match(html, /id="tv-metric-filters"/);
  assert.match(html, /const TV_METRIC_FILTERS\s*=/);
  assert.match(html, /function mountTvMetricFilters/);
  assert.match(html, /id="screener-detail-drawer"/);
  assert.match(html, /data-screen-chip="FMP_UNDER"/);
  // Hint bar must not also stick at top:0 (would hide under chrome).
  assert.match(html, /#screener-view\s+\.scroll-hint-bar\s*\{[^}]*position:\s*static/);
  assert.equal(/#screener-view\s+\.scroll-hint-bar\s*\{[^}]*position:\s*sticky/.test(html), false);
  for (const view of ['valuation', 'financial', 'all']) {
    assert.match(html, new RegExp(`data-view="${view}"`));
  }
});

test('valuation keeps primary market columns without dropping DCF accessibility', () => {
  const valuation = html.match(/valuation:\s*\{[^}]+\}/)?.[0] || '';
  assert.match(valuation, /'price'/);
  assert.match(valuation, /'mcap'/);
  assert.match(valuation, /fmp_dcf/);
  // All FMP / site / liquidation headers remain in thead for other views.
  assert.match(html, /data-i18n="th_fmp_dcf"/);
  assert.match(html, /data-i18n="th_target"/);
  assert.match(html, /data-i18n="th_liq_1"/);
});

test('sticky name/exchange offsets follow compact 168px ticker width', () => {
  assert.match(html, /#screener-table\s+\.col-fixed-1\s*\{[^}]*width:\s*168px/);
  assert.match(html, /#screener-table\s+\.col-fixed-2\s*\{[^}]*left:\s*168px/);
  assert.match(html, /--screener-name-left',\s*exchangeVisible\s*\?\s*'240px'\s*:\s*'168px'/);
  assert.equal(/--screener-name-left',\s*mode === 'all' \? '195px'/.test(html), false);
});

test('drag-to-scroll suppresses screener row click / drawer open', () => {
  assert.match(html, /dataset\.dragMoved/);
  assert.match(html, /__screenerDragMoved/);
  assert.match(html, /function onScreenerRowClick/);
  assert.match(html, /box\?\.dataset\.dragMoved === '1'/);
  assert.match(html, /addEventListener\('click',\s*\(e\)\s*=>\s*\{[\s\S]*?stopPropagation\(\)/);
});

test('hydration / pagination guards remain (no show-all freeze path)', () => {
  assert.equal(html.includes('function showAllStocks'), false);
  assert.equal(/screenerVisibleRows\s*=\s*Infinity/.test(html), false);
  assert.match(html, /function showMoreStocks\(\)\s*\{\s*screenerVisibleRows\s*\+=\s*100/);
  assert.match(html, /list\.length > 200 \? list\.slice\(0, screenerVisibleRows\)/);
});

test('key DCF column headers remain in thead (catalogue fair removed)', () => {
  for (const key of [
    'th_fmp_dcf', 'th_fmp_dcf_upside', 'th_fmp_levered', 'th_fmp_levered_upside',
    'th_target', 'th_target_spread', 'th_price', 'th_mcap',
  ]) {
    assert.match(html, new RegExp(`data-i18n="${key}"`));
  }
  assert.match(html, /data-col-group="fmp"/);
  assert.match(html, /data-col-group="site"/);
  assert.equal(/data-col-group="catalogue"/.test(html), false);
  assert.equal(/data-i18n="th_catalogue_fair"/.test(html), false);
  assert.equal(/data-i18n="th_catalogue_premium"/.test(html), false);
});

test('browser smoke suite exists for live row counts', () => {
  const smoke = path.join(__dirname, 'tradingview_screener_layout.browser.cjs');
  assert.equal(fs.existsSync(smoke), true);
  const source = fs.readFileSync(smoke, 'utf8');
  assert.match(source, /valuation',\s*15/);
  assert.match(source, /financial',\s*24/);
  assert.match(source, /all',\s*41/);
  assert.equal(/overview',\s*8/.test(source), false);
  assert.match(source, /FMP_UNDER/);
  assert.match(source, /data-fmp-reference/);
  assert.match(source, /\[data-catalogue-fair\]'\)\.count\(\),\s*0/);
  assert.match(source, /screener-more/);
});
