const fs = require('node:fs');
const path = require('node:path');

function applyTranslations(input, root = path.resolve(__dirname, '..')) {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'news_translation_source.json'), 'utf8'));
  const cache = JSON.parse(fs.readFileSync(input, 'utf8'));
  const target = path.join(root, 'cache', 'news_translations.json');
  const existing = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : { titles: {} };
  if (cache.version !== 1 || cache.language !== 'zh-Hant' || cache.provider !== 'Vertex AI'
      || !cache.titles || Array.isArray(cache.titles)) throw new Error('Invalid translation cache identity');
  const known = new Set([...source.titles, ...Object.keys(existing.titles)]);
  for (const [title, entry] of Object.entries(cache.titles)) {
    if (!known.has(title) || typeof entry?.text !== 'string' || !/[\u3400-\u9fff]/.test(entry.text)
        || entry.model !== 'gemini-2.5-flash-lite' || !Number.isFinite(Date.parse(entry.translatedAt))
        || Object.hasOwn(existing.titles, title) && existing.titles[title].text !== entry.text) {
      throw new Error('Mismatched, invalid or unexpectedly changed headline translation');
    }
  }
  const merged = { ...cache, titles: { ...existing.titles, ...cache.titles } };
  fs.writeFileSync(target + '.tmp', JSON.stringify(merged) + '\n');
  fs.renameSync(target + '.tmp', target);
  console.log(`Saved ${Object.keys(merged.titles).length} exact-title translations without changing source headlines or financials.`);
  return merged;
}

if (require.main === module) {
  if (!process.argv[2]) throw new Error('Provide the downloaded translation cache path');
  applyTranslations(process.argv[2]);
}
module.exports = { applyTranslations };
