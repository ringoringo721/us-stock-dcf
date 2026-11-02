(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RevenueSegments = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const META_KEYS = new Set(['date', 'symbol', 'cik', 'reportedCurrency', 'data', 'period',
    'fiscalYear', 'fillingDate', 'acceptedDate', 'calendarYear', 'filingDate', 'segments']);

  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
      && Number.isFinite(Date.parse(value.slice(0, 10)))
      && new Date(value.slice(0, 10)).toISOString().slice(0, 10) === value.slice(0, 10);
  }

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function numericMap(object) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
    const segments = {};
    for (const [key, value] of Object.entries(object)) {
      if (META_KEYS.has(key)) continue;
      const amount = finite(value);
      if (amount === null) continue;
      segments[key] = amount;
    }
    return Object.keys(segments).length ? segments : null;
  }

  /**
   * FMP may return flat `{date, iPhone:…}`, `{date, data:{…}}`, or nested
   * `{date, AAPL:{iPhone:…}}` (symbol-keyed). Prefer `data`, then numeric maps,
   * then the first nested object that looks like a segment map.
   */
  function extractSegmentMap(row, ticker) {
    if (!row || typeof row !== 'object') return null;
    if (row.data && typeof row.data === 'object' && !Array.isArray(row.data)) {
      const fromData = numericMap(row.data);
      if (fromData) return fromData;
    }
    if (row.segments && typeof row.segments === 'object' && !Array.isArray(row.segments)) {
      const fromSegments = numericMap(row.segments);
      if (fromSegments) return fromSegments;
    }
    const direct = numericMap(row);
    if (direct) return direct;
    if (ticker && row[ticker] && typeof row[ticker] === 'object') {
      const byTicker = numericMap(row[ticker]);
      if (byTicker) return byTicker;
    }
    for (const [key, value] of Object.entries(row)) {
      if (META_KEYS.has(key) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const nested = numericMap(value);
      if (nested) return nested;
    }
    return null;
  }

  /** Normalize FMP product/geographic segmentation rows into {date, segments:{name:amount}}. */
  function normalizeRows(rows, ticker = null) {
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const row of rows) {
      if (!row || !validDate(row.date)) continue;
      const date = row.date.slice(0, 10);
      const segments = extractSegmentMap(row, ticker);
      if (!segments) continue;
      out.push({ date, segments });
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  }

  function validateCache(record, ticker) {
    if (record?.version !== 1 || record.ticker !== ticker
        || !record.product && !record.geographic) {
      throw new TypeError('Unsupported revenue segment record');
    }
    return {
      version: 1,
      ticker,
      source: record.source || 'FMP revenue segmentation',
      period: record.period || null,
      product: normalizeRows(record.product || [], ticker),
      geographic: normalizeRows(record.geographic || [], ticker),
    };
  }

  /** Accept raw FMP rows or already-normalized `{ date, segments }` from validateCache/load. */
  function asNormalizedRows(segmentRows, ticker = null) {
    if (!Array.isArray(segmentRows) || !segmentRows.length) return [];
    if (segmentRows.every(row => row && validDate(row.date)
        && row.segments && typeof row.segments === 'object' && !Array.isArray(row.segments))) {
      return segmentRows
        .map(row => ({ date: row.date.slice(0, 10), segments: row.segments }))
        .sort((a, b) => a.date.localeCompare(b.date));
    }
    return normalizeRows(segmentRows, ticker);
  }

  /**
   * Align segment series to the financials period labels/dates (annual or interim).
   * Matching is by calendar date prefix (YYYY-MM) then nearest prior segment date.
   */
  function alignToPeriods(segmentRows, periodDates, ticker = null) {
    const rows = asNormalizedRows(segmentRows, ticker);
    if (!Array.isArray(periodDates) || !periodDates.length) {
      return { names: [], columns: [] };
    }
    const nameSet = new Set();
    const columns = periodDates.map((label, index) => {
      const raw = typeof label === 'string' ? label : '';
      const iso = /^\d{4}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
      let match = null;
      if (iso) {
        const prefix = iso.slice(0, 7);
        match = [...rows].reverse().find(row => row.date.slice(0, 7) === prefix)
          || [...rows].reverse().find(row => row.date <= (iso.length === 7 ? `${iso}-28` : iso));
      }
      if (match) Object.keys(match.segments).forEach(name => nameSet.add(name));
      return { label: raw || `P${index + 1}`, date: match?.date || null, segments: match?.segments || null };
    });
    const names = [...nameSet].sort((a, b) => a.localeCompare(b));
    return { names, columns };
  }

  function fmpPeriod(statementPeriod) {
    return statementPeriod === 'quarterly' || statementPeriod === 'quarter' ? 'quarter' : 'annual';
  }

  const pending = new Map();

  function load(ticker, options = {}) {
    const reload = options === true || options.reload === true;
    const period = fmpPeriod(typeof options === 'object' && options ? options.period : null);
    const cacheKey = `revenue-segments:${ticker}:${period}`;
    if (!reload && pending.has(cacheKey)) return pending.get(cacheKey);
    const Cache = typeof FmpCache !== 'undefined' ? FmpCache : null;
    const cached = Cache?.get?.(cacheKey);
    if (!reload && cached) return Promise.resolve(cached);

    const local = fetch(`cache/revenue_segments/${encodeURIComponent(ticker)}.json`)
      .then(async (response) => {
        if (!response.ok) throw new Error('MISSING_SEGMENT_CACHE');
        const record = validateCache(await response.json(), ticker);
        // Local files are annual captures (period often unset). Never reuse for quarter.
        const cachePeriod = record.period || 'annual';
        if (period !== 'annual' && cachePeriod !== period) {
          throw new Error('SEGMENT_CACHE_PERIOD_MISMATCH');
        }
        return { ...record, period: cachePeriod };
      });

    async function fetchPeriod(requestedPeriod) {
      const qs = `symbol=${encodeURIComponent(ticker)}&period=${requestedPeriod}&structure=flat`;
      const [productRes, geoRes] = await Promise.all([
        fetch(`/api/fmp?action=revenue-product-segmentation&${qs}`),
        fetch(`/api/fmp?action=revenue-geographic-segmentation&${qs}`),
      ]);
      if (!productRes.ok && !geoRes.ok) {
        const status = productRes.status || geoRes.status;
        throw new Error(`SEGMENT_API_FAILED:${status}`);
      }
      const productJson = productRes.ok ? await productRes.json() : { data: [] };
      const geoJson = geoRes.ok ? await geoRes.json() : { data: [] };
      const product = Array.isArray(productJson) ? productJson : productJson?.data || productJson?.rows || [];
      const geographic = Array.isArray(geoJson) ? geoJson : geoJson?.data || geoJson?.rows || [];
      return validateCache({
        version: 1,
        ticker,
        source: `FMP revenue segmentation (${requestedPeriod})`,
        period: requestedPeriod,
        product,
        geographic,
      }, ticker);
    }

    const remote = async () => {
      const record = await fetchPeriod(period);
      // Many names only publish annual product/geo mixes; fall back when quarter is empty.
      if (period === 'quarter' && !record.product.length && !record.geographic.length) {
        const annual = await fetchPeriod('annual');
        return {
          ...annual,
          source: `${annual.source}; quarter empty → annual`,
        };
      }
      return record;
    };

    const task = local.catch(() => remote()).then((record) => {
      Cache?.set?.(cacheKey, record);
      return record;
    }).finally(() => { if (pending.get(cacheKey) === task) pending.delete(cacheKey); });
    pending.set(cacheKey, task);
    return task;
  }

  return { normalizeRows, extractSegmentMap, validateCache, alignToPeriods, fmpPeriod, load };
});
