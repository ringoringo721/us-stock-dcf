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

  function reference(data, kind) {
    if (!data) return null;
    const model = data.models?.[kind], row = model?.data?.[0];
    return !model?.reason && row?.symbol === data.symbol && finite(row.dcf) ? row.dcf : null;
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
      SCENARIO_BASE_UNVERIFIED: ['缺少與實際年度財報核對的基期；不猜測預測起點。', 'A verified actual fiscal-year baseline is unavailable; the projection start is not guessed.'],
      SCENARIO_FORECAST_UNAVAILABLE: ['完整 FMP 年度來源尚不可用，不能建立十年情境。', 'Full annual FMP source rows are unavailable; a ten-year scenario cannot be created.'],
      SCENARIO_SOURCE_UNAVAILABLE: ['缺少有效 FMP 模型或普通股股數，不能建立十年情境。', 'A valid FMP model or issued-share denominator is unavailable.'],
      SCENARIO_INVALID_TERMINAL_SPREAD: ['第十年 WACC 必須高於終值增長率。', 'Year-ten WACC must exceed terminal growth.'],
      FMP_NO_COVERAGE: ['FMP 未提供此模型資料；不製造估值。', 'FMP supplies no rows for this model; no valuation is fabricated.'],
      FMP_MODEL_CURRENCY_UNVERIFIED: ['FMP 模型金額幣別尚未與財報核對，不能冒稱美元或港元。', 'FMP model currency could not be reconciled with financials; amounts are not relabeled as USD/HKD.'],
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

  function scenarioHtml(text, money, result) {
    const scenario = state.scenarios[state.kind];
    if (!scenario) return `<p id="fmp-status" role="status">${escape(reasonText(result.reason, state.language()))}</p>`;
    const origins = {
      fmp: text('FMP 模型', 'FMP model'), extension: text('標準延伸假設', 'Standard extension'),
      user: text('用戶修改', 'User override'), derived: text('連動推導', 'Linked derivation'),
      capm: 'CAPM', 'derived-fmp': text('FMP 推導', 'FMP-derived'),
      'normalized-fmp-tax': text('標準化：採 FMP 列示稅率', 'Normalized: stated FMP tax')
    };
    return `<p class="analysis-note">${text(
      '這是以 FMP 資料為基礎、由本網站計算的十年自訂情境，不是 FMP API 原始估值。十年由已核對的最近實際財年之後開始。FMP 已提供的預測比率照錄；其後營收增長率逐步回歸終值增長率，其餘比率及資本成本維持最後一個供應商預測年度。標準延伸不代表公司指引或分析師共識。',
      'This ten-year scenario is calculated by this site from FMP inputs, not returned by the FMP API. Its ten years start after the latest reconciled actual fiscal year. Available FMP projected ratios are retained; subsequent revenue growth fades to terminal growth and other ratios/capital costs hold the last vendor projection. Extensions are not company guidance or analyst consensus.')}</p>
      <p class="analysis-note">${text('實際基期', 'Actual baseline')}: ${scenario.baseYear} (${escape(scenario.baseDate)}) · ${text('FMP 預測年度', 'FMP projection years')}: ${scenario.providerYears.join(', ')} · ${text('來源擷取', 'Source captured')}: ${escape(scenario.sourceCapturedAt)}</p>
      ${(scenario.warnings || []).map(warning => `<p class="analysis-note">${text('來源警示：隱含營運稅率超出可用範圍；此情境明確改採 FMP 列示稅率，非照錄原始估值。', 'Source warning: implied operating tax is outside the supported range; this scenario explicitly uses the stated FMP tax rate instead, not the original API valuation.')} ${warning.year}: ${escape(warning.original)}% → ${escape(warning.replacement)}%</p>`).join('')}
      <p class="analysis-note">${text(
        'Advanced：EBIT = EBITDA − D&A；修改 EBIT 會連動 EBITDA。FCFF = EBIT × (1 − 稅率) + D&A + 負數 CapEx − 營運資金增加。CFO 情境直接採 CFO + 負數 CapEx，不再加回 D&A；為與供應商 Levered 定義對照，仍採 WACC 折現及 EV 減淨債務，不冒稱獨立 FCFE／Ke 模型。營運稅率由 FMP EBIT 與稅後 EBIT 推導，不套用可能受一次性項目扭曲的歷史有效稅率。',
        'Advanced: EBIT = EBITDA - D&A; editing EBIT updates EBITDA. FCFF = EBIT × (1 - tax) + D&A + negative CapEx - increase in operating working capital. The CFO scenario uses CFO + negative CapEx, without adding D&A again. It retains WACC discounting and EV less net debt for comparison with vendor Levered definitions, not an independent FCFE/Ke model. Operating tax is implied by FMP EBIT and after-tax EBIT, rather than distorted historical effective taxes.')}</p>
      <p class="analysis-note">${text(
        '逐年 WACC 由股權／稅後債務成本與資本權重計算；修改 Beta、無風險利率或風險溢價會以 CAPM 更新該年的股權成本，亦可直接覆寫股權成本。每年折現因子連乘。終值增長率僅用於第十年後終值。現金比例僅展示預測餘額；EV 只減一次基期淨債務，不額外加上預測現金。負存貨或負稅率照來源標示，必須審視其適用性，未經獨立核實。',
        'Annual WACC uses equity/after-tax debt costs and capital weights; editing beta, risk-free rate or premium updates that year’s equity cost through CAPM, which can also be overridden directly. Annual discount factors compound. Terminal growth applies only beyond year ten. Cash ratios disclose projected balances only: EV subtracts snapshot net debt once, with no extra addition of projected cash. Negative inventory/tax inputs require review and are not independently certified.')}</p>
      <div class="table-scroll-wrapper"><table id="fmp-ten-year-inputs"><thead><tr><th>${text('假設／來源', 'Assumption / source')}</th>${scenario.years.map(item => `<th>${item.year}</th>`).join('')}</tr></thead><tbody>
        ${Scenario.activeFields(state.kind).map(([key, zh, en, min, max]) => `<tr><th>${escape(text(zh, en))}</th>${scenario.years.map((item, index) => `<td>
          <input aria-label="${escape(text(zh, en))} ${item.year}" data-scenario-key="${key}" data-scenario-year="${index}" type="number" step="any" min="${min}" max="${max}" required value="${finite(item.values[key]) ? item.values[key] : ''}">
          <small data-origin="${index}-${key}">${escape(origins[item.origins[key]] || item.origins[key])}</small></td>`).join('')}</tr>`).join('')}
      </tbody></table></div>
      <div class="fin-model-grid"><div class="form-group"><label for="fmp-terminal-growth">${text('第十年後終值增長率 (%)', 'Terminal growth after year ten (%)')}</label>
      <input id="fmp-terminal-growth" type="number" required step="any" min="-10" max="20" value="${scenario.terminalGrowth}"></div>
      <div class="form-group"><label for="fmp-snapshot-net-debt">${text('來源快照淨債務（可調整）', 'Snapshot net debt (editable)')} · ${escape(scenario.currency)}</label>
      <input id="fmp-snapshot-net-debt" type="number" required step="any" value="${scenario.netDebt}"></div></div>
      <p class="analysis-note">${text('調整終值增長率不會悄悄改寫已填好的十年增長率；需要時請逐年修改。', 'Changing terminal growth does not silently overwrite the ten populated annual growth inputs; edit those years explicitly if needed.')}</p>
      <button id="fmp-calculate" type="button" class="btn-save">${text('計算十年情境', 'Calculate ten-year scenario')}</button>
      <p id="fmp-status" role="status">${escape(result.reason ? reasonText(result.reason, state.language())
        : text('本站十年情境；不是 FMP 原始結果。可按「儲存目標價」一次計算並儲存。', 'Site-calculated ten-year scenario, not an FMP API result. Save target calculates and saves in one step.'))}</p>
      <div class="table-scroll-wrapper"><table id="fmp-ten-year-results"><thead><tr><th>${text('預測財年', 'Projected FY')}</th><th>${text('營收', 'Revenue')}</th><th>${state.kind === 'advanced' ? 'EBITDA' : 'CFO'}</th><th>CapEx</th>
        ${state.kind === 'advanced' ? `<th>${text('營運資金增加', 'Change in NWC')}</th><th>${text('現金餘額（僅展示）', 'Cash balance (disclosure)')}</th>` : ''}
        <th>${text('現金流', 'Cash flow')}</th><th>WACC</th><th>${text('現金流現值', 'PV cash flow')}</th></tr></thead><tbody>
      ${(result.result?.rows || []).map(row => `<tr><th>${row.year}</th><td>${money(row.revenue)}</td><td>${money(state.kind === 'advanced' ? row.ebitda : row.cfo)}</td><td>${money(row.capex)}</td>
        ${state.kind === 'advanced' ? `<td>${money(row.changeNwc)}</td><td>${money(row.projectedCash)}</td>` : ''}
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
    const local = state.mode === 'ten-year';
    const result = local ? scenarioValue() : value(data, kind, stock);
    const row = result.row || (!local ? first(data?.models?.[kind]?.data) : null);
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
    const officialCorrection = !!stock.balanceClassificationSource || !!stock.cashflowProvenance;
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
      ${officialCorrection ? `<p class="analysis-note" id="fmp-official-source-warning">${text(
        '財務報表頁已按官方資料更正現金流及／或流動與非流動分類，但本頁原生 API 結果及十年情境的 FMP 預設尚未據此重寫，並非已核實的官方預測。請審閱營運資金、現金、債務與現金流口徑後再保存目標價。',
        'The financial-statements page corrects cash flow and/or current/non-current classification using official sources. Native API results and the ten-year scenario’s FMP defaults have not been rewritten from those corrections and are not verified official forecasts. Review working capital, cash, debt and cash-flow definitions before saving a target.')}</p>` : ''}
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
      for (const field of Scenario.activeFields(kind)) {
        const control = box.querySelector(`[data-scenario-year="${index}"][data-scenario-key="${field[0]}"]`);
        if (control !== input) control.value = finite(item.values[field[0]]) ? item.values[field[0]] : '';
        box.querySelector(`[data-origin="${index}-${field[0]}"]`).textContent = item.origins[field[0]] === 'user'
          ? text('用戶修改', 'User override') : item.origins[field[0]] === 'capm' ? 'CAPM'
            : item.origins[field[0]] === 'derived' ? text('連動推導', 'Linked derivation')
              : item.origins[field[0]] === 'fmp' ? text('FMP 模型', 'FMP model')
                : item.origins[field[0]] === 'derived-fmp' ? text('FMP 推導', 'FMP-derived')
                  : item.origins[field[0]] === 'normalized-fmp-tax' ? text('標準化：採 FMP 列示稅率', 'Normalized: stated FMP tax') : text('標準延伸假設', 'Standard extension');
      }
      changed();
    }));
    for (const [id, key] of [['fmp-terminal-growth', 'terminalGrowth'], ['fmp-snapshot-net-debt', 'netDebt']]) {
      box.querySelector(`#${id}`)?.addEventListener('input', event => {
        state.scenarios[kind][key] = event.target.value.trim() ? event.target.valueAsNumber : null;
        changed();
      });
    }
    box.querySelector('#fmp-calculate')?.addEventListener('click', calculate);
    if (state.busy && box.querySelector('#fmp-calculate')) box.querySelector('#fmp-calculate').disabled = true;
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
    root.document.querySelector('[onclick="saveCustomModel()"]').disabled = true;
    status.textContent = state.language() === 'en' ? 'Calculating with FMP…' : '正在向 FMP 計算…';
    try {
      const response = await root.fetch(`/api/fmp?${query}`);
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('FMP_API_UNAVAILABLE');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP_${response.status}`);
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
  return { record, value, issuedShares, reference, compatible, load, save, reset, details, detailsError, reasonText,
    deactivate: () => { state = null; }, rerender: () => { if (state) render(); } };
});
