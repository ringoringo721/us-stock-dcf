(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DcfDrivers = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  function calculate(snapshot, scenario, helpers) {
    const { finite, day, days, yearLater, fail, operatingRatios, capitalInputs } = helpers;
    const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
    if ((scenario.currency && scenario.currency !== snapshot?.currency)
        || (scenario.modelVersion !== undefined && scenario.modelVersion !== 'fcff-v2')
        || ['fcf0', 'growth_10y'].some(key => own(scenario, key))) return fail('incompatibleSavedModel');
    const previewReasons = ['leaseClassificationRequired', 'leaseMappingUnverified', 'debtCompositionUnverified'];
    if (snapshot?.reason && !previewReasons.includes(snapshot.reason)) return fail(snapshot.reason);
    if (!snapshot || snapshot.version !== 1 || snapshot.method !== 'FCFF' || !['USD', 'HKD'].includes(snapshot.currency)
        || !day(snapshot.valuationDate) || !day(snapshot.balance?.date)
        || snapshot.balance.date > snapshot.valuationDate) return fail('invalidSource');
    const historical = operatingRatios(snapshot.ttm);
    if (!historical) return fail(snapshot.reason || 'incompleteTtm');
    if (snapshot.ttm.dates.at(-1) !== snapshot.balance.date
        || snapshot.ttm.workingCapital !== snapshot.balance.workingCapital) return fail('statementDateMismatch');
    const value = (key, fallback) => own(scenario, key) ? scenario[key]
      : own(snapshot.defaults || {}, key) ? snapshot.defaults[key] : fallback;
    const g = value('g'), tax = value('tax');
    const forecastGrowth = value('forecastGrowth', snapshot.defaults?.g);
    const ratios = Object.fromEntries(['depreciation', 'capex', 'workingCapital']
      .map(key => [key, value(key, historical[key])]));
    const ebitdaMargin = value('ebitdaMargin', (snapshot.ttm.ebit + snapshot.ttm.depreciation) / snapshot.ttm.revenue);
    const terminalMargin = value('terminalMargin', historical.operatingMargin);
    const terminalMethod = value('terminalMethod', 'roic');
    const timing = value('discountTiming', 'midYear');
    const depreciationBasis = value('depreciationBasis', 'analystSpread');
    const extrapolation = value('extrapolation', 'fade');
    if (![g, forecastGrowth, tax, ebitdaMargin, terminalMargin, ...Object.values(ratios)].every(finite)
        || tax < 0 || tax > 100 || g <= -100 || ratios.capex < 0 || ratios.depreciation < 0
        || forecastGrowth <= -100 || terminalMargin < 0 || !['roic', 'components'].includes(terminalMethod)
        || !['midYear', 'periodEnd'].includes(timing)
        || !['analystSpread', 'ttm'].includes(depreciationBasis)
        || !['fade', 'flat'].includes(extrapolation)) return fail('invalidOperatingAssumptions');
    const forecasts = snapshot.forecasts;
    if (!Array.isArray(forecasts) || !forecasts.length || forecasts.some((row, i) => !day(row.date)
        || !finite(row.revenue) || row.revenue <= 0 || (!finite(row.ebit) && !finite(row.ebitda))
        || (i && (days(forecasts[i - 1].date, row.date) < 330
          || days(forecasts[i - 1].date, row.date) > 400)))) return fail('missingAnalystAnchors');
    const upcoming = forecasts.filter(row => row.date > snapshot.valuationDate);
    if (!upcoming.length) return fail('missingAnalystAnchors');
    const ends = upcoming.slice(0, 10).map(row => row.date);
    const anchorEnd = ends.at(-1);
    for (let count = 1; ends.length < 10; count++) ends.push(yearLater(anchorEnd, count));
    const overrides = value('years', {});
    const allowed = ['revenue', 'revenueGrowth', 'ebitda', 'ebitdaMargin', 'depreciation',
      'depreciationRate', 'capex', 'capexRate', 'workingCapital', 'workingCapitalRate', 'tax'];
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
        || Object.values(overrides).some(row => !row || typeof row !== 'object' || Array.isArray(row)
          || Object.entries(row).some(([key, amount]) => !allowed.includes(key) || !finite(amount))
          || [['revenue', 'revenueGrowth'], ['ebitda', 'ebitdaMargin'], ['capex', 'capexRate'],
            ['depreciation', 'depreciationRate'], ['workingCapital', 'workingCapitalRate']]
            .some(pair => pair.every(key => own(row, key))))) return fail('invalidForecastOverrides');
    if (Object.keys(overrides).some(end => !ends.includes(end))) return fail('staleSavedPeriods');
    const previousAnchor = forecasts.filter(row => row.date < ends[0]).at(-1);
    const fiscalStart = previousAnchor?.date || yearLater(ends[0], -1);
    const annualReference = snapshot.annualReference;
    const reportedReference = day(annualReference?.date)
      && Math.abs(days(annualReference.date, fiscalStart)) < 30 && finite(annualReference.revenue);
    const initialRevenue = reportedReference ? annualReference.revenue : previousAnchor?.revenue;
    const revenueReference = { date: reportedReference ? annualReference.date : previousAnchor?.date,
      revenue: initialRevenue, source: reportedReference ? 'reportedAnnual' : 'analyst' };
    if (!finite(initialRevenue) || initialRevenue <= 0) return fail('missingAnalystAnchors');
    const lastAnchorIndex = Math.min(upcoming.length, 10) - 1;
    const lastAnchor = upcoming[lastAnchorIndex];
    const previousRevenue = lastAnchorIndex > 0 ? upcoming[lastAnchorIndex - 1].revenue : initialRevenue;
    const anchorGrowth = lastAnchor.revenue / previousRevenue - 1;
    const anchorDa = depreciationBasis === 'analystSpread' && finite(lastAnchor.ebit) && finite(lastAnchor.ebitda)
      && lastAnchor.ebitda >= lastAnchor.ebit ? lastAnchor.ebitda - lastAnchor.ebit
      : lastAnchor.revenue * ratios.depreciation;
    const anchorMargin = (finite(lastAnchor.ebitda) ? lastAnchor.ebitda : lastAnchor.ebit + anchorDa)
      / lastAnchor.revenue;
    const annuals = [];
    let previous = initialRevenue;
    for (const [index, end] of ends.entries()) {
      const anchor = upcoming.find(row => row.date === end), edit = overrides[end] || {};
      const fade = Math.min(1, (index - lastAnchorIndex) / Math.max(1, 9 - lastAnchorIndex));
      const growth = extrapolation === 'flat' ? 0 : anchorGrowth + (forecastGrowth / 100 - anchorGrowth) * fade;
      const projectedRevenue = anchor ? anchor.revenue : previous * (1 + growth);
      const revenue = own(edit, 'revenue') ? edit.revenue : own(edit, 'revenueGrowth')
        ? previous * (1 + edit.revenueGrowth) : projectedRevenue;
      const cashDriver = (name, rateName, fallback) => own(edit, name) ? edit[name]
        : own(edit, rateName) ? revenue * edit[rateName] : fallback;
      const spreadAvailable = depreciationBasis === 'analystSpread' && anchor && finite(anchor.ebit)
        && finite(anchor.ebitda) && anchor.ebitda >= anchor.ebit;
      const depreciation = cashDriver('depreciation', 'depreciationRate',
        spreadAvailable ? anchor.ebitda - anchor.ebit
          : revenue * ratios.depreciation);
      const defaultEbitda = anchor ? finite(anchor.ebitda) ? anchor.ebitda : anchor.ebit + depreciation
        : revenue * (extrapolation === 'flat' ? anchorMargin : anchorMargin + (ebitdaMargin - anchorMargin) * fade);
      const ebitda = cashDriver('ebitda', 'ebitdaMargin', defaultEbitda);
      const capex = cashDriver('capex', 'capexRate', revenue * ratios.capex);
      const workingCapital = cashDriver('workingCapital', 'workingCapitalRate', revenue * ratios.workingCapital);
      const yearTax = own(edit, 'tax') ? edit.tax : tax;
      const ebit = ebitda - depreciation, nopat = ebit * (1 - yearTax / 100);
      if (![revenue, ebitda, depreciation, capex, workingCapital, yearTax, nopat].every(finite)
          || revenue <= 0 || depreciation < 0 || capex < 0 || yearTax < 0 || yearTax > 100) {
        return fail('invalidForecastOverrides', { annuals });
      }
      annuals.push({ end, fiscalStart: index ? ends[index - 1] : fiscalStart,
        revenue, revenueGrowth: revenue / previous - 1, ebitda, ebit, nopat,
        depreciation, capex, workingCapital, tax: yearTax, anchor: !!anchor,
        sources: {
          revenue: own(edit, 'revenue') || own(edit, 'revenueGrowth') ? 'user'
            : anchor?.operatingBasis === 'exCorporateInvestmentIncomeScenario' ? 'exCorporateInvestmentIncome'
              : anchor ? 'analyst' : 'model',
          ebitda: own(edit, 'ebitda') || own(edit, 'ebitdaMargin') ? 'user'
            : anchor?.operatingBasis === 'normalizedRentalMarginScenario' ? 'normalizedRentalMargin'
              : anchor?.operatingBasis === 'exCorporateInvestmentIncomeScenario' ? 'exCorporateInvestmentIncome'
              : anchor ? finite(anchor.ebitda) ? 'analyst' : 'analystEbitPlusModelDa' : 'model',
          depreciation: own(edit, 'depreciation') || own(edit, 'depreciationRate') ? 'user'
            : spreadAvailable ? 'analystSpread' : 'model'
        }
      });
      previous = revenue;
    }
    const draft = { annuals };
    const ytd = snapshot.ytd, currentYearYtd = ytd?.date > fiscalStart;
    const actuals = currentYearYtd ? ytd : { revenue: 0, ebitda: 0, depreciation: 0, capex: 0 };
    if (!ytd || ytd.date !== snapshot.balance.date
        || !['revenue', 'ebitda', 'depreciation', 'capex'].every(key => finite(actuals[key]))) {
      return fail('missingCurrentPeriod', draft);
    }
    const remainingStart = currentYearYtd ? ytd.date : fiscalStart;
    if (remainingStart > snapshot.valuationDate || remainingStart >= ends[0]) return fail('invalidCurrentPeriod', draft);
    const first = annuals[0];
    if (['revenue', 'depreciation', 'capex'].some(key => first[key] < actuals[key])) {
      return fail('forecastConflictsWithActual', draft);
    }
    const { reason: capitalReason, ...capital } = snapshot.reason
      ? { reason: snapshot.reason } : capitalInputs(snapshot, scenario);
    const WACC = capitalReason ? null : capital.WACC;
    let openingNwc = snapshot.balance.workingCapital + (first.workingCapital - snapshot.balance.workingCapital)
      * days(snapshot.balance.date, snapshot.valuationDate) / days(snapshot.balance.date, first.end);
    const estimatedOpeningWorkingCapital = openingNwc;
    const periods = annuals.map((annual, index) => {
      const start = index ? annuals[index - 1].end : snapshot.valuationDate;
      const fraction = index ? 1 : days(start, annual.end) / days(remainingStart, annual.end);
      const flow = key => index ? annual[key] : (annual[key] - actuals[key]) * fraction;
      const revenue = flow('revenue'), ebitda = flow('ebitda'), depreciation = flow('depreciation');
      const capex = flow('capex'), ebit = ebitda - depreciation;
      const taxExpense = annual.tax === 0 ? 0 : ebit * annual.tax / 100;
      const nopat = ebit - taxExpense, nwcChange = annual.workingCapital - openingNwc;
      const fcff = nopat + depreciation - capex - nwcChange;
      const discountMs = timing === 'midYear' ? (Date.parse(start) + Date.parse(annual.end)) / 2 : Date.parse(annual.end);
      const time = (discountMs - Date.parse(snapshot.valuationDate)) / 86400000 / 365.25;
      const df = finite(WACC) ? 1 / (1 + WACC) ** time : null;
      openingNwc = annual.workingCapital;
      return { start, end: annual.end, annualEnd: annual.end, fiscalStart: annual.fiscalStart,
        partial: start !== annual.fiscalStart, anchor: annual.anchor, sources: annual.sources,
        revenue, ebitda, ebit, taxExpense, nopat, depreciation, capex, nwcChange, fcff,
        discountDate: new Date(discountMs).toISOString(), time, df, pv: finite(df) ? fcff * df : null };
    });
    if (periods.some(row => !['revenue', 'ebitda', 'ebit', 'taxExpense', 'nopat',
      'depreciation', 'capex', 'nwcChange', 'fcff', 'time'].every(key => finite(row[key])))) {
      return fail('invalidCalculation', draft);
    }
    const assumptions = { historical, ratios, tax, terminalMargin, ebitdaMargin,
      terminalMethod, discountTiming: timing, dayCount: 'Actual/365.25',
      horizon: ends.at(-1), depreciationBasis, extrapolation, forecastGrowth, revenueReference };
    const prepared = { annuals, periods, assumptions, estimatedOpeningWorkingCapital };
    if (capitalReason) return fail(capitalReason, prepared);
    const terminalRoicInput = value('terminalRoic', null);
    const terminalRoic = terminalRoicInput === null ? WACC * 100 : terminalRoicInput;
    if (terminalMethod === 'roic' && (!finite(terminalRoic) || terminalRoic <= 0 || terminalRoic < g)) {
      return fail('invalidTerminalReinvestment', prepared);
    }
    Object.assign(assumptions, { terminalRoic, terminalRoicBasis: terminalRoicInput === null ? 'WACC' : 'user' });
    const terminalRevenue = annuals.at(-1).revenue * (1 + g / 100);
    const terminalDaRate = value('terminalDepreciation', ratios.depreciation);
    const terminalCapexRate = value('terminalCapex', ratios.capex);
    const terminalNwcRate = value('terminalWorkingCapital', ratios.workingCapital);
    if (![terminalDaRate, terminalCapexRate, terminalNwcRate].every(finite)
        || terminalDaRate < 0 || terminalCapexRate < 0) return fail('invalidOperatingAssumptions', prepared);
    const terminalDepreciation = terminalRevenue * terminalDaRate;
    const terminalEbitdaMargin = value('terminalEbitdaMargin', terminalMargin + terminalDaRate);
    if (!finite(terminalEbitdaMargin) || terminalEbitdaMargin < terminalDaRate) {
      return fail('invalidOperatingAssumptions', prepared);
    }
    const terminalEbit = terminalRevenue * (terminalEbitdaMargin - terminalDaRate);
    const terminalEbitda = terminalEbit + terminalDepreciation;
    const terminalTax = terminalEbit * tax / 100, terminalNopat = terminalEbit - terminalTax;
    const terminalCapex = terminalRevenue * terminalCapexRate;
    const terminalNwcChange = (terminalRevenue - annuals.at(-1).revenue) * terminalNwcRate;
    const terminalReinvestment = terminalMethod === 'roic' ? terminalNopat * g / terminalRoic
      : terminalCapex - terminalDepreciation + terminalNwcChange;
    const terminalFcff = terminalNopat - terminalReinvestment;
    const terminalTime = days(snapshot.valuationDate, ends.at(-1)) / 365.25;
    const terminalDf = 1 / (1 + WACC) ** terminalTime;
    const sumPV = periods.reduce((sum, row) => sum + row.pv, 0);
    const tv = terminalFcff / (WACC - g / 100), pvTV = tv * terminalDf, ModelEV = sumPV + pvTV;
    const EquityVal = ModelEV - capital.financingDebt + capital.cash + capital.investments
      - capital.preferred - capital.minority;
    const fairVal = EquityVal / capital.shares;
    if (![terminalFcff, tv, pvTV, ModelEV, EquityVal, fairVal].every(finite)) return fail('invalidCalculation', prepared);
    return { version: 1, modelVersion: 'fcff-v2', method: 'FCFF', reason: null, ...capital, ...prepared,
      terminalRevenue, terminalEbitda, terminalDepreciation, terminalEbit, terminalTax, terminalNopat,
      terminalCapex, terminalNwcChange, terminalReinvestment, terminalFcff, terminalTime, terminalDf,
      terminalWarning: terminalMethod === 'components' && g > 0 && terminalReinvestment <= 0,
      sumPV, tv, pvTV, ModelEV, EquityVal, fairVal,
      premiumPct: fairVal > 0 ? (capital.price / fairVal - 1) * 100 : null };
  }
  return { calculate };
});
