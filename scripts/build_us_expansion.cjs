const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const { listingStock } = require('../us_universe.js');

function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function write(directory, file, data, prefix = '') {
  const target = path.join(directory, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, prefix + JSON.stringify(data) + (prefix ? ';' : '') + '\n');
}

function loadCatalogue() {
  const file = path.join(root, 'cache', 'us_universe.json');
  if (!fs.existsSync(file)) {
    throw new Error('cache/us_universe.json missing; run scripts/import_us_universe.py with FMP_API_KEY first');
  }
  return read(file);
}

function reviewedTickers() {
  return new Set(Object.keys(read(path.join(root, 'full_market_dcf.json'))));
}

function needsMoatRecovery(stock) {
  const source = stock?.ratingSources?.moat, report = stock?.moat;
  if (source?.reason === 'analysisUnavailable' || source?.reason === 'pendingCapture') return true;
  if (!source?.evidenceHash || source.evidenceHash !== source.currentEvidenceHash || source.reason
      || !Number.isFinite(Date.parse(source.updatedAt))) return true;
  const dimensions = Object.entries(report || {}).filter(([key]) => /^m\d+_/.test(key)).map(([, value]) => value);
  return dimensions.length !== 10 || dimensions.some(value => !Number.isInteger(value?.score)
    || value.score < 0 || value.score > 10 || typeof value.comment_zh !== 'string' || !value.comment_zh.trim()
    || typeof value.comment_en !== 'string' || !value.comment_en.trim())
    || typeof report.overall_moat_verdict_zh !== 'string' || !report.overall_moat_verdict_zh.trim()
    || typeof report.overall_moat_verdict_en !== 'string' || !report.overall_moat_verdict_en.trim();
}

function matrix(size = 20, selected = '', symbols = '', incompleteOnly = false) {
  if (!Number.isInteger(size) || size < 1 || size > 20) throw new Error('Batch size must be 1-20');
  const catalogue = loadCatalogue();
  const reviewed = reviewedTickers();
  const listed = catalogue.stocks.filter(item => !reviewed.has(item.ticker));
  const batches = Array.from({ length: Math.ceil(listed.length / size) }, (_, batch) =>
    ({ batch, symbols: listed.slice(batch * size, (batch + 1) * size).map(item => item.ticker).join(',') }));
  let result = batches;
  if (selected) {
    const wanted = selected.split(',').map(value => Number(value.trim()));
    if (wanted.some(value => !Number.isInteger(value) || value < 0 || value >= batches.length)
        || selected.split(',').some(value => !value.trim())) throw new Error('Invalid selected US batch');
    result = result.filter(item => wanted.includes(item.batch));
  }
  if (symbols) {
    const wanted = symbols.split(',').map(value => value.trim().toUpperCase());
    const available = new Set(result.flatMap(item => item.symbols.split(',').filter(Boolean)));
    if (wanted.length > 20 || new Set(wanted).size !== wanted.length
        || wanted.some(ticker => !available.has(ticker))) throw new Error('Invalid selected US symbols');
    result = result.map(item => ({ ...item,
      symbols: item.symbols.split(',').filter(ticker => wanted.includes(ticker)).join(',')
    })).filter(item => item.symbols);
  }
  if (incompleteOnly) {
    result = result.map(item => ({ ...item, symbols: item.symbols.split(',').filter(ticker => {
      const file = path.join(root, 'cache', 'us_companies', `${ticker}.json`);
      return needsMoatRecovery(fs.existsSync(file) ? read(file).stock : null);
    }).join(',') })).filter(item => item.symbols);
    if (!result.length) throw new Error('No eligible incomplete US assessments selected');
  }
  if (!listed.length) {
    throw new Error('No US expansion candidates above USD 2B outside the reviewed baseline');
  }
  if (!result.length) {
    throw new Error('No US expansion batches selected');
  }
  return result;
}

function ingest(output, marketFile, reports = {}) {
  const catalogue = loadCatalogue();
  const approved = new Map(catalogue.stocks.map(item => [item.ticker, item]));
  const reviewed = reviewedTickers();
  const market = read(marketFile);
  const manifest = [];
  for (const [ticker, stock] of Object.entries(market)) {
    if (!approved.has(ticker) || reviewed.has(ticker)) {
      throw new Error(`Expansion may not overwrite reviewed or unregistered stocks: ${ticker}`);
    }
    if (stock?.ticker !== ticker || stock.calculationCurrency !== 'USD') {
      throw new Error(`Invalid US expansion stock identity: ${ticker}`);
    }
    const listing = approved.get(ticker);
    const moat = reports[ticker]?.report || stock.moat || null;
    const ratingMoat = reports[ticker]
      ? { ...reports[ticker], report: undefined, reason: null, currentEvidenceHash: reports[ticker].evidenceHash }
      : stock.ratingSources?.moat || { reason: moat ? null : 'analysisUnavailable' };
    const recordStock = {
      ...stock,
      name: stock.name || listing.name_en,
      name_en: stock.name_en || listing.name_en,
      exchange: stock.exchange || listing.exchange,
      sector: stock.sector || listing.sector,
      industry: stock.industry || listing.industry,
      moat,
      ratingSources: { ...(stock.ratingSources || {}), moat: ratingMoat },
      expansion: { status: 'available', capturedAt: stock.expansion?.capturedAt || new Date().toISOString(),
        reason: stock.expansion?.reason || null, detailPath: `cache/us_companies/${ticker}.json` }
    };
    write(output, `cache/us_companies/${ticker}.json`, { version: 1, ticker, stock: recordStock, snapshot: null });
    const finSrc = path.join(root, 'cache', 'financials', `${ticker}_statements_v2.json`);
    if (fs.existsSync(finSrc)) {
      write(output, `cache/financials/${ticker}_statements_v2.json`, read(finSrc));
    }
    const chartSrc = path.join(root, 'cache', 'price_charts', `${ticker}.json`);
    if (fs.existsSync(chartSrc)) {
      write(output, `cache/price_charts/${ticker}.json`, read(chartSrc));
    }
    const companySrc = path.join(root, 'cache', 'company', `${ticker}.json`);
    if (fs.existsSync(companySrc)) {
      write(output, `cache/company/${ticker}.json`, read(companySrc));
    }
    manifest.push({
      ticker,
      status: 'available',
      reason: recordStock.expansion.reason,
      fScore: Number.isFinite(recordStock.f_score) ? recordStock.f_score : null,
      moat: !!recordStock.moat && !recordStock.ratingSources?.moat?.reason
    });
  }
  write(output, 'market.json', Object.fromEntries(manifest.map(item => {
    const record = read(path.join(output, 'cache', 'us_companies', `${item.ticker}.json`));
    return [item.ticker, record.stock];
  })));
  write(output, 'manifest.json', { version: 1, source: catalogue.source, screen: catalogue.screen, stocks: manifest });
  return manifest;
}

function packageResults(output) {
  const modelFile = path.join(output, 'fmp_model_data.js'), context = { window: {} };
  if (fs.existsSync(modelFile)) vm.runInNewContext(fs.readFileSync(modelFile, 'utf8'), context);
  const models = context.window.FMP_MODEL_DATA?.stocks || {};
  const manifest = read(path.join(output, 'manifest.json'));
  const counts = { companies: manifest.stocks.length, financialSnapshots: 0, fScores: 0, completeMoats: 0, nativeAdvancedModels: 0 };
  const market = read(path.join(output, 'market.json'));
  for (const [ticker, stock] of Object.entries(market)) {
    const file = `cache/us_companies/${ticker}.json`;
    const record = read(path.join(output, file));
    record.model = models[ticker] || null;
    write(output, file, record);
    const finPath = path.join(output, 'cache', 'financials', `${ticker}_statements_v2.json`);
    if (fs.existsSync(finPath)) {
      const financials = read(finPath);
      if (['annual', 'quarterly'].some(period => ['income', 'balance', 'cashflow']
        .some(type => (financials[period]?.[type] || []).length))) counts.financialSnapshots++;
    }
    if (Number.isFinite(stock.f_score)) counts.fScores++;
    const dimensions = Object.entries(stock.moat || {}).filter(([key]) => /^m\d+_/.test(key));
    if (!stock.ratingSources?.moat?.reason && dimensions.length === 10
        && dimensions.every(([, value]) => Number.isInteger(value.score))) counts.completeMoats++;
    if (record.model?.models?.advanced?.data?.length && !record.model.currencyCheck?.reason) {
      counts.nativeAdvancedModels++;
    }
  }
  manifest.coverage = counts;
  write(output, 'manifest.json', manifest);
  const summary = `Additional US company capture: ${JSON.stringify(counts)}. Missing ratings are NOT completed assessments; fallback neutral moat scores are never published for expansion names.\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

function integrate(input, output = root) {
  const expansionFile = path.join(output, 'us_expansion_data.js'), context = { window: {} };
  if (fs.existsSync(expansionFile)) vm.runInNewContext(fs.readFileSync(expansionFile, 'utf8'), context);
  const expansion = context.window.US_EXPANSION || { version: 1, stocks: {}, models: {}, snapshots: {} };
  const catalogue = loadCatalogue();
  const approved = new Set(catalogue.stocks.map(item => item.ticker));
  const reviewed = reviewedTickers();
  const directories = [input], manifests = [];
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Symlinks are not supported in captured artifacts');
      if (entry.isDirectory()) directories.push(path.join(directory, entry.name));
      else if (entry.name === 'manifest.json') manifests.push(path.join(directory, entry.name));
    }
  }
  if (!manifests.length) throw new Error('No company batch manifests found');
  for (const file of manifests) {
    const manifest = read(file), directory = path.dirname(file);
    if (manifest.version !== 1) throw new Error('Unsupported US expansion manifest version');
    if (manifest.source?.retrievedAt !== catalogue.source.retrievedAt
        && manifest.source?.provider !== catalogue.source.provider) {
      // Allow resume across re-imports only when provider matches; retrievedAt may differ after re-screen.
      if (manifest.source?.provider !== catalogue.source.provider) {
        throw new Error('Batch universe source provider mismatch');
      }
    }
    for (const item of manifest.stocks) {
      const ticker = item.ticker;
      if (!approved.has(ticker) || reviewed.has(ticker)) {
        throw new Error('Artifact may not replace reviewed US companies');
      }
      if (item.status !== 'available') {
        if (!expansion.stocks[ticker]) {
          const stock = listingStock(catalogue.stocks.find(row => row.ticker === ticker));
          stock.expansion = { status: item.status, reason: item.reason };
          expansion.stocks[ticker] = stock;
        }
        continue;
      }
      const record = read(path.join(directory, 'cache', 'us_companies', `${ticker}.json`));
      if (record.version !== 1 || record.ticker !== ticker || record.stock?.ticker !== ticker
          || record.stock.calculationCurrency !== 'USD' || record.model && record.model.symbol !== ticker) {
        throw new Error('Captured US company identity mismatch');
      }
      if (expansion.stocks[ticker]?.expansion?.capturedAt > record.stock.expansion.capturedAt) continue;
      for (const [folder, filename] of [['us_companies', `${ticker}.json`],
        ['financials', `${ticker}_statements_v2.json`], ['price_charts', `${ticker}.json`], ['company', `${ticker}.json`]]) {
        const source = path.join(directory, 'cache', folder, filename);
        if (!fs.existsSync(source)) continue;
        write(output, path.join('cache', folder, filename), read(source));
      }
      const compact = { ...record.stock };
      for (const key of ['statements_raw', 'real_history', 'news', 'top_holders', 'insider_trades', 'stock_splits',
        'historical_dcf_series', 'real_5y_prices', 'description', 'description_en', 'description_zh', 'reported_growth']) {
        delete compact[key];
      }
      compact.f_score_breakdown = [];
      if (compact.moat && compact.ratingSources?.moat?.reason) {
        // Do not publish invented or incomplete moat payloads in the compact screener catalogue.
        compact.moat = null;
      } else if (compact.moat) {
        compact.moat = Object.fromEntries(Object.entries(compact.moat).filter(([key]) =>
          /^m\d+_/.test(key) || key.startsWith('overall_moat_verdict')).map(([key, value]) =>
          [key, /^m\d+_/.test(key) ? { score: value.score } : value]));
      }
      expansion.stocks[ticker] = compact;
      if (record.model) expansion.models[ticker] = record.model;
      if (record.snapshot) {
        const { defaults, quotedCapital, reason } = record.snapshot;
        expansion.snapshots[ticker] = { defaults, quotedCapital, reason };
      }
    }
  }
  expansion.source = catalogue.source;
  expansion.screen = catalogue.screen;
  write(output, 'us_expansion_data.js', expansion, 'window.US_EXPANSION = ');
  return Object.keys(expansion.stocks).length;
}

if (require.main === module) {
  const [command, input, output, reportsFile] = process.argv.slice(2);
  if (command === 'matrix') {
    console.log(JSON.stringify({ include: matrix(20,
      process.env.US_EXPANSION_BATCHES || '', process.env.US_EXPANSION_SYMBOLS || '',
      process.env.US_EXPANSION_INCOMPLETE_ONLY === 'true') }));
  } else if (command === 'ingest') {
    ingest(output || input, input, reportsFile && fs.existsSync(reportsFile) ? read(reportsFile) : {});
  } else if (command === 'package') packageResults(input);
  else if (command === 'integrate') {
    console.log(`Integrated ${integrate(input, output)} additional US company outcomes without replacing reviewed stocks.`);
  } else throw new Error('Expected matrix, ingest, package or integrate');
}

module.exports = { matrix, ingest, packageResults, integrate, needsMoatRecovery, listingStock };
