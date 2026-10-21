(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FmpScenario = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const fullAnnualPeriod = row => !!row && row.reportType !== 'secondInterim'
    && (row.period === undefined || row.period === 'FY') && (row.periodLength === 12
    || row.periodLength === undefined && row.period === 'FY' && !row.symbol?.endsWith('.HK'));
  const fail = code => { throw new Error(code); };
  const kinds = ['advanced', 'customLevered'];
  // Mature-market long-term nominal growth band used in Damodaran / sell-side Gordon practice
  // (≈ long-run GDP + inflation). Midpoint 2.5% is a suggested default only, not a forecast.
  const TERMINAL_GROWTH_REFERENCE = {
    value: 2.5, bandLow: 2, bandHigh: 3, origin: 'suggested-default',
    citationZh: '參考 Damodaran／賣方常見成熟市場長期名目成長帶（約長期 GDP＋通膨）2%–3%，建議預設取中點 2.5%；可改，不會覆寫你已輸入的值。',
    citationEn: 'Reference: Damodaran / common sell-side mature-market long-term nominal growth band (~long-run GDP + inflation) of 2%–3%. Suggested default uses the 2.5% midpoint; editable and never overwrites a value you already entered.'
  };
  const fields = [
    ['growth', '營收成長率 (%)', 'Revenue growth (%)', -99.99, 1000],
    ['ebitda', 'EBITDA／營收 (%)', 'EBITDA / revenue (%)', -1000, 1000, 'advanced'],
    ['ebit', 'EBIT／營收 (%)，與 EBITDA 連動', 'EBIT / revenue (%), linked to EBITDA', -1000, 1000, 'advanced'],
    ['da', 'D&A／營收 (%)', 'D&A / revenue (%)', 0, 1000, 'advanced'],
    ['nwcChange', '淨營運資金變動／營收（增加為正，%）', 'Change in net working capital / revenue (increase positive, %)', -Number.MAX_VALUE, Number.MAX_VALUE, 'advanced'],
    ['cfo', 'CFO／營收 (%)', 'CFO / revenue (%)', -1000, 1000, 'customLevered'],
    ['capex', '資本開支／營收（負值，%）', 'CapEx / revenue (negative, %)', -1000, 0],
    ['tax', '預測營運稅率 (%)', 'Forecast operating tax (%)', -100, 100],
    ['beta', 'Beta', 'Beta', -10, 10],
    ['rf', '無風險利率 (%)', 'Risk-free rate (%)', -10, 50],
    ['erp', '股權風險溢價 (%)', 'Equity risk premium (%)', 0, 50],
    ['kd', '債務成本 (%)', 'Cost of debt (%)', 0, 100],
    ['ke', '股權成本 (%)', 'Cost of equity (%)', -10, 100],
    ['debtWeight', '債務佔資本 (%)', 'Debt / capital (%)', 0, 100]
  ];
  const legacyWorkingCapitalFields = [
    ['receivables', '應收／營收 (%)', 'Receivables / revenue (%)', 0, 1000, 'advanced'],
    ['inventories', '存貨／營收 (%)', 'Inventories / revenue (%)', -1000, 1000, 'advanced'],
    ['payables', '應付／營收 (%)', 'Payables / revenue (%)', 0, 1000, 'advanced']
  ];
  const activeFields = (kind, scenario = null) => fields
    .flatMap(field => field[0] === 'nwcChange' && scenario && !scenario.workingCapitalMethod
      ? legacyWorkingCapitalFields : [field])
    .filter(field => !field[5] || field[5] === kind);
  const verifiedIncomeDocument = document => !!document
    && /^https:\/\/(?:www\.galaxyentertainment\.com\/uploads\/investor\/[a-f0-9]+|www1\.hkexnews\.hk\/listedco\/listconews\/(?:sehk|gem)\/20\d\d\/\d{4}\/[a-z0-9]+|www\.sjmholdings\.com\/resources\/images\/uploads\/(?:ar2008|intrep2008|intrep2009))\.pdf$/.test(document.url)
    && /^[a-f0-9]{64}$/.test(document.sha256) && Array.isArray(document.pdfPages)
    && document.pdfPages.length > 0 && document.pdfPages.every(page => Number.isSafeInteger(page) && page > 0);

  function verifiedRevenueCorrection(symbol, row, provenance) {
    const correction = row?.revenueCorrection;
    const source = provenance?.annual?.find(item => item.date === row.date);
    const multiplier = { units: 1, thousands: 1000, millions: 1e6 }[source?.unit || provenance?.unit];
    const basis = provenance?.basisCode || (symbol === '0027.HK' ? 'issuerRevenueBeforeGamingTax' : null);
    return !!(correction && provenance?.symbol === symbol && correction.symbol === symbol
      && ['HKD', 'USD', 'JPY'].includes(row.reportedCurrency) && row.reportedCurrency === provenance.currency
      && ['issuerRevenueBeforeGamingTax', 'issuerReportedConsolidatedRevenue'].includes(basis)
      && correction.basis === basis && (finite(correction.providerRevenue)
        || provenance.incomeHistoryPolicy === 'reviewedPeriodsOnly' && correction.providerRevenue === null)
      && correction.reportedRevenue === row.revenue && multiplier && finite(source?.revenue)
      && source.revenue * multiplier === row.revenue
      && Array.isArray(correction.sourceIds) && correction.sourceIds.includes(source.sourceId)
      && correction.sourceIds.every(id => verifiedIncomeDocument(provenance.documents?.[id])));
  }

  function baseSource(data, statements) {
    const rows = data.models?.advanced?.data || [];
    if (data.currencyCheck?.reason || !rows.length) return { reason: 'SCENARIO_BASE_UNVERIFIED' };
    const evidence = data.currencyCheck;
    const candidates = (statements?.annual?.income || []).filter(fullAnnualPeriod).map(row => {
      const correction = row.revenueCorrection;
      if (correction && !verifiedRevenueCorrection(data.symbol, row, statements.revenueProvenance)) {
        fail('SCENARIO_REVENUE_SOURCE_UNVERIFIED');
      }
      return {
        year: Number(row.fiscalYear || row.calendarYear), date: row.date, revenue: row.revenue,
        modelBasisRevenue: row.revenueCorrection?.providerRevenue ?? row.revenue,
        revenueCorrection: row.revenueCorrection,
        currency: row.reportedCurrency, source: row.revenueCorrection ? 'Official issuer consolidated revenue' : 'FMP filed annual financials'
      };
    });
    const storedEvidence = statements?.annual?.income?.find(row => row.date === evidence.sourceDate);
    const fullEvidencePeriod = storedEvidence ? fullAnnualPeriod(storedEvidence)
      : evidence.sourcePeriodLength === 12 || evidence.sourcePeriodLength === undefined && !data.symbol?.endsWith('.HK');
    if (finite(evidence.originalRevenue) && evidence.sourceDate && fullEvidencePeriod) {
      const match = rows.find(row => row.revenue === evidence.modelRevenue
        && Number(row.year) === Number(evidence.sourceDate.slice(0, 4)));
      if (match) candidates.push({ year: Number(match.year), date: evidence.sourceDate,
        revenue: evidence.originalRevenue, currency: evidence.sourceCurrency, source: evidence.financialSource || evidence.basis });
    }
    const verified = candidates.filter(actual => actual.currency === evidence.sourceCurrency
      && actual.date <= data.capturedAt?.slice(0, 10) && actual.revenue > 0
      && rows.some(row => Number(row.year) === actual.year && finite(row.revenue)
        && finite(evidence.fx?.price) && evidence.fx.price > 0
        && [actual.modelBasisRevenue, actual.revenue].some(revenue => revenue > 0
          && Math.abs(row.revenue / revenue / evidence.fx.price - 1) < 0.005)));
    const latest = verified.sort((a, b) => b.year - a.year || b.date.localeCompare(a.date))[0];
    return latest ? { year: latest.year, date: latest.date, source: latest.source, reason: null,
      ...(latest.revenueCorrection ? { revenue: latest.revenue, currency: latest.currency,
        revenueCorrection: latest.revenueCorrection } : {}) }
      : { reason: 'SCENARIO_BASE_UNVERIFIED' };
  }

  function fiveYearEffectiveTax(statements, base, currency) {
    const unavailable = reason => ({ percent: null, years: [], rates: [], reason });
    if (!base || !Number.isInteger(base.year) || !base.date) return unavailable('TAX_BASE_UNAVAILABLE');
    if (!statements?.annual?.income) return unavailable('TAX_STATEMENTS_UNAVAILABLE');
    const rows = [];
    for (let offset = 0; offset < 5; offset++) {
      const year = base.year - offset;
      const matches = statements.annual.income.filter(row => Number(row.fiscalYear || row.calendarYear) === year
        && fullAnnualPeriod(row) && (!currency || row.reportedCurrency === currency));
      if (matches.length !== 1) return unavailable('TAX_FIVE_YEAR_INCOMPLETE');
      const row = matches[0];
      if (!(row.incomeBeforeTax > 0) || !finite(row.incomeTaxExpense)) return unavailable('TAX_PRETAX_OR_EXPENSE_UNAVAILABLE');
      const rate = row.incomeTaxExpense / row.incomeBeforeTax * 100;
      if (!finite(rate) || rate < -100 || rate > 100) return unavailable('TAX_RATE_OUT_OF_RANGE');
      rows.push({ year, date: row.date, rate });
    }
    rows.reverse();
    const percent = rows.reduce((sum, row) => sum + row.rate, 0) / rows.length;
    return { percent, years: rows.map(row => row.year), rates: rows, reason: null,
      basis: 'Arithmetic mean of five consecutive full-FY effective tax rates (income tax expense / pretax income).' };
  }

  function fiveYearHistory(statements, data, kind = 'advanced') {
    const unavailable = reason => ({ reason, years: [], metrics: {}, summary: {} });
    const base = data?.forecastBase;
    if (!base || !Number.isInteger(base.year)) return unavailable('HISTORY_BASE_UNAVAILABLE');
    if (!statements?.annual?.income) return unavailable('HISTORY_STATEMENTS_UNAVAILABLE');
    const currency = data.currencyCheck?.sourceCurrency;
    const years = [];
    for (let offset = 4; offset >= 0; offset--) {
      const year = base.year - offset;
      const incomeMatches = statements.annual.income.filter(row => Number(row.fiscalYear || row.calendarYear) === year
        && fullAnnualPeriod(row) && (!currency || row.reportedCurrency === currency));
      if (incomeMatches.length !== 1 || !(incomeMatches[0].revenue > 0)) return unavailable('HISTORY_FIVE_YEAR_INCOMPLETE');
      const income = incomeMatches[0];
      const cashMatches = (statements.annual.cashflow || []).filter(row => row.date === income.date
        && fullAnnualPeriod(row) && (!currency || row.reportedCurrency === currency));
      const cashflow = cashMatches.length === 1 ? cashMatches[0] : null;
      const prior = years.at(-1);
      const growth = prior?.revenue > 0 ? (income.revenue / prior.revenue - 1) * 100 : null;
      const ratio = amount => finite(amount) ? amount / income.revenue * 100 : null;
      const da = finite(income.depreciationAndAmortization) ? income.depreciationAndAmortization
        : cashflow?.depreciationAndAmortization;
      const tax = income.incomeBeforeTax > 0 && finite(income.incomeTaxExpense)
        ? income.incomeTaxExpense / income.incomeBeforeTax * 100 : null;
      years.push({
        year, date: income.date, revenue: income.revenue, growth,
        ebitda: ratio(income.ebitda), da: ratio(da),
        capex: ratio(cashflow?.capitalExpenditure),
        cfo: ratio(cashflow?.operatingCashFlow ?? cashflow?.netCashProvidedByOperatingActivities),
        nwcChange: finite(cashflow?.changeInWorkingCapital) ? -cashflow.changeInWorkingCapital / income.revenue * 100 : null,
        tax
      });
    }
    const keys = kind === 'customLevered'
      ? ['growth', 'cfo', 'capex', 'tax']
      : ['growth', 'ebitda', 'da', 'nwcChange', 'capex', 'tax'];
    const metrics = Object.fromEntries(keys.map(key => [key, years.map(row => row[key])]));
    const first = years[0], last = years.at(-1);
    const summary = {
      revenueCagr: first.revenue > 0 && last.revenue > 0
        ? (Math.pow(last.revenue / first.revenue, 1 / (years.length - 1)) - 1) * 100 : null,
      spanYears: years.map(row => row.year)
    };
    for (const key of keys) {
      const series = metrics[key].filter(finite);
      summary[key] = {
        average: series.length ? series.reduce((sum, value) => sum + value, 0) / series.length : null,
        changePp: finite(first[key]) && finite(last[key]) ? last[key] - first[key] : null
      };
    }
    return { reason: null, years, metrics, summary };
  }

  function defaults(data, kind, shares, context = {}) {
    if (!kinds.includes(kind) || !Number.isSafeInteger(shares) || shares <= 0
        || data.currencyCheck?.reason || data.models?.[kind]?.reason) fail('SCENARIO_SOURCE_UNAVAILABLE');
    const base = data.forecastBase;
    if (!Number.isInteger(base?.year) || base.reason) fail('SCENARIO_BASE_UNVERIFIED');
    const source = (data.models?.[kind]?.data || []).slice().sort((a, b) => Number(a.year) - Number(b.year));
    const opening = source.find(row => Number(row.year) === base.year);
    const projected = source.filter(row => Number(row.year) > base.year);
    if (!opening || !projected.length || projected.length > 10 || !(opening.revenue > 0)
        || projected.some((row, index) => Number(row.year) !== base.year + index + 1)) fail('SCENARIO_FORECAST_UNAVAILABLE');
    if (!finite(opening.netDebt)
        || source.some(row => row.netDebt !== opening.netDebt)) fail('SCENARIO_SNAPSHOT_NET_DEBT_UNVERIFIED');
    const consensus = data.analystEstimates;
    const validSource = consensus?.symbol === data.symbol && !consensus.reason
      && Array.isArray(consensus.rows) && consensus.currency === data.currencyCheck?.sourceCurrency
      && consensus.calculationCurrency === data.currency && finite(consensus.fx?.rate) && consensus.fx.rate > 0;
    const actuals = data.forecastActuals?.symbol === data.symbol ? data.forecastActuals : null;
    const latest = !actuals?.latest?.reason ? actuals?.latest : null;
    const taxFive = fiveYearEffectiveTax(context.statements, base, data.currencyCheck?.sourceCurrency);
    const capitalFields = { beta: 'beta', rf: 'riskFreeRate', erp: 'marketRiskPremium',
      kd: 'costofDebt', ke: 'costOfEquity', debtWeight: 'debtWeighting' };
    const years = [], warnings = [];
    const baseRevenue = base.revenueCorrection && base.currency === data.currencyCheck.sourceCurrency
      && finite(base.revenue) && finite(data.currencyCheck.fx?.price)
      ? base.revenue * data.currencyCheck.fx.price : opening.revenue;
    let previousRevenue = baseRevenue;
    for (let index = 0; index < 10; index++) {
      const year = base.year + index + 1;
      const expected = Date.UTC(year, Number(base.date.slice(5, 7)) - 1, Number(base.date.slice(8, 10)));
      const matches = validSource ? consensus.rows.filter(row =>
        Math.abs(Date.parse(row.date) - expected) <= 10 * 86400000) : [];
      const row = matches.length === 1 ? matches[0] : null;
      const covered = row?.revenueAvg > 0 && Number.isInteger(row.numAnalystsRevenue) && row.numAnalystsRevenue > 0;
      const revenue = covered ? row.revenueAvg * consensus.fx.rate : null;
      const values = Object.fromEntries(activeFields(kind).map(([key]) => [key, null]));
      const origins = Object.fromEntries(Object.keys(values).map(key => [key, 'unavailable']));
      const set = (key, value, origin) => {
        if (finite(value)) { values[key] = value; origins[key] = origin; }
      };
      const capitalRow = projected[index] || projected.at(-1);
      for (const [key, field] of Object.entries(capitalFields)) {
        set(key, capitalRow[field], 'retained-capital');
      }
      if (revenue > 0 && previousRevenue > 0) set('growth', (revenue / previousRevenue - 1) * 100, 'analyst-derived');
      const ratio = (key, sourceKey) => {
        if (covered && finite(row[sourceKey])) set(key, row[sourceKey] / row.revenueAvg * 100, 'analyst');
      };
      const fallback = (key, sourceKey) => {
        ratio(key, sourceKey);
        if (!finite(values[key])) set(key, latest?.items[key]?.percent, 'latest-fy');
      };
      fallback('capex', 'capitalExpenditureAvg');
      if (kind === 'customLevered') fallback('cfo', 'operatingCashFlowAvg');
      else {
        fallback('da', 'depreciationAndAmortizationAvg');
        fallback('ebitda', 'ebitdaAvg');
        if (finite(values.ebitda) && finite(values.da)) set('ebit', values.ebitda - values.da, 'derived');
        else if (covered && finite(row.ebitAvg)) {
          set('ebit', row.ebitAvg / row.revenueAvg * 100, 'analyst');
          if (finite(values.da)) set('ebitda', values.ebit + values.da, 'derived');
        } else if (finite(values.ebitda) && finite(latest?.items?.da?.percent)) {
          set('da', latest.items.da.percent, 'latest-fy');
          set('ebit', values.ebitda - values.da, 'derived');
        }
        set('nwcChange', actuals?.workingCapital?.nwcChange, 'working-capital-average');
      }
      if (!finite(values.tax)) set('tax', taxFive.percent, 'five-year-effective-tax');
      years.push({ year, values, origins, consensusDate: covered ? row.date : null });
      previousRevenue = revenue;
    }
    const openingNwc = kind === 'advanced'
      ? [opening.receivables, opening.inventories, opening.payable].every(finite)
        ? opening.receivables + opening.inventories - opening.payable : null : 0;
    const suggestedExit = finite(context.stock?.ev_to_ebitda) && context.stock.ev_to_ebitda > 0
      && context.stock.ev_to_ebitda <= 500 ? context.stock.ev_to_ebitda : null;
    return { version: 1, assumptionPolicy: 'analyst-consensus-v1', kind, symbol: data.symbol, currency: data.currency, shares,
      workingCapitalMethod: 'cash-change-to-revenue',
      baseYear: base.year, baseDate: base.date, baseRevenue, openingNwc,
      baseRevenueSource: base.revenueCorrection ? 'officialReportedRevenue' : 'nativeHistoricalModelRevenue',
      sourceCapturedAt: consensus?.capturedAt || data.capturedAt,
      providerYears: [], analystYears: years.filter(row => row.consensusDate).map(row => row.year),
      analystReason: validSource ? null : consensus?.reason || 'ANALYST_SOURCE_UNAVAILABLE',
      actualRatioDate: latest?.date || null, workingCapitalYears: actuals?.workingCapitalYears || [],
      warnings, netDebt: opening.netDebt, netDebtDate: base.date,
      netDebtBasis: opening.netDebt < 0 ? 'net-cash' : 'net-debt',
      terminalGrowth: TERMINAL_GROWTH_REFERENCE.value,
      terminalGrowthOrigin: TERMINAL_GROWTH_REFERENCE.origin,
      terminalGrowthReference: { ...TERMINAL_GROWTH_REFERENCE },
      exitMultiple: suggestedExit,
      exitMultipleOrigin: suggestedExit === null ? null : 'suggested-current-multiple',
      taxFiveYear: taxFive,
      years };
  }

  function missingInputs(scenario) {
    if (!scenario) return [];
    const missing = [];
    if (!finite(scenario.terminalGrowth)) missing.push({ key: 'terminalGrowth' });
    for (const item of scenario.years || []) {
      for (const [key] of activeFields(scenario.kind, scenario)) {
        if (!finite(item.values[key])) missing.push({ year: item.year, key });
      }
    }
    return missing;
  }

  function exitMultipleTerminal(scenario, last, presentFlows) {
    const empty = reason => ({ method: 'exit-multiple', available: false, reason,
      exitMultiple: finite(scenario.exitMultiple) ? scenario.exitMultiple : null,
      terminalValue: null, presentTerminalValue: null, enterpriseValue: null, equityValue: null, targetPrice: null });
    if (scenario.kind !== 'advanced') return empty('EXIT_MULTIPLE_ADVANCED_ONLY');
    if (!finite(scenario.exitMultiple)) return empty('EXIT_MULTIPLE_UNAVAILABLE');
    if (!(scenario.exitMultiple > 0 && scenario.exitMultiple <= 500)) return empty('EXIT_MULTIPLE_INVALID');
    if (!(last.ebitda > 0)) return empty('EXIT_MULTIPLE_NONPOSITIVE_EBITDA');
    const terminalValue = last.ebitda * scenario.exitMultiple;
    const presentTerminalValue = terminalValue / last.discount;
    const enterpriseValue = presentFlows + presentTerminalValue;
    const equityValue = enterpriseValue - scenario.netDebt;
    const targetPrice = equityValue / scenario.shares;
    if (![enterpriseValue, equityValue, targetPrice, presentTerminalValue].every(finite)) {
      return empty('EXIT_MULTIPLE_NONFINITE_RESULT');
    }
    return { method: 'exit-multiple', available: true, reason: null, exitMultiple: scenario.exitMultiple,
      terminalValue, presentTerminalValue, enterpriseValue, equityValue, targetPrice };
  }

  function upgradeWorkingCapital(scenario) {
    if (scenario.kind !== 'advanced' || scenario.workingCapitalMethod) return scenario;
    const upgraded = structuredClone(scenario);
    let revenue = scenario.baseRevenue, previous = scenario.openingNwc;
    if (!finite(previous) || !(revenue > 0)) fail('SCENARIO_INVALID_INPUT');
    upgraded.legacyWorkingCapital = { openingNwc: previous, years: [] };
    for (const item of upgraded.years) {
      const v = item.values;
      if (![v.growth, v.receivables, v.inventories, v.payables].every(finite)) fail('SCENARIO_INVALID_INPUT');
      revenue *= 1 + v.growth / 100;
      if (!(revenue > 0)) fail('SCENARIO_INVALID_INPUT');
      const current = revenue * (v.receivables + v.inventories - v.payables) / 100;
      upgraded.legacyWorkingCapital.years.push({ year: item.year,
        values: { receivables: v.receivables, inventories: v.inventories, payables: v.payables },
        origins: Object.fromEntries(['receivables', 'inventories', 'payables'].map(key => [key, item.origins[key]])) });
      v.nwcChange = (current - previous) / revenue * 100;
      item.origins.nwcChange = 'derived-legacy';
      for (const key of ['receivables', 'inventories', 'payables']) { delete v[key]; delete item.origins[key]; }
      previous = current;
    }
    upgraded.workingCapitalMethod = 'cash-change-to-revenue';
    return upgraded;
  }

  function update(scenario, index, key, value) {
    const item = scenario.years[index];
    if (!item || !activeFields(scenario.kind, scenario).some(field => field[0] === key)) fail('SCENARIO_INVALID_INPUT');
    item.values[key] = value;
    item.origins[key] = 'user';
    const set = (field, number, origin) => { item.values[field] = number; item.origins[field] = origin; };
    if (key === 'ebit') set('ebitda', finite(value) && finite(item.values.da) ? value + item.values.da : null, 'derived');
    if (key === 'ebitda' || key === 'da') set('ebit', finite(item.values.ebitda) && finite(item.values.da) ? item.values.ebitda - item.values.da : null, 'derived');
    if (['rf', 'beta', 'erp'].includes(key)) set('ke', [item.values.rf, item.values.beta, item.values.erp].every(finite)
      ? item.values.rf + item.values.beta * item.values.erp : null, 'capm');
  }

  function calculate(scenario) {
    if (scenario?.assumptionPolicy === 'analyst-consensus-v1' && missingInputs(scenario).length) {
      fail('SCENARIO_INCOMPLETE_ASSUMPTIONS');
    }
    if (scenario?.version !== 1 || !kinds.includes(scenario.kind)
        || !Number.isSafeInteger(scenario.shares) || scenario.shares <= 0
        || !Number.isInteger(scenario.baseYear) || !(scenario.baseRevenue > 0)
        || (!scenario.workingCapitalMethod && !finite(scenario.openingNwc)) || !finite(scenario.netDebt)
        || (scenario.workingCapitalMethod && scenario.workingCapitalMethod !== 'cash-change-to-revenue')
        || !finite(scenario.terminalGrowth) || scenario.terminalGrowth < -10 || scenario.terminalGrowth > 20
        || scenario.years?.length !== 10) fail('SCENARIO_INVALID_INPUT');
    let revenue = scenario.baseRevenue, nwc = scenario.openingNwc, discount = 1, presentFlows = 0;
    const rows = scenario.years.map((item, index) => {
      if (item.year !== scenario.baseYear + index + 1) fail('SCENARIO_INVALID_YEARS');
      const v = item.values;
      for (const [key, , , min, max] of activeFields(scenario.kind, scenario)) {
        if (!finite(v[key]) || v[key] < min || v[key] > max) fail(`SCENARIO_INVALID_${key}`);
      }
      if (scenario.kind === 'advanced' && Math.abs(v.ebitda - v.da - v.ebit) > 1e-8) fail('SCENARIO_INCONSISTENT_EBIT');
      revenue *= 1 + v.growth / 100;
      const wacc = v.ke / 100 * (1 - v.debtWeight / 100) + v.kd / 100 * (1 - v.tax / 100) * v.debtWeight / 100;
      if (!(wacc > 0 && wacc < 1)) fail('SCENARIO_INVALID_WACC');
      discount *= 1 + wacc;
      const capex = revenue * v.capex / 100;
      let cashFlow, ebitda = null, ebit = null, cfo = null, da = null, changeNwc = null, projectedCash = null;
      if (scenario.kind === 'advanced') {
        ebitda = revenue * v.ebitda / 100;
        da = revenue * v.da / 100;
        ebit = ebitda - da;
        if (scenario.workingCapitalMethod === 'cash-change-to-revenue') changeNwc = revenue * v.nwcChange / 100;
        else {
          const nextNwc = revenue * (v.receivables + v.inventories - v.payables) / 100;
          changeNwc = nextNwc - nwc;
          nwc = nextNwc;
        }
        projectedCash = finite(v.cash) ? revenue * v.cash / 100 : null;
        cashFlow = ebit * (1 - v.tax / 100) + da + capex - changeNwc;
      } else {
        cfo = revenue * v.cfo / 100;
        cashFlow = cfo + capex;
      }
      const pv = cashFlow / discount;
      presentFlows += pv;
      return { year: item.year, revenue, ebitda, ebit, cfo, da, capex, changeNwc, projectedCash, cashFlow, wacc, discount, pv };
    });
    const last = rows.at(-1), g = scenario.terminalGrowth / 100;
    if (last.wacc <= g) fail('SCENARIO_INVALID_TERMINAL_SPREAD');
    const terminalValue = last.cashFlow * (1 + g) / (last.wacc - g);
    const presentTerminalValue = terminalValue / last.discount;
    const enterpriseValue = presentFlows + presentTerminalValue, equityValue = enterpriseValue - scenario.netDebt;
    const targetPrice = equityValue / scenario.shares;
    if (![enterpriseValue, equityValue, targetPrice, presentTerminalValue].every(finite)) fail('SCENARIO_NONFINITE_RESULT');
    const warnings = [];
    if (last.cashFlow <= 0) warnings.push('NONPOSITIVE_TERMINAL_CASH_FLOW');
    if (equityValue < 0) warnings.push('NEGATIVE_EQUITY_VALUE');
    const gordon = { method: 'gordon', available: true, reason: null, terminalGrowth: scenario.terminalGrowth,
      terminalValue, presentTerminalValue, enterpriseValue, equityValue, targetPrice };
    const exit = exitMultipleTerminal(scenario, last, presentFlows);
    if (exit.available && exit.equityValue < 0) warnings.push('NEGATIVE_EXIT_MULTIPLE_EQUITY_VALUE');
    return { targetPrice, enterpriseValue, equityValue, terminalValue, presentTerminalValue, presentFlows, warnings,
      netDebt: scenario.netDebt, wacc: last.wacc, g: scenario.terminalGrowth, rows,
      terminalMethod: 'gordon', terminals: { gordon, exitMultiple: exit } };
  }

  function actualReference(data, statements, base = data?.forecastBase) {
    const unavailable = reason => ({ reason, year: base?.year, date: base?.date, items: {} });
    if (!base || base.reason || !statements) return unavailable('ACTUAL_STATEMENTS_UNAVAILABLE');
    const income = statements.annual?.income?.find(row => row.date === base.date
      && Number(row.fiscalYear || row.calendarYear) === base.year);
    if (!income || !(income.revenue > 0)) return unavailable('ACTUAL_PERIOD_UNAVAILABLE');
    if (!fullAnnualPeriod(income)) return unavailable('ACTUAL_PERIOD_NOT_FULL_YEAR');
    if (income.reportedCurrency !== data.currency) return unavailable('ACTUAL_CURRENCY_UNVERIFIED');
    const rowFor = type => statements.annual?.[type]?.find(row =>
      row.date === base.date && row.reportedCurrency === data.currency
      && (type === 'balance' || fullAnnualPeriod(row)));
    const balance = rowFor('balance'), cashflow = rowFor('cashflow');
    const previous = statements.annual.income.find(row => {
      const gap = (Date.parse(base.date) - Date.parse(row.date)) / 86400000;
      return Number(row.fiscalYear || row.calendarYear) === base.year - 1
        && row.reportedCurrency === data.currency && gap >= 330 && gap <= 400
        && fullAnnualPeriod(row);
    });
    const source = row => row?.propertyFvNormalization && row?.sourceBasis ? 'officialPropertyCashflow'
      : row?.balanceClassificationSource ? 'officialBalance'
      : row?.sourceIds?.length ? 'officialCashflow' : 'fmpStandardizedActual';
    const item = (amount, row, basis = 'revenueRatio', denominator = income.revenue) => ({
      amount: finite(amount) ? amount : null,
      percent: finite(amount) && finite(denominator) && denominator !== 0 ? amount / denominator * 100 : null,
      source: source(row), basis,
      provenance: { date: row?.date, sourceIds: row?.sourceIds, sourceBasis: row?.sourceBasis,
        currencyConversion: row?.currencyConversion,
        documents: row?.revenueCorrection
          ? Object.entries(statements.revenueProvenance?.documents || {})
            .filter(([id]) => row.revenueCorrection.sourceIds.includes(id)).map(([id, doc]) => ({ id, ...doc }))
          : row?.propertyFvNormalization && row?.sourceBasis
          ? Object.entries(statements.propertyFvProvenance?.documents || {})
            .filter(([id]) => row.sourceIds?.includes(id)).map(([id, doc]) => ({ id, ...doc }))
          : row?.balanceClassificationSource ? [row.balanceClassificationSource]
          : row?.sourceIds?.length ? (statements.cashflowProvenance?.documents || [])
            .filter(document => row.sourceIds.includes(document.id)) : [] }
    });
    const reviewedDa = income.revenueCorrection?.reviewedIncomeFields?.includes('depreciationAndAmortization');
    const da = reviewedDa || finite(income.depreciationAndAmortization)
      ? income.depreciationAndAmortization : cashflow?.depreciationAndAmortization;
    const ebit = finite(income.ebit) ? income.ebit
      : finite(income.ebitda) && finite(da) ? income.ebitda - da : null;
    const items = {
      growth: { ...item(income.revenue, income, 'annualRevenueGrowth'),
        percent: previous?.revenue > 0 ? (income.revenue / previous.revenue - 1) * 100 : null },
      ebitda: item(income.ebitda, income), ebit: item(ebit, income, finite(income.ebit) ? 'revenueRatio' : 'derivedEbitdaLessDa'),
      da: item(da, finite(income.depreciationAndAmortization) ? income : cashflow),
      cash: item(balance?.cashAndShortTermInvestments, balance, 'closingBalanceRevenueRatio'),
      receivables: item(balance?.netReceivables, balance, 'closingBalanceRevenueRatio'),
      inventories: item(balance?.inventory, balance, 'closingBalanceRevenueRatio'),
      payables: item(balance?.accountPayables, balance, 'closingBalanceRevenueRatio'),
      nwcChange: { ...item(finite(cashflow?.changeInWorkingCapital) ? -cashflow.changeInWorkingCapital : null,
        cashflow, 'negativeReportedWorkingCapitalCashImpact'), source: 'fmpStandardizedActual' },
      cfo: item(cashflow?.operatingCashFlow ?? cashflow?.netCashProvidedByOperatingActivities, cashflow),
      capex: item(cashflow?.capitalExpenditure, cashflow),
      tax: item(income.incomeTaxExpense, income, 'historicalEffectiveTaxNotForecastOperatingTax', income.incomeBeforeTax)
    };
    if (income.revenueCorrection) {
      items.growth.source = 'officialRevenue';
      items.growth.provenance.revenueCorrection = income.revenueCorrection;
      if (income.revenueCorrection.operatingCosts) {
        for (const key of ['ebit', 'ebitda', 'da']) {
          items[key].source = key === 'da' ? 'officialReport'
            : income.revenueCorrection.operatingIncomeBasis === 'derived' ? 'officialDerivedOperatingProfit' : 'officialOperatingProfit';
          items[key].provenance.revenueCorrection = income.revenueCorrection;
        }
      }
      const reviewed = income.revenueCorrection.reviewedIncomeFields || [];
      for (const [key, field] of [['ebit', 'operatingIncome'], ['ebitda', 'operatingIncome'],
        ['da', 'depreciationAndAmortization'], ['tax', 'incomeTaxExpense']]) {
        if (reviewed.includes(field) && (key !== 'ebitda' || reviewed.includes('depreciationAndAmortization'))) {
          items[key].source = ['ebit', 'ebitda'].includes(key)
            ? income.revenueCorrection.operatingIncomeBasis === 'derived' ? 'officialDerivedOperatingProfit' : 'officialOperatingProfit'
            : 'officialReport';
          items[key].provenance.revenueCorrection = income.revenueCorrection;
        }
      }
    }
    if (income.propertyFvNormalization) {
      for (const key of ['ebit', 'ebitda']) {
        items[key].source = 'officialPropertyFv';
        items[key].provenance.propertyFvNormalization = income.propertyFvNormalization;
        items[key].provenance.documents = Object.entries(statements.propertyFvProvenance?.documents || {})
          .filter(([id]) => income.propertyFvNormalization.sourceIds.includes(id)).map(([id, doc]) => ({ id, ...doc }));
      }
    }
    const review = data.sourceReview;
    const reported = !review?.reason && review?.years?.find(year => year.year === base.year);
    if (reported && review.currency === data.currency && review.unit === 'millions') {
      for (const [key, amount] of [['cfo', reported.official.reportedOperatingCashFlow], ['capex', -reported.fullCashCapex]]) {
        if (finite(amount)) items[key] = { ...item(amount * 1e6, null), source: 'officialReport',
          document: review.document, basis: key === 'capex' ? 'propertyAndPpeCashAdditions' : 'reportedCfoNotFmpReclassified' };
      }
    }
    return { reason: null, year: base.year, date: base.date, currency: data.currency, revenue: income.revenue, items,
      basis: 'Actual annual financial statements; flows for the full year, balances at that year end. Reference only.',
      fxBasis: income.currencyConversion || null,
      propertyFvProvenance: statements.propertyFvProvenance || null };
  }

  const formulas = {
    units: 'Amounts in calculation-currency units (not millions); shares in individual issued common shares. Input percentages are percentage points, divided by 100 in formulas.',
    revenue: 'Revenue[t] = Revenue[t-1] * (1 + growth[t]/100)',
    advanced: 'EBITDA = Revenue*ebitda/100; DA = Revenue*da/100; EBIT = EBITDA-DA; changeNwc = Revenue*nwcChange/100 (positive increase consumes cash); FCFF = EBIT*(1-tax/100)+DA+negativeCapEx-changeNwc. Legacy scenarios without workingCapitalMethod retain NWC=Revenue*(receivables+inventories-payables)/100 and changeNwc=NWC[t]-NWC[t-1].',
    cfo: 'CFO = Revenue*cfo/100; CashFlow = CFO+negativeCapEx. No additional DA or working-capital deduction. Vendor-style WACC/EV bridge, not independently defined FCFE.',
    capex: 'negativeCapEx = Revenue*capex/100 (input <= 0)',
    capm: 'Editing rf, beta or erp updates ke = rf+beta*erp; direct ke overrides are respected.',
    wacc: 'WACC[t] = ke[t]/100*(1-debtWeight[t]/100)+kd[t]/100*(1-tax[t]/100)*debtWeight[t]/100',
    discount: 'Discount[t] = PRODUCT(1+WACC[1], ..., 1+WACC[t]); PV[t] = CashFlow[t]/Discount[t]. End-of-year convention; no stub-year adjustment.',
    terminal: 'Primary Gordon TV = CashFlow[10]*(1+terminalGrowth/100)/(WACC[10]-terminalGrowth/100); PVTV = TV/Discount[10]. Requires WACC[10] > terminalGrowth/100. New scenarios suggest Damodaran-style 2.5% terminal growth (2%–3% band) and may suggest current EV/EBITDA as an exit multiple; both are labeled suggested defaults and never overwrite user edits. Alternate Advanced exit-multiple TV = EBITDA[10]*exitMultiple when supplied; otherwise N/A with reason.',
    bridge: 'EV = SUM(PV[1:10])+PVTV; Equity = EV-netDebt; Target = Equity/issuedShares. Snapshot net debt subtracted once; projected cash is disclosure only. Primary targetPrice uses Gordon; exit-multiple EV/equity/per-share are reported beside it when available.',
    native: 'Native API internals are not independently reproduced. Site native target = returned equityValue/verified issued common shares. Returned equityValuePerShare and dilutedSharesOutstanding are preserved separately. Reconciliation residuals are checks, not replacements for vendor outputs.',
    taxDefault: 'When analyst operating tax is missing, new scenarios use the arithmetic mean of five consecutive full-FY effective tax rates (tax expense / pretax) from statements; otherwise tax stays N/A.',
    operatingDefaults: 'Missing consensus CapEx/CFO/D&A/EBITDA use latest full-FY revenue ratios (labeled latest-fy). NWC uses five-year average change/revenue. Revenue growth is never invented beyond consensus coverage.'
  };
  return { fields, activeFields, fullAnnualPeriod, verifiedIncomeDocument, baseSource, verifiedRevenueCorrection, defaults, update, calculate, actualReference, missingInputs, upgradeWorkingCapital, exitMultipleTerminal, fiveYearEffectiveTax, fiveYearHistory, TERMINAL_GROWTH_REFERENCE, formulas };
});
