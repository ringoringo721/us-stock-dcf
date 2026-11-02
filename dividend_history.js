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
  const NI_ALIASES = ['netIncome', 'netIncomeApplicableToCommonShares'];
  const EPS_ALIASES = ['epsdiluted', 'epsDiluted', 'eps'];

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

  /** Annual payout ratio = cash dividends ÷ net income (NI>0); else DPS÷EPS when both >0. */
  function payoutRatioFromStatementRow(cashflowRow, incomeRow) {
    const dividends = field(cashflowRow, DIV_ALIASES);
    const netIncome = field(incomeRow, NI_ALIASES);
    if (dividends !== null && netIncome !== null && netIncome > 0) {
      return roundPct((Math.abs(dividends) / netIncome) * 100);
    }
    const shares = field(incomeRow, SHARE_ALIASES);
    const eps = field(incomeRow, EPS_ALIASES);
    if (dividends !== null && shares > 0 && eps > 0) {
      const dps = Math.abs(dividends) / shares;
      return roundPct((dps / eps) * 100);
    }
    return null;
  }

  /** Map fiscal-year statement rows → {year → payoutRatioPct}. */
  function payoutRatiosFromStatements(statements) {
    const cashflow = statements?.annual?.cashflow || statements?.cashflow;
    const income = statements?.annual?.income || statements?.income;
    if (!Array.isArray(cashflow) || !Array.isArray(income)) return new Map();
    const byDate = new Map(income.filter(row => validDate(row?.date)).map(row => [row.date.slice(0, 10), row]));
    const out = new Map();
    for (const row of cashflow) {
      if (!validDate(row?.date)) continue;
      const ratio = payoutRatioFromStatementRow(row, byDate.get(row.date.slice(0, 10)));
      if (ratio === null) continue;
      out.set(Number(row.date.slice(0, 4)), ratio);
    }
    return out;
  }

  /**
   * Aggregate payment rows into calendar-year buckets with Q1–Q4, H1/H2, and FY totals.
   * Optional statement-derived payoutRatioPct attaches to each year (full-year basis).
   */
  function aggregateCalendar(payments, { years = 30, asOf = null, payoutByYear = null } = {}) {
    const rows = normalizePayments(payments);
    const span = Math.max(1, Math.min(30, Number(years) || 30));
    if (!rows.length) {
      return { years: [], payments: [], asOf: asOf || null, span };
    }
    const end = asOf && validDate(asOf) ? asOf : rows.at(-1).date;
    const startYear = Number(end.slice(0, 4)) - span + 1;
    const byYear = new Map();
    for (let year = startYear; year <= Number(end.slice(0, 4)); year++) {
      byYear.set(year, {
        year, q1: null, q2: null, q3: null, q4: null, h1: null, h2: null, fy: null,
        count: 0, payoutRatioPct: payoutByYear?.get?.(year) ?? null,
      });
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
      if (bucket.payoutRatioPct == null && payoutByYear?.has?.(bucket.year)) {
        bucket.payoutRatioPct = payoutByYear.get(bucket.year);
      }
    }
    return {
      asOf: end,
      span,
      payments: rows.filter(row => row.date >= `${startYear}-01-01` && row.date <= end),
      years: [...byYear.values()].sort((a, b) => b.year - a.year),
    };
  }

  /**
   * Shape calendar buckets for UI grain: quarter | half | year.
   * Always keeps payout amount columns for the selected grain plus payout ratio.
   */
  function tableForGrain(aggregated, grain = 'quarter') {
    const mode = grain === 'half' || grain === 'year' || grain === 'fy' ? grain === 'fy' ? 'year' : grain : 'quarter';
    const columns = mode === 'quarter'
      ? ['q1', 'q2', 'q3', 'q4', 'fy']
      : mode === 'half'
        ? ['h1', 'h2', 'fy']
        : ['fy'];
    return {
      grain: mode,
      columns,
      rows: (aggregated?.years || []).map(row => ({
        year: row.year,
        amount: Object.fromEntries(columns.map(key => [key, row[key]])),
        fy: row.fy,
        count: row.count,
        payoutRatioPct: row.payoutRatioPct,
      })),
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

  /** Synthetic one-per-year payment rows from statement DPS (fallback when FMP dividends fail). */
  function paymentsFromStatements(statements) {
    return annualDpsFromStatements(statements).map(row => ({
      date: row.date,
      dividend: row.dps,
      adjDividend: row.dps,
    }));
  }

  function fiscalLabelToIso(label) {
    if (typeof label !== 'string' || label === 'TTM') return null;
    if (validDate(label.slice(0, 10))) return label.slice(0, 10);
    if (!/^\d{4}-\d{2}$/.test(label.slice(0, 7))) return null;
    const year = Number(label.slice(0, 4));
    const month = Number(label.slice(5, 7));
    if (!(year >= 1970 && month >= 1 && month <= 12)) return null;
    const day = [4, 6, 9, 11].includes(month) ? '30' : month === 2 ? '28' : '31';
    const iso = `${label.slice(0, 7)}-${day}`;
    return validDate(iso) ? iso : `${year}-12-31`;
  }

  /**
   * Build annual payment + payout rows from columnar statements_raw (in-memory market data).
   * NI/dividends are often millions while shares stay absolute; payout ratio is scale-invariant.
   */
  function paymentsFromStatementRaw(statementsRaw) {
    const dates = statementsRaw?.annual_dates;
    const divSeries = statementsRaw?.cashflow?.dividendsPaid
      || statementsRaw?.cashflow?.commonDividendsPaid;
    const niSeries = statementsRaw?.income?.netIncome;
    const shareSeries = statementsRaw?.income?.weightedAverageShsOutDil
      || statementsRaw?.income?.weightedAverageShsOut;
    if (!Array.isArray(dates) || !Array.isArray(divSeries)) {
      return { payments: [], payoutByYear: new Map() };
    }
    const n = Math.min(dates.length, divSeries.length,
      Array.isArray(niSeries) ? niSeries.length : divSeries.length);
    const payments = [];
    const payoutByYear = new Map();
    for (let i = 0; i < n; i++) {
      const date = fiscalLabelToIso(dates[i]);
      if (!date) continue;
      const year = Number(date.slice(0, 4));
      const div = finite(divSeries[i]);
      if (div === null) continue;
      const shares = Array.isArray(shareSeries) ? finite(shareSeries[i]) : null;
      const ni = Array.isArray(niSeries) ? finite(niSeries[i]) : null;
      const absDiv = Math.abs(div);
      let dps = null;
      if (shares > 0 && absDiv > 0) {
        dps = absDiv < 1e6 && shares > 1e6 ? (absDiv * 1e6) / shares : absDiv / shares;
      }
      if (dps !== null && dps > 0) payments.push({ date, dividend: dps, adjDividend: dps });
      if (ni !== null && ni > 0) payoutByYear.set(year, roundPct((absDiv / Math.abs(ni)) * 100));
    }
    return { payments: normalizePayments(payments), payoutByYear };
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

  function load(ticker, options = {}) {
    const reload = options === true || options.reload === true;
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
        if (!response.ok) throw new Error(`DIVIDEND_API_FAILED:${response.status}`);
        const payload = await response.json();
        const rows = Array.isArray(payload) ? payload
          : payload?.data || payload?.rows || payload?.historical || [];
        if (!Array.isArray(rows)) throw new Error('DIVIDEND_API_INVALID');
        return validateCache({ version: 1, ticker, source: 'FMP dividends', rows }, ticker);
      });

    const statementsFallback = () => fetch(`cache/financials/${encodeURIComponent(ticker)}_statements_v2.json`)
      .then(async (response) => {
        if (!response.ok) throw new Error('MISSING_STATEMENT_FALLBACK');
        const statements = await response.json();
        const rows = paymentsFromStatements(statements);
        if (!rows.length) throw new Error('EMPTY_STATEMENT_DIVIDENDS');
        return {
          version: 1,
          ticker,
          source: 'statements_v2 DPS fallback (FMP dividends unavailable)',
          rows: normalizePayments(rows),
          payoutByYear: payoutRatiosFromStatements(statements),
          fallback: true,
        };
      });

    const task = local.catch(() => remote()).catch(() => statementsFallback()).then((record) => {
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
    tableForGrain,
    annualDpsFromPayments,
    annualDpsFromStatements,
    paymentsFromStatements,
    paymentsFromStatementRaw,
    payoutRatiosFromStatements,
    payoutRatioFromStatementRow,
    cagrForWindow,
    growthWindows,
    leverageToFcf,
    metricsFromStatements,
    metricsFromPayments,
    validateCache,
    load,
  };
});
