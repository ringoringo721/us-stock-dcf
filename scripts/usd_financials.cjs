const fs = require('node:fs');
const path = require('node:path');
const { convertStatements } = require('../usd_currency.js');
const { calculateReturns, financialReference } = require('../fcf_ratios.js');
const FinancialModels = require('../financial_models.js');
const { normalizeBankStatements } = require('../financial_industry.js');

// Keep in sync with build_full_market.py STATEMENT_FIELD_ALIASES (USD-native path).
const aliases = {
  epsdiluted: ['epsDiluted'], ebitdaratio: ['ebitdaRatio'],
  netCashProvidedByOperatingActivities: ['netCashProvidedByOperatingActivities', 'operatingCashFlow'],
  netCashUsedForInvestingActivites: ['netCashProvidedByInvestingActivities', 'netCashUsedForInvestingActivities'],
  netCashUsedProvidedByFinancingActivities: ['netCashProvidedByFinancingActivities'],
  otherInvestingActivites: ['otherInvestingActivities'], otherFinancingActivites: ['otherFinancingActivities'],
  dividendsPaid: ['commonDividendsPaid', 'commonStockDividendsPaid', 'netDividendsPaid'],
  commonStockIssued: ['commonStockIssuance'],
  debtRepayment: ['netDebtIssuance'],
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
function total(rows, field, type, { count = 4, stride = 1, minDays = 60, maxDays = 120 } = {}) {
  if (rows.length !== count || rows.some((row, i) => i && (
    Number(row.fiscalYear || row.calendarYear) * 4 + Number(row.period[1])
      !== Number(rows[i - 1].fiscalYear || rows[i - 1].calendarYear) * 4
        + Number(rows[i - 1].period[1]) + stride
    ||
    (Date.parse(row.date) - Date.parse(rows[i - 1].date)) / 86400000 < minDays
    || (Date.parse(row.date) - Date.parse(rows[i - 1].date)) / 86400000 > maxDays))) return null;
  const values = rows.map(row => value(row, field));
  if (values.some(v => v === null)) return null;
  if (type === 'balance' || field === 'cashAtEndOfPeriod') return values.at(-1);
  if (field === 'cashAtBeginningOfPeriod') return values[0];
  if (ratios[field]) {
    const numerator = total(rows, ratios[field], type, { count, stride, minDays, maxDays });
    const denominator = total(rows, 'revenue', type, { count, stride, minDays, maxDays });
    return numerator === null || !denominator ? null : numerator / denominator;
  }
  const sum = values.reduce((a, b) => a + b, 0);
  return /^weightedAverageShs/.test(field) ? sum / count : sum;
}
const ratio = (a, b, scale = 1) => {
  const result = Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b * scale : null;
  return Number.isFinite(result) ? result : null;
};
const balanceRatioFields = ['pb_trailing', 'current_ratio', 'cash_to_assets', 'liab_to_assets', 'roe', 'roa'];

function marketBalanceRatios(stock, data) {
  const balance = [...data.annual.balance, ...data.quarterly.balance].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  const returns = calculateReturns(data).at(-1);
  const sources = { ...stock.marketRatioSources };
  const metric = (numerator, denominator, basis, scale = 1) => {
    let reason = !balance ? 'missingBalance' : balance.currencyConversion?.reason ? 'missingFx'
      : !Number.isFinite(numerator) || !Number.isFinite(denominator) ? 'missingField'
        : denominator === 0 ? 'zeroDenominator' : null;
    const amount = reason ? null : ratio(numerator, denominator, scale);
    if (!reason && amount === null) reason = 'invalidCalculation';
    return { value: amount,
      source: { basis, date: balance?.date || null, reason } };
  };
  const equity = value(balance, 'totalStockholdersEquity');
  const ratios = {
    pb_trailing: metric(Number.isFinite(stock.mcap) && stock.mcap > 0 ? stock.mcap : null,
      equity === null ? null : equity / 1e6, 'marketCapOverReportedParentEquity'),
    current_ratio: metric(value(balance, 'totalCurrentAssets'), value(balance, 'totalCurrentLiabilities'),
      'reportedCurrentAssetsOverCurrentLiabilities'),
    cash_to_assets: metric(value(balance, 'cashAndShortTermInvestments'), value(balance, 'totalAssets'),
      'reportedCashAndShortTermInvestmentsOverAssets', 100),
    liab_to_assets: metric(value(balance, 'totalLiabilities'), value(balance, 'totalAssets'),
      'reportedLiabilitiesOverAssets', 100)
  };
  ratios.pb_trailing.source.bookEquity = equity;
  ratios.pb_trailing.source.preferredEquityDeducted = false;
  const output = {};
  for (const [field, result] of Object.entries(ratios)) {
    output[field] = result.value;
    sources[field === 'pb_trailing' ? 'pb' : field] = result.source;
  }
  for (const field of ['roe', 'roa']) {
    const result = returns?.ratios[field];
    output[field] = result?.value ?? null;
    sources[field] = { basis: field === 'roe' ? 'ttmNetIncomeOverBeginningParentEquity'
      : 'ttmNetIncomeOverBeginningAssets', date: returns?.date || null,
      reason: result?.reason || (result ? null : 'missingPeriod'), warnings: result?.warnings || [] };
  }
  output.marketRatioSources = sources;
  return output;
}

function updateRatioBlocks(text, updates) {
  const starts = [...text.matchAll(/\n  "([^"]+)": \{/g)];
  if (starts.length !== Object.keys(updates).length) throw new Error('Incomplete market-ratio output');
  const end = text.lastIndexOf('\n}');
  const chunks = [text.slice(0, starts[0].index)];
  for (const [i, match] of starts.entries()) {
    const ticker = match[1], update = updates[ticker];
    if (!update) throw new Error(`Missing market ratios for ${ticker}`);
    let block = text.slice(match.index, starts[i + 1]?.index ?? end);
    for (const field of balanceRatioFields) {
      const pattern = new RegExp(`^(    "${field}": )[^\\n]+`, 'm');
      if (!pattern.test(block)) throw new Error(`${ticker}: missing ${field}`);
      block = block.replace(pattern, (_, prefix) => `${prefix}${JSON.stringify(update[field])},`);
    }
    const metadata = `    "marketRatioSources": ${JSON.stringify(update.marketRatioSources, null, 2).replace(/\n/g, '\n    ')},`;
    const existing = /^    "marketRatioSources": \{[\s\S]*?^    \},/m;
    if (existing.test(block)) block = block.replace(existing, () => metadata);
    else {
      if (!/^    "name":/m.test(block)) throw new Error(`${ticker}: missing record boundary`);
      block = block.replace(/^    "name":/m, () => `${metadata}\n    "name":`);
    }
    chunks.push(block);
  }
  chunks.push(text.slice(end));
  return chunks.join('');
}

function refreshMarketRatios(root, { force = false, dryRun = false } = {}) {
  const market = JSON.parse(fs.readFileSync(path.join(root, 'full_market_dcf.json'), 'utf8'));
  const rates = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'fx', 'usd_rates.json'), 'utf8'));
  const updates = {};
  const skipped = [];
  for (const [ticker, stock] of Object.entries(market)) {
    const source = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'financials', `${ticker}_statements_v2.json`), 'utf8'));
    const rollback = wouldRollbackQuarterWindow(stock, source);
    if (rollback && !force) {
      // Keep published Qn ratios aligned with cash/debt/fcf0; do not patch from older cache.
      skipped.push(ticker);
      continue;
    }
    updates[ticker] = marketBalanceRatios(stock, convertStatements(source, rates));
  }
  if (dryRun || !Object.keys(updates).length) {
    if (!dryRun) {
      console.log(`Skipped statement-backed ratio refresh for ${skipped.length} listings with newer published windows; no files changed.`);
    }
    return { updated: Object.keys(updates).length, skipped, dryRun: !!dryRun };
  }
  for (const file of ['full_market_dcf.json', 'market_data.js']) {
    const target = path.join(root, file);
    const original = fs.readFileSync(target, 'utf8');
    // updateRatioBlocks requires every market ticker; merge skips as no-op keep-current.
    const merged = { ...Object.fromEntries(skipped.map(ticker => {
      const stock = market[ticker];
      return [ticker, Object.fromEntries([
        ...['pb_trailing', 'current_ratio', 'cash_to_assets', 'liab_to_assets', 'roe', 'roa']
          .map(field => [field, stock[field]]),
        ['marketRatioSources', stock.marketRatioSources]
      ])];
    })), ...updates };
    const updated = updateRatioBlocks(original, merged);
    if (updated === original) continue;
    const temporary = `${target}.ratios-${process.pid}.tmp`;
    fs.writeFileSync(temporary, updated);
    fs.renameSync(temporary, target);
  }
  console.log(`Refreshed statement-backed balance/return ratios for ${Object.keys(updates).length} US listings`
    + (skipped.length ? `; skipped ${skipped.length} newer-window (${skipped.join(', ')})` : '')
    + '; no DCF inputs changed.');
  return { updated: Object.keys(updates).length, skipped };
}

function normalizeStock(stock, source, rates) {
  const data = normalizeBankStatements(convertStatements(source, rates), stock.industry, stock.ticker);
  const balanceMetrics = marketBalanceRatios(stock, data);
  const output = structuredClone(stock);
  const sorted = (period, type) => data[period][type].slice().sort((a, b) => a.date.localeCompare(b.date));
  const latest = type => sorted('quarterly', type).at(-1);
  const frequency = data.reportingFrequency || 'quarterly';
  const stride = frequency === 'semiannual' ? 2 : 1;
  const count = frequency === 'semiannual' ? 2 : 4;
  const cadenceOpts = {
    count, stride,
    minDays: frequency === 'semiannual' ? 150 : 60,
    maxDays: frequency === 'semiannual' ? 220 : 120
  };
  // Pick the trailing cadence window by fiscal period keys (Q2/Q4 half-years stride by 2).
  const recent = type => {
    const rows = sorted('quarterly', type);
    if (rows.length < count) return rows.slice(-count);
    const key = row => Number(row.fiscalYear || row.calendarYear) * 4 + Number(row.period[1]);
    const end = key(rows.at(-1));
    return Array.from({ length: count }, (_, i) => {
      const want = end - (count - 1 - i) * stride;
      return rows.find(row => key(row) === want);
    }).filter(Boolean);
  };
  const bs = latest('balance');
  const income = latest('income');
  if (!bs || !income || !latest('cashflow')) throw new Error('USD normalization requires dated quarterly income, balance and cash-flow statements');
  const millions = n => n === null ? null : n / 1e6;
  const flow = (type, field) => total(recent(type), field, type, cadenceOpts);
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
  output.ev = output.net_debt === null ? null : output.mcap + output.net_debt;
  output.fmp_official_ev = output.ev;
  output.enterpriseValueBasis = 'USD market capitalization + USD debt - USD cash and short-term investments';
  output.pe_trailing = ratio(output.mcap, netIncome);
  output.pb_trailing = balanceMetrics.pb_trailing;
  output.pe_forward = output.pe_trailing === null ? null : output.pe_trailing * 0.88;
  output.pb_forward = output.pb_trailing === null ? null : output.pb_trailing * 0.9;
  output.ps_ratio = ratio(output.mcap, revenue);
  output.ev_to_ebitda = ratio(output.ev, ebitda);
  output.debt_to_ebitda = ratio(output.debt, ebitda);
  output.net_debt_to_ebitda = ratio(output.net_debt, ebitda);
  output.debt_to_fcf = output.fcf0 != null && output.fcf0 > 0 ? ratio(output.debt, output.fcf0) : null;
  output.net_debt_to_fcf = output.fcf0 != null && output.fcf0 > 0 ? ratio(output.net_debt, output.fcf0) : null;
  output.fcf_to_ev = ratio(output.fcf0, output.ev, 100);
  output.fcf_to_mcap = ratio(output.fcf0, output.mcap, 100);
  const dividends = flow('cashflow', 'dividendsPaid');
  output.div_yield = ratio(dividends === null ? null : -dividends / 1e6, output.mcap, 100);
  Object.assign(output, balanceMetrics);
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
    const payout = FinancialModels.totalPayoutFromFlows(dividends, buybacks);
    fin.dps_total = payout === null || !(stock.shares > 0) ? null : payout / (stock.shares * 1e6);
    fin.pb_tangible = ratio(stock.price, reference.tbvps);
    const capm = FinancialModels.capmKePercent(stock);
    if (Number.isFinite(capm)) {
      fin.ke_capm = Number(capm.toFixed(4));
      fin.ke_floor_pct = FinancialModels.US_KE_FLOOR_PCT;
      if (fin.ke_floor_applied !== false) {
        fin.ke_floor_applied = true;
        fin.ke = Math.max(capm, FinancialModels.US_KE_FLOOR_PCT);
      }
    }
    const valued = FinancialModels.valueFinancial(fin, { industry: stock.industry });
    fin.excess_return_fair = valued.excess_return_fair;
    fin.ddm_fair = valued.ddm_fair;
    output.fair_val = valued.fair_val;
  }
  output.default_fair_val = output.fair_val;
  output.premium_pct = output.fair_val === null ? null : (stock.price / output.fair_val - 1) * 100;
  output.is_undervalued = output.premium_pct === null ? null : output.premium_pct < 0;
  return output;
}

function latestStatementDate(source, period = 'quarterly') {
  const dates = ['income', 'balance', 'cashflow']
    .flatMap(type => (source?.[period]?.[type] || []).map(row => row?.date).filter(Boolean));
  return dates.sort().at(-1) || null;
}

/** Published financials tab window as YYYY-MM (not calendar month-end). */
function publishedQuarterYm(stock) {
  const dates = stock?.statements_raw?.quarterly_raw?.dates;
  if (!Array.isArray(dates) || !dates.length) return null;
  const ym = dates.at(-1);
  return typeof ym === 'string' && /^\d{4}-\d{2}$/.test(ym) ? ym : null;
}

/** @deprecated Prefer publishedQuarterYm — month-end synthesis false-stales mid-month filings. */
function publishedQuarterEnd(stock) {
  const ym = publishedQuarterYm(stock);
  if (!ym) return null;
  const [year, month] = ym.split('-').map(Number);
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Refuse rewrites when on-disk statements lag the published quarter *month*.
 * Compare YYYY-MM only: inventing calendar month-end for published "2026-09"
 * would treat a current cache row dated 2026-09-27 as stale vs 2026-09-30.
 */
function wouldRollbackQuarterWindow(stock, source) {
  const published = publishedQuarterYm(stock);
  const cachedDate = latestStatementDate(source, 'quarterly');
  const cached = cachedDate && /^\d{4}-\d{2}-\d{2}$/.test(cachedDate) ? cachedDate.slice(0, 7) : null;
  if (!published || !cached) return null;
  return cached < published ? { published, cached, cachedDate } : null;
}

function main() {
  const root = path.join(__dirname, '..');
  const files = ['full_market_dcf.json', 'market_data.js'];
  const force = process.argv.includes('--force');
  const market = JSON.parse(fs.readFileSync(path.join(root, files[0]), 'utf8'));
  const rates = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'fx', 'usd_rates.json'), 'utf8'));
  for (const [ticker, stock] of Object.entries(market)) {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'financials', `${ticker}_statements_v2.json`), 'utf8'));
    const foreign = ['annual', 'quarterly'].some(period => Object.values(raw[period] || {})
      .filter(Array.isArray).flat().some(row => row.reportedCurrency !== 'USD'));
    if (!foreign && stock.reportedCurrency === 'USD') continue;
    const rollback = wouldRollbackQuarterWindow(stock, raw);
    if (rollback && !force) {
      console.log(`${ticker}: skip USD rewrite; statements cache month ${rollback.cached} lags published ${rollback.published} (pass --force to override)`);
      continue;
    }
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
  if (process.argv.includes('--market-ratios')) {
    refreshMarketRatios(path.join(__dirname, '..'), { force: process.argv.includes('--force') });
  } else if (process.argv.includes('--statements')) {
    const root = path.join(__dirname, '..');
    const rates = JSON.parse(fs.readFileSync(path.join(root, 'cache', 'fx', 'usd_rates.json'), 'utf8'));
    process.stdout.write(JSON.stringify(convertStatements(JSON.parse(fs.readFileSync(0, 'utf8')), rates)));
  } else main();
}
module.exports = {
  normalizeStock, value, marketBalanceRatios, updateRatioBlocks, refreshMarketRatios,
  latestStatementDate, publishedQuarterYm, publishedQuarterEnd, wouldRollbackQuarterWindow
};
