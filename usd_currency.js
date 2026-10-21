(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UsdCurrency = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const day = 86400000;
  const metadata = new Set(['date', 'symbol', 'cik', 'fiscalYear', 'calendarYear', 'period', 'filingDate',
    'acceptedDate', 'fillingDate', 'link', 'finalLink', 'reportedCurrency', 'weightedAverageShsOut',
    'weightedAverageShsOutDil', 'numberOfShares', 'periodLength', 'sourceReportedCurrency', 'currencyConversion',
    'periodStartDate', 'reportingFrequency', 'derivation', 'sourceDates', 'sourceReleaseDate',
    'comparabilityGroup', 'operatingIncomeBasis', 'earningsIncludeDiscontinued', 'reportType']);
  const numeric = value => (typeof value === 'number' || typeof value === 'string' && value.trim())
    && Number.isFinite(Number(value)) ? Number(value) : null;
  const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const code = value => ({ NTD: 'TWD', RMB: 'CNY' }[value] || value);
  const periodKey = (row, annual) => {
    const year = Number(row.fiscalYear || row.calendarYear);
    return annual ? year : year * 4 + Number(String(row.period)[1]) - 1;
  };

  function rateFor(rates, currency, start, end, basis, target = 'USD') {
    currency = code(currency);
    target = code(target);
    if (currency === target) return { rate: 1, basis, start, end, observationDate: end, reason: null };
    const unavailable = reason => ({ rate: null, basis, start, end, observationDate: null, reason });
    if (!iso(end) || basis === 'average' && !iso(start)) return unavailable('missingFxPeriod');
    let series = rates?.currencies?.[currency];
    if (target !== 'USD') {
      const targetSeries = rates?.currencies?.[target];
      if (!targetSeries || !Array.isArray(targetSeries.observations)) return unavailable('missingFxCurrency');
      const sourceObservations = currency === 'USD' ? targetSeries.observations.map(([date]) => [date, 1])
        : series?.observations;
      if (!Array.isArray(sourceObservations)) return unavailable('missingFxCurrency');
      const denominators = new Map(targetSeries.observations);
      series = { series: `${currency === 'USD' ? 'USD' : series.series}/${targetSeries.series}`,
        observations: sourceObservations.filter(([date, value]) =>
          numeric(value) > 0 && numeric(denominators.get(date)) > 0)
          .map(([date, value]) => [date, Number(value) / Number(denominators.get(date))]) };
    }
    if (!series || !Array.isArray(series.observations)) return unavailable('missingFxCurrency');
    const observations = series.observations;
    const last = observations.at(-1)?.[0];
    const businessEnd = new Date(end);
    while ([0, 6].includes(businessEnd.getUTCDay())) businessEnd.setUTCDate(businessEnd.getUTCDate() - 1);
    if (!last || businessEnd.toISOString().slice(0, 10) > last) return unavailable('missingFxDate');
    const selected = observations.filter(([date, value]) => iso(date) && numeric(value) > 0
      && date <= end && (basis !== 'average' || date >= start));
    const closing = selected.at(-1);
    if (!closing || (Date.parse(end) - Date.parse(closing[0])) / day > 7) return unavailable('missingFxDate');
    if (basis === 'average' && ((Date.parse(selected[0][0]) - Date.parse(start)) / day > 7
        || selected.some((row, i) => i && (Date.parse(row[0]) - Date.parse(selected[i - 1][0])) / day > 7))) {
      return unavailable('incompleteFxPeriod');
    }
    const rate = basis === 'average' ? selected.reduce((sum, row) => sum + row[1], 0) / selected.length : closing[1];
    return { rate, basis, start, end, observationDate: closing[0], reason: null, source: series.series };
  }

  function convertStatements(data, rates, target = data?.calculationCurrency || 'USD') {
    if (!data || !data.quarterly || !data.annual) throw new TypeError('Missing financial statement periods');
    target = code(target);
    if (!['USD', 'HKD'].includes(target)) throw new TypeError('Unsupported calculation currency');
    const result = { ...data, calculationCurrency: target };
    for (const period of ['annual', 'quarterly']) {
      const annual = period === 'annual';
      const rows = Object.values(data[period]).filter(Array.isArray).flat();
      const endings = new Map();
      for (const row of rows) {
        if (!iso(row.date)) continue;
        const key = periodKey(row, annual);
        if (!endings.has(key)) endings.set(key, row.date);
        else if (endings.get(key) !== row.date) endings.set(key, null);
      }
      result[period] = { ...data[period] };
      for (const type of ['income', 'balance', 'cashflow']) {
        if (!Array.isArray(data[period][type])) throw new TypeError(`Missing ${period} ${type} statements`);
        result[period][type] = data[period][type].map(row => {
          if (row.currencyConversion?.target === target) return { ...row };
          if (row.currencyConversion?.target) throw new TypeError('Cannot reconvert previously translated statements');
          let start = row.periodStartDate;
          const unknownDuration = row.periodLength === null;
          const step = !annual && data.reportingFrequency === 'semiannual' ? 2 : 1;
          const previous = endings.get(periodKey(row, annual) - step);
          if (!unknownDuration && !iso(start) && previous) start = new Date(Date.parse(previous) + day).toISOString().slice(0, 10);
          // Standard calendar periods have unambiguous starts even when the previous report is absent.
          if (!unknownDuration && !iso(start) && iso(row.date)) {
            const date = new Date(row.date);
            const month = date.getUTCMonth();
            const calendarEnd = new Date(Date.UTC(date.getUTCFullYear(), month + 1, 0)).getUTCDate() === date.getUTCDate();
            if (annual && month === 11 && calendarEnd) start = `${date.getUTCFullYear()}-01-01`;
            else if (!annual && step === 1 && calendarEnd && month % 3 === 2 && row.period === `Q${(month + 1) / 3}`) {
              start = `${date.getUTCFullYear()}-${String(month - 1).padStart(2, '0')}-01`;
            }
          }
          const source = row.reportedCurrency;
          const fx = rateFor(rates, source, start, row.date, type === 'balance' ? 'closing' : 'average', target);
          const converted = { ...row, sourceReportedCurrency: source, reportedCurrency: target,
            currencyConversion: { ...fx, sourceCurrency: source, target } };
          for (const [field, value] of Object.entries(row)) {
            if (metadata.has(field) || /ratio$/i.test(field) || numeric(value) === null) continue;
            let fieldFx = fx;
            if (type === 'cashflow' && ['cashAtEndOfPeriod', 'cashAtBeginningOfPeriod'].includes(field)) {
              const end = field === 'cashAtEndOfPeriod' ? row.date
                : iso(start) ? new Date(Date.parse(start) - day).toISOString().slice(0, 10) : null;
              fieldFx = rateFor(rates, source, null, end, 'closing', target);
            }
            converted[field] = fieldFx.rate === null ? null : numeric(value) * fieldFx.rate;
          }
          return converted;
        });
      }
    }
    return result;
  }
  const pending = {};
  function loadRates(reload = false, target = 'USD', capturedSource = null) {
    if (!['USD', 'HKD'].includes(target)) throw new TypeError('Unsupported calculation currency');
    if (capturedSource && (target !== 'HKD' || !/^[a-f0-9]{64}$/.test(capturedSource.sha256)
        || capturedSource.path !== `cache/fx/hk_expansion_${capturedSource.sha256}.json`)) {
      throw new TypeError('Invalid captured HKD FX source');
    }
    const key = capturedSource?.path || target;
    if (reload) delete pending[key];
    if (!pending[key]) {
      const file = target === 'HKD' ? 'hkd_rates.json' : 'usd_rates.json';
      pending[key] = fetch(capturedSource?.path || `cache/fx/${file}`).then(response => {
        if (!response.ok) throw new Error(`Historical FX HTTP ${response.status}`);
        return response.json();
      }).catch(error => { delete pending[key]; throw error; });
    }
    return pending[key];
  }
  async function normalize(data, reload = false) {
    const target = data.calculationCurrency || 'USD';
    const foreign = ['annual', 'quarterly'].some(period => Object.values(data[period] || {})
      .filter(Array.isArray).flat().some(row => code(row.reportedCurrency) !== target));
    return convertStatements(data, foreign ? await loadRates(reload, target, data.hkdFxSource) : null);
  }
  return { rateFor, convertStatements, loadRates, normalize };
});
