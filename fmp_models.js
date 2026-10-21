(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FmpModels = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  const Scenario = typeof module === 'object' && module.exports ? require('./fmp_scenario.js') : root.FmpScenario;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const record = ticker => root.FMP_MODEL_DATA?.stocks?.[ticker] || null;
  const first = rows => (rows || []).slice().sort((a, b) => Number(b.year) - Number(a.year))[0];
  let state = null;

  function issuedShares(stock) {
    if (!stock.shareSource || stock.shareSource.reason || !finite(stock.shares_outstanding)) return null;
    const shares = Math.round(stock.shares_outstanding);
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(stock.shares_outstanding)) * 4;
    // Million-share source conversions can introduce a few floating-point ULPs.
    return Number.isSafeInteger(shares) && shares > 0
      && Math.abs(shares - stock.shares_outstanding) <= tolerance ? shares : null;
  }

  function value(data, kind, stock) {
    const unavailable = reason => ({ fairVal: null, reason, WACC: null, g: null });
    if (stock.corporateDcfApplicability === 'requiresSegmentValuation') return unavailable('FMP_SEGMENT_VALUATION_REQUIRED');
    if (!data || data.symbol !== stock.ticker || data.currency !== (stock.calculationCurrency || 'USD')) return unavailable('FMP_SOURCE_UNAVAILABLE');
    const model = data.models?.[kind];
    if (model?.reason) return unavailable(model.reason);
    if (data.currencyCheck?.reason) return unavailable(data.currencyCheck.reason);
    const row = first(model?.data);
    if (!row || row.symbol !== stock.ticker || !finite(row.equityValue) || !finite(row.enterpriseValue)) return unavailable('FMP_INVALID_RESPONSE');
    const shares = issuedShares(stock);
    if (shares === null) return unavailable('FMP_ISSUED_SHARES_UNAVAILABLE');
    if (!finite(row.wacc) || !finite(row.longTermGrowthRate) || row.wacc <= row.longTermGrowthRate) return unavailable('FMP_INVALID_TERMINAL_SPREAD');
    return { fairVal: row.equityValue / shares, reason: null, WACC: row.wacc / 100,
      g: row.longTermGrowthRate, ModelEV: row.enterpriseValue / 1e6, EquityVal: row.equityValue / 1e6,
      NetDebt: finite(row.netDebt) ? row.netDebt / 1e6 : null,
      issuedShares: shares, providerShares: row.dilutedSharesOutstanding,
      providerFairValue: row.equityValuePerShare, row, currency: data.currency, capturedAt: model.capturedAt || data.capturedAt };
  }

  const dcfApplicable = stock => stock?.fin_valuation?.is_financial !== true
    && stock?.corporateDcfApplicability !== 'requiresSegmentValuation';

  function reference(data, kind, stock) {
    if (!data || !dcfApplicable(stock)) return null;
    const model = data.models?.[kind], row = model?.data?.[0];
    return !model?.reason && row?.symbol === data.symbol && finite(row.dcf) ? row.dcf : null;
  }

  function priceDifference(valuation, price) {
    if (!finite(valuation) || !finite(price) || valuation <= 0 || price <= 0) return null;
    const value = (price / valuation - 1) * 100;
    return finite(value) ? value : null;
  }

  function compatible(saved) {
    return ['advanced', 'customLevered'].includes(saved?.kind)
      && (saved.schemaVersion === 1 && saved.modelType === 'FMP_CUSTOM_DCF'
        || saved.schemaVersion === 2 && saved.modelType === 'FMP_TEN_YEAR_SCENARIO'
          && saved.scenario?.version === 1 && saved.scenario.kind === saved.kind
          && saved.scenario.symbol === saved.ticker && saved.scenario.currency === saved.currency);
  }

  const fields = [
    ['revenueGrowthPct', 'revenuePercentage', '營收成長率 (%)', 'Revenue growth (%)', 100],
    ['ebitdaPct', 'ebitdaPercentage', 'EBITDA 利潤率 (%)', 'EBITDA margin (%)', 100, 'advanced'],
    ['ebitPct', 'ebitPercentage', 'EBIT 利潤率 (%)', 'EBIT margin (%)', 100, 'advanced'],
    ['depreciationAndAmortizationPct', 'depreciationPercentage', '折舊及攤銷／營收 (%)', 'D&A / revenue (%)', 100, 'advanced'],
    ['cashAndShortTermInvestmentsPct', 'totalCashPercentage', '現金及短期投資／營收 (%)', 'Cash and short-term investments / revenue (%)', 100, 'advanced'],
    ['receivablesPct', 'receivablesPercentage', '應收／營收 (%)', 'Receivables / revenue (%)', 100, 'advanced'],
    ['inventoriesPct', 'inventoriesPercentage', '存貨／營收 (%)', 'Inventories / revenue (%)', 100, 'advanced'],
    ['payablePct', 'payablePercentage', '應付／營收 (%)', 'Payables / revenue (%)', 100, 'advanced'],
    ['operatingCashFlowPct', 'operatingCashFlowPercentage', '營業現金流／營收 (%)', 'Operating cash flow / revenue (%)', 100, 'customLevered'],
    ['capitalExpenditurePct', 'capitalExpenditurePercentage', '資本開支／營收（負值，%）', 'CapEx / revenue (negative, %)', 100],
    ['beta', 'beta', 'Beta', 'Beta', 1],
    ['riskFreeRate', 'riskFreeRate', '無風險利率 (%)', 'Risk-free rate (%)', 1],
    ['marketRiskPremium', 'marketRiskPremium', '股權風險溢價 (%)', 'Market risk premium (%)', 1],
    ['costOfDebt', 'costofDebt', '債務成本 (%)', 'Cost of debt (%)', 1],
    ['costOfEquity', 'costOfEquity', '股權成本 (%)', 'Cost of equity (%)', 1],
    ['longTermGrowthRate', 'longTermGrowthRate', '終值增長率 (%)', 'Terminal growth (%)', 1]
  ];
  const name = kind => kind === 'advanced' ? 'FMP Custom DCF Advanced' : 'FMP Custom DCF Levered';
  function reasonText(reason, language) {
    const messages = {
      FMP_SEGMENT_VALUATION_REQUIRED: ['銀行／支付或權益法博彩投資須分部估值；原生 FMP 資料保留，但不當作已核實的單一企業 DCF。', 'Banking/payment or equity-accounted gaming investments require segment valuation; native FMP data is retained, not endorsed as a verified single corporate DCF.'],
      SCENARIO_BASE_UNVERIFIED: ['缺少與實際年度財報核對的基期；不猜測預測起點。', 'A verified actual fiscal-year baseline is unavailable; the projection start is not guessed.'],
      SCENARIO_REVENUE_SOURCE_UNVERIFIED: ['官方營收修正資料與股票或財報金額不符，須重新核對後才能建立情境。', 'Official revenue correction metadata does not match the security or financial amount; reconciliation is required.'],
      SCENARIO_FORECAST_UNAVAILABLE: ['完整 FMP 年度來源尚不可用，不能建立十年情境。', 'Full annual FMP source rows are unavailable; a ten-year scenario cannot be created.'],
      SCENARIO_SOURCE_UNAVAILABLE: ['缺少有效 FMP 模型或普通股股數，不能建立十年情境。', 'A valid FMP model or issued-share denominator is unavailable.'],
      SCENARIO_SNAPSHOT_NET_DEBT_UNVERIFIED: ['FMP 淨債務並非一致的來源快照，須核實後才能作股權價值調整。', 'FMP net debt is not a consistent source snapshot; verify its basis before the equity bridge.'],
      SCENARIO_INVALID_TERMINAL_SPREAD: ['第十年 WACC 必須高於終值增長率。', 'Year-ten WACC must exceed terminal growth.'],
      SCENARIO_INCOMPLETE_ASSUMPTIONS: ['分析師／實績假設尚未齊備；缺項為 N/A，未計算或儲存新估值。', 'Analyst/actual assumptions are incomplete. Missing inputs are N/A; no new valuation is calculated or saved.'],
      ANALYST_ACTUAL_BASE_UNAVAILABLE: ['缺少可用的最新完整財年核對資料，暫不採用共識。', 'Latest full-FY reconciliation data is unavailable; consensus is not applied.'],
      ANALYST_CURRENCY_SCALE_UNVERIFIED: ['分析師與財報金額口徑未能通過核對，暫不套用預測。', 'Consensus/reporting amount-scale reconciliation failed; forecasts are not applied.'],
      ANALYST_FX_UNVERIFIED: ['預測幣別或換匯依據未能核實，暫不套用。', 'Forecast currency/FX could not be verified; forecasts are not applied.'],
      ANALYST_SOURCE_UNAVAILABLE: ['尚無已核對的分析師預測來源。', 'Verified analyst forecast sources are unavailable.'],
      FMP_NO_COVERAGE: ['FMP 未提供此模型資料；不製造估值。', 'FMP supplies no rows for this model; no valuation is fabricated.'],
      FMP_MODEL_CURRENCY_UNVERIFIED: ['FMP 模型金額幣別尚未與財報核對，不能冒稱美元或港元。', 'FMP model currency could not be reconciled with financials; amounts are not relabeled as USD/HKD.'],
      FMP_OFFICIAL_REVENUE_SOURCE_UNVERIFIED: ['官方營收修正與供應商金額未能核對，暫不套用模型。', 'Official revenue correction could not be reconciled with provider amounts; the model is not applied.'],
      FMP_ISSUED_SHARES_UNAVAILABLE: ['缺少已核實的普通股股數；不以稀釋加權平均股數代替。', 'Verified issued common shares are missing; diluted weighted-average shares are not substituted.'],
      FMP_INVALID_TERMINAL_SPREAD: ['FMP 預設 WACC 不高於終值增長率；請調整並重新計算，不採無效終值。', 'FMP default WACC does not exceed terminal growth; adjust and recalculate rather than use an invalid terminal value.'],
      FMP_SOURCE_UNAVAILABLE: ['尚無此股票的 FMP 模型來源。', 'The FMP model source is unavailable for this security.'],
      EXIT_MULTIPLE_UNAVAILABLE: ['未提供出場倍數；不套用現價 EV/EBITDA 作為終值倍數。', 'No exit multiple was provided; current trading EV/EBITDA is not used as a terminal multiple.'],
      EXIT_MULTIPLE_ADVANCED_ONLY: ['出場倍數終值僅適用 Advanced（EBITDA／FCFF）情境。', 'Exit-multiple terminal value applies only to Advanced (EBITDA / FCFF) scenarios.'],
      EXIT_MULTIPLE_INVALID: ['出場倍數須為大於 0 且不超過 500 的數字。', 'Exit multiple must be a number greater than 0 and at most 500.'],
      EXIT_MULTIPLE_NONPOSITIVE_EBITDA: ['第十年 EBITDA 非正數，無法計算出場倍數終值。', 'Year-ten EBITDA is nonpositive; an exit-multiple terminal cannot be calculated.'],
      EXIT_MULTIPLE_NONFINITE_RESULT: ['出場倍數終值結果非有限數。', 'Exit-multiple terminal result is nonfinite.'],
      FINANCIAL_INSTITUTION: ['金融機構使用超額有形股本／DDM 面板，不套用企業 FCFF 信心標籤。', 'Financial institutions use the tangible-equity / DDM panel; corporate FCFF confidence does not apply.'],
      SEGMENT_VALUATION: ['須分部估值，單一企業內在價值信心標為不可用。', 'Segment valuation is required; single-corporate intrinsic confidence is unavailable.'],
      SHARE_BASIS: ['普通股股數未核實。', 'Issued common share basis is unverified.'],
      TERMINAL_SPREAD: ['終值利差無效（WACC 不高於終值增長率）。', 'Terminal spread is invalid (WACC does not exceed terminal growth).'],
      INCOMPLETE_SCENARIO: ['十年情境假設未齊備。', 'Ten-year scenario assumptions are incomplete.'],
      MISSING_STATEMENTS: ['實際財報參考未能載入。', 'Actual financial-statement references could not be loaded.'],
      VALUATION_UNAVAILABLE: ['目前沒有可用的內在價值結果。', 'No usable intrinsic-value result is available.'],
      OFFICIAL_CORRECTION_REVIEW: ['官方財報已更正或需審閱口徑差異；信心降為中。', 'Official statement corrections or basis differences require review; confidence is medium.'],
      GROWTH_REQUIRES_MANUAL_INPUT: ['歷史營收成長過高或波動過大，不自動填入以免假精度；請手動輸入。', 'Historical revenue growth is too high or volatile to autofill without false precision; enter growth manually.'],
      HISTORICAL_GROWTH_OUTLIER: ['歷史營收 CAGR 超出自動填入上限，僅作參考。', 'Historical revenue CAGR exceeds the autofill ceiling; shown as reference only.'],
      DATED_CURVE_TENOR_UNAVAILABLE: ['此年期在已標日期的公債／基準曲線擷取中不存在（目前多僅有 year10）；未改寫 retained-capital 無風險利率。', 'This tenor is absent from the dated treasury/benchmark capture (often year10 only); the retained-capital risk-free rate was not overwritten.']
    };
    return messages[reason]?.[language === 'en' ? 1 : 0] || reason || '';
  }

  function valuationConfidence({ stock, result, scenario = null, mode = 'vendor', statementsMissing = false }) {
    const pushUnique = (list, code) => { if (code && !list.includes(code)) list.push(code); };
    const pack = (level, reasons) => ({ level, reasons,
      label: { high: ['高', 'High'], medium: ['中', 'Medium'], low: ['低', 'Low'], unavailable: ['不可用', 'Unavailable'] }[level] });
    if (stock?.fin_valuation?.is_financial === true) return pack('unavailable', ['FINANCIAL_INSTITUTION']);
    if (stock?.corporateDcfApplicability === 'requiresSegmentValuation') return pack('unavailable', ['SEGMENT_VALUATION']);
    if (issuedShares(stock) === null) return pack('unavailable', ['SHARE_BASIS']);
    const reason = result?.reason || null;
    if (reason === 'FMP_INVALID_TERMINAL_SPREAD' || reason === 'SCENARIO_INVALID_TERMINAL_SPREAD') {
      return pack('unavailable', ['TERMINAL_SPREAD']);
    }
    const incomplete = reason === 'SCENARIO_INCOMPLETE_ASSUMPTIONS'
      || (mode === 'ten-year' && scenario && Scenario.missingInputs(scenario).length > 0);
    if (incomplete) return pack('low', ['INCOMPLETE_SCENARIO']);
    if (!finite(result?.fairVal)) return pack('unavailable', [reason || 'VALUATION_UNAVAILABLE']);
    const soft = [];
    if (statementsMissing) pushUnique(soft, 'MISSING_STATEMENTS');
    if (soft.includes('MISSING_STATEMENTS')) return pack('low', soft);
    if (soft.length || stock.balanceClassificationSource || stock.cashflowProvenance || stock.revenueProvenance
        || (result?.result?.warnings || []).length) {
      return pack('medium', soft.length ? soft : ['OFFICIAL_CORRECTION_REVIEW']);
    }
    return pack('high', []);
  }

  function confidenceText(confidence, language) {
    if (!confidence) return '';
    const en = language === 'en';
    const label = confidence.label?.[en ? 1 : 0] || confidence.level;
    const title = en ? 'Intrinsic-value confidence' : '內在價值信心';
    const detail = (confidence.reasons || []).map(code => reasonText(code, language)).filter(Boolean).join(en ? '; ' : '；');
    return detail ? `${title}: ${label} — ${detail}` : `${title}: ${label}`;
  }
  function load(options) {
    const previous = state?.ticker === options.ticker ? state : null;
    const saved = compatible(options.saved) && options.saved.currency === (options.stock.calculationCurrency || 'USD') ? options.saved : null;
    state = { ...options, kind: previous?.kind || saved?.kind || 'advanced',
      mode: previous?.mode || (saved?.modelType === 'FMP_TEN_YEAR_SCENARIO' ? 'ten-year' : 'vendor'),
      scenarios: previous?.scenarios || (saved?.modelType === 'FMP_TEN_YEAR_SCENARIO' ? { [saved.kind]: structuredClone(saved.scenario) } : {}),
      scenarioDirty: previous?.scenarioDirty || { advanced: false, customLevered: false },
      sourceData: previous?.sourceData || options.data || record(options.ticker),
      actualStatements: previous?.actualStatements || null, actualError: previous?.actualError || null,
      universe: options.universe || previous?.universe || null,
      params: previous?.params || { advanced: {}, customLevered: {}, ...(saved?.modelType === 'FMP_CUSTOM_DCF' ? { [saved.kind]: saved.params || {} } : {}) },
      dirty: previous?.dirty || { advanced: false, customLevered: false,
        ...(saved?.modelType === 'FMP_CUSTOM_DCF' ? { [saved.kind]: Object.keys(saved.params || {}).length > 0 && !saved.modelSummary } : {}) },
      data: previous?.data || options.data || record(options.ticker), requestId: (state?.requestId || 0) + 1 };
    if (!previous && saved?.modelSummary && saved.ticker === options.ticker && saved.issuedShares === issuedShares(options.stock)) {
      state.data = { ...state.data, models: { ...state.data.models,
        [saved.kind]: { ...state.data.models[saved.kind], data: [saved.modelSummary],
          capturedAt: saved.sourceCapturedAt, reason: null } } };
    }
    render();
  }

  function scenarioValue() {
    try {
      const shares = issuedShares(state.stock);
      if (shares === null) throw new Error('FMP_ISSUED_SHARES_UNAVAILABLE');
      if (!state.scenarios[state.kind]) {
        state.scenarios[state.kind] = Scenario.defaults(state.sourceData, state.kind, shares, {
          statements: state.actualStatements, stock: state.stock, peers: loadPeers()
        });
      }
      state.scenarios[state.kind] = Scenario.upgradeWorkingCapital(state.scenarios[state.kind]);
      const scenario = state.scenarios[state.kind];
      enrichScenarioSuggestions(scenario);
      const result = Scenario.calculate(scenario);
      if (scenario.symbol !== state.ticker || scenario.currency !== (state.stock.calculationCurrency || 'USD')
          || scenario.shares !== shares) throw new Error('SCENARIO_SOURCE_UNAVAILABLE');
      return { fairVal: result.targetPrice, WACC: result.wacc, g: result.g, reason: null, result,
        row: { enterpriseValue: result.enterpriseValue, equityValue: result.equityValue, netDebt: result.netDebt,
          terminalValue: result.terminalValue, presentTerminalValue: result.presentTerminalValue,
          wacc: result.wacc * 100, longTermGrowthRate: result.g },
        currency: scenario.currency, capturedAt: scenario.sourceCapturedAt, issuedShares: scenario.shares };
    } catch (error) {
      if (!/^(SCENARIO_|FMP_)/.test(error.message)) throw error;
      return { fairVal: null, reason: error.message };
    }
  }

  const inputValue = (key, number) => finite(number) ? key === 'beta' ? String(number) : number.toFixed(2) : '';

  function loadPeers() {
    const Peer = root.PeerComparison;
    const universe = typeof state.universe === 'function' ? state.universe() : state.universe;
    if (!Peer?.select || !universe || typeof universe !== 'object') return [];
    try { return Peer.select(universe, state.ticker, 5).peers || []; }
    catch { return []; }
  }

  function enrichScenarioSuggestions(scenario) {
    if (!scenario) return scenario;
    if (!Object.prototype.hasOwnProperty.call(scenario, 'exitMultiple')) scenario.exitMultiple = null;
    if (!scenario.netDebtDate) scenario.netDebtDate = scenario.baseDate || null;
    if (!scenario.netDebtBasis) {
      scenario.netDebtBasis = finite(scenario.netDebt) && scenario.netDebt < 0 ? 'net-cash' : 'net-debt';
    }
    if (!scenario.terminalGrowthReference) scenario.terminalGrowthReference = { ...Scenario.TERMINAL_GROWTH_REFERENCE };
    if (!finite(scenario.terminalGrowth) && scenario.terminalGrowthOrigin !== 'user') {
      scenario.terminalGrowth = Scenario.TERMINAL_GROWTH_REFERENCE.value;
      scenario.terminalGrowthOrigin = Scenario.TERMINAL_GROWTH_REFERENCE.origin;
    }
    if (!finite(scenario.exitMultiple) && scenario.exitMultipleOrigin !== 'user'
        && finite(state.stock?.ev_to_ebitda)
        && state.stock.ev_to_ebitda > 0 && state.stock.ev_to_ebitda <= 500) {
      scenario.exitMultiple = state.stock.ev_to_ebitda;
      scenario.exitMultipleOrigin = 'suggested-current-multiple';
    }
    const taxFive = Scenario.fiveYearEffectiveTax(state.actualStatements, {
      year: scenario.baseYear, date: scenario.baseDate
    }, state.sourceData?.currencyCheck?.sourceCurrency);
    scenario.taxFiveYear = taxFive;
    const latest = state.sourceData?.forecastActuals?.symbol === state.ticker
      && state.sourceData.forecastActuals.latest
      && !state.sourceData.forecastActuals.latest.reason
      ? state.sourceData.forecastActuals.latest : null;
    const opening = (state.sourceData?.models?.[scenario.kind]?.data || [])
      .find(row => Number(row.year) === scenario.baseYear);
    const modelBase = {
      ebitda: opening?.ebitdaPercentage, ebit: opening?.ebitPercentage, da: opening?.depreciationPercentage,
      cfo: opening?.operatingCashFlowPercentage, capex: opening?.capitalExpenditurePercentage,
      tax: opening?.taxRate
    };
    const fill = (item, key, value, origin) => {
      if (!finite(value)) return;
      if (['user', 'analyst', 'analyst-derived', 'derived', 'retained-capital'].includes(item.origins?.[key])) return;
      // Only fill blanks / unavailable, or refresh the same suggestion origin. Never demote a
      // higher-priority default (e.g. five-year tax) with a weaker fallback.
      if (finite(item.values[key]) && item.origins?.[key] !== 'unavailable' && item.origins?.[key] !== origin) return;
      item.values[key] = value;
      item.origins[key] = origin;
    };
    for (const item of scenario.years || []) {
      if (taxFive.percent != null) fill(item, 'tax', taxFive.percent, 'five-year-effective-tax');
      if (latest?.items?.tax?.percent != null) fill(item, 'tax', latest.items.tax.percent, 'latest-fy');
      fill(item, 'tax', modelBase.tax, 'fmp-base-year');
      for (const key of scenario.kind === 'customLevered'
        ? ['capex', 'cfo'] : ['capex', 'da', 'ebitda']) {
        fill(item, key, latest?.items?.[key]?.percent, 'latest-fy');
        fill(item, key, modelBase[key], 'fmp-base-year');
      }
      if (scenario.kind === 'advanced') {
        if (finite(item.values.ebitda) && finite(item.values.da)
            && (item.origins?.ebit === 'unavailable' || item.origins?.ebit === 'derived'
              || !finite(item.values.ebit))) {
          item.values.ebit = item.values.ebitda - item.values.da;
          item.origins.ebit = 'derived';
        }
        const nwc = state.sourceData?.forecastActuals?.workingCapital?.nwcChange;
        fill(item, 'nwcChange', nwc, 'working-capital-average');
      }
    }
    const growthSuggestion = Scenario.suggestRevenueGrowth({
      statements: state.actualStatements, data: state.sourceData, peers: loadPeers()
    });
    scenario.growthSuggestion = growthSuggestion;
    if (finite(growthSuggestion.percent)) {
      for (const item of scenario.years || []) {
        if (item.origins?.growth === 'user' || item.origins?.growth === 'analyst-derived') continue;
        if (!finite(item.values.growth) || item.origins?.growth === 'unavailable'
            || ['historical-cagr', 'peer-median-growth', 'suggested-mature-growth'].includes(item.origins?.growth)) {
          item.values.growth = growthSuggestion.percent;
          item.origins.growth = growthSuggestion.origin;
        }
      }
    }
    if (scenario.kind === 'advanced' && opening
        && [opening.receivablesPercentage, opening.inventoriesPercentage, opening.payablePercentage].every(finite)) {
      const wcPct = opening.receivablesPercentage + opening.inventoriesPercentage - opening.payablePercentage;
      for (const item of scenario.years || []) {
        if (!finite(item.values.nwcChange) && finite(item.values.growth)
            && item.origins?.nwcChange !== 'user') {
          item.values.nwcChange = wcPct * item.values.growth / (100 + item.values.growth);
          item.origins.nwcChange = 'fmp-base-year';
        }
      }
    }
    return scenario;
  }

  function actualColumn(text, money) {
    const scenario = state.scenarios[state.kind];
    const reference = Scenario.actualReference(state.sourceData, state.actualStatements,
      scenario ? { year: scenario.baseYear, date: scenario.baseDate } : undefined);
    const sources = {
      fmpStandardizedActual: text('FMP 標準化實績', 'FMP standardized actual'),
      officialBalance: text('官方期末報表', 'Official closing balance'),
      officialCashflow: text('官方現金流報表', 'Official cash-flow statement'),
      officialPropertyFv: text('官方物業公允值調整（EBITDA 加 FMP 折舊；合營損益保留）',
        'Official property-FV adjustment (EBITDA adds FMP D&A; JV earnings retained)'),
      officialPropertyCashflow: text('官方物業現金流（未扣融資分類利息）',
        'Official property cash flow (before financing-classified interest)'),
      officialReport: text('官方年報', 'Official annual report'),
      officialRevenue: text('官方合併營收（發行人認列口徑）', 'Official consolidated revenue (issuer reporting basis)'),
      officialOperatingProfit: text('官方營業利潤／已核對 D&A 推導（非調整後 EBITDA）', 'Official operating profit / reviewed D&A derivation (not adjusted EBITDA)'),
      officialDerivedOperatingProfit: text('由官方損益項目推導的核心營運利潤（非報表小計／調整後 EBITDA）',
        'Core operating profit derived from official lines (not a reported subtotal / adjusted EBITDA)')
    };
    const cells = Object.fromEntries(Scenario.activeFields(state.kind, scenario).map(([key]) => {
      const item = reference.items[key];
      const basis = item?.basis === 'historicalEffectiveTaxNotForecastOperatingTax'
        ? text('歷史所得稅／稅前利潤，非預測營運稅率', 'Historical income tax / PBT, not forecast operating tax')
        : item?.basis === 'closingBalanceRevenueRatio' ? text('同一財年期末餘額／全年營收', 'Same FY closing balance / annual revenue')
          : item?.basis === 'propertyAndPpeCashAdditions' ? text('物業＋PPE 現金添置', 'Property + PPE cash additions')
            : item?.basis === 'reportedCfoNotFmpReclassified' ? text('年報原列 CFO，非 FMP 重分類口徑', 'As-reported CFO, not FMP reclassification')
              : item?.basis === 'negativeReportedWorkingCapitalCashImpact'
                ? text('現金流量表營運資金現金影響取負號（含其他營運資金）；增加為正', 'Negative cash-flow working-capital cash impact, including other working capital; increases are positive')
                : item?.basis === 'derivedEbitdaLessDa' ? text('實績 EBITDA 減 D&A 推導', 'Derived actual EBITDA less D&A') : '';
      return [key, `${finite(item?.percent) ? `${item.percent.toFixed(2)}%` : 'N/A'}${finite(item?.amount)
        ? `<small>${money(item.amount)}</small>` : ''}
        <small>${escape(item ? sources[item.source] : text('非財報實績項目；不虛構歷史資本成本', 'Not a reported financial actual; historical capital costs are not invented'))}</small>
        ${basis ? `<small>${escape(basis)}</small>` : ''}`];
    }));
    return {
      header: `${text('實際全年參考', 'Actual FY reference')}<small>${escape(reference.date || 'N/A')}</small>`,
      cells,
      note: reference.reason ? `${text('實際財報參考暫不可用', 'Actual financial reference unavailable')}: ${escape(state.actualError || reference.reason)}`
        : text(
          '參考欄採基期實際全年（非 TTM），不改寫 FMP 原始模型或快照淨債務。新情境中 CapEx、CFO、D&A 若缺分析師預測，採最近完整財年的營收比率；來源財年另列。流量為全年，資產負債為同年期末；缺少細分維持 N/A。外幣實績採各期歷史匯率，FMP 模型可能採即期匯率。融資成本／Beta 不是財報實績。百分比顯示兩位小數，計算及下載檔保留完整精度。',
          'Reference uses the actual baseline FY (not TTM), without rewriting native FMP models or snapshot net debt. New scenarios use the latest full-FY revenue ratios for CapEx, CFO and D&A only when analyst forecasts are absent; that source FY is identified separately. Flows cover the FY; balances are FY-end. Missing breakdowns stay N/A. Foreign actuals use period-specific historical FX; FMP models may use spot FX. Capital costs/beta are not reported financial actuals. Percentages display two decimals; calculations and downloads retain full precision.')
    };
  }

  function originText(origin, text) {
    return ({
      fmp: text('FMP 模型', 'FMP model'), extension: text('舊版延伸假設', 'Legacy extension'),
      user: text('用戶修改', 'User override'), derived: text('連動推導', 'Linked derivation'),
      capm: 'CAPM', 'derived-fmp': text('FMP 推導', 'FMP-derived'),
      'normalized-fmp-tax': text('標準化：採 FMP 列示稅率', 'Normalized: stated FMP tax'),
      analyst: text('分析師共識比率', 'Analyst consensus ratio'),
      'analyst-derived': text('分析師營收推導', 'Derived from analyst revenue'),
      'latest-fy': text('最近全年實績比率（非共識）', 'Latest FY actual ratio (not consensus)'),
      'working-capital-average': text('營運資金五年平均比率', 'Five-year working-capital ratio'),
      'five-year-effective-tax': text('建議預設：近五年有效稅率平均（可改）', 'Suggested default: 5y avg effective tax (editable)'),
      'historical-cagr': text('建議預設：歷史營收 CAGR（可改）', 'Suggested default: historical revenue CAGR (editable)'),
      'peer-median-growth': text('建議預設：同業成長中位數（可改）', 'Suggested default: peer median growth (editable)'),
      'suggested-mature-growth': text('建議預設：成熟公司長期成長帶（可改）', 'Suggested default: mature long-term growth band (editable)'),
      'suggested-rf-tenor': text('建議：依選定公債年期（可改）', 'Suggested: selected treasury tenor (editable)'),
      'suggested-default': text('建議預設／可改', 'Suggested default / editable'),
      'suggested-current-multiple': text('建議預設：現價 EV/EBITDA（可改）', 'Suggested default: current EV/EBITDA (editable)'),
      'retained-capital': text('維持原資本成本設定', 'Retained capital-cost setting'),
      'derived-legacy': text('舊情境等值換算', 'Equivalent legacy conversion'),
      'fmp-base-year': text('建議預設：模型基期實績比率（可改）', 'Suggested default: model base-year ratio (editable)'),
      unavailable: text('N/A：未提供預測', 'N/A: forecast unavailable')
    })[origin] || origin;
  }

  function formatMoneyInput(currency, number) {
    return finite(number) ? `${currency} ${number.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : 'N/A';
  }

  function peerMultipleReference(text) {
    const Peer = root.PeerComparison;
    const universe = typeof state.universe === 'function' ? state.universe() : state.universe;
    if (!Peer?.select || !universe || typeof universe !== 'object') {
      return { html: `<p class="analysis-note" id="fmp-peer-multiples">${text('同業倍數參考', 'Peer multiple reference')}: N/A — ${text('同業宇宙尚未載入', 'peer universe is not loaded')}</p>`, peers: [] };
    }
    let selected;
    try { selected = Peer.select(universe, state.ticker, 5); }
    catch (error) {
      return { html: `<p class="analysis-note" id="fmp-peer-multiples">${text('同業倍數參考', 'Peer multiple reference')}: N/A — ${escape(error.message)}</p>`, peers: [] };
    }
    const peers = selected.peers || [];
    if (!peers.length) {
      return { html: `<p class="analysis-note" id="fmp-peer-multiples">${text('同業倍數參考', 'Peer multiple reference')}: N/A — ${text('找不到可用同業', 'no usable peers found')}</p>`, peers: [] };
    }
    const cell = value => finite(value) ? `${Number(value).toFixed(2)}x` : 'N/A';
    const rows = peers.map(peer => `<tr><th>${escape(peer.ticker)} <small>${escape(peer.basis)}</small></th>
      <td>${cell(peer.stock?.pe_trailing)}</td><td>${cell(peer.stock?.ev_to_ebitda)}</td></tr>`).join('');
    return {
      peers,
      html: `<div id="fmp-peer-multiples" class="analysis-note"><strong>${text('出場倍數參考（現價／同業）', 'Exit-multiple reference (spot / peers)')}</strong>
        <p>${text('本股', 'This stock')}: P/E ${cell(state.stock.pe_trailing)} · EV/EBITDA ${cell(state.stock.ev_to_ebitda)}
        ${finite(state.stock.ev_to_ebitda) ? ` · ${text('新建情境建議預設用現價 EV/EBITDA，可改', 'new scenarios suggest current EV/EBITDA as an editable default')}` : ` · ${text('本股 EV/EBITDA 不可用，不預填出場倍數', 'stock EV/EBITDA unavailable; exit multiple is not prefilled')}`}</p>
        <div class="table-scroll-wrapper"><table id="fmp-peer-multiple-table"><thead><tr>
          <th>${text('同業（最多 5）', 'Peers (up to 5)')}</th><th>P/E</th><th>EV/EBITDA</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        <small>${text('同業選取沿用站上 PeerComparison（同子行業／供應商／相關產業），倍數為目前行情快照，不是終值預測。', 'Peer selection reuses site PeerComparison (same sub-industry / provider / related). Multiples are current market snapshots, not terminal forecasts.')}</small></div>`
    };
  }

  function historyPanelHtml(text) {
    const history = Scenario.fiveYearHistory(state.actualStatements, state.sourceData, state.kind);
    if (history.reason) {
      return `<section id="fmp-fy-history"><h4>${text('近五年實績參考', 'Last five FY reference')}</h4>
        <p class="analysis-note">N/A — ${escape(state.actualError || history.reason)}</p></section>`;
    }
    const labels = {
      growth: text('營收成長 %', 'Revenue growth %'),
      ebitda: 'EBITDA %', da: 'D&A %', nwcChange: text('ΔNWC %', 'ΔNWC %'),
      capex: 'CapEx %', cfo: 'CFO %', tax: text('有效稅率 %', 'Effective tax %')
    };
    const metricKeys = Object.keys(history.metrics);
    const head = metricKeys.map(key => `<th>${escape(labels[key] || key)}</th>`).join('');
    const body = history.years.map((row, index) => `<tr><th>${row.year}<small>${escape(row.date)}</small></th>${
      metricKeys.map(key => `<td>${finite(history.metrics[key][index]) ? `${history.metrics[key][index].toFixed(2)}%` : 'N/A'}</td>`).join('')
    }</tr>`).join('');
    const summaryBits = [
      finite(history.summary.revenueCagr) ? `${text('營收 CAGR', 'Revenue CAGR')} ${history.summary.revenueCagr.toFixed(2)}%` : null,
      ...metricKeys.map(key => {
        const item = history.summary[key];
        if (!item || !finite(item.average)) return null;
        const delta = finite(item.changePp) ? ` · Δ ${item.changePp >= 0 ? '+' : ''}${item.changePp.toFixed(2)}pt` : '';
        return `${labels[key]} ${text('五年平均', '5y avg')} ${item.average.toFixed(2)}%${delta}`;
      })
    ].filter(Boolean);
    return `<section id="fmp-fy-history"><h4>${text('近五年實績參考（數字摘要，不改寫輸入）', 'Last five FY reference (numeric summary; does not rewrite inputs)')}</h4>
      <p class="analysis-note" id="fmp-fy-history-summary">${escape(summaryBits.join(' · '))}</p>
      <div class="table-scroll-wrapper"><table id="fmp-fy-history-table"><thead><tr><th>${text('財年', 'FY')}</th>${head}</tr></thead><tbody>${body}</tbody></table></div></section>`;
  }

  function growthDefaultNoteHtml(text, scenario) {
    const suggestion = scenario.growthSuggestion;
    if (!suggestion) return '';
    const practice = text(
      '實務參考：Damodaran 多以基本面／歷史成長再向穩定成長收斂；多數 DCF 工具優先分析師預測，其次歷史，否則需手動輸入。本站缺共識時採歷史 CAGR→同業中位→成熟 2.5%，極端波動則留空。',
      'Practice note: Damodaran typically uses fundamentals/history then fades toward stable growth; many DCF tools prefer analyst estimates, then history, else manual input. This site uses historical CAGR → peer median → mature 2.5% when consensus is missing, and leaves blanks for extreme volatility.'
    );
    if (finite(suggestion.percent)) {
      return `<p class="analysis-note" id="fmp-growth-default-note">${text('營收成長建議預設', 'Suggested revenue-growth default')}: ${suggestion.percent.toFixed(2)}% (${escape(originText(suggestion.origin, text))}).
        ${text('僅填補缺共識年度，採單一水平值、不編造十年遞減路徑；可改，不覆寫分析師或你已輸入的值。', 'Fills only years without consensus, as one flat rate — no invented 10-year fade path; editable and does not overwrite analyst or user values.')}
        ${practice}</p>`;
    }
    return `<p class="analysis-note text-red" id="fmp-growth-default-note">${text('營收成長', 'Revenue growth')}: N/A — ${escape(reasonText(suggestion.reason || 'GROWTH_REQUIRES_MANUAL_INPUT', state.language()))}
      ${finite(suggestion.detail?.cagr) ? ` (${text('歷史 CAGR', 'historical CAGR')} ${suggestion.detail.cagr.toFixed(2)}%，${text('僅供參考', 'reference only')})` : ''}.
      ${practice}</p>`;
  }

  function fcffRecord(ticker = state?.ticker) {
    return root.FCFF_DATA?.stocks?.[ticker] || root.HK_FCFF_DATA?.stocks?.[ticker] || null;
  }

  function isHkListing(stock = state?.stock, ticker = state?.ticker) {
    const symbol = ticker || stock?.ticker || '';
    return symbol.endsWith('.HK') || stock?.market === 'HKEX' || stock?.exchange === 'HKEX';
  }

  function treasuryTenorRates(treasury) {
    const rates = {};
    if (!treasury || typeof treasury !== 'object') return rates;
    for (let year = 1; year <= 10; year++) {
      const value = treasury[`year${year}`];
      if (finite(value)) rates[year] = value;
    }
    return rates;
  }

  function isUsdTreasuryCapture(treasury) {
    return !!treasury && (treasury.currency === 'USD' || treasury.currency == null)
      && Object.keys(treasuryTenorRates(treasury)).length > 0;
  }

  function latestUsdTreasuryCapture(excludeTicker) {
    let best = null;
    for (const bag of [root.FCFF_DATA?.stocks, root.HK_FCFF_DATA?.stocks]) {
      if (!bag) continue;
      for (const [symbol, row] of Object.entries(bag)) {
        if (symbol === excludeTicker) continue;
        const treasury = row?.provenance?.treasury;
        if (!isUsdTreasuryCapture(treasury) || treasury.currency === 'HKD') continue;
        if (!best || (treasury.date || '') > (best.date || '')) best = treasury;
      }
    }
    return best ? { ...best, currency: 'USD' } : null;
  }

  function riskFreeTenorSource(stock = state?.stock, ticker = state?.ticker) {
    const fcff = fcffRecord(ticker);
    const hk = isHkListing(stock, ticker);
    let treasury = fcff?.provenance?.treasury || null;
    // HK Advanced ten-year: primary default is USD Treasury (US rf concept / peg proxy), never HKD curve.
    if (hk) {
      if (!isUsdTreasuryCapture(treasury) || treasury?.currency === 'HKD') {
        treasury = latestUsdTreasuryCapture(ticker) || (isUsdTreasuryCapture(treasury)
          ? { ...treasury, currency: 'USD' } : null);
      } else {
        treasury = { ...treasury, currency: 'USD' };
      }
    } else if (treasury?.currency === 'HKD') {
      treasury = latestUsdTreasuryCapture(ticker);
    }
    const rates = treasuryTenorRates(treasury);
    const missing = [];
    for (let year = 1; year <= 10; year++) {
      if (!finite(rates[year])) missing.push(year);
    }
    const available = Object.keys(rates).map(Number).sort((a, b) => a - b);
    const riskFreeNote = hk
      ? (fcff?.provenance?.riskFreeRate
        && !/HKD benchmark|港元/i.test(fcff.provenance.riskFreeRate)
          ? fcff.provenance.riskFreeRate
          : 'User-directed USD Treasury proxy under the HKD/USD peg; not an observed HKD yield or a copied US-stock WACC')
      : (fcff?.provenance?.riskFreeRate || null);
    return {
      currency: hk ? 'USD' : (treasury?.currency || 'USD'),
      date: treasury?.date || null,
      rates,
      missing,
      hkPegProxy: hk,
      basis: available.length === 0 ? 'dated-treasury-unavailable'
        : available.length === 1 && available[0] === 10 ? 'dated-capture-year10-only'
        : 'dated-usd-treasury-curve',
      betaProvenance: fcff?.provenance?.beta
        || 'FMP profile beta; lookback, frequency and benchmark unspecified by the response',
      riskFreeNote,
      retainedRf: finite(state?.scenarios?.[state.kind]?.years?.[0]?.values?.rf)
        ? state.scenarios[state.kind].years[0].values.rf : null,
      retainedBeta: finite(state?.scenarios?.[state.kind]?.years?.[0]?.values?.beta)
        ? state.scenarios[state.kind].years[0].values.beta : null
    };
  }

  function applyRfTenor(scenario, tenor) {
    const source = riskFreeTenorSource();
    const rate = source.rates[tenor];
    scenario.rfTenor = tenor;
    scenario.rfTenorSource = {
      currency: source.currency, date: source.date, basis: source.basis,
      rate: finite(rate) ? rate : null,
      reason: finite(rate) ? null : 'DATED_CURVE_TENOR_UNAVAILABLE'
    };
    if (!finite(rate)) return false;
    for (const item of scenario.years || []) {
      if (item.origins?.rf === 'user') continue;
      item.values.rf = rate;
      item.origins.rf = 'suggested-rf-tenor';
      if (item.origins?.ke === 'user') continue;
      if ([item.values.rf, item.values.beta, item.values.erp].every(finite)) {
        item.values.ke = item.values.rf + item.values.beta * item.values.erp;
        item.origins.ke = 'capm';
      }
    }
    return true;
  }

  function rfTenorControlHtml(text, scenario) {
    // Always render the 1–10y chooser next to the rf row — even when cache only has year10.
    // Missing tenors stay visible as disabled · N/A; default selection is 10Y when present.
    const source = riskFreeTenorSource();
    const selected = Number.isInteger(scenario.rfTenor) ? scenario.rfTenor
      : finite(source.rates[10]) ? 10 : 10;
    const options = Array.from({ length: 10 }, (_, index) => {
      const tenor = index + 1;
      const rate = source.rates[tenor];
      const available = finite(rate);
      return `<option value="${tenor}" ${selected === tenor ? 'selected' : ''} ${available ? '' : 'disabled'}>${tenor}Y${available ? ` · ${rate.toFixed(2)}%` : ` · N/A`}</option>`;
    }).join('');
    const missingNote = source.missing.length
      ? text(`缺期數：${source.missing.map(year => `${year}Y`).join(', ')}（定存擷取目前多僅 year10；選擇器仍顯示）。`,
        `Missing tenors: ${source.missing.map(year => `${year}Y`).join(', ')} (dated capture often year10 only; chooser still shown).`)
      : '';
    const rfStatus = scenario.rfTenorSource?.reason
      ? escape(reasonText(scenario.rfTenorSource.reason, state.language()))
      : finite(source.rates[selected])
        ? `${source.rates[selected].toFixed(2)}% · ${escape(source.currency)} · ${escape(source.date || 'N/A')}`
        : text('沿用 retained-capital；選有資料的年期才寫入（不覆寫你已改的格子）。',
          'Retains retained-capital until a data-backed tenor is applied (does not overwrite your edits).');
    const label = source.hkPegProxy
      ? text('公債年期（USD／1–10Y）', 'Treasury tenor (USD / 1–10Y)')
      : text('公債年期（1–10Y）', 'Treasury tenor (1–10Y)');
    return `<div class="fmp-rf-tenor-control" id="fmp-rf-tenor-control">
      <label for="fmp-rf-tenor">${label}</label>
      <select id="fmp-rf-tenor" aria-label="${escape(label)}">${options}</select>
      <small id="fmp-rf-tenor-status">${rfStatus}${missingNote ? ` ${escape(missingNote)}` : ''}</small>
    </div>`;
  }

  function capitalProvenanceHtml(text, scenario) {
    const source = riskFreeTenorSource();
    return `<section id="fmp-capital-provenance">
      <p class="analysis-note" id="fmp-beta-provenance"><strong>Beta</strong>: ${finite(source.retainedBeta) ? source.retainedBeta.toFixed(3) : 'N/A'} —
        ${text('來自 FMP 模型列保留的 beta（最終多為 FMP profile.beta）。供應商未說明回看期、頻率或基準指數；本站不宣稱「準確 5 年週線對 S&P」。可於十年表覆寫。',
          'From the retained FMP model beta (typically FMP profile.beta). Provider lookback, frequency and benchmark are unspecified; this site does not claim an “accurate 5y weekly vs S&P” beta. Override in the ten-year grid if needed.')}
        <small>${escape(source.betaProvenance)}</small></p>
      <p class="analysis-note" id="fmp-rf-provenance"><strong>${text('無風險利率', 'Risk-free rate')}</strong>:
        ${source.hkPegProxy
          ? text('港股採用美元公債／美股無風險利率概念（聯繫匯率代理），非港元曲線。',
            'HK stocks use the USD Treasury / US-stock risk-free concept (HKD peg proxy), not an HKD curve.')
          : ''}
        ${text('情境預設沿用 FMP 模型 riskFreeRate（retained-capital）', 'Scenario defaults retain FMP model riskFreeRate (retained-capital)')}${finite(source.retainedRf) ? `: ${source.retainedRf.toFixed(2)}%` : ''}.
        ${source.date ? text(`定存美元公債擷取（參考）`, `Dated USD Treasury capture (reference)`) + `: ${escape(source.currency)} ${text('十年期', '10Y')} ${finite(source.rates[10]) ? `${source.rates[10].toFixed(2)}%` : 'N/A'} · ${escape(source.date)}.` : text('尚無已標日期的美元公債曲線擷取。', 'No dated USD Treasury-curve capture is available.')}
        ${text('1–10 年期下拉選單在下方十年表「無風險利率 (%)」列左側（有資料的期數可選；缺期仍顯示為 N/A）。',
          'The 1–10y tenor dropdown is on the left of the 「Risk-free rate (%)」 row in the ten-year table below (data-backed years selectable; missing years still shown as N/A).')}
        ${source.riskFreeNote ? `<small>${escape(source.riskFreeNote)}</small>` : ''}</p>
    </section>`;
  }

  function scenarioHtml(text, money, result) {
    const scenario = state.scenarios[state.kind];
    if (!scenario) return `<p id="fmp-status" role="status">${escape(reasonText(result.reason, state.language()))}</p>`;
    const actual = actualColumn(text, money);
    const analyst = scenario.assumptionPolicy === 'analyst-consensus-v1';
    const missing = Scenario.missingInputs(scenario);
    const missingNames = [...new Set(missing.map(item => item.key))].map(key => {
      const field = Scenario.fields.find(field => field[0] === key);
      return field ? text(field[1], field[2]) : text('終值增長率', 'Terminal growth');
    });
    const reviewedBase = state.sourceData?.forecastBase;
    const officialBaseRevenue = reviewedBase?.revenue * state.sourceData?.currencyCheck?.fx?.price;
    const oldRevenueBasis = reviewedBase?.revenueCorrection && scenario.baseYear === reviewedBase.year
      && finite(officialBaseRevenue) && officialBaseRevenue > 0
      && Math.abs(scenario.baseRevenue / officialBaseRevenue - 1) > 1e-8;
    return `<p class="analysis-note">${text(
      analyst
        ? '新十年情境以分析師共識營收及 EBITDA 為預測依據，不採 FMP 預製模型的五年平均營運預測。CapEx、CFO、D&A 若無共識，沿用最近完整財年的營收比率，並標示為實績延用而非分析師預測；只有營運資金使用最近連續五年比率平均。Beta、無風險利率、風險溢價、債務成本、股權成本及債務／資本比例維持原設定。缺少共識的其他營運項目及年度維持 N/A，不延伸或補造十年預測，未補齊前不產生新估值。原生 FMP 結果及已儲存的情境不變。'
        : '這是已保存／保留的舊版十年情境，其 FMP 比率、延伸假設及用戶輸入不會自動改寫。重設後新建情境才採分析師預設；舊版延伸並非分析師共識。',
      analyst
        ? 'New ten-year scenarios use analyst consensus revenue and EBITDA, not the prebuilt FMP model’s five-year-average operating forecasts. Missing consensus CapEx, CFO and D&A use latest full-FY revenue ratios, explicitly labeled actual-ratio carry-forwards, not analyst forecasts. Only working capital uses five consecutive annual ratio averages. Beta, risk-free rate, risk premium, debt/equity costs and debt/capital retain their existing settings. Other missing operating fields/years stay N/A; no ten-year extension is invented and no new valuation is produced until inputs are complete. Native FMP results and saved scenarios are unchanged.'
        : 'This retained legacy ten-year scenario preserves its FMP ratios, extensions and user inputs. Only newly initialized scenarios after reset use analyst defaults; legacy extensions are not analyst consensus.')}</p>
      <p class="analysis-note">${text('實際基期', 'Actual baseline')}: ${scenario.baseYear} (${escape(scenario.baseDate)}) · ${text('基期營收', 'Base revenue')}: ${money(scenario.baseRevenue)} (${scenario.baseRevenueSource === 'officialReportedRevenue' ? text('官方財報口徑', 'Official reported basis') : text('原情境口徑', 'Original scenario basis')}) · ${text(analyst ? '共識財年' : '舊版 FMP 預測年度', analyst ? 'Consensus fiscal years' : 'Legacy FMP projection years')}: ${(analyst ? scenario.analystYears : scenario.providerYears).join(', ') || 'N/A'} · ${text('來源擷取', 'Source captured')}: ${escape(scenario.sourceCapturedAt)}</p>
      ${oldRevenueBasis ? `<p class="analysis-note text-red" id="fmp-stale-revenue-basis">${text('此保留情境仍採修正前營收基期；已儲存假設及目標價不會自動改寫。重設後的新情境才採官方營收。', 'This retained scenario still uses the pre-correction revenue baseline. Saved assumptions/targets are not automatically overwritten; a newly reset scenario uses official revenue.')}</p>` : ''}
      ${analyst ? `<p class="analysis-note" id="fmp-assumption-sources">${text('實績比率來源財年末', 'Actual-ratio source FY end')}: ${escape(scenario.actualRatioDate || 'N/A')} · ${text('營運資金平均財年', 'Working-capital average FYs')}: ${scenario.workingCapitalYears.map(year => year ?? 'N/A').join(', ')}${scenario.analystReason ? ` · ${escape(reasonText(scenario.analystReason, state.language()))}` : ''}.
        ${text('共識幣別及單位採歷史共識／實績比對核查；不同幣別採已核對的 FMP 模型快照匯率。共識不保證屬同一會計或經調整口徑，且並非每項均有分析師人數。', 'Consensus currency/units are checked against historical consensus/reporting scale; cross-currency amounts use the verified FMP model snapshot FX. Consensus is not certified to share one accounting/adjusted basis, and analyst counts are not supplied for every metric.')}</p>` : ''}
      <p class="analysis-note" id="fmp-nwc-note">${text(
        '營運資金改用單一「淨營運資金變動／營收」：正值為資金增加，從 FCFF 扣除；負值為資金釋放。新預設採最近連續五個完整財年比率的簡單平均，由現金流量表營運資金現金影響取負號（包括其他營運資金），不是只以應收、存貨、應付三項餘額相減。CFO 情境已包含此影響，不會再次扣除。舊情境三項比率按原逐年營收換成等值變動比率，原始輸入保留於下載檔，不自動改寫已儲存目標價。',
        'Working capital uses one change-in-NWC/revenue input: positive increases are deducted from FCFF; negative changes release cash. New defaults average five consecutive full-FY ratios, using negative cash-flow working-capital cash impact, including other working capital, not just three closing trade balances. The CFO scenario already includes this impact and does not deduct it again. Legacy ratios are converted using their original annual revenue to equivalent change ratios, with original inputs retained in the download and saved targets not automatically overwritten.')}</p>
      ${missing.length ? `<p class="analysis-note text-red" id="fmp-missing-assumptions">${text('缺少假設，估值為 N/A', 'Missing assumptions; valuation is N/A')}: ${escape(missingNames.join(' / '))}</p>` : ''}
      ${(scenario.warnings || []).map(warning => `<p class="analysis-note">${text('來源警示：隱含營運稅率超出可用範圍；此情境明確改採 FMP 列示稅率，非照錄原始估值。', 'Source warning: implied operating tax is outside the supported range; this scenario explicitly uses the stated FMP tax rate instead, not the original API valuation.')} ${warning.year}: ${escape(warning.original)}% → ${escape(warning.replacement)}%</p>`).join('')}
      <p class="analysis-note">${text(
        'Advanced：EBIT = EBITDA − D&A；修改 EBIT 會連動 EBITDA。有共識 EBITDA 時優先使用，EBIT 為連動推導，不冒稱同時符合供應商獨立 EBIT 預測；僅有共識 EBIT 時，以 EBIT 加 D&A 推導 EBITDA。FCFF = EBIT × (1 − 稅率) + D&A + 負數 CapEx − 營運資金增加。CFO 情境採 CFO + 負數 CapEx，不再加回 D&A；保留 WACC 折現及 EV 減淨債務定義，並非獨立 FCFE／Ke 模型。缺分析師營運稅率時，新建情境建議預設為近五年有效稅率平均（可改），不以原生模型隱含稅率冒充。',
        'Advanced: EBIT = EBITDA - D&A; editing EBIT updates EBITDA. Consensus EBITDA takes priority, with linked EBIT not claimed to also match a separate provider EBIT forecast. If only consensus EBIT exists, EBITDA derives from EBIT plus D&A. FCFF = EBIT × (1 - tax) + D&A + negative CapEx - increase in working capital. The CFO scenario uses CFO + negative CapEx without adding D&A again. It retains WACC/EV less net debt, not an independent FCFE/Ke model. When analyst operating tax is missing, new scenarios suggest a five-year average effective tax (editable) rather than a native-model implied tax.')}</p>
      <p class="analysis-note">${text(
        '逐年 WACC 由股權／稅後債務成本與資本權重計算；修改 Beta、無風險利率或風險溢價會以 CAPM 更新該年的股權成本，亦可直接覆寫股權成本。每年折現因子連乘。終值增長率僅用於第十年後終值。EV 只減一次基期淨債務，不額外加上預測現金。負存貨或負稅率照來源標示，必須審視其適用性，未經獨立核實。',
        'Annual WACC uses equity/after-tax debt costs and capital weights; editing beta, risk-free rate or premium updates that year’s equity cost through CAPM, which can also be overridden directly. Annual discount factors compound. Terminal growth applies only beyond year ten. EV subtracts snapshot net debt once, with no extra addition of projected cash. Negative inventory/tax inputs require review and are not independently certified.')}</p>
      <p class="analysis-note" id="fmp-actual-note">${actual.note}</p>
      ${growthDefaultNoteHtml(text, scenario)}
      ${capitalProvenanceHtml(text, scenario)}
      ${historyPanelHtml(text)}
      <div class="table-scroll-wrapper"><table id="fmp-ten-year-inputs"><thead><tr><th>${text('假設／來源', 'Assumption / source')}</th><th id="fmp-actual-period">${actual.header}</th>${scenario.years.map(item => `<th>${item.year}</th>`).join('')}</tr></thead><tbody>
        ${Scenario.activeFields(state.kind, scenario).map(([key, zh, en, min, max]) => {
          const label = key === 'rf'
            ? `${escape(text(zh, en))}${rfTenorControlHtml(text, scenario)}`
            : escape(text(zh, en));
          return `<tr data-scenario-field="${key}"><th>${label}</th><td data-actual-key="${key}">${actual.cells[key]}</td>${scenario.years.map((item, index) => `<td class="fmp-assumption-cell">
          <input aria-label="${escape(text(zh, en))} ${item.year}" data-scenario-key="${key}" data-scenario-year="${index}" type="number" step="any" min="${min}" max="${max}" required placeholder="N/A" title="${escape(item.values[key] ?? '')}" value="${inputValue(key, item.values[key])}">
          <small class="fmp-assumption-origin" data-origin="${index}-${key}">${escape(originText(item.origins[key], text))}</small></td>`).join('')}</tr>`;
        }).join('')}
      </tbody></table></div>
      ${scenario.currencyWarning ? `<p class="analysis-note text-red" id="fmp-currency-warning">${text(
        '模型金額幣別／FX 尚未與財報完全核對；十年情境仍可用快取模型列，但請審閱換匯假設。',
        'Model currency/FX is not fully reconciled with financials; the ten-year scenario still uses cached model rows — review the FX assumptions.')} ${escape(reasonText(scenario.currencyWarning, state.language()) || scenario.currencyWarning)}</p>` : ''}
      ${(() => {
        const ref = scenario.terminalGrowthReference || Scenario.TERMINAL_GROWTH_REFERENCE;
        const tax = scenario.taxFiveYear;
        const netCash = scenario.netDebtBasis === 'net-cash' || scenario.netDebt < 0;
        const netLabel = netCash ? text('建議淨現金（可調整）', 'Suggested net cash (editable)')
          : text('建議淨債務（可調整）', 'Suggested net debt (editable)');
        const peer = peerMultipleReference(text);
        return `<div class="fin-model-grid fmp-terminal-inputs"><div class="form-group"><label for="fmp-terminal-growth">${text('第十年後終值增長率 (%)', 'Terminal growth after year ten (%)')}</label>
      <input id="fmp-terminal-growth" type="number" required step="any" min="-10" max="20" placeholder="N/A" title="${escape(scenario.terminalGrowth ?? '')}" value="${inputValue('terminalGrowth', scenario.terminalGrowth)}">
      <small id="fmp-terminal-growth-ref">${text('參考帶', 'Reference band')} ${ref.bandLow.toFixed(1)}%–${ref.bandHigh.toFixed(1)}% · ${text('建議預設', 'Suggested default')} ${ref.value.toFixed(1)}% · ${escape(state.language() === 'en' ? ref.citationEn : ref.citationZh)}</small></div>
      <div class="form-group"><label for="fmp-exit-multiple">${text('出場倍數終值 EV/EBITDA（可覆寫）', 'Exit-multiple terminal EV/EBITDA (optional override)')}</label>
      <input id="fmp-exit-multiple" type="number" step="any" min="0" max="500" placeholder="N/A" title="${escape(scenario.exitMultiple ?? '')}" value="${inputValue('exitMultiple', scenario.exitMultiple)}">
      <small>${originText(scenario.exitMultipleOrigin || (finite(scenario.exitMultiple) ? 'user' : 'unavailable'), text)}</small></div>
      <div class="form-group"><label for="fmp-snapshot-net-debt">${netLabel} · ${escape(scenario.currency)}</label>
      <input id="fmp-snapshot-net-debt" type="number" required step="any" title="${escape(scenario.netDebt)}" value="${scenario.netDebt}">
      <small id="fmp-snapshot-net-debt-meta">${text('報表／快照日', 'Statement / snapshot date')}: ${escape(scenario.netDebtDate || scenario.baseDate || 'N/A')} · ${text('顯示', 'Display')}: ${formatMoneyInput(scenario.currency, scenario.netDebt)} · ${netCash ? text('負淨債務＝淨現金', 'Negative net debt = net cash') : text('正值＝淨債務', 'Positive = net debt')}</small></div></div>
      ${peer.html}
      <p class="analysis-note" id="fmp-tax-default-note">${tax?.percent != null
        ? text(`預測稅率建議預設為近五年有效稅率平均 ${tax.percent.toFixed(2)}%（財年 ${tax.years.join(', ')}）；標為可改，不會覆寫你已改的格子。`, `Forecast tax suggests the 5y effective-tax average ${tax.percent.toFixed(2)}% (FY ${tax.years.join(', ')}); labeled editable and does not overwrite cells you already changed.`)
        : text(`預測稅率五年平均不可用：${tax?.reason || 'TAX_UNAVAILABLE'}；缺稅率時維持 N/A。`, `Five-year average tax unavailable: ${tax?.reason || 'TAX_UNAVAILABLE'}; missing tax stays N/A.`)}</p>
      <p class="analysis-note">${text('調整終值增長率不會悄悄改寫已填好的十年增長率；需要時請逐年修改。缺共識的營運比率可採「建議預設／可改」（最近全年或五年平均）；營收成長不在共識之外虛構。出場倍數新建時可建議現價 EV/EBITDA，並顯示同業 P/E 與 EV/EBITDA 參考；留空則該終值列為 N/A。', 'Changing terminal growth does not silently overwrite the ten populated annual growth inputs; edit those years explicitly if needed. Missing consensus operating ratios may use labeled suggested defaults (latest FY or five-year averages); revenue growth is never invented beyond consensus. New scenarios may suggest current EV/EBITDA as the exit multiple and show peer P/E and EV/EBITDA for reference; leaving it blank keeps that terminal N/A.')}</p>`;
      })()}
      <button id="fmp-calculate" type="button" class="btn-save">${text('計算十年情境', 'Calculate ten-year scenario')}</button>
      <p id="fmp-status" role="status">${escape(result.reason ? reasonText(result.reason, state.language())
        : text('本站十年情境；不是 FMP 原始結果。可按「儲存目標價」一次計算並儲存。', 'Site-calculated ten-year scenario, not an FMP API result. Save target calculates and saves in one step.'))}</p>
      ${result.result?.warnings?.length ? `<p id="fmp-negative-scenario-warning" class="analysis-note text-red">${text(
        '此情境有非正數終期現金流及／或負股權值。負數照算以便審閱，不代表可交易的負股價；Gordon 終值並非經濟上可靠的正值持續經營估值。請先審閱 CapEx、營運利潤及終期假設。',
        'This scenario has nonpositive terminal cash flow and/or negative equity. Negative arithmetic is retained for review, not interpreted as a tradable negative share price; its Gordon terminal is not an economically reliable positive going-concern valuation. Review FMP projected CapEx, operating profit and terminal assumptions first.')}</p>` : ''}
      <div class="table-scroll-wrapper"><table id="fmp-ten-year-results"><thead><tr><th>${text('預測財年', 'Projected FY')}</th><th>${text('營收', 'Revenue')}</th><th>${state.kind === 'advanced' ? 'EBITDA' : 'CFO'}</th><th>CapEx</th>
        ${state.kind === 'advanced' ? `<th>${text('營運資金增加', 'Change in NWC')}</th>` : ''}
        <th>${text('現金流', 'Cash flow')}</th><th>WACC</th><th>${text('現金流現值', 'PV cash flow')}</th></tr></thead><tbody>
      ${(result.result?.rows || []).map(row => `<tr><th>${row.year}</th><td>${money(row.revenue)}</td><td>${money(state.kind === 'advanced' ? row.ebitda : row.cfo)}</td><td>${money(row.capex)}</td>
        ${state.kind === 'advanced' ? `<td>${money(row.changeNwc)}</td>` : ''}
        <td>${money(row.cashFlow)}</td><td>${(row.wacc * 100).toFixed(2)}%</td><td>${money(row.pv)}</td></tr>`).join('')}</tbody></table></div>
      <p class="analysis-note">${text('現金流現值合計／Gordon 終值現值／EV／淨債務／股權價值（主結果採 Gordon）', 'PV cash flows / Gordon PV terminal / EV / net debt / equity (primary uses Gordon)')}: ${[
        result.result?.presentFlows, result.row?.presentTerminalValue, result.row?.enterpriseValue, scenario.netDebt, result.row?.equityValue].map(money).join(' / ')}</p>
      ${dualTerminalHtml(text, money, result, scenario)}`;
  }

  function dualTerminalHtml(text, money, result, scenario) {
    const terminals = result.result?.terminals;
    if (!terminals) return '';
    const gordon = terminals.gordon;
    const exit = terminals.exitMultiple;
    const row = (label, gVal, eVal) => `<tr><th>${escape(label)}</th><td>${gVal}</td><td>${eVal}</td></tr>`;
    const exitCell = (value, formatter = money) => exit?.available ? formatter(value) : 'N/A';
    const perShare = value => finite(value) ? money(value) : 'N/A';
    return `<section id="fmp-dual-terminal"><h4>${text('雙終值比較（Gordon 為主結果）', 'Dual terminal comparison (Gordon is primary)')}</h4>
      <div class="table-scroll-wrapper"><table id="fmp-dual-terminal-results"><thead><tr>
        <th>${text('項目', 'Item')}</th><th>${text('Gordon 永續增長', 'Gordon growth')}</th>
        <th>${text('出場倍數', 'Exit multiple')}</th></tr></thead><tbody>
        ${row(text('終值方法輸入', 'Terminal input'),
          finite(gordon?.terminalGrowth) ? `${Number(gordon.terminalGrowth).toFixed(2)}%` : 'N/A',
          exit?.available ? `${Number(exit.exitMultiple).toFixed(2)}x` : 'N/A')}
        ${row(text('終值', 'Terminal value'), money(gordon?.terminalValue), exitCell(exit?.terminalValue))}
        ${row(text('終值現值', 'PV of terminal'), money(gordon?.presentTerminalValue), exitCell(exit?.presentTerminalValue))}
        ${row(text('企業價值 EV', 'Enterprise value'), money(gordon?.enterpriseValue), exitCell(exit?.enterpriseValue))}
        ${row(text('股權價值', 'Equity value'), money(gordon?.equityValue), exitCell(exit?.equityValue))}
        ${row(text('每股目標', 'Per-share target'), perShare(gordon?.targetPrice), exit?.available ? perShare(exit.targetPrice) : 'N/A')}
      </tbody></table></div>
      <p class="analysis-note" id="fmp-exit-multiple-status">${exit?.available
        ? text(`出場倍數 ${Number(exit.exitMultiple).toFixed(2)}x 已計算；主結果仍採 Gordon。`, `Exit multiple ${Number(exit.exitMultiple).toFixed(2)}x calculated; primary result remains Gordon.`)
        : `${text('出場倍數終值', 'Exit-multiple terminal')}: N/A — ${escape(reasonText(exit?.reason || 'EXIT_MULTIPLE_UNAVAILABLE', state.language()))}${
          scenario.kind === 'advanced' && finite(state.stock.ev_to_ebitda)
            ? ` (${text('現價 EV/EBITDA 僅供參考', 'current EV/EBITDA for reference only')}: ${Number(state.stock.ev_to_ebitda).toFixed(2)}x)`
            : ''}`}</p></section>`;
  }

  function sourceReviewHtml(text) {
    const review = state.sourceData?.sourceReview || record(state.ticker)?.sourceReview;
    if (!review) return '';
    if (review.reason) return `<p class="analysis-note text-red">${text(
      '官方年報比較已失去適用的財報指紋／年度核對，須重新審閱，不沿用舊對帳。', 'Official comparisons no longer match the reviewed statement fingerprint/year and require fresh review.')} ${escape(review.reason)}</p>`;
    const [old, current] = review.years;
    const amount = number => finite(number) ? number.toLocaleString('en-US', { maximumFractionDigits: 3 }) : 'N/A';
    const rows = [
      [text('營運現金流（年報原列／FMP 模型）', 'Operating cash flow (as reported / FMP model)'), old.official.reportedOperatingCashFlow, old.provider.operatingCashFlow, current.official.reportedOperatingCashFlow, current.provider.operatingCashFlow],
      [text('PPE 現金添置（支出負號）', 'Cash PPE additions (negative outflow)'), -old.official.cashOtherCapex, old.provider.capitalExpenditure, -current.official.cashOtherCapex, current.provider.capitalExpenditure],
      [text('投資物業現金添置', 'Cash investment-property additions'), -old.official.cashPropertyAdditions, text('未包含於 CapEx', 'Excluded from CapEx'), -current.official.cashPropertyAdditions, text('未包含於 CapEx', 'Excluded from CapEx')],
      [text('物業＋PPE 現金添置／FMP CapEx', 'Property + PPE cash additions / FMP CapEx'), -old.fullCashCapex, old.provider.capitalExpenditure, -current.fullCashCapex, current.provider.capitalExpenditure]
    ];
    return `<section id="fmp-source-review"><h4>${text('領展：年報與 FMP 口徑對帳（HK$ 百萬元）', 'Link: annual-report / FMP reconciliation (HK$ millions)')}</h4>
      <p class="analysis-note text-red">${text(
        '重要：FMP 原始結果及其預設保留不改，但不等同按年報正規化的租賃業務估值。其 EBIT／EBITDA 仍受物業估值損益影響；改顯示 EBITDA 並不能剔除這些損益。歷史 CapEx 不完整涵蓋投資物業添置，且下列年度 CFO 分類不一致，不應直接用來推斷同口徑成長。',
        'Important: original FMP results/defaults remain unchanged, but are not an issuer-normalized rental valuation. EBIT/EBITDA retain property valuation effects; displaying EBITDA does not remove them. Historical CapEx does not fully include investment-property additions, and CFO classification differs across these years, so a like-for-like growth rate cannot be inferred directly.')}</p>
      <div class="table-scroll-wrapper"><table><thead><tr><th>${text('項目', 'Item')}</th><th>${old.year} ${text('年報', 'Report')}</th><th>${old.year} FMP</th><th>${current.year} ${text('年報', 'Report')}</th><th>${current.year} FMP</th></tr></thead>
      <tbody>${rows.map(([label, ...values]) => `<tr><th>${escape(label)}</th>${values.map(value => `<td>${escape(typeof value === 'number' ? amount(value) : value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="analysis-note">${current.year}: ${amount(current.official.reportedOperatingCashFlow)} − ${amount(current.official.cashInterestPaid)} + ${amount(current.official.cashInterestReceived)} + ${amount(current.official.cashDividendsReceived)} = ${amount(current.standardizedOperatingCashFlow)}.
      ${text('即年報營運現金流，減融資活動列示的已付利息，加投資活動列示的已收利息及股息，與 FMP CFO 相符。比較年度 FMP CFO 則仍等於年報原列數字，未作同樣重分類。這是分類／可比性差異，並非匯率或金額單位錯誤。',
        'Reported operating cash flow less financing cash interest, plus investing cash interest/dividends, reconciles to FMP CFO. The comparative FMP CFO instead equals the as-reported amount without that reclassification. This is a classification/comparability difference, not FX or a unit mismatch.')}</p>
      <p class="analysis-note">${text('本年 FMP「投資購買」亦包含物業添置、銀行存款及合營注資：', 'Current FMP purchases of investments include property additions, bank deposits and JV capital:')}
      ${amount(current.official.cashPropertyAdditions)} + ${amount(current.official.bankDepositPlacements)} + ${amount(current.official.jointVentureCapitalInjection)} = ${amount(-current.provider.purchasesOfInvestments)}.
      ${text('不能把整筆投資購買當成經常性 CapEx。', 'The entire investment-purchase amount is not recurring CapEx.')}</p>
      <p class="analysis-note">${text('年報營運現金流減物業及 PPE 現金添置', 'Reported CFO less cash property/PPE additions')}: ${current.year} ${amount(current.operatingCashLessPropertyAndPpe)}.
      ${text('此數字尚未扣融資活動的利息及其他分派，不冒稱 FCFF、FCFE 或 AFFO，也不是股票目標價。', 'This is before financing cash interest and other distributions, not asserted to be FCFF, FCFE, AFFO or a share-price target.')}</p>
      <p class="analysis-note">${text('年報物業公允值損失', 'Reported property fair-value loss')}: ${amount(review.propertyFairValueLoss)}.
      ${text('淨物業收入減企業開支的租賃經營參考', 'Rental operating reference: NPI less corporate expenses')}: ${amount(review.normalizedRentalEbit)}.
      ${text('後者與 FMP EBIT 定義不同，不直接互換。未核實的供應商未來預測不改標為年報數字。', 'The latter is not the same definition as FMP EBIT and is not silently substituted. Unverified future vendor assumptions are not relabeled as report figures.')}</p>
      <p class="analysis-note"><a href="${escape(review.document.url)}" target="_blank" rel="noopener noreferrer">${escape(review.document.title)}</a> · ${escape(current.year)} · ${text('原始金額：HK$ 百萬元', 'Original units: HK$ millions')}</p></section>`;
  }

  function render() {
    const { stock, ticker, kind, data } = state, en = state.language() === 'en';
    const box = root.document.getElementById('fmp-workspace');
    const local = state.mode === 'ten-year' && dcfApplicable(stock);
    const result = local ? scenarioValue() : value(data, kind, stock);
    const row = result.row || (!local && dcfApplicable(stock) ? first(data?.models?.[kind]?.data) : null);
    const baseline = first(record(ticker)?.models?.[kind]?.data);
    const currency = stock.calculationCurrency || 'USD';
    const money = number => finite(number) ? `${currency} ${number.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : 'N/A';
    const text = (zh, english) => en ? english : zh;
    const percent = number => finite(number) ? `${number.toFixed(2)}%` : 'N/A';
    const set = (id, value) => { root.document.getElementById(id).textContent = value; };
    set('det-res-fair', money(result.fairVal));
    root.document.getElementById('det-res-fair').className = `stat-num ${result.fairVal === null
      ? 'text-muted' : result.fairVal < 0 ? 'text-red' : 'text-green'}`;
    set('det-res-price', money(stock.price));
    const review = state.sourceData?.sourceReview || record(ticker)?.sourceReview;
    const officialCorrection = !!stock.balanceClassificationSource || !!stock.cashflowProvenance || !!stock.revenueProvenance;
    set('det-res-status', (result.reason ? reasonText(result.reason, state.language())
      : `${local ? text('FMP 資料十年情境（本站計算）', 'FMP-based ten-year scenario (site-calculated)') : name(kind)} · ${result.capturedAt || data.capturedAt}`)
      + (review ? text(' · 注意年報／模型口徑差異；此價未按租賃業務正規化。', ' · Report/model basis differences: this value is not rental-normalized.') : '')
      + (officialCorrection ? text(' · 官方財報已更正；FMP 模型假設仍須獨立審閱。', ' · Official statements corrected; FMP model assumptions still require separate review.') : ''));
    set('det-res-wacc', percent(row?.wacc));
    set('det-res-g', percent(row?.longTermGrowthRate));
    set('det-res-spread', row ? percent(row.wacc - row.longTermGrowthRate) : 'N/A');
    set('det-res-ev', finite(row?.enterpriseValue) ? `${money(row.enterpriseValue / 1e6)} M` : 'N/A');
    const premium = result.fairVal > 0 && finite(stock.price) ? (stock.price / result.fairVal - 1) * 100 : null;
    set('det-res-premium', percent(premium));
    const badge = root.document.getElementById('det-badge');
    badge.className = finite(premium) ? `badge badge-${premium < 0 ? 'undervalued' : 'overvalued'}` : 'badge';
    badge.textContent = finite(premium) ? `${premium >= 0 ? '+' : ''}${premium.toFixed(1)}%` : 'N/A';
    set('det-res-evebitda', finite(stock.ev_to_ebitda) ? stock.ev_to_ebitda.toFixed(2) : 'N/A');
    set('det-res-nde', finite(stock.net_debt_to_ebitda) ? stock.net_debt_to_ebitda.toFixed(2) : 'N/A');
    const confidence = valuationConfidence({
      stock, result, scenario: local ? state.scenarios[kind] : null, mode: state.mode,
      statementsMissing: local && !state.actualStatements && !!state.actualError
    });
    const confidenceEl = root.document.getElementById('det-res-confidence');
    if (confidenceEl) {
      confidenceEl.textContent = confidenceText(confidence, state.language());
      confidenceEl.dataset.level = confidence.level;
    }
    root.document.querySelector('[onclick="saveCustomModel()"]').disabled = !!state.busy
      || result.fairVal === null && !(local ? state.scenarioDirty[kind] : state.dirty[kind]);
    box.innerHTML = `<div class="panel">
      <h3>${text('FMP 雙軌可編輯估值模型', 'Two editable FMP valuation models')}</h3>
      <label for="fmp-mode">${text('計算來源', 'Calculation source')}</label>
      <select id="fmp-mode"><option value="vendor">${text('FMP API 原始模型', 'Original FMP API model')}</option>
        <option value="ten-year">${text('FMP 資料十年自訂情境（本站計算）', 'FMP-based ten-year scenario (site-calculated)')}</option></select>
      <label for="fmp-model">${text('模型', 'Model')}</label>
      <select id="fmp-model"><option value="advanced">${local ? text('Advanced 十年情境（EBITDA／FCFF）', 'Advanced ten-year scenario (EBITDA / FCFF)') : name('advanced')}</option>
        <option value="customLevered">${local ? text('Levered 十年情境（CFO）', 'Levered ten-year scenario (CFO)') : name('customLevered')}</option></select>
      ${sourceReviewHtml(text)}
      ${stock.revenueProvenance ? `<p class="analysis-note text-red" id="fmp-revenue-source-warning">${text(
        '已核對期間採各發行人官方合併營收與指定損益項目，並按原報表的博彩稅、派彩、佣金及合併範圍處理，不會一律加回博彩稅或被投資公司的營收。原生 FMP 模型仍保留供應商原始數字，未按本次核對重算，不能視為已校正估值；新建本站情境使用已核對基期與適用實績比率。已儲存假設及目標價不自動改寫，未核對的其他欄位亦不代表已獲官方認證。',
        'Reviewed periods use each issuer’s official consolidated revenue and specified income lines, respecting its gaming-tax, payout, commission and consolidation presentation. Gaming tax and investee revenue are not universally added back. Native FMP models retain unmodified provider figures and are not recalculated by this review; they are not corrected valuations. New site scenarios use reviewed baselines and applicable actual ratios. Saved assumptions/targets are unchanged; unreviewed fields are not certified.')}</p>` : ''}
      ${officialCorrection ? `<p class="analysis-note" id="fmp-official-source-warning">${text(
        '財務報表頁已按官方資料更正現金流及／或流動與非流動分類；原生 API 結果保留不改。新情境按適用的已審閱實績比率設定，並非已核實的官方預測。請審閱營運資金、現金、債務與現金流口徑後再保存目標價。',
        'The financial-statements page corrects cash flow and/or current/non-current classification using official sources. Native API results are unchanged. New scenarios use the reviewed latest actual ratios where applicable, not verified official forecasts. Review working capital, cash, debt and cash-flow definitions before saving a target.')}</p>` : ''}
      ${local ? scenarioHtml(text, money, result) : `
      <p class="analysis-note">${text(
        '下表與預設假設直接來自 FMP 模型 API，屬供應商模型／外推，不保證是公司指引或分析師共識。輸入空白保留 FMP 預設；自行修改的數值明確屬用戶情境。FMP Levered 依供應商回傳的 WACC、EV 及淨債務定義呈現，不冒稱以 Ke 折現的獨立 FCFE 模型。',
        'Rows and defaults come directly from FMP model APIs: vendor projections/extrapolations, not necessarily company guidance or analyst consensus. Blank inputs preserve FMP defaults; overrides are user scenarios. FMP Levered retains the returned WACC, EV and net-debt definitions; it is not relabeled as an independently calculated FCFE/Ke model.')}</p>
      <p class="analysis-note" id="fmp-share-note">${text(
        '本網站每股價採 FMP 股權價值 ÷ 全公司流通在外普通股（不含庫存股；A/H 採全部普通股）。FMP 原始每股價及其稀釋股數另列，不冒稱使用相同股數。',
        'Site price = FMP equity value / all outstanding common shares excluding treasury shares (all A/H ordinary classes). The original FMP per-share value and diluted denominator are shown separately, not claimed to use issued shares.')}
        ${escape(stock.shareSource?.date || '')} · ${finite(stock.shares_outstanding) ? stock.shares_outstanding.toLocaleString('en-US') : 'N/A'} · ${escape(stock.shareSource?.source || '')}</p>
      <p class="analysis-note">${text('模型金額幣別及 FX 核對', 'Model amount currency / FX reconciliation')}: ${escape(data?.currencyCheck?.reason || data?.currencyCheck?.basis || 'FMP_SOURCE_UNAVAILABLE')}.
        ${text('外幣財報的 FMP 模型採其當前即期換匯，不代表歷史期間平均匯率。', 'Foreign financials in FMP models use its current spot conversion, not historical period-average FX.')}</p>
      <div class="fin-model-grid">${fields.filter(field => !field[5] || field[5] === kind).map(([key, field, zh, english, scale]) => `
        <div class="form-group"><label for="fmp-${key}">${escape(text(zh, english))}</label>
        <input id="fmp-${key}" data-fmp-input="${key}" type="number" step="any" placeholder="${finite(baseline?.[field]) ? baseline[field] : 'N/A'}"
          value="${finite(state.params[kind]?.[key]) ? escape(state.params[kind][key] * scale) : ''}">
        <small>${text('FMP 預設', 'FMP default')}: ${finite(baseline?.[field]) ? baseline[field] : 'N/A'}</small></div>`).join('')}</div>
      <button id="fmp-calculate" type="button" class="btn-save">${text('向 FMP 計算此情境', 'Calculate this scenario with FMP')}</button>
      <p id="fmp-status" role="status">${escape(state.dirty[kind]
        ? text('用戶情境尚未計算；按「儲存目標價」會先向 FMP 計算，成功後才儲存新價格。', 'Overrides are pending: Save target calculates with FMP first and saves only the successful new result.')
        : result.reason ? reasonText(result.reason, state.language()) : `${name(kind)} · ${result.capturedAt || data?.capturedAt || 'N/A'}`)}</p>
      <div class="table-scroll-wrapper"><table><tbody>
        <tr><th>${text('供應商原始每股值（稀釋股數）', 'Original provider value per diluted share')}</th><td>${money(row?.equityValuePerShare)}</td></tr>
        <tr><th>${text('供應商模型稀釋股數', 'Provider model diluted shares')}</th><td>${finite(row?.dilutedSharesOutstanding) ? row.dilutedSharesOutstanding.toLocaleString('en-US') : 'N/A'}</td></tr>
        <tr><th>${text('模型企業價值 EV', 'Model enterprise value')}</th><td>${money(row?.enterpriseValue)}</td></tr>
        <tr><th>${text('減：FMP 模型淨債務', 'Less: FMP model net debt')}</th><td>${money(row?.netDebt)}</td></tr>
        <tr><th>${text('股權價值', 'Equity value')}</th><td>${money(row?.equityValue)}</td></tr>
        <tr><th>${text('WACC ／ Ke ／ 稅率（FMP）', 'WACC / Ke / tax rate (FMP)')}</th><td>${percent(row?.wacc)} / ${percent(row?.costOfEquity)} / ${percent(row?.taxRate)}</td></tr>
        <tr><th>${text('終值 ／ 終值現值', 'Terminal value / discounted terminal value')}</th><td>${money(row?.terminalValue)} / ${money(row?.presentTerminalValue)}</td></tr>
        <tr><th>${text('模型現金流現值合計', 'Sum of discounted model cash flows')}</th><td>${money(row?.sumPvUfcf ?? row?.sumPvLfcf)}</td></tr>
      </tbody></table></div>
      <h4>${text('FMP 年度模型資料（不是逐期公布的歷史估值）', 'FMP annual model rows (not point-in-time historical valuations)')}</h4>
      <p class="analysis-note">${text('年度及數值照錄 FMP；未將模型年度當成已公布財報，也未製造季度估值。', 'Years and values are supplied by FMP; model years are not relabeled as filed financials and no quarterly valuations are fabricated.')}</p>
      <p class="analysis-note">${text('EBITDA 與 CFO 並不相同；CFO 已處理 D&A，亦受稅、利息及營運資金影響。此處改為顯示 EBITDA，不會改動 FMP Advanced 的 EBIT 稅基或公式。', 'EBITDA is not CFO: CFO already accounts for D&A and also reflects taxes, interest and working capital. Displaying EBITDA does not change the FMP Advanced EBIT tax base or formula.')}</p>
      <div class="table-scroll-wrapper"><table id="fmp-vendor-years"><thead><tr><th>${text('模型年度', 'Model year')}</th><th>${text('資料性質', 'Basis')}</th><th>${text('營收', 'Revenue')}</th><th>${kind === 'advanced' ? 'EBITDA' : 'CFO'}</th><th>CapEx</th><th>${kind === 'advanced' ? text('模型 FCFF', 'Model FCFF') : text('模型 CFO 減 CapEx', 'Model CFO less CapEx')}</th></tr></thead>
        <tbody>${(data?.models?.[kind]?.data || []).slice().sort((a,b) => Number(a.year)-Number(b.year)).map(r => `<tr>
          <th>${escape(r.year)}</th><td>${!Number.isInteger(data?.forecastBase?.year) ? text('FMP 模型資料；實際／預測未核對', 'FMP model; actual/projected unverified')
            : Number(r.year) > data.forecastBase.year ? text('FMP 模型預測', 'FMP model projection') : text('FMP 歷史模型口徑，非年報逐列照錄', 'FMP historical model basis, not report line items')}</td>
          <td>${money(r.revenue)}</td><td>${money(kind === 'advanced' ? r.ebitda : r.operatingCashFlow)}</td><td>${money(r.capitalExpenditure)}</td><td>${money(kind === 'advanced' ? r.ufcf : r.freeCashFlow)}</td></tr>`).join('')}</tbody></table></div>
      <p class="analysis-note">${text('FMP 的租賃、投資、非控制權益及優先股處理未等同本網站原官方 FCFF 對帳；不保證兩模型可直接比較。此處顯示供應商模型，不代表所有假設均經獨立驗證。', 'FMP treatment of leases, investments, NCI and preferred claims is not the prior issuer-reconciled FCFF bridge. Models are not guaranteed comparable; displaying a vendor model does not independently certify all assumptions.')}</p>
      `}
      <button id="fmp-download-audit" type="button" class="btn-save">${text('下載計算模型與完整精度輸入（JSON）', 'Download calculation model and full-precision inputs (JSON)')}</button>
      <p class="analysis-note">${text('下載包含原生 API 資料、每股分母、對帳差額、十年逐年公式／輸入／結果及實際參考來源；未保存或部署任何改動。原生 API 內部規則未經獨立重現，不以差額倒推或修改供應商數字。', 'The download includes native API rows, share denominators, reconciliation residuals, annual ten-year formulas/inputs/results and actual-reference provenance. It does not save or deploy changes. Native API internals are not independently reproduced; residuals are not used to back-solve or modify vendor figures.')}</p>
    </div>`;
    box.querySelector('#fmp-mode').value = state.mode;
    box.querySelector('#fmp-mode').addEventListener('change', event => { state.requestId++; state.mode = event.target.value; render(); });
    box.querySelector('#fmp-model').value = kind;
    box.querySelector('#fmp-model').addEventListener('change', event => { state.requestId++; state.kind = event.target.value; render(); });
    box.querySelectorAll('[data-fmp-input]').forEach(input => input.addEventListener('input', () => {
      const field = fields.find(field => field[0] === input.dataset.fmpInput);
      if (input.value.trim()) state.params[kind][field[0]] = Number(input.value) / field[4];
      else delete state.params[kind][field[0]];
      state.dirty[kind] = true;
      state.requestId++;
      root.document.querySelector('[onclick="saveCustomModel()"]').disabled = !!state.busy;
      box.querySelector('#fmp-status').textContent = text('假設已修改；儲存時會先計算，成功後才保存新目標價。', 'Assumptions changed: saving calculates first and persists only the new successful target.');
    }));
    const changed = () => {
      state.requestId++; state.scenarioDirty[kind] = true;
      root.document.querySelector('[onclick="saveCustomModel()"]').disabled = !!state.busy;
      box.querySelector('#fmp-status').textContent = text('假設已修改；儲存時會先計算，成功後才保存新目標價。', 'Assumptions changed: saving calculates first and persists only the new successful target.');
    };
    box.querySelectorAll('[data-scenario-key]').forEach(input => input.addEventListener('input', () => {
      const index = Number(input.dataset.scenarioYear), key = input.dataset.scenarioKey;
      const scenario = state.scenarios[kind], item = scenario.years[index];
      Scenario.update(scenario, index, key, input.value.trim() ? input.valueAsNumber : null);
      for (const field of Scenario.activeFields(kind, scenario)) {
        const control = box.querySelector(`[data-scenario-year="${index}"][data-scenario-key="${field[0]}"]`);
        control.title = finite(item.values[field[0]]) ? String(item.values[field[0]]) : '';
        if (control !== input) control.value = inputValue(field[0], item.values[field[0]]);
        box.querySelector(`[data-origin="${index}-${field[0]}"]`).textContent = originText(item.origins[field[0]], text);
      }
      changed();
    }));
    box.querySelectorAll('[data-scenario-key]').forEach(input => input.addEventListener('blur', () => {
      input.value = inputValue(input.dataset.scenarioKey,
        state.scenarios[kind].years[Number(input.dataset.scenarioYear)].values[input.dataset.scenarioKey]);
    }));
    for (const [id, key] of [['fmp-terminal-growth', 'terminalGrowth'], ['fmp-exit-multiple', 'exitMultiple'], ['fmp-snapshot-net-debt', 'netDebt']]) {
      box.querySelector(`#${id}`)?.addEventListener('input', event => {
        state.scenarios[kind][key] = event.target.value.trim() ? event.target.valueAsNumber : null;
        event.target.title = String(state.scenarios[kind][key] ?? '');
        if (key === 'terminalGrowth') {
          state.scenarios[kind].terminalGrowthOrigin = event.target.value.trim() ? 'user' : null;
        }
        if (key === 'exitMultiple') {
          state.scenarios[kind].exitMultipleOrigin = event.target.value.trim() ? 'user' : null;
        }
        if (key === 'netDebt') {
          state.scenarios[kind].netDebtBasis = finite(state.scenarios[kind].netDebt)
            && state.scenarios[kind].netDebt < 0 ? 'net-cash' : 'net-debt';
          const meta = box.querySelector('#fmp-snapshot-net-debt-meta');
          if (meta) {
            const netCash = state.scenarios[kind].netDebtBasis === 'net-cash';
            meta.textContent = `${text('報表／快照日', 'Statement / snapshot date')}: ${state.scenarios[kind].netDebtDate || state.scenarios[kind].baseDate || 'N/A'} · ${text('顯示', 'Display')}: ${formatMoneyInput(state.scenarios[kind].currency, state.scenarios[kind].netDebt)} · ${netCash ? text('負淨債務＝淨現金', 'Negative net debt = net cash') : text('正值＝淨債務', 'Positive = net debt')}`;
          }
        }
        changed();
      });
    }
    box.querySelector('#fmp-terminal-growth')?.addEventListener('blur', event => {
      event.target.value = inputValue('terminalGrowth', state.scenarios[kind].terminalGrowth);
    });
    box.querySelector('#fmp-exit-multiple')?.addEventListener('blur', event => {
      event.target.value = inputValue('exitMultiple', state.scenarios[kind].exitMultiple);
    });
    box.querySelector('#fmp-rf-tenor')?.addEventListener('change', event => {
      const tenor = Number(event.target.value);
      const applied = applyRfTenor(state.scenarios[kind], tenor);
      const status = box.querySelector('#fmp-rf-tenor-status');
      if (status) {
        status.textContent = applied
          ? `${state.scenarios[kind].rfTenorSource.rate.toFixed(2)}% · ${state.scenarios[kind].rfTenorSource.currency} · ${state.scenarios[kind].rfTenorSource.date || 'N/A'}`
          : reasonText('DATED_CURVE_TENOR_UNAVAILABLE', state.language());
      }
      if (applied) {
        state.scenarioDirty[kind] = true;
        render();
      } else {
        changed();
      }
    });
    box.querySelector('#fmp-calculate')?.addEventListener('click', calculate);
    box.querySelector('#fmp-download-audit').addEventListener('click', downloadAudit);
    box.querySelector('#fmp-download-audit').disabled = !!state.busy;
    if (state.busy && box.querySelector('#fmp-calculate')) box.querySelector('#fmp-calculate').disabled = true;
  }

  function auditPacket({ data, sourceData = data, kind, stock, scenario = null, statements = null, params = {} }) {
    const native = value(data, kind, stock), rows = data?.models?.[kind]?.data || [];
    const residual = (actual, expected) => finite(actual) && finite(expected) ? actual - expected : null;
    let calculation = null, calculationReason = null;
    if (scenario) {
      try { calculation = Scenario.calculate(scenario); }
      catch (error) {
        if (!error.message.startsWith('SCENARIO_')) throw error;
        calculationReason = error.message;
      }
    }
    return { version: 1, symbol: stock.ticker, currency: data?.currency, kind,
      sourceCapturedAt: data?.models?.[kind]?.capturedAt || data?.capturedAt,
      native: { params, selectedYear: native.row?.year, reason: native.reason,
        rowCoverage: rows.length < (sourceData?.models?.[kind]?.data?.length || 0) ? 'partialVersusCachedSource' : 'availableApiRows',
        targetPrice: native.fairVal, issuedShares: issuedShares(stock), shareSource: stock.shareSource,
        rows, checks: rows.map(row => ({ year: row.year,
          evResidual: residual(row.enterpriseValue, (row.sumPvUfcf ?? row.sumPvLfcf) + row.presentTerminalValue),
          equityResidual: residual(row.equityValue, row.enterpriseValue - row.netDebt),
          dilutedPriceResidual: residual(row.equityValuePerShare, row.equityValue / row.dilutedSharesOutstanding),
          ebitIdentityResidual: kind === 'advanced' ? residual(row.ebit, row.ebitda - row.depreciation) : null,
          cfoCashFlowResidual: kind === 'customLevered' ? residual(row.freeCashFlow, row.operatingCashFlow + row.capitalExpenditure) : null
        })) },
      originalSourceModels: sourceData?.models,
      analystEstimates: sourceData?.analystEstimates,
      forecastActuals: sourceData?.forecastActuals,
      revenueProvenance: sourceData?.revenueProvenance || statements?.revenueProvenance,
      tenYear: scenario ? { input: structuredClone(scenario), result: calculation,
        reason: calculationReason, missingInputs: Scenario.missingInputs(scenario) } : null,
      actualReference: Scenario.actualReference(sourceData, statements,
        scenario ? { year: scenario.baseYear, date: scenario.baseDate } : undefined),
      formulas: Scenario.formulas };
  }

  async function downloadAudit() {
    if (!state || state.busy) return;
    const current = state, kind = state.kind, mode = state.mode;
    if (mode !== 'ten-year' && state.dirty[kind]) {
      if (!await calculate() || state !== current || state.kind !== kind || state.mode !== mode) return;
    }
    const packet = auditPacket({ ...state, scenario: mode === 'ten-year' ? state.scenarios[kind] : null,
      statements: state.actualStatements, params: state.params[kind] });
    const url = root.URL.createObjectURL(new root.Blob([JSON.stringify(packet, null, 2)], { type: 'application/json' }));
    const link = root.document.createElement('a');
    link.href = url; link.download = `${state.ticker}-${kind}-${mode}-calculation.json`;
    link.click();
    root.setTimeout(() => root.URL.revokeObjectURL(url), 0);
  }

  function actuals(ticker, statements, reason = null) {
    if (!state || state.ticker !== ticker) return;
    state.actualStatements = statements; state.actualError = reason;
    if (state.scenarios?.[state.kind]) enrichScenarioSuggestions(state.scenarios[state.kind]);
    if (state.mode !== 'ten-year' || !root.document.getElementById('fmp-actual-period')) return;
    if (root.document.getElementById('fmp-fy-history') || root.document.getElementById('fmp-ten-year-inputs')) {
      render();
      return;
    }
    const text = (zh, en) => state.language() === 'en' ? en : zh;
    const money = value => finite(value) ? `${state.stock.calculationCurrency || 'USD'} ${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : 'N/A';
    const column = actualColumn(text, money);
    root.document.getElementById('fmp-actual-period').innerHTML = column.header;
    root.document.getElementById('fmp-actual-note').innerHTML = column.note;
    root.document.querySelectorAll('[data-actual-key]').forEach(cell => { cell.innerHTML = column.cells[cell.dataset.actualKey]; });
  }

  async function calculate() {
    if (!state || state.busy) return false;
    const current = state, id = ++state.requestId, kind = state.kind, mode = state.mode;
    const status = root.document.getElementById('fmp-status');
    if ([...root.document.querySelectorAll('#fmp-workspace input')].some(input => !input.reportValidity())) {
      status.textContent = state.language() === 'en' ? 'Correct the invalid numeric inputs before calculating.' : '請先修正無效的數字輸入。';
      return false;
    }
    if (mode === 'ten-year') {
      const result = scenarioValue();
      if (result.reason) {
        status.textContent = reasonText(result.reason, state.language());
        return false;
      }
      state.scenarioDirty[kind] = false;
      render();
      return true;
    }
    const query = new URLSearchParams({ action: kind === 'advanced' ? 'custom-dcf' : 'custom-levered-dcf', symbol: state.ticker,
      ...Object.fromEntries(Object.entries(state.params[kind]).map(([key, value]) => [key, String(value)])) });
    const button = root.document.getElementById('fmp-calculate');
    state.busy = true;
    state.busyRequest = id;
    button.disabled = true;
    root.document.getElementById('fmp-download-audit').disabled = true;
    root.document.querySelector('[onclick="saveCustomModel()"]').disabled = true;
    status.textContent = state.language() === 'en' ? 'Calculating with FMP…' : '正在向 FMP 計算…';
    try {
      const result = await root.FmpCache.request(query, {
        scope: JSON.stringify([current.sourceData?.capturedAt || null, current.data?.capturedAt || null])
      });
      if (!Array.isArray(result.data) || result.source?.symbol !== current.ticker) throw new Error('FMP_INVALID_RESPONSE');
      if (state !== current || id !== state.requestId || kind !== state.kind || mode !== state.mode) return false;
      const updated = { ...state.data,
        models: { ...state.data.models, [kind]: { ...state.data.models[kind], data: result.data,
          capturedAt: result.source.capturedAt,
          reason: result.data.length ? null : 'FMP_NO_COVERAGE' } } };
      const calculated = value(updated, kind, state.stock);
      if (calculated.reason) throw new Error(calculated.reason);
      state.data = updated;
      state.dirty[kind] = false;
      state.busy = false;
      render();
      root.document.getElementById('fmp-status').textContent += ` ${root.FmpCache.note(result, state.language())}`;
      return true;
    } catch (error) {
      if (state !== current || id !== state.requestId) return false;
      console.error('FMP custom valuation failed', state.ticker, error.message);
      const activeStatus = root.document.getElementById('fmp-status');
      if (activeStatus) activeStatus.textContent = `${state.language() === 'en' ? 'Calculation failed; no new result was saved' : '計算失敗，未儲存新結果'}: ${error.message}`;
      return false;
    } finally {
      if (current.busyRequest === id) current.busy = false;
      if (state === current && current.busyRequest === id) {
        root.document.querySelector('[onclick="saveCustomModel()"]').disabled = false;
        const activeButton = root.document.getElementById('fmp-calculate');
        if (activeButton) activeButton.disabled = false;
        const auditButton = root.document.getElementById('fmp-download-audit');
        if (auditButton) auditButton.disabled = false;
      }
    }
  }

  async function save() {
    if (!state || state.busy || root.document.querySelector('[onclick="saveCustomModel()"]').disabled) return;
    const current = state, kind = state.kind, mode = state.mode;
    if (mode === 'ten-year' || state.dirty[kind]) {
      if (!await calculate() || state !== current || kind !== state.kind || mode !== state.mode) return;
    }
    if (mode === 'ten-year') {
      const result = scenarioValue();
      if (result.reason) return;
      state.save({ schemaVersion: 2, modelType: 'FMP_TEN_YEAR_SCENARIO', kind, ticker: state.ticker,
        currency: result.currency, targetPrice: result.fairVal, issuedShares: result.issuedShares,
        shareSource: state.stock.shareSource, scenario: structuredClone(state.scenarios[kind]),
        sourceReviewRequired: !!state.sourceData?.sourceReview || !!state.stock.balanceClassificationSource || !!state.stock.cashflowProvenance,
        sourceCapturedAt: result.capturedAt, savedAt: new Date().toISOString() });
      return;
    }
    const result = value(state.data, state.kind, state.stock);
    if (result.fairVal === null) return;
    state.save({ schemaVersion: 1, modelType: 'FMP_CUSTOM_DCF', kind: state.kind, ticker: state.ticker,
      currency: result.currency, targetPrice: result.fairVal, issuedShares: result.issuedShares,
      sourceReviewRequired: !!state.sourceData?.sourceReview || !!state.stock.balanceClassificationSource || !!state.stock.cashflowProvenance,
      shareSource: state.stock.shareSource, providerShares: result.providerShares, providerEquityValue: result.row.equityValue,
      modelSummary: { ...result.row }, params: { ...state.params[state.kind] },
      sourceCapturedAt: result.capturedAt, savedAt: new Date().toISOString() });
  }
  function reset() { if (state) { state.requestId++; state.params = { advanced: {}, customLevered: {} };
    state.scenarios = {}; state.scenarioDirty = { advanced: false, customLevered: false };
    state.mode = 'vendor'; state.kind = 'advanced'; state.busy = false;
    state.dirty = { advanced: false, customLevered: false }; state.data = state.sourceData || record(state.ticker); render(); } }
  function detailsError(ticker, reason) {
    if (!state || state.ticker !== ticker) return;
    const status = root.document.getElementById('fmp-status');
    if (status) status.textContent = `${state.language() === 'en'
      ? 'Detailed model source unavailable; only the dated summary is shown'
      : '詳細模型來源無法載入；目前僅顯示附日期的摘要'}: ${reason}`;
  }
  function modelYearKey(payload, kind) {
    return (payload?.models?.[kind]?.data || [])
      .map(row => Number(row.year)).filter(Number.isFinite).sort((a, b) => a - b).join(',');
  }

  function details(data) {
    if (state && state.ticker === data.symbol) {
      if (state.data === record(state.ticker) || state.data === state.sourceData) state.data = data;
      const previous = state.sourceData;
      state.sourceData = data;
      // Embedded FMP_MODEL_DATA often truncates to a single forward year and may omit
      // analystEstimates/forecastActuals. Rebuild pristine scenarios once the company
      // cache arrives (same capturedAt is common — compare model years too).
      const enriched = (!previous?.analystEstimates?.rows?.length && data.analystEstimates?.rows?.length)
        || (!previous?.forecastActuals?.latest && data.forecastActuals?.latest)
        || (!!previous?.forecastBase?.reason && !data.forecastBase?.reason)
        || (previous?.currencyCheck?.reason !== data.currencyCheck?.reason)
        || (previous?.capturedAt !== data.capturedAt)
        || modelYearKey(previous, 'advanced') !== modelYearKey(data, 'advanced')
        || modelYearKey(previous, 'customLevered') !== modelYearKey(data, 'customLevered');
      if (enriched) {
        for (const kind of ['advanced', 'customLevered']) {
          if (!state.scenarioDirty?.[kind]) delete state.scenarios[kind];
        }
      }
      if (!root.document.getElementById('fmp-workspace').hidden) render();
    }
  }
  return { record, value, issuedShares, reference, dcfApplicable, priceDifference, compatible, load, save, reset, details, detailsError, reasonText, actuals, auditPacket,
    valuationConfidence, confidenceText, riskFreeTenorSource, applyRfTenor, isHkListing,
    deactivate: () => { state = null; }, rerender: () => { if (state) render(); } };
});
