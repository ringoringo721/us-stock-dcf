const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { annualRoteHistory } = require('../fcf_ratios.js');
const { convertStatements } = require('../usd_currency.js');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'cache', 'rote_history');
const method = 'reportedNetIncomeOverBeginningTangibleEquity';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function loadWindowExport(filename, key) {
  const target = path.join(root, filename);
  if (!fs.existsSync(target)) return {};
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(target, 'utf8'), context);
  return context.window[key]?.stocks || {};
}

function financialMarkets() {
  return {
    ...require('../full_market_dcf.json'),
    ...require('../hk_market_dcf.json'),
    ...loadWindowExport('us_expansion_data.js', 'US_EXPANSION'),
    ...loadWindowExport('hkex_expansion_data.js', 'HKEX_EXPANSION'),
  };
}

function merge(existing, additional) {
  const rows = new Map(additional.map(row => [row.date, row]));
  for (const row of existing) rows.set(row.date, row);
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function writeHistory(symbol, existing, rates, basisHash, annual, source) {
  const data = {
    calculationCurrency: existing.calculationCurrency || 'USD',
    annual,
    quarterly: { income: [], balance: [], cashflow: [] },
  };
  const years = annualRoteHistory(convertStatements(data, rates));
  const result = {
    version: 1,
    symbol,
    capturedAt: new Date().toISOString(),
    method,
    source: {
      ...source,
      existingStatementsHash: basisHash,
      existingStatementsHashBasis: 'annual income/balance statements plus calculation currency',
      fxSnapshotHash: hash(rates),
    },
    calculationCurrency: data.calculationCurrency,
    years,
    annual: data.annual,
  };
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${symbol}.json`), JSON.stringify(result) + '\n');
  console.log(`${symbol}: saved ${years.filter(row => row.value !== null).length}/10 annual ROTE values`);
  return result;
}

async function capture(symbol, refresh, { allowExistingOnly = false } = {}) {
  const target = path.join(directory, `${symbol}.json`);
  const existing = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'financials', `${symbol}_statements_v2.json`)));
  const rates = require(existing.calculationCurrency === 'HKD' ? '../cache/fx/hkd_rates.json' : '../cache/fx/usd_rates.json');
  const basisHash = hash({
    annual: { income: existing.annual.income, balance: existing.annual.balance },
    currency: existing.calculationCurrency || 'USD',
  });
  if (!refresh && fs.existsSync(target)) {
    const saved = JSON.parse(fs.readFileSync(target));
    if (saved.version === 1 && saved.method === method && saved.source.existingStatementsHash === basisHash) {
      if (saved.source.fxSnapshotHash !== hash(rates)) {
        saved.years = annualRoteHistory(convertStatements({
          calculationCurrency: saved.calculationCurrency,
          annual: saved.annual,
          quarterly: { income: [], balance: [], cashflow: [] },
        }, rates));
        saved.source.fxSnapshotHash = hash(rates);
        saved.calculatedAt = new Date().toISOString();
        fs.writeFileSync(target, JSON.stringify(saved) + '\n');
      }
      console.log(`${symbol}: reused saved ROTE history`);
      return;
    }
  }
  if (!process.env.FMP_API_KEY) {
    if (!allowExistingOnly && !process.argv.includes('--existing-only')) {
      throw new Error('FMP_API_KEY is required for uncached history (pass --existing-only to seed from saved statements)');
    }
    return writeHistory(symbol, existing, rates, basisHash, {
      income: [...existing.annual.income].sort((a, b) => a.date.localeCompare(b.date)),
      balance: [...existing.annual.balance].sort((a, b) => a.date.localeCompare(b.date)),
      cashflow: [],
    }, {
      provider: 'existing annual statements only; FMP history not requested',
      endpoints: [],
      limit: null,
      incomeResponseHash: null,
      balanceResponseHash: null,
    });
  }
  async function request(endpoint, limit) {
    const url = new URL(`https://financialmodelingprep.com/stable/${endpoint}`);
    for (const [key, value] of Object.entries({ symbol, period: 'annual', limit, apikey: process.env.FMP_API_KEY })) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(45000), redirect: 'error' });
    if (!response.ok) throw new Error(`${symbol}: FMP_${endpoint}_HTTP_${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.some(row => row?.symbol !== symbol || row.period !== 'FY'
        || !/^\d{4}-\d{2}-\d{2}$/.test(row.date))) throw new Error(`${symbol}: FMP_INVALID_ANNUAL_HISTORY`);
    return rows;
  }
  const [income, balance] = await Promise.all([
    request('income-statement', 11), request('balance-sheet-statement', 11),
  ]);
  return writeHistory(symbol, existing, rates, basisHash, {
    income: merge(existing.annual.income, income),
    balance: merge(existing.annual.balance, balance),
    cashflow: [],
  }, {
    provider: 'FMP annual statements; existing official-source overrides retained',
    endpoints: ['income-statement', 'balance-sheet-statement'],
    limit: 11,
    incomeResponseHash: hash(income),
    balanceResponseHash: hash(balance),
  });
}

async function main() {
  const env = path.join(root, '.env.local');
  if (fs.existsSync(env)) process.loadEnvFile(env);
  const markets = financialMarkets();
  const symbols = Object.keys(markets).filter(symbol => markets[symbol].fin_valuation?.is_financial === true);
  const requested = process.argv.find(arg => arg.startsWith('--symbols='));
  const selected = requested ? requested.slice('--symbols='.length).split(',') : symbols;
  if (selected.some(symbol => !symbols.includes(symbol))) {
    throw new Error('History capture is limited to configured financial-model stocks');
  }
  const allowExistingOnly = process.argv.includes('--existing-only');
  const queue = [...selected];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) await capture(queue.shift(), process.argv.includes('--refresh'), { allowExistingOnly });
  }));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { merge, capture, financialMarkets };
