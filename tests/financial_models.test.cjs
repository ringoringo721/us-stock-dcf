const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const FinancialModels = require('../financial_models.js');

test('excess invalid keeps DDM viewable and blanks only the 55/45 blend', () => {
  const fin = {
    is_financial: true,
    ke: 9, g: 2.25, rote: -10, tbvps: -5, dps_total: 2.5,
    reference: { reason: 'nonPositiveTangibleEquity', rote: -10, tbvps: -5 }
  };
  const valued = FinancialModels.valueFinancial(fin, { industry: 'Diversified Banks' });
  assert.equal(valued.excess_return_fair, null);
  assert.equal(valued.excessReason, 'nonPositiveTangibleEquity');
  assert.ok(Number.isFinite(valued.ddm_fair));
  assert.equal(valued.ddmReason, null);
  assert.equal(valued.fair_val, null);
  assert.equal(valued.blendReason, 'nonPositiveTangibleEquity');
});

test('healthy bank path matches 55/45 blend algebra', () => {
  const fin = {
    is_financial: true,
    ke: 5.73125, g: 2.25, rote: 9.261791678594236,
    tbvps: 13.159397281788603, dps_total: 0.708773208918765,
    reference: { reason: null }
  };
  const valued = FinancialModels.valueFinancial(fin);
  assert.equal(valued.excess_return_fair, 26.51);
  assert.equal(valued.ddm_fair, 25.21);
  assert.equal(valued.fair_val, 25.92);
  assert.equal(valued.excessReason, null);
  assert.equal(valued.ddmReason, null);
});

test('US Ke floor resolves max(CAPM, 9%) and can be toggled off', () => {
  const stock = { rf: 4.3, beta: 0.5, erp: 4.75, calculationCurrency: 'USD' };
  const floored = FinancialModels.resolveKePercent({ ke_floor_applied: true }, stock);
  assert.equal(floored.ke_capm, 4.3 + 0.5 * 4.75);
  assert.equal(floored.ke, 9);
  assert.equal(floored.ke_floor_applied, true);
  const raw = FinancialModels.resolveKePercent({ ke_floor_applied: false, ke_capm: floored.ke_capm }, stock);
  assert.equal(raw.ke, floored.ke_capm);
  assert.equal(raw.ke_floor_applied, false);
});

test('syncCapmKe drives Ke from rf/beta/ERP unless manual override', () => {
  const stock = { rf: 5.09, beta: 0.135, erp: 4.75, calculationCurrency: 'HKD' };
  const fin = { is_financial: true, ke_floor_applied: false };
  const resolved = FinancialModels.syncCapmKe(fin, stock);
  assert.equal(resolved.ke_capm, Number((5.09 + 0.135 * 4.75).toFixed(4)));
  assert.equal(fin.ke, resolved.ke);
  assert.equal(fin.ke_capm, resolved.ke_capm);
  fin.ke_manual_override = true;
  fin.ke = 8.5;
  stock.rf = 4.0;
  const manual = FinancialModels.syncCapmKe(fin, stock);
  assert.equal(manual.ke, 8.5);
  assert.equal(manual.manual, true);
  assert.equal(fin.ke_capm, Number((4.0 + 0.135 * 4.75).toFixed(4)));
  assert.equal(fin.ke, 8.5);
});

test('US syncCapmKe respects floor toggle and manual Ke', () => {
  const stock = { rf: 4.3, beta: 0.5, erp: 4.75, calculationCurrency: 'USD' };
  const fin = { is_financial: true, ke_floor_applied: true };
  const floored = FinancialModels.syncCapmKe(fin, stock);
  assert.equal(floored.ke, 9);
  fin.ke_floor_applied = false;
  const raw = FinancialModels.syncCapmKe(fin, stock);
  assert.equal(raw.ke, floored.ke_capm);
  fin.ke_manual_override = true;
  fin.ke = 11;
  const manual = FinancialModels.syncCapmKe(fin, stock);
  assert.equal(manual.ke, 11);
  assert.equal(manual.ke_floor_applied, false);
});

test('buyback cap is min(|buyback|, 1.5×|div|)', () => {
  assert.equal(FinancialModels.totalPayoutFromFlows(-100, -200), 100 + 150);
  assert.equal(FinancialModels.totalPayoutFromFlows(-100, -50), 150);
});

test('insurer warnings cover bank-style model and fragile ROTE', () => {
  assert.deepEqual(
    FinancialModels.insurerWarnings('Life & Health Insurance', 12),
    ['bankStyleResidualIncomeOnInsurer']
  );
  assert.deepEqual(
    FinancialModels.insurerWarnings('Multi-line Insurance', 52),
    ['bankStyleResidualIncomeOnInsurer', 'fragileInsurerRote']
  );
  assert.deepEqual(FinancialModels.insurerWarnings('Diversified Banks', 52), []);
});

test('UI copy discloses blend weights, buyback cap, Ke floor, and insurer caveats', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  for (const key of [
    'fin_blend_note', 'fin_buyback_note', 'fin_ke_floor_note', 'fin_ke_floor_toggle',
    'fin_insurer_bank_style', 'fin_insurer_fragile_rote',
    'fin_ke_history_title', 'fin_ke_history_basis',
    'fin_capm_title', 'fin_capm_basis', 'fin_ke_use_calculated', 'fin_capm_live'
  ]) {
    assert.match(html, new RegExp(`${key}:`));
  }
  assert.match(html, /55%.*45%|超額報酬 55%.*DDM 45%/);
  assert.match(html, /1\.5/);
  assert.match(html, /max\(CAPM, 9%\)/);
  assert.match(html, /id="fin-ke-floor-toggle"/);
  assert.match(html, /id="fin-blend-note"/);
  assert.match(html, /id="fin-buyback-note"/);
  assert.match(html, /id="fin-insurer-note"/);
  assert.match(html, /id="fin-ke-history-panel"/);
  assert.match(html, /jumpToFinKeHistory/);
  assert.match(html, /id="fin-capm-builder"/);
  assert.match(html, /id="input-fin-rf"/);
  assert.match(html, /id="input-fin-beta"/);
  assert.match(html, /id="input-fin-erp"/);
  assert.match(html, /id="fin-ke-use-calculated"[^>]*\bchecked\b/);
  assert.match(html, /onFinCapmInput/);
  assert.match(html, /onFinKeModeChange/);
  assert.match(html, /ke_manual_override !== true/);
  assert.match(html, /id="input-fin-ke"/);
  assert.match(html, /id="input-fin-g"/);
  assert.match(html, /id="input-fin-rote"/);
  assert.match(html, /onFinNumberInput/);
  assert.match(html, /ke_treasury_data\.js/);
  assert.match(html, /financial_models\.js/);
  assert.match(html, /超額有形股本回報模型/);
});

test('embedded Ke treasury snapshot validates and builds history without fetch', () => {
  const embedded = fs.readFileSync(path.join(__dirname, '..', 'ke_treasury_data.js'), 'utf8');
  assert.match(embedded, /window\.KE_TREASURY_USD10Y\s*=/);
  const data = JSON.parse(embedded.replace(/^[\s\S]*?=\s*/, '').replace(/;\s*$/, ''));
  assert.equal(FinancialModels.validateKeTreasuryCache(data), true);
  const history = FinancialModels.buildKeHistory(data, { beta: 0.135, erp: 4.75, calculationCurrency: 'HKD' });
  assert.equal(history.years.filter(row => row.ke !== null).length, 10);
});

test('Ke history uses dated USD 10Y + current beta; does not invent betas', () => {
  const treasury = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'ke_history', 'treasury_usd10y.json'), 'utf8'));
  assert.equal(FinancialModels.validateKeTreasuryCache(treasury), true);
  const history = FinancialModels.buildKeHistory(treasury, {
    beta: 0.135, erp: 4.75, calculationCurrency: 'HKD'
  });
  assert.equal(history.method, 'usd10yPlusCurrentBetaTimesAssumedErp');
  assert.equal(history.rfBasis, 'usdTreasury10YProxyUnderHkdUsdPeg');
  assert.equal(history.betaBasis, 'currentProfileBetaHeldConstant');
  assert.equal(history.years.length, 10);
  const y2024 = history.years.find(row => row.year === 2024);
  assert.ok(y2024);
  assert.equal(y2024.rf, 4.58);
  assert.equal(y2024.ke, Number((4.58 + 0.135 * 4.75).toFixed(12)));
  assert.equal(y2024.reason, null);
  const missingBeta = FinancialModels.buildKeHistory(treasury, { beta: null, erp: 4.75 });
  assert.ok(missingBeta.years.every(row => row.ke === null && row.reason === 'missingBeta'));
  const latest = history.years.at(-1);
  if (!latest.yearEnd) assert.ok(latest.warnings.includes('latestObservationNotYearEnd'));
});
