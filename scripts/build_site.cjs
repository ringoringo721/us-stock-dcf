const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const assets = [
  'index.html', 'site_theme.js', 'market_context.js', 'market_data.js', 'fcff_data.js',
  'hk_market_data.js', 'hk_fcff_data.js', 'dcf_drivers.js', 'fcff.js', 'fcff_view.js',
  'usd_currency.js', 'liquidation.js', 'peer_comparison.js', 'fcf_ratios.js',
  'balance_sheet.js', 'earnings_trend.js', 'profile_overview.js', 'price_history.js',
  'full_market_dcf.json', 'hk_market_dcf.json',
];

function buildSite(output = path.join(root, 'public')) {
  const destination = path.resolve(output);
  if (destination === root || !path.relative(root, destination)) {
    throw new Error('Static output must not replace the repository root');
  }
  const files = [...assets];
  for (const directory of ['financials', 'price_charts']) {
    for (const filename of fs.readdirSync(path.join(root, 'cache', directory))) {
      const pattern = directory === 'financials'
        ? /^[A-Z0-9.-]+_statements_v2\.json$/ : /^[A-Z0-9.-]+\.json$/;
      if (pattern.test(filename)) files.push(path.join('cache', directory, filename));
    }
  }
  for (const filename of ['usd_rates.json', 'hkd_rates.json']) {
    files.push(path.join('cache', 'fx', filename));
  }
  for (const filename of files) {
    const target = path.join(destination, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, filename), target);
  }
  return files;
}

if (require.main === module) {
  console.log(`Published ${buildSite(process.argv[2]).length} allowlisted static assets.`);
}
module.exports = { buildSite, assets };
