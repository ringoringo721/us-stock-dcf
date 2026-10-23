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

  // Banks / credit / most insurers do not report industrial Cost of Revenue / Gross Profit.
  // FMP still fills those fields inconsistently (interest expense as CoGS, GP > revenue, etc.).
  function suppressIndustrialGrossProfit(industry, ticker) {
    return usesFinancialValuationModel(industry, ticker);
  }

  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function netInterestIncomeOf(row) {
    const reported = finiteNumber(row?.netInterestIncome);
    if (reported !== null) return reported;
    const income = finiteNumber(row?.interestIncome);
    const expense = finiteNumber(row?.interestExpense);
    return income !== null && expense !== null ? income - expense : null;
  }

  // Banks/credit only — insurers keep premium revenue even when interest fields exist.
  function shouldNormalizeBankRevenue(industry, ticker) {
    if (isInsuranceIndustry(industry)) return false;
    if (industry == null || industry === '') return true;
    return usesFinancialValuationModel(industry, ticker);
  }

  // FMP often stores bank "revenue" as gross interest income (+ fees) for some periods,
  // while other years use net operating income (NII + non-interest). Detect the gross framing.
  function bankRevenueUsesGrossInterest(row) {
    const revenue = finiteNumber(row?.revenue);
    const interestIncome = finiteNumber(row?.interestIncome);
    const netInterest = netInterestIncomeOf(row);
    if (!(revenue > 0 && interestIncome > 0 && netInterest > 0)) return false;
    // Interest income must be a major share of reported revenue (excludes premium-led insurers).
    if (interestIncome < revenue * 0.4) return false;
    return revenue > netInterest * 1.5 && revenue >= interestIncome * 0.9;
  }

  // Operating revenue ≈ NII + non-interest income. When revenue includes gross interest,
  // non-interest ≈ max(0, revenue − interestIncome).
  function bankOperatingRevenue(row) {
    const revenue = finiteNumber(row?.revenue);
    if (revenue === null) return null;
    if (!bankRevenueUsesGrossInterest(row)) return revenue;
    const netInterest = netInterestIncomeOf(row);
    const interestIncome = finiteNumber(row.interestIncome);
    return netInterest + Math.max(0, revenue - interestIncome);
  }

  function normalizeBankIncomeRow(row, industry, ticker) {
    if (!row || !shouldNormalizeBankRevenue(industry, ticker)) return row;
    if (!bankRevenueUsesGrossInterest(row)) return row;
    const operating = bankOperatingRevenue(row);
    if (operating === null || operating === row.revenue) return row;
    return {
      ...row,
      revenue: operating,
      providerRevenue: row.revenue,
      revenueNormalization: 'bankOperatingFromGrossInterest'
    };
  }

  function normalizeBankStatements(data, industry, ticker) {
    if (!data || !shouldNormalizeBankRevenue(industry, ticker)) return data;
    const mapPeriod = period => {
      if (!period || !Array.isArray(period.income)) return period;
      return {
        ...period,
        income: period.income.map(row => normalizeBankIncomeRow(row, industry, ticker))
      };
    };
    return {
      ...data,
      annual: mapPeriod(data.annual),
      quarterly: mapPeriod(data.quarterly)
    };
  }

  // Columnar statements_raw.income (values already scaled). Returns a new revenue array.
  function normalizeBankRevenueSeries(income, industry, ticker) {
    if (!income || !Array.isArray(income.revenue)) return income?.revenue || [];
    if (!shouldNormalizeBankRevenue(industry, ticker)) return income.revenue.slice();
    const interestIncome = income.interestIncome || [];
    const interestExpense = income.interestExpense || [];
    const netInterestIncome = income.netInterestIncome || [];
    return income.revenue.map((revenue, index) => bankOperatingRevenue({
      revenue,
      interestIncome: interestIncome[index],
      interestExpense: interestExpense[index],
      netInterestIncome: netInterestIncome[index]
    }));
  }

  return {
    usesFinancialValuationModel, isInsuranceIndustry, suppressIndustrialGrossProfit,
    shouldNormalizeBankRevenue, bankRevenueUsesGrossInterest, bankOperatingRevenue,
    netInterestIncomeOf, normalizeBankIncomeRow, normalizeBankStatements, normalizeBankRevenueSeries,
    BASELINE, EXPANSION, INSURANCE, EXCLUDED_TICKERS
  };
});
