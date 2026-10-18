const finite = value => typeof value === 'number' && Number.isFinite(value);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const ordered = rows => rows.slice().sort((a, b) => a.date.localeCompare(b.date));
const nextDay = date => new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
const fail = () => { throw new Error('INVALID_OFFICIAL_CASHFLOW_SOURCE'); };

function reviewedSource(ticker) {
  const source = require('../cache/hkex_cashflow_sources.json');
  const issuer = source.issuers.find(item => item.symbol === ticker);
  if (!issuer) return null;
  const ids = new Set(issuer.periods.flatMap(period => period.sourceRefs.map(ref => ref.sourceId)));
  return { ticker, currency: issuer.currency, unit: issuer.unit, notes: issuer.comparabilityNotes,
    documents: [...ids].map(id => ({ id, url: source.sources[id].url, sha256: source.sources[id].sha256,
      pdfPages: Object.values(source.sources[id].pages).map(page => page.pdf) })),
    periods: issuer.periods.map(period => {
      const fields = { ...period.fields };
      for (const [field, amount] of Object.entries(period.lines)) {
        if (amount === null || finite(amount)) fields[field] = amount;
      }
      const items = ticker === '0388.HK'
        ? ['headquartersPremisesAcquisitionPayments', 'otherFixedAssetAndIntangiblePurchasesCombined']
        : ['netPropertyPlantAndEquipmentPurchasesAndSales', 'netIntangibleAssetInvestment'];
      fields.capitalExpenditure = items.every(field => finite(fields[field]))
        ? items.reduce((sum, field) => sum + fields[field], 0) : null;
      fields.otherNonCashItems = fields.otherNonCashAdjustments;
      if (ticker === '0388.HK') fields.commonDividendsPaid = fields.dividendsPaidToHKEXShareholders;
      if (ticker === '0005.HK') {
        fields.commonStockRepurchased = fields.shareBuybacks;
        fields.commonDividendsPaid = fields.dividendsPaidOnOrdinaryShares;
        if (!finite(fields.commonDividendsPaid)
            || fields.commonDividendsPaid + fields.couponsPaidOnEquityCapitalSecurities !== fields.parentDividendsAndEquityCouponsPaid
            || fields.parentDividendsAndEquityCouponsPaid < fields.dividendsPaidToParentShareholdersAndNonControllingInterests) fail();
      }
      return { ...period, fields, sourceIds: period.sourceRefs.map(ref => ref.sourceId) };
    }) };
}

function applyOfficialCashflows(statements, ticker, record) {
  if (!record) return statements;
  if (!['0005.HK', '0388.HK'].includes(ticker) || record.ticker !== ticker
      || !['USD', 'HKD'].includes(record.currency) || record.unit !== 'millions'
      || !Array.isArray(record.periods) || !record.periods.length || !record.documents?.length) fail();
  for (const document of record.documents) {
    if (!/^https:\/\/(?:www1\.hkexnews\.hk|www\.hkexgroup\.com|www\.hsbc\.com)\//.test(document.url || '')
        || !/^[a-f0-9]{64}$/.test(document.sha256 || '')
        || !document.pdfPages?.length || document.pdfPages.some(page => !Number.isSafeInteger(page) || page < 1)) fail();
  }
  const rows = record.periods.map(period => {
    const year = Number(period.fiscalYear);
    if (!Number.isInteger(year) || !day(period.start) || !day(period.end)
        || period.start !== `${year}-01-01` || !['FY', 'H1'].includes(period.period)
        || period.end !== `${year}-${period.period === 'FY' ? '12-31' : '06-30'}`
        || !period.sourceIds?.length || period.sourceIds.some(id => !record.documents.some(doc => doc.id === id))) fail();
    const anchors = period.period === 'FY' ? statements.annual.income : statements.quarterly.income;
    if (!anchors.some(row => row.date === period.end && row.reportedCurrency === record.currency)) {
      throw new Error('OFFICIAL_CASHFLOW_PERIOD_COVERAGE_REVIEW_REQUIRED');
    }
    const fields = {};
    for (const [field, amount] of Object.entries(period.fields)) {
      if (amount !== null && !finite(amount)) fail();
      fields[field] = amount === null ? null : amount * 1e6;
    }
    for (const field of ['operatingCashFlow', 'netCashProvidedByInvestingActivities', 'netCashProvidedByFinancingActivities',
      'netChangeInCash', 'effectOfForexChangesOnCash', 'cashAtBeginningOfPeriod', 'cashAtEndOfPeriod']) {
      if (!finite(fields[field])) fail();
    }
    if (Math.abs(fields.operatingCashFlow + fields.netCashProvidedByInvestingActivities
        + fields.netCashProvidedByFinancingActivities - fields.netChangeInCash) > 1
        || Math.abs(fields.cashAtBeginningOfPeriod + fields.netChangeInCash
          + fields.effectOfForexChangesOnCash - fields.cashAtEndOfPeriod) > 1) fail();
    if (record.currency !== statements.annual.income.at(-1)?.reportedCurrency) fail();
    fields.netCashProvidedByOperatingActivities = fields.operatingCashFlow;
    if (finite(fields.capitalExpenditure)) fields.freeCashFlow = fields.operatingCashFlow + fields.capitalExpenditure;
    return { ...fields, symbol: ticker, reportedCurrency: record.currency, date: period.end,
      fiscalYear: String(year), period: period.period === 'FY' ? 'FY' : 'Q2',
      periodStartDate: period.start, periodLength: period.period === 'FY' ? 12 : 6,
      reportingFrequency: period.period === 'FY' ? 'annual' : 'semiannual',
      derivation: 'issuerReportedCashflow', sourceIds: period.sourceIds,
      availabilityBasis: 'retrospectiveOfficialCorrectionNotPointInTime',
      sourceBasis: period.basis || 'reportedIFRS', sourceLines: period.lines };
  });
  if (new Set(rows.map(row => row.date)).size !== rows.length) fail();
  const annuals = rows.filter(row => row.period === 'FY'), halves = rows.filter(row => row.period === 'Q2');
  const derived = [];
  for (const annual of annuals) {
    const first = halves.find(row => row.fiscalYear === annual.fiscalYear);
    if (!first) continue;
    const second = { ...annual, period: 'Q4', periodLength: 6, reportingFrequency: 'semiannual',
      periodStartDate: nextDay(first.date), derivation: 'annualMinusOfficialH1', sourceDates: [annual.date, first.date],
      sourceIds: [...new Set([...annual.sourceIds, ...first.sourceIds])], sourceLines: null };
    for (const field of new Set([...Object.keys(annual), ...Object.keys(first)])) {
      if (field === 'periodLength') continue;
      if (finite(annual[field]) || finite(first[field])) {
        second[field] = finite(annual[field]) && finite(first[field]) ? annual[field] - first[field] : null;
      }
    }
    second.cashAtBeginningOfPeriod = first.cashAtEndOfPeriod;
    second.cashAtEndOfPeriod = annual.cashAtEndOfPeriod;
    derived.push(second);
  }
  const sourceDates = new Set(annuals.map(row => row.date));
  const interimDates = new Set([...halves, ...derived].map(row => row.date));
  if (statements.quarterly.cashflow.some(row => !interimDates.has(row.date)
      || row.periodLength !== 6)) {
    throw new Error('OFFICIAL_CASHFLOW_MIXED_CADENCE_REVIEW_REQUIRED');
  }
  const originalAnnual = statements.annual.cashflow.filter(row => sourceDates.has(row.date)
    && row.derivation !== 'issuerReportedCashflow');
  return { ...statements,
    annual: { ...statements.annual, cashflow: ordered([
      ...statements.annual.cashflow.filter(row => !sourceDates.has(row.date)), ...annuals]) },
    quarterly: { ...statements.quarterly, cashflow: ordered([...halves, ...derived]) },
    statementFrequencies: { ...statements.statementFrequencies, cashflow: 'semiannual' },
    qualityWarnings: (statements.qualityWarnings || []).map(warning =>
      ['unreportedCashflows', 'incompleteCashflowCoverage'].includes(warning.code)
        ? { code: 'officialCashflowSourceReplacement',
          message: 'Invalid FMP interim cash flow is archived; cited official annual and half-year reports now supply verified periods.',
          originalWarning: warning } : warning),
    archivedProviderAnnualCashflow: originalAnnual.length ? originalAnnual : statements.archivedProviderAnnualCashflow,
    cashflowProvenance: { ticker, currency: record.currency, unit: record.unit,
      documents: record.documents, annualDates: [...sourceDates], interimDates: halves.map(row => row.date),
      derivation: 'officialAnnualMinusOfficialH1PlusOfficialH1', notes: record.notes || [] }
  };
}

module.exports = { applyOfficialCashflows, reviewedSource };
