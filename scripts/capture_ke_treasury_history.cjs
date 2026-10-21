#!/usr/bin/env node
/**
 * Capture:
 * 1) Calendar-year USD 10Y (FRED DGS10) for Fin Ke history.
 * 2) Dated USD Treasury constant-maturity curve (1/2/3/5/7/10Y) from Treasury.gov
 *    for Advanced ten-year #fmp-rf-tenor (HK uses the same USD / peg-proxy concept).
 * Does not invent equity betas, ERPs, or unpublished CMT tenors (4/6/8/9Y).
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'cache', 'ke_history');
const outFile = path.join(outDir, 'treasury_usd10y.json');
const curveFile = path.join(outDir, 'treasury_usd_curve.json');
const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10';
const TREASURY_CSV = year =>
  `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
const YEARS = 10;
const PUBLISHED_TENORS = [1, 2, 3, 5, 7, 10];
const UNPUBLISHED_TENORS = [4, 6, 8, 9];
const COL = {
  1: '1 Yr', 2: '2 Yr', 3: '3 Yr', 5: '5 Yr', 7: '7 Yr', 10: '10 Yr'
};

async function fetchText(url, label) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60000),
    redirect: 'follow',
    headers: { 'User-Agent': 'us-stock-dcf-ke-treasury-capture/1.0' }
  });
  if (!response.ok) throw new Error(`${label}_HTTP_${response.status}`);
  const text = await response.text();
  if (/<!doctype html>|<html[\s>]/i.test(text.slice(0, 200))) throw new Error(`${label}_HTML_NOT_CSV`);
  return text;
}

function parseYearEnds(csv) {
  const lines = csv.trim().split(/\r?\n/);
  if (lines[0] !== 'observation_date,DGS10') throw new Error('FRED_DGS10_UNEXPECTED_HEADER');
  const byYear = new Map();
  for (const line of lines.slice(1)) {
    const [date, raw] = line.split(',');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !raw || raw === '.') continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const year = Number(date.slice(0, 4));
    byYear.set(year, { year, date, year10: value });
  }
  if (!byYear.size) throw new Error('FRED_DGS10_EMPTY');
  const latestYear = Math.max(...byYear.keys());
  const years = [];
  for (let year = latestYear - (YEARS - 1); year <= latestYear; year++) {
    const row = byYear.get(year);
    if (!row) {
      years.push({ year, date: null, year10: null, yearEnd: null, reason: 'missingTreasuryObservation' });
      continue;
    }
    const yearEnd = row.date.slice(5) >= '12-15';
    years.push({
      year: row.year,
      date: row.date,
      year10: row.year10,
      yearEnd,
      reason: yearEnd ? null : 'latestObservationNotYearEnd'
    });
  }
  return years;
}

function parseIsoDate(usDate) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(usDate || '').trim());
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || !day || !year) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseTreasuryCurveCsv(csv) {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error('TREASURY_CURVE_EMPTY');
  const header = lines[0].split(',').map(cell => cell.replace(/^"|"$/g, '').trim());
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  if (index.Date == null || PUBLISHED_TENORS.some(year => index[COL[year]] == null)) {
    throw new Error('TREASURY_CURVE_UNEXPECTED_HEADER');
  }
  const byDate = {};
  for (const line of lines.slice(1)) {
    const cells = [];
    let current = '';
    let quoted = false;
    for (const char of line) {
      if (char === '"') { quoted = !quoted; continue; }
      if (char === ',' && !quoted) { cells.push(current); current = ''; continue; }
      current += char;
    }
    cells.push(current);
    const date = parseIsoDate(cells[index.Date]);
    if (!date) continue;
    const row = { date, currency: 'USD' };
    let any = false;
    for (const year of PUBLISHED_TENORS) {
      const raw = cells[index[COL[year]]];
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      row[`year${year}`] = value;
      any = true;
    }
    if (any) byDate[date] = row;
  }
  const dates = Object.keys(byDate).sort();
  if (!dates.length) throw new Error('TREASURY_CURVE_NO_ROWS');
  const latestDate = dates.at(-1);
  return {
    version: 1,
    source: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/',
    csvPattern: TREASURY_CSV('<year>'),
    basis: 'usdTreasuryConstantMaturityParYieldCurve',
    unit: 'percent',
    currency: 'USD',
    method: 'officialDailyParYieldCurve',
    hkPolicy: 'userDirectedUsdTreasuryProxyUnderHkdUsdPeg',
    publishedTenors: [...PUBLISHED_TENORS],
    unpublishedTenors: [...UNPUBLISHED_TENORS],
    unpublishedReason: 'noConstantMaturityTreasuryPublication',
    capturedAt: new Date().toISOString(),
    latest: { ...byDate[latestDate] },
    byDate
  };
}

function loadExistingHistory() {
  if (!fs.existsSync(outFile)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    if (data?.version === 1 && Array.isArray(data.years) && data.years.length === 10) return data;
  } catch {
    return null;
  }
  return null;
}

async function captureCurve(year = new Date().getUTCFullYear()) {
  const csv = await fetchText(TREASURY_CSV(year), 'TREASURY_CURVE');
  return parseTreasuryCurveCsv(csv);
}

async function captureHistory() {
  const existing = loadExistingHistory();
  try {
    const csv = await fetchText(FRED_CSV, 'FRED_DGS10');
    const years = parseYearEnds(csv);
    return {
      version: 1,
      series: 'DGS10',
      source: 'https://fred.stlouisfed.org/series/DGS10',
      csv: FRED_CSV,
      basis: 'usdTreasury10YConstantMaturity',
      unit: 'percent',
      method: 'calendarYearLastObservation',
      hkPolicy: 'userDirectedUsdTreasuryProxyUnderHkdUsdPeg',
      capturedAt: new Date().toISOString(),
      years
    };
  } catch (error) {
    if (!existing) throw error;
    console.warn(`FRED DGS10 unavailable (${error.message}); retaining ${path.relative(root, outFile)}`);
    const { retainedAt: _a, retainReason: _b, ...clean } = existing;
    return clean;
  }
}

function writeEmbed(history, curve) {
  const payload = { ...history, curve };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(history, null, 2) + '\n');
  fs.writeFileSync(curveFile, JSON.stringify(curve, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'ke_treasury_data.js'),
    `window.KE_TREASURY_USD10Y = ${JSON.stringify(payload)};\n`);
  const published = curve.publishedTenors.filter(year => Number.isFinite(curve.latest[`year${year}`]));
  console.log(`Wrote Ke history ${history.years.filter(y => y.year10 !== null).length}/${history.years.length} · curve ${curve.latest.date} tenors ${published.join(',')}`);
  return payload;
}

async function capture() {
  const [history, curve] = await Promise.all([captureHistory(), captureCurve()]);
  return writeEmbed(history, curve);
}

if (require.main === module) {
  capture().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = {
  parseYearEnds, parseTreasuryCurveCsv, capture, captureCurve, captureHistory,
  YEARS, PUBLISHED_TENORS, UNPUBLISHED_TENORS, TREASURY_CSV
};
