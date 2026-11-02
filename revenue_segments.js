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

  function rowTotal(row) {
    if (!row?.segments) return 0;
    return Object.values(row.segments).reduce((sum, value) => (
      typeof value === 'number' && Number.isFinite(value) ? sum + value : sum), 0);
  }

  /**
   * FMP period=quarter feeds sometimes mix YTD-cumulative or full-FY snapshots into
   * year-end rows (Bugbot: ABBV/AMGN/AMD). Detect within each calendar year:
   *  - last ≈ sum(prior) AND same segment keys AND non-negative residuals → de-cumulate
   *  - otherwise last ≈ sum(prior) with mismatched keys/negatives → DROP (no invented rev)
   *  - last >> peer-quarter median → drop (no FY-in-Q4)
   * Iterate: ABBV 2014 dumps FY into both Sep and Dec — dropping Dec alone still
   * leaves an annual-scale "Q3" that would paint FY into the quarterly UI.
   */
  function segmentKeys(row) {
    return Object.keys(row.segments || {}).sort();
  }

  function sameSegmentKeys(a, b) {
    const ka = segmentKeys(a);
    const kb = segmentKeys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((key, index) => key === kb[index]);
  }

  function tryDecumulateYtd(prior, last, median) {
    // True YTD: identical segment keys across the year, every residual ≥ 0, residual
    // looks like one peer quarter — otherwise totals can match by coincidence (rollups,
    // missing quarters) and subtraction invents multi-billion negative "revenue".
    if (!prior.every(row => sameSegmentKeys(row, last))) return { ok: false };
    const residual = {};
    for (const name of Object.keys(last.segments)) {
      const priorValue = prior.reduce((sum, row) => sum + (row.segments[name] || 0), 0);
      const quarterValue = last.segments[name] - priorValue;
      if (!Number.isFinite(quarterValue)) return { ok: false };
      if (quarterValue < 0) return { ok: false };
      if (quarterValue > 0) residual[name] = quarterValue;
    }
    const residualTotal = Object.values(residual).reduce((sum, value) => sum + value, 0);
    if (!(residualTotal > 0) || !Object.keys(residual).length) return { ok: false };
    // Reject only annual-sized residuals. A tiny leftover Q4 after true YTD is valid
    // (and must survive; do not treat it as a junk stub).
    if (median > 0 && residualTotal >= median * 2.8) return { ok: false };
    return { ok: true, row: { ...last, segments: residual } };
  }

  function sanitizeQuarterlyRows(rows) {
    const normalized = asNormalizedRows(rows);
    if (normalized.length < 2) return normalized;
    const byYear = new Map();
    for (const row of normalized) {
      const year = row.date.slice(0, 4);
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year).push({ ...row, segments: { ...row.segments } });
    }
    const out = [];
    for (const yearRows of byYear.values()) {
      let rowsInYear = yearRows.sort((a, b) => a.date.localeCompare(b.date));
      // Keep trimming / de-cumulating the trailing row until peers look quarterly-scaled.
      while (rowsInYear.length >= 2) {
        const prior = rowsInYear.slice(0, -1);
        const last = rowsInYear.at(-1);
        const priorTotals = prior.map(rowTotal);
        const priorSum = priorTotals.reduce((sum, value) => sum + value, 0);
        const lastTotal = rowTotal(last);
        const median = [...priorTotals].sort((a, b) => a - b)[Math.floor((priorTotals.length - 1) / 2)] || 0;

        // YTD needs ≥2 prior quarters (Q3≈Q1+Q2 or Q4≈Q1+Q2+Q3). With only one
        // prior, last≈priorSum is normal QoQ stability — do not de-cumulate.
        if (prior.length >= 2 && priorSum > 0
            && Math.abs(lastTotal - priorSum) / priorSum <= 0.12) {
          const decum = tryDecumulateYtd(prior, last, median);
          if (decum.ok) {
            rowsInYear = [...prior, decum.row];
            break;
          }
          // Coincident total match / rollup mismatch — drop and re-check new trailing row.
          rowsInYear = prior;
          continue;
        }
        // Negative year-end artifacts (e.g. Citigroup FMP Q4 dumps) poison TTM.
        if (lastTotal < 0) {
          rowsInYear = prior;
          continue;
        }
        // Oversized year-end (FY dump into Q4).
        if (median > 0 && lastTotal > median * 2.8) {
          rowsInYear = prior;
          continue;
        }
        // Undersized junk YE stub (<< peers) with mismatched segment keys — not a
        // legitimate de-cumulated leftover (those keep the same keys as priors).
        if (median > 0 && lastTotal >= 0 && lastTotal < median * 0.15
            && prior.length && !sameSegmentKeys(last, prior[prior.length - 1])) {
          rowsInYear = prior;
          continue;
        }
        break;
      }
      out.push(...rowsInYear);
    }
    // Final sweep: drop any remaining negative-total quarters (mid-year junk too).
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out.filter(row => rowTotal(row) >= 0);
  }

  function validateCache(record, ticker) {
    if (record?.version !== 1 || record.ticker !== ticker
        || !record.product && !record.geographic) {
      throw new TypeError('Unsupported revenue segment record');
    }
    const period = record.period || null;
    let product = normalizeRows(record.product || [], ticker);
    let geographic = normalizeRows(record.geographic || [], ticker);
    // Already-scrubbed quarter caches carry sanitizedAt — skip a second pass that
    // would otherwise treat a leftover de-cumulated Q4 as a junk stub and drop it.
    // Re-run when any row still has a negative total (poison YE kept under an old tip).
    const hasNegative = rows => rows.some(row => rowTotal(row) < 0);
    const alreadySanitized = period === 'quarter' && !!record.sanitizedAt
      && !hasNegative(product) && !hasNegative(geographic);
    if (period === 'quarter' && !alreadySanitized) {
      product = sanitizeQuarterlyRows(product);
      geographic = sanitizeQuarterlyRows(geographic);
    }
    return {
      version: 1,
      ticker,
      source: record.source || 'FMP revenue segmentation',
      period,
      product,
      geographic,
      ...(record.sanitizedAt ? { sanitizedAt: record.sanitizedAt } : {}),
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

  function periodSpec(entry, index) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const label = String(entry.label ?? `P${index + 1}`);
      const kind = entry.kind
        || (/^TTM$/i.test(label) || /latest balance/i.test(label) || /最新期末/.test(label)
          ? 'ttm' : 'period');
      const dateHint = entry.date && /^\d{4}-\d{2}/.test(String(entry.date))
        ? String(entry.date).slice(0, 10) : null;
      return { label, kind, dateHint };
    }
    const raw = typeof entry === 'string' ? entry : '';
    const kind = /^TTM$/i.test(raw) || /latest balance/i.test(raw) || /最新期末/.test(raw)
      ? 'ttm' : 'period';
    const dateHint = /^\d{4}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
    return { label: raw || `P${index + 1}`, kind, dateHint };
  }

  /**
   * Sum the last `count` quarterly segment rows into one TTM snapshot.
   * Returns null when fewer than `count` quarters exist (caller should omit TTM).
   */
  function sumTrailingQuarters(segmentRows, count = 4, ticker = null) {
    const rows = asNormalizedRows(segmentRows, ticker);
    if (rows.length < count) return null;
    const window = rows.slice(-count);
    const segments = {};
    for (const row of window) {
      for (const [name, value] of Object.entries(row.segments || {})) {
        if (!Number.isFinite(value)) continue;
        segments[name] = (segments[name] || 0) + value;
      }
    }
    if (!Object.keys(segments).length) return null;
    return {
      date: window.at(-1).date,
      from: window[0].date,
      to: window.at(-1).date,
      quarters: count,
      segments,
    };
  }

  /** Fill empty TTM columns from trailing quarterly sums; leave null when impossible. */
  function applyTtmFromQuarters(aligned, quarterRows, ticker = null) {
    if (!aligned?.columns?.length) return aligned || { names: [], columns: [] };
    const ttm = sumTrailingQuarters(quarterRows, 4, ticker);
    if (!ttm) return aligned;
    const nameSet = new Set(aligned.names || []);
    Object.keys(ttm.segments).forEach(name => nameSet.add(name));
    const columns = aligned.columns.map((col) => {
      if (col.kind !== 'ttm') return col;
      return {
        ...col,
        date: ttm.date,
        segments: { ...ttm.segments },
        ttmFrom: ttm.from,
        ttmTo: ttm.to,
      };
    });
    return {
      names: [...nameSet].sort((a, b) => a.localeCompare(b)),
      columns,
    };
  }

  /**
   * Align segment series to the financials period labels/dates (annual or interim).
   * `periodDates` may be strings or `{ label, date?, kind? }` specs.
   * Matching is by calendar date prefix (YYYY-MM) then nearest prior segment date.
   * TTM / "latest balance" columns never reuse a prior FY segment snapshot (avoids
   * fake headers like 2026-06 paired with a duplicated 2025-09 FY amount).
   * Call `applyTtmFromQuarters` afterward to fill TTM from last-4 quarterly rows.
   */
  function alignToPeriods(segmentRows, periodDates, ticker = null) {
    const rows = asNormalizedRows(segmentRows, ticker);
    if (!Array.isArray(periodDates) || !periodDates.length) {
      return { names: [], columns: [] };
    }
    const nameSet = new Set();
    const columns = periodDates.map((entry, index) => {
      const { label, kind, dateHint } = periodSpec(entry, index);
      if (kind === 'ttm') {
        // Keep the statement TTM as-of date for the sub-label only — never attach FY segments.
        return { label, date: dateHint, segments: null, kind: 'ttm' };
      }
      let match = null;
      if (dateHint) {
        const iso = dateHint.length === 7 ? `${dateHint}-28` : dateHint;
        const prefix = iso.slice(0, 7);
        match = [...rows].reverse().find(row => row.date.slice(0, 7) === prefix)
          || [...rows].reverse().find(row => row.date <= iso);
      }
      if (match) Object.keys(match.segments).forEach(name => nameSet.add(name));
      return {
        label,
        date: match?.date || null,
        segments: match?.segments || null,
        kind: 'period',
      };
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

    function readOneCache(path) {
      return fetch(path).then(async (response) => {
        if (!response.ok) throw new Error('MISSING_SEGMENT_CACHE');
        const record = validateCache(await response.json(), ticker);
        const cachePeriod = record.period || 'annual';
        return { ...record, period: cachePeriod };
      });
    }

    function readLocalCache() {
      const enc = encodeURIComponent(ticker);
      // Prefer period-specific files so Preview without FMP_API_KEY can still show quarters.
      // Annual `{ticker}.json` must never satisfy a quarterly UI (no FY amounts in Q columns).
      if (period === 'quarter') {
        return readOneCache(`cache/revenue_segments/${enc}.quarter.json`).then((record) => {
          if (record.period !== 'quarter') throw new Error('SEGMENT_CACHE_PERIOD_MISMATCH');
          return record;
        });
      }
      return readOneCache(`cache/revenue_segments/${enc}.json`).then((record) => {
        const cachePeriod = record.period || 'annual';
        if (period !== 'annual' && cachePeriod !== period) {
          throw new Error('SEGMENT_CACHE_PERIOD_MISMATCH');
        }
        return { ...record, period: cachePeriod };
      });
    }

    async function fetchPeriod(requestedPeriod) {
      const qs = `symbol=${encodeURIComponent(ticker)}&period=${requestedPeriod}&structure=flat`;
      const [productRes, geoRes] = await Promise.all([
        fetch(`/api/fmp?action=revenue-product-segmentation&${qs}`),
        fetch(`/api/fmp?action=revenue-geographic-segmentation&${qs}`),
      ]);
      if (!productRes.ok && !geoRes.ok) {
        let detail = String(productRes.status || geoRes.status);
        try {
          const body = await productRes.json().catch(() => geoRes.json());
          if (body?.error) detail = `${detail}:${body.error}`;
        } catch { /* ignore */ }
        throw new Error(`SEGMENT_API_FAILED:${detail}`);
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
      // Quarter empty from FMP: return empty quarter record (do NOT paint annual FY into Q columns).
      // Annual file/API data is only used when the UI period is annual.
      return record;
    };

    // Never reuse annual local cache for quarterly UI — FY amounts must not appear in Q columns.
    const task = readLocalCache().catch(() => remote()).then((record) => {
      Cache?.set?.(cacheKey, record);
      return record;
    }).finally(() => { if (pending.get(cacheKey) === task) pending.delete(cacheKey); });
    pending.set(cacheKey, task);
    return task;
  }

  return {
    normalizeRows,
    extractSegmentMap,
    validateCache,
    sanitizeQuarterlyRows,
    sumTrailingQuarters,
    applyTtmFromQuarters,
    alignToPeriods,
    fmpPeriod,
    load,
  };
});
