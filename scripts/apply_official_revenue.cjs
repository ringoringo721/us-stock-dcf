const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { compileStock } = require('./build_hkex.cjs');
const Scenario = require('../fmp_scenario.js');
const { buildAnalystSources } = require('./analyst_sources.cjs');
const { reviewedSource } = require('./official_revenue.cjs');

function apply(sourceDirectory, symbols = ['0027.HK', ...Object.keys(require('../cache/hkex_gaming_revenue_sources.json').stocks)]) {
  const root = path.resolve(__dirname, '..');
  const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  const write = (name, data, prefix = '') => fs.writeFileSync(path.join(root, name), prefix + JSON.stringify(data) + (prefix ? ';' : '') + '\n');
  const config = read('hkex_stocks.json');
  if (!symbols.length || new Set(symbols).size !== symbols.length
      || symbols.some(symbol => !reviewedSource(symbol) || !config.some(item => item.ticker === symbol))) {
    throw new Error('Requested issuer is not configured with reviewed official revenue evidence');
  }
  const market = read('hk_market_dcf.json');
  const rates = read(path.join('cache', 'fx', 'hkd_rates.json'));
  const reports = read(path.join('cache', 'hkex_moat.json'));
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'hk_fcff_data.js'), 'utf8'), context);
  const fcff = context.window.HK_FCFF_DATA;
  const treasuryFile = path.join(sourceDirectory, 'treasury.json');
  const capturedTreasury = fs.existsSync(treasuryFile) ? JSON.parse(fs.readFileSync(treasuryFile, 'utf8')) : null;
  const writes = [], summaries = [];
  for (const symbol of symbols) {
    const evidence = JSON.parse(fs.readFileSync(path.join(sourceDirectory, `${symbol}.json`), 'utf8'));
    const previous = market[symbol], item = config.find(item => item.ticker === symbol);
    const treasury = previous?.rateSource?.date && Number.isFinite(previous.rateSource.year10)
      ? { ok: true, rows: [{
        date: previous.rateSource.date,
        ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
          const year = index + 1;
          const value = previous.rateSource[`year${year}`];
          return Number.isFinite(value) ? [`year${year}`, value] : null;
        }).filter(Boolean))
      }] } : capturedTreasury;
    const result = compileStock(item, evidence, rates, reports, previous, treasury);
    const companyFile = path.join('cache', 'company', `${symbol}.json`);
    const company = fs.existsSync(path.join(root, companyFile)) ? read(companyFile) : null;
    if (company) {
      const modelsBefore = JSON.stringify(company.models);
      company.forecastBase = Scenario.baseSource(company, result.statements);
      Object.assign(company, buildAnalystSources(company, result.statements, evidence.responses.estimates, evidence.capturedAt));
      company.revenueProvenance = result.statements.revenueProvenance;
      if (JSON.stringify(company.models) !== modelsBefore) throw new Error('Native models must not change');
      writes.push([companyFile, company]);
    }
    market[symbol] = result.stock;
    const previousStatus = fcff.stocks[symbol]
      ? fcff.stocks[symbol].reason || 'operatingInputsAvailable' : null;
    const currentStatus = result.snapshot.reason || 'operatingInputsAvailable';
    if (!item.financial) fcff.stocks[symbol] = result.snapshot;
    if (previousStatus !== currentStatus) {
      if (previousStatus) {
        if (!(fcff.outcomes[previousStatus] > 0)) throw new Error('Snapshot outcome metadata is inconsistent');
        if (--fcff.outcomes[previousStatus] === 0) delete fcff.outcomes[previousStatus];
      }
      fcff.outcomes[currentStatus] = (fcff.outcomes[currentStatus] || 0) + 1;
    }
    if (!fcff.betaSources[symbol]) fcff.betaSources[symbol] = {
      value: result.stock.beta, source: 'FMP profile beta', lookback: null,
      frequency: null, benchmark: null, capturedAt: evidence.capturedAt
    };
    writes.push([path.join('cache', 'financials', `${symbol}_statements_v2.json`), result.statements],
      [path.join('cache', 'price_charts', `${symbol}.json`), result.chart]);
    summaries.push({ symbol, revenue: company?.forecastBase?.revenue ?? null,
      analystYears: company?.analystEstimates?.rows?.map(row => row.date) || [],
      analystReason: company?.analystEstimates?.reason || null,
      modelReason: company?.forecastBase?.reason || (company ? null : 'companyCaptureRequired'),
      nativeModels: company ? 'unchanged' : 'notCaptured' });
  }
  for (const [file, data] of writes) write(file, data);
  write('hk_market_dcf.json', market);
  write('hk_market_data.js', market, 'window.HK_MARKET_DATA = ');
  write('hk_fcff_data.js', fcff, 'window.HK_FCFF_DATA = ');
  console.log(JSON.stringify(summaries, null, 2));
}
if (require.main === module) {
  if (![3, 4].includes(process.argv.length)) throw new Error('Usage: node scripts\\apply_official_revenue.cjs CAPTURE_DIRECTORY [SYMBOLS]');
  apply(path.resolve(process.argv[2]), process.argv[3]?.split(','));
}
module.exports = { apply };
