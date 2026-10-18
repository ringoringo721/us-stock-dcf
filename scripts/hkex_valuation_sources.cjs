const crypto = require('node:crypto');
const records = require('../cache/hkex_valuation_reconciliations.json');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const inputNames = ('revenue netPropertyIncome corporateExpenses propertyFairValueLoss propertyPlantEquipmentImpairment '
  + 'depreciation cashPropertyAdditions cashOtherCapex newNoncashLeaseAssets leaseDebt receivables depositsAndPrepayments '
  + 'payablesAndAccruals accruedCapex securityDeposits incentiveProvision financingAccrualsIncludingLeases borrowings '
  + 'convertibleBonds noncontrollingLoans netFinancingDerivatives openingFinancingLiabilities cashInterestPaid '
  + 'unrestrictedCashAndDeposits totalCashAndDeposits jointVentureBookValue noncontrollingBookEquity preferredEquity').split(' ');
const fingerprint = statements => crypto.createHash('sha256').update(JSON.stringify({
  annual: statements.annual, quarterly: statements.quarterly
})).digest('hex');

function reconcileValuation(snapshot, statements, record = records.stocks[snapshot.ticker]) {
  if (!record) return snapshot;
  if (record.ticker !== snapshot.ticker || record.ticker !== '0823.HK'
      || record.currency !== 'HKD' || record.unit !== 'millions'
      || !day(record.balanceDate) || !day(record.statementApprovalDate) || record.statementApprovalDate < record.balanceDate
      || !/^[a-f0-9]{64}$/.test(record.financialFingerprint || '')
      || !/^https:\/\//.test(record.document?.url || '')
      || !/^[a-f0-9]{64}$/.test(record.document?.sha256 || '')
      || !day(record.document?.modifiedDate) || record.document.modifiedDate < record.statementApprovalDate
      || !Array.isArray(record.document.pdfPages) || !record.document.pdfPages.length
      || record.document.pdfPages.some(page => !Number.isSafeInteger(page) || page <= 0)
      || inputNames.some(key => !finite(record.inputs?.[key]))) {
    throw new TypeError(`${snapshot.ticker}: invalid official valuation reconciliation`);
  }
  const eligibleReasons = [null, 'leaseClassificationRequired', 'leaseMappingUnverified', 'debtCompositionUnverified'];
  if (!eligibleReasons.includes(snapshot.reason)) return snapshot;
  if (snapshot.currency !== 'HKD' || record.document.modifiedDate > snapshot.valuationDate
      || record.balanceDate !== snapshot.balance?.date || snapshot.ttm?.dates.at(-1) !== record.balanceDate
      || snapshot.annualReference?.date !== record.balanceDate
      || snapshot.ytd?.date !== record.balanceDate || snapshot.ytd.revenue !== 0
      || record.financialFingerprint !== fingerprint(statements)) {
    return { ...snapshot, reason: 'officialReconciliationRequired' };
  }
  const p = record.inputs;
  const requiredPositive = ['revenue', 'netPropertyIncome', 'openingFinancingLiabilities'];
  if (requiredPositive.some(key => !(p[key] > 0))
      || Object.entries(p).some(([key, value]) => key !== 'noncontrollingBookEquity' && value < 0)
      || p.newNoncashLeaseAssets !== 0 || p.leaseDebt > p.financingAccrualsIncludingLeases
      || p.unrestrictedCashAndDeposits > p.totalCashAndDeposits) {
    throw new TypeError(`${snapshot.ticker}: inconsistent official valuation components`);
  }
  const ebit = p.netPropertyIncome - p.corporateExpenses;
  const capex = p.cashPropertyAdditions + p.cashOtherCapex + p.newNoncashLeaseAssets;
  const debt = p.borrowings + p.convertibleBonds + p.noncontrollingLoans
    + p.netFinancingDerivatives + p.financingAccrualsIncludingLeases;
  const workingCapital = p.receivables + p.depositsAndPrepayments - p.payablesAndAccruals
    - p.securityDeposits - p.incentiveProvision + p.accruedCapex + p.financingAccrualsIncludingLeases;
  const averageDebt = (debt + p.openingFinancingLiabilities) / 2;
  const forecasts = snapshot.forecasts.map(row => ({
    ...row,
    unnormalizedConsensus: { ebit: row.ebit, ebitda: row.ebitda },
    ebit: row.revenue * ebit / p.revenue,
    ebitda: row.revenue * (ebit + p.depreciation) / p.revenue,
    operatingBasis: 'normalizedRentalMarginScenario'
  }));
  return { ...snapshot, reason: null, leaseReconciled: true,
    balance: { ...snapshot.balance, leaseDebt: p.leaseDebt, workingCapital },
    ttm: { ...snapshot.ttm, reportingFrequency: 'annual', dates: [record.balanceDate],
      fiscalPeriods: [Number(snapshot.ttm.fiscalPeriods.at(-1))],
      revenue: p.revenue, ebit, depreciation: p.depreciation,
      capex, workingCapital, ebitda: ebit + p.depreciation },
    defaults: { ...snapshot.defaults, reportedDebt: debt, debt, leaseOverlap: 0,
      cash: p.unrestrictedCashAndDeposits, investments: p.jointVentureBookValue,
      minority: p.noncontrollingBookEquity, preferred: p.preferredEquity,
      kd: p.cashInterestPaid / averageDebt * 100,
      depreciationBasis: 'ttm', terminalMethod: 'components' },
    quotedCapital: { date: record.balanceDate, reportedDebt: debt,
      cash: p.totalCashAndDeposits, preferred: p.preferredEquity, minority: p.noncontrollingBookEquity },
    quotedTtm: snapshot.quotedTtm || { ebitda: snapshot.ttm.ebitda, reportedFcf: snapshot.ttm.reportedFcf },
    annualReference: { ...snapshot.annualReference, revenue: p.revenue },
    forecasts,
    officialReconciliation: { ...record, method: 'normalizedRentalFcffScenario',
      basis: 'matchedOfficialAnnualComponents',
      dateBasis: 'Financial-statement approval and document HTTP Last-Modified dates; not certified point-in-time publication evidence',
      operatingWorkingCapitalBasis: 'All disclosed operating receivables, prepayments, deposits and provisions, including noncurrent amounts; excludes financing accruals and cash-capex accruals',
      interestBasis: 'Reported cash interest / average book financing liabilities; historical proxy, not marginal borrowing cost',
      financingBasis: 'Reported financing rollforward: borrowings, convertible bonds, NCI loans, net financing derivatives and financing accruals including leases; book proxies, not verified market values' },
    provenance: { ...snapshot.provenance,
      operatingRatios: 'Reported full-year rental operating components at the matching TTM year-end; source-normalized, not reported accounting profit',
      depreciation: 'Reported PPE depreciation includes own-use ROU depreciation; actual new ROU assets explicitly nil',
      investments: 'Only the joint venture book proxy is added; operating investment properties are already valued through rental FCFF',
      cash: 'Only disclosed unrestricted cash and deposits are added in the model; quoted capital separately retains total reported cash',
      kd: 'Reported cash interest / average official financing rollforward liabilities; adjustable historical proxy',
      debt: { value: debt, leaseDebt: p.leaseDebt, unit: 'HKD',
        basis: 'officialFinancingRollforwardIncludingNoncontrollingLoans', reason: null },
      leases: 'Own-use ROU depreciation remains in D&A; disclosed new noncash ROU assets are nil. Lease debt remains within financing accruals and is deducted once.',
      forecastOperatingProfit: 'Analyst revenue with constant source-normalized rental EBIT and D&A margins; modeled scenario, not analyst profit consensus. Original consensus is preserved separately.',
      terminal: 'Component reinvestment retains property cash capex net of D&A and incremental operating working capital; no investment-property book value is added again' }
  };
}

module.exports = { reconcileValuation, fingerprint };
