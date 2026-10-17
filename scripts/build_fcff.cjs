const fs = require('node:fs');
const path = require('node:path');
const { prepareSnapshot } = require('./fcff_sources.cjs');
const { calculate } = require('../fcff.js');

function compile(market, records, treasury, rates, leases = {}) {
  const stocks = {}, outcomes = {}, betaSources = {};
  for (const [ticker, stock] of Object.entries(market)) {
    const profile = records[ticker]?.responses?.profile;
    const beta = profile?.ok && profile.rows?.length === 1
      && profile.rows[0].symbol === ticker.replace(/\./g, '-') ? profile.rows[0].beta : null;
    betaSources[ticker] = {
      value: typeof beta === 'number' && Number.isFinite(beta) ? beta : null,
      source: 'FMP profile beta', lookback: null, frequency: null, benchmark: null,
      capturedAt: records[ticker]?.capturedAt || null
    };
    if (stock.fin_valuation?.is_financial) continue;
    const snapshot = prepareSnapshot(ticker, records[ticker], treasury, rates, leases[ticker]);
    const result = calculate(snapshot);
    stocks[ticker] = snapshot;
    const status = result.reason || 'available';
    outcomes[status] = (outcomes[status] || 0) + 1;
  }
  return { version: 1, method: 'FCFF', stocks, betaSources, outcomes };
}

function readRecords(directory, tickers) {
  const records = {};
  for (const ticker of tickers) {
    const file = path.join(directory, `${ticker}.json`);
    if (!fs.existsSync(file)) throw new Error(`Missing source record: ${ticker}`);
    records[ticker] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return records;
}

function main() {
  const root = path.join(__dirname, '..');
  const input = path.resolve(process.argv[2] || path.join(root, 'valuation-audit-output'));
  const market = JSON.parse(fs.readFileSync(path.join(root, 'full_market_dcf.json'), 'utf8'));
  const records = readRecords(input, Object.keys(market));
  const leases = process.argv[3] ? readRecords(path.resolve(process.argv[3]), Object.keys(market)) : {};
  const treasury = JSON.parse(fs.readFileSync(path.join(input, 'treasury.json'), 'utf8'));
  const rates = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'fx', 'usd_rates.json'), 'utf8'));
  const data = compile(market, records, treasury, rates, leases);
  const text = JSON.stringify(data);
  fs.writeFileSync(path.join(root, 'cache', 'fcff_sources.json'), text + '\n');
  fs.writeFileSync(path.join(root, 'fcff_data.js'), `window.FCFF_DATA = ${text};\n`);
  console.log(`Compiled ${Object.keys(data.stocks).length} nonfinancial FCFF snapshots: ${JSON.stringify(data.outcomes)}`);
  console.log('Existing financial models, reported FCF trends and liquidation datasets were not changed.');
}

if (require.main === module) main();
module.exports = { compile };
