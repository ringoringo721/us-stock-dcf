const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { calculate } = require('../fcff.js');
const { metrics, compatible, reasonText } = require('../fcff_view.js');
const { compile } = require('../scripts/build_fcff.cjs');
const data = require('../cache/fcff_sources.json');
const market = require('../full_market_dcf.json');
const near = (a, b) => assert.ok(Math.abs(a - b) < Math.max(1e-7, Math.abs(b) * 1e-10), `${a} != ${b}`);

test('browser FCFF data matches the independently stored cache and covers every nonfinancial company', () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../fcff_data.js'), 'utf8'), context);
  assert.equal(JSON.stringify(context.window.FCFF_DATA), JSON.stringify(data));
  assert.deepEqual(Object.keys(data.stocks), Object.keys(market).filter(ticker => !market[ticker].fin_valuation?.is_financial));
  assert.equal(Object.keys(data.betaSources).length, Object.keys(market).length);
});

test('every available real-source valuation independently reconciles component arithmetic and every unavailable result has localized reasons', () => {
  const outcomes = {};
  for (const [ticker, snapshot] of Object.entries(data.stocks)) {
    const result = calculate(snapshot);
    const status = result.reason || 'available';
    outcomes[status] = (outcomes[status] || 0) + 1;
    if (result.reason) {
      assert.equal(result.fairVal, null, ticker);
      assert.ok(result.periods.every(row => row.pv === null && row.df === null), ticker);
      assert.ok(!reasonText(result.reason, 'zh').includes(result.reason), ticker);
      assert.ok(!reasonText(result.reason, 'en').includes(result.reason), ticker);
      continue;
    }
    const defaults = snapshot.defaults;
    near(result.WACC, result.wE * result.Ke + result.wD * defaults.kd / 100 * (1 - defaults.tax / 100)
      + result.wP * result.preferredCost + result.wM * result.minorityCost);
    near(result.financingDebt, defaults.debt - defaults.leaseOverlap);
    for (const row of result.periods) {
      near(row.fcff, row.ebit * (1 - defaults.tax / 100) + row.depreciation - row.capex - row.nwcChange);
      near(row.pv, row.fcff / (1 + result.WACC) ** row.time);
    }
    near(result.sumPV, result.periods.reduce((sum, row) => sum + row.pv, 0));
    near(result.terminalFcff, result.terminalNopat * (1 - defaults.g / result.assumptions.terminalRoic));
    assert.equal(result.periods.length, 10, ticker);
    near(result.pvTV, result.terminalFcff / (result.WACC - defaults.g / 100) * result.terminalDf);
    near(result.EquityVal, result.ModelEV - result.financingDebt + defaults.cash + defaults.investments
      - defaults.preferred - defaults.minority);
    near(result.fairVal, result.EquityVal / defaults.shares);
    const baseCell = calculate(snapshot, { discountRate: result.WACC, g: defaults.g });
    near(baseCell.fairVal, result.fairVal);
    const summary = metrics(market[ticker], snapshot, result);
    assert.ok(Number.isFinite(summary.EV));
    assert.equal(summary.localFCF0, snapshot.ttm.reportedFcf);
    const repriced = metrics({ ...market[ticker], price: snapshot.defaults.price * 2 }, snapshot, result);
    if (result.fairVal > 0) near(repriced.premiumPct, (snapshot.defaults.price * 2 / result.fairVal - 1) * 100);
  }
  assert.deepEqual(outcomes, data.outcomes);
  assert.ok(outcomes.available > 0);
});

test('unverified lease sources never fall back to legacy prices or fabricated EBITDA', () => {
  const snapshot = { reason: 'leaseClassificationRequired' }, result = calculate(snapshot);
  assert.equal(result.reason, 'leaseClassificationRequired');
  const value = metrics({ ...market.NVDA, fair_val: 99999, fcf0: 99999 }, snapshot, result);
  assert.equal(value.fairVal, null);
  assert.equal(value.EV, null);
  assert.equal(value.ev_to_ebitda, null);
  assert.equal(value.isUndervalued, null);
  assert.equal(calculate({ reason: 'leaseMappingUnverified' }).reason, 'leaseMappingUnverified');
});

test('beta provenance preserves negative/zero provider values and never invents a five-year window', () => {
  for (const source of Object.values(data.betaSources)) {
    assert.equal(source.lookback, null);
    assert.equal(source.frequency, null);
    assert.equal(source.benchmark, null);
  }
  const base = { fin_valuation: { is_financial: false } };
  const records = { TEST: { capturedAt: '2026-10-17', responses: {
    profile: { ok: true, rows: [{ symbol: 'TEST', beta: 0 }] }
  } } };
  assert.equal(compile({ TEST: base }, records, null, null).betaSources.TEST.value, 0);
  records.TEST.responses.profile.rows[0].beta = -0.047;
  assert.equal(compile({ TEST: base }, records, null, null).betaSources.TEST.value, -0.047);
  records.TEST.responses.profile.rows[0].beta = null;
  assert.equal(compile({ TEST: base }, records, null, null).betaSources.TEST.value, null);
  assert.equal(compatible({ params: { fcf0: 10 } }), false);
  assert.equal(compatible({ params: { modelVersion: 'fcff-v1' } }), false);
  assert.equal(compatible({ params: { modelVersion: 'fcff-v2' } }), true);
  assert.equal(compatible({ params: { modelVersion: 'fcff-v1', fcf0: 100 } }), false);
});
