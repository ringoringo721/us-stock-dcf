const fs = require('node:fs');
const path = require('node:path');
const { newsRows } = require('../company_data.js');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'cache', 'company');
const baselineOnly = process.argv.includes('--baseline-only');

/** Frontpage / reviewed US baseline tickers from full_market_dcf.json when --baseline-only. */
function baselineSymbols() {
  const marketPath = path.join(root, 'full_market_dcf.json');
  if (!fs.existsSync(marketPath)) {
    throw new Error('--baseline-only requires full_market_dcf.json (reviewed US frontpage universe)');
  }
  const market = JSON.parse(fs.readFileSync(marketPath, 'utf8'));
  if (!market || typeof market !== 'object' || Array.isArray(market)) {
    throw new Error('full_market_dcf.json must be an object keyed by ticker');
  }
  return new Set(Object.keys(market));
}

const allowed = baselineOnly ? baselineSymbols() : null;
const titles = new Set();
let capturedAt = '';
let filesScanned = 0;
let filesIncluded = 0;
for (const filename of fs.readdirSync(directory).filter(name => /^[A-Z0-9.-]+\.json$/.test(name))) {
  filesScanned += 1;
  const ticker = filename.replace(/\.json$/i, '');
  if (allowed && !allowed.has(ticker)) continue;
  filesIncluded += 1;
  const data = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
  for (const article of newsRows(data.news?.data, data.symbol)) titles.add(article.title);
  if (data.capturedAt > capturedAt) capturedAt = data.capturedAt;
}
const output = {
  version: 1,
  source: baselineOnly
    ? 'FMP captured company news headlines for reviewed US baseline/frontpage tickers only'
    : 'FMP captured company news headlines only',
  baselineOnly: Boolean(baselineOnly),
  sourceCapturedAt: capturedAt,
  titles: [...titles].sort(),
};
fs.writeFileSync(path.join(root, 'cache', 'news_translation_source.json'), JSON.stringify(output) + '\n');
console.log(
  `Prepared ${titles.size} unique original headlines`
  + (baselineOnly ? ` from ${filesIncluded}/${filesScanned} baseline ticker files` : ` from ${filesIncluded} company files`)
  + '; no articles, credentials or financial data included.'
  + ' translate_news.py only sends titles missing from the translation cache.'
);
