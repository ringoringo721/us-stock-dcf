const Scenario = require('../fmp_scenario.js');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const close = (a, b) => day(a) && day(b) && Math.abs(Date.parse(a) - Date.parse(b)) <= 10 * 86400000;

function buildAnalystSources(data, statements, response, capturedAt) {
  const asOf = typeof capturedAt === 'string' ? capturedAt.slice(0, 10) : null;
  const annual = (statements?.annual?.income || []).filter(row => day(row.date)
    && day(asOf) && row.date <= asOf
    && Scenario.fullAnnualPeriod(row)
    && ['filingDate', 'acceptedDate'].every(key => !row[key]
      || typeof row[key] === 'string' && day(row[key].slice(0, 10)) && row[key].slice(0, 10) <= asOf))
    .sort((a, b) => b.date.localeCompare(a.date));
  const latest = annual[0];
  // When capture left forecastBase unverified (FX), recover the fiscal year from currencyCheck
  // so actual-ratio / consensus wiring is not blanked solely by that soft failure.
  const recoveredBase = Scenario.resolveForecastBase(data);
  const baseYear = Number.isInteger(data.forecastBase?.year) ? data.forecastBase.year
    : Number.isInteger(recoveredBase?.year) ? recoveredBase.year : null;
  const baseDate = data.forecastBase?.date || recoveredBase?.date || null;
  const references = latest && Number.isInteger(baseYear)
    && Number(latest.fiscalYear || latest.calendarYear) >= baseYear
    ? Array.from({ length: 5 }, (_, index) => {
    const matches = annual.filter(row => Number(row.fiscalYear || row.calendarYear)
      === Number(latest.fiscalYear || latest.calendarYear) - index);
    if (matches.length !== 1 || matches[0].reportedCurrency !== latest.reportedCurrency) return null;
    return Scenario.actualReference({ ...data, currency: latest.reportedCurrency }, statements,
      { year: Number(matches[0].fiscalYear || matches[0].calendarYear), date: matches[0].date });
  }) : [];
  const reference = references[0];
  const complete = references.length === 5 && references.every((row, index) => row && !row.reason
    && finite(row.items.nwcChange?.percent) && (!index
      || (Date.parse(references[index - 1].date) - Date.parse(row.date)) / 86400000 >= 330
      && (Date.parse(references[index - 1].date) - Date.parse(row.date)) / 86400000 <= 400));
  const workingCapital = {
    nwcChange: complete ? references.reduce((sum, row) => sum + row.items.nwcChange.percent, 0) / 5 : null
  };
  const forecastActuals = { symbol: data.symbol, capturedAt,
    latest: reference ? { ...reference, basis: 'Latest complete FY actual source for approved CFO/CapEx/DA carry-forward ratios, not a forecast.' } : null,
    workingCapital, workingCapitalYears: references.map(row => row?.year ?? null),
    workingCapitalBasis: 'Arithmetic mean of five consecutive annual change-in-NWC/revenue ratios. Change in NWC = negative FMP cash-flow changeInWorkingCapital (includes other operating working capital); positive increases consume cash. Not a difference of only receivables, inventories and payables.' };
  const source = { provider: 'FMP', endpoint: 'analyst-estimates', period: 'annual',
    symbol: data.symbol, capturedAt, currency: latest?.reportedCurrency || null,
    calculationCurrency: data.currency, rows: [], reason: null,
    basis: 'Current provider consensus, not point-in-time history. Adjusted/GAAP definitions and per-metric analyst counts are not independently certified.' };
  const unavailable = reason => ({ analystEstimates: { ...source, reason }, forecastActuals });
  if (!latest || !reference || reference.reason || !day(asOf)) return unavailable('ANALYST_ACTUAL_BASE_UNAVAILABLE');
  const rows = response?.data || response?.rows;
  if (response?.reason || response?.ok === false || !Array.isArray(rows)) {
    return unavailable(response?.reason || `ANALYST_HTTP_${response?.httpStatus || 'UNAVAILABLE'}`);
  }
  if (!rows.length) return unavailable('ANALYST_NO_COVERAGE');
  const providerSymbol = data.symbol.endsWith('.HK') ? data.symbol : data.symbol.replaceAll('.', '-');
  if (rows.some(row => !row || ![data.symbol, providerSymbol].includes(row.symbol))) {
    return unavailable('ANALYST_SECURITY_MISMATCH');
  }
  if (rows.some(row => !day(row.date))) return unavailable('ANALYST_INVALID_FISCAL_DATE');
  if (new Set(rows.map(row => row.date)).size !== rows.length) return unavailable('ANALYST_AMBIGUOUS_PERIOD');
  const matched = rows.filter(row => close(row.date, latest.date));
  const scale = matched.length === 1 && finite(matched[0].revenueAvg)
    ? matched[0].revenueAvg / latest.revenue : null;
  if (!finite(scale) || scale < 0.75 || scale > 1.25) return unavailable('ANALYST_CURRENCY_SCALE_UNVERIFIED');
  const evidence = data.currencyCheck;
  const rate = latest.reportedCurrency === data.currency ? 1 : evidence?.fx?.price;
  if (!finite(rate) || rate <= 0) return unavailable('ANALYST_FX_UNVERIFIED');
  if (latest.reportedCurrency !== data.currency
      && evidence?.sourceCurrency && latest.reportedCurrency !== evidence.sourceCurrency) {
    return unavailable('ANALYST_FX_UNVERIFIED');
  }
  // Soft-warn: unverified FX still keeps consensus rows when a spot rate is available.
  const fxSoft = latest.reportedCurrency !== data.currency && !!evidence?.reason;
  source.currencyCheck = { basis: 'Reporting currency inferred from matching historical consensus/reporting scale',
    date: latest.date, ratio: scale };
  source.fx = { rate, basis: rate === 1 ? 'Same reporting and calculation currency'
    : (fxSoft
      ? 'Unverified FMP model snapshot spot conversion (review FX); not historical forecast FX'
      : 'Verified FMP model snapshot spot conversion, not historical forecast FX'),
    capturedAt: data.capturedAt, ...(fxSoft ? { soft: true } : {}) };
  if (fxSoft) source.reason = 'ANALYST_FX_UNVERIFIED';
  const fields = ['revenueAvg', 'ebitdaAvg', 'ebitAvg', 'netIncomeAvg', 'epsAvg',
    'operatingCashFlowAvg', 'capitalExpenditureAvg', 'depreciationAndAmortizationAvg',
    'numAnalystsRevenue', 'numAnalystsEps'];
  const cutoff = baseDate || data.forecastBase?.date;
  source.rows = rows.filter(row => !cutoff || row.date > cutoff).map(row => ({
    date: row.date, ...Object.fromEntries(fields.map(key => [key, finite(row[key]) ? row[key] : null]))
  })).sort((a, b) => a.date.localeCompare(b.date));
  if (!source.rows.length && !source.reason) source.reason = 'ANALYST_NO_FUTURE_COVERAGE';
  return { analystEstimates: source, forecastActuals };
}

module.exports = { buildAnalystSources };
