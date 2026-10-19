const defaultSource = require('../cache/hkex_revenue_sources.json');
const gamingSources = require('../cache/hkex_gaming_revenue_sources.json').stocks;
const { verifiedIncomeDocument } = require('../fmp_scenario.js');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const multipliers = { units: 1, thousands: 1000, millions: 1000000 };
const date = value => typeof value === 'string' && /^20\d\d-\d\d-\d\d$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const incomeFields = new Set(['revenue', 'grossProfit', 'costOfRevenue', 'operatingIncome', 'ebit',
  'depreciationAndAmortization', 'ebitda', 'operatingExpenses', 'costAndExpenses',
  'interestIncome', 'interestExpense', 'incomeBeforeTax', 'incomeTaxExpense', 'netIncome',
  'netIncomeFromContinuingOperations']);
const reviewedSource = ticker => ticker === defaultSource.symbol ? defaultSource : gamingSources[ticker] || null;

function applyOfficialRevenue(statements, ticker, record = reviewedSource(ticker)) {
  if (!record) return statements;
  const fail = () => { throw new Error('INVALID_OFFICIAL_REVENUE_SOURCE'); };
  const basis = record.basisCode || (ticker === defaultSource.symbol ? 'issuerRevenueBeforeGamingTax' : null);
  const grossProfitPolicy = record.grossProfitPolicy || (ticker === defaultSource.symbol ? 'notReported' : null);
  if (record.symbol !== ticker || !['HKD', 'USD', 'JPY'].includes(record.currency) || !multipliers[record.unit]
      || !['issuerRevenueBeforeGamingTax', 'issuerReportedConsolidatedRevenue'].includes(basis)
      || !['reported', 'notReported', 'periodSpecific'].includes(grossProfitPolicy)
      || !record.documents || typeof record.documents !== 'object'
      || !Array.isArray(record.annual) || !record.annual.length
      || record.interimPeriods !== undefined && !Array.isArray(record.interimPeriods)
      || !Array.isArray(record.halfYear) || !record.halfYear.length) fail();
  const interims = [...record.halfYear, ...(record.interimPeriods || [])];
  if (new Set(interims.map(row => row.date)).size !== interims.length) fail();
  for (const document of Object.values(record.documents || {})) {
    if (!verifiedIncomeDocument(document)) fail();
  }
  for (const [period, rows] of [['annual', record.annual], ['halfYear', record.halfYear], ['interimPeriods', record.interimPeriods || []]]) {
    if (new Set(rows.map(row => row.date)).size !== rows.length) fail();
    for (const row of rows) {
      if (!date(row.date) || row.revenue < 0 || !finite(row.revenue) || !record.documents[row.sourceId]
          || row.unit !== undefined && !multipliers[row.unit]
          || row.periodLength !== undefined && (!Number.isSafeInteger(row.periodLength) || row.periodLength <= 0)
          || row.periodStartDate !== undefined && (!date(row.periodStartDate) || row.periodStartDate > row.date)
          || grossProfitPolicy === 'reported' && !finite(row.income?.grossProfit)
          || grossProfitPolicy === 'periodSpecific' && !Object.hasOwn(row.income || {}, 'grossProfit')
          || row.income && Object.entries(row.income).some(([key, value]) => !incomeFields.has(key)
            || key === 'revenue' || value !== null && !finite(value))
          || row.perShare && Object.entries(row.perShare).some(([key, value]) =>
            !['eps', 'epsdiluted'].includes(key) || value !== null && !finite(value))
          || row.operatingIncomeBasis !== undefined && !['reported', 'derived', 'unavailable'].includes(row.operatingIncomeBasis)
          || row.earningsIncludeDiscontinued !== undefined && typeof row.earningsIncludeDiscontinued !== 'boolean'
          || period === 'interimPeriods' && row.reportType !== 'secondInterim'
          || row.comparabilityGroup !== undefined && (typeof row.comparabilityGroup !== 'string' || !row.comparabilityGroup.trim())) fail();
      if (row.periodStartDate && row.periodLength && row.periodStartDate.endsWith('-01')) {
        const end = new Date(row.date);
        const monthEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate() === end.getUTCDate();
        const start = new Date(row.periodStartDate);
        if (monthEnd && (end.getUTCFullYear() - start.getUTCFullYear()) * 12
            + end.getUTCMonth() - start.getUTCMonth() + 1 !== row.periodLength) fail();
      }
      const costKeys = ['gamingTax', 'rawMaterials', 'depreciation', 'employeeBenefits', 'otherOperating',
        ...(Object.hasOwn(row.operatingCosts || {}, 'commissions') ? ['commissions'] : [])];
      if (row.operatingCosts && (Object.keys(row.operatingCosts).length !== costKeys.length
          || record.unit !== 'thousands' || record.currency !== 'HKD'
          || row.unit !== undefined && row.unit !== 'thousands'
          || !costKeys.every(key => finite(row.operatingCosts[key]) && row.operatingCosts[key] >= 0))) fail();
    }
  }
  const original = { ...(statements.providerRevenueOriginal || {
    annual: structuredClone(statements.annual.income), quarterly: structuredClone(statements.quarterly.income)
  }), qualityWarnings: statements.providerRevenueOriginal?.qualityWarnings
    || structuredClone((statements.qualityWarnings || []).filter(item => item.code !== 'officialRevenueCorrection')) };
  const canonical = record.incomeHistoryPolicy === 'reviewedPeriodsOnly';
  const basisWarnings = [];
  if (canonical) {
    const numericFields = new Set([...incomeFields, 'eps', 'epsdiluted',
      ...[...original.annual, ...original.quarterly].flatMap(row =>
        Object.keys(row).filter(key => typeof row[key] === 'number' && !['fiscalYear', 'calendarYear', 'periodLength'].includes(key)))]);
    const startDate = reviewed => {
      if (reviewed.periodStartDate) return reviewed.periodStartDate;
      if (!Number.isSafeInteger(reviewed.periodLength)) return null;
      const end = new Date(reviewed.date);
      if (new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate() !== end.getUTCDate()) return null;
      return new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1 - reviewed.periodLength, 1)).toISOString().slice(0, 10);
    };
    const annualShells = record.annual.map(reviewed => ({
      ...Object.fromEntries([...numericFields].map(key => [key, null])),
      symbol: ticker, date: reviewed.date, fiscalYear: String(reviewed.fiscalYear || reviewed.date.slice(0, 4)),
      calendarYear: reviewed.date.slice(0, 4), period: 'FY', reportedCurrency: record.currency,
      periodLength: reviewed.periodLength ?? null, periodStartDate: startDate(reviewed),
      comparabilityGroup: reviewed.comparabilityGroup || null,
      reportingFrequency: 'annual', derivation: 'officialIncomeStatement'
    })).sort((a, b) => a.date.localeCompare(b.date));
    const yearEndMonth = Number(annualShells.at(-1).date.slice(5, 7));
    const halfShells = [...record.halfYear, ...(record.interimPeriods || [])].map(reviewed => {
      const annual = annualShells.find(row => row.periodStartDate && row.periodStartDate <= reviewed.date && reviewed.date < row.date);
      return { ...Object.fromEntries([...numericFields].map(key => [key, null])),
        symbol: ticker, date: reviewed.date,
        fiscalYear: String(reviewed.fiscalYear || annual?.fiscalYear
          || Number(reviewed.date.slice(0, 4)) + (Number(reviewed.date.slice(5, 7)) > yearEndMonth ? 1 : 0)),
        calendarYear: reviewed.date.slice(0, 4), period: reviewed.reportType === 'secondInterim' ? 'Q3' : 'Q2', reportedCurrency: record.currency,
        ...(reviewed.reportType ? { reportType: reviewed.reportType } : {}),
        periodLength: reviewed.periodLength ?? null, periodStartDate: startDate(reviewed),
        comparabilityGroup: reviewed.comparabilityGroup || null,
        reportingFrequency: 'semiannual', derivation: 'officialIncomeStatement'
      };
    });
    const secondShells = [];
    for (const annual of annualShells) {
      const first = halfShells.find(row => row.fiscalYear === annual.fiscalYear && row.period === 'Q2');
      if (!first) continue;
      const length = annual.periodLength - first.periodLength;
      if (!annual.periodStartDate || annual.periodStartDate !== first.periodStartDate
          || !Number.isSafeInteger(annual.periodLength) || !Number.isSafeInteger(first.periodLength)
          || !Number.isSafeInteger(length) || length <= 0
          || !annual.comparabilityGroup || annual.comparabilityGroup !== first.comparabilityGroup) {
        basisWarnings.push({ code: 'officialIncomeReconstructionUnavailable', date: annual.date,
          message: 'No H2 is reconstructed without matching reviewed start dates, durations and accounting/continuing-operation bases.' });
        continue;
      }
      secondShells.push({ ...annual, period: 'Q4', periodLength: length,
        periodStartDate: new Date(Date.parse(first.date) + 86400000).toISOString().slice(0, 10),
        reportingFrequency: 'semiannual', derivation: 'officialAnnualMinusOfficialH1' });
    }
    statements = { ...statements, reportingFrequency: 'semiannual',
      statementFrequencies: { ...statements.statementFrequencies, income: 'semiannual' },
      annual: { ...statements.annual, income: annualShells },
      quarterly: { ...statements.quarterly,
        income: [...halfShells, ...secondShells].sort((a, b) => a.date.localeCompare(b.date)) } };
  }
  const corrected = (row, revenue, ids, derivation, costs = null, income = {}, periodMetadata = {}) => {
    if (row.symbol !== ticker || row.reportedCurrency !== record.currency || !finite(revenue) || revenue < 0) fail();
    const old = original[row.period === 'FY' ? 'annual' : 'quarterly'].find(item => item.date === row.date);
    if ((!old || !finite(old.revenue)) && !canonical) fail();
    const operatingExpenses = costs ? Object.values(costs).reduce((sum, amount) => sum + amount, 0) * 1000 : null;
    const operating = costs ? { operatingIncome: revenue - operatingExpenses, ebit: revenue - operatingExpenses,
      depreciationAndAmortization: costs.depreciation * 1000,
      ebitda: revenue - operatingExpenses + costs.depreciation * 1000, operatingExpenses,
      costAndExpenses: operatingExpenses, researchAndDevelopmentExpenses: null, generalAndAdministrativeExpenses: null,
      sellingAndMarketingExpenses: null, sellingGeneralAndAdministrativeExpenses: null, otherExpenses: null } : {};
    const gross = grossProfitPolicy === 'notReported'
      ? { costOfRevenue: null, grossProfit: null, grossProfitRatio: null, costAndExpenses: null } : {};
    const reportedOperating = Object.hasOwn(income, 'operatingIncome')
      && ['reportedOperatingIncomePlusReportedDA', 'derivedOperatingIncomePlusReportedDA'].includes(record.ebitdaBasis)
      ? { ebit: income.operatingIncome, ebitda: finite(income.operatingIncome) && finite(income.depreciationAndAmortization)
        ? income.operatingIncome + income.depreciationAndAmortization : null } : {};
    const derivedOperating = !!costs || periodMetadata.operatingIncomeBasis === 'derived'
      || periodMetadata.operatingIncomeBasis === undefined && record.ebitdaBasis === 'derivedOperatingIncomePlusReportedDA';
    const result = { ...row, ...gross, ...operating, ...income, ...reportedOperating, revenue, ...periodMetadata,
      revenueCorrection: { symbol: ticker, providerRevenue: finite(old?.revenue) ? old.revenue : null, reportedRevenue: revenue,
        sourceIds: ids, derivation, basis,
        reviewedIncomeFields: Object.keys(income),
        operatingIncomeBasis: derivedOperating ? 'derived'
          : periodMetadata.operatingIncomeBasis || (finite(income.operatingIncome) ? 'reported' : 'unavailable'),
        operatingCosts: costs, operatingBasis: costs ? 'Revenue less reported operating-cost categories, including expensed commissions where disclosed; core EBITDA adds reported D&A once, not adjusted EBITDA' : null,
        grossProfitBasis: grossProfitPolicy === 'reported' || finite(income.grossProfit) ? 'Issuer reported gross-profit subtotal'
          : 'Not reported in the issuer expenses-by-nature income statement' } };
    if (Object.keys(reportedOperating).length) {
      result.revenueCorrection.operatingBasis = derivedOperating
        ? 'Derived operating profit from cited statement lines plus disclosed D&A; not an issuer-reported subtotal or adjusted EBITDA'
        : 'Reported operating profit plus disclosed D&A; not adjusted EBITDA';
    }
    for (const [ratio, numerator] of Object.entries({ grossProfitRatio: 'grossProfit', operatingIncomeRatio: 'operatingIncome',
      incomeBeforeTaxRatio: 'incomeBeforeTax', netIncomeRatio: 'netIncome', ebitdaRatio: 'ebitda', ebitdaratio: 'ebitda' })) {
      result[ratio] = revenue > 0 && finite(result[numerator]) ? result[numerator] / revenue : null;
    }
    if (result.earningsIncludeDiscontinued) result.netIncomeRatio = revenue > 0 && finite(result.netIncomeFromContinuingOperations)
      ? result.netIncomeFromContinuingOperations / revenue : null;
    return result;
  };
  const fromRecord = (row, reviewed, derivation) => {
    const multiplier = multipliers[reviewed.unit || record.unit];
    const income = Object.fromEntries(Object.entries(reviewed.income || {}).map(([key, value]) =>
      [key, value === null ? null : value * multiplier]));
    if (canonical && !Object.hasOwn(income, 'depreciationAndAmortization')) income.depreciationAndAmortization = null;
    const periodMetadata = Object.fromEntries(['periodStartDate', 'periodLength', 'operatingIncomeBasis', 'comparabilityGroup', 'earningsIncludeDiscontinued'].filter(key => reviewed[key] !== undefined)
      .map(key => [key, reviewed[key]]));
    Object.assign(periodMetadata, reviewed.perShare || {});
    if (Object.hasOwn(reviewed.perShare || {}, 'epsdiluted')) periodMetadata.epsDiluted = reviewed.perShare.epsdiluted;
    return corrected(row, reviewed.revenue * multiplier, [reviewed.sourceId], derivation,
      reviewed.operatingCosts, income, periodMetadata);
  };
  const annual = statements.annual.income.map(row => {
    const reviewed = record.annual.find(item => item.date === row.date);
    return reviewed ? fromRecord(row, reviewed, 'issuerReportedAnnual') : row;
  });
  const halfRows = statements.quarterly.income.filter(row => row.period === 'Q2').map(row => {
    const reviewed = record.halfYear.find(item => item.date === row.date);
    return reviewed ? fromRecord(row, reviewed, 'issuerReportedH1') : row;
  });
  const quarterly = statements.quarterly.income.map(row => {
    if (row.reportType === 'secondInterim') return fromRecord(row,
      record.interimPeriods.find(item => item.date === row.date), 'issuerReportedSecondInterim');
    if (row.period === 'Q2') return halfRows.find(item => item.date === row.date);
    const fy = annual.find(item => item.fiscalYear === row.fiscalYear && item.revenueCorrection);
    const h1 = halfRows.find(item => item.fiscalYear === row.fiscalYear && item.revenueCorrection);
    if (row.period !== 'Q4' || !fy || !h1
        || !canonical && (fy.periodLength !== 12 || h1.periodLength !== 6)) return row;
    const fyCosts = fy.revenueCorrection.operatingCosts;
    const h1Costs = h1.revenueCorrection.operatingCosts;
    if (fyCosts && h1Costs && (Object.keys(fyCosts).length !== Object.keys(h1Costs).length
        || Object.keys(fyCosts).some(key => !Object.hasOwn(h1Costs, key)))) {
      basisWarnings.push({ code: 'officialOperatingCostBasisMismatch', date: row.date,
        message: 'H2 is not reconstructed: reviewed annual and H1 commission/cost presentations differ. Provider row retained as unreviewed.' });
      const provider = original.quarterly.find(item => item.date === row.date);
      if (!provider) fail();
      return structuredClone(provider);
    }
    const costs = fy.revenueCorrection.operatingCosts && h1.revenueCorrection.operatingCosts
      ? Object.fromEntries(Object.entries(fy.revenueCorrection.operatingCosts)
        .map(([key, amount]) => [key, amount - h1.revenueCorrection.operatingCosts[key]])) : null;
    if (costs && Object.values(costs).some(amount => amount < 0)) fail();
    const income = Object.fromEntries((fy.revenueCorrection.reviewedIncomeFields || [])
      .filter(key => h1.revenueCorrection.reviewedIncomeFields.includes(key))
      .map(key => [key, finite(fy[key]) && finite(h1[key]) ? fy[key] - h1[key] : null]));
    return corrected(row, fy.revenue - h1.revenue,
      [...new Set([...fy.revenueCorrection.sourceIds, ...h1.revenueCorrection.sourceIds])],
      'officialAnnualMinusOfficialH1', costs, income, canonical
        ? { operatingIncomeBasis: fy.operatingIncomeBasis === 'derived' || h1.operatingIncomeBasis === 'derived' ? 'derived' : 'reported',
          earningsIncludeDiscontinued: !!(fy.earningsIncludeDiscontinued || h1.earningsIncludeDiscontinued) } : {});
  });
  const reconciled = new Set(annual.filter(fy => fy.revenueCorrection
    && quarterly.filter(row => row.fiscalYear === fy.fiscalYear && row.revenueCorrection).length === 2
    && quarterly.filter(row => row.fiscalYear === fy.fiscalYear)
      .reduce((sum, row) => sum + row.revenue, 0) === fy.revenue).map(row => row.date));
  return { ...statements, annual: { ...statements.annual, income: annual },
    quarterly: { ...statements.quarterly, income: quarterly }, providerRevenueOriginal: original,
    revenueProvenance: record,
    qualityWarnings: [...(statements.qualityWarnings || []).filter(item => item.code !== 'officialRevenueCorrection'
      && item.code !== 'officialOperatingCostBasisMismatch'
      && item.code !== 'officialIncomeReconstructionUnavailable'
      && !(canonical && item.code === 'annualInterimReconciliation')
      && !(item.code === 'annualInterimReconciliation' && reconciled.has(item.date))),
      ...basisWarnings,
      { code: 'officialRevenueCorrection',
        message: `${record.basis} ${record.limitations}` }] };
}

module.exports = { applyOfficialRevenue, reviewedSource };
