(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CustomTargetPrice = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MODEL_TYPES = Object.freeze({
    OVERRIDE: 'CUSTOM_TARGET_OVERRIDE'
  });

  function finitePositive(value) {
    const number = typeof value === 'number' ? value : Number(value);
    return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : null;
  }

  function fromSaved(saved) {
    return finitePositive(saved?.targetPrice);
  }

  function parseInput(raw) {
    if (raw == null) return null;
    const text = String(raw).trim();
    if (!text) return null;
    return finitePositive(Number(text));
  }

  /**
   * Prefer live model fair value; otherwise typed custom input; otherwise saved target.
   * Model N/A must not erase a saved or typed custom target.
   */
  function resolve(modelFairVal, { input = null, saved = null } = {}) {
    const model = finitePositive(modelFairVal);
    if (model != null) return { value: model, source: 'model' };
    const typed = parseInput(input);
    if (typed != null) return { value: typed, source: 'custom' };
    const stored = fromSaved(saved);
    if (stored != null) return { value: stored, source: 'saved' };
    return { value: null, source: null };
  }

  function canSave(modelFairVal, { input = null, saved = null } = {}) {
    return resolve(modelFairVal, { input, saved }).value != null;
  }

  function buildOverrideRecord({ ticker, targetPrice, currency, reason = null, params = null }) {
    const price = finitePositive(targetPrice);
    if (price == null) throw new TypeError('CUSTOM_TARGET_REQUIRES_POSITIVE_PRICE');
    return {
      schemaVersion: 1,
      modelType: MODEL_TYPES.OVERRIDE,
      ticker,
      currency: currency || 'USD',
      targetPrice: price,
      reason: reason || 'MODEL_FAIR_VALUE_UNAVAILABLE',
      savedAt: new Date().toISOString(),
      ...(params && typeof params === 'object' ? { params } : {})
    };
  }

  return { MODEL_TYPES, finitePositive, fromSaved, parseInput, resolve, canSave, buildOverrideRecord };
});
