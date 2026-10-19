const { fingerprint } = require('./hkex_valuation_sources.cjs');
const { displayFingerprint, reviewedSourceHash } = require('./property_fv.cjs');

function sourceReview(data, financials, record) {
  if (!record?.cashFlowDisclosure || data.symbol !== record.ticker) return null;
  const disclosure = record.cashFlowDisclosure;
  if (record.financialFingerprint !== fingerprint(financials) || data.currency !== record.currency
      || record.unit !== 'millions' || data.forecastBase?.year !== disclosure.year
      || financials.propertyFvOriginal && (financials.propertyFvProvenance?.sourceHash !== reviewedSourceHash
        || financials.propertyFvProvenance?.adjustedFingerprint !== displayFingerprint(financials))) {
    return { reason: 'OFFICIAL_COMPARISON_REVIEW_REQUIRED' };
  }
  const original = financials.propertyFvOriginal || financials;
  const years = [disclosure.comparative, disclosure].map(official => {
    const advanced = data.models.advanced.data.find(row => Number(row.year) === official.year);
    const levered = data.models.customLevered.data.find(row => Number(row.year) === official.year);
    const cashflow = original.annual.cashflow.find(row => Number(row.fiscalYear) === official.year);
    if (!advanced || !levered || !cashflow) throw new Error('OFFICIAL_COMPARISON_SOURCE_MISSING');
    const afterReclassification = official.reportedOperatingCashFlow - official.cashInterestPaid
      + official.cashInterestReceived + official.cashDividendsReceived;
    return { year: official.year, official: { ...official },
      standardizedOperatingCashFlow: afterReclassification,
      fullCashCapex: official.cashPropertyAdditions + official.cashOtherCapex,
      operatingCashLessPropertyAndPpe: official.reportedOperatingCashFlow - official.cashPropertyAdditions - official.cashOtherCapex,
      provider: { revenue: advanced.revenue / 1e6, ebit: advanced.ebit / 1e6, ebitda: advanced.ebitda / 1e6,
        operatingCashFlow: levered.operatingCashFlow / 1e6, capitalExpenditure: advanced.capitalExpenditure / 1e6,
        purchasesOfInvestments: cashflow.purchasesOfInvestments / 1e6 },
      providerCfoBasis: levered.operatingCashFlow === afterReclassification * 1e6 ? 'reclassified'
        : levered.operatingCashFlow === official.reportedOperatingCashFlow * 1e6 ? 'asReported' : 'unreconciled' };
  });
  if (years[0].providerCfoBasis !== 'asReported' || years[1].providerCfoBasis !== 'reclassified'
      || years.some(year => year.provider.capitalExpenditure !== -year.official.cashOtherCapex)
      || -years[1].provider.purchasesOfInvestments !== disclosure.cashPropertyAdditions
        + disclosure.bankDepositPlacements + disclosure.jointVentureCapitalInjection) {
    return { reason: 'PROVIDER_COMPARISON_CHANGED_REVIEW_REQUIRED' };
  }
  return { reason: null, currency: record.currency, unit: record.unit, document: record.document, years,
    normalizedRentalEbit: record.inputs.netPropertyIncome - record.inputs.corporateExpenses,
    propertyFairValueLoss: record.inputs.propertyFairValueLoss, requiresAssumptionReview: true };
}

module.exports = { sourceReview };
