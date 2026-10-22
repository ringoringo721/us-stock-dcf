(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FinancialIndustry = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // Baseline build_full_market industries plus current FMP screener labels used by US expansion.
  const BASELINE = new Set([
    'Diversified Banks',
    'Consumer Finance',
    'Investment Banking & Brokerage',
    'Property & Casualty Insurance',
    'Life & Health Insurance',
    'Multi-line Insurance'
  ]);
  const EXPANSION = new Set([
    'Banks',
    'Banks - Regional',
    'Banks - Diversified',
    'Financial - Credit Services',
    'Investment - Banking & Investment Services',
    'Insurance - Property & Casualty',
    'Insurance - Life',
    'Insurance - Diversified',
    'Insurance - Reinsurance',
    'Insurance - Specialty'
  ]);
  // Brokers / asset managers stay on corporate DCF (matches baseline FINANCIAL_SPECIAL_INDUSTRIES).
  const EXCLUDED_TICKERS = new Set(['BRK-A', 'BRK-B', 'BRK.A', 'BRK.B']);

  const INSURANCE = new Set([
    'Life & Health Insurance',
    'Multi-line Insurance',
    'Property & Casualty Insurance',
    'Insurance Brokers',
    'Insurance - Property & Casualty',
    'Insurance - Life',
    'Insurance - Diversified',
    'Insurance - Reinsurance',
    'Insurance - Specialty',
    'Insurance - Brokers'
  ]);

  function usesFinancialValuationModel(industry, ticker) {
    if (ticker && EXCLUDED_TICKERS.has(String(ticker).toUpperCase())) return false;
    const name = industry || '';
    return BASELINE.has(name) || EXPANSION.has(name);
  }

  function isInsuranceIndustry(industry) {
    return INSURANCE.has(industry || '');
  }

  return { usesFinancialValuationModel, isInsuranceIndustry, BASELINE, EXPANSION, INSURANCE, EXCLUDED_TICKERS };
});
