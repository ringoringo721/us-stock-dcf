const assert = require('node:assert/strict');
const { test } = require('node:test');
const CustomTargetPrice = require('../custom_target_price.js');

test('custom target resolves model fair value first, then typed input, then saved override', () => {
  assert.deepEqual(CustomTargetPrice.resolve(12.5, { input: '9', saved: { targetPrice: 8 } }),
    { value: 12.5, source: 'model' });
  assert.deepEqual(CustomTargetPrice.resolve(null, { input: '9.25', saved: { targetPrice: 8 } }),
    { value: 9.25, source: 'custom' });
  assert.deepEqual(CustomTargetPrice.resolve(null, { input: '', saved: { targetPrice: 11.58 } }),
    { value: 11.58, source: 'saved' });
  assert.deepEqual(CustomTargetPrice.resolve(null, { input: '', saved: null }),
    { value: null, source: null });
  assert.deepEqual(CustomTargetPrice.resolve(12.5, {
    input: '90', saved: { modelType: 'CUSTOM_TARGET_OVERRIDE', targetPrice: 90 }
  }), { value: 90, source: 'custom' });
});

test('custom target can save when model FV is N/A but a typed or saved override exists', () => {
  assert.equal(CustomTargetPrice.canSave(null, { input: '', saved: null }), false);
  assert.equal(CustomTargetPrice.canSave(null, { input: '11.58', saved: null }), true);
  assert.equal(CustomTargetPrice.canSave(null, { input: '', saved: { targetPrice: 11.58 } }), true);
  assert.equal(CustomTargetPrice.canSave(26.61, { input: '', saved: null }), true);
});

test('resolveForSave prefers typed custom over model fair value', () => {
  assert.deepEqual(CustomTargetPrice.resolveForSave(12.5, { input: '9.25', saved: { targetPrice: 8 } }),
    { value: 9.25, source: 'custom' });
  assert.deepEqual(CustomTargetPrice.resolveForSave(null, { input: '9.25', saved: null }),
    { value: 9.25, source: 'custom' });
  assert.deepEqual(CustomTargetPrice.resolveForSave(12.5, { input: '', saved: null }),
    { value: 12.5, source: 'model' });
  assert.equal(CustomTargetPrice.isOverride({
    modelType: 'CUSTOM_TARGET_OVERRIDE', targetPrice: 90
  }), true);
  assert.equal(CustomTargetPrice.isOverride({
    modelType: 'FMP_CUSTOM_DCF', targetPrice: 90, kind: 'advanced', schemaVersion: 1
  }), false);
});

test('override records keep a positive target even without model fair value', () => {
  const record = CustomTargetPrice.buildOverrideRecord({
    ticker: '0941.HK', targetPrice: 90, currency: 'HKD', reason: 'FMP_ISSUED_SHARES_UNAVAILABLE'
  });
  assert.equal(record.modelType, 'CUSTOM_TARGET_OVERRIDE');
  assert.equal(record.targetPrice, 90);
  assert.equal(record.currency, 'HKD');
  assert.equal(record.reason, 'FMP_ISSUED_SHARES_UNAVAILABLE');
  assert.throws(() => CustomTargetPrice.buildOverrideRecord({
    ticker: '0941.HK', targetPrice: null, currency: 'HKD'
  }), /CUSTOM_TARGET_REQUIRES_POSITIVE_PRICE/);
});
