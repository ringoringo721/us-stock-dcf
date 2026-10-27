'use strict';

/**
 * SEC EDGAR companyfacts helpers for US FMP anomaly annotate / optional overwrite.
 * Default product policy is annotate-only (reports); applyOverwrites is a gated escape hatch.
 * Never invents numbers: values change only when an EDGAR fact exists for a matched period.
 * HK tickers (.HK) are out of scope.
 */

const DEFAULT_TOLERANCE_RATIO = 0.02;
const DEFAULT_TOLERANCE_ABS = 1e6;
const COMPANYFACTS_BASE = 'https://data.sec.gov/api/xbrl/companyfacts';

const CONCEPT_CANDIDATES = {
  revenue: [
    'Revenues',
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'SalesRevenueNet'
  ],
  netIncome: ['NetIncomeLoss'],
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'],
  capitalExpenditure: ['PaymentsToAcquirePropertyPlantAndEquipment'],
  weightedAverageShsOutDil: ['WeightedAverageNumberOfDilutedSharesOutstanding'],
  sharesOutstanding: ['EntityCommonStockSharesOutstanding']
};

const MVP_ROW_FIELDS = ['revenue', 'netIncome', 'operatingCashFlow', 'weightedAverageShsOutDil'];

function isUsTicker(ticker) {
  return Boolean(ticker) && !/\.HK$/i.test(String(ticker));
}

function normalizeCik(cik) {
  if (cik == null) return null;
  const digits = String(cik).replace(/\D/g, '');
  if (!digits || /^0+$/.test(digits)) return null;
  return digits.padStart(10, '0');
}

function resolveCik(statements, profileCik) {
  const rows = [];
  for (const period of ['annual', 'quarterly']) {
    for (const type of ['income', 'balance', 'cashflow']) {
      const list = statements?.[period]?.[type];
      if (Array.isArray(list)) rows.push(...list);
    }
  }
  for (const row of rows) {
    const cik = normalizeCik(row?.cik);
    if (cik) return cik;
  }
  return normalizeCik(profileCik);
}

function companyfactsUrl(cik) {
  const normalized = normalizeCik(cik);
  if (!normalized) throw new Error('invalid CIK');
  return `${COMPANYFACTS_BASE}/CIK${normalized}.json`;
}

function requireUserAgent(userAgent) {
  const value = String(userAgent || process.env.SEC_USER_AGENT || '').trim();
  if (!value || /mozilla\/\d/i.test(value)) {
    throw new Error('SEC_USER_AGENT required (descriptive identity + contact email; not a browser UA)');
  }
  return value;
}

async function fetchCompanyfacts(cik, options = {}) {
  const url = companyfactsUrl(cik);
  const userAgent = requireUserAgent(options.userAgent);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': userAgent,
      Accept: 'application/json'
    }
  });
  if (response.status === 429) {
    const err = new Error('SEC_RATE_LIMITED');
    err.status = 429;
    throw err;
  }
  if (!response.ok) {
    const err = new Error(`SEC_HTTP_${response.status}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

function periodToken(row) {
  const period = String(row?.period || '').toUpperCase();
  if (period === 'FY' || period === 'YEAR') return 'FY';
  if (/^Q[1-4]$/.test(period)) return period;
  return period || null;
}

function durationDays(entry) {
  if (!entry?.start || !entry?.end) return null;
  const startMs = Date.parse(String(entry.start).slice(0, 10));
  const endMs = Date.parse(String(entry.end).slice(0, 10));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.round((endMs - startMs) / 86400000);
}

/** Expected XBRL duration window for an FMP statement period. Rejects YTD/cumulative when matching quarters. */
function expectedDurationRange(fp) {
  if (fp === 'FY') return { min: 300, max: 400, allowMissingStart: true };
  if (/^Q[1-4]$/.test(fp)) return { min: 70, max: 110, allowMissingStart: false };
  return null;
}

function durationCompatible(entry, fp) {
  const expected = expectedDurationRange(fp);
  if (!expected) return true;
  const days = durationDays(entry);
  if (days == null) return expected.allowMissingStart;
  return days >= expected.min && days <= expected.max;
}

function unitEntries(companyfacts, concept) {
  const node = companyfacts?.facts?.['us-gaap']?.[concept]
    || companyfacts?.facts?.dei?.[concept];
  if (!node?.units) return [];
  const preferred = node.units.USD || node.units.shares || Object.values(node.units)[0];
  return Array.isArray(preferred) ? preferred : [];
}

function hasFactsForEnd(entries, end) {
  const target = String(end || '').slice(0, 10);
  return Array.isArray(entries) && entries.some(entry => String(entry?.end || '').slice(0, 10) === target
    && Number.isFinite(Number(entry?.val)));
}

/**
 * Match a companyfacts unit entry to an FMP statement row.
 * Requires the same period end; prefers fy/fp; for duration facts requires
 * quarter-length (~90d) for Q1–Q4 and year-length (~365d) for FY so YTD/cumulative
 * values are never compared to single-quarter FMP rows.
 */
function matchFact(entries, row, { formPrefer = ['10-K', '10-Q'] } = {}) {
  if (!Array.isArray(entries) || !entries.length || !row?.date) return null;
  const end = String(row.date).slice(0, 10);
  const fy = String(row.fiscalYear || row.calendarYear || '');
  const fp = periodToken(row);
  const scored = entries
    .filter(entry => entry && Number.isFinite(Number(entry.val)))
    .filter(entry => String(entry.end || '').slice(0, 10) === end)
    .filter(entry => {
      if (!fp || !entry.fp) return true;
      return String(entry.fp).toUpperCase() === fp;
    })
    .filter(entry => durationCompatible(entry, fp))
    .map(entry => {
      let score = 10; // exact end already required
      if (fy && String(entry.fy) === fy) score += 3;
      if (fp && String(entry.fp || '').toUpperCase() === fp) score += 3;
      if (formPrefer.includes(String(entry.form || ''))) score += 1;
      if (entry.frame) score += 1; // framed single-period facts preferred over unlabeled duplicates
      const days = durationDays(entry);
      if (fp && /^Q[1-4]$/.test(fp) && days != null && days >= 70 && days <= 110) score += 2;
      if (fp === 'FY' && days != null && days >= 300) score += 2;
      return { entry, score, days };
    })
    .sort((a, b) => b.score - a.score
      || (a.days ?? 1e9) - (b.days ?? 1e9) // prefer tighter/shorter compatible duration
      || String(b.entry.filed || '').localeCompare(String(a.entry.filed || '')));
  return scored[0]?.entry || null;
}

function pickConceptValue(companyfacts, field, row) {
  const concepts = CONCEPT_CANDIDATES[field] || [];
  let sawEndMatch = false;
  for (const concept of concepts) {
    const entries = unitEntries(companyfacts, concept);
    if (hasFactsForEnd(entries, row?.date)) sawEndMatch = true;
    const entry = matchFact(entries, row);
    if (entry) {
      return {
        concept,
        value: Number(entry.val),
        end: entry.end,
        start: entry.start || null,
        days: durationDays(entry),
        fy: entry.fy,
        fp: entry.fp,
        form: entry.form,
        frame: entry.frame || null,
        filed: entry.filed,
        accn: entry.accn
      };
    }
  }
  return { missing: true, periodUnmatched: sawEndMatch };
}

function finiteNumber(value) {
  return value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
}

function isMissing(value) {
  return finiteNumber(value) == null;
}

function differs(fmpValue, edgarValue, {
  toleranceRatio = DEFAULT_TOLERANCE_RATIO,
  toleranceAbs = DEFAULT_TOLERANCE_ABS
} = {}) {
  const left = finiteNumber(fmpValue);
  const right = finiteNumber(edgarValue);
  if (left == null || right == null) return false;
  const abs = Math.abs(left - right);
  if (abs <= toleranceAbs) return false;
  const denom = Math.max(Math.abs(left), Math.abs(right), 1);
  return abs / denom > toleranceRatio;
}

function normalizeCapexSign(fmpCapex, edgarAbsOrSigned) {
  const edgar = finiteNumber(edgarAbsOrSigned);
  if (edgar == null) return null;
  const fmp = finiteNumber(fmpCapex);
  // FMP usually stores CapEx as negative cash outflow; EDGAR PPE payments are typically positive.
  if (fmp != null && fmp < 0 && edgar > 0) return -Math.abs(edgar);
  if (fmp != null && fmp > 0 && edgar < 0) return Math.abs(edgar);
  return edgar;
}

function deriveFreeCashFlow(ocf, capex) {
  const operating = finiteNumber(ocf);
  const spend = finiteNumber(capex);
  if (operating == null || spend == null) return null;
  // FCF = OCF + CapEx when CapEx is negative; OCF - CapEx when CapEx is positive spend.
  return spend <= 0 ? operating + spend : operating - spend;
}

function compareRowField(row, field, companyfacts, options = {}) {
  const fmpValue = finiteNumber(row?.[field]);
  const picked = pickConceptValue(companyfacts, field, row);
  if (!picked || picked.missing) {
    return {
      field,
      date: row?.date || null,
      period: row?.period || null,
      fmpValue,
      edgarValue: null,
      trigger: picked?.periodUnmatched ? 'periodUnmatched' : 'edgarConceptMissing',
      action: 'none'
    };
  }
  let edgarValue = picked.value;
  if (field === 'capitalExpenditure') {
    edgarValue = normalizeCapexSign(row?.capitalExpenditure, picked.value);
  }
  const meta = {
    field, date: row.date, period: row.period, fmpValue, edgarValue,
    concept: picked.concept, accn: picked.accn, filed: picked.filed,
    start: picked.start, days: picked.days, frame: picked.frame, fp: picked.fp, fy: picked.fy
  };
  if (isMissing(fmpValue) && edgarValue != null) {
    return { ...meta, trigger: 'fmpMissingEdgarPresent', action: 'overwrite' };
  }
  if (differs(fmpValue, edgarValue, options)) {
    return { ...meta, trigger: 'fmpEdgarMismatch', action: 'overwrite' };
  }
  return { ...meta, trigger: 'agree', action: 'none' };
}

function inspectStatements(statements, companyfacts, options = {}) {
  const fields = options.fields || MVP_ROW_FIELDS;
  const findings = [];
  for (const frequency of ['annual', 'quarterly']) {
    for (const type of ['income', 'cashflow']) {
      const rows = statements?.[frequency]?.[type];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        for (const field of fields) {
          if (type === 'income' && !['revenue', 'netIncome', 'weightedAverageShsOutDil'].includes(field)) continue;
          if (type === 'cashflow' && !['operatingCashFlow', 'capitalExpenditure', 'freeCashFlow'].includes(field)) continue;
          if (field === 'freeCashFlow') continue; // handled after OCF/CapEx
          findings.push({ frequency, type, ...compareRowField(row, field, companyfacts, options) });
        }
        if (type === 'cashflow' && (options.fields || [...MVP_ROW_FIELDS, 'freeCashFlow']).includes('freeCashFlow')) {
          const ocfFinding = findings.find(item => item.frequency === frequency && item.type === 'cashflow'
            && item.date === row.date && item.field === 'operatingCashFlow');
          const capexPick = pickConceptValue(companyfacts, 'capitalExpenditure', row);
          const capexMissing = !capexPick || capexPick.missing;
          const edgarCapex = !capexMissing
            ? normalizeCapexSign(row.capitalExpenditure, capexPick.value) : null;
          const edgarOcf = ocfFinding?.edgarValue ?? null;
          const edgarFcf = deriveFreeCashFlow(edgarOcf, edgarCapex);
          const fmpFcf = finiteNumber(row.freeCashFlow);
          if (edgarFcf == null) {
            const periodUnmatched = ocfFinding?.trigger === 'periodUnmatched'
              || (!!capexPick && capexPick.periodUnmatched);
            findings.push({
              frequency, type, field: 'freeCashFlow', date: row.date, period: row.period,
              fmpValue: fmpFcf, edgarValue: null,
              trigger: periodUnmatched ? 'periodUnmatched' : 'edgarConceptMissing',
              action: 'none'
            });
          } else if (isMissing(fmpFcf)) {
            findings.push({
              frequency, type, field: 'freeCashFlow', date: row.date, period: row.period,
              fmpValue: fmpFcf, edgarValue: edgarFcf, concept: 'derived:OCF-CapEx',
              trigger: 'fmpMissingEdgarPresent', action: 'overwrite'
            });
          } else if (differs(fmpFcf, edgarFcf, options)) {
            findings.push({
              frequency, type, field: 'freeCashFlow', date: row.date, period: row.period,
              fmpValue: fmpFcf, edgarValue: edgarFcf, concept: 'derived:OCF-CapEx',
              trigger: 'fmpEdgarMismatch', action: 'overwrite'
            });
          } else {
            findings.push({
              frequency, type, field: 'freeCashFlow', date: row.date, period: row.period,
              fmpValue: fmpFcf, edgarValue: edgarFcf, concept: 'derived:OCF-CapEx',
              trigger: 'agree', action: 'none'
            });
          }
        }
      }
    }
  }
  return findings;
}

function warningMessage(finding, language = 'zh') {
  if (language === 'en') {
    if (finding.trigger === 'fmpMissingEdgarPresent') {
      return `FMP missing ${finding.field} for ${finding.date}; filled from SEC EDGAR companyfacts (${finding.concept}).`;
    }
    if (finding.trigger === 'fmpEdgarMismatch') {
      return `FMP ${finding.field} for ${finding.date} disagrees with SEC EDGAR companyfacts; overwritten from ${finding.concept}.`;
    }
    return `SEC EDGAR companyfacts note for ${finding.field} @ ${finding.date}: ${finding.trigger}`;
  }
  if (finding.trigger === 'fmpMissingEdgarPresent') {
    return `FMP 缺 ${finding.field}（${finding.date}）；已以 SEC EDGAR companyfacts（${finding.concept}）補上。`;
  }
  if (finding.trigger === 'fmpEdgarMismatch') {
    return `FMP ${finding.field}（${finding.date}）與 SEC EDGAR companyfacts 不符，已採 ${finding.concept} 覆寫。`;
  }
  return `SEC EDGAR companyfacts 備註：${finding.field} @ ${finding.date}（${finding.trigger}）`;
}

function applyOverwrites(statements, findings, options = {}) {
  const overwrites = findings.filter(item => item.action === 'overwrite' && Number.isFinite(item.edgarValue));
  if (!overwrites.length) {
    return {
      statements,
      applied: [],
      qualityWarnings: Array.isArray(statements.qualityWarnings) ? statements.qualityWarnings : []
    };
  }
  const clone = structuredClone(statements);
  const applied = [];
  for (const item of overwrites) {
    const rows = clone?.[item.frequency]?.[item.type];
    if (!Array.isArray(rows)) continue;
    const row = rows.find(candidate => candidate?.date === item.date);
    if (!row) continue;
    const previous = row[item.field];
    row[item.field] = item.edgarValue;
    row.edgarCorrection = {
      ...(row.edgarCorrection || {}),
      [item.field]: {
        previous,
        value: item.edgarValue,
        concept: item.concept,
        trigger: item.trigger,
        accn: item.accn || null,
        filed: item.filed || null
      }
    };
    applied.push(item);
  }
  const retained = (clone.qualityWarnings || []).filter(row => row?.code !== 'edgarCompanyfactsOverwrite');
  const qualityWarnings = [
    ...retained,
    ...applied.map(item => ({
      code: 'edgarCompanyfactsOverwrite',
      field: item.field,
      date: item.date,
      period: item.period,
      frequency: item.frequency,
      type: item.type,
      fmpValue: item.fmpValue,
      edgarValue: item.edgarValue,
      concept: item.concept,
      trigger: item.trigger,
      message: warningMessage(item, options.language || 'zh')
    }))
  ];
  clone.qualityWarnings = qualityWarnings;
  clone.edgarOverlay = {
    cik: options.cik || clone.edgarOverlay?.cik || null,
    retrievedAt: options.retrievedAt || new Date().toISOString(),
    source: 'data.sec.gov/api/xbrl/companyfacts',
    appliedCount: applied.length,
    mode: options.mode || 'overwrite'
  };
  return { statements: clone, applied, qualityWarnings };
}

function summarizeFindings(findings) {
  const summary = {
    total: findings.length,
    agree: 0,
    overwrite: 0,
    missingConcept: 0,
    periodUnmatched: 0,
    byTrigger: {}
  };
  for (const item of findings) {
    summary.byTrigger[item.trigger] = (summary.byTrigger[item.trigger] || 0) + 1;
    if (item.trigger === 'agree') summary.agree += 1;
    if (item.action === 'overwrite') summary.overwrite += 1;
    if (item.trigger === 'edgarConceptMissing') summary.missingConcept += 1;
    if (item.trigger === 'periodUnmatched') summary.periodUnmatched += 1;
  }
  return summary;
}

module.exports = {
  CONCEPT_CANDIDATES,
  MVP_ROW_FIELDS,
  DEFAULT_TOLERANCE_RATIO,
  DEFAULT_TOLERANCE_ABS,
  isUsTicker,
  normalizeCik,
  resolveCik,
  companyfactsUrl,
  requireUserAgent,
  fetchCompanyfacts,
  durationDays,
  expectedDurationRange,
  durationCompatible,
  matchFact,
  pickConceptValue,
  compareRowField,
  inspectStatements,
  applyOverwrites,
  summarizeFindings,
  deriveFreeCashFlow,
  differs,
  warningMessage
};
