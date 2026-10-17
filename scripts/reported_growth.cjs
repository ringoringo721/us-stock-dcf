const fs = require('node:fs');
const path = require('node:path');
const { convertStatements } = require('../usd_currency.js');
const { calculate, growth } = require('../profile_overview.js');
const fields = {
  revenue: 'income', grossProfit: 'income', operatingIncome: 'income', netIncome: 'income',
  ebitda: 'income', epsDiluted: 'income', operatingCashFlow: 'cashflow', freeCashFlow: 'cashflow'
};

function reportedGrowth(source, rates) {
  const data = convertStatements(source, rates);
  return {
    version: 1, currency: 'USD', basis: 'TTM versus prior-year TTM', date: calculate(data).date,
    fields: Object.fromEntries(Object.entries(fields).map(([field, statement]) => [field, growth(data, statement, field)]))
  };
}

function main() {
  const root = path.join(__dirname, '..');
  const market = JSON.parse(fs.readFileSync(path.join(root, 'full_market_dcf.json'), 'utf8'));
  const rates = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'fx', 'usd_rates.json'), 'utf8'));
  const records = {};
  for (const ticker of Object.keys(market)) {
    const source = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'financials', `${ticker}_statements_v2.json`), 'utf8'));
    records[ticker] = reportedGrowth(source, rates);
  }
  for (const file of ['full_market_dcf.json', 'market_data.js']) {
    const target = path.join(root, file);
    const original = fs.readFileSync(target, 'utf8');
    const text = original.replace(/\r\n/g, '\n').replace(/\n    "reported_growth": \{[\s\S]*?\n    \},/g, '');
    let count = 0;
    const updated = text.replace(/\n  "([^"]+)": \{/g, (match, ticker) => {
      if (!records[ticker]) throw new Error(`Missing reported growth for ${ticker}`);
      count++;
      return `${match}\n    "reported_growth": ${JSON.stringify(records[ticker], null, 2).replace(/\n/g, '\n    ')},`;
    });
    if (count !== Object.keys(market).length) throw new Error(`Incomplete stock records in ${file}`);
    if (updated !== original) {
      const temporary = `${target}.growth-${process.pid}.tmp`;
      try {
        fs.writeFileSync(temporary, updated);
        fs.renameSync(temporary, target);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    }
  }
  console.log(`Reported growth refreshed for ${Object.keys(records).length} stocks using eight real, aligned USD quarters`);
}
if (require.main === module) main();
module.exports = { reportedGrowth, fields };
