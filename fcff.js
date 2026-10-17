(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./dcf_drivers.js') : root.DcfDrivers);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Fcff = api;
})(typeof globalThis === 'object' ? globalThis : this, function (drivers) {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const days = (start, end) => (Date.parse(end) - Date.parse(start)) / 86400000;
  const yearLater = (value, count) => {
    const date = new Date(value), month = date.getUTCMonth();
    date.setUTCFullYear(date.getUTCFullYear() + count);
    if (date.getUTCMonth() !== month) date.setUTCDate(0);
    return date.toISOString().slice(0, 10);
  };
  const fail = (reason, extra = {}) => ({
    version: 1, method: 'FCFF', reason, fairVal: null, premiumPct: null,
    ModelEV: null, EquityVal: null, WACC: null, periods: [], ...extra
  });

  function operatingRatios(ttm) {
    const count = ttm?.reportingFrequency === 'annual' ? 1 : ttm?.reportingFrequency === 'semiannual' ? 2 : 4;
    const stride = 4 / count;
    if (!ttm || !Array.isArray(ttm.dates) || ttm.dates.length !== count
        || !Array.isArray(ttm.fiscalPeriods) || ttm.fiscalPeriods.length !== count
        || ttm.fiscalPeriods.some((period, i) => !Number.isInteger(period)
          || (i > 0 && period !== ttm.fiscalPeriods[i - 1] + stride))
        || ttm.dates.some((date, i) => !day(date) || (i > 0
          && (days(ttm.dates[i - 1], date) < stride * 60 || days(ttm.dates[i - 1], date) > stride * 120)))
        || !finite(ttm.revenue) || ttm.revenue <= 0
        || !['ebit', 'depreciation', 'capex', 'workingCapital'].every(key => finite(ttm[key]))) return null;
    return {
      basis: count === 1 ? 'latestCompleteReportedAnnualPeriod' : count === 2 ? 'latestTwoConsecutiveHalfYears' : 'latestFourConsecutiveFiscalQuarters',
      dates: [...ttm.dates],
      depreciation: ttm.depreciation / ttm.revenue,
      capex: ttm.capex / ttm.revenue,
      workingCapital: ttm.workingCapital / ttm.revenue,
      operatingMargin: ttm.ebit / ttm.revenue
    };
  }

  function capitalInputs(snapshot, scenario) {
    const parameter = name => Object.prototype.hasOwnProperty.call(scenario, name)
      ? scenario[name] : snapshot.defaults?.[name];
    const tax = parameter('tax'), rf = parameter('rf'), erp = parameter('erp');
    const beta = parameter('beta'), kd = parameter('kd'), g = parameter('g');
    const price = parameter('price'), shares = parameter('shares');
    const debt = parameter('debt'), cash = parameter('cash'), investments = parameter('investments');
    const leaseOverlap = parameter('leaseOverlap');
    if (!finite(snapshot.balance.leaseDebt) || snapshot.balance.leaseDebt < 0
        || !finite(leaseOverlap) || (snapshot.balance.leaseDebt > 0 && snapshot.leaseReconciled !== true)) {
      return fail('leaseClassificationRequired');
    }
    const preferred = parameter('preferred'), minority = parameter('minority');
    const manualRate = scenario.discountRate != null;
    if (![tax, g, price, shares, debt, cash, investments, preferred, minority].every(finite)
        || (!manualRate && ![rf, erp, beta, kd].every(finite))) {
      return fail('missingParameters');
    }
    if (tax < 0 || tax > 100 || erp < 0 || kd < 0 || price <= 0 || shares <= 0
        || debt < 0 || cash < 0 || investments < 0 || preferred < 0 || minority < 0 || g <= -100
        || leaseOverlap < 0 || leaseOverlap > snapshot.balance.leaseDebt || leaseOverlap > debt) {
      return fail('invalidParameters');
    }
    const financingDebt = debt - leaseOverlap;
    const E = price * shares, V = E + financingDebt + preferred + minority;
    const wE = E / V, wD = financingDebt / V, wP = preferred / V, wM = minority / V;
    const Ke = [rf, beta, erp].every(finite) ? rf / 100 + beta * erp / 100 : null;
    const Kd_after = finite(kd) ? kd / 100 * (1 - tax / 100) : null;
    const priorityCost = name => parameter(name) === null ? Ke
      : finite(parameter(name)) ? parameter(name) / 100 : null;
    const preferredCost = priorityCost('preferredCost'), minorityCost = priorityCost('minorityCost');
    if (!manualRate && (!finite(preferredCost) || !finite(minorityCost))) return fail('missingParameters');
    const WACC = manualRate
      ? scenario.discountRate : wE * Ke + wD * Kd_after + wP * preferredCost + wM * minorityCost;
    const base = { E, V, wE, wD, wP, wM, Ke, Kd_after, preferredCost, minorityCost,
      WACC, beta, reportedDebt: debt, leaseOverlap, financingDebt, cash, investments,
      preferred, minority, NetDebt: financingDebt - cash, tax, g, price, shares };
    if (!finite(WACC) || WACC <= g / 100 || WACC <= 0) return fail('invalidTerminalSpread', base);
    return { reason: null, ...base };
  }

  function calculate(snapshot, scenario = {}) {
    if (scenario.confirmFinancingAssumptions === true
        && snapshot && (!snapshot.reason
          || ['leaseClassificationRequired', 'leaseMappingUnverified', 'debtCompositionUnverified'].includes(snapshot.reason))) {
      if (!finite(scenario.leaseDebt)) return fail('missingParameters');
      if (scenario.leaseDebt < 0) return fail('invalidParameters');
      const assumed = { ...snapshot, reason: null, leaseReconciled: true,
        balance: { ...snapshot.balance, leaseDebt: scenario.leaseDebt,
          ...(finite(scenario.openingWorkingCapital) ? { workingCapital: scenario.openingWorkingCapital } : {}) },
        ttm: { ...snapshot.ttm, ...(finite(scenario.openingWorkingCapital) ? { workingCapital: scenario.openingWorkingCapital } : {}) } };
      const result = calculate(assumed, { ...scenario, confirmFinancingAssumptions: false });
      return { ...result, financingBasis: 'userConfirmedAssumptionsNotIssuerReconciliation' };
    }
    if (snapshot?.modelVersion === 'fcff-v2' || scenario.modelVersion === 'fcff-v2') {
      return drivers.calculate(snapshot, scenario, { finite, day, days, yearLater, fail, operatingRatios, capitalInputs });
    }
    if (Object.prototype.hasOwnProperty.call(scenario, 'fcf0')
        || Object.prototype.hasOwnProperty.call(scenario, 'growth_10y')
        || (scenario.modelVersion !== undefined && scenario.modelVersion !== 'fcff-v1')) {
      return fail('incompatibleSavedModel');
    }
    if (scenario.currency && scenario.currency !== snapshot?.currency) return fail('incompatibleSavedModel');
    if (snapshot?.reason) return fail(snapshot.reason);
    if (!snapshot || snapshot.version !== 1 || snapshot.method !== 'FCFF'
        || !['USD', 'HKD'].includes(snapshot.currency) || !day(snapshot.valuationDate)
        || !day(snapshot.balance?.date) || snapshot.balance.date > snapshot.valuationDate) {
      return fail('invalidSource');
    }
    const historical = operatingRatios(snapshot.ttm);
    if (!historical) return fail('incompleteTtm');
    if (snapshot.ttm.dates.at(-1) !== snapshot.balance.date
        || snapshot.ttm.workingCapital !== snapshot.balance.workingCapital) {
      return fail('statementDateMismatch');
    }
    const { reason, ...base } = capitalInputs(snapshot, scenario);
    if (reason) return fail(reason, base);
    const { WACC, tax, g, price, shares, financingDebt, cash, investments, preferred, minority } = base;
    const parameter = name => Object.prototype.hasOwnProperty.call(scenario, name)
      ? scenario[name] : snapshot.defaults?.[name];
    const terminalRoicInput = parameter('terminalRoic');
    const terminalRoic = terminalRoicInput === null ? WACC * 100 : terminalRoicInput;
    if (!finite(terminalRoic) || terminalRoic <= 0 || terminalRoic < g) {
      return fail('invalidTerminalReinvestment', base);
    }
    const terminalMargin = Object.prototype.hasOwnProperty.call(scenario, 'terminalMargin')
      ? scenario.terminalMargin : historical.operatingMargin;
    const ratios = {};
    for (const key of ['depreciation', 'capex', 'workingCapital']) {
      ratios[key] = Object.prototype.hasOwnProperty.call(scenario, key)
        ? scenario[key] : historical[key];
    }
    if (!Object.values(ratios).every(finite) || ratios.depreciation < 0 || ratios.capex < 0
        || !finite(terminalMargin) || terminalMargin < 0) return fail('invalidOperatingAssumptions', base);
    const forecasts = snapshot.forecasts;
    if (!Array.isArray(forecasts) || !forecasts.length
        || forecasts.some((row, i) => !day(row?.date) || !finite(row.revenue) || row.revenue <= 0
          || !finite(row.ebit) || (i > 0 && (row.date <= forecasts[i - 1].date
            || days(forecasts[i - 1].date, row.date) < 330
            || days(forecasts[i - 1].date, row.date) > 400)))) {
      return fail('missingAnalystAnchors', base);
    }
    const upcoming = forecasts.filter(row => row.date > snapshot.valuationDate);
    if (!upcoming.length) return fail('missingAnalystAnchors', base);
    const first = upcoming[0], previous = forecasts.filter(row => row.date < first.date).at(-1);
    const fiscalStart = previous?.date || yearLater(first.date, -1);
    const ytd = snapshot.ytd;
    if (!ytd || ytd.date !== snapshot.balance.date || !day(ytd.date)
        || !finite(ytd.revenue) || !finite(ytd.ebit)
        || !finite(snapshot.balance.workingCapital)) return fail('missingCurrentPeriod', base);
    const currentYearYtd = ytd.date > fiscalStart;
    const remainingStart = currentYearYtd ? ytd.date : fiscalStart;
    if (remainingStart > snapshot.valuationDate || remainingStart >= first.date) {
      return fail('invalidCurrentPeriod', base);
    }
    const remainingRevenue = first.revenue - (currentYearYtd ? ytd.revenue : 0);
    const remainingEbit = first.ebit - (currentYearYtd ? ytd.ebit : 0);
    if (remainingRevenue < 0 || !finite(remainingEbit)) return fail('forecastConflictsWithActual', base);
    const lastAnchor = upcoming.at(-1), priorIndex = forecasts.indexOf(lastAnchor) - 1;
    const priorAnchor = priorIndex >= 0 ? forecasts[priorIndex] : null;
    const priorRevenue = priorAnchor?.revenue ?? snapshot.annualReference?.revenue;
    if (!finite(priorRevenue) || priorRevenue <= 0) return fail('missingAnalystAnchors', base);
    const anchorGrowth = lastAnchor.revenue / priorRevenue - 1;
    const anchorMargin = lastAnchor.ebit / lastAnchor.revenue;
    const horizon = yearLater(snapshot.valuationDate, 10);
    const fadeYears = Math.max(1, Number(horizon.slice(0, 4)) - Number(lastAnchor.date.slice(0, 4)));
    const assumptions = { historical, ratios, tax, terminalMargin, terminalRoic,
      terminalRoicBasis: terminalRoicInput === null ? 'WACC' : 'user',
      dayCount: 'Actual/365.25', discountTiming: 'periodEnd', horizon };
    const periods = [];
    let start = snapshot.valuationDate, annualEnd = first.date, annualRevenue = first.revenue;
    let annualEbit = first.ebit, lastYearRevenue = first.revenue;
    const initialTarget = first.revenue * ratios.workingCapital;
    const balanceToEnd = days(snapshot.balance.date, first.date);
    if (balanceToEnd <= 0) return fail('invalidCurrentPeriod', base);
    let workingCapital = snapshot.balance.workingCapital + (initialTarget - snapshot.balance.workingCapital)
      * days(snapshot.balance.date, start) / balanceToEnd;
    const estimatedOpeningWorkingCapital = workingCapital;
    let sumPV = 0, extrapolated = 0;
    while (start < horizon && periods.length < 12) {
      const anchor = upcoming.find(row => row.date === annualEnd);
      if (anchor) { annualRevenue = anchor.revenue; annualEbit = anchor.ebit; }
      else {
        extrapolated++;
        const fade = Math.min(1, extrapolated / fadeYears);
        const growth = anchorGrowth + (g / 100 - anchorGrowth) * fade;
        const margin = anchorMargin + (terminalMargin - anchorMargin) * fade;
        if (!finite(growth) || growth <= -1) return fail('invalidForecastGrowth', base);
        annualRevenue = lastYearRevenue * (1 + growth);
        annualEbit = annualRevenue * margin;
      }
      const end = annualEnd < horizon ? annualEnd : horizon;
      const isFirst = periods.length === 0;
      const annualStart = isFirst ? fiscalStart : start;
      const remainingFraction = days(start, end) / days(isFirst ? remainingStart : annualStart, annualEnd);
      const revenue = isFirst ? remainingRevenue * remainingFraction : annualRevenue * remainingFraction;
      const ebit = isFirst ? remainingEbit * remainingFraction : annualEbit * remainingFraction;
      const annualNwc = annualRevenue * ratios.workingCapital;
      const nwcChange = (annualNwc - workingCapital) * days(start, end) / days(start, annualEnd);
      const nopat = ebit * (1 - tax / 100);
      const depreciation = revenue * ratios.depreciation, capex = revenue * ratios.capex;
      const fcff = nopat + depreciation - capex - nwcChange;
      const time = days(snapshot.valuationDate, end) / 365.25;
      const df = 1 / (1 + WACC) ** time, pv = fcff * df;
      if (![revenue, ebit, nopat, depreciation, capex, nwcChange, fcff, time, df, pv].every(finite)) {
        return fail('invalidCalculation', base);
      }
      periods.push({ start, end, annualEnd, time, revenue, ebit, nopat, depreciation, capex,
        nwcChange, fcff, df, pv, anchor: !!anchor,
        source: anchor ? 'analystRevenueEbitWithModelCashFlow' : 'modelExtrapolation',
        partial: start !== annualStart || end !== annualEnd });
      sumPV += pv;
      workingCapital += nwcChange;
      lastYearRevenue = annualRevenue;
      start = end;
      annualEnd = upcoming.find(row => row.date > annualEnd)?.date || yearLater(annualEnd, 1);
    }
    if (start !== horizon) return fail('invalidForecastHorizon', base);
    const terminalNopat = annualRevenue * (1 + g / 100) * terminalMargin * (1 - tax / 100);
    const terminalReinvestment = terminalNopat * g / terminalRoic;
    const terminalFcff = terminalNopat - terminalReinvestment;
    const tv = terminalFcff / (WACC - g / 100), pvTV = tv * periods.at(-1).df;
    const ModelEV = sumPV + pvTV;
    const EquityVal = ModelEV - financingDebt + cash + investments - preferred - minority;
    const fairVal = EquityVal / shares;
    if (![terminalNopat, terminalReinvestment, terminalFcff, tv, pvTV, ModelEV, EquityVal, fairVal].every(finite)) {
      return fail('invalidCalculation', base);
    }
    return { version: 1, method: 'FCFF', reason: null, ...base, assumptions, periods,
      estimatedOpeningWorkingCapital, sumPV, terminalNopat, terminalReinvestment,
      terminalFcff, tv, pvTV, ModelEV, EquityVal, fairVal,
      premiumPct: fairVal > 0 ? (price / fairVal - 1) * 100 : null };
  }
  return { calculate, operatingRatios };
});
