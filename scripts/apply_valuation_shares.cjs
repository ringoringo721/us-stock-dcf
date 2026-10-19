const fs = require('node:fs');
const path = require('node:path');
const { outstandingShares } = require('./fcff_sources.cjs');
const { calculate } = require('../liquidation.js');
const { financialReference } = require('../fcf_ratios.js');
const { convertStatements } = require('../usd_currency.js');
const finite = value => typeof value === 'number' && Number.isFinite(value);

function applyToMarket(market, records, financials = {}) {
  return Object.fromEntries(Object.entries(market).map(([ticker, original]) => {
    const evidence = records[ticker];
    const source = outstandingShares(evidence, evidence?.capturedAt?.slice(0, 10));
    if (!finite(source.shares) || evidence?.ticker !== ticker) throw new TypeError(`${ticker}: missing verified outstanding shares`);
    const stock = { ...original, shares: source.shares, shares_outstanding: source.shares * 1e6,
      shares_display: `${source.shares.toFixed(2)} M`, shareSource: source, shareBasis: source.basis };
    if (!stock.fin_valuation?.is_financial && stock.calculationCurrency === 'USD'
        && finite(stock.dcf_model_ev) && finite(stock.net_debt)) {
      stock.fair_val = Math.max((stock.dcf_model_ev - stock.net_debt) / stock.shares, 0.01);
      stock.default_fair_val = stock.fair_val;
      stock.premium_pct = (stock.price / stock.fair_val - 1) * 100;
      stock.is_undervalued = stock.premium_pct < 0;
    }
    if (stock.fin_valuation?.is_financial) {
      const fin = { ...stock.fin_valuation };
      const rescale = value => finite(value) && finite(original.shares) && original.shares > 0
        ? value * (original.shares / stock.shares) : null;
      for (const key of ['excess_return_fair', 'ddm_fair']) {
        if (Object.prototype.hasOwnProperty.call(fin, key)) fin[key] = rescale(fin[key]);
      }
      for (const key of ['fair_val', 'default_fair_val']) {
        if (Object.prototype.hasOwnProperty.call(stock, key)) stock[key] = rescale(stock[key]);
      }
      if (Object.prototype.hasOwnProperty.call(stock, 'fair_val')) {
        stock.premium_pct = stock.fair_val > 0 ? (stock.price / stock.fair_val - 1) * 100 : null;
        stock.is_undervalued = stock.premium_pct === null ? null : stock.premium_pct < 0;
      }
      const total = (group, perShare) => finite(fin[group]) ? fin[group]
        : finite(fin[perShare]) && finite(original.shares) ? fin[perShare] * original.shares : null;
      fin.tangibleEquity = total('tangibleEquity', 'tbvps');
      fin.totalPayout = total('totalPayout', 'dps_total');
      fin.tbvps = finite(fin.tangibleEquity) ? fin.tangibleEquity / stock.shares : null;
      fin.dps_total = finite(fin.totalPayout) ? fin.totalPayout / stock.shares : null;
      if (finite(fin.bvps) && finite(original.shares)) fin.bvps *= original.shares / stock.shares;
      fin.pb_tangible = fin.tbvps > 0 ? stock.price / fin.tbvps : null;
      if (financials[ticker]) {
        fin.reference = financialReference(financials[ticker], { shares: stock.shares });
        fin.tbvps = fin.reference.tbvps;
        fin.rote = fin.reference.rote;
      } else if (fin.reference) fin.reference = { ...fin.reference, tbvps: fin.tbvps };
      stock.fin_valuation = fin;
    }
    if (stock.liquidation) {
      stock.liquidation = { ...stock.liquidation, sharesOutstanding: stock.shares_outstanding,
        shareBasis: source.basis, shareSource: source, fetchedAt: evidence.capturedAt };
      calculate(stock.liquidation, ticker).values.forEach((value, i) => { stock[`liq_val_${i + 1}`] = value; });
    }
    return [ticker, stock];
  }));
}

function applyToSnapshots(data, market) {
  return { ...data, stocks: Object.fromEntries(Object.entries(data.stocks).map(([ticker, source]) => {
    const stock = market[ticker];
    if (!stock?.shareSource) throw new TypeError(`${ticker}: missing share-count provenance`);
    return [ticker, { ...source, defaults: { ...source.defaults, shares: stock.shares },
      provenance: { ...source.provenance, shares: stock.shareSource } }];
  })) };
}

function patchMarketText(text, market) {
  const starts = [...text.matchAll(/\n  "([^"]+)": \{/g)];
  if (starts.length !== Object.keys(market).length) throw new TypeError('Market text coverage mismatch');
  let result = text.slice(0, starts[0].index);
  starts.forEach((match, i) => {
    const stock = market[match[1]];
    if (!stock) throw new TypeError(`Unexpected market ticker ${match[1]}`);
    const end = starts[i + 1]?.index ?? text.lastIndexOf('\n}');
    let block = text.slice(match.index, end);
    const original = JSON.parse(`{${block.replace(/,\s*$/, '')}}`)[match[1]];
    for (const key of ['shares', 'shares_outstanding', 'shares_display', 'shareSource', 'shareBasis',
      'fin_valuation', 'liquidation', 'liq_val_1', 'liq_val_2', 'liq_val_3',
      'fair_val', 'default_fair_val', 'premium_pct', 'is_undervalued']) {
      if (JSON.stringify(stock[key]) === JSON.stringify(original[key])) continue;
      if (!Object.prototype.hasOwnProperty.call(stock, key)) continue;
      const marker = `\n    "${key}": `;
      const start = block.indexOf(marker);
      const value = JSON.stringify(stock[key], null, 2).replace(/\n/g, '\n    ');
      const closing = block.lastIndexOf('\n  }');
      if (start < 0) block = block.slice(0, closing) + ',' + marker + value + block.slice(closing);
      else {
        const next = block.indexOf('\n    "', start + marker.length);
        block = block.slice(0, start) + marker + value + (next < 0 ? '' : ',') + block.slice(next < 0 ? closing : next);
      }
    }
    result += block;
  });
  return result + text.slice(text.lastIndexOf('\n}'));
}

if (require.main === module) {
  const root = path.join(__dirname, '..'), directory = path.resolve(process.argv[2]);
  const market = JSON.parse(fs.readFileSync(path.join(root, 'full_market_dcf.json'), 'utf8'));
  const records = Object.fromEntries(Object.keys(market).map(ticker => [ticker,
    JSON.parse(fs.readFileSync(path.join(directory, `${ticker}.json`), 'utf8'))]));
  const financials = {};
  const rates = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'fx', 'usd_rates.json'), 'utf8'));
  for (const [ticker, stock] of Object.entries(market)) if (stock.fin_valuation?.is_financial) {
    financials[ticker] = convertStatements(JSON.parse(fs.readFileSync(path.join(root, 'cache', 'financials', `${ticker}_statements_v2.json`), 'utf8')), rates);
  }
  const updated = applyToMarket(market, records, financials);
  for (const file of ['full_market_dcf.json', 'market_data.js']) {
    const target = path.join(root, file);
    fs.writeFileSync(target, patchMarketText(fs.readFileSync(target, 'utf8'), updated));
  }
  const snapshotFile = path.join(root, 'cache', 'fcff_sources.json');
  const snapshots = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  const output = JSON.stringify(applyToSnapshots(snapshots, updated));
  fs.writeFileSync(snapshotFile, output + '\n');
  fs.writeFileSync(path.join(root, 'fcff_data.js'), `window.FCFF_DATA = ${output};\n`);
  console.log(`Applied ${Object.keys(updated).length} dated outstanding-share counts; no diluted-share denominator or market-cap/price fill.`);
}

module.exports = { applyToMarket, applyToSnapshots, patchMarketText };
