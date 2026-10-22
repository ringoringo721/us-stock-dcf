(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StatementsModelPack = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  const Scenario = typeof module === 'object' && module.exports
    ? require('./fmp_scenario.js') : root.FmpScenario;
  const finite = value => typeof value === 'number' && Number.isFinite(value);

  function matchStatement(rows, date) {
    return (rows || []).find(row => row.date === date) || null;
  }

  function pct(numerator, revenue) {
    if (!(revenue > 0) || !finite(numerator)) return null;
    return (numerator / revenue) * 100;
  }

  function build(ticker, statements, stock, currency, capturedAt) {
    const full = Scenario.fullAnnualPeriod;
    const income = (statements.annual?.income || []).filter(row => full(row)
      && row.reportedCurrency === currency && row.revenue > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!income.length) throw new Error('SCENARIO_FORECAST_UNAVAILABLE');
    const latest = income.at(-1);
    const baseYear = Number(latest.fiscalYear || latest.calendarYear);
    if (!Number.isInteger(baseYear)) throw new Error('SCENARIO_FORECAST_UNAVAILABLE');
    const balance = matchStatement(statements.annual?.balance, latest.date);
    const cashflow = matchStatement(statements.annual?.cashflow, latest.date);
    const netDebt = finite(stock.net_debt) ? stock.net_debt * 1e6
      : finite(balance?.totalDebt) && finite(balance?.cashAndShortTermInvestments)
        ? balance.totalDebt - balance.cashAndShortTermInvestments
        : null;
    if (!finite(netDebt)) throw new Error('SCENARIO_SNAPSHOT_NET_DEBT_UNVERIFIED');
    const beta = finite(stock.beta) ? stock.beta : 1;
    const rf = finite(stock.rf) ? stock.rf : 4.3;
    const erp = finite(stock.erp) ? stock.erp : 4.75;
    const kd = finite(stock.kd) ? stock.kd : 4.5;
    const ke = rf + beta * erp;
    const taxRate = finite(latest.incomeBeforeTax) && latest.incomeBeforeTax > 0
      && finite(latest.incomeTaxExpense)
      ? (latest.incomeTaxExpense / latest.incomeBeforeTax) * 100
      : (finite(stock.tax) ? stock.tax : 21);
    const debt = finite(stock.debt) ? stock.debt * 1e6
      : (finite(balance?.totalDebt) ? balance.totalDebt : 0);
    const mcap = finite(stock.mcap) ? stock.mcap * 1e6
      : (finite(stock.price) && finite(stock.shares_outstanding)
        ? stock.price * stock.shares_outstanding : null);
    const totalCapital = finite(mcap) ? mcap + Math.max(debt, 0) : null;
    const debtWeight = totalCapital > 0 ? (Math.max(debt, 0) / totalCapital) * 100 : 0;
    const equityWeight = 100 - debtWeight;
    const afterTaxKd = kd * (1 - Math.min(Math.max(taxRate, 0), 100) / 100);
    const wacc = debtWeight / 100 * afterTaxKd + equityWeight / 100 * ke;
    const longTermGrowthRate = finite(stock.g) ? stock.g : 2.5;
    const shares = finite(stock.shares_outstanding) ? stock.shares_outstanding
      : (finite(stock.shares) ? stock.shares * 1e6 : null);
    const equityValue = finite(stock.fair_val) && shares > 0 ? stock.fair_val * shares : null;
    const enterpriseValue = finite(equityValue) ? equityValue + netDebt : null;
    const growthPath = Array.isArray(stock.growth_10y) && stock.growth_10y.length
      ? stock.growth_10y.map(value => finite(value) ? value : null)
      : Array.from({ length: 10 }, () => null);

    function ratiosFor(incomeRow, cashflowRow) {
      const revenue = incomeRow.revenue;
      const ebitda = incomeRow.ebitda;
      const ebit = incomeRow.operatingIncome ?? incomeRow.ebit;
      const da = incomeRow.depreciationAndAmortization;
      const capex = cashflowRow?.capitalExpenditure;
      const cfo = cashflowRow?.operatingCashFlow ?? cashflowRow?.netCashProvidedByOperatingActivities;
      return {
        revenue,
        ebitda: finite(ebitda) ? ebitda : null,
        ebit: finite(ebit) ? ebit : null,
        depreciation: finite(da) ? da : null,
        ebitdaPercentage: pct(ebitda, revenue),
        ebitPercentage: pct(ebit, revenue),
        depreciationPercentage: pct(da, revenue),
        capitalExpenditure: finite(capex) ? capex : null,
        capitalExpenditurePercentage: pct(capex, revenue),
        operatingCashFlowPercentage: pct(cfo, revenue),
        totalCashPercentage: pct(balance?.cashAndShortTermInvestments, revenue),
        receivablesPercentage: pct(balance?.netReceivables ?? balance?.accountsReceivables, revenue),
        inventoriesPercentage: pct(balance?.inventory, revenue),
        payablePercentage: pct(balance?.accountPayables, revenue)
      };
    }

    const baseCashflow = cashflow || matchStatement(statements.annual?.cashflow, latest.date);
    const baseRatios = ratiosFor(latest, baseCashflow);
    const capital = {
      price: finite(stock.price) ? stock.price : null,
      beta, dilutedSharesOutstanding: shares, costofDebt: kd, taxRate,
      afterTaxCostOfDebt: afterTaxKd, riskFreeRate: rf, marketRiskPremium: erp,
      costOfEquity: ke, totalDebt: debt, totalEquity: mcap, totalCapital,
      debtWeighting: debtWeight, equityWeighting: equityWeight, wacc,
      longTermGrowthRate, netDebt, equityValue, enterpriseValue,
      equityValuePerShare: finite(stock.fair_val) ? stock.fair_val : null
    };

    const historical = income.map(row => {
      const cf = matchStatement(statements.annual?.cashflow, row.date);
      const ratios = ratiosFor(row, cf);
      return {
        year: Number(row.fiscalYear || row.calendarYear),
        symbol: ticker,
        revenue: ratios.revenue,
        revenuePercentage: 0,
        ebitda: ratios.ebitda,
        ebitdaPercentage: ratios.ebitdaPercentage,
        ebit: ratios.ebit,
        ebitPercentage: ratios.ebitPercentage,
        depreciation: ratios.depreciation,
        depreciationPercentage: ratios.depreciationPercentage,
        totalCash: balance?.cashAndShortTermInvestments ?? null,
        totalCashPercentage: ratios.totalCashPercentage,
        receivables: balance?.netReceivables ?? balance?.accountsReceivables ?? null,
        receivablesPercentage: ratios.receivablesPercentage,
        inventories: balance?.inventory ?? null,
        inventoriesPercentage: ratios.inventoriesPercentage,
        payable: balance?.accountPayables ?? null,
        payablePercentage: ratios.payablePercentage,
        capitalExpenditure: ratios.capitalExpenditure,
        capitalExpenditurePercentage: ratios.capitalExpenditurePercentage,
        operatingCashFlowPercentage: ratios.operatingCashFlowPercentage,
        ...capital
      };
    });

    let revenue = latest.revenue;
    const projected = [];
    for (let index = 0; index < 10; index++) {
      const growth = growthPath[index];
      const growthPct = finite(growth) ? growth : (finite(growthPath.at(-1)) ? growthPath.at(-1) : 3);
      revenue *= 1 + growthPct / 100;
      projected.push({
        year: baseYear + index + 1,
        symbol: ticker,
        revenue,
        revenuePercentage: growthPct,
        ebitda: finite(baseRatios.ebitdaPercentage) ? revenue * baseRatios.ebitdaPercentage / 100 : null,
        ebitdaPercentage: baseRatios.ebitdaPercentage,
        ebit: finite(baseRatios.ebitPercentage) ? revenue * baseRatios.ebitPercentage / 100 : null,
        ebitPercentage: baseRatios.ebitPercentage,
        depreciation: finite(baseRatios.depreciationPercentage)
          ? revenue * baseRatios.depreciationPercentage / 100 : null,
        depreciationPercentage: baseRatios.depreciationPercentage,
        totalCash: null,
        totalCashPercentage: baseRatios.totalCashPercentage,
        receivables: null,
        receivablesPercentage: baseRatios.receivablesPercentage,
        inventories: null,
        inventoriesPercentage: baseRatios.inventoriesPercentage,
        payable: null,
        payablePercentage: baseRatios.payablePercentage,
        capitalExpenditure: finite(baseRatios.capitalExpenditurePercentage)
          ? revenue * baseRatios.capitalExpenditurePercentage / 100 : null,
        capitalExpenditurePercentage: baseRatios.capitalExpenditurePercentage,
        operatingCashFlowPercentage: baseRatios.operatingCashFlowPercentage,
        ...capital
      });
    }

    const rows = [...historical, ...projected];
    const model = {
      data: rows,
      reason: null,
      endpoint: 'statements-derived',
      capturedAt,
      source: 'annual statements_v2 + stock growth_10y defaults'
    };
    const currencyCheck = {
      reason: null,
      sourceCurrency: currency,
      currency,
      sourceDate: latest.date,
      sourcePeriodLength: latest.periodLength ?? 12,
      financialSource: 'storedAnnualFinancials',
      originalRevenue: latest.revenue,
      modelRevenue: latest.revenue,
      impliedRate: 1,
      fx: { price: 1, symbol: `${currency}${currency}` },
      basis: 'matchingHistoricalRevenue'
    };
    return {
      symbol: ticker,
      currency,
      capturedAt,
      models: {
        dcf: { data: [], reason: 'FMP_PROXY_UNAVAILABLE', endpoint: 'statements-derived', capturedAt },
        levered: { data: [], reason: 'FMP_PROXY_UNAVAILABLE', endpoint: 'statements-derived', capturedAt },
        advanced: model,
        customLevered: { ...model }
      },
      currencyCheck,
      forecastBase: {
        year: baseYear,
        date: latest.date,
        source: 'FMP filed annual financials',
        reason: null
      },
      hydratedFrom: 'statements_v2-offline',
      news: { data: [], reason: 'FMP_COMPANY_CACHE_MISSING' },
      ownership: { data: [], reason: 'FMP_COMPANY_CACHE_MISSING' },
      holders: { data: [], reason: 'FMP_COMPANY_CACHE_MISSING' },
      insiders: { data: [], reason: 'FMP_COMPANY_CACHE_MISSING' }
    };
  }

  return { build };
});
