(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DividendHistory = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const DAY = 86400000;
  const WINDOWS = [5, 10, 15, 20, 25, 30];
  const DIV_ALIASES = ['commonDividendsPaid', 'commonStockDividendsPaid', 'netDividendsPaid', 'dividendsPaid'];
  const SHARE_ALIASES = ['weightedAverageShsOutDil', 'weightedAverageShsOut'];

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  }

  function field(row, aliases) {
    for (const key of aliases) {
      const value = finite(row?.[key]);
      if (value !== null) return value;
    }
    return null;
  }

  function roundPct(value) {
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  }

  function cagrPct(start, end, years) {
    if (!(start > 0 && end > 0 && years > 0)) return null;
    const growth = Math.pow(end / start, 1 / years) - 1;
    return Number.isFinite(growth) ? roundPct(growth * 100) : null;
  }

  function yearsBetween(startIso, endIso) {
    return (Date.parse(endIso) - Date.parse(startIso)) / (365.25 * DAY);
  }

  /** Prefer adjDividend (split-adjusted), then dividend. */
  function paymentAmount(row) {
    const adj = finite(row?.adjDividend);
    if (adj !== null) return adj;
    return finite(row?.dividend);
  }

  function normalizePayments(rows) {
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const row of rows) {
      if (!row || !validDate(row.date)) continue;
      const amount = paymentAmount(row);
      if (amount === null || amount < 0) continue;
      out.push({
        date: row.date.slice(0, 10),
        dividend: amount,
        declarationDate: validDate(row.declarationDate) ? row.declarationDate.slice(0, 10) : null,
        recordDate: validDate(row.recordDate) ? row.recordDate.slice(0, 10) : null,
        paymentDate: validDate(row.paymentDate) ? row.paymentDate.slice(0, 10) : null,
      });
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  }

  function calendarQuarter(iso) {
    return Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1;
  }

  /**
   * Aggregate payment rows into calendar-year buckets with Q1–Q4, H1/H2, and FY totals.
   * Half-years are Q1+Q2 and Q3+Q4 when those quarters have payments.
   */
  function aggregateCalendar(payments, { years = 30, asOf = null } = {}) {
    const rows = normalizePayments(payments);
    if (!rows.length) return { years: [], payments: [], asOf: asOf || null };
    const end = asOf && validDate(asOf) ? asOf : rows.at(-1).date;
    const startYear = Number(end.slice(0, 4)) - years + 1;
    const byYear = new Map();
    for (let year = startYear; year <= Number(end.slice(0, 4)); year++) {
      byYear.set(year, { year, q1: null, q2: null, q3: null, q4: null, h1: null, h2: null, fy: null, count: 0 });
    }
    for (const row of rows) {
      const year = Number(row.date.slice(0, 4));
      if (year < startYear || row.date > end) continue;
      const bucket = byYear.get(year);
      if (!bucket) continue;
      const q = calendarQuarter(row.date);
      const key = `q${q}`;
      bucket[key] = (bucket[key] || 0) + row.dividend;
      bucket.fy = (bucket.fy || 0) + row.dividend;
      bucket.count += 1;
    }
    for (const bucket of byYear.values()) {
      if (bucket.q1 != null || bucket.q2 != null) {
        bucket.h1 = (bucket.q1 || 0) + (bucket.q2 || 0);
      }
      if (bucket.q3 != null || bucket.q4 != null) {
        bucket.h2 = (bucket.q3 || 0) + (bucket.q4 || 0);
      }
    }
    return {
      asOf: end,
      payments: rows.filter(row => row.date >= `${startYear}-01-01` && row.date <= end),
      years: [...byYear.values()].sort((a, b) => b.year - a.year),
    };
  }

  /** Annual DPS series from FMP dividend payment dates (calendar-year sums). */
  function annualDpsFromPayments(payments) {
    const { years } = aggregateCalendar(payments, { years: 80 });
    return years
      .filter(row => row.fy != null && row.fy > 0)
      .map(row => ({ date: `${row.year}-12-31`, dps: row.fy }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Annual DPS proxy from statement cash dividends ÷ diluted shares (sign-normalized). */
  function annualDpsFromStatements(statements) {
    const cashflow = statements?.annual?.cashflow || statements?.cashflow;
    const income = statements?.annual?.income || statements?.income;
    if (!Array.isArray(cashflow) || !Array.isArray(income)) return [];
    const byDate = new Map(income.filter(row => validDate(row?.date)).map(row => [row.date.slice(0, 10), row]));
    const series = [];
    for (const row of cashflow) {
      if (!validDate(row?.date)) continue;
      const date = row.date.slice(0, 10);
      const dividends = field(row, DIV_ALIASES);
      const shares = field(byDate.get(date), SHARE_ALIASES);
      if (dividends === null || !(shares > 0)) continue;
      const dps = Math.abs(dividends) / shares;
      if (!(dps >= 0) || !Number.isFinite(dps)) continue;
      series.push({ date, dps });
    }
    series.sort((a, b) => a.date.localeCompare(b.date));
    return series;
  }

  function cagrForWindow(series, years, asOf = null) {
    if (!Array.isArray(series) || series.length < 2 || !(years > 0)) return null;
    const end = asOf && validDate(asOf) ? asOf : series.at(-1).date;
    const endRow = [...series].reverse().find(row => row.date <= end && row.dps > 0);
    if (!endRow) return null;
    const target = new Date(`${endRow.date}T00:00:00Z`);
    target.setUTCFullYear(target.getUTCFullYear() - years);
    const startIso = target.toISOString().slice(0, 10);
    // Prefer the observation nearest to (but not after) the target lookback date.
    let startRow = null;
    for (const row of series) {
      if (row.date > endRow.date) break;
      if (row.dps > 0 && row.date <= startIso) startRow = row;
    }
    // Five FY statement rows typically span ~4 calendar years; allow −1.25y slack
    // so a labelled 5y window still publishes from the longest available annual DPS.
    const minSpan = years - 1.25;
    if (!startRow) {
      const first = series.find(row => row.dps > 0 && row.date < endRow.date);
      if (!first) return null;
      const span = yearsBetween(first.date, endRow.date);
      if (span < minSpan) return null;
      return cagrPct(first.dps, endRow.dps, span);
    }
    const span = yearsBetween(startRow.date, endRow.date);
    if (span < minSpan) return null;
    return cagrPct(startRow.dps, endRow.dps, span);
  }

  function growthWindows(series, asOf = null) {
    const out = {};
    for (const years of WINDOWS) {
      out[`div_cagr_${years}y`] = cagrForWindow(series, years, asOf);
    }
    return out;
  }

  function leverageToFcf(stock) {
    const debt = finite(stock?.debt);
    const net = finite(stock?.net_debt) ?? (debt !== null && finite(stock?.cash_and_short_term) != null
      ? debt - stock.cash_and_short_term : null);
    const fcf = finite(stock?.fcf0);
    const ratio = (num) => (num !== null && fcf !== null && fcf > 0)
      ? Math.round((num / fcf) * 100) / 100 : null;
    return {
      debt_to_fcf: ratio(debt),
      net_debt_to_fcf: ratio(net),
    };
  }

  function metricsFromStatements(statements, stock = null, asOf = null) {
    const series = annualDpsFromStatements(statements);
    return {
      ...growthWindows(series, asOf),
      ...leverageToFcf(stock || {}),
      dividendSeriesSource: series.length ? 'statements' : null,
      dividendSeriesPoints: series.length,
    };
  }

  function metricsFromPayments(payments, stock = null, asOf = null) {
    const series = annualDpsFromPayments(payments);
    return {
      ...growthWindows(series, asOf),
      ...leverageToFcf(stock || {}),
      dividendSeriesSource: series.length ? 'dividends' : null,
      dividendSeriesPoints: series.length,
    };
  }

  function validateCache(record, ticker) {
    if (record?.version !== 1 || record.ticker !== ticker || !Array.isArray(record.rows)) {
      throw new TypeError('Unsupported dividend history record');
    }
    return { ...record, rows: normalizePayments(record.rows) };
  }

  const pending = new Map();

  function load(ticker, reload = false) {
    if (!reload && pending.has(ticker)) return pending.get(ticker);
    const Cache = typeof module === 'object' && module.exports
      ? null
      : (typeof FmpCache !== 'undefined' ? FmpCache : null);
    const cached = Cache?.get?.(`dividends:${ticker}`);
    if (!reload && cached) return Promise.resolve(cached);

    const local = fetch(`cache/dividends/${encodeURIComponent(ticker)}.json`)
      .then(async (response) => {
        if (!response.ok) throw new Error('MISSING_DIVIDEND_CACHE');
        return validateCache(await response.json(), ticker);
      });

    const remote = () => fetch(`/api/fmp?action=dividends&symbol=${encodeURIComponent(ticker)}&limit=400`)
      .then(async (response) => {
        if (!response.ok) throw new Error('DIVIDEND_API_FAILED');
        const payload = await response.json();
        const rows = Array.isArray(payload) ? payload : payload?.data || payload?.rows || [];
        if (!Array.isArray(rows)) throw new Error('DIVIDEND_API_INVALID');
        return validateCache({ version: 1, ticker, source: 'FMP dividends', rows }, ticker);
      });

    const task = local.catch(() => remote()).then((record) => {
      Cache?.set?.(`dividends:${ticker}`, record);
      return record;
    }).finally(() => { if (pending.get(ticker) === task) pending.delete(ticker); });
    pending.set(ticker, task);
    return task;
  }

  return {
    WINDOWS,
    normalizePayments,
    aggregateCalendar,
    annualDpsFromPayments,
    annualDpsFromStatements,
    cagrForWindow,
    growthWindows,
    leverageToFcf,
    metricsFromStatements,
    metricsFromPayments,
    validateCache,
    load,
  };
});
