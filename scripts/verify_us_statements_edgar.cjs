#!/usr/bin/env node
'use strict';

/**
 * Annotate (default) US FMP statement caches against SEC EDGAR companyfacts.
 * Never invents numbers. HK tickers are rejected.
 *
 * Default policy (user decision A): annotate / dry-run report only.
 * `--write` overwrites statement field values only when EDGAR_ALLOW_WRITE=1
 * (not used by CI workflows).
 *
 * Usage:
 *   node scripts/verify_us_statements_edgar.cjs --ticker AAPL
 *   node scripts/verify_us_statements_edgar.cjs --tickers AAPL,MSFT --out edgar-annotate-output
 *   node scripts/verify_us_statements_edgar.cjs --from-cache --limit 20 --out edgar-annotate-output
 *   node scripts/verify_us_statements_edgar.cjs --ticker AAPL --facts path/to/fixture.json
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  isUsTicker,
  resolveCik,
  normalizeCik,
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
    tickers: null,
    fromCache: false,
    write: false,
    facts: null,
    out: null,
    limit: null,
    delayMs: 350,
    toleranceRatio: DEFAULT_TOLERANCE_RATIO,
    toleranceAbs: DEFAULT_TOLERANCE_ABS,
    root: path.resolve(__dirname, '..'),
    help: false
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') options.write = true;
    else if (arg === '--from-cache') options.fromCache = true;
    else if (arg === '--ticker') options.ticker = argv[++i];
    else if (arg === '--tickers') options.tickers = argv[++i];
    else if (arg === '--facts') options.facts = argv[++i];
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--limit') options.limit = Number(argv[++i]);
    else if (arg === '--delay-ms') options.delayMs = Number(argv[++i]);
    else if (arg === '--tolerance-ratio') options.toleranceRatio = Number(argv[++i]);
    else if (arg === '--tolerance-abs') options.toleranceAbs = Number(argv[++i]);
    else if (arg === '--root') options.root = path.resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function listUsTickersFromCache(root) {
  const dir = path.join(root, 'cache', 'financials');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('_statements_v2.json'))
    .map(name => name.replace(/_statements_v2\.json$/, ''))
    .filter(isUsTicker)
    .sort();
}

function resolveTickerList(options) {
  if (options.ticker) return [String(options.ticker).toUpperCase()];
  if (options.tickers) {
    return String(options.tickers).split(/[\s,]+/).map(value => value.trim().toUpperCase()).filter(Boolean);
  }
  if (options.fromCache) return listUsTickersFromCache(options.root);
  return [];
}

function readStatements(root, ticker) {
  const file = path.join(root, 'cache', 'financials', `${ticker}_statements_v2.json`);
  if (!fs.existsSync(file)) throw new Error(`Missing statements cache: ${file}`);
  return { file, statements: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function factsCachePath(root, cik) {
  return path.join(root, 'cache', 'edgar', 'companyfacts', `CIK${normalizeCik(cik)}.json`);
}

async function loadFacts(options, cik, memoryCache) {
  if (options.facts) {
    return {
      companyfacts: JSON.parse(fs.readFileSync(path.resolve(options.facts), 'utf8')),
      retrievedAt: new Date().toISOString(),
      source: `fixture:${options.facts}`
    };
  }
  if (memoryCache.has(cik)) return memoryCache.get(cik);

  const disk = factsCachePath(options.root, cik);
  if (fs.existsSync(disk)) {
    const companyfacts = JSON.parse(fs.readFileSync(disk, 'utf8'));
    const payload = {
      companyfacts,
      retrievedAt: fs.statSync(disk).mtime.toISOString(),
      source: `cache:${path.relative(options.root, disk)}`
    };
    memoryCache.set(cik, payload);
    return payload;
  }

  const companyfacts = await fetchCompanyfacts(cik);
  const payload = {
    companyfacts,
    retrievedAt: new Date().toISOString(),
    source: 'data.sec.gov/api/xbrl/companyfacts'
  };
  fs.mkdirSync(path.dirname(disk), { recursive: true });
  fs.writeFileSync(disk, `${JSON.stringify(companyfacts)}\n`);
  memoryCache.set(cik, payload);
  return payload;
}

function assertWriteAllowed(options) {
  if (!options.write) return;
  if (process.env.EDGAR_ALLOW_WRITE !== '1') {
    throw new Error(
      '--write is disabled under annotate-only policy. Set EDGAR_ALLOW_WRITE=1 only for intentional manual overwrites.'
    );
  }
}

async function annotateTicker(ticker, options, memoryCache) {
  if (!isUsTicker(ticker)) {
    return {
      ticker,
      ok: false,
      error: 'HK_OR_NON_US_OUT_OF_SCOPE'
    };
  }
  const { file, statements } = readStatements(options.root, ticker);
  const cik = resolveCik(statements);
  if (!cik) {
    return {
      ticker,
      ok: false,
      error: 'CIK_MISSING',
      statementsFile: path.relative(options.root, file)
    };
  }

  const { companyfacts, retrievedAt, source } = await loadFacts(options, cik, memoryCache);
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

  return {
    ticker,
    ok: true,
    cik,
    statementsFile: path.relative(options.root, file),
    source,
    retrievedAt,
    mode: options.write ? 'overwrite' : 'annotate',
    write: Boolean(options.write),
    summary,
    actionableCount: actionable.length,
    appliedCount: applied.length,
    actionable,
    findings,
    qualityWarningCodes: (qualityWarnings || []).map(row => row.code).filter(Boolean)
  };
}

function printUsage() {
  console.log(`Usage:
  node scripts/verify_us_statements_edgar.cjs --ticker TICKER [--facts fixture.json] [--out DIR]
  node scripts/verify_us_statements_edgar.cjs --tickers AAPL,MSFT --out DIR
  node scripts/verify_us_statements_edgar.cjs --from-cache [--limit N] --out DIR

Default: annotate / dry-run only (no statement field overwrite).
--write requires EDGAR_ALLOW_WRITE=1 (manual escape hatch; CI must not set this).
Live SEC fetch requires SEC_USER_AGENT (skipped when --facts is set).`);
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    printUsage();
    process.exit(0);
  }
  assertWriteAllowed(options);

  let tickers = resolveTickerList(options);
  if (!tickers.length) {
    printUsage();
    process.exit(1);
  }
  if (Number.isFinite(options.limit) && options.limit >= 0) {
    tickers = tickers.slice(0, options.limit);
  }

  const memoryCache = new Map();
  const reports = [];
  for (let index = 0; index < tickers.length; index += 1) {
    const ticker = tickers[index];
    try {
      const report = await annotateTicker(ticker, options, memoryCache);
      reports.push(report);
      if (!options.facts && report.ok && report.source === 'data.sec.gov/api/xbrl/companyfacts'
          && index < tickers.length - 1 && options.delayMs > 0) {
        await sleep(options.delayMs);
      }
    } catch (error) {
      reports.push({
        ticker,
        ok: false,
        error: error.message || String(error)
      });
      if (!options.facts && index < tickers.length - 1 && options.delayMs > 0) {
        await sleep(options.delayMs);
      }
    }
  }

  const summary = {
    mode: options.write ? 'overwrite' : 'annotate',
    write: Boolean(options.write),
    tickerCount: reports.length,
    okCount: reports.filter(row => row.ok).length,
    errorCount: reports.filter(row => !row.ok).length,
    actionableTickers: reports.filter(row => row.ok && row.actionableCount > 0).map(row => row.ticker),
    actionableFieldCount: reports.reduce((sum, row) => sum + (row.actionableCount || 0), 0),
    appliedFieldCount: reports.reduce((sum, row) => sum + (row.appliedCount || 0), 0),
    generatedAt: new Date().toISOString()
  };

  const payload = reports.length === 1 ? { ...reports[0], batch: summary } : { summary, reports };

  if (options.out) {
    const outDir = path.resolve(options.root, options.out);
    fs.mkdirSync(outDir, { recursive: true });
    for (const report of reports) {
      fs.writeFileSync(
        path.join(outDir, `${report.ticker || 'UNKNOWN'}.json`),
        `${JSON.stringify(report, null, 2)}\n`
      );
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  }

  console.log(JSON.stringify(payload, null, 2));
  if (options.write) {
    console.error(`Overwrite mode: applied ${summary.appliedFieldCount} field(s) across ${summary.okCount} ticker(s).`);
  } else {
    console.error(
      `Annotate-only: ${summary.actionableFieldCount} field(s) across ${summary.actionableTickers.length} ticker(s) would differ; statement caches unchanged.`
    );
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  main,
  resolveTickerList,
  listUsTickersFromCache,
  annotateTicker,
  assertWriteAllowed
};
