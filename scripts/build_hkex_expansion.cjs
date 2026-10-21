const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const catalogue = require('../cache/hkex_universe.json');
const reviewed = new Set(require('../hkex_stocks.json').map(item => item.ticker));
const { listingStock, belowMoatMarketCap } = require('../hkex_universe.js');
const { compileStock, prepareStatements, statementTable, scoreBreakdown, hash, priceHistory } = require('./build_hkex.cjs');
const { convertStatements } = require('../usd_currency.js');
const scores = require('../statement_scores.js');
const ratios = require('../fcf_ratios.js');
const rates = require('../cache/fx/hkd_rates.json');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(directory, file, data, prefix = '') {
  const target = path.join(directory, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, prefix + JSON.stringify(data) + (prefix ? ';' : '') + '\n');
}
function needsMoatRecovery(stock) {
  if (belowMoatMarketCap(stock)) return false;
  const source = stock?.ratingSources?.moat, report = stock?.moat;
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
  const listed = catalogue.stocks.filter(item => !reviewed.has(item.ticker));
  const batches = Array.from({ length: Math.ceil(listed.length / size) }, (_, batch) =>
    ({ batch, symbols: listed.slice(batch * size, (batch + 1) * size).map(item => item.ticker).join(',') }));
  let result = batches;
  if (selected) {
    const wanted = selected.split(',').map(value => Number(value.trim()));
    if (wanted.some(value => !Number.isInteger(value) || value < 0 || value >= batches.length)
        || selected.split(',').some(value => !value.trim())) throw new Error('Invalid selected HKEX batch');
    result = result.filter(item => wanted.includes(item.batch));
  }
  if (symbols) {
    const wanted = symbols.split(',').map(value => value.trim());
    const available = new Set(result.flatMap(item => item.symbols.split(',')));
    if (wanted.length > 20 || new Set(wanted).size !== wanted.length
        || wanted.some(ticker => !available.has(ticker))) throw new Error('Invalid selected HKEX symbols');
    result = result.map(item => ({ ...item,
      symbols: item.symbols.split(',').filter(ticker => wanted.includes(ticker)).join(',')
    })).filter(item => item.symbols);
  }
  if (incompleteOnly) {
    result = result.map(item => ({ ...item, symbols: item.symbols.split(',').filter(ticker => {
      const file = path.join(root, 'cache', 'hk_companies', `${ticker}.json`);
      return needsMoatRecovery(fs.existsSync(file) ? read(file).stock : null);
    }).join(',') })).filter(item => item.symbols);
    if (!result.length) throw new Error('No eligible incomplete HKEX assessments selected');
  }
  return result;
}
function preferSavedMoat(stock, fingerprint, previous) {
  const source = stock?.ratingSources?.moat;
  if (!stock?.moat || source?.reason === 'staleEvidence' || source?.evidenceHash !== fingerprint
      || source.currentEvidenceHash !== fingerprint || !Number.isFinite(Date.parse(source.updatedAt))) return previous;
  if (previous?.report && previous.evidenceHash === fingerprint
      && Date.parse(previous.updatedAt) >= Date.parse(source.updatedAt)) return previous;
  const { evidenceHash, updatedAt, model, assessmentPolicy, provider, businessResearch, lastError } = source;
  return { evidenceHash, updatedAt, model, assessmentPolicy, provider, businessResearch, lastError, report: stock.moat };
}
function partial(item, original, error, reports, treasury, capturedRates = rates) {
  const evidence = structuredClone(original), sourceWarnings = [];
  for (const name of ['income', 'balance', 'cashflow', 'annual_income', 'annual_balance', 'annual_cashflow']) {
    if (!evidence.responses[name]) continue;
    try { prepareStatements({ ...evidence, responses: { [name]: evidence.responses[name] } }, { allowIncomplete: true }); }
    catch (sourceError) {
      evidence.responses[name] = { ok: false, error: 'INVALID_SOURCE' };
      sourceWarnings.push({ code: 'providerStatementInvalid', endpoint: name, message: sourceError.message });
    }
  }
  try { priceHistory(evidence); }
  catch (priceError) {
    sourceWarnings.push({ code: 'priceHistoryUnavailable', message: priceError.message });
    delete evidence.responses.prices_older; delete evidence.responses.prices_recent;
  }
  if (item.tradingCurrency === 'HKD') {
    try {
      return { ...compileStock(item, evidence, capturedRates, reports, {}, treasury, { allowIncomplete: true, sourceWarnings }),
        limitation: error.message };
    } catch (remainingError) {
      sourceWarnings.push({ code: 'companySnapshotIncomplete', message: remainingError.message });
    }
  }
  const stock = listingStock(item), profile = evidence.responses.profile?.rows?.find(row => row.symbol === item.ticker);
  const statements = prepareStatements(evidence, { allowIncomplete: true, sourceWarnings });
  const display = convertStatements(statements, capturedRates), score = scores.calculate(statements);
  stock.statements_raw = statementTable(display);
  stock.f_score = score.score; stock.f_score_breakdown = scoreBreakdown(score, display);
  stock.ratingSources.fScore = { ...score, checkedAt: evidence.capturedAt, evidenceHash: hash(statements) };
  stock.company_name = profile?.companyName || stock.company_name;
  stock.description = profile?.description || null;
  stock.description_en = profile?.description || null;
  stock.dataAvailability = { currentPrice: 'sourceUnavailable', financials: statements.qualityWarnings };
  const moatInput = {
    methodVersion: 'hkex-qualitative-evidence-v2', ticker: item.ticker,
    profile: { companyName: profile?.companyName || item.name_en || item.name,
      description: profile?.description || null, industry: item.industry,
      identitySource: profile ? 'FMP matched provider profile' : 'HKEX official listing identity only; business description unavailable' },
    reportingCurrency: statements.annual.income.at(-1)?.reportedCurrency || null,
    statements: { ...statements, fetchedAt: undefined }, displayStatements: { ...display, fetchedAt: undefined },
    fScore: score, transcripts: []
  };
  let chart = { version: 1, ticker: item.ticker, rows: [], reason: 'sourceUnavailable' };
  try { chart = priceHistory(evidence); }
  catch (chartError) { chart.reason = chartError.message; }
  return { stock, statements, chart, snapshot: null, moatInput,
    fingerprint: moatInput ? hash(moatInput) : null, limitation: error.message };
}
function build(input, output, symbols, reports = {}) {
  const capturedRateFile = path.join(output, 'cache', 'fx', 'hkd_rates.json');
  const capturedRates = fs.existsSync(capturedRateFile) ? read(capturedRateFile) : rates;
  const approved = new Map(catalogue.stocks.map(item => [item.ticker, item]));
  const treasury = fs.existsSync(path.join(input, 'treasury.json')) ? read(path.join(input, 'treasury.json')) : null;
  const inputs = [], market = {}, manifest = [];
  const savedResearch = fs.existsSync(path.join(output, 'business-research.json'))
    ? read(path.join(output, 'business-research.json')).research || {} : {};
  for (const ticker of symbols) {
    if (!approved.has(ticker) || reviewed.has(ticker)) throw new Error('Expansion may not overwrite reviewed or unregistered stocks');
    const listing = approved.get(ticker);
    const item = { ...listing, name: listing.name_en,
      financial: /Banks|Insurance|Financial Conglomerates/.test(listing.industry),
      shareClassReviewRequired: !listing.isin || listing.isin.startsWith('CNE'),
      generalCorporateValuationWarning: listing.securityType === 'REIT' };
    try {
      const evidence = read(path.join(input, `${ticker}.json`));
      let result;
      try {
        if (listing.tradingCurrency !== 'HKD') throw new Error('unsupportedTradingCurrency');
        result = compileStock(item, evidence, capturedRates, reports, {}, treasury, { allowIncomplete: true });
      } catch (error) {
        console.error(`${ticker}: incomplete company snapshot: ${error.message}`);
        result = partial(item, evidence, error, reports, treasury, capturedRates);
      }
      const savedFile = path.join(root, 'cache', 'hk_companies', `${ticker}.json`);
      const saved = fs.existsSync(savedFile) ? read(savedFile) : null;
      if (saved && (saved.ticker !== ticker || saved.stock?.ticker !== ticker)) throw new Error('Invalid saved moat company identity');
      const candidate = preferSavedMoat(saved?.stock, result.fingerprint, reports[ticker]);
      if (candidate?.evidenceHash === result.fingerprint && candidate.report) {
        result.stock.moat = candidate.report;
        result.stock.description_zh = candidate.report.description_zh;
        result.stock.ratingSources.moat = { ...result.stock.ratingSources.moat, ...candidate, report: undefined, reason: null,
          currentEvidenceHash: result.fingerprint, checkedAt: evidence.capturedAt };
      }
      result.stock.expansion = { status: 'available', capturedAt: evidence.capturedAt,
        reason: result.limitation || null, detailPath: `cache/hk_companies/${ticker}.json` };
      if (result.moatInput) inputs.push({ ...result.moatInput, evidenceHash: result.fingerprint,
        moatScreen: { calculationCurrency: result.stock.calculationCurrency, marketCapMillions: result.stock.mcap },
        existing: candidate || null, ...((candidate?.businessResearch || savedResearch[ticker])
          ? { businessResearch: candidate?.businessResearch || savedResearch[ticker] } : {}) });
      market[ticker] = result.stock;
      write(output, `cache/financials/${ticker}_statements_v2.json`, result.statements);
      write(output, `cache/price_charts/${ticker}.json`, result.chart);
      write(output, `cache/hk_companies/${ticker}.json`, { version: 1, ticker,
        stock: result.stock, snapshot: result.snapshot });
      manifest.push({ ticker, status: 'available', reason: result.limitation || null,
        fScore: result.stock.f_score, moat: !!result.stock.moat });
    } catch (error) {
      console.error(`${ticker}: company data unavailable: ${error.message}`);
      manifest.push({ ticker, status: 'captureFailed', reason: error.message });
    }
  }
  write(output, 'market.json', market);
  write(output, 'moat-inputs.json', inputs);
  write(output, 'manifest.json', { version: 1, source: catalogue.source, stocks: manifest });
  return manifest;
}
function packageResults(output) {
  const capturedRateFile = path.join(output, 'cache', 'fx', 'hkd_rates.json');
  const capturedRates = fs.existsSync(capturedRateFile) ? read(capturedRateFile) : rates;
  const modelFile = path.join(output, 'fmp_model_data.js'), context = { window: {} };
  if (fs.existsSync(modelFile)) vm.runInNewContext(fs.readFileSync(modelFile, 'utf8'), context);
  const models = context.window.FMP_MODEL_DATA?.stocks || {};
  const manifest = read(path.join(output, 'manifest.json'));
  const counts = { companies: manifest.stocks.length, financialSnapshots: 0, fScores: 0, completeMoats: 0, nativeAdvancedModels: 0 };
  for (const [ticker, stock] of Object.entries(read(path.join(output, 'market.json')))) {
    const file = `cache/hk_companies/${ticker}.json`, record = read(path.join(output, file));
    const financials = read(path.join(output, 'cache', 'financials', `${ticker}_statements_v2.json`));
    record.model = models[ticker] || null;
    if (record.model?.currencyCheck?.sourceDate && !record.model.currencyCheck.reason) {
      const annual = financials.annual.income.find(row => row.date === record.model.currencyCheck.sourceDate);
      if (!annual || annual.periodLength !== 12) {
        record.model.currencyCheck = { ...record.model.currencyCheck, reason: 'FMP_MODEL_CURRENCY_UNVERIFIED',
          sourcePeriodLength: annual?.periodLength ?? null, reviewReason: 'nonFullFiscalPeriod' };
        const fullFile = path.join(output, 'cache', 'company', `${ticker}.json`);
        if (fs.existsSync(fullFile)) {
          const company = read(fullFile); company.currencyCheck = record.model.currencyCheck;
          write(output, `cache/company/${ticker}.json`, company);
        }
      }
    }
    write(output, file, record);
    if (['annual', 'quarterly'].some(period => ['income', 'balance', 'cashflow']
      .some(type => financials[period][type].some(row => row.reportedCurrency !== 'HKD')))) {
      const sha256 = hash(capturedRates), fxPath = `cache/fx/hk_expansion_${sha256}.json`;
      write(output, fxPath, capturedRates);
      financials.hkdFxSource = { path: fxPath, sha256, basis: 'SHA-256 of JSON.stringify(rate snapshot)' };
      write(output, `cache/financials/${ticker}_statements_v2.json`, financials);
    }
    if (['annual', 'quarterly'].some(period => ['income', 'balance', 'cashflow'].some(type => financials[period][type].length))) {
      counts.financialSnapshots++;
    }
    if (Number.isFinite(stock.f_score)) counts.fScores++;
    const dimensions = Object.entries(stock.moat || {}).filter(([key]) => /^m\d+_/.test(key));
    if (!stock.ratingSources.moat?.reason && dimensions.length === 10
        && dimensions.every(([, value]) => Number.isInteger(value.score))) counts.completeMoats++;
    if (record.model?.models?.advanced?.data?.length && !record.model.currencyCheck?.reason) counts.nativeAdvancedModels++;
  }
  manifest.coverage = counts; write(output, 'manifest.json', manifest);
  const summary = `Additional HKEX company capture: ${JSON.stringify(counts)}. Missing ratings, partial research and unavailable endpoints are NOT completed assessments.\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
function integrate(input, output = root) {
  const expansionFile = path.join(output, 'hkex_expansion_data.js'), context = { window: {} };
  if (fs.existsSync(expansionFile)) vm.runInNewContext(fs.readFileSync(expansionFile, 'utf8'), context);
  const expansion = context.window.HKEX_EXPANSION || { version: 1, stocks: {}, models: {}, snapshots: {} };
  const approved = new Set(catalogue.stocks.map(item => item.ticker));
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
    if (manifest.version !== 1 || manifest.source.sha256 !== catalogue.source.sha256) throw new Error('Batch universe source mismatch');
    for (const item of manifest.stocks) {
      const ticker = item.ticker;
      if (!approved.has(ticker) || reviewed.has(ticker)) throw new Error('Artifact may not replace reviewed companies');
      if (item.status !== 'available') {
        if (!expansion.stocks[ticker]) {
          const stock = listingStock(catalogue.stocks.find(row => row.ticker === ticker));
          stock.expansion = { status: item.status, reason: item.reason };
          expansion.stocks[ticker] = stock;
        }
        continue;
      }
      const record = read(path.join(directory, 'cache', 'hk_companies', `${ticker}.json`));
      if (record.version !== 1 || record.ticker !== ticker || record.stock?.ticker !== ticker
          || record.stock.calculationCurrency !== 'HKD' || record.model && record.model.symbol !== ticker) {
        throw new Error('Captured company identity mismatch');
      }
      if (expansion.stocks[ticker]?.expansion?.capturedAt > record.stock.expansion.capturedAt) continue;
      for (const [folder, filename] of [['hk_companies', `${ticker}.json`],
        ['financials', `${ticker}_statements_v2.json`], ['price_charts', `${ticker}.json`], ['company', `${ticker}.json`]]) {
        const source = path.join(directory, 'cache', folder, filename);
        if (folder === 'company' && !fs.existsSync(source)) continue;
        write(output, path.join('cache', folder, filename), read(source));
      }
      const financials = read(path.join(directory, 'cache', 'financials', `${ticker}_statements_v2.json`));
      if (financials.hkdFxSource) {
        const fx = financials.hkdFxSource;
        if (!/^[a-f0-9]{64}$/.test(fx.sha256) || fx.path !== `cache/fx/hk_expansion_${fx.sha256}.json`) {
          throw new Error('Invalid captured FX path');
        }
        const capturedRates = read(path.join(directory, fx.path));
        if (hash(capturedRates) !== fx.sha256) throw new Error('Captured FX content hash mismatch');
        write(output, fx.path, capturedRates);
      }
      const compact = { ...record.stock };
      if (!Number.isFinite(compact.fcf_to_equity)) {
        compact.fcf_to_equity = ratios.storedTtmFcfToEquity(record.stock.statements_raw,
          record.stock.currencyConversion?.reason);
      }
      for (const key of ['statements_raw', 'real_history', 'news', 'top_holders', 'insider_trades', 'stock_splits',
        'historical_dcf_series', 'real_5y_prices', 'description', 'description_en', 'description_zh', 'reported_growth']) delete compact[key];
      compact.f_score_breakdown = [];
      if (compact.ratingSources?.moat?.businessResearch) {
        const { businessResearch, ...provenance } = compact.ratingSources.moat;
        compact.ratingSources = { ...compact.ratingSources, moat: {
          ...provenance, businessResearchSourceCount: businessResearch.sources.length
        } };
      }
      if (compact.moat) {
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
  write(output, 'hkex_expansion_data.js', expansion, 'window.HKEX_EXPANSION = ');
  return Object.keys(expansion.stocks).length;
}
if (require.main === module) {
  const [command, input, output, supplied, reportsFile] = process.argv.slice(2);
  if (command === 'matrix') console.log(JSON.stringify({ include: matrix(20,
    process.env.HK_EXPANSION_BATCHES || '', process.env.HK_EXPANSION_SYMBOLS || '',
    process.env.HK_EXPANSION_INCOMPLETE_ONLY === 'true') }));
  else if (command === 'build') build(input, output, supplied.split(','), reportsFile && fs.existsSync(reportsFile) ? read(reportsFile) : {});
  else if (command === 'package') packageResults(input);
  else if (command === 'integrate') console.log(`Integrated ${integrate(input, output)} additional company outcomes without replacing reviewed stocks.`);
  else throw new Error('Expected matrix, build, package or integrate');
}
module.exports = { matrix, build, packageResults, integrate, preferSavedMoat, needsMoatRecovery };
