(function (root, factory) {
  const api = factory(
    () => typeof module === 'object' && module.exports ? require('./fcf_ratios.js') : root.FcfRatios,
    () => typeof module === 'object' && module.exports ? require('./profile_overview.js') : root.ProfileOverview,
    () => typeof module === 'object' && module.exports ? require('./financial_industry.js') : root.FinancialIndustry);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PeerComparison = api;
})(typeof globalThis === 'object' ? globalThis : this, function (returnsEngine, growthEngine, financialIndustry) {
  'use strict';
  const industryApi = () => financialIndustry();
  // Comparison families broaden coverage; membership does not imply direct competition.
  const families = [
    ['Technology Hardware, Storage & Peripherals', 'Communications Equipment', 'Electronic Equipment & Instruments', 'Electronic Components'],
    ['Semiconductors', 'Semiconductor Materials & Equipment'],
    ['Systems Software', 'Application Software', 'IT Consulting & Other Services', 'Data Processing & Outsourced Services'],
    ['Wireless Telecommunication Services', 'Integrated Telecommunication Services', 'Cable & Satellite', 'Alternative Carriers'],
    ['Interactive Media & Services', 'Movies & Entertainment', 'Interactive Home Entertainment'],
    ['Broadline Retail', 'Home Improvement Retail', 'Apparel Retail', 'Specialty Stores', 'Footwear'],
    ['Automobile Manufacturers', 'Automotive Retail'],
    ['Restaurants', 'Hotels, Resorts & Cruise Lines', 'Casinos & Gaming', 'Personal Services'],
    ['Multi-Sector Holdings', 'Transaction & Payment Processing Services', 'Investment Banking & Brokerage',
      'Consumer Finance', 'Asset Management & Custody Banks', 'Financial Exchanges & Data'],
    ['Diversified Banks'],
    ['Property & Casualty Insurance', 'Multi-line Insurance', 'Life & Health Insurance', 'Insurance Brokers'],
    ['Pharmaceuticals', 'Biotechnology', 'Life Sciences Tools & Services'],
    ['Managed Healthcare', 'Health Care Equipment', 'Health Care Supplies', 'Health Care Services',
      'Health Care Distributors', 'Health Care Technology'],
    ['Consumer Staples Merchandise Retail'],
    ['Household Products'],
    ['Soft Drinks & Non-alcoholic Beverages', 'Tobacco', 'Packaged Foods & Meats', 'Agricultural Products & Services'],
    ['Aerospace & Defense'],
    ['Construction Machinery & Heavy Transportation Equipment', 'Agricultural & Farm Machinery', 'Industrial Machinery',
      'Electrical Components & Equipment', 'Building Products', 'Industrial Conglomerates'],
    ['Rail Transportation', 'Air Freight & Logistics', 'Airport Services'],
    ['Research & Consulting Services', 'Diversified Support Services', 'Human Resource & Employment Services',
      'Environmental & Facilities Services', 'Commercial & Professional Services'],
    ['Integrated Oil & Gas', 'Oil & Gas Exploration & Production', 'Oil & Gas Equipment & Services',
      'Oil & Gas Storage & Transportation', 'Oil & Gas Refining & Marketing'],
    ['Industrial Gases', 'Specialty Chemicals', 'Fertilizers & Agricultural Chemicals', 'Commodity Chemicals'],
    ['Copper', 'Gold'],
    ['Construction Materials'],
    ['Electric Utilities', 'Multi-Utilities', 'Water Utilities'],
    ['Industrial REITs', 'Telecom Tower REITs', 'Data Center REITs', 'Retail REITs', 'Real Estate Services', 'Hotel & Resort REITs']
  ];
  const text = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
  const symbol = value => typeof value === 'string' ? value.trim().toUpperCase().replace(/[.-]/g, '') : '';
  const family = new Map(families.flatMap((industries, i) => industries.map(industry => [text(industry), i])));
  const issuer = (stock, ticker) => text(stock.company_name || stock.companyName)
    .replace(/\s*\(?class\s+[a-z]\)?/g, '').replace(/[^a-z0-9]/g, '') || symbol(ticker);

  function select(universe, ticker, limit = 5) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new RangeError('Peer limit must be between 1 and 5');
    const entries = Object.entries(universe || {});
    const target = entries.find(([key]) => symbol(key) === symbol(ticker));
    if (!target) throw new RangeError(`Unknown comparison ticker: ${ticker}`);
    const [targetTicker, current] = target;
    const provided = new Set((Array.isArray(current.peers) ? current.peers : [])
      .filter(value => typeof value === 'string').map(symbol));
    const targetIssuer = issuer(current, targetTicker);
    const targetFamily = family.get(text(current.industry));
    const candidates = [];
    for (const [key, stock] of entries) {
      if (!stock || symbol(key) === symbol(targetTicker) || issuer(stock, key) === targetIssuer) continue;
      const sameSector = text(stock.sector) && text(stock.sector) === text(current.sector);
      const sameIndustry = sameSector && text(stock.industry) && text(stock.industry) === text(current.industry);
      const related = sameSector && targetFamily !== undefined && family.get(text(stock.industry)) === targetFamily;
      const provider = provided.has(symbol(key));
      if (!sameIndustry && !provider && !related) continue;
      const basis = sameIndustry ? 'industry' : provider ? 'provider' : 'related';
      const priority = sameIndustry ? (provider ? 0 : 1) : provider ? 2 : 3;
      const distance = Number.isFinite(current.mcap) && Number.isFinite(stock.mcap)
        ? Math.abs(stock.mcap - current.mcap) : Infinity;
      candidates.push({ ticker: key, stock, basis, priority, distance });
    }
    candidates.sort((a, b) => a.priority - b.priority || a.distance - b.distance || a.ticker.localeCompare(b.ticker));
    const seenIssuers = new Set([targetIssuer]);
    const peers = candidates.filter(candidate => {
      const key = issuer(candidate.stock, candidate.ticker);
      if (seenIssuers.has(key)) return false;
      seenIssuers.add(key);
      return true;
    }).slice(0, limit).map(({ ticker, stock, basis }) => ({ ticker, stock, basis }));
    const available = new Set(entries.map(([key]) => symbol(key)));
    return {
      ticker: targetTicker, peers,
      counts: Object.fromEntries(['industry', 'provider', 'related'].map(basis => [basis, peers.filter(peer => peer.basis === basis).length])),
      unavailable: [...provided].filter(key => key !== symbol(targetTicker) && !available.has(key))
    };
  }
  // True when the provider pack has no income/balance/cashflow rows at all (HK expansion gap).
  function statementsPackEmpty(data) {
    return ['annual', 'quarterly'].every(period => ['income', 'balance', 'cashflow']
      .every(type => Array.isArray(data?.[period]?.[type]) && data[period][type].length === 0));
  }

  function annualView(stock, data) {
    if (!Array.isArray(data?.annual?.income) || !Array.isArray(data?.annual?.balance)
        || !Array.isArray(data?.annual?.cashflow)) throw new TypeError('Missing annual peer statements');
    if (data.calculationCurrency !== (stock.calculationCurrency || 'HKD')) {
      throw new TypeError('Annual peer statement currency mismatch');
    }
    data = industryApi().normalizeBankStatements(data, stock.industry, stock.ticker);
    const finite = Number.isFinite;
    const sorted = rows => rows.slice().sort((a, b) => a.date.localeCompare(b.date));
    // Align with FmpScenario.fullAnnualPeriod: US FY rows often omit periodLength.
    const fullFiscal = row => !!row && row.reportType !== 'secondInterim'
      && (row.period === undefined || row.period === 'FY')
      && (row.periodLength === 12
        || row.periodLength === undefined && row.period === 'FY' && !String(stock.ticker || '').endsWith('.HK'));
    const fullYears = rows => sorted(rows.filter(row => fullFiscal(row)
      && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(Date.parse(row.date))
      && new Date(row.date).toISOString().slice(0, 10) === row.date));
    const years = fullYears(data.annual.income);
    const latest = years.at(-1), date = latest?.date || null;
    const matching = type => {
      const rows = data.annual[type].filter(row => row.date === date
        && (type === 'balance' || fullFiscal(row)));
      return rows.length === 1 ? rows[0] : null;
    };
    const fields = {
      income: ['revenue', 'grossProfit', 'operatingIncome', 'netIncome', 'ebitda', 'interestExpense',
        'netIncomeDeductions', 'epsdiluted'],
      balance: ['totalDebt', 'cashAndShortTermInvestments', 'preferredStock', 'minorityInterest',
        'totalStockholdersEquity', 'totalAssets', 'totalLiabilities', 'goodwillAndIntangibleAssets',
        'goodwill', 'intangibleAssets', 'totalCurrentAssets', 'totalCurrentLiabilities'],
      cashflow: ['operatingCashFlow', 'netCashProvidedByOperatingActivities', 'capitalExpenditure',
        'freeCashFlow', 'dividendsPaid', 'commonDividendsPaid', 'commonStockDividendsPaid', 'netDividendsPaid']
    };
    const packEmpty = statementsPackEmpty(data);
    const warnedUnavailable = (Array.isArray(data.qualityWarnings) ? data.qualityWarnings : [])
      .concat(Array.isArray(stock?.qualityWarnings) ? stock.qualityWarnings : [])
      .some(row => row?.code === 'providerStatementUnavailable');
    const reference = { basis: 'latestFullFiscalYear', currency: data.calculationCurrency, date,
      label: latest ? `FY ${latest.fiscalYear || latest.calendarYear || date.slice(0, 4)}` : 'N/A',
      reason: latest ? null : 'missingFullFiscalYear',
      // Empty provider packs must not look like a FY-date / duration bug on the peers table.
      providerStatementsUnavailable: packEmpty || (!latest && warnedUnavailable && !years.length) };
    for (const [type, names] of Object.entries(fields)) {
      const row = matching(type);
      reference[type] = Object.fromEntries(names.map(field => [field,
        row && !row.currencyConversion?.reason && finite(row[field])
          ? row[field] / (field === 'epsdiluted' ? 1 : 1e6) : null]));
    }
    const { income, balance, cashflow } = reference;
    const divide = (a, b, positive = false) => {
      const value = finite(a) && finite(b) && (positive ? b > 0 : b !== 0) ? a / b : null;
      return finite(value) ? value : null;
    };
    balance.netDebt = finite(balance.totalDebt) && finite(balance.cashAndShortTermInvestments)
      ? balance.totalDebt - balance.cashAndShortTermInvestments : null;
    const evInputs = [stock.mcap, balance.netDebt, balance.preferredStock, balance.minorityInterest];
    reference.ev = stock.mcap > 0 && evInputs.every(finite) ? evInputs.reduce((sum, value) => sum + value, 0) : null;
    const shares = stock.shareBasis === 'commonSharesOutstandingExcludingTreasury' && stock.shares > 0
      && finite(stock.shares) ? stock.shares : null;
    const commonEarnings = finite(income.netIncome) && (balance.preferredStock === 0 || finite(income.netIncomeDeductions))
      ? income.netIncome - (finite(income.netIncomeDeductions) ? income.netIncomeDeductions : 0) : null;
    reference.epsBasis = finite(income.epsdiluted) ? 'reportedAnnualDilutedEps' : 'annualCommonEarningsOverDatedShares';
    reference.eps = finite(income.epsdiluted) ? income.epsdiluted : divide(commonEarnings, shares, true);
    const annualData = { ...data, annual: {
      income: years.filter(row => row.date <= date),
      balance: sorted(data.annual.balance.filter(row => row.date <= date)),
      cashflow: fullYears(data.annual.cashflow).filter(row => row.date <= date)
    } };
    const returns = latest ? returnsEngine().calculateReturns(annualData,
      { period: 'annual', flow: 'single', balance: 'beginning' }).find(row => row.date === date) : null;
    reference.growth = Object.fromEntries([
      ['revenue', 'income'], ['grossProfit', 'income'], ['operatingIncome', 'income'], ['netIncome', 'income'],
      ['ebitda', 'income'], ['operatingCashFlow', 'cashflow'], ['freeCashFlow', 'cashflow']
    ].map(([field, type]) => {
      const record = growthEngine().annualGrowth(annualData, type, field);
      if (record.date !== date) {
        return [field, { value: null, date, previousDate: null, reason: 'missingPeriod', basis: 'annual' }];
      }
      const previous = annualData.annual[type].at(-2)?.[field];
      const present = annualData.annual[type].at(-1)?.[field];
      const comparable = !record.reason || record.reason === 'nonPositivePrior';
      const transition = !comparable ? null
        : previous < 0 && present > 0 ? 'negativeToPositive'
          : previous > 0 && present < 0 ? 'positiveToNegative' : null;
      return [field, { ...record, transition }];
    }));
    const commonDividendField = ['commonDividendsPaid', 'commonStockDividendsPaid'].find(field => finite(cashflow[field]));
    const totalDividendField = ['dividendsPaid', 'netDividendsPaid'].find(field => finite(cashflow[field]));
    reference.dividendField = commonDividendField || (balance.preferredStock === 0 ? totalDividendField : null) || null;
    const dividends = reference.dividendField ? cashflow[reference.dividendField] : null;
    const dividendYield = finite(dividends)
      ? divide(dividends === 0 ? 0 : -dividends, stock.mcap, true) : null;
    return { ...stock, peerAnnual: reference, EV: reference.ev,
      pe_trailing: divide(stock.price, reference.eps), pb_trailing: divide(stock.price, divide(balance.totalStockholdersEquity, shares, true)),
      roe: returns?.ratios.roe.value ?? null, roa: returns?.ratios.roa.value ?? null,
      current_ratio: divide(balance.totalCurrentAssets, balance.totalCurrentLiabilities),
      div_yield: dividendYield === null ? null : dividendYield * 100,
      ev_to_ebitda: divide(reference.ev, income.ebitda, true),
      debt_to_ebitda: divide(balance.totalDebt, income.ebitda, true),
      net_debt_to_ebitda: divide(balance.netDebt, income.ebitda, true)
    };
  }

  // Rebuild the trailing TTM slot (and zeroed quarterly_raw) from normalized statements.
  // Expansion packs for unlabeled semiannual filers often store FX-null zeros under quarterly cadence.
  function overlayUsTtm(stock, statements) {
    if (!stock?.statements_raw || !statements?.quarterly?.income) return stock;
    const frequency = statements.reportingFrequency
      || statements.statementFrequencies?.income || 'quarterly';
    const stride = frequency === 'semiannual' ? 2 : 1;
    const count = frequency === 'semiannual' ? 2 : 4;
    const minDays = frequency === 'semiannual' ? 150 : 60;
    const maxDays = frequency === 'semiannual' ? 220 : 125;
    const indexRows = (rows, annual) => {
      const index = new Map();
      for (const row of rows || []) {
        if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
        const year = Number(row.fiscalYear || row.calendarYear);
        const quarter = /^Q[1-4]$/.test(row.period) ? Number(row.period[1]) : null;
        if (!Number.isInteger(year)) continue;
        if (annual ? row.period !== 'FY' : quarter === null) continue;
        const key = annual ? year : year * 4 + quarter - 1;
        index.set(key, index.has(key) ? null : row);
      }
      return index;
    };
    const incomeIndex = indexRows(statements.quarterly.income, false);
    if (!incomeIndex.size) return stock;
    const key = Math.max(...incomeIndex.keys());
    const window = Array.from({ length: count }, (_, i) => incomeIndex.get(key - (count - 1 - i) * stride));
    // Sparse windows (undefined/null slots) stay invalid — never throw on missing rows.
    const valid = rows => {
      if (!Array.isArray(rows) || rows.length !== count || rows.some(row => !row || typeof row !== 'object')) {
        return false;
      }
      const latest = rows.at(-1);
      if (typeof latest?.reportedCurrency !== 'string' || !/^[A-Z]{3}$/.test(latest.reportedCurrency)) {
        return false;
      }
      return rows.every((row, i) => typeof row.reportedCurrency === 'string'
        && /^[A-Z]{3}$/.test(row.reportedCurrency) && row.reportedCurrency === latest.reportedCurrency
        && !row.currencyConversion?.reason
        && (row.periodLength == null || row.periodLength === stride * 3)
        && (!i || (Date.parse(row.date) - Date.parse(rows[i - 1].date)) / 86400000 >= minDays
          && (Date.parse(row.date) - Date.parse(rows[i - 1].date)) / 86400000 <= maxDays));
    };
    const sumField = (type, field) => {
      const rows = type === 'income' ? window
        : Array.from({ length: count }, (_, i) => indexRows(statements.quarterly[type], false)
          .get(key - (count - 1 - i) * stride));
      if (!valid(rows) || rows.some(row => typeof row[field] !== 'number' || !Number.isFinite(row[field]))) {
        return null;
      }
      if (type === 'balance' || field === 'cashAtEndOfPeriod') return rows.at(-1)[field];
      if (field === 'cashAtBeginningOfPeriod') return rows[0][field];
      if (/^weightedAverageShs/.test(field)) {
        return rows.reduce((sum, row) => sum + row[field], 0) / rows.length;
      }
      return rows.reduce((sum, row) => sum + row[field], 0);
    };
    const raw = structuredClone(stock.statements_raw);
    const scale = (field, amount) => amount === null ? null
      : /^weightedAverageShs/.test(field) || /ratio$/i.test(field) || /^eps/i.test(field)
        ? amount : amount / 1e6;
    for (const type of ['income', 'balance', 'cashflow']) {
      if (!raw[type] || typeof raw[type] !== 'object') continue;
      for (const field of Object.keys(raw[type])) {
        if (!Array.isArray(raw[type][field]) || !raw[type][field].length) continue;
        const next = scale(field, sumField(type, field));
        if (next !== null) raw[type][field] = [...raw[type][field].slice(0, -1), next];
      }
    }
    const latestIncome = window.at(-1);
    if (latestIncome?.date && Array.isArray(raw.annual_dates) && raw.annual_dates.length) {
      raw.annual_dates = [...raw.annual_dates.slice(0, -1), latestIncome.date.slice(0, 7)];
    }
    const q = raw.quarterly_raw;
    if (q?.income && Array.isArray(statements.quarterly.income)) {
      const sorted = statements.quarterly.income.slice().sort((a, b) => a.date.localeCompare(b.date)).slice(-20);
      for (const type of ['income', 'balance', 'cashflow']) {
        if (!q[type] || typeof q[type] !== 'object') continue;
        for (const field of Object.keys(q[type])) {
          if (!Array.isArray(q[type][field])) continue;
          q[type][field] = sorted.map(row => {
            const match = (statements.quarterly[type] || []).find(other => other.date === row.date);
            const amount = match && typeof match[field] === 'number' && Number.isFinite(match[field])
              ? match[field] : null;
            return scale(field, amount);
          });
        }
      }
      q.dates = sorted.map(row => row.date.slice(0, 7));
      q.periods = sorted.map(row => `${row.fiscalYear || row.calendarYear}${row.period}`);
    }
    return {
      ...stock,
      statements_raw: raw,
      reportingFrequency: frequency,
      statementFrequencies: statements.statementFrequencies || stock.statementFrequencies
    };
  }

  return { select, annualView, statementsPackEmpty, overlayUsTtm };
});
