const fs = require('node:fs');
const path = require('node:path');
const { convertStatements } = require('../usd_currency.js');
const { calculateReturns, financialReference } = require('../fcf_ratios.js');

const aliases = {
  epsdiluted: ['epsDiluted'], ebitdaratio: ['ebitdaRatio'],
  netCashProvidedByOperatingActivities: ['netCashProvidedByOperatingActivities', 'operatingCashFlow'],
  netCashUsedForInvestingActivites: ['netCashProvidedByInvestingActivities', 'netCashUsedForInvestingActivities'],
  netCashUsedProvidedByFinancingActivities: ['netCashProvidedByFinancingActivities'],
  otherInvestingActivites: ['otherInvestingActivities'], otherFinancingActivites: ['otherFinancingActivities'],
  dividendsPaid: ['commonDividendsPaid', 'commonStockDividendsPaid', 'netDividendsPaid'],
  tradeAccountsReceivables: ['accountsReceivables', 'netReceivables']
};
const ratios = { grossProfitRatio: 'grossProfit', operatingIncomeRatio: 'operatingIncome',
  incomeBeforeTaxRatio: 'incomeBeforeTax', netIncomeRatio: 'netIncome', ebitdaratio: 'ebitda' };
const value = (row, field) => {
  if (!row) return null;
  if (ratios[field]) {
    const numerator = value(row, ratios[field]), denominator = value(row, 'revenue');
    return numerator === null || !denominator ? null : numerator / denominator;
  }
  for (const key of [field, ...(aliases[field] || [])]) {
    if (typeof row[key] === 'number' && Number.isFinite(row[key])) return row[key];
  }
  return null;
};
function total(rows, field, type) {
  if (rows.length !== 4 || rows.some((row, i) => i && (
    Number(row.fiscalYear || row.calendarYear) * 4 + Number(row.period[1])
      !== Number(rows[i - 1].fiscalYear || rows[i - 1].calendarYear) * 4 + Number(rows[i - 1].period[1]) + 1
    ||
    (Date.parse(row.date) - Date.parse(rows[i - 1].date)) / 86400000 < 60
    || (Date.parse(row.date) - Date.parse(rows[i - 1].date)) / 86400000 > 120))) return null;
  const values = rows.map(row => value(row, field));
  if (values.some(v => v === null)) return null;
  if (type === 'balance' || field === 'cashAtEndOfPeriod') return values.at(-1);
  if (field === 'cashAtBeginningOfPeriod') return values[0];
  if (ratios[field]) {
    const numerator = total(rows, ratios[field], type), denominator = total(rows, 'revenue', type);
    return numerator === null || !denominator ? null : numerator / denominator;
  }
  const sum = values.reduce((a, b) => a + b, 0);
  return /^weightedAverageShs/.test(field) ? sum / 4 : sum;
}
const ratio = (a, b, scale = 1) => a === null || b === null || b === 0 ? null : a / b * scale;

function normalizeStock(stock, source, rates) {
  const data = convertStatements(source, rates);
  const output = structuredClone(stock);
  const sorted = (period, type) => data[period][type].slice().sort((a, b) => a.date.localeCompare(b.date));
  const latest = type => sorted('quarterly', type).at(-1);
  const recent = type => sorted('quarterly', type).slice(-4);
  const bs = latest('balance');
  const income = latest('income');
  if (!bs || !income || !latest('cashflow')) throw new Error('USD normalization requires dated quarterly income, balance and cash-flow statements');
  const millions = n => n === null ? null : n / 1e6;
  const flow = (type, field) => total(recent(type), field, type);
  const balance = field => value(bs, field);
  const dates = [income, bs, latest('cashflow')];
  let reason = [...recent('income'), ...recent('cashflow'), bs]
    .find(row => row.currencyConversion.reason)?.currencyConversion.reason
    || (new Set(dates.map(row => row.date)).size !== 1 ? 'dateMismatch' : null);
  output.calculationCurrency = 'USD';
  output.currencyConversion = {
    sourceCurrency: stock.reportedCurrency, target: 'USD', source: rates.source, prepared: rates.prepared,
    income: income.currencyConversion, balance: bs.currencyConversion, cashflow: latest('cashflow').currencyConversion, reason
  };
  const raw = output.statements_raw;
  const annualIncome = sorted('annual', 'income').slice(-5);
  const quarterlyIncome = sorted('quarterly', 'income').slice(-20);
  for (const type of ['income', 'balance', 'cashflow']) {
    const annual = annualIncome.map(row => data.annual[type].find(other => other.date === row.date));
    const quarters = quarterlyIncome.map(row => data.quarterly[type].find(other => other.date === row.date));
    for (const field of Object.keys(raw[type])) {
      const unscaled = /^weightedAverageShs/.test(field) || /ratio$/i.test(field) || /^eps/i.test(field);
      const scale = n => n === null ? null : unscaled ? n : n / 1e6;
      raw[type][field] = [...annual.map(row => scale(value(row, field))), scale(type === 'balance'
        ? value(bs, field) : flow(type, field))];
      raw.quarterly_raw[type][field] = quarters.map(row => scale(value(row, field)));
    }
  }
  raw.annual_dates = [...annualIncome.map(row => row.date.slice(0, 7)), income.date.slice(0, 7)];
  raw.quarterly_raw.dates = sorted('quarterly', 'income').slice(-20).map(row => row.date.slice(0, 7));
  raw.quarterly_raw.periods = sorted('quarterly', 'income').slice(-20).map(row => `${row.fiscalYear || row.calendarYear}${row.period}`);
  raw.tradeAccountsReceivables = raw.balance.tradeAccountsReceivables;
  raw.vendorNonTradeReceivables = raw.balance.vendorNonTradeReceivables;
  raw.quarterly_raw.tradeAccountsReceivables = raw.quarterly_raw.balance.tradeAccountsReceivables;
  raw.quarterly_raw.vendorNonTradeReceivables = raw.quarterly_raw.balance.vendorNonTradeReceivables;
  raw.calculationCurrency = 'USD';
  const fxMissing = rows => rows.some(row => row.currencyConversion.reason);
  raw.fxUnavailable = [...annualIncome.map(row => Object.values(data.annual).filter(Array.isArray).flat()
    .filter(other => other.date === row.date).some(other => other.currencyConversion.reason)),
  fxMissing([...recent('income'), ...recent('cashflow'), bs])];
  raw.quarterly_raw.fxUnavailable = sorted('quarterly', 'income').slice(-20).map(row =>
    Object.values(data.quarterly).filter(Array.isArray).flat()
      .filter(other => other.date === row.date).some(other => other.currencyConversion.reason));
  output.debt = millions(balance('totalDebt'));
  output.cash = millions(balance('cashAndCashEquivalents'));
  output.short_term_investments = millions(balance('shortTermInvestments'));
  output.cash_and_short_term = millions(balance('cashAndShortTermInvestments'));
  output.net_debt = output.debt === null || output.cash_and_short_term === null ? null : output.debt - output.cash_and_short_term;
  output.fcf0 = millions(flow('cashflow', 'freeCashFlow'));
  if (!reason && (![output.fcf0, output.debt, output.cash_and_short_term, stock.shares].every(Number.isFinite) || stock.shares <= 0)) {
    reason = 'missingFinancialData';
  }
  output.currencyConversion.reason = reason;
  const revenue = millions(flow('income', 'revenue'));
  const netIncome = millions(flow('income', 'netIncome'));
  const ebitda = millions(flow('income', 'ebitda'));
  const equity = millions(balance('totalStockholdersEquity'));
  output.ev = output.net_debt === null ? null : output.mcap + output.net_debt;
  output.fmp_official_ev = output.ev;
  output.enterpriseValueBasis = 'USD market capitalization + USD debt - USD cash and short-term investments';
  output.pe_trailing = ratio(output.mcap, netIncome);
  output.pb_trailing = ratio(output.mcap, equity);
  output.pe_forward = output.pe_trailing === null ? null : output.pe_trailing * 0.88;
  output.pb_forward = output.pb_trailing === null ? null : output.pb_trailing * 0.9;
  output.ps_ratio = ratio(output.mcap, revenue);
  output.ev_to_ebitda = ratio(output.ev, ebitda);
  output.debt_to_ebitda = ratio(output.debt, ebitda);
  output.net_debt_to_ebitda = ratio(output.net_debt, ebitda);
  output.fcf_to_ev = ratio(output.fcf0, output.ev, 100);
  output.fcf_to_mcap = ratio(output.fcf0, output.mcap, 100);
  const dividends = flow('cashflow', 'dividendsPaid');
  output.div_yield = ratio(dividends === null ? null : -dividends / 1e6, output.mcap, 100);
  const returns = calculateReturns(data).at(-1);
  output.roe = returns.ratios.roe.value;
  output.roa = returns.ratios.roa.value;
  output.liab_to_assets = ratio(balance('totalLiabilities'), balance('totalAssets'), 100);
  output.cash_to_assets = ratio(balance('cashAndShortTermInvestments'), balance('totalAssets'), 100);
  output.current_ratio = ratio(balance('totalCurrentAssets'), balance('totalCurrentLiabilities'));
  const subtraction = (a, b) => a === null || b === null ? null : a - b;
  const liabilities = millions(balance('totalLiabilities'));
  output.liq_val_1 = ratio(subtraction(millions(balance('totalCurrentAssets')), liabilities), stock.shares);
  const receivables = millions(balance('netReceivables')), inventory = millions(balance('inventory'));
  output.liq_val_2 = receivables === null || inventory === null || output.cash_and_short_term === null || liabilities === null
    ? null : (receivables * 0.8 + inventory * 0.5 + output.cash_and_short_term - liabilities) / stock.shares;
  output.liq_val_3 = ratio(subtraction(output.cash_and_short_term, liabilities), stock.shares);
  for (const [field, type, sourceField, negative] of [
    ['revenue', 'income', 'revenue'], ['net_income', 'income', 'netIncome'],
    ['gross_profit', 'income', 'grossProfit'], ['operating_income', 'income', 'operatingIncome'],
    ['cfo', 'cashflow', 'operatingCashFlow'], ['capex', 'cashflow', 'capitalExpenditure', true],
    ['fcf', 'cashflow', 'freeCashFlow']
  ]) {
    const transform = amount => amount === null ? null : (negative ? -Math.abs(amount) : amount) / 1e6;
    output.real_history[field] = [...sorted('annual', type).slice(-5).map(row => transform(value(row, sourceField))),
      transform(flow(type, sourceField))];
  }
  const ke = (stock.rf ?? 4.3) / 100 + stock.beta * (stock.erp ?? 4.75) / 100;
  const wacc = stock.mcap / (stock.mcap + output.debt) * ke
    + output.debt / (stock.mcap + output.debt) * stock.kd / 100 * (1 - stock.tax / 100);
  output.wacc = reason ? null : wacc * 100;
  let fcf = output.fcf0 === null ? NaN : output.fcf0, pv = 0;
  for (const [i, growth] of stock.growth_10y.entries()) { fcf *= 1 + growth / 100; pv += fcf / (1 + wacc) ** (i + 1); }
  const g = stock.g / 100, safeWacc = Math.max(wacc, g + 0.015);
  output.dcf_model_ev = reason || !Number.isFinite(fcf) ? null : pv + fcf * (1 + g) / (safeWacc - g) / (1 + wacc) ** 10;
  output.fair_val = output.dcf_model_ev === null || output.net_debt === null ? null
    : Math.max((output.dcf_model_ev - output.net_debt) / stock.shares, 0.01);
  if (output.fin_valuation.is_financial) {
    const reference = financialReference(data, { shares: stock.shares });
    const fin = output.fin_valuation;
    fin.reference = reference; fin.rote = reference.rote; fin.tbvps = reference.tbvps;
    const buybacks = flow('cashflow', 'commonStockRepurchased');
    fin.dps_total = dividends === null || buybacks === null ? null : (Math.abs(dividends) + Math.abs(buybacks)) / (stock.shares * 1e6);
    fin.pb_tangible = ratio(stock.price, reference.tbvps);
    fin.excess_return_fair = reference.reason ? null : reference.tbvps * (1 + (reference.rote - fin.ke) / Math.max(fin.ke - fin.g, 2));
    let dividend = fin.dps_total, ddm = 0;
    for (let year = 1; year <= 5; year++) { dividend *= 1.065; ddm += dividend / (1 + fin.ke / 100) ** year; }
    fin.ddm_fair = fin.dps_total === null ? null : ddm + dividend * (1 + fin.g / 100)
      / Math.max((fin.ke - fin.g) / 100, 0.02) / (1 + fin.ke / 100) ** 5;
    output.fair_val = reference.reason || fin.ddm_fair === null ? null : fin.excess_return_fair * 0.55 + fin.ddm_fair * 0.45;
  }
  output.default_fair_val = output.fair_val;
  output.premium_pct = output.fair_val === null ? null : (stock.price / output.fair_val - 1) * 100;
  output.is_undervalued = output.premium_pct === null ? null : output.premium_pct < 0;
  return output;
}

function main() {
  const root = path.join(__dirname, '..');
  const files = ['full_market_dcf.json', 'market_data.js'];
  const market = JSON.parse(fs.readFileSync(path.join(root, files[0]), 'utf8'));
  const rates = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'fx', 'usd_rates.json'), 'utf8'));
  for (const [ticker, stock] of Object.entries(market)) {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'financials', `${ticker}_statements_v2.json`), 'utf8'));
    const foreign = ['annual', 'quarterly'].some(period => Object.values(raw[period] || {})
      .filter(Array.isArray).flat().some(row => row.reportedCurrency !== 'USD'));
    if (!foreign && stock.reportedCurrency === 'USD') continue;
    const normalized = normalizeStock(stock, raw, rates);
    for (const file of files) {
      const target = path.join(root, file);
      const text = fs.readFileSync(target, 'utf8');
      const start = text.indexOf(`\n  "${ticker}": {`);
      if (start < 0) throw new Error(`Missing ${ticker} in ${file}`);
      const next = text.indexOf('\n  "', start + 1);
      const end = next < 0 ? text.lastIndexOf('\n}') : next;
      const block = `\n  "${ticker}": ${JSON.stringify(normalized, null, 2).replace(/\n/g, '\n  ')}${next < 0 ? '' : ','}`;
      fs.writeFileSync(target, text.slice(0, start) + block + text.slice(end));
    }
    console.log(`${ticker}: ${stock.reportedCurrency} → USD; ${normalized.currencyConversion.reason || 'period-specific FX verified'}`);
  }
}
if (require.main === module) {
  if (process.argv.includes('--statements')) {
    const root = path.join(__dirname, '..');
    const rates = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'fx', 'usd_rates.json'), 'utf8'));
    process.stdout.write(JSON.stringify(convertStatements(JSON.parse(fs.readFileSync(0, 'utf8')), rates)));
  } else main();
}
module.exports = { normalizeStock };
