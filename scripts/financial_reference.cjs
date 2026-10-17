const fs = require('node:fs');
const path = require('node:path');
const { financialReference } = require('../fcf_ratios.js');
const { convertStatements } = require('../usd_currency.js');
const rates = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cache', 'fx', 'usd_rates.json'), 'utf8'));

if (process.argv.includes('--stdin')) {
  const { statements, shares, fxRate } = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(financialReference(convertStatements(statements, rates), { shares, fxRate })));
} else {
  const root = path.join(__dirname, '..');
  const file = path.join(root, 'full_market_dcf.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [ticker, stock] of Object.entries(data)) {
    if (!stock.fin_valuation?.is_financial) continue;
    const statements = JSON.parse(fs.readFileSync(
      path.join(root, 'cache', 'financials', `${ticker}_statements_v2.json`), 'utf8'));
    const reference = financialReference(convertStatements(statements, rates), { shares: stock.shares });
    const fin = stock.fin_valuation;
    fin.reference = reference;
    fin.rote = reference.rote;
    fin.tbvps = reference.tbvps;
    fin.pb_tangible = reference.tbvps > 0 ? stock.price / reference.tbvps : null;
    fin.excess_return_fair = reference.reason ? null
      : reference.tbvps * (1 + (reference.rote - fin.ke) / Math.max(fin.ke - fin.g, 2));
    stock.fair_val = fin.excess_return_fair === null ? null
      : Number((fin.excess_return_fair * 0.55 + fin.ddm_fair * 0.45).toFixed(2));
    stock.default_fair_val = stock.fair_val;
    stock.premium_pct = stock.fair_val > 0 ? (stock.price / stock.fair_val - 1) * 100 : null;
    stock.is_undervalued = stock.premium_pct === null ? null : stock.premium_pct < 0;
  }
  for (const target of [file, path.join(root, 'market_data.js')]) {
    let text = fs.readFileSync(target, 'utf8');
    for (const [ticker, stock] of Object.entries(data)) {
      if (!stock.fin_valuation?.is_financial) continue;
      const start = text.indexOf(`\n  "${ticker}": {`);
      if (start < 0) throw new Error(`Missing ${ticker} in ${target}`);
      const rest = text.slice(start + 1);
      const next = rest.slice(1).search(/\n  "[^"]+": \{/);
      const end = next < 0 ? text.length : start + next + 2;
      let block = text.slice(start, end);
      for (const field of ['fair_val', 'default_fair_val', 'premium_pct', 'is_undervalued']) {
        block = block.replace(new RegExp(`^(    "${field}": )[^\\n]+`, 'm'),
          (_, prefix) => `${prefix}${JSON.stringify(stock[field])},`);
      }
      block = block.replace(/^    "fin_valuation": \{[\s\S]*?^    \},?/m,
        () => `    "fin_valuation": ${JSON.stringify(stock.fin_valuation, null, 2).replace(/\n/g, '\n    ')},`);
      text = text.slice(0, start) + block + text.slice(end);
    }
    fs.writeFileSync(target, text);
  }
}
