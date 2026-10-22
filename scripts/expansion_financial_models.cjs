'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { convertStatements } = require('../usd_currency.js');
const { financialReference } = require('../fcf_ratios.js');
const FinancialModels = require('../financial_models.js');
const { usesFinancialValuationModel } = require('../financial_industry.js');

const root = path.resolve(__dirname, '..');
const rates = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'fx', 'usd_rates.json'), 'utf8'));

const aliases = {
  dividendsPaid: ['commonDividendsPaid', 'commonStockDividendsPaid', 'netDividendsPaid'],
  commonStockRepurchased: ['commonStockRepurchased']
};

function fieldValue(row, field) {
  if (!row) return null;
  for (const key of [field, ...(aliases[field] || [])]) {
    if (typeof row[key] === 'number' && Number.isFinite(row[key])) return row[key];
  }
  return null;
}

function totalQuarterly(rows, field) {
  if (rows.length !== 4) return null;
  const values = rows.map(row => fieldValue(row, field));
  if (values.some(value => value === null)) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function annualPayout(statements) {
  const rows = (statements.annual?.cashflow || []).slice()
    .filter(row => row.period === 'FY' || row.period === undefined)
    .sort((a, b) => b.date.localeCompare(a.date));
  for (const row of rows) {
    const dividends = fieldValue(row, 'dividendsPaid');
    const buybacks = fieldValue(row, 'commonStockRepurchased');
    const payout = FinancialModels.totalPayoutFromFlows(dividends, buybacks);
    if (payout != null && payout > 0) {
      return { payout, date: row.date, basis: 'latestCompleteAnnualWithPayout' };
    }
  }
  return { payout: null, date: null, basis: 'noAnnualPayout' };
}

function ttmPayout(statements) {
  const rows = (statements.quarterly?.cashflow || []).slice()
    .sort((a, b) => a.date.localeCompare(b.date)).slice(-4);
  const dividends = totalQuarterly(rows, 'dividendsPaid');
  const buybacks = totalQuarterly(rows, 'commonStockRepurchased');
  const payout = FinancialModels.totalPayoutFromFlows(dividends, buybacks);
  if (payout != null && payout > 0) {
    return { payout, date: rows.at(-1)?.date || null, basis: 'ttmQuarterly' };
  }
  return annualPayout(statements);
}

function applyFinancialValuation(stock, statements, { rates: fx = rates } = {}) {
  if (!usesFinancialValuationModel(stock.industry, stock.ticker)) {
    return { ...stock, fin_valuation: { ...(stock.fin_valuation || {}), is_financial: false } };
  }
  if (!(stock.shares > 0)) {
    return {
      ...stock,
      fin_valuation: {
        is_financial: true,
        unavailableReason: 'missingShares',
        reference: { reason: 'missingShares' }
      },
      fair_val: null,
      default_fair_val: null,
      premium_pct: null,
      is_undervalued: null
    };
  }
  const data = convertStatements(statements, fx);
  const reference = financialReference(data, { shares: stock.shares });
  const payoutInfo = ttmPayout(data);
  const dpsTotal = payoutInfo.payout == null ? null : payoutInfo.payout / (stock.shares * 1e6);
  const rf = Number.isFinite(stock.rf) ? stock.rf : 4.3;
  const erp = Number.isFinite(stock.erp) ? stock.erp : 4.75;
  const beta = Number.isFinite(stock.beta) ? stock.beta : 1;
  const capm = FinancialModels.capmKePercent({ rf, beta, erp });
  const fin = {
    is_financial: true,
    reference,
    rote: reference.rote,
    tbvps: reference.tbvps,
    bvps: reference.tbvps,
    g: Number.isFinite(stock.g) ? stock.g : 2.25,
    dps_total: dpsTotal,
    dps_source: payoutInfo.basis,
    dps_source_date: payoutInfo.date,
    pb_tangible: reference.tbvps > 0 && Number.isFinite(stock.price)
      ? stock.price / reference.tbvps : null,
    ke_floor_pct: FinancialModels.US_KE_FLOOR_PCT,
    ke_floor_applied: true
  };
  if (Number.isFinite(capm)) {
    fin.ke_capm = Number(capm.toFixed(4));
    fin.ke = Math.max(capm, FinancialModels.US_KE_FLOOR_PCT);
  }
  const valued = FinancialModels.valueFinancial(fin, { industry: stock.industry });
  fin.excess_return_fair = valued.excess_return_fair;
  fin.ddm_fair = valued.ddm_fair;
  const fair = valued.fair_val;
  return {
    ...stock,
    rf,
    erp,
    fin_valuation: fin,
    fair_val: fair,
    default_fair_val: fair,
    premium_pct: fair > 0 && Number.isFinite(stock.price) ? (stock.price / fair - 1) * 100 : null,
    is_undervalued: fair > 0 && Number.isFinite(stock.price) ? stock.price / fair - 1 < 0 : null
  };
}

function compactForExpansion(stock) {
  const compact = { ...stock };
  for (const key of ['statements_raw', 'real_history', 'news', 'top_holders', 'insider_trades',
    'stock_splits', 'historical_dcf_series', 'real_5y_prices', 'description', 'description_en',
    'description_zh', 'reported_growth']) {
    delete compact[key];
  }
  compact.f_score_breakdown = [];
  if (compact.moat && compact.ratingSources?.moat?.reason) compact.moat = null;
  else if (compact.moat) {
    compact.moat = Object.fromEntries(Object.entries(compact.moat).filter(([key]) =>
      /^m\d+_/.test(key) || key.startsWith('overall_moat_verdict')).map(([key, value]) =>
      [key, /^m\d+_/.test(key) ? { score: value.score } : value]));
  }
  return compact;
}

function repairExpansionFinancials(directory = root) {
  const companiesDir = path.join(directory, 'cache', 'us_companies');
  const expansionFile = path.join(directory, 'us_expansion_data.js');
  const context = { window: {} };
  require('node:vm').runInNewContext(fs.readFileSync(expansionFile, 'utf8'), context);
  const expansion = context.window.US_EXPANSION;
  let updated = 0;
  for (const file of fs.readdirSync(companiesDir)) {
    if (!/^[A-Z0-9.-]+\.json$/.test(file)) continue;
    const target = path.join(companiesDir, file);
    const record = JSON.parse(fs.readFileSync(target, 'utf8'));
    const ticker = record.ticker;
    const stock = record.stock;
    if (!stock || !usesFinancialValuationModel(stock.industry, ticker)) continue;
    const statementsPath = path.join(directory, 'cache', 'financials', `${ticker}_statements_v2.json`);
    if (!fs.existsSync(statementsPath)) continue;
    const statements = JSON.parse(fs.readFileSync(statementsPath, 'utf8'));
    const valued = applyFinancialValuation({ ...stock, ticker }, statements);
    record.stock = valued;
    fs.writeFileSync(target, `${JSON.stringify(record)}\n`);
    if (expansion.stocks[ticker]) {
      expansion.stocks[ticker] = compactForExpansion(valued);
    }
    updated++;
  }
  fs.writeFileSync(expansionFile, `window.US_EXPANSION = ${JSON.stringify(expansion)};\n`);
  return updated;
}

module.exports = {
  applyFinancialValuation, compactForExpansion, repairExpansionFinancials, ttmPayout, annualPayout
};

if (require.main === module) {
  const count = repairExpansionFinancials();
  console.log(`Applied financial valuation models to ${count} US expansion banks/insurers.`);
}
