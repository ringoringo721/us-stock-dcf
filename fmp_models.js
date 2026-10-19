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
      FMP_SOURCE_UNAVAILABLE: ['尚無此股票的 FMP 模型來源。', 'The FMP model source is unavailable for this security.']
    };
    return messages[reason]?.[language === 'en' ? 1 : 0] || reason || '';
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
      if (!state.scenarios[state.kind]) state.scenarios[state.kind] = Scenario.defaults(state.sourceData, state.kind, issuedShares(state.stock));
      state.scenarios[state.kind] = Scenario.upgradeWorkingCapital(state.scenarios[state.kind]);
      const scenario = state.scenarios[state.kind], result = Scenario.calculate(scenario);
      if (scenario.symbol !== state.ticker || scenario.currency !== (state.stock.calculationCurrency || 'USD')
          || scenario.shares !== issuedShares(state.stock)) throw new Error('SCENARIO_SOURCE_UNAVAILABLE');
      return { fairVal: result.targetPrice, WACC: result.wacc, g: result.g, reason: null, result,
        row: { enterpriseValue: result.enterpriseValue, equityValue: result.equityValue, netDebt: result.netDebt,
          terminalValue: result.terminalValue, presentTerminalValue: result.presentTerminalValue,
          wacc: result.wacc * 100, longTermGrowthRate: result.g },
        currency: scenario.currency, capturedAt: scenario.sourceCapturedAt, issuedShares: scenario.shares };
    } catch (error) {
      if (!error.message.startsWith('SCENARIO_')) throw error;
      return { fairVal: null, reason: error.message };
    }
  }

  const inputValue = (key, number) => finite(number) ? key === 'beta' ? String(number) : number.toFixed(2) : '';
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
      'retained-capital': text('維持原資本成本設定', 'Retained capital-cost setting'),
      'derived-legacy': text('舊情境等值換算', 'Equivalent legacy conversion'),
      unavailable: text('N/A：未提供預測', 'N/A: forecast unavailable')
    })[origin] || origin;
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
        'Advanced：EBIT = EBITDA − D&A；修改 EBIT 會連動 EBITDA。有共識 EBITDA 時優先使用，EBIT 為連動推導，不冒稱同時符合供應商獨立 EBIT 預測；僅有共識 EBIT 時，以 EBIT 加 D&A 推導 EBITDA。FCFF = EBIT × (1 − 稅率) + D&A + 負數 CapEx − 營運資金增加。CFO 情境採 CFO + 負數 CapEx，不再加回 D&A；保留 WACC 折現及 EV 減淨債務定義，並非獨立 FCFE／Ke 模型。新預設不以歷史有效稅率或原生模型隱含稅率填補缺少的分析師營運稅率。',
        'Advanced: EBIT = EBITDA - D&A; editing EBIT updates EBITDA. Consensus EBITDA takes priority, with linked EBIT not claimed to also match a separate provider EBIT forecast. If only consensus EBIT exists, EBITDA derives from EBIT plus D&A. FCFF = EBIT × (1 - tax) + D&A + negative CapEx - increase in working capital. The CFO scenario uses CFO + negative CapEx without adding D&A again. It retains WACC/EV less net debt, not an independent FCFE/Ke model. New defaults do not substitute historical effective tax or native-model implied tax for missing analyst operating tax.')}</p>
      <p class="analysis-note">${text(
        '逐年 WACC 由股權／稅後債務成本與資本權重計算；修改 Beta、無風險利率或風險溢價會以 CAPM 更新該年的股權成本，亦可直接覆寫股權成本。每年折現因子連乘。終值增長率僅用於第十年後終值。EV 只減一次基期淨債務，不額外加上預測現金。負存貨或負稅率照來源標示，必須審視其適用性，未經獨立核實。',
        'Annual WACC uses equity/after-tax debt costs and capital weights; editing beta, risk-free rate or premium updates that year’s equity cost through CAPM, which can also be overridden directly. Annual discount factors compound. Terminal growth applies only beyond year ten. EV subtracts snapshot net debt once, with no extra addition of projected cash. Negative inventory/tax inputs require review and are not independently certified.')}</p>
      <p class="analysis-note" id="fmp-actual-note">${actual.note}</p>
      <div class="table-scroll-wrapper"><table id="fmp-ten-year-inputs"><thead><tr><th>${text('假設／來源', 'Assumption / source')}</th><th id="fmp-actual-period">${actual.header}</th>${scenario.years.map(item => `<th>${item.year}</th>`).join('')}</tr></thead><tbody>
        ${Scenario.activeFields(state.kind, scenario).map(([key, zh, en, min, max]) => `<tr><th>${escape(text(zh, en))}</th><td data-actual-key="${key}">${actual.cells[key]}</td>${scenario.years.map((item, index) => `<td>
          <input aria-label="${escape(text(zh, en))} ${item.year}" data-scenario-key="${key}" data-scenario-year="${index}" type="number" step="any" min="${min}" max="${max}" required placeholder="N/A" title="${escape(item.values[key] ?? '')}" value="${inputValue(key, item.values[key])}">
          <small data-origin="${index}-${key}">${escape(originText(item.origins[key], text))}</small></td>`).join('')}</tr>`).join('')}
      </tbody></table></div>
      <div class="fin-model-grid"><div class="form-group"><label for="fmp-terminal-growth">${text('第十年後終值增長率 (%)', 'Terminal growth after year ten (%)')}</label>
      <input id="fmp-terminal-growth" type="number" required step="any" min="-10" max="20" placeholder="N/A" title="${escape(scenario.terminalGrowth ?? '')}" value="${inputValue('terminalGrowth', scenario.terminalGrowth)}"></div>
      <div class="form-group"><label for="fmp-snapshot-net-debt">${text('來源快照淨債務（可調整）', 'Snapshot net debt (editable)')} · ${escape(scenario.currency)}</label>
      <input id="fmp-snapshot-net-debt" type="number" required step="any" value="${scenario.netDebt}"></div></div>
      <p class="analysis-note">${text('調整終值增長率不會悄悄改寫已填好的十年增長率；需要時請逐年修改。', 'Changing terminal growth does not silently overwrite the ten populated annual growth inputs; edit those years explicitly if needed.')}</p>
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
      <p class="analysis-note">${text('現金流現值合計／終值現值／EV／淨債務／股權價值', 'PV cash flows / PV terminal / EV / net debt / equity')}: ${[
        result.result?.presentFlows, result.row?.presentTerminalValue, result.row?.enterpriseValue, scenario.netDebt, result.row?.equityValue].map(money).join(' / ')}</p>`;
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
    for (const [id, key] of [['fmp-terminal-growth', 'terminalGrowth'], ['fmp-snapshot-net-debt', 'netDebt']]) {
      box.querySelector(`#${id}`)?.addEventListener('input', event => {
        state.scenarios[kind][key] = event.target.value.trim() ? event.target.valueAsNumber : null;
        event.target.title = String(state.scenarios[kind][key] ?? '');
        changed();
      });
    }
    box.querySelector('#fmp-terminal-growth')?.addEventListener('blur', event => {
      event.target.value = inputValue('terminalGrowth', state.scenarios[kind].terminalGrowth);
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
    if (state.mode !== 'ten-year' || !root.document.getElementById('fmp-actual-period')) return;
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
  function details(data) {
    if (state && state.ticker === data.symbol) {
      if (state.data === record(state.ticker) || state.data === state.sourceData) state.data = data;
      state.sourceData = data;
      if (!root.document.getElementById('fmp-workspace').hidden) render();
    }
  }
  return { record, value, issuedShares, reference, dcfApplicable, priceDifference, compatible, load, save, reset, details, detailsError, reasonText, actuals, auditPacket,
    deactivate: () => { state = null; }, rerender: () => { if (state) render(); } };
});
