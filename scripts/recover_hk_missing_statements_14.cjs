#!/usr/bin/env node
'use strict';
/**
 * Recover the 14 large-cap HK names whose moat scores stay partial because FMP
 * returned empty income/balance/cash-flow rows (providerStatementUnavailable).
 *
 * This script does NOT invent financials or moat scores. It either:
 *   1) prints the GitHub Actions dispatch recipe (default), or
 *   2) with --local and FMP_API_KEY (+ optional GCP_SA_KEY), re-captures
 *      sources, rebuilds company snapshots, and optionally retries incomplete
 *      moat assessments via the existing expansion pipeline.
 *
 * Tickers (mcap ≥ HKD 1B, partial moat, empty FMP statements as of 2026-10-20):
 *   0668.HK 0901.HK 1021.HK 1770.HK 1956.HK 2361.HK 2566.HK
 *   2569.HK 2585.HK 2697.HK 3228.HK 3661.HK 3752.HK 6686.HK
 *
 * Prior evidence: GitHub Actions run 39519497780 (artifacts hkex-expanded-*).
 * FMP profile/quote/shares-float often succeed; statement endpoints return [].
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const TICKERS = [
  '0668.HK', '0901.HK', '1021.HK', '1770.HK', '1956.HK', '2361.HK', '2566.HK',
  '2569.HK', '2585.HK', '2697.HK', '3228.HK', '3661.HK', '3752.HK', '6686.HK'
];
const SYMBOLS = TICKERS.join(',');
const PRIOR_RUN_ID = '39519497780';

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', stdio: 'inherit'
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
}

function printRecipe() {
  const text = `
HK missing-statements recovery (14 tickers)
===========================================
Symbols: ${SYMBOLS}

Blockers observed in Cloud Agent (2026-10-21):
  - FMP_API_KEY / GCP_SA_KEY / GEMINI_API_KEY are not present in the agent environment
  - workflow_dispatch on valuation_audit.yml returns HTTP 403 for the agent token
  - Prior FMP captures (run ${PRIOR_RUN_ID}) already returned HTTP 200 with 0 statement rows
    for all 14 names — re-capture alone will not invent coverage

Required secrets (GitHub Actions repo secrets, or local env for --local):
  - FMP_API_KEY          → scripts/capture_valuation_sources.py
  - GCP_SA_KEY           → research_hkex_moat.py + refresh_hkex_moat.py (Vertex)
  - GEMINI_API_KEY       → optional fallback for refresh_hkex_moat.py
  - GOOGLE_CLOUD_LOCATION=global (recommended for Vertex)

Preferred path — GitHub Actions (uses repo secrets; artifacts only):
  gh workflow run valuation_audit.yml --repo ringoringo721/us-stock-dcf \\
    -f expand_all_hk=true \\
    -f symbols='${SYMBOLS}'

  # Ratings-only retry from prior sources (no new FMP calls):
  gh workflow run valuation_audit.yml --repo ringoringo721/us-stock-dcf \\
    -f expand_all_hk=true \\
    -f moat_only=true \\
    -f resume_run_id=${PRIOR_RUN_ID} \\
    -f symbols='${SYMBOLS}'

  Then download hkex-expanded-* artifacts and integrate:
  node scripts/build_hkex_expansion.cjs integrate <artifact-root>

Local path (requires secrets in the shell):
  node scripts/recover_hk_missing_statements_14.cjs --local
  node scripts/recover_hk_missing_statements_14.cjs --local --moat

After statements appear, rebuilds populate PE/ROE/ROA/FCF via build_hkex_expansion.cjs.
Incomplete moat dimensions are only filled by Vertex --retry-incomplete; never fabricate scores.
`.trim();
  console.log(text);
}

function localCapture({ withMoat }) {
  if (!process.env.FMP_API_KEY) {
    throw new Error('FMP_API_KEY is required for --local capture; refusing to invent statements');
  }
  const output = path.join(root, 'hkex-data-output-14');
  fs.mkdirSync(path.join(output, 'sources'), { recursive: true });
  fs.mkdirSync(path.join(output, 'cache', 'fx'), { recursive: true });
  run('node', ['scripts/refresh_usd_rates.cjs', '--hkd', '--all-hkd-currencies']);
  fs.copyFileSync(path.join(root, 'cache/fx/hkd_rates.json'), path.join(output, 'cache/fx/hkd_rates.json'));
  run('python3', ['-u', 'scripts/capture_valuation_sources.py'], {
    CAPTURE_MARKET: 'HKEX',
    CAPTURE_ALL_HK: 'true',
    CAPTURE_RESUME: 'true',
    CAPTURE_REQUEST_DELAY: '1',
    CAPTURE_SYMBOLS: SYMBOLS,
    CAPTURE_OUTPUT: path.join(output, 'sources')
  });
  run('node', ['scripts/build_hkex_expansion.cjs', 'build',
    path.join(output, 'sources'), output, SYMBOLS, path.join(output, 'moat-reports.json')]);
  if (withMoat) {
    if (!process.env.GCP_SA_KEY && !process.env.GEMINI_API_KEY
        && !process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.GOOGLE_CLOUD_PROJECT) {
      throw new Error('GCP_SA_KEY or GEMINI_API_KEY required for --moat; refusing to invent scores');
    }
    run('python3', ['-u', 'scripts/research_hkex_moat.py',
      path.join(output, 'moat-inputs.json'),
      path.join(output, 'researched-inputs.json'),
      path.join(output, 'business-research.json'),
      '--retry-incomplete'], { GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION || 'global',
      MOAT_REQUEST_TIMEOUT_MS: process.env.MOAT_REQUEST_TIMEOUT_MS || '120000' });
    run('python3', ['-u', 'scripts/refresh_hkex_moat.py',
      path.join(output, 'researched-inputs.json'),
      path.join(output, 'moat-reports.json'),
      '--retry-incomplete'], { GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION || 'global',
      MOAT_REQUEST_TIMEOUT_MS: process.env.MOAT_REQUEST_TIMEOUT_MS || '180000' });
    run('node', ['scripts/build_hkex_expansion.cjs', 'build',
      path.join(output, 'sources'), output, SYMBOLS, path.join(output, 'moat-reports.json')]);
  }
  run('node', ['scripts/build_hkex_expansion.cjs', 'package', output]);
  console.log(`Local recovery artifacts written under ${output}`);
  console.log('Integrate with: node scripts/build_hkex_expansion.cjs integrate ' + output);
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--local')) localCapture({ withMoat: args.has('--moat') });
  else printRecipe();
}

if (require.main === module) main();
module.exports = { TICKERS, SYMBOLS, PRIOR_RUN_ID, printRecipe };
