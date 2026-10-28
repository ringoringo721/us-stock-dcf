(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StatementDistressScores = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const number = (row, ...fields) => {
    for (const field of fields) if (finite(row?.[field])) return row[field];
    return null;
  };
  const ratio = (a, b) => finite(a) && finite(b) && b !== 0 ? a / b : null;
  const positiveRatio = (a, b) => finite(a) && finite(b) && b > 0 ? a / b : null;
  const sorted = rows => (rows || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const currencyOf = (...rows) => {
    const currencies = [...new Set(rows.filter(Boolean).map(row => row.reportedCurrency).filter(Boolean))];
    return currencies.length === 1 ? currencies[0] : null;
  };
  const fiscalYearOf = row => {
    const year = Number(row?.fiscalYear || row?.calendarYear);
    return Number.isFinite(year) ? year : null;
  };
  // Retail / 52-53 week filers often post BS dates a few days off the income/CF date.
  // Match exact date, else same fiscal year, else nearest row within 7 days.
  function matchStatementRow(rows, incomeRow, { maxDayDelta = 7 } = {}) {
    const list = rows || [];
    if (!incomeRow?.date) return null;
    const exact = list.find(row => row.date === incomeRow.date);
    if (exact) return exact;
    const year = fiscalYearOf(incomeRow);
    if (year !== null) {
      const byYear = list.filter(row => fiscalYearOf(row) === year);
      if (byYear.length === 1) return byYear[0];
      if (byYear.length > 1) {
        const target = Date.parse(incomeRow.date);
        return byYear.slice().sort((a, b) =>
          Math.abs(Date.parse(a.date) - target) - Math.abs(Date.parse(b.date) - target))[0];
      }
    }
    const target = Date.parse(incomeRow.date);
    let best = null;
    let bestAbs = Infinity;
    for (const row of list) {
      const delta = Math.abs(Date.parse(row.date) - target);
      if (delta < bestAbs) {
        bestAbs = delta;
        best = row;
      }
    }
    return bestAbs <= maxDayDelta * 86400000 ? best : null;
  }
  // Beneish YoY indexes: 0/0 → neutral 1 (same intensity both years). Missing or prior-only
  // zero still blocks the score (do not invent a spike magnitude).
  function indexRatio(numerator, denominator, reasonBuf) {
    if (!finite(numerator) || !finite(denominator)) {
      reasonBuf.reason = 'incompleteCriteria';
      return null;
    }
    if (numerator === 0 && denominator === 0) return 1;
    if (denominator === 0) {
      reasonBuf.reason = 'incompleteCriteria';
      return null;
    }
    return numerator / denominator;
  }

  function annualObservation(data, { needPrior = false } = {}) {
    const annualIncome = sorted(data?.annual?.income);
    for (let i = annualIncome.length - 1; i >= (needPrior ? 1 : 0); i--) {
      const current = annualIncome[i];
      const previous = needPrior ? annualIncome[i - 1] : null;
      if (current.periodLength !== undefined && current.periodLength !== 12) continue;
      if (previous && previous.periodLength !== undefined && previous.periodLength !== 12) continue;
      if (previous && current.comparabilityGroup && previous.comparabilityGroup
          && current.comparabilityGroup !== previous.comparabilityGroup) continue;
      if (previous && Number(current.fiscalYear || current.calendarYear)
          !== Number(previous.fiscalYear || previous.calendarYear) + 1) continue;
      if (previous) {
        const duration = (Date.parse(current.date) - Date.parse(previous.date)) / 86400000;
        if (duration < 330 || duration > 400) continue;
      }
      const balance = matchStatementRow(data.annual.balance, current);
      const priorBalance = previous ? matchStatementRow(data.annual.balance, previous) : null;
      const cashflow = matchStatementRow(data.annual.cashflow, current);
      const priorCashflow = previous ? matchStatementRow(data.annual.cashflow, previous) : null;
      if (!balance || !cashflow) continue;
      if (needPrior && (!priorBalance || !priorCashflow || !previous)) continue;
      const rows = needPrior
        ? [current, previous, balance, priorBalance, cashflow, priorCashflow]
        : [current, balance, cashflow];
      if (!currencyOf(...rows)) continue;
      return {
        date: current.date,
        period: `FY ${current.fiscalYear || current.calendarYear}`,
        basis: 'comparableAnnual',
        income: current,
        priorIncome: previous || null,
        balance,
        priorBalance: priorBalance || null,
        cashflow,
        priorCashflow: priorCashflow || null,
        scoringCurrency: current.reportedCurrency
      };
    }
    return null;
  }

  function naResult(kind, reason, extra = {}) {
    return {
      score: null,
      zone: null,
      model: kind === 'altman' ? null : undefined,
      items: [],
      date: null,
      period: null,
      basis: null,
      reason,
      scoringCurrency: null,
      ...extra
    };
  }

  function formatRatio(value, digits = 4) {
    return finite(value) ? Number(value.toPrecision(digits + 2)).toFixed(digits) : 'N/A';
  }

  function formatScore(value, digits = 2) {
    return finite(value) ? Number(value.toFixed(digits)) : null;
  }

  function altmanZone(z) {
    if (!finite(z)) return null;
    if (z > 4) return 'superRobust';
    if (z > 2.99) return 'safe';
    if (z >= 1.8) return 'grey';
    return 'distress';
  }

  function beneishZone(m) {
    if (!finite(m)) return null;
    if (m < -2) return 'clean';
    if (m <= -1.78) return 'windowDressing';
    return 'highRisk';
  }

  function calculateAltman(data, {
    mcapMillions = null,
    isFinancial = false,
    model = 'z'
  } = {}) {
    if (isFinancial) {
      return naResult('altman', 'financialSectorNotApplicable', { model: null, applicability: 'financialSector' });
    }
    const source = annualObservation(data, { needPrior: false });
    if (!source) return naResult('altman', 'missingComparableStatements', { model });

    const { income, balance } = source;
    const totalAssets = number(balance, 'totalAssets');
    const totalLiabilities = number(balance, 'totalLiabilities');
    const currentAssets = number(balance, 'totalCurrentAssets');
    const currentLiabilities = number(balance, 'totalCurrentLiabilities');
    const retainedEarnings = number(balance, 'retainedEarnings');
    const equity = number(balance, 'totalStockholdersEquity', 'totalEquity');
    const ebit = number(income, 'ebit', 'operatingIncome');
    const revenue = number(income, 'revenue');

    const x1 = ratio(finite(currentAssets) && finite(currentLiabilities)
      ? currentAssets - currentLiabilities : null, totalAssets);
    const x2 = ratio(retainedEarnings, totalAssets);
    const x3 = ratio(ebit, totalAssets);
    const x5 = positiveRatio(revenue, totalAssets);

    let x4 = null;
    let x4Basis = null;
    if (model === 'zPrime') {
      if (!(finite(equity) && equity > 0)) {
        return {
          score: null, zone: null, model: 'zPrime', items: [], date: source.date, period: source.period,
          basis: source.basis, reason: 'nonPositiveEquity', scoringCurrency: source.scoringCurrency
        };
      }
      x4 = positiveRatio(equity, totalLiabilities);
      x4Basis = 'bookEquity';
    } else {
      if (!(finite(mcapMillions) && mcapMillions > 0)) {
        return {
          score: null, zone: null, model: 'z', items: [], date: source.date, period: source.period,
          basis: source.basis, reason: 'missingMarketCap', scoringCurrency: source.scoringCurrency
        };
      }
      // Site mcap is millions of statement currency units; statement balances are absolute units.
      x4 = positiveRatio(mcapMillions * 1e6, totalLiabilities);
      x4Basis = 'marketEquity';
    }

    const weights = model === 'zPrime'
      ? { x1: 0.717, x2: 0.847, x3: 3.107, x4: 0.420, x5: 0.998 }
      : { x1: 1.2, x2: 1.4, x3: 3.3, x4: 0.6, x5: 1.0 };

    const ratios = { x1, x2, x3, x4, x5 };
    if (!Object.values(ratios).every(finite)) {
      return {
        score: null, zone: null, model, items: [], date: source.date, period: source.period,
        basis: source.basis, reason: 'incompleteCriteria', scoringCurrency: source.scoringCurrency,
        ratios
      };
    }
    if (!(finite(totalAssets) && totalAssets > 0) || !(finite(currentAssets) && finite(currentLiabilities))) {
      return {
        score: null, zone: null, model, items: [], date: source.date, period: source.period,
        basis: source.basis, reason: 'unreliableCurrentAccounts', scoringCurrency: source.scoringCurrency
      };
    }

    const contributions = {
      x1: weights.x1 * x1,
      x2: weights.x2 * x2,
      x3: weights.x3 * x3,
      x4: weights.x4 * x4,
      x5: weights.x5 * x5
    };
    const score = Object.values(contributions).reduce((sum, value) => sum + value, 0);
    const descriptions = model === 'zPrime' ? [
      ['營運資金', '營運資金 / 總資產 (X1)', 'Working capital / Total assets (X1)', weights.x1],
      ['保留盈餘', '保留盈餘 / 總資產 (X2)', 'Retained earnings / Total assets (X2)', weights.x2],
      ['獲利能力', 'EBIT / 總資產 (X3)', 'EBIT / Total assets (X3)', weights.x3],
      ['財務結構', '帳面股東權益 / 總負債 (X4′)', 'Book equity / Total liabilities (X4′)', weights.x4],
      ['資產週轉', '營收 / 總資產 (X5)', 'Sales / Total assets (X5)', weights.x5]
    ] : [
      ['營運資金', '營運資金 / 總資產 (X1)', 'Working capital / Total assets (X1)', weights.x1],
      ['保留盈餘', '保留盈餘 / 總資產 (X2)', 'Retained earnings / Total assets (X2)', weights.x2],
      ['獲利能力', 'EBIT / 總資產 (X3)', 'EBIT / Total assets (X3)', weights.x3],
      ['財務結構', '市值權益 / 總負債 (X4)', 'Market equity / Total liabilities (X4)', weights.x4],
      ['資產週轉', '營收 / 總資產 (X5)', 'Sales / Total assets (X5)', weights.x5]
    ];
    const keys = ['x1', 'x2', 'x3', 'x4', 'x5'];
    const items = descriptions.map(([category, desc, desc_en, weight], i) => {
      const key = keys[i];
      const value = ratios[key];
      const contribution = contributions[key];
      const detail = `${formatRatio(value)} × ${weight} = ${formatRatio(contribution)}`;
      return {
        id: i + 1,
        key,
        category,
        desc,
        desc_en,
        weight,
        value,
        contribution,
        passed: null,
        detail,
        detail_zh: detail,
        detail_en: detail,
        reason: null
      };
    });

    return {
      score: formatScore(score, 2),
      zone: model === 'z' ? altmanZone(score) : (score > 2.9 ? 'safe' : score >= 1.23 ? 'grey' : 'distress'),
      model,
      x4Basis,
      items,
      ratios,
      weights,
      date: source.date,
      period: source.period,
      basis: source.basis,
      reason: null,
      scoringCurrency: source.scoringCurrency,
      mcapMillions: model === 'z' ? mcapMillions : null
    };
  }

  function depRateOf(da, ppe) {
    if (!finite(da) || !finite(ppe)) return null;
    // Both zero ⇒ no depreciable base; treat as zero rate so DEPI can resolve 0/0 → 1.
    // Missing (null) DA/PPE still blocks.
    if (da + ppe === 0) return 0;
    return da / (da + ppe);
  }

  function calculateBeneishAtLatest(data) {
    const source = annualObservation(data, { needPrior: true });
    if (!source) return naResult('beneish', 'missingComparableStatements');

    const { income, priorIncome, balance, priorBalance, cashflow } = source;
    const sales = number(income, 'revenue');
    const priorSales = number(priorIncome, 'revenue');
    const ar = number(balance, 'accountsReceivables', 'netReceivables');
    const priorAr = number(priorBalance, 'accountsReceivables', 'netReceivables');
    const gp = number(income, 'grossProfit');
    const priorGp = number(priorIncome, 'grossProfit');
    const ca = number(balance, 'totalCurrentAssets');
    const priorCa = number(priorBalance, 'totalCurrentAssets');
    const ppe = number(balance, 'propertyPlantEquipmentNet');
    const priorPpe = number(priorBalance, 'propertyPlantEquipmentNet');
    const ta = number(balance, 'totalAssets');
    const priorTa = number(priorBalance, 'totalAssets');
    const da = number(income, 'depreciationAndAmortization')
      ?? number(cashflow, 'depreciationAndAmortization');
    const priorDa = number(priorIncome, 'depreciationAndAmortization')
      ?? number(source.priorCashflow, 'depreciationAndAmortization');
    const sga = number(income, 'sellingGeneralAndAdministrativeExpenses');
    const priorSga = number(priorIncome, 'sellingGeneralAndAdministrativeExpenses');
    const tl = number(balance, 'totalLiabilities');
    const priorTl = number(priorBalance, 'totalLiabilities');
    const ni = number(income, 'netIncome');
    const cfo = number(cashflow, 'operatingCashFlow', 'netCashProvidedByOperatingActivities');

    const reasonBuf = { reason: null };
    const gm = positiveRatio(gp, sales);
    const priorGm = positiveRatio(priorGp, priorSales);
    const aq = finite(ca) && finite(ppe) && finite(ta) && ta > 0 ? 1 - ((ca + ppe) / ta) : null;
    const priorAq = finite(priorCa) && finite(priorPpe) && finite(priorTa) && priorTa > 0
      ? 1 - ((priorCa + priorPpe) / priorTa) : null;
    const depRate = depRateOf(da, ppe);
    const priorDepRate = depRateOf(priorDa, priorPpe);
    // Intensity levels allow explicit 0 (cash AR, SGA rolled into COGS). indexRatio maps
    // 0/0 → neutral 1; prior-only zero still incomplete (do not invent a spike).
    const arSales = finite(ar) && finite(sales) && sales > 0 ? ar / sales : null;
    const priorArSales = finite(priorAr) && finite(priorSales) && priorSales > 0 ? priorAr / priorSales : null;
    // FMP often stores SGA as 0 when the 10-K rolls SG&A into operating expenses.
    // Treat non-positive SGA as undisclosed; SGAI defaults to neutral 1 (common Beneish practice).
    const sgaSales = finite(sga) && sga > 0 && finite(sales) && sales > 0 ? sga / sales : null;
    const priorSgaSales = finite(priorSga) && priorSga > 0 && finite(priorSales) && priorSales > 0
      ? priorSga / priorSales : null;

    const dsri = indexRatio(arSales, priorArSales, reasonBuf);
    const gmi = indexRatio(priorGm, gm, reasonBuf);
    const aqi = indexRatio(aq, priorAq, reasonBuf);
    const sgi = indexRatio(sales, priorSales, reasonBuf);
    const depi = indexRatio(priorDepRate, depRate, reasonBuf);
    const sgai = (sgaSales === null || priorSgaSales === null)
      ? 1
      : indexRatio(sgaSales, priorSgaSales, reasonBuf);
    const lvgi = indexRatio(
      finite(tl) && finite(ta) && ta > 0 ? tl / ta : null,
      finite(priorTl) && finite(priorTa) && priorTa > 0 ? priorTl / priorTa : null,
      reasonBuf
    );
    const tata = (() => {
      if (!(finite(ni) && finite(cfo) && finite(ta) && ta !== 0)) {
        reasonBuf.reason = 'incompleteCriteria';
        return null;
      }
      return (ni - cfo) / ta;
    })();

    const indices = { DSRI: dsri, GMI: gmi, AQI: aqi, SGI: sgi, DEPI: depi, SGAI: sgai, TATA: tata, LVGI: lvgi };
    if (Object.values(indices).some(value => !finite(value))) {
      return {
        score: null, zone: null, items: [], date: source.date, period: source.period,
        basis: source.basis, reason: 'incompleteCriteria', scoringCurrency: source.scoringCurrency,
        indices
      };
    }

    const weights = {
      intercept: -4.84,
      DSRI: 0.920,
      GMI: 0.528,
      AQI: 0.404,
      SGI: 0.892,
      DEPI: 0.115,
      SGAI: -0.172,
      TATA: 4.679,
      LVGI: -0.327
    };
    const contributions = Object.fromEntries(Object.entries(indices).map(([key, value]) => [key, weights[key] * value]));
    const score = weights.intercept + Object.values(contributions).reduce((sum, value) => sum + value, 0);

    const meta = [
      ['應收帳款', 'DSRI 應收帳款指數', 'DSRI Days sales receivable index', 'DSRI'],
      ['毛利率', 'GMI 毛利率指數', 'GMI Gross margin index', 'GMI'],
      ['資產質素', 'AQI 資產質素指數', 'AQI Asset quality index', 'AQI'],
      ['營收成長', 'SGI 銷售成長指數', 'SGI Sales growth index', 'SGI'],
      ['折舊', 'DEPI 折舊指數', 'DEPI Depreciation index', 'DEPI'],
      ['管銷費用', 'SGAI 管銷費用指數', 'SGAI SG&A index', 'SGAI'],
      ['應計項目', 'TATA 總應計項目 / 總資產', 'TATA Total accruals to total assets', 'TATA'],
      ['槓桿', 'LVGI 槓桿指數', 'LVGI Leverage index', 'LVGI']
    ];
    const items = meta.map(([category, desc, desc_en, key], i) => {
      const value = indices[key];
      const weight = weights[key];
      const contribution = contributions[key];
      const detail = `${formatRatio(value)} × ${weight} = ${formatRatio(contribution)}`;
      return {
        id: i + 1,
        key,
        category,
        desc,
        desc_en,
        weight,
        value,
        contribution,
        passed: null,
        detail,
        detail_zh: detail,
        detail_en: detail,
        reason: null
      };
    });

    return {
      score: formatScore(score, 2),
      zone: beneishZone(score),
      items,
      indices,
      weights,
      intercept: weights.intercept,
      date: source.date,
      period: source.period,
      basis: source.basis,
      reason: null,
      scoringCurrency: source.scoringCurrency
    };
  }

  // Newest FY pair can be incomplete (FMP zero AR/DA spikes). Walk older comparable
  // annual pairs so scores publish whenever any valid two-year window exists.
  function calculateBeneish(data, { isFinancial = false } = {}) {
    if (isFinancial) {
      return naResult('beneish', 'financialSectorNotApplicable', { applicability: 'financialSector' });
    }
    const annualIncome = sorted(data?.annual?.income);
    let last = naResult('beneish', 'missingComparableStatements');
    for (let end = annualIncome.length - 1; end >= 1; end--) {
      const truncated = {
        annual: {
          income: annualIncome.slice(0, end + 1),
          balance: data?.annual?.balance || [],
          cashflow: data?.annual?.cashflow || []
        },
        quarterly: data?.quarterly
      };
      const result = calculateBeneishAtLatest(truncated);
      if (Number.isFinite(result.score)) return result;
      last = result;
    }
    return last;
  }

  function calculateAll(data, options = {}) {
    const isFinancial = !!options.isFinancial;
    return {
      altman: calculateAltman(data, { ...options, isFinancial, model: options.altmanModel || 'z' }),
      beneish: calculateBeneish(data, { isFinancial })
    };
  }

  return {
    calculateAltman,
    calculateBeneish,
    calculateAll,
    altmanZone,
    beneishZone,
    annualObservation
  };
});
