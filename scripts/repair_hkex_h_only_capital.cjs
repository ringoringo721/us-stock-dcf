#!/usr/bin/env node
'use strict';
/**
 * Re-parse FF301 monthly-return PDFs for H-only capital records and restore
 * missing Domestic/A/other ordinary classes when the PDF discloses them.
 * Does not invent classes; leaves true single-class issuers unchanged.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const capitalPath = path.join(root, 'cache', 'hkex_share_capital.json');
const capital = JSON.parse(fs.readFileSync(capitalPath, 'utf8'));

const py = `
import json, sys, types, urllib.request
from importlib.util import spec_from_file_location, module_from_spec
sys.modules.setdefault("requests", types.ModuleType("requests"))
spec = spec_from_file_location("cap", ${JSON.stringify(path.join(root, 'scripts', 'capture_hkex_share_capital.py'))})
mod = module_from_spec(spec)
spec.loader.exec_module(mod)
jobs = json.loads(sys.stdin.read())
out = []
for job in jobs:
    ticker, url = job["ticker"], job["url"]
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; financial-statement-review)"})
        data = urllib.request.urlopen(req, timeout=90).read()
        parsed = mod.parse_ff301(data)
        out.append({
            "ticker": ticker,
            "ok": True,
            "classes": parsed["classes"],
            "outstandingShares": parsed["outstandingShares"],
            "date": parsed["date"],
            "filingDate": parsed["filingDate"],
        })
    except Exception as e:
        out.append({"ticker": ticker, "ok": False, "error": f"{type(e).__name__}: {e}"})
print(json.dumps(out))
`;

function hOnlyTickers() {
  return Object.entries(capital)
    .filter(([, row]) => Array.isArray(row.classes)
      && row.classes.length === 1
      && row.classes[0].name === 'H'
      && /^https:\/\//.test(row.url || ''))
    .map(([ticker, row]) => ({ ticker, url: row.url }));
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function main() {
  const jobs = hOnlyTickers();
  const summary = {
    scanned: jobs.length,
    upgraded: [],
    unchanged: [],
    failed: [],
  };
  for (const batch of chunk(jobs, 25)) {
    const result = spawnSync(process.env.PYTHON || 'python3', ['-c', py], {
      input: JSON.stringify(batch),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(`batch failed: ${result.stderr || result.stdout}`);
    }
    const rows = JSON.parse(result.stdout);
    for (const row of rows) {
      if (!row.ok) {
        summary.failed.push({ ticker: row.ticker, error: row.error });
        continue;
      }
      const before = capital[row.ticker];
      const beforeNames = before.classes.map(c => c.name).join('/');
      const afterNames = row.classes.map(c => c.name).join('/');
      if (row.classes.length <= 1) {
        summary.unchanged.push(row.ticker);
        continue;
      }
      const beforeOutstanding = before.classes.reduce(
        (n, c) => n + c.issuedShares - (c.treasuryShares || 0), 0);
      capital[row.ticker] = {
        ...before,
        date: row.date || before.date,
        filingDate: row.filingDate || before.filingDate,
        coverage: 'allOrdinaryShareClasses',
        classes: row.classes,
        verifiedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        providerReview: before.providerReview ? {
          ...before.providerReview,
          capitalDate: row.date || before.date,
          note: `Re-parsed FF301: restored issuer-wide ordinary classes ${afterNames} `
            + `(was ${beforeNames} ${beforeOutstanding}). `
            + (before.providerReview.note || ''),
        } : before.providerReview,
      };
      summary.upgraded.push({
        ticker: row.ticker,
        before: beforeNames,
        after: afterNames,
        beforeOutstanding,
        afterOutstanding: row.outstandingShares,
      });
    }
    process.stderr.write(`batch ${batch[0].ticker}…${batch.at(-1).ticker}: `
      + `upgraded=${summary.upgraded.length} failed=${summary.failed.length}\n`);
  }
  fs.writeFileSync(capitalPath, `${JSON.stringify(capital, null, 2)}\n`);
  const reportPath = path.join(root, 'cache', 'hkex_h_only_capital_repair_summary.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({
    scanned: summary.scanned,
    upgraded: summary.upgraded.length,
    unchanged: summary.unchanged.length,
    failed: summary.failed.length,
    sampleUpgraded: summary.upgraded.slice(0, 15),
    failedSample: summary.failed.slice(0, 10),
    reportPath,
  }, null, 2));
}

main();
