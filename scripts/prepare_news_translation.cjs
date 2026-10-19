const fs = require('node:fs');
const path = require('node:path');
const { newsRows } = require('../company_data.js');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'cache', 'company');
const titles = new Set();
let capturedAt = '';
for (const filename of fs.readdirSync(directory).filter(name => /^[A-Z0-9.-]+\.json$/.test(name))) {
  const data = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
  for (const article of newsRows(data.news?.data, data.symbol)) titles.add(article.title);
  if (data.capturedAt > capturedAt) capturedAt = data.capturedAt;
}
const output = { version: 1, source: 'FMP captured company news headlines only', sourceCapturedAt: capturedAt,
  titles: [...titles].sort() };
fs.writeFileSync(path.join(root, 'cache', 'news_translation_source.json'), JSON.stringify(output) + '\n');
console.log(`Prepared ${titles.size} unique original headlines; no articles, credentials or financial data included.`);
