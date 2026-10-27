#!/usr/bin/env node
'use strict';

/**
 * Dry-run (default) or --write verify/overwrite of US FMP statement caches
 * against SEC EDGAR companyfacts. HK tickers are rejected.
 *
 * Usage:
 *   node scripts/verify_us_statements_edgar.cjs --ticker AAPL
 *   node scripts/verify_us_statements_edgar.cjs --ticker AAPL --write
 *   node scripts/verify_us_statements_edgar.cjs --ticker AAPL --facts path/to/fixture.json
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  isUsTicker,
  resolveCik,
  fetchCompanyfacts,
  inspectStatements,
  applyOverwrites,
  summarizeFindings,
  DEFAULT_TOLERANCE_RATIO,
  DEFAULT_TOLERANCE_ABS
} = require('./edgar_companyfacts.cjs');

function parseArgs(argv) {
  const options = {
    ticker: null,
    write: false,
    facts: null,
    toleranceRatio: DEFAULT_TOLERANCE_RATIO,
    toleranceAbs: DEFAULT_TOLERANCE_ABS,
    root: path.resolve(__dirname, '..')
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') options.write = true;
    else if (arg === '--ticker') options.ticker = argv[++i];
    else if (arg === '--facts') options.facts = argv[++i];
    else if (arg === '--tolerance-ratio') options.toleranceRatio = Number(argv[++i]);
    else if (arg === '--tolerance-abs') options.toleranceAbs = Number(argv[++i]);
    else if (arg === '--root') options.root = path.resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function readStatements(root, ticker) {
  const file = path.join(root, 'cache', 'financials', `${ticker}_statements_v2.json`);
  if (!fs.existsSync(file)) throw new Error(`Missing statements cache: ${file}`);
  return { file, statements: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

async function loadFacts(options, cik) {
  if (options.facts) {
    return {
      companyfacts: JSON.parse(fs.readFileSync(path.resolve(options.facts), 'utf8')),
      retrievedAt: new Date().toISOString(),
      source: `fixture:${options.facts}`
    };
  }
  const companyfacts = await fetchCompanyfacts(cik);
  return {
    companyfacts,
    retrievedAt: new Date().toISOString(),
    source: 'data.sec.gov/api/xbrl/companyfacts'
  };
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help || !options.ticker) {
    console.log(`Usage: node scripts/verify_us_statements_edgar.cjs --ticker TICKER [--facts fixture.json] [--write]
Environment: SEC_USER_AGENT required for live SEC fetch (skipped when --facts is set).`);
    process.exit(options.help ? 0 : 1);
  }
  const ticker = String(options.ticker).toUpperCase();
  if (!isUsTicker(ticker)) {
    throw new Error(`HK and non-US tickers are out of scope: ${ticker}`);
  }
  const { file, statements } = readStatements(options.root, ticker);
  const cik = resolveCik(statements);
  if (!cik) throw new Error(`No valid CIK found in statements for ${ticker}`);

  const { companyfacts, retrievedAt, source } = await loadFacts(options, cik);
  const findings = inspectStatements(statements, companyfacts, {
    toleranceRatio: options.toleranceRatio,
    toleranceAbs: options.toleranceAbs,
    fields: ['revenue', 'netIncome', 'operatingCashFlow', 'weightedAverageShsOutDil', 'freeCashFlow']
  });
  const summary = summarizeFindings(findings);
  const actionable = findings.filter(item => item.action === 'overwrite');

  let applied = [];
  let qualityWarnings = statements.qualityWarnings || [];
  if (options.write && actionable.length) {
    const result = applyOverwrites(statements, findings, {
      cik, retrievedAt, language: 'zh', mode: 'overwrite'
    });
    fs.writeFileSync(file, `${JSON.stringify(result.statements, null, 2)}\n`);
    applied = result.applied;
    qualityWarnings = result.qualityWarnings;
  }

  const report = {
    ticker,
    cik,
    statementsFile: path.relative(options.root, file),
    source,
    retrievedAt,
    write: options.write,
    summary,
    actionableCount: actionable.length,
    appliedCount: applied.length,
    actionable,
    qualityWarningCodes: (qualityWarnings || []).map(row => row.code).filter(Boolean)
  };
  console.log(JSON.stringify(report, null, 2));
  if (options.write && actionable.length) {
    console.error(`Wrote ${applied.length} EDGAR overwrites into ${file}`);
  } else if (!options.write && actionable.length) {
    console.error(`Dry-run: ${actionable.length} field(s) would be overwritten. Re-run with --write to apply.`);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
