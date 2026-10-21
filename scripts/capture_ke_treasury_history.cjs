#!/usr/bin/env node
/**
 * Capture calendar-year USD 10Y constant-maturity yields (FRED DGS10) for Ke history.
 * Does not invent equity betas or ERPs — those stay current/assumed at display time.
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'cache', 'ke_history');
const outFile = path.join(outDir, 'treasury_usd10y.json');
const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10';
const YEARS = 10;

async function fetchCsv(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: 'follow' });
  if (!response.ok) throw new Error(`FRED_DGS10_HTTP_${response.status}`);
  return response.text();
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

async function capture() {
  const csv = await fetchCsv(FRED_CSV);
  const years = parseYearEnds(csv);
  const payload = {
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
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n');
  // Embed for Preview/static hosts so Ke history never depends solely on JSON fetch.
  fs.writeFileSync(path.join(root, 'ke_treasury_data.js'),
    `window.KE_TREASURY_USD10Y = ${JSON.stringify(payload)};\n`);
  console.log(`Wrote ${years.filter(y => y.year10 !== null).length}/${years.length} USD 10Y year points → ${path.relative(root, outFile)}`);
  return payload;
}

if (require.main === module) {
  capture().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { parseYearEnds, capture, YEARS };
