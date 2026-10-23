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
  function annualView(stock, data) {
    if (!Array.isArray(data?.annual?.income) || !Array.isArray(data?.annual?.balance)
        || !Array.isArray(data?.annual?.cashflow)) throw new TypeError('Missing annual peer statements');
    if (data.calculationCurrency !== (stock.calculationCurrency || 'HKD')) {
      throw new TypeError('Annual peer statement currency mismatch');
    }
    data = industryApi().normalizeBankStatements(data, stock.industry, stock.ticker);
    const finite = Number.isFinite;
    const sorted = rows => rows.slice().sort((a, b) => a.date.localeCompare(b.date));
    const fullYears = rows => sorted(rows.filter(row => row.period === 'FY' && row.periodLength === 12
      && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isFinite(Date.parse(row.date))
      && new Date(row.date).toISOString().slice(0, 10) === row.date));
    const years = fullYears(data.annual.income);
    const latest = years.at(-1), date = latest?.date || null;
    const matching = type => {
      const rows = data.annual[type].filter(row => row.date === date
        && (type === 'balance' || row.period === 'FY' && row.periodLength === 12));
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
    const reference = { basis: 'latestFullFiscalYear', currency: data.calculationCurrency, date,
      label: latest ? `FY ${latest.fiscalYear || latest.calendarYear || date.slice(0, 4)}` : 'N/A',
      reason: latest ? null : 'missingFullFiscalYear' };
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
  return { select, annualView };
});
