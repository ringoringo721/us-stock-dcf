const crypto = require('node:crypto');
const { rateFor } = require('../usd_currency.js');
const records = require('../cache/hkex_valuation_reconciliations.json');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const inputNames = ('revenue netPropertyIncome corporateExpenses propertyFairValueLoss propertyPlantEquipmentImpairment '
  + 'depreciation cashPropertyAdditions cashOtherCapex newNoncashLeaseAssets leaseDebt receivables depositsAndPrepayments '
  + 'payablesAndAccruals accruedCapex securityDeposits incentiveProvision financingAccrualsIncludingLeases borrowings '
  + 'convertibleBonds noncontrollingLoans netFinancingDerivatives openingFinancingLiabilities cashInterestPaid '
  + 'unrestrictedCashAndDeposits totalCashAndDeposits jointVentureBookValue noncontrollingBookEquity preferredEquity').split(' ');
const fingerprint = statements => {
  const original = statements.propertyFvOriginal || statements;
  return crypto.createHash('sha256').update(JSON.stringify({
    annual: original.annual, quarterly: original.quarterly
  })).digest('hex');
};

function reconcileOperatingComponents(snapshot, statements, record, rates) {
  const invalid = () => { throw new TypeError(`${snapshot.ticker}: invalid official operating reconciliation`); };
  const flowKeys = ['revenue', 'ebit', 'depreciation', 'cashCapex', 'newNoncashLeaseAssets', 'taxExpense', 'pretax'];
  const validFlow = flow => flow && day(flow.start) && day(flow.end) && flow.start <= flow.end
    && flowKeys.every(key => finite(flow[key])) && flow.revenue > 0
    && ['depreciation', 'cashCapex', 'newNoncashLeaseAssets'].every(key => flow[key] >= 0);
  const p = record.capital, kd = record.debtCost;
  if (!['0700.HK', '0388.HK', '9988.HK'].includes(record.ticker) || record.ticker !== snapshot.ticker
      || !['CNY', 'HKD'].includes(record.currency) || record.unit !== 'millions'
      || !day(record.balanceDate) || !day(record.annualReference?.date) || !(record.annualReference.revenue > 0)
      || !/^[a-f0-9]{64}$/.test(record.financialFingerprint || '')
      || !Array.isArray(record.documents) || !record.documents.length
      || record.documents.some(doc => !/^https:\/\//.test(doc.url || '') || !day(doc.availableDate)
        || !/^[a-f0-9]{64}$/.test(doc.sha256 || '') || !Array.isArray(doc.pdfPages) || !doc.pdfPages.length
        || doc.pdfPages.some(page => !Number.isSafeInteger(page) || page <= 0))
      || !Array.isArray(record.flows) || !record.flows.length || !record.flows.every(validFlow)
      || record.flows.some((flow, i) => flow.end > record.balanceDate
        || (i && Date.parse(flow.start) - Date.parse(record.flows[i - 1].end) !== 86400000))
      || !['debt', 'leaseDebt', 'cash', 'investments', 'otherClaims', 'preferred', 'minority', 'workingCapital']
        .every(key => finite(p?.[key]))
      || Object.entries(p).some(([key, value]) => key !== 'workingCapital' && value < 0)
      || p.leaseDebt > p.debt || !['interest', 'openingDebt', 'closingDebt', 'annualization'].every(key => finite(kd?.[key]))
      || kd.interest < 0 || kd.openingDebt < 0 || kd.closingDebt < 0 || kd.openingDebt + kd.closingDebt <= 0
      || !day(kd.start) || !day(kd.end) || kd.end > record.balanceDate || kd.start >= kd.end
      || Math.abs(kd.annualization - 365.25 / ((Date.parse(kd.end) - Date.parse(kd.start)) / 86400000)) > 0.02
      || (record.ytd !== null && !validFlow(record.ytd))
      || !['annual', 'reconstructedTtm'].includes(record.basis)
      || record.basis === 'annual' && (!Number.isSafeInteger(record.fiscalYear) || record.fiscalYear < 1900)
      || record.reviewedSnapshotDate && !day(record.reviewedSnapshotDate)
      || record.quotedCapital && (!day(record.quotedCapital.date)
        || !['reportedDebt', 'cash', 'preferred', 'minority'].every(key => finite(record.quotedCapital[key]) && record.quotedCapital[key] >= 0))
      || typeof record.noteZh !== 'string' || typeof record.noteEn !== 'string') invalid();
  if (![null, 'leaseClassificationRequired', 'leaseMappingUnverified', 'debtCompositionUnverified'].includes(snapshot.reason)) return snapshot;
  const first = record.flows[0], last = record.flows.at(-1);
  const span = (Date.parse(last.end) - Date.parse(first.start)) / 86400000 + 1;
  const reviewedDate = record.reviewedSnapshotDate || record.balanceDate;
  if (snapshot.currency !== 'HKD' || snapshot.sourceCurrency !== record.currency
      || record.documents.some(doc => doc.availableDate > snapshot.valuationDate)
      || reviewedDate !== snapshot.balance?.date || snapshot.ttm?.dates.at(-1) !== reviewedDate
      || record.balanceDate > reviewedDate
      || record.quotedCapital && record.quotedCapital.date !== reviewedDate
      || snapshot.annualReference?.date !== record.annualReference.date || last.end !== record.balanceDate
      || span < 365 || span > 366 || (record.ytd && record.ytd.end !== record.balanceDate)
      || record.financialFingerprint !== fingerprint(statements)) {
    return { ...snapshot, reason: 'officialReconciliationRequired' };
  }
  const closing = rateFor(rates, record.currency, null, record.balanceDate, 'closing', 'HKD');
  const averages = record.flows.map(flow => rateFor(rates, record.currency, flow.start, flow.end, 'average', 'HKD'));
  const forecastFx = snapshot.provenance?.forecastFx?.rate;
  const quotedFx = record.quotedCapital
    ? rateFor(rates, record.currency, null, record.quotedCapital.date, 'closing', 'HKD') : null;
  if (!finite(closing.rate) || averages.some(fx => !finite(fx.rate)) || !finite(forecastFx)
      || quotedFx && !finite(quotedFx.rate)) {
    return { ...snapshot, reason: 'missingFx' };
  }
  const aggregate = key => record.flows.reduce((sum, flow, i) => sum + flow[key] * averages[i].rate, 0);
  const revenue = aggregate('revenue'), ebit = aggregate('ebit'), depreciation = aggregate('depreciation');
  const workingCapital = p.workingCapital * closing.rate;
  const capex = aggregate('cashCapex') + aggregate('newNoncashLeaseAssets');
  const tax = aggregate('taxExpense') / aggregate('pretax') * 100;
  if (!finite(tax) || tax < 0 || tax > 100) invalid();
  const adjustment = record.forecastExclusion;
  if (adjustment && (!finite(adjustment.revenue) || !finite(adjustment.profit)
      || !finite(adjustment.referenceRevenue) || adjustment.referenceRevenue <= 0
      || adjustment.revenue < 0 || adjustment.revenue >= adjustment.referenceRevenue
      || adjustment.profit < 0)) invalid();
  const forecasts = adjustment ? snapshot.forecasts.map(row => {
    const raw = row.operatingBasis === 'exCorporateInvestmentIncomeScenario' ? row.unnormalizedConsensus : row;
    return { ...row, unnormalizedConsensus: { revenue: raw.revenue, ebit: raw.ebit, ebitda: raw.ebitda },
      revenue: raw.revenue * (1 - adjustment.revenue / adjustment.referenceRevenue),
      ebit: finite(raw.ebit) ? raw.ebit - raw.revenue * adjustment.profit / adjustment.referenceRevenue : null,
      ebitda: finite(raw.ebitda) ? raw.ebitda - raw.revenue * adjustment.profit / adjustment.referenceRevenue : null,
      operatingBasis: 'exCorporateInvestmentIncomeScenario' };
  }) : snapshot.forecasts;
  const ytd = record.ytd;
  return { ...snapshot, reason: null, leaseReconciled: true,
    balance: { ...snapshot.balance, date: record.balanceDate, workingCapital, leaseDebt: p.leaseDebt * closing.rate, fx: closing },
    ttm: { ...snapshot.ttm, revenue, ebit, ebitda: ebit + depreciation, depreciation, capex, workingCapital,
      ...(record.basis === 'annual' ? { reportingFrequency: 'annual', dates: [record.balanceDate], reportedFcf: null,
        fiscalPeriods: [record.fiscalYear * 4 + 4] } : {}) },
    annualReference: { date: record.annualReference.date, revenue: record.annualReference.revenue * forecastFx },
    ytd: { date: record.balanceDate, revenue: ytd ? ytd.revenue * forecastFx : 0,
      ebit: ytd ? ytd.ebit * forecastFx : 0, depreciation: ytd ? ytd.depreciation * forecastFx : 0,
      ebitda: ytd ? (ytd.ebit + ytd.depreciation) * forecastFx : 0,
      capex: ytd ? (ytd.cashCapex + ytd.newNoncashLeaseAssets) * forecastFx : 0 },
    defaults: { ...snapshot.defaults, reportedDebt: p.debt * closing.rate, debt: p.debt * closing.rate, leaseOverlap: 0,
      cash: p.cash * closing.rate, investments: (p.investments - p.otherClaims) * closing.rate,
      preferred: p.preferred * closing.rate, minority: p.minority * closing.rate,
      kd: kd.interest * kd.annualization / ((kd.openingDebt + kd.closingDebt) / 2) * 100,
      tax, depreciationBasis: 'ttm' },
    quotedCapital: record.quotedCapital ? { date: record.quotedCapital.date,
      ...Object.fromEntries(['reportedDebt', 'cash', 'preferred', 'minority'].map(key => [key, record.quotedCapital[key] * quotedFx.rate])) }
      : snapshot.quotedCapital || { date: record.balanceDate, reportedDebt: p.debt * closing.rate,
      cash: p.cash * closing.rate, preferred: p.preferred * closing.rate, minority: p.minority * closing.rate },
    quotedTtm: snapshot.quotedTtm || { ebitda: snapshot.ttm.ebitda, reportedFcf: snapshot.ttm.reportedFcf },
    forecasts,
    officialReconciliation: { ...record, method: 'officialOperatingComponents',
      basis: record.basis === 'annual' ? 'matchedOfficialAnnualComponents' : 'matchedOfficialTtmComponents',
      dateBasis: 'Dated public filings / HTTP document modification; not certified point-in-time history',
      conversion: { closing, periods: averages },
      document: record.documents[0] },
    provenance: { ...snapshot.provenance, operatingRatios: record.noteEn,
      debt: { value: p.debt * closing.rate, leaseDebt: p.leaseDebt * closing.rate,
        unit: 'HKD', basis: 'issuerSpecificOfficialFinancingComponents', reason: null },
      kd: `Interest proxy for ${kd.start} to ${kd.end}; annualization ${kd.annualization}; not marginal borrowing cost`,
      debtCost: { ...kd, basis: 'periodMatchedOfficialInterestAndBookBorrowings' },
      cash: record.cashBasis || 'Disclosed unrestricted cash and deposits; restricted/client cash excluded',
      investments: 'Identified nonoperating financial assets at book proxies, net of separately identified other financial claims; not verified realizable equity values',
      leases: record.leaseBasis }
  };
}

function reconcileValuation(snapshot, statements, record = records.stocks[snapshot.ticker], rates) {
  if (!record) return snapshot;
  if (record.method === 'officialOperatingComponents') return reconcileOperatingComponents(snapshot, statements, record, rates);
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
