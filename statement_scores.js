(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StatementScores = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const number = (row, ...fields) => {
    for (const field of fields) if (finite(row?.[field])) return row[field];
    return null;
  };
  const ratio = (a, b) => finite(a) && finite(b) && b > 0 ? a / b : null;
  const key = row => Number(row.fiscalYear || row.calendarYear) * 4 + Number(String(row.period)[1]);
  const sorted = rows => (rows || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const sum = (rows, ...fields) => {
    const values = rows.map(row => number(row, ...fields));
    return values.length && values.every(finite) ? values.reduce((a, b) => a + b, 0) : null;
  };
  const aligned = (income, cashflow, balance, opening) => income.length && income.length === cashflow.length
    && balance && opening && income.every((row, i) => row.date === cashflow[i]?.date)
    && new Set([...income, ...cashflow, balance, opening].map(row => row.reportedCurrency)).size === 1;
  function observations(data) {
    const step = data.reportingFrequency === 'semiannual' ? 2 : 1, count = 4 / step;
    const income = sorted(data.quarterly?.income), cashflow = data.quarterly?.cashflow || [];
    const balances = data.quarterly?.balance || [], last = income.at(-1);
    if (last && income.length >= count * 2) {
      const flows = income.slice(-count * 2), finalKey = key(last);
      const valid = flows.every((row, i) => !i || key(row) === key(flows[i - 1]) + step
        && (Date.parse(row.date) - Date.parse(flows[i - 1].date)) / 86400000 >= step * 60
        && (Date.parse(row.date) - Date.parse(flows[i - 1].date)) / 86400000 <= step * 120);
      const closing = balances.find(row => key(row) === finalKey && row.date === last.date);
      const opening = balances.find(row => key(row) === finalKey - 4);
      const earlier = balances.find(row => key(row) === finalKey - 8);
      const currentIncome = flows.slice(-count), priorIncome = flows.slice(0, count);
      const matching = rows => rows.map(row => cashflow.find(other => other.date === row.date && key(other) === key(row)));
      const currentCf = matching(currentIncome), priorCf = matching(priorIncome);
      if (valid && aligned(currentIncome, currentCf, closing, opening)
          && aligned(priorIncome, priorCf, opening, earlier)) {
        return { date: last.date, period: `FY ${last.fiscalYear || last.calendarYear} ${step === 2 ? `H${Number(last.period[1]) / 2}` : last.period}`,
          basis: 'comparableTtm', income: currentIncome, priorIncome, cashflow: currentCf,
          balance: closing, opening, earlier };
      }
    }
    const annual = sorted(data.annual?.income);
    for (let i = annual.length - 1; i >= 1; i--) {
      const current = annual[i], previous = annual[i - 1];
      if (Number(current.fiscalYear || current.calendarYear) !== Number(previous.fiscalYear || previous.calendarYear) + 1) continue;
      const duration = (Date.parse(current.date) - Date.parse(previous.date)) / 86400000;
      if (duration < 330 || duration > 400) continue;
      const balance = data.annual.balance.find(row => row.date === current.date);
      const opening = data.annual.balance.find(row => row.date === previous.date);
      const earlierIncome = annual[i - 2];
      const earlier = earlierIncome && data.annual.balance.find(row => row.date === earlierIncome.date);
      const cf = data.annual.cashflow.find(row => row.date === current.date);
      if (previous.reportedCurrency === current.reportedCurrency && aligned([current], [cf], balance, opening)) {
        return { date: current.date, period: `FY ${current.fiscalYear || current.calendarYear}`,
          basis: 'comparableAnnual', income: [current], priorIncome: [previous], cashflow: [cf],
          balance, opening, earlier };
      }
    }
    return null;
  }
  function calculate(data) {
    const source = observations(data);
    const descriptions = [
      ['盈利能力', '資產回報率 ROA > 0', 'Positive ROA'],
      ['盈利能力', '營業現金流 CFO > 0', 'Positive operating cash flow'],
      ['盈利能力', '資產回報率改善 (ΔROA > 0)', 'Improvement in ROA'],
      ['盈利能力', '營業現金流高於淨利潤 (CFO > 淨利潤)', 'Operating cash flow exceeds net income'],
      ['槓桿與償債', '長期負債資產比下降', 'Lower long-term debt to assets'],
      ['槓桿與償債', '流動比率改善', 'Improvement in current ratio'],
      ['槓桿與償債', '期間無現金增發普通股', 'No cash common-equity issuance'],
      ['營運效率', '毛利率改善', 'Improvement in gross margin'],
      ['營運效率', '資產週轉率改善', 'Improvement in asset turnover']
    ];
    const items = descriptions.map(([category, desc, desc_en], i) => ({
      id: i + 1, category, desc, desc_en, passed: null, detail: 'N/A', reason: 'missingComparableStatements'
    }));
    const result = { score: null, items, date: source?.date || null, period: source?.period || null,
      basis: source?.basis || null, evaluatedTests: 0, passedTests: 0, reason: 'missingComparableStatements' };
    if (!source) return result;
    const { income, priorIncome, cashflow, balance, opening, earlier } = source;
    const net = sum(income, 'netIncome'), priorNet = sum(priorIncome, 'netIncome');
    const cfo = sum(cashflow, 'operatingCashFlow', 'netCashProvidedByOperatingActivities');
    const earlierAssets = earlier?.reportedCurrency === opening.reportedCurrency ? number(earlier, 'totalAssets') : null;
    const roa = ratio(net, number(opening, 'totalAssets')), priorRoa = ratio(priorNet, earlierAssets);
    const leverage = ratio(number(balance, 'longTermDebt'), number(balance, 'totalAssets'));
    const priorLeverage = ratio(number(opening, 'longTermDebt'), number(opening, 'totalAssets'));
    const liquidity = ratio(number(balance, 'totalCurrentAssets'), number(balance, 'totalCurrentLiabilities'));
    const priorLiquidity = ratio(number(opening, 'totalCurrentAssets'), number(opening, 'totalCurrentLiabilities'));
    const issuance = sum(cashflow, 'commonStockIssuance', 'commonStockIssued');
    const margin = ratio(sum(income, 'grossProfit'), sum(income, 'revenue'));
    const priorMargin = ratio(sum(priorIncome, 'grossProfit'), sum(priorIncome, 'revenue'));
    const turnover = ratio(sum(income, 'revenue'), number(opening, 'totalAssets'));
    const priorTurnover = ratio(sum(priorIncome, 'revenue'), earlierAssets);
    const checks = [
      [[roa], () => roa > 0], [[cfo], () => cfo > 0], [[roa, priorRoa], () => roa > priorRoa],
      [[cfo, net], () => cfo > net], [[leverage, priorLeverage], () => leverage < priorLeverage],
      [[liquidity, priorLiquidity], () => liquidity > priorLiquidity], [[issuance], () => issuance <= 0],
      [[margin, priorMargin], () => margin > priorMargin], [[turnover, priorTurnover], () => turnover > priorTurnover]
    ];
    checks.forEach(([values, compare], i) => {
      items[i].metrics = values;
      if (!values.every(finite)) { items[i].reason = 'missingCriterionInputs'; return; }
      items[i].passed = compare() ? 1 : 0;
      items[i].reason = null;
      items[i].detail = values.map(value => Number(value.toPrecision(8))).join(' / ');
    });
    result.evaluatedTests = items.filter(item => item.passed !== null).length;
    result.passedTests = items.filter(item => item.passed === 1).length;
    result.reason = result.evaluatedTests === 9 ? null : 'incompleteCriteria';
    result.score = result.reason ? null : result.passedTests;
    return result;
  }
  return { calculate };
});
