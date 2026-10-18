const reviewed = require('../cache/hkex_balance_classifications.json');
const groups = {
  totalCurrentAssets: ['cashAndCashEquivalents', 'financialAssetsFvplCurrent', 'financialAssetsFvociCurrent',
    'financialAssetsAmortisedCostCurrent', 'derivativeAssetsCurrent', 'receivablesPrepaymentsDepositsCurrent', 'taxRecoverableCurrent'],
  totalNonCurrentAssets: ['financialAssetsFvplNonCurrent', 'financialAssetsFvociNonCurrent', 'financialAssetsAmortisedCostNonCurrent',
    'receivablesPrepaymentsDepositsNonCurrent', 'jointVentureAndAssociateInterests', 'goodwillAndIntangibleAssets',
    'propertyPlantEquipmentNet', 'rightOfUseAssets', 'taxAssets'],
  totalCurrentLiabilities: ['derivativeLiabilitiesCurrent', 'participantDepositsCollateralCurrent',
    'payablesAccrualsOtherLiabilitiesCurrent', 'deferredRevenue', 'taxPayables', 'otherFinancialLiabilitiesCurrent',
    'clearingHouseFundContributionsCurrent', 'capitalLeaseObligationsCurrent', 'shortTermDebt', 'provisionsCurrent'],
  totalNonCurrentLiabilities: ['deferredRevenueNonCurrent', 'taxPayablesNonCurrent', 'capitalLeaseObligationsNonCurrent',
    'longTermDebt', 'provisionsNonCurrent', 'deferredTaxLiabilitiesNonCurrent'],
  totalAssets: ['totalCurrentAssets', 'totalNonCurrentAssets'],
  totalLiabilities: ['totalCurrentLiabilities', 'totalNonCurrentLiabilities'],
  totalStockholdersEquity: ['commonStock', 'treasuryStock', 'employeeShareBasedCompensationReserve',
    'hedgingRevaluationReserves', 'exchangeReserve', 'designatedReserves', 'writtenPutReserveNonControllingInterests', 'retainedEarnings'],
  totalEquity: ['totalStockholdersEquity', 'minorityInterest'],
  totalLiabilitiesAndTotalEquity: ['totalLiabilities', 'totalEquity']
};

function applyOfficialBalance(statements, ticker, review = reviewed) {
  if (ticker !== review.ticker) return statements;
  if (review.currency !== 'HKD' || review.unit !== 'millions') throw new Error('INVALID_OFFICIAL_BALANCE_SOURCE');
  for (const period of review.periods) {
    const fields = period.fields;
    for (const [total, items] of Object.entries(groups)) {
      if (!Number.isFinite(fields[total]) || fields[total] < 0
          || !items.every(field => Number.isFinite(fields[field]) && (total === 'totalStockholdersEquity' || fields[field] >= 0))
          || fields[total] !== items.reduce((sum, field) => sum + fields[field], 0)) {
        throw new Error(`OFFICIAL_BALANCE_DOES_NOT_RECONCILE: ${period.date} ${total}`);
      }
    }
    if (fields.totalAssets !== fields.totalLiabilitiesAndTotalEquity) throw new Error('OFFICIAL_BALANCE_NOT_BALANCED');
  }
  const archive = [], applied = new Set();
  const replace = row => {
    const report = review.periods.find(period => period.date === row.date);
    if (!report) return row;
    const fields = report.fields;
    if (row.reportedCurrency !== review.currency || row.totalAssets !== fields.totalAssets * 1e6
        || row.totalLiabilities !== fields.totalLiabilities * 1e6
        || row.totalStockholdersEquity !== fields.totalStockholdersEquity * 1e6) {
      throw new Error(`OFFICIAL_BALANCE_PROVIDER_COMPARISON_CHANGED: ${row.date}`);
    }
    if (!row.balanceClassificationSource) archive.push(row);
    applied.add(row.date);
    const mapped = Object.fromEntries(Object.entries(fields).map(([field, amount]) => [field, amount * 1e6]));
    const sum = names => names.reduce((total, name) => total + mapped[name], 0);
    const shortTermInvestments = sum(['financialAssetsFvplCurrent', 'financialAssetsFvociCurrent', 'financialAssetsAmortisedCostCurrent']);
    const longTermInvestments = sum(['financialAssetsFvplNonCurrent', 'financialAssetsFvociNonCurrent',
      'financialAssetsAmortisedCostNonCurrent', 'jointVentureAndAssociateInterests']);
    const capitalLeaseObligations = sum(['capitalLeaseObligationsCurrent', 'capitalLeaseObligationsNonCurrent']);
    const totalDebt = mapped.shortTermDebt + mapped.longTermDebt + capitalLeaseObligations;
    return { ...row, ...mapped, balanceClassificationSource: review.source,
      filingDate: null, acceptedDate: null, availabilityBasis: 'retrospectiveOfficialCorrectionNotPointInTime',
      netReceivables: null, accountsReceivables: null, tradeAccountsReceivables: null, otherReceivables: null,
      prepaids: null, goodwill: null, intangibleAssets: null, accountPayables: null, otherPayables: null,
      accruedExpenses: null, totalPayables: null, shortTermInvestments, longTermInvestments,
      cashAndShortTermInvestments: mapped.cashAndCashEquivalents + shortTermInvestments,
      totalInvestments: shortTermInvestments + longTermInvestments,
      otherCurrentAssets: mapped.derivativeAssetsCurrent + mapped.taxRecoverableCurrent,
      otherNonCurrentAssets: mapped.receivablesPrepaymentsDepositsNonCurrent + mapped.rightOfUseAssets,
      otherCurrentLiabilities: sum(['derivativeLiabilitiesCurrent', 'participantDepositsCollateralCurrent',
        'otherFinancialLiabilitiesCurrent', 'clearingHouseFundContributionsCurrent', 'provisionsCurrent']),
      otherNonCurrentLiabilities: mapped.taxPayablesNonCurrent + mapped.provisionsNonCurrent,
      accumulatedOtherComprehensiveIncomeLoss: mapped.hedgingRevaluationReserves + mapped.exchangeReserve,
      otherTotalStockholdersEquity: sum(['employeeShareBasedCompensationReserve', 'designatedReserves', 'writtenPutReserveNonControllingInterests']),
      capitalLeaseObligations, totalDebt, netDebt: totalDebt - mapped.cashAndCashEquivalents };
  };
  const annual = { ...statements.annual, balance: statements.annual.balance.map(replace) };
  const quarterly = { ...statements.quarterly, balance: statements.quarterly.balance.map(replace) };
  if (!applied.size) throw new Error('OFFICIAL_BALANCE_PERIOD_COVERAGE_REVIEW_REQUIRED');
  return { ...statements, annual, quarterly,
    archivedProviderBalance: archive.length ? archive : statements.archivedProviderBalance,
    balanceClassificationSource: { ...review.source, dates: [...applied].sort(),
      debtBasis: 'Borrowings plus current and non-current lease liabilities, counted once.',
      coverage: 'Only the cited dates are verified; earlier FMP classifications remain unreviewed.' } };
}

module.exports = { applyOfficialBalance, groups };
