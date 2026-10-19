const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'scripts', 'capture_company_data.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'company-preservation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const companyDirectory = path.join(directory, 'cache', 'company');
  fs.mkdirSync(companyDirectory, { recursive: true });
  const models = { dcf: { data: [{ symbol: 'AAPL', year: '2025', dcf: 210 },
    { symbol: 'AAPL', year: '2024', dcf: 190 }], endpoint: 'discounted-cash-flow', reason: null } };
  const company = { symbol: 'AAPL', currency: 'USD', models,
    news: { data: [], reason: 'FMP_NO_COVERAGE' }, holders: { data: [], reason: 'FMP_NO_COVERAGE' } };
  const companyPath = path.join(companyDirectory, 'AAPL.json');
  fs.writeFileSync(companyPath, JSON.stringify(company) + '\n');
  const summary = { symbol: 'AAPL', currency: 'USD',
    models: { dcf: { ...models.dcf, data: [models.dcf.data[0]] } },
    forecastBase: { reason: 'unchanged-existing-evidence' } };
  const target = path.join(directory, 'fmp_model_data.js');
  fs.writeFileSync(target, `window.FMP_MODEL_DATA = ${JSON.stringify({ version: 1, stocks: { AAPL: summary } })};\n`);
  const mock = path.join(directory, 'mock.cjs');
  fs.writeFileSync(mock, `
process.loadEnvFile = () => {};
globalThis.fetch = async url => {
  const parsed = new URL(url);
  if (parsed.origin !== 'https://financialmodelingprep.com') throw new Error('Unexpected network request');
  const data = parsed.pathname.endsWith('/profile') ? [{ symbol: '0027.HK', currency: 'HKD' }] : [];
  return { ok: true, status: 200, json: async () => data };
};\n`);
  const run = arg => spawnSync(process.execPath, ['--require', mock, script, arg, target], {
    cwd: root, encoding: 'utf8', env: { ...process.env, FMP_API_KEY: arg === '--repack' ? '' : 'fixture-only-key' }
  });
  const read = () => {
    const context = { window: {} };
    vm.runInNewContext(fs.readFileSync(target, 'utf8'), context);
    return JSON.parse(JSON.stringify(context.window.FMP_MODEL_DATA));
  };
  return { company, companyPath, summary, target, run, read };
}

test('capturing a gaming issuer preserves unselected native model histories, cache bytes and summaries', t => {
  const data = fixture(t);
  const before = fs.readFileSync(data.companyPath, 'utf8');
  const result = data.run('0027.HK');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(data.companyPath, 'utf8'), before);
  assert.deepEqual(data.read().stocks.AAPL, data.summary);
  assert.equal(data.read().stocks['0027.HK'].symbol, '0027.HK');
});

test('offline repack reads full native company cache, never the truncated summary', t => {
  const data = fixture(t);
  const result = data.run('--repack');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(data.companyPath, 'utf8')).models, data.company.models);
  assert.equal(data.read().stocks.AAPL.models.dcf.data.length, 1);
  assert.equal(data.read().stocks.AAPL.models.dcf.data[0].year, '2025');
});

test('repack without full cache fails explicitly and leaves the summary asset unchanged', t => {
  const data = fixture(t);
  fs.unlinkSync(data.companyPath);
  const before = fs.readFileSync(data.target, 'utf8');
  const result = data.run('--repack');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Full company cache required for repack: AAPL/);
  assert.equal(fs.readFileSync(data.target, 'utf8'), before);
});
