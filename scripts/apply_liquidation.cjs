const fs = require('node:fs');
const path = require('node:path');
const { rateFor } = require('../usd_currency.js');
const { calculate } = require('../liquidation.js');
const finite = value => typeof value === 'number' && Number.isFinite(value);

function prepareSnapshot(ticker, record, rates, stock) {
  if (!record) return null;
  if (record.ticker !== ticker || record.providerSymbol !== ticker.replace(/\./g, '-')) {
    throw new TypeError(`${ticker}: incorrect liquidation source symbol`);
  }
  const b = record.balance;
  const fx = rateFor(rates, b.reportedCurrency, null, b.date, 'closing');
  const usd = field => finite(b[field]) && finite(fx.rate) ? b[field] * fx.rate : null;
  const snapshot = {
    version: 1, ticker, currency: 'USD', source: 'FMP stable balance-sheet-statement and quote',
    fetchedAt: record.fetchedAt, balanceDate: b.date, filingDate: b.filingDate,
    quoteDate: record.quote.date, sourceCurrency: b.reportedCurrency, fx,
    receivablesBasis: 'trade', shareBasis: 'marketCapOverPrice',
    quote: record.quote,
    amounts: { currentAssets: usd('totalCurrentAssets'), totalLiabilities: usd('totalLiabilities'),
      cashAndShortTermInvestments: usd('cashAndShortTermInvestments'),
      tradeReceivables: usd('accountsReceivables'), inventory: usd('inventory'),
      preferredStock: usd('preferredStock') }
  };
  if (stock?.shareBasis === 'commonSharesOutstandingExcludingTreasury') {
    snapshot.shareBasis = stock.shareBasis;
    snapshot.sharesOutstanding = stock.shares_outstanding;
    snapshot.shareSource = stock.shareSource;
    if (stock.shareSource?.capturedAt > snapshot.fetchedAt) snapshot.fetchedAt = stock.shareSource.capturedAt;
  }
  return snapshot;
}

function applyToMarket(market, sources, rates) {
  if (sources.version !== 1 || !sources.stocks) throw new TypeError('Invalid liquidation source dataset');
  const updates = {};
  for (const ticker of Object.keys(market)) {
    const liquidation = prepareSnapshot(ticker, sources.stocks[ticker], rates, market[ticker]);
    const result = calculate(liquidation, ticker);
    updates[ticker] = { liquidation, liq_val_1: result.values[0],
      liq_val_2: result.values[1], liq_val_3: result.values[2] };
  }
  return updates;
}

function patchMarketText(text, updates) {
  const starts = [...text.matchAll(/\n  "([^"]+)": \{/g)];
  let result = text.slice(0, starts[0]?.index ?? text.length);
  if (starts.length !== Object.keys(updates).length) throw new TypeError('Market text coverage mismatch');
  starts.forEach((match, i) => {
    const update = updates[match[1]];
    if (!update) throw new TypeError(`Unexpected market ticker ${match[1]}`);
    const end = starts[i + 1]?.index ?? text.lastIndexOf('\n}');
    let block = text.slice(match.index, end);
    for (const field of ['liq_val_1', 'liq_val_2', 'liq_val_3']) {
      const pattern = new RegExp(`(\\n    "${field}": )[^,\\r\\n]+`);
      if (!pattern.test(block)) throw new TypeError(`Missing ${match[1]} ${field}`);
      block = block.replace(pattern, (_, prefix) => prefix + JSON.stringify(update[field]));
    }
    const closing = block.lastIndexOf('\n  }');
    const property = `\n    "liquidation": ${JSON.stringify(update.liquidation, null, 2).replace(/\n/g, '\n    ')}`;
    const existing = block.indexOf('\n    "liquidation": ');
    if (existing >= 0) {
      const next = block.indexOf('\n    "', existing + 1);
      block = block.slice(0, existing) + property + (next >= 0 ? ',' : '')
        + block.slice(next >= 0 ? next : closing);
    } else block = block.slice(0, closing) + ',' + property + block.slice(closing);
    result += block;
  });
  return result + text.slice(text.lastIndexOf('\n}'));
}

function main() {
  const root = path.join(__dirname, '..');
  const market = JSON.parse(fs.readFileSync(path.join(root, 'full_market_dcf.json'), 'utf8'));
  const sources = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'liquidation_sources.json'), 'utf8'));
  const rates = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'fx', 'usd_rates.json'), 'utf8'));
  const updates = applyToMarket(market, sources, rates);
  const output = ['full_market_dcf.json', 'market_data.js'].map(file => ({
    target: path.join(root, file),
    content: patchMarketText(fs.readFileSync(path.join(root, file), 'utf8'), updates)
  }));
  const prefix = 'window.FULL_MARKET_DATA = ';
  if (!output[1].content.startsWith(prefix)
      || JSON.stringify(JSON.parse(output[0].content)) !== JSON.stringify(
        JSON.parse(output[1].content.slice(prefix.length).trim().replace(/;$/, '')))) {
    throw new TypeError('JSON and browser market datasets disagree; files were not written');
  }
  for (const file of output) fs.writeFileSync(file.target, file.content);
  const unavailable = Object.keys(updates).filter(ticker =>
    calculate(updates[ticker].liquidation, ticker).values.some(value => value === null));
  console.log(`Applied shared liquidation calculations to ${Object.keys(updates).length} stocks; DCF values unchanged`);
  if (unavailable.length) console.warn(`Liquidation inputs unavailable (N/A): ${unavailable.join(', ')}`);
}
if (require.main === module) main();
module.exports = { prepareSnapshot, applyToMarket, patchMarketText };
