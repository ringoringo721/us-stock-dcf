const fs = require('node:fs');
const path = require('node:path');
const Scenario = require('../fmp_scenario.js');
const Models = require('../fmp_models.js');
const Currency = require('../usd_currency.js');

function exportCalculations(ticker = null) {
  const root = path.resolve(__dirname, '..');
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file)));
  const market = { ...read('full_market_dcf.json'), ...read('hk_market_dcf.json') };
  if (ticker && !Object.hasOwn(market, ticker)) throw new Error('UNKNOWN_TICKER');
  const packets = [], unavailable = [];
  for (const [symbol, item] of Object.entries(market)) {
    if (ticker && symbol !== ticker || item.fin_valuation?.is_financial) continue;
    const stock = { ...item, ticker: symbol };
    const data = read(path.join('cache', 'company', `${symbol}.json`));
    const raw = read(path.join('cache', 'financials', `${symbol}_statements_v2.json`));
    const currency = raw.calculationCurrency || 'USD';
    const statements = Currency.convertStatements(raw, read(path.join('cache', 'fx', `${currency.toLowerCase()}_rates.json`)));
    for (const kind of ['advanced', 'customLevered']) {
      if (data.models[kind].reason) {
        unavailable.push({ symbol, kind, reason: data.models[kind].reason });
        continue;
      }
      const scenario = Scenario.defaults(data, kind, Models.issuedShares(stock));
      packets.push(Models.auditPacket({ data, kind, stock, scenario, statements }));
    }
  }
  if (ticker && !packets.length) throw new Error('NO_SUPPORTED_FMP_SCENARIOS');
  return { version: 1, generatedAt: new Date().toISOString(), packets, unavailable };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let output, ticker;
  while (args.length) {
    const key = args.shift(), value = args.shift();
    if (!value || !['--output', '--ticker'].includes(key)) throw new Error('Usage: node scripts\\export_fmp_calculations.cjs --output FILE [--ticker SYMBOL]');
    if (key === '--output') output = value;
    else ticker = value;
  }
  if (!output) throw new Error('An explicit --output path is required');
  const report = exportCalculations(ticker);
  fs.writeFileSync(path.resolve(output), JSON.stringify(report, null, 2) + '\n');
  console.log(`Exported ${report.packets.length} full-precision scenarios; ${report.unavailable.length} unsupported pairs remain unavailable.`);
}
module.exports = { exportCalculations };
