(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FmpScenario = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const fail = code => { throw new Error(code); };
  const kinds = ['advanced', 'customLevered'];
  const fields = [
    ['growth', '營收成長率 (%)', 'Revenue growth (%)', -99.99, 1000],
    ['ebitda', 'EBITDA／營收 (%)', 'EBITDA / revenue (%)', -1000, 1000, 'advanced'],
    ['ebit', 'EBIT／營收 (%)，與 EBITDA 連動', 'EBIT / revenue (%), linked to EBITDA', -1000, 1000, 'advanced'],
    ['da', 'D&A／營收 (%)', 'D&A / revenue (%)', 0, 1000, 'advanced'],
    ['cash', '現金及短期投資／營收 (%)，僅展示', 'Cash / revenue (%), disclosure only', 0, 1000, 'advanced'],
    ['receivables', '應收／營收 (%)', 'Receivables / revenue (%)', 0, 1000, 'advanced'],
    ['inventories', '存貨／營收 (%)', 'Inventories / revenue (%)', -1000, 1000, 'advanced'],
    ['payables', '應付／營收 (%)', 'Payables / revenue (%)', 0, 1000, 'advanced'],
    ['cfo', 'CFO／營收 (%)', 'CFO / revenue (%)', -1000, 1000, 'customLevered'],
    ['capex', '資本開支／營收（負值，%）', 'CapEx / revenue (negative, %)', -1000, 0],
    ['tax', '營運稅率 (%)，由 FMP EBIT／EBIAT 推導', 'Operating tax (%), implied by FMP EBIT / EBIAT', -100, 100],
    ['beta', 'Beta', 'Beta', -10, 10],
    ['rf', '無風險利率 (%)', 'Risk-free rate (%)', -10, 50],
    ['erp', '股權風險溢價 (%)', 'Equity risk premium (%)', 0, 50],
    ['kd', '債務成本 (%)', 'Cost of debt (%)', 0, 100],
    ['ke', '股權成本 (%)', 'Cost of equity (%)', -10, 100],
    ['debtWeight', '債務佔資本 (%)', 'Debt / capital (%)', 0, 100]
  ];
  const activeFields = kind => fields.filter(field => !field[5] || field[5] === kind);

  function baseSource(data, statements) {
    const rows = data.models?.advanced?.data || [];
    if (data.currencyCheck?.reason || !rows.length) return { reason: 'SCENARIO_BASE_UNVERIFIED' };
    const evidence = data.currencyCheck;
    const candidates = (statements?.annual?.income || []).map(row => ({
      year: Number(row.fiscalYear || row.calendarYear), date: row.date, revenue: row.revenue,
      currency: row.reportedCurrency, source: 'FMP filed annual financials'
    }));
    if (finite(evidence.originalRevenue) && evidence.sourceDate) {
      const match = rows.find(row => row.revenue === evidence.modelRevenue
        && Number(row.year) === Number(evidence.sourceDate.slice(0, 4)));
      if (match) candidates.push({ year: Number(match.year), date: evidence.sourceDate,
        revenue: evidence.originalRevenue, currency: evidence.sourceCurrency, source: evidence.financialSource || evidence.basis });
    }
    const verified = candidates.filter(actual => actual.currency === evidence.sourceCurrency
      && actual.date <= data.capturedAt?.slice(0, 10) && actual.revenue > 0
      && rows.some(row => Number(row.year) === actual.year && finite(row.revenue)
        && finite(evidence.fx?.price) && evidence.fx.price > 0
        && Math.abs(row.revenue / actual.revenue / evidence.fx.price - 1) < 0.005));
    const latest = verified.sort((a, b) => b.year - a.year || b.date.localeCompare(a.date))[0];
    return latest ? { year: latest.year, date: latest.date, source: latest.source, reason: null }
      : { reason: 'SCENARIO_BASE_UNVERIFIED' };
  }

  function defaults(data, kind, shares) {
    if (!kinds.includes(kind) || !Number.isSafeInteger(shares) || shares <= 0
        || data.currencyCheck?.reason || data.models?.[kind]?.reason) fail('SCENARIO_SOURCE_UNAVAILABLE');
    const base = data.forecastBase;
    if (!Number.isInteger(base?.year) || base.reason) fail('SCENARIO_BASE_UNVERIFIED');
    const source = (data.models?.[kind]?.data || []).slice().sort((a, b) => Number(a.year) - Number(b.year));
    const opening = source.find(row => Number(row.year) === base.year);
    const projected = source.filter(row => Number(row.year) > base.year);
    if (!opening || !projected.length || projected.length > 10 || !(opening.revenue > 0)
        || projected.some((row, index) => Number(row.year) !== base.year + index + 1)) fail('SCENARIO_FORECAST_UNAVAILABLE');
    const last = projected.at(-1);
    if (!finite(last.longTermGrowthRate) || !finite(last.netDebt)) fail('SCENARIO_SOURCE_UNAVAILABLE');
    const years = [], warnings = [];
    let previousRevenue = opening.revenue;
    for (let index = 0; index < 10; index++) {
      const provider = projected[index], row = provider || last;
      if (!(row.revenue > 0)) fail('SCENARIO_SOURCE_UNAVAILABLE');
      const ratio = key => finite(row[key]) ? row[key] / row.revenue * 100 : fail(`SCENARIO_MISSING_${key}`);
      const number = key => finite(row[key]) ? row[key] : fail(`SCENARIO_MISSING_${key}`);
      const lastGrowth = projected.length > 1
        ? (last.revenue / projected.at(-2).revenue - 1) * 100 : (last.revenue / opening.revenue - 1) * 100;
      const growth = provider ? (row.revenue / previousRevenue - 1) * 100
        : lastGrowth + (last.longTermGrowthRate - lastGrowth) * (index + 1 - projected.length) / (10 - projected.length);
      const taxRow = (data.models?.advanced?.data || []).find(item => Number(item.year) === Number(row.year));
      if (!taxRow || !finite(taxRow.ebit) || taxRow.ebit === 0 || !finite(taxRow.ebiat)) fail('SCENARIO_TAX_UNAVAILABLE');
      let tax = (1 - taxRow.ebiat / taxRow.ebit) * 100, normalizedTax = false;
      if (tax < -100 || tax > 100) {
        if (!finite(taxRow.taxRate) || taxRow.taxRate < 0 || taxRow.taxRate > 100) fail('SCENARIO_TAX_UNAVAILABLE');
        warnings.push({ year: base.year + index + 1, code: 'NORMALIZED_TAX', original: tax, replacement: taxRow.taxRate });
        tax = taxRow.taxRate;
        normalizedTax = true;
      }
      const values = { growth, capex: ratio('capitalExpenditure'), tax,
        beta: number('beta'), rf: number('riskFreeRate'), erp: number('marketRiskPremium'),
        kd: number('costofDebt'), ke: number('costOfEquity'), debtWeight: number('debtWeighting') };
      if (kind === 'advanced') Object.assign(values, { ebitda: ratio('ebitda'), da: ratio('depreciation'),
        cash: ratio('totalCash'), receivables: ratio('receivables'), inventories: ratio('inventories'), payables: ratio('payable') });
      else values.cfo = ratio('operatingCashFlow');
      if (kind === 'advanced') values.ebit = values.ebitda - values.da;
      const origins = Object.fromEntries(Object.keys(values).map(key => [key, provider ? 'fmp' : 'extension']));
      if (provider) origins.tax = normalizedTax ? 'normalized-fmp-tax' : 'derived-fmp';
      if (kind === 'advanced') origins.ebit = 'derived';
      years.push({ year: base.year + index + 1, values, origins });
      if (provider) previousRevenue = row.revenue;
    }
    const openingNwc = kind === 'advanced'
      ? opening.receivables + opening.inventories - opening.payable : 0;
    if (!finite(openingNwc)) fail('SCENARIO_BASE_UNVERIFIED');
    return { version: 1, kind, symbol: data.symbol, currency: data.currency, shares,
      baseYear: base.year, baseDate: base.date, baseRevenue: opening.revenue, openingNwc,
      sourceCapturedAt: data.models[kind].capturedAt || data.capturedAt,
      providerYears: projected.map(row => Number(row.year)), warnings, netDebt: last.netDebt,
      terminalGrowth: last.longTermGrowthRate, years };
  }

  function update(scenario, index, key, value) {
    const item = scenario.years[index];
    if (!item || !activeFields(scenario.kind).some(field => field[0] === key)) fail('SCENARIO_INVALID_INPUT');
    item.values[key] = value;
    item.origins[key] = 'user';
    const set = (field, number, origin) => { item.values[field] = number; item.origins[field] = origin; };
    if (key === 'ebit') set('ebitda', finite(value) && finite(item.values.da) ? value + item.values.da : null, 'derived');
    if (key === 'ebitda' || key === 'da') set('ebit', finite(item.values.ebitda) && finite(item.values.da) ? item.values.ebitda - item.values.da : null, 'derived');
    if (['rf', 'beta', 'erp'].includes(key)) set('ke', [item.values.rf, item.values.beta, item.values.erp].every(finite)
      ? item.values.rf + item.values.beta * item.values.erp : null, 'capm');
  }

  function calculate(scenario) {
    if (scenario?.version !== 1 || !kinds.includes(scenario.kind)
        || !Number.isSafeInteger(scenario.shares) || scenario.shares <= 0
        || !Number.isInteger(scenario.baseYear) || !(scenario.baseRevenue > 0)
        || !finite(scenario.openingNwc) || !finite(scenario.netDebt)
        || !finite(scenario.terminalGrowth) || scenario.terminalGrowth < -10 || scenario.terminalGrowth > 20
        || scenario.years?.length !== 10) fail('SCENARIO_INVALID_INPUT');
    let revenue = scenario.baseRevenue, nwc = scenario.openingNwc, discount = 1, presentFlows = 0;
    const rows = scenario.years.map((item, index) => {
      if (item.year !== scenario.baseYear + index + 1) fail('SCENARIO_INVALID_YEARS');
      const v = item.values;
      for (const [key, , , min, max] of activeFields(scenario.kind)) {
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
        const nextNwc = revenue * (v.receivables + v.inventories - v.payables) / 100;
        changeNwc = nextNwc - nwc;
        nwc = nextNwc;
        projectedCash = revenue * v.cash / 100;
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
    return { targetPrice, enterpriseValue, equityValue, terminalValue, presentTerminalValue, presentFlows,
      netDebt: scenario.netDebt, wacc: last.wacc, g: scenario.terminalGrowth, rows };
  }
  return { fields, activeFields, baseSource, defaults, update, calculate };
});
