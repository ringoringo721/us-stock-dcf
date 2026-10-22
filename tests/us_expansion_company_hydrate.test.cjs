const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { createHandler } = require('../api/fmp.js');

const root = path.resolve(__dirname, '..');
const fergStatements = JSON.parse(
  fs.readFileSync(path.join(root, 'cache', 'financials', 'FERG_statements_v2.json'), 'utf8'));

function advancedRows(symbol) {
  const income = fergStatements.annual.income
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const historical = income.map(row => ({
    year: Number(row.fiscalYear || row.calendarYear),
    symbol,
    revenue: row.revenue,
    ebitda: row.ebitda,
    ebit: row.operatingIncome ?? row.ebitda,
    depreciation: row.depreciationAndAmortization || 0,
    revenuePercentage: 0,
    ebitdaPercentage: row.revenue ? row.ebitda / row.revenue : 0,
    ebitPercentage: 0,
    depreciationPercentage: 0,
    capitalExpenditure: 0,
    capitalExpenditurePercentage: -0.02,
    operatingCashFlowPercentage: 0.1,
    netDebt: 1e9,
    equityValue: 2e10,
    enterpriseValue: 2.1e10,
    wacc: 9,
    longTermGrowthRate: 2.5,
    dilutedSharesOutstanding: 2e8,
    beta: 1.1,
    riskFreeRate: 4,
    marketRiskPremium: 5,
    costofDebt: 5,
    costOfEquity: 9.5,
    taxRate: 0.25,
    debtWeighting: 0.2
  }));
  const baseYear = historical.at(-1).year;
  const projected = Array.from({ length: 10 }, (_, index) => ({
    ...historical.at(-1),
    year: baseYear + index + 1,
    revenue: historical.at(-1).revenue * (1.05 ** (index + 1)),
    revenuePercentage: 5
  }));
  return [...historical, ...projected];
}

test('analyst-estimates proxy accepts annual limit queries and rejects invalid ones', async () => {
  const handler = createHandler({
    apiKey: () => 'test-placeholder',
    fetch: async url => {
      assert.equal(url.pathname, '/stable/analyst-estimates');
      assert.equal(url.searchParams.get('symbol'), 'FERG');
      assert.equal(url.searchParams.get('period'), 'annual');
      assert.equal(url.searchParams.get('limit'), '12');
      return { ok: true, json: async () => [{ symbol: 'FERG', date: '2027-06-30', revenueAvg: 9e9 }] };
    }
  });
  const call = async url => {
    const res = {
      statusCode: 200, setHeader() {},
      end(body) { this.body = JSON.parse(body); }
    };
    await handler({ method: 'GET', url }, res);
    return res;
  };
  const ok = await call('/api/fmp?action=analyst-estimates&symbol=FERG&period=annual&limit=12');
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.data[0].symbol, 'FERG');
  const bad = await call('/api/fmp?action=analyst-estimates&symbol=FERG&period=quarter&limit=12');
  assert.equal(bad.statusCode, 400);
});

test('CompanyData hydrates US expansion packs from statements + FMP proxy when company cache 404s', async () => {
  const rows = advancedRows('FERG');
  // Browser-shaped root: no CommonJS module, so hydrate uses root.FmpCache / FmpScenario.
  const sandbox = {
    console, URL, URLSearchParams, Map, Set, Promise, Object, Array, Number, String, Date, Math, JSON,
    Error, TypeError,
    US_EXPANSION: { stocks: { FERG: { ticker: 'FERG', calculationCurrency: 'USD' } } },
    US_LISTINGS: { stocks: [{ ticker: 'FERG' }] },
    FMP_MODEL_DATA: { version: 1, stocks: {} },
    fetch: async url => {
      if (String(url).includes('cache/company/FERG.json')) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      if (String(url).includes('cache/financials/FERG_statements_v2.json')) {
        return { ok: true, status: 200, json: async () => fergStatements };
      }
      throw new Error(`Unexpected fetch ${url}`);
    },
    FmpCache: {
      request: async query => {
        const action = query.get('action');
        if (action === 'custom-dcf' || action === 'custom-levered-dcf') {
          return { data: rows, source: { symbol: 'FERG', endpoint: action, capturedAt: '2026-10-22T00:00:00Z' } };
        }
        if (action === 'dcf' || action === 'levered-dcf') {
          return {
            data: [{ symbol: 'FERG', date: '2026-10-22', dcf: 90, 'Stock Price': 80 }],
            source: { symbol: 'FERG', endpoint: action, capturedAt: '2026-10-22T00:00:00Z' }
          };
        }
        if (action === 'analyst-estimates') {
          return {
            data: [{
              symbol: 'FERG', date: '2027-06-30', revenueAvg: 9.2e9, ebitdaAvg: 1.2e9,
              ebitAvg: 1e9, netIncomeAvg: 7e8, epsAvg: 3.5, operatingCashFlowAvg: 1.1e9,
              capitalExpenditureAvg: -2e8, depreciationAndAmortizationAvg: 2e8,
              numAnalystsRevenue: 8, numAnalystsEps: 8
            }],
            source: { symbol: 'FERG', endpoint: 'analyst-estimates', capturedAt: '2026-10-22T00:00:00Z' }
          };
        }
        throw new Error(`Unexpected FMP action ${action}`);
      }
    },
    FmpScenario: require('../fmp_scenario.js')
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    `${fs.readFileSync(path.join(root, 'company_data.js'), 'utf8')}\nthis.api = this.CompanyData;`,
    sandbox);
  const data = await sandbox.api.load('FERG');
  assert.equal(data.symbol, 'FERG');
  assert.equal(data.hydratedFrom, 'fmp-proxy+statements_v2');
  assert.ok(data.models.advanced.data.length >= 10);
  assert.equal(data.currencyCheck.reason, null);
  assert.equal(data.forecastBase.reason, null);
  assert.ok(Number.isInteger(data.forecastBase.year));
  assert.equal(sandbox.FMP_MODEL_DATA.stocks.FERG.symbol, 'FERG');
});

test('capture_company_data accepts US expansion CAPTURE_MARKET_FILE identities', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'us-capture-market-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const marketFile = path.join(directory, 'market.json');
  // Intentionally omit stock.ticker the way build_full_market historically does.
  fs.writeFileSync(marketFile, JSON.stringify({
    FERG: { name: 'Ferguson', calculationCurrency: 'USD', fin_valuation: { is_financial: false } }
  }));
  const mock = path.join(directory, 'mock.cjs');
  fs.writeFileSync(mock, `
    process.loadEnvFile = () => {};
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
  `);
  const result = spawnSync(process.execPath, [
    '--require', mock, path.join(root, 'scripts', 'capture_company_data.cjs'), 'FERG',
    path.join(directory, 'fmp_model_data.js')
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FMP_API_KEY: 'fixture-only-key', CAPTURE_MARKET_FILE: marketFile }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /FERG:/);
});
