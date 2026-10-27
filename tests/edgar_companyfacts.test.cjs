'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isUsTicker,
  normalizeCik,
  resolveCik,
  companyfactsUrl,
  requireUserAgent,
  inspectStatements,
  applyOverwrites,
  summarizeFindings,
  deriveFreeCashFlow,
  differs,
  matchFact,
  pickConceptValue,
  durationDays
} = require('../scripts/edgar_companyfacts.cjs');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'aapl_companyfacts_sample.json'), 'utf8'));
const periodFixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'aapl_companyfacts_period_alignment.json'), 'utf8'));

const sampleStatements = {
  annual: {
    income: [{
      date: '2025-09-27', symbol: 'AAPL', cik: '0000320193', fiscalYear: '2025', period: 'FY',
      revenue: 416161000000, netIncome: 112010000000, weightedAverageShsOutDil: 15004697000
    }, {
      date: '2024-09-28', symbol: 'AAPL', cik: '0000320193', fiscalYear: '2024', period: 'FY',
      revenue: 391035000000, netIncome: 93736000000, weightedAverageShsOutDil: 15108780000
    }],
    cashflow: [{
      date: '2025-09-27', symbol: 'AAPL', cik: '0000320193', fiscalYear: '2025', period: 'FY',
      operatingCashFlow: 111482000000, capitalExpenditure: -12715000000, freeCashFlow: 98767000000
    }]
  },
  quarterly: { income: [], balance: [], cashflow: [] }
};

test('US gate and CIK helpers reject HK and zero CIKs', () => {
  assert.equal(isUsTicker('AAPL'), true);
  assert.equal(isUsTicker('0700.HK'), false);
  assert.equal(normalizeCik('320193'), '0000320193');
  assert.equal(normalizeCik('0000000000'), null);
  assert.equal(resolveCik(sampleStatements), '0000320193');
  assert.equal(companyfactsUrl('320193'), 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json');
  assert.throws(() => requireUserAgent('Mozilla/5.0'), /SEC_USER_AGENT/);
  assert.equal(requireUserAgent('Example Research contact@example.com'), 'Example Research contact@example.com');
});

test('FCF derivation and mismatch tolerance', () => {
  assert.equal(deriveFreeCashFlow(100, -20), 80);
  assert.equal(deriveFreeCashFlow(100, 20), 80);
  assert.equal(deriveFreeCashFlow(100, null), null);
  assert.equal(differs(100, 101, { toleranceRatio: 0.02, toleranceAbs: 0 }), false);
  assert.equal(differs(100, 110, { toleranceRatio: 0.02, toleranceAbs: 0 }), true);
});

test('quarter matching prefers ~90-day facts and rejects YTD/cumulative on same end/fp', () => {
  const revenueUnits = periodFixture.facts['us-gaap']
    .RevenueFromContractWithCustomerExcludingAssessedTax.units.USD;
  const q3Row = {
    date: '2026-06-27', fiscalYear: '2026', period: 'Q3',
    revenue: 109417000000, netIncome: 29789000000
  };
  const matched = matchFact(revenueUnits, q3Row);
  assert.equal(matched.val, 109417000000);
  assert.equal(durationDays(matched), 90);
  assert.notEqual(matched.val, 364357000000);

  const picked = pickConceptValue(periodFixture, 'revenue', q3Row);
  assert.equal(picked.value, 109417000000);
  assert.equal(picked.days, 90);

  // FMP Q4 at FY end must not bind the annual/YTD cumulative fact
  const q4Row = { date: '2025-09-27', fiscalYear: '2025', period: 'Q4', revenue: 102466000000 };
  const q4Pick = pickConceptValue(periodFixture, 'revenue', q4Row);
  assert.equal(q4Pick.missing, true);
  assert.equal(q4Pick.periodUnmatched, true);

  const statements = {
    annual: {
      income: [{
        date: '2025-09-27', fiscalYear: '2025', period: 'FY',
        revenue: 416161000000, netIncome: 112010000000
      }],
      cashflow: [{
        date: '2025-09-27', fiscalYear: '2025', period: 'FY',
        operatingCashFlow: 111482000000, capitalExpenditure: -12715000000, freeCashFlow: 98767000000
      }]
    },
    quarterly: {
      income: [
        q3Row,
        { date: '2026-03-28', fiscalYear: '2026', period: 'Q2', revenue: 111184000000, netIncome: 29578000000 },
        q4Row
      ],
      cashflow: [{
        date: '2026-06-27', fiscalYear: '2026', period: 'Q3',
        operatingCashFlow: 34369000000, capitalExpenditure: -2455000000, freeCashFlow: 31914000000
      }]
    }
  };
  const findings = inspectStatements(statements, periodFixture, {
    fields: ['revenue', 'netIncome', 'operatingCashFlow', 'freeCashFlow']
  });
  const q3Rev = findings.find(row => row.field === 'revenue' && row.date === '2026-06-27');
  const q3Ni = findings.find(row => row.field === 'netIncome' && row.date === '2026-06-27');
  const q2Rev = findings.find(row => row.field === 'revenue' && row.date === '2026-03-28');
  const q4Rev = findings.find(row => row.field === 'revenue' && row.date === '2025-09-27' && row.frequency === 'quarterly');
  const q3Ocf = findings.find(row => row.field === 'operatingCashFlow' && row.date === '2026-06-27');
  const fyRev = findings.find(row => row.field === 'revenue' && row.date === '2025-09-27' && row.frequency === 'annual');

  assert.equal(q3Rev.trigger, 'agree');
  assert.equal(q3Rev.edgarValue, 109417000000);
  assert.equal(q3Ni.trigger, 'agree');
  assert.equal(q2Rev.trigger, 'agree');
  assert.equal(q2Rev.edgarValue, 111184000000);
  assert.equal(q4Rev.trigger, 'periodUnmatched');
  assert.equal(q4Rev.action, 'none');
  assert.equal(q3Ocf.trigger, 'periodUnmatched'); // only YTD OCF present in fixture
  assert.equal(fyRev.trigger, 'agree');
  assert.equal(summarizeFindings(findings).overwrite, 0);
});

test('inspect agrees on FY2025 and flags FY2024 revenue mismatch from fixture', () => {
  const findings = inspectStatements(sampleStatements, fixture, {
    fields: ['revenue', 'netIncome', 'operatingCashFlow', 'weightedAverageShsOutDil', 'freeCashFlow'],
    toleranceRatio: 0.02,
    toleranceAbs: 1e6
  });
  const fy25Rev = findings.find(row => row.field === 'revenue' && row.date === '2025-09-27');
  const fy24Rev = findings.find(row => row.field === 'revenue' && row.date === '2024-09-28');
  const fy25Fcf = findings.find(row => row.field === 'freeCashFlow' && row.date === '2025-09-27');
  assert.equal(fy25Rev.trigger, 'agree');
  assert.equal(fy24Rev.trigger, 'fmpEdgarMismatch');
  assert.equal(fy24Rev.action, 'overwrite');
  assert.equal(fy25Fcf.trigger, 'agree');
  const summary = summarizeFindings(findings);
  assert.ok(summary.overwrite >= 1);
});

test('applyOverwrites writes EDGAR values and Traditional Chinese qualityWarnings without inventing', () => {
  const findings = inspectStatements(sampleStatements, fixture, {
    fields: ['revenue', 'netIncome', 'operatingCashFlow', 'weightedAverageShsOutDil', 'freeCashFlow']
  });
  const { statements, applied, qualityWarnings } = applyOverwrites(sampleStatements, findings, {
    cik: '0000320193', language: 'zh'
  });
  assert.ok(applied.length >= 1);
  const fy24 = statements.annual.income.find(row => row.date === '2024-09-28');
  assert.equal(fy24.revenue, findings.find(row => row.date === '2024-09-28' && row.field === 'revenue').edgarValue);
  assert.ok(fy24.edgarCorrection.revenue);
  assert.ok(qualityWarnings.some(row => row.code === 'edgarCompanyfactsOverwrite'
    && /SEC EDGAR companyfacts/.test(row.message)));
  // Missing EDGAR concept must not invent a number
  const sparse = {
    annual: {
      income: [{ date: '2020-01-01', fiscalYear: '2020', period: 'FY', revenue: null, netIncome: null }],
      cashflow: []
    },
    quarterly: { income: [], balance: [], cashflow: [] }
  };
  const emptyFindings = inspectStatements(sparse, { facts: { 'us-gaap': {} } }, {
    fields: ['revenue', 'netIncome']
  });
  assert.ok(emptyFindings.every(row => row.action === 'none' && row.edgarValue == null));
  const untouched = applyOverwrites(sparse, emptyFindings);
  assert.equal(untouched.applied.length, 0);
  assert.equal(untouched.statements.annual.income[0].revenue, null);
});

test('verify CLI annotate/dry-run with fixture does not write', () => {
  const { spawnSync } = require('node:child_process');
  const root = path.join(__dirname, '..');
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'verify_us_statements_edgar.cjs'),
    '--ticker', 'AAPL',
    '--facts', path.join(root, 'tests', 'fixtures', 'aapl_companyfacts_sample.json')
  ], { encoding: 'utf8', cwd: root, env: { ...process.env, EDGAR_ALLOW_WRITE: '' } });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ticker, 'AAPL');
  assert.equal(report.write, false);
  assert.equal(report.mode, 'annotate');
  assert.ok(report.summary.total > 0);
});

test('--write is blocked without EDGAR_ALLOW_WRITE=1 under annotate-only policy', () => {
  const { spawnSync } = require('node:child_process');
  const root = path.join(__dirname, '..');
  const blocked = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'verify_us_statements_edgar.cjs'),
    '--ticker', 'AAPL',
    '--write',
    '--facts', path.join(root, 'tests', 'fixtures', 'aapl_companyfacts_sample.json')
  ], { encoding: 'utf8', cwd: root, env: { ...process.env, EDGAR_ALLOW_WRITE: '' } });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /EDGAR_ALLOW_WRITE/);
});

test('batch annotate writes report artifacts without mutating statements', () => {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const root = path.join(__dirname, '..');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'edgar-annotate-'));
  const before = fs.readFileSync(path.join(root, 'cache', 'financials', 'AAPL_statements_v2.json'), 'utf8');
  const result = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'verify_us_statements_edgar.cjs'),
    '--tickers', 'AAPL',
    '--facts', path.join(root, 'tests', 'fixtures', 'aapl_companyfacts_sample.json'),
    '--out', out
  ], { encoding: 'utf8', cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'cache', 'financials', 'AAPL_statements_v2.json'), 'utf8'), before);
  const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.mode, 'annotate');
  assert.equal(summary.write, false);
  assert.ok(fs.existsSync(path.join(out, 'AAPL.json')));
});
