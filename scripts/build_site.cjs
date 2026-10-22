const fs = require('node:fs');
// Publishes cache/beta_benchmarks for on-demand OLS beta lookback previews.
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const assets = [
  'index.html', 'site_theme.js', 'market_context.js', 'market_data.js', 'fcff_data.js',
  'hk_market_data.js', 'hk_fcff_data.js', 'dcf_drivers.js', 'fcff.js', 'fcff_view.js',
  'usd_currency.js', 'liquidation.js', 'peer_comparison.js', 'fcf_ratios.js', 'financial_models.js',
  'ke_treasury_data.js',
  'balance_sheet.js', 'earnings_trend.js', 'profile_overview.js', 'technical_indicators.js', 'price_history.js', 'stock_search.js', 'company_data.js',
  'fmp_model_data.js', 'fmp_scenario.js', 'fmp_models.js', 'fmp_cache.js', 'beta_lookback.js',
  'hkex_universe.js', 'hkex_universe_data.js', 'hkex_expansion_data.js', 'cache/hkex_universe.json',
  'us_universe.js', 'us_universe_data.js', 'us_expansion_data.js', 'cache/us_universe.json',
  'full_market_dcf.json', 'hk_market_dcf.json',
  'cache/news_translations.json', 'cache/hsi_constituents.json',
  'cache/property_fv_sources.json', 'cache/property_fv_coverage.json', 'cache/property_fv_reviews.json',
];

function buildSite(output = path.join(root, 'public')) {
  const destination = path.resolve(output);
  if (destination === root || !path.relative(root, destination)) {
    throw new Error('Static output must not replace the repository root');
  }
  const files = [...assets];
  for (const directory of ['financials', 'price_charts', 'company', 'rote_history', 'hk_companies', 'us_companies', 'ke_history', 'beta_benchmarks']) {
    if (!fs.existsSync(path.join(root, 'cache', directory))) continue;
    for (const filename of fs.readdirSync(path.join(root, 'cache', directory))) {
      const pattern = directory === 'financials'
        ? /^[A-Z0-9.-]+_statements_v2\.json$/
        : directory === 'ke_history' ? /^[a-z0-9_]+\.json$/ : /^[A-Z0-9.-]+\.json$/;
      if (pattern.test(filename)) files.push(path.join('cache', directory, filename));
    }
  }
  for (const filename of ['usd_rates.json', 'hkd_rates.json']) {
    files.push(path.join('cache', 'fx', filename));
  }
  for (const filename of fs.readdirSync(path.join(root, 'cache', 'fx'))) {
    if (/^hk_expansion_[a-f0-9]{64}\.json$/.test(filename)) files.push(path.join('cache', 'fx', filename));
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
