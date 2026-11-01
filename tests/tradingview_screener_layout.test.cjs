'use strict';
/**
 * Static smoke for TradingView-style screener layout (DCF-76).
 * Guards regressions that hide valuation columns, break pagination, or drop screen chips.
 * Does not require Playwright.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('overview preset exposes catalogue fair + premium only as primary valuation pair', () => {
  const overview = html.match(/overview:\s*\{[^}]+\}/)?.[0] || '';
  assert.match(overview, /'fairVal'/);
  assert.match(overview, /'premiumPct'/);
  assert.match(html, /data-i18n="th_catalogue_fair"/);
  assert.match(html, /data-i18n="th_catalogue_premium"/);
  assert.match(html, /sortTable\('fairVal'\)/);
  assert.match(html, /sortTable\('premiumPct'\)/);
  // Overview must not dump every FMP DCF column into the default view.
  assert.equal(/fmp_dcf/.test(overview), false);
  assert.equal(/fmp_levered/.test(overview), false);
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

test('undervalued / overvalued screens are clickable and wired to catalogue filter', () => {
  assert.match(html, /data-screen="UNDERVALUED"[^>]*onclick="setValFilter\('UNDERVALUED'\)"/);
  assert.match(html, /data-screen="OVERVALUED"[^>]*onclick="setValFilter\('OVERVALUED'\)"/);
  assert.match(html, /id="stat-undervalued-box"/);
  assert.match(html, /id="stat-overvalued-box"/);
  assert.match(html, /function syncScreenerScreenState/);
  assert.match(html, /currentValFilter === 'UNDERVALUED'/);
  assert.match(html, /item\.isUndervalued/);
});

test('column view tabs coexist with select; sticky chrome + filter chips present', () => {
  assert.match(html, /id="screener-view-chips"/);
  assert.match(html, /function setScreenerColumnView/);
  assert.match(html, /\.screener-chrome\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/);
  assert.match(html, /id="screener-columns"/);
  assert.match(html, /class="tv-filter-bar"/);
  assert.match(html, /id="screener-detail-drawer"/);
  assert.match(html, /data-screen-chip="UNDERVALUED"/);
  // Hint bar must not also stick at top:0 (would hide under chrome).
  assert.match(html, /#screener-view\s+\.scroll-hint-bar\s*\{[^}]*position:\s*static/);
  assert.equal(/#screener-view\s+\.scroll-hint-bar\s*\{[^}]*position:\s*sticky/.test(html), false);
  for (const view of ['overview', 'valuation', 'financial', 'all']) {
    assert.match(html, new RegExp(`data-view="${view}"`));
  }
});

test('overview keeps primary market columns without dropping DCF accessibility', () => {
  const overview = html.match(/overview:\s*\{[^}]+\}/)?.[0] || '';
  assert.match(overview, /'price'/);
  assert.match(overview, /'mcap'/);
  assert.match(overview, /'pe_trailing'/);
  assert.match(overview, /'fairVal'/);
  assert.match(overview, /'premiumPct'/);
  // All FMP / site / liquidation headers remain in thead for other views.
  assert.match(html, /data-i18n="th_fmp_dcf"/);
  assert.match(html, /data-i18n="th_target"/);
  assert.match(html, /data-i18n="th_liq_1"/);
});

test('hydration / pagination guards remain (no show-all freeze path)', () => {
  assert.equal(html.includes('function showAllStocks'), false);
  assert.equal(/screenerVisibleRows\s*=\s*Infinity/.test(html), false);
  assert.match(html, /function showMoreStocks\(\)\s*\{\s*screenerVisibleRows\s*\+=\s*100/);
  assert.match(html, /list\.length > 200 \? list\.slice\(0, screenerVisibleRows\)/);
});

test('key DCF column headers remain in thead (not removed by layout)', () => {
  for (const key of [
    'th_catalogue_fair', 'th_catalogue_premium',
    'th_fmp_dcf', 'th_fmp_dcf_upside', 'th_fmp_levered', 'th_fmp_levered_upside',
    'th_target', 'th_target_spread', 'th_price', 'th_mcap',
  ]) {
    assert.match(html, new RegExp(`data-i18n="${key}"`));
  }
  assert.match(html, /data-col-group="fmp"/);
  assert.match(html, /data-col-group="site"/);
  assert.match(html, /data-col-group="catalogue"/);
});

test('browser smoke suite exists for live row counts', () => {
  const smoke = path.join(__dirname, 'tradingview_screener_layout.browser.cjs');
  assert.equal(fs.existsSync(smoke), true);
  const source = fs.readFileSync(smoke, 'utf8');
  assert.match(source, /overview',\s*10/);
  assert.match(source, /valuation',\s*15/);
  assert.match(source, /all',\s*40/);
  assert.match(source, /UNDERVALUED/);
  assert.match(source, /data-fmp-reference/);
  assert.match(source, /data-catalogue-fair/);
  assert.match(source, /screener-more/);
});
