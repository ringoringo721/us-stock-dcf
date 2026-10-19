const fs = require('node:fs');
const path = require('node:path');
const { buildAnalystSources } = require('./analyst_sources.cjs');

function importSources(directories, root = path.resolve(__dirname, '..')) {
  if (!directories.length) throw new Error('Provide at least one existing valuation-source capture directory');
  for (const directory of directories) {
    if (!fs.statSync(directory).isDirectory()) throw new Error('Source path must be a directory');
  }
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const market = { ...read(path.join(root, 'full_market_dcf.json')), ...read(path.join(root, 'hk_market_dcf.json')) };
  const summary = { updated: 0, available: 0, unavailable: {} };
  for (const symbol of Object.keys(market)) {
    if (market[symbol].fin_valuation?.is_financial) continue;
    const target = path.join(root, 'cache', 'company', `${symbol}.json`);
    const data = read(target);
    const captures = directories.flatMap(directory => {
      const file = path.join(directory, `${symbol}.json`);
      return fs.existsSync(file) ? [read(file)] : [];
    }).sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
    const capture = captures[0];
    if (data.symbol !== symbol || capture && capture.ticker !== symbol) throw new Error('Analyst capture security mismatch');
    const statements = read(path.join(root, 'cache', 'financials', `${symbol}_statements_v2.json`));
    const sources = buildAnalystSources(data, statements,
      capture?.responses?.estimates || { reason: 'ANALYST_CAPTURE_UNAVAILABLE' },
      capture?.capturedAt || data.capturedAt);
    if (sources.analystEstimates.reason) {
      const code = sources.analystEstimates.reason;
      summary.unavailable[code] = (summary.unavailable[code] || 0) + 1;
    } else summary.available++;
    const updated = { ...data, ...sources };
    if (JSON.stringify(data) !== JSON.stringify(updated)) {
      fs.writeFileSync(target, JSON.stringify(updated) + '\n');
      summary.updated++;
    }
  }
  return summary;
}

if (require.main === module) console.log(JSON.stringify(importSources(process.argv.slice(2)), null, 2));
module.exports = { importSources };
