const crypto = require('node:crypto');
const reviewed = require('../cache/property_fv_sources.json');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clone = value => structuredClone(value);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sort = rows => rows.sort((a, b) => a.date.localeCompare(b.date));
const amount = value => finite(value) ? value * 1e6 : null;
const difference = (a, b) => finite(a) && finite(b) ? a - b : null;
const incomeFields = ['operatingIncome', 'ebit', 'ebitda', 'netIncome'];

function facts(columns, rows) {
  if (!Array.isArray(rows) || rows.length !== 8 || rows.some((row, index) =>
    row.length !== columns.length || row[0] !== 2019 + index
      || row.slice(1).some(value => value !== null && !finite(value)))) {
    throw new TypeError('Invalid reviewed property FV source rows');
  }
  return rows.map(row => Object.fromEntries(columns.map((key, i) => [key, row[i]])));
}

function applyPropertyFv(statements, ticker, record = reviewed) {
  if (ticker !== record.ticker) return statements;
  if (record.version !== 1 || record.ticker !== '0823.HK' || record.currency !== 'HKD'
      || record.unit !== 'millions' || Object.keys(record.documents).length !== 8
      || Object.values(record.documents).some(doc => !/^https:\/\/www\.linkreit\.com\//.test(doc.url)
        || !/^[a-f0-9]{64}$/.test(doc.sha256) || !doc.pdfPages?.length
        || doc.pdfPages.some(page => !Number.isSafeInteger(page) || page <= 0))) {
    throw new TypeError('Invalid reviewed property FV source provenance');
  }
  const original = clone(statements.propertyFvOriginal || {
    annual: statements.annual, quarterly: statements.quarterly,
    calculationCurrency: statements.calculationCurrency, reportingFrequency: statements.reportingFrequency,
    statementFrequencies: statements.statementFrequencies, qualityWarnings: statements.qualityWarnings
  });
  const result = { ...statements, annual: clone(original.annual), quarterly: clone(original.quarterly),
    propertyFvOriginal: original };
  const provenance = { version: record.version, sourceHash: digest(record), currency: record.currency,
    firstFiscalYear: 2019, lastFiscalYear: 2026, notes: record.notes, documents: record.documents,
    nativeFmpForecasts: 'unchanged', fScoreBasis: 'originalReportedStatements',
    originalData: 'propertyFvOriginal', incomeScope: 'fieldSpecificAdjustmentsNotRestatedGaapStatements',
    missingAdjustedDilutedEps: 'Convertible dilution must be re-tested on adjusted earnings' };
  result.propertyFvProvenance = provenance;
  for (const frequency of ['annual', 'halfYear']) {
    const annual = frequency === 'annual', section = annual ? result.annual : result.quarterly;
    const rows = facts(record.incomeColumns, record[`${frequency}Income`]);
    const cash = facts(record.cashColumns, record[`${frequency}Cash`]);
    const units = record[annual ? 'reportedBasicUnitsAnnual' : 'reportedBasicUnitsHalfYear'];
    const dilutedUnits = record[annual ? 'reportedDilutedUnitsAnnual' : 'reportedDilutedUnitsHalfYear'];
    if ([units, dilutedUnits].some(rows => rows?.length !== 8 || rows.some(value => !Number.isSafeInteger(value) || value <= 0))) {
      throw new TypeError('Invalid reviewed unit counts');
    }
    for (let i = 0; i < rows.length; i++) {
      const f = rows[i], c = cash[i], year = f.year;
      const date = annual ? `${year}-03-31` : `${year - 1}-09-30`;
      const row = section.income.find(row => row.date === date);
      if (!row || row.reportedCurrency !== 'HKD' || !(row.revenue > 0)
          || (annual ? row.period !== 'FY' : row.period !== 'Q2')) {
        throw new TypeError(`${ticker}: property FV source period mismatch ${date}`);
      }
      const documentId = `${year % 2 ? year + 1 : year}${annual ? 'annual' : 'interim'}`;
      const meta = { date, symbol: ticker, reportedCurrency: 'HKD', fiscalYear: String(year),
        period: annual ? 'FY' : 'Q2', periodLength: annual ? 12 : 6,
        periodStartDate: `${year - 1}-04-01`, reportingFrequency: annual ? 'annual' : 'semiannual',
        derivation: 'officialPropertyFvReview', sourceIds: [documentId] };
      const normalization = { sourceIds: [documentId], reportedAttributableProfit: amount(f.attributableProfit),
        propertyFvGain: amount(f.propertyFvGain), attributableFvAddback: amount(f.attributableFvAddback),
        propertyDeferredTaxAdjustment: amount(f.propertyDeferredTaxAdjustment),
        ebitScope: 'exConsolidatedPropertyFvJvShareOfProfitRetained', depreciationSource: 'originalFmpHistoricalDa',
        netIncomeReason: finite(f.attributableFvAddback) ? null : 'PROPERTY_FV_AND_OTHER_IMPAIRMENTS_NOT_SEPARABLE' };
      row.operatingIncome = finite(f.operatingImpairment)
        ? amount(f.netPropertyIncome - f.corporateExpenses - f.operatingImpairment) : null;
      row.ebit = finite(f.propertyFvGain) ? amount(f.pretax + f.financeCosts - f.propertyFvGain) : null;
      row.ebitda = finite(row.ebit) && finite(row.depreciationAndAmortization)
        ? row.ebit + row.depreciationAndAmortization : null;
      row.netIncome = finite(f.attributableFvAddback) && finite(f.propertyDeferredTaxAdjustment)
        ? amount(f.attributableProfit + f.attributableFvAddback + f.propertyDeferredTaxAdjustment) : null;
      row.weightedAverageShsOut = units[i];
      row.weightedAverageShsOutDil = dilutedUnits[i];
      row.eps = finite(row.netIncome) ? row.netIncome / units[i] : null;
      row.epsDiluted = null;
      row.propertyFvNormalization = normalization;
      for (const [field, numerator] of [['operatingIncomeRatio', 'operatingIncome'], ['ebitdaratio', 'ebitda'],
        ['netIncomeRatio', 'netIncome']]) row[field] = finite(row[numerator]) ? row[numerator] / row.revenue : null;
      if (c.operatingCashFlow + c.investingCashFlow + c.financingCashFlow !== c.netChange
          || c.openingCash + c.netChange + c.fxOnCash + c.heldForSaleCashMovement !== c.closingCash
          || c.investmentPropertyAdditions < 0 || c.ppeAdditions < 0) {
        throw new TypeError(`${ticker}: official property cash flow does not reconcile ${date}`);
      }
      const cf = { ...meta, sourceBasis: 'officialStatutoryCfoBeforeFinancingInterest',
        propertyFvNormalization: { sourceIds: [documentId], cashBasis: 'statutoryCfoLessCashPropertyAndPpeAdditions' },
        incomeBeforeTax: amount(f.pretax), netIncome: null,
        operatingCashFlow: amount(c.operatingCashFlow),
        netCashProvidedByOperatingActivities: amount(c.operatingCashFlow),
        cashInvestmentPropertyAdditions: amount(c.investmentPropertyAdditions),
        cashPpeAdditions: amount(c.ppeAdditions),
        capitalExpenditure: -amount(c.investmentPropertyAdditions + c.ppeAdditions),
        investmentsInPropertyPlantAndEquipment: -amount(c.ppeAdditions),
        freeCashFlow: amount(c.operatingCashFlow - c.investmentPropertyAdditions - c.ppeAdditions),
        netCashProvidedByInvestingActivities: amount(c.investingCashFlow),
        netCashProvidedByFinancingActivities: amount(c.financingCashFlow),
        netChangeInCash: amount(c.netChange), cashAtBeginningOfPeriod: amount(c.openingCash),
        cashAtEndOfPeriod: amount(c.closingCash), effectOfForexChangesOnCash: amount(c.fxOnCash),
        heldForSaleCashMovement: amount(c.heldForSaleCashMovement),
        commonDividendsPaid: amount(c.cashDistributions), netDividendsPaid: amount(c.cashDistributions),
        commonStockRepurchased: amount(c.unitRepurchases) };
      section.cashflow = section.cashflow.filter(row => row.date !== date).concat(cf);
    }
  }
  for (const a of result.annual.income.filter(row => row.propertyFvNormalization)) {
    const h1 = result.quarterly.income.find(row => row.date === `${Number(a.fiscalYear) - 1}-09-30`);
    const h2 = result.quarterly.income.find(row => row.date === a.date);
    if (!h1?.propertyFvNormalization || !h2) throw new TypeError(`${ticker}: missing real half-year comparison`);
    for (const field of incomeFields) h2[field] = difference(a[field], h1[field]);
    h2.eps = null; h2.epsDiluted = null;
    h2.weightedAverageShsOut = null; h2.weightedAverageShsOutDil = null;
    h2.propertyFvNormalization = { sourceIds: [...a.propertyFvNormalization.sourceIds, ...h1.propertyFvNormalization.sourceIds],
      derivation: 'annualMinusReportedH1', netIncomeReason: h1.propertyFvNormalization.netIncomeReason };
    for (const [field, numerator] of [['operatingIncomeRatio', 'operatingIncome'], ['ebitdaratio', 'ebitda'],
      ['netIncomeRatio', 'netIncome']]) h2[field] = finite(h2[numerator]) ? h2[numerator] / h2.revenue : null;
    const ac = result.annual.cashflow.find(row => row.date === a.date);
    const hc = result.quarterly.cashflow.find(row => row.date === h1.date);
    const cf = { date: a.date, symbol: ticker, fiscalYear: a.fiscalYear, reportedCurrency: 'HKD',
      period: 'Q4', periodLength: 6, periodStartDate: `${Number(a.fiscalYear) - 1}-10-01`,
      reportingFrequency: 'semiannual', derivation: 'annualMinusReportedH1',
      sourceDates: [a.date, h1.date], sourceIds: [...ac.sourceIds, ...hc.sourceIds],
      sourceBasis: ac.sourceBasis, propertyFvNormalization: h2.propertyFvNormalization };
    for (const field of Object.keys(ac).filter(field => finite(ac[field]))) cf[field] = difference(ac[field], hc[field]);
    cf.cashAtBeginningOfPeriod = hc.cashAtEndOfPeriod; cf.cashAtEndOfPeriod = ac.cashAtEndOfPeriod;
    result.quarterly.cashflow = result.quarterly.cashflow.filter(row => row.date !== cf.date).concat(cf);
  }
  for (const frequency of ['annual', 'quarterly']) sort(result[frequency].cashflow);
  result.statementFrequencies = { ...result.statementFrequencies, cashflow: 'semiannual' };
  provenance.adjustedFingerprint = digest({ annual: result.annual, quarterly: result.quarterly });
  return result;
}

module.exports = { applyPropertyFv, reviewedSourceHash: digest(reviewed),
  displayFingerprint: statements => digest({ annual: statements.annual, quarterly: statements.quarterly }) };
