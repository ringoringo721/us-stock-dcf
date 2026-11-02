(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RevenueSegments = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
      && Number.isFinite(Date.parse(value.slice(0, 10)))
      && new Date(value.slice(0, 10)).toISOString().slice(0, 10) === value.slice(0, 10);
  }

  function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  /** Normalize FMP product/geographic segmentation rows into {date, segments:{name:amount}}. */
  function normalizeRows(rows) {
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const row of rows) {
      if (!row || !validDate(row.date)) continue;
      const date = row.date.slice(0, 10);
      const data = row.data && typeof row.data === 'object' && !Array.isArray(row.data)
        ? row.data
        : row;
      const segments = {};
      for (const [key, value] of Object.entries(data)) {
        if (['date', 'symbol', 'cik', 'reportedCurrency', 'data', 'period', 'fiscalYear',
          'fillingDate', 'acceptedDate', 'calendarYear'].includes(key)) continue;
        const amount = finite(value);
        if (amount === null) continue;
        segments[key] = amount;
      }
      if (!Object.keys(segments).length) continue;
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
      product: normalizeRows(record.product || []),
      geographic: normalizeRows(record.geographic || []),
    };
  }

  /** Accept raw FMP rows or already-normalized `{ date, segments }` from validateCache/load. */
  function asNormalizedRows(segmentRows) {
    if (!Array.isArray(segmentRows) || !segmentRows.length) return [];
    if (segmentRows.every(row => row && validDate(row.date)
        && row.segments && typeof row.segments === 'object' && !Array.isArray(row.segments))) {
      return segmentRows
        .map(row => ({ date: row.date.slice(0, 10), segments: row.segments }))
        .sort((a, b) => a.date.localeCompare(b.date));
    }
    return normalizeRows(segmentRows);
  }

  /**
   * Align segment series to the financials period labels/dates (annual or interim).
   * Matching is by calendar date prefix (YYYY-MM) then nearest prior segment date.
   */
  function alignToPeriods(segmentRows, periodDates) {
    const rows = asNormalizedRows(segmentRows);
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

  const pending = new Map();

  function load(ticker, reload = false) {
    if (!reload && pending.has(ticker)) return pending.get(ticker);
    const Cache = typeof FmpCache !== 'undefined' ? FmpCache : null;
    const cached = Cache?.get?.(`revenue-segments:${ticker}`);
    if (!reload && cached) return Promise.resolve(cached);

    const local = fetch(`cache/revenue_segments/${encodeURIComponent(ticker)}.json`)
      .then(async (response) => {
        if (!response.ok) throw new Error('MISSING_SEGMENT_CACHE');
        return validateCache(await response.json(), ticker);
      });

    const remote = async () => {
      const [productRes, geoRes] = await Promise.all([
        fetch(`/api/fmp?action=revenue-product-segmentation&symbol=${encodeURIComponent(ticker)}`),
        fetch(`/api/fmp?action=revenue-geographic-segmentation&symbol=${encodeURIComponent(ticker)}`),
      ]);
      if (!productRes.ok && !geoRes.ok) throw new Error('SEGMENT_API_FAILED');
      const productJson = productRes.ok ? await productRes.json() : { data: [] };
      const geoJson = geoRes.ok ? await geoRes.json() : { data: [] };
      const product = Array.isArray(productJson) ? productJson : productJson?.data || productJson?.rows || [];
      const geographic = Array.isArray(geoJson) ? geoJson : geoJson?.data || geoJson?.rows || [];
      return validateCache({
        version: 1,
        ticker,
        source: 'FMP revenue segmentation',
        product,
        geographic,
      }, ticker);
    };

    const task = local.catch(() => remote()).then((record) => {
      Cache?.set?.(`revenue-segments:${ticker}`, record);
      return record;
    }).finally(() => { if (pending.get(ticker) === task) pending.delete(ticker); });
    pending.set(ticker, task);
    return task;
  }

  return { normalizeRows, validateCache, alignToPeriods, load };
});
