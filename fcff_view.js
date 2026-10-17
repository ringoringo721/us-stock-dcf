(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FcffView = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const compatible = saved => saved?.params?.modelVersion === 'fcff-v2'
    && !['fcf0', 'growth_10y'].some(key => Object.prototype.hasOwnProperty.call(saved.params, key));
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const amount = value => finite(value) ? value.toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  }) : 'N/A';
  const percent = value => finite(value) ? `${(value * 100).toFixed(2)}%` : 'N/A';
  const reasons = {
    sourceUnavailable: ['FMP 來源不完整，無法重建估值。', 'Required FMP sources are unavailable.'],
    sourceSymbolMismatch: ['來源股票代碼不一致。', 'Source ticker symbols do not match.'],
    missingQuote: ['缺少有效美元報價或總市值。', 'A valid USD quote and market capitalization are required.'],
    sourceDateMismatch: ['來源日期無效、未公布或不一致。', 'Source dates are invalid, unpublished or inconsistent.'],
    incompleteTtm: ['缺少四個連續且對齊的季度。', 'Four consecutive, aligned fiscal quarters are required.'],
    sourceCurrencyMismatch: ['財報幣別不一致。', 'Statement reporting currencies do not match.'],
    missingFx: ['缺少期間對應的美元匯率。', 'Period-matched historical USD exchange rates are missing.'],
    missingForecastFx: ['缺少足夠近期的預測換匯基準。', 'A sufficiently recent forecast FX observation is missing.'],
    forecastCurrencyScaleUnverified: ['分析師預測幣別／金額單位未能與歷史年度對齊。', 'Analyst forecast currency/scale could not be reconciled with historical annual revenue.'],
    missingAnalystAnchors: ['缺少連續且有效的分析師營收／EBIT 預測。', 'Valid consecutive analyst revenue/EBIT anchors are missing.'],
    incompleteYearToDate: ['本財年已公布季度不完整。', 'Current fiscal-year reported quarters are incomplete.'],
    requiresSegmentValuation: ['此公司需要金融／分部估值，不適用一般企業 FCFF。', 'This company requires financial or segment valuation, not the general corporate FCFF model.'],
    debtCompositionUnverified: ['借款與租賃負債組成未能核對。', 'Borrowings and lease debt composition could not be reconciled.'],
    leaseClassificationRequired: ['租賃付款、折舊與新增租賃資產尚未核對；不猜測調整金額。', 'Lease payments, depreciation and new leased assets are not reconciled; no adjustment is guessed.'],
    leaseMappingUnverified: ['原始財報有租賃負債，但標準化欄位為零，須先核對映射。', 'Original statements contain lease liabilities but the normalized field is zero; mapping requires reconciliation.'],
    missingParameters: ['請補入空白的必要假設；不使用隱藏預設值。', 'Enter missing required assumptions; no hidden defaults are used.'],
    invalidParameters: ['參數超出有效範圍，或租賃調整超過對應負債。', 'Parameters are out of range or the lease adjustment exceeds the corresponding liability.'],
    invalidTerminalSpread: ['WACC 必須大於終值增長率且大於零。', 'WACC must exceed terminal growth and zero.'],
    invalidTerminalReinvestment: ['終值 ROIC 必須為正且不低於終值增長率。', 'Terminal ROIC must be positive and at least terminal growth.'],
    invalidOperatingAssumptions: ['營運假設無效；請核對資本支出、折舊及長期利潤率。', 'Invalid operating assumptions; check capital expenditure, depreciation and terminal margin.'],
    forecastConflictsWithActual: ['本年度預測低於已公布營收、折舊或資本支出；請調整年度假設。', 'The annual forecast is below reported revenue, D&A or capex; adjust the annual assumptions.'],
    incompatibleSavedModel: ['舊版模型不能直接轉作新版十財年／年中折現模型。', 'A legacy model cannot be reinterpreted as the new ten-fiscal-year / mid-year model.'],
    invalidForecastOverrides: ['年度假設無效或互相衝突。', 'Annual driver inputs are invalid or conflicting.'],
    staleSavedPeriods: ['已儲存情境的財年已過期；請重設或重新建立年度假設。', 'Saved fiscal periods are outside the current horizon; reset or rebuild annual assumptions.'],
    statementDateMismatch: ['資產負債表與 TTM 結束日不一致。', 'Balance-sheet and TTM closing dates do not match.'],
    missingCurrentPeriod: ['缺少本財年的累計實績。', 'Current fiscal-year actuals are missing.'],
    invalidCurrentPeriod: ['本財年預測期間無法對齊。', 'The current fiscal-year forecast period cannot be aligned.'],
    invalidSource: ['估值來源格式或日期無效。', 'Invalid valuation source format or dates.'],
    invalidForecastGrowth: ['模型推算增長率無效。', 'Invalid extrapolated growth.'],
    invalidForecastHorizon: ['無法建立完整十年預測期間。', 'A complete ten-year forecast horizon could not be constructed.'],
    invalidCalculation: ['計算產生非有限值。', 'The calculation produced a nonfinite value.']
  };
  function reasonText(reason, language) {
    const pair = reasons[reason];
    return pair ? pair[language === 'en' ? 1 : 0]
      : (language === 'en' ? 'Valuation unavailable: ' : '估值不可用：') + reason;
  }
  function metrics(stock, snapshot, result) {
    const defaults = snapshot?.defaults || {};
    const mcap = finite(stock.mcap) ? stock.mcap : finite(result.E) ? result.E : null;
    const premiumPct = finite(result.fairVal) && result.fairVal > 0 && finite(stock.price) && stock.price > 0
      ? (stock.price / result.fairVal - 1) * 100 : null;
    const cash = result.cash ?? defaults.cash, debt = result.reportedDebt ?? defaults.debt;
    const net = finite(result.NetDebt) ? result.NetDebt : null;
    const ev = finite(net) && finite(mcap) && finite(result.preferred)
      && finite(result.minority) && finite(result.investments)
      ? mcap + net + result.preferred + result.minority - result.investments : null;
    const ebitda = snapshot?.ttm?.ebitda, fcf = snapshot?.ttm?.reportedFcf;
    const ratio = (a, b, scale = 1) => finite(a) && finite(b) && b > 0 ? a / b * scale : null;
    return {
      ...result, premiumPct, mcap, EV: ev, localFCF0: fcf, localDebt: debt, localCash: cash,
      isUndervalued: premiumPct === null ? null : premiumPct < 0,
      fcf_to_ev: ratio(fcf, ev, 100), fcf_to_mcap: ratio(fcf, mcap, 100),
      ev_to_ebitda: ratio(ev, ebitda), debt_to_ebitda: ratio(debt, ebitda),
      net_debt_to_ebitda: ratio(net, ebitda),
      div_yield: stock.div_yield, f_score: stock.f_score,
      f_score_breakdown: stock.f_score_breakdown || []
    };
  }

  const fields = [
    ['price', '股價 ($)', 'Share price ($)'],
    ['shares', '估值股數 (百萬股；總市值／股價)', 'Valuation shares (M; market cap / price)'],
    ['debt', '帳面總債務（含已列租賃，$M）', 'Reported total debt (including reported leases, $M)'],
    ['leaseOverlap', '已在 FCFF 承擔的對應租賃負債 ($M)', 'Matching lease debt already borne by FCFF ($M)'],
    ['cash', '非營運現金及短期投資 ($M)', 'Nonoperating cash and short-term investments ($M)'],
    ['investments', '非營運長期投資 ($M；帳面值代理)', 'Nonoperating long-term investments ($M; book proxy)'],
    ['preferred', '優先股權益 ($M；帳面值代理)', 'Preferred equity ($M; book proxy)'],
    ['minority', '非控制權益 ($M；帳面值代理)', 'Noncontrolling interests ($M; book proxy)'],
    ['rf', '無風險利率 (%)；10 年美債來源值', 'Risk-free rate (%); sourced 10Y Treasury'],
    ['erp', '股權風險溢價 (%)；模型假設', 'Equity risk premium (%); model assumption'],
    ['beta', 'Beta（預設：FMP；年期未明）', 'Beta (default: FMP; lookback unspecified)'],
    ['kd', '稅前債務成本 (%)；TTM 歷史利息代理', 'Pretax debt cost (%); TTM historical interest proxy'],
    ['tax', '稅率 (%)；TTM 有效稅率起點', 'Tax rate (%); starting from TTM effective tax'],
    ['g', '終值增長率 (%)；模型假設', 'Terminal growth (%); model assumption'],
    ['terminalRoic', '長期 ROIC (%)；空白＝WACC', 'Terminal ROIC (%); blank = WACC', 'nullable'],
    ['preferredCost', '優先股成本 (%)；空白＝Ke 代理', 'Preferred cost (%); blank = common Ke proxy', 'nullable'],
    ['minorityCost', '非控制權益成本 (%)；空白＝Ke 代理', 'Noncontrolling cost (%); blank = common Ke proxy', 'nullable'],
    ['terminalMargin', '長期 EBIT 利潤率 (%)；起點為 TTM', 'Terminal EBIT margin (%); starts at TTM', 'ratio'],
    ['depreciation', '折舊攤銷／營收 (%)；TTM 後備比率', 'D&A / revenue (%); TTM fallback ratio', 'ratio'],
    ['capex', '資本支出／營收 (%)；TTM', 'Capital expenditure / revenue (%); TTM', 'ratio'],
    ['workingCapital', '非現金營運資金／營收 (%)；TTM 營收與期末餘額', 'Noncash NWC / revenue (%); TTM revenue and closing balance', 'ratio'],
    ['ebitdaMargin', '模型後段 EBITDA 利潤率 (%)；營業 EBIT＋現金流 D&A', 'Extrapolated EBITDA margin (%); operating EBIT + cash-flow D&A', 'ratio'],
    ['forecastGrowth', '模型後段營收增長 (%)；獨立於終值 g', 'Extrapolated revenue growth (%); separate from terminal g'],
    ['discountRate', '自訂 WACC (%)；空白＝資本成本加權', 'Override WACC (%); blank = weighted capital costs', 'nullableRatio'],
    ['terminalEbitdaMargin', '終值 EBITDA 利潤率 (%)；空白＝EBIT 利潤率＋D&A 比率', 'Terminal EBITDA margin (%); blank = EBIT margin + D&A rate', 'optionalRatio'],
    ['terminalDepreciation', '終值 D&A／營收 (%)；空白＝一般 D&A 比率', 'Terminal D&A / revenue (%); blank = general D&A rate', 'optionalRatio'],
    ['terminalCapex', '終值 CapEx／營收 (%)；空白＝一般 CapEx 比率', 'Terminal capex / revenue (%); blank = general capex rate', 'optionalRatio'],
    ['terminalWorkingCapital', '終值 NWC／營收 (%)；空白＝一般 NWC 比率', 'Terminal NWC / revenue (%); blank = general NWC rate', 'optionalRatio']
  ];
  let context = null;
  let yearEdits = {}, assumptionTab = 'revenue', supportTab = 'cashflow';
  const driverTabs = [
    ['revenue', '營收與 EBITDA', 'Revenue & EBITDA'], ['capex', '資本支出', 'CapEx'],
    ['workingCapital', '營運資金', 'Working capital'], ['depreciation', '折舊攤銷', 'D&A'],
    ['tax', '稅率', 'Tax rate'], ['discount', '折現率', 'Discount rate'], ['terminal', '終值', 'Terminal value']
  ];
  const supportTabs = [
    ['cashflow', '企業自由現金流', 'Unlevered cash flow'], ['periods', '折現期間', 'Discounting periods'],
    ['factors', '折現因子', 'Discount factors'], ['enterprise', '企業價值', 'Enterprise value'],
    ['equity', '股權價值橋接', 'Equity waterfall'], ['history', '歷史財務', 'Historical financials'],
    ['multiples', '目前交易倍數', 'Current trading multiples']
  ];
  const text = (zh, en) => context.language() === 'en' ? en : zh;
  function snapshot() { return window.FCFF_DATA?.stocks?.[context.ticker]; }
  function readScenario() {
    const scenario = { modelVersion: 'fcff-v2', years: structuredClone(yearEdits) };
    for (const [key, , , mode] of fields) {
      const input = document.getElementById(`fcff-${key}`);
      const value = input.value.trim() === '' ? null : Number(input.value);
      if (mode === 'optionalRatio' && value === null) continue;
      scenario[key] = ['ratio', 'nullableRatio', 'optionalRatio'].includes(mode) && value !== null ? value / 100 : value;
    }
    for (const key of ['terminalMethod', 'discountTiming', 'depreciationBasis', 'extrapolation']) {
      scenario[key] = document.getElementById(`fcff-${key}`).value;
    }
    return scenario;
  }
  function load(options) {
    context = options;
    const source = snapshot();
    const saved = compatible(options.saved) ? options.saved.params : {};
    const scenario = compatible({ params: options.stock.fcffScenario }) ? options.stock.fcffScenario : saved;
    yearEdits = structuredClone(scenario.years || {});
    const ratios = window.Fcff.operatingRatios(source?.ttm);
    const defaults = { ...source?.defaults, ...ratios,
      terminalMargin: ratios?.operatingMargin,
      ebitdaMargin: ratios ? ratios.operatingMargin + ratios.depreciation : null, ...scenario };
    const panel = document.getElementById('fcff-workspace');
    panel.hidden = false;
    panel.innerHTML = `<section class="panel historical-ratio-panel">
      <div class="panel-title">FCFF · ${text('十財年營運驅動模型', 'Ten-fiscal-year operating-driver model')}</div>
      <p id="fcff-source-note" class="analysis-note"></p>
      <p id="fcff-status" class="model-reference-note" role="status"></p>
      <p id="fcff-legacy" class="analysis-note"></p>
      <details><summary>${text('來源、代理值與假設說明', 'Source, proxy and assumption disclosures')}</summary>
        <p id="fcff-assumptions" class="analysis-note"></p>
      </details>
      <details id="fcff-input-controls"><summary>${text('調整假設（美元百萬；除每股／百分比）', 'Edit assumptions (USD millions, except per-share / percentages)')}</summary>
        <div class="fcff-inputs">${fields.map(([key, zh, en, mode]) => {
          const value = ['ratio', 'nullableRatio', 'optionalRatio'].includes(mode) && finite(defaults[key]) ? defaults[key] * 100 : defaults[key];
          return `<div class="form-group"><label for="fcff-${key}">${escape(text(zh, en))}</label>
            <input type="number" id="fcff-${key}" step="any" value="${finite(value) ? value : ''}"
              ${!source?.ttm ? 'disabled' : ''}></div>`;
        }).join('')}</div></details>
      <div class="fcff-inputs" id="fcff-method-controls"></div>
    </section>
    <section class="panel historical-ratio-panel">
      <div class="panel-title">${text('分項年度假設', 'Annual operating assumptions')}</div>
      <div id="fcff-driver-tabs" class="fcff-tabs" role="group" aria-label="${text('假設分類', 'Assumption categories')}"></div>
      <p class="analysis-note">${text(
        '所有金額為美元百萬。藍色欄位可修改，離開欄位後重算；清空年度欄位會恢復該項來源／模型假設。畫面取位不改變計算精度。完整財年數值並非未來已知現金流；年度營收、EBITDA、比率可分開調整。',
        'All amounts are USD millions. Blue fields are editable and recalculate on blur; clearing an annual field restores its source/model default. Display rounding does not change calculation precision. Full-year projections are not known future cash flows; revenue, EBITDA and ratios can be edited separately.')}</p>
      <div id="fcff-driver-detail"></div>
    </section>
    <section class="panel historical-ratio-panel">
      <div class="panel-title">${text('支持計算', 'Supporting calculations')}</div>
      <div id="fcff-support-tabs" class="fcff-tabs" role="group" aria-label="${text('計算分類', 'Calculation categories')}"></div>
      <p class="analysis-note">${text(
        'EBIT＝EBITDA－D&A；FCFF＝EBIT ×（1－稅率）＋D&A－CapEx－NWC 增加。先扣除本財年已公布實績，再按日均分未公布期間並剔除估值日前部分。首期僅餘下現金流，終值於第十財年期末折現。',
        'EBIT = EBITDA − D&A; FCFF = EBIT × (1 − tax) + D&A − capex − increase in NWC. Reported fiscal YTD is removed first; unreported flows are allocated uniformly by day and the elapsed portion is excluded. The first cash flow is a remaining-period stub; terminal value is discounted at the tenth fiscal year-end.')}</p>
      <div class="table-scroll-wrapper" id="fcff-support-cashflow"><table id="fcff-table"></table></div>
      <div class="table-scroll-wrapper" id="fcff-support-equity" hidden><table><tbody id="fcff-bridge"></tbody></table></div>
      <div id="fcff-support-other" hidden></div>
      <p id="fcff-terminal-note" class="analysis-note"></p>
    </section>
    <section class="panel historical-ratio-panel">
      <div class="panel-title">${text('敏感度：WACC 與終值增長率', 'Sensitivity: WACC and terminal growth')}</div>
      <p class="analysis-note">${text('每一格重跑相同 FCFF 模型；ROIC 空白時隨該格 WACC 變動，不套用隱藏利差下限。', 'Every cell reruns the same FCFF model. A blank ROIC follows that cell’s WACC; no hidden spread floor is applied.')}</p>
      <div class="table-scroll-wrapper"><table id="fcff-sensitivity"></table></div>
    </section>`;
    const choices = [
      ['terminalMethod', '終值現金流方法', 'Terminal cash-flow method', [
        ['roic', 'ROIC 再投資（預設＝WACC）', 'ROIC reinvestment (default = WACC)'],
        ['components', '正規化營運分項', 'Normalized operating components']]],
      ['discountTiming', '折現時點', 'Cash-flow timing', [
        ['midYear', '剩餘期間中點（年中慣例）', 'Midpoint of remaining period'],
        ['periodEnd', '期末', 'Period end']]],
      ['depreciationBasis', '年度 D&A 起點', 'Annual D&A starting basis', [
        ['analystSpread', '分析師差額／TTM 後備', 'Analyst spread / TTM fallback'],
        ['ttm', '全部使用 TTM／自訂比率', 'TTM / custom ratio only']]],
      ['extrapolation', '分析師預測之後', 'Beyond analyst coverage', [
        ['fade', '增長與利潤率過渡至長期假設', 'Fade to long-term assumptions'],
        ['flat', '維持最後分析師年度規模／利潤率', 'Flat final-year scale / margin']]]
    ];
    document.getElementById('fcff-method-controls').innerHTML = choices.map(([key, zh, en, items]) =>
      `<div class="form-group"><label for="fcff-${key}">${text(zh, en)}</label>
      <select id="fcff-${key}">${items.map(([option, a, b]) => `<option value="${option}" ${defaults[key] === option ? 'selected' : ''}>${text(a, b)}</option>`).join('')}</select></div>`).join('');
    for (const input of panel.querySelectorAll('input')) input.addEventListener('input', recalculate);
    for (const select of panel.querySelectorAll('select')) select.addEventListener('change', recalculate);
    renderTabs();
    document.getElementById('fcff-legacy').textContent = options.saved && !compatible(options.saved)
      ? text('舊版自訂目標價已保留，但舊版參數不會套入新的十財年模型；儲存新情境前將封存舊紀錄。',
        'Your legacy target is retained, but earlier inputs are not applied to the ten-fiscal-year model. Saving a new scenario archives the previous record.')
      : '';
    recalculate();
  }
  function rerender() {
    if (!context) return;
    context.stock.fcffScenario = readScenario();
    load(context);
  }
  function recalculate() {
    if (!context) return null;
    const source = snapshot(), scenario = readScenario();
    context.stock.fcffScenario = scenario;
    const result = window.Fcff.calculate(source, scenario);
    const ttm = source?.ttm;
    document.getElementById('fcff-source-note').textContent = [
      context.ticker, 'USD', source?.valuationDate,
      source?.quoteDate && `${text('報價日期', 'Quote date')}: ${source.quoteDate}`,
      ttm && `TTM ${ttm.dates[0]} — ${ttm.dates.at(-1)}`,
      source?.provenance?.treasury && `10Y Treasury ${source.provenance.treasury.date}`
    ].filter(Boolean).join(' · ');
    document.getElementById('fcff-assumptions').textContent = [
      text('股數＝總市值／股價，不是歷史加權稀釋股數。', 'Shares = market cap / price, not historical diluted weighted-average shares.'),
      text('營運比率採最新 TTM；現金及投資視作非營運資產，優先股及非控制權益採可調整帳面值代理。', 'Operating ratios use latest TTM; cash/investments are assumed nonoperating and priority claims use adjustable book-value proxies.'),
      source?.provenance?.forecastFx && `${text('未來匯率固定於', 'Future FX fixed at')} ${source.provenance.forecastFx.observationDate || source.valuationDate}: ${source.provenance.forecastFx.rate}`,
      text('分析師幣別以歷史年度金額尺度核對，非 API 明示幣別；稅率與 Kd 是歷史代理，ERP 與 g 是模型假設。', 'Analyst currency is inferred from historical annual scale, not an explicit API currency field; tax and Kd are historical proxies, ERP and g are model assumptions.'),
      text('EBITDA 缺值時使用分析師 EBIT＋模型 D&A；D&A 可由分析師 EBITDA－EBIT 推導，兩者均非獨立現金流預測。本財年累計營運 EBITDA＝實際營業 EBIT＋現金流 D&A，未獨立認證與分析師調整口徑一致。', 'Missing EBITDA uses analyst EBIT + modeled D&A; D&A can be derived from analyst EBITDA − EBIT, neither being independent cash-flow consensus. YTD operating EBITDA = reported operating EBIT + cash-flow D&A; comparability with analyst-adjusted definitions is not independently certified.'),
      text('預估稅項＝EBIT × 情境稅率；虧損會產生假設稅益，未另建稅損抵扣／遞延稅模型，不代表已知退稅。', 'Pro forma tax = EBIT × scenario tax rate; losses imply assumed tax benefits. No separate NOL/deferred-tax schedule is modeled and refunds are not known actuals.'),
      text('Beta 預設來自 FMP Profile，回應未明示年期／頻率／基準；手動修改均屬使用者情境，不是 FMP 預測。', 'Default beta comes from FMP Profile; lookback/frequency/benchmark are unspecified. Manual edits are user scenarios, not FMP forecasts.'),
      text('租賃付款已在 FCFF 承擔時，只排除對應負債；WACC 與股權橋接使用相同債務口徑。', 'Only matching lease claims already borne by FCFF are excluded; WACC and the equity bridge use identical financing debt.')
    ].filter(Boolean).join(' · ');
    document.getElementById('fcff-status').textContent = result.reason
      ? reasonText(result.reason, context.language()) + (result.annuals?.length
        ? text(' 可用年度數據僅供建立假設，不代表估值已核准。', ' Available annual projections are a draft, not a validated valuation.') : '')
      : text('分析師錨點以外均為模型推算，不是已知未來現金流。', 'Beyond analyst anchors, values are model extrapolations, not known future cash flow.');
    document.getElementById('det-res-fair').textContent = finite(result.fairVal) ? `$${amount(result.fairVal)}` : 'N/A';
    document.getElementById('det-res-fair').className = `stat-num ${result.fairVal === null
      ? 'text-muted' : result.fairVal < 0 ? 'text-red' : 'text-green'}`;
    const displayedPrice = finite(scenario.price) ? scenario.price : context.stock.price;
    document.getElementById('det-res-price').textContent = finite(displayedPrice) ? `$${amount(displayedPrice)}` : 'N/A';
    document.getElementById('det-res-wacc').textContent = percent(result.WACC);
    document.getElementById('det-res-g').textContent = finite(scenario.g) ? `${scenario.g.toFixed(2)}%` : 'N/A';
    document.getElementById('det-res-spread').textContent = finite(result.WACC) && finite(scenario.g)
      ? percent(result.WACC - scenario.g / 100) : 'N/A';
    const ratios = metrics({ ...context.stock, mcap: result.E }, source, result);
    document.getElementById('det-res-ev').textContent = finite(ratios.EV) ? `$${amount(ratios.EV)} M` : 'N/A';
    document.getElementById('det-res-evebitda').textContent = finite(ratios.ev_to_ebitda) ? `${ratios.ev_to_ebitda.toFixed(1)}x` : 'N/A';
    document.getElementById('det-res-nde').textContent = finite(ratios.net_debt_to_ebitda) ? `${ratios.net_debt_to_ebitda.toFixed(2)}x` : 'N/A';
    const premium = result.premiumPct;
    const badge = document.getElementById('det-badge');
    badge.className = finite(premium) ? `badge badge-${premium < 0 ? 'undervalued' : 'overvalued'}` : 'badge';
    badge.textContent = finite(premium) ? `${premium < 0 ? '' : '+'}${premium.toFixed(1)}%` : 'N/A';
    document.getElementById('det-res-premium').textContent = badge.textContent;
    document.getElementById('det-res-status').textContent = result.reason
      ? reasonText(result.reason, context.language())
      : finite(premium) ? text('目前情境的模型估值，非投資建議。', 'Model value for this scenario, not investment advice.')
        : text('普通股權模型值非正數；不計算溢價百分比。', 'Modeled common equity is nonpositive; no premium percentage is calculated.');
    document.querySelector('[onclick="saveCustomModel()"]').disabled = result.fairVal === null;
    renderTable(result);
    renderBridge(result);
    renderSensitivity(source, scenario, result);
    renderDriver(result);
    renderSupport(result);
    return result;
  }
  function renderTabs() {
    for (const [id, items, active] of [
      ['fcff-driver-tabs', driverTabs, assumptionTab], ['fcff-support-tabs', supportTabs, supportTab]
    ]) {
      const container = document.getElementById(id);
      container.innerHTML = items.map(([key, zh, en]) =>
        `<button type="button" data-tab="${key}" aria-pressed="${key === active}">${text(zh, en)}</button>`).join('');
      for (const button of container.querySelectorAll('button')) button.addEventListener('click', () => {
        if (id === 'fcff-driver-tabs') assumptionTab = button.dataset.tab;
        else supportTab = button.dataset.tab;
        renderTabs();
        recalculate();
      });
    }
  }
  function schedule(headers, rows) {
    return `<div class="table-scroll-wrapper"><table><thead><tr>${headers.map(header =>
      `<th>${escape(header)}</th>`).join('')}</tr></thead><tbody>${rows.map(([label, values]) =>
      `<tr><th>${label}</th>${values.map(value => `<td>${value}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function sourceLabel(kind) {
    return {
      analyst: text('FMP 分析師預測', 'FMP analyst estimate'),
      model: text('模型推算', 'Modeled'),
      user: text('使用者情境', 'User scenario'),
      analystEbitPlusModelDa: text('分析師 EBIT＋模型 D&A（非直接 EBITDA 預測）', 'Analyst EBIT + modeled D&A (not direct EBITDA consensus)'),
      analystSpread: text('分析師 EBITDA－EBIT（推導，非獨立 D&A 預測）', 'Analyst EBITDA − EBIT (derived, not independent D&A consensus)')
    }[kind] || 'N/A';
  }
  function scenarioCases(result) {
    if (result.reason) return [null, result, null];
    const input = readScenario();
    return [
      window.Fcff.calculate(snapshot(), { ...input, discountRate: result.WACC + 0.005, g: input.g - 0.5 }),
      result,
      window.Fcff.calculate(snapshot(), { ...input, discountRate: result.WACC - 0.005, g: input.g + 0.5 })
    ];
  }
  function caseTable(result, rows) {
    const cases = scenarioCases(result);
    return schedule([text('項目', 'Item'), text('較低估值', 'Lower value'), text('基準', 'Base'), text('較高估值', 'Higher value')],
      rows.map(([label, key, format = amount]) => [label, cases.map(item => format(item?.[key]))]));
  }
  function renderDriver(result) {
    const detail = document.getElementById('fcff-driver-detail');
    if (assumptionTab === 'discount') {
      detail.innerHTML = `<p class="analysis-note">${text(
        '預設以 CAPM 及一致債務口徑計算 WACC，也可在「調整假設」輸入自訂 WACC。較低／較高估值同時變動 WACC ±0.5 個百分點及 g ∓0.5 個百分點，屬模型情境範圍，不是機率信賴區間。',
        'Default WACC uses CAPM and the same financing debt as the equity bridge; a custom WACC can be entered under Edit assumptions. Lower/higher cases change WACC by ±0.5 percentage points and g by ∓0.5 points together. This is an assumption range, not a statistical confidence interval.')}</p>` +
        caseTable(result, [[text('WACC', 'WACC'), 'WACC', percent], ['Ke', 'Ke', percent],
          [text('稅後債務成本', 'After-tax debt cost'), 'Kd_after', percent],
          [text('普通股資本權重', 'Common equity weight'), 'wE', percent],
          [text('融資債務權重', 'Financing debt weight'), 'wD', percent],
          [text('每股價值 ($)', 'Value per share ($)'), 'fairVal']]);
      return;
    }
    if (assumptionTab === 'terminal') {
      detail.innerHTML = `<p class="analysis-note">${text(
        '保留 ROIC 再投資法（預設 ROIC＝WACC），也可選擇正規化營運分項法。終值營收＝第十財年營收 ×（1＋g），只加一次成長；分項法另算 D&A、CapEx 及新增 NWC，不能假設成長不需投資。',
        'The ROIC reinvestment method remains available (default ROIC = WACC); normalized operating components are an alternative. Terminal revenue equals year-ten revenue × (1 + g), applying growth only once. The component method models D&A, capex and incremental NWC separately; growth must not be assumed costless.')}</p>` +
        caseTable(result, [
          [text('下一年營收', 'Next-year revenue'), 'terminalRevenue'],
          ['EBITDA', 'terminalEbitda'], ['D&A', 'terminalDepreciation'], ['EBIT', 'terminalEbit'],
          [text('稅項', 'Tax'), 'terminalTax'], ['NOPAT', 'terminalNopat'],
          [text('分項 CapEx（ROIC 法不使用）', 'Component capex (unused by ROIC method)'), 'terminalCapex'],
          [text('分項 NWC 增加（ROIC 法不使用）', 'Component NWC increase (unused by ROIC method)'), 'terminalNwcChange'],
          [text('採用之淨再投資', 'Applied net reinvestment'), 'terminalReinvestment'],
          ['FCFF', 'terminalFcff'], [text('終值折現年數', 'Terminal discount years'), 'terminalTime'],
          [text('終值折現因子', 'Terminal discount factor'), 'terminalDf', value => finite(value) ? value.toFixed(6) : 'N/A'],
          [text('終值現值', 'Terminal present value'), 'pvTV']
        ]);
      return;
    }
    const annuals = result.annuals || [];
    const editRow = (label, key, getter, ratio, pair) => [label, annuals.map(row => {
      const inputValue = getter(row);
      return `<input class="fcff-year-input" type="number" step="any" data-end="${row.end}" data-key="${key}"
        data-ratio="${ratio ? 'true' : 'false'}" data-pair="${pair || ''}"
        aria-label="${escape(label)} ${row.end}" title="${finite(inputValue) ? inputValue : ''}"
        value="${finite(inputValue) ? Number(inputValue.toFixed(ratio ? 4 : 2)) : ''}">`;
    })];
    const rows = {
      revenue: [
        editRow(text('營收', 'Revenue'), 'revenue', row => row.revenue, false, 'revenueGrowth'),
        editRow(text('營收增長 (%)', 'Revenue growth (%)'), 'revenueGrowth', row => row.revenueGrowth * 100, true, 'revenue'),
        [text('營收來源', 'Revenue source'), annuals.map(row => sourceLabel(row.sources.revenue))],
        editRow('EBITDA', 'ebitda', row => row.ebitda, false, 'ebitdaMargin'),
        editRow(text('EBITDA 利潤率 (%)', 'EBITDA margin (%)'), 'ebitdaMargin', row => row.ebitda / row.revenue * 100, true, 'ebitda'),
        [text('EBITDA 來源', 'EBITDA source'), annuals.map(row => sourceLabel(row.sources.ebitda))]
      ],
      capex: [editRow('CapEx', 'capex', row => row.capex, false, 'capexRate'),
        editRow(text('CapEx／營收 (%)', 'Capex / revenue (%)'), 'capexRate', row => row.capex / row.revenue * 100, true, 'capex')],
      workingCapital: [editRow(text('期末非現金 NWC', 'Closing noncash NWC'), 'workingCapital', row => row.workingCapital, false, 'workingCapitalRate'),
        editRow(text('NWC／營收 (%)', 'NWC / revenue (%)'), 'workingCapitalRate', row => row.workingCapital / row.revenue * 100, true, 'workingCapital')],
      depreciation: [editRow('D&A', 'depreciation', row => row.depreciation, false, 'depreciationRate'),
        editRow(text('D&A／營收 (%)', 'D&A / revenue (%)'), 'depreciationRate', row => row.depreciation / row.revenue * 100, true, 'depreciation'),
        [text('D&A 來源', 'D&A source'), annuals.map(row => sourceLabel(row.sources.depreciation))]],
      tax: [editRow(text('預測有效稅率 (%)', 'Forecast effective tax (%)'), 'tax', row => row.tax, false),
        [text('完整財年稅項', 'Full-year tax expense'), annuals.map(row => amount(row.ebit * row.tax / 100))]]
    }[assumptionTab];
    detail.innerHTML = annuals.length ? schedule([text('完整財年', 'Full fiscal year'), ...annuals.map(row => row.end)], rows)
      : `<p class="analysis-note">${escape(reasonText(result.reason, context.language()))}</p>`;
    if (assumptionTab === 'revenue' && result.assumptions?.revenueReference) {
      const reference = result.assumptions.revenueReference;
      const note = document.createElement('p');
      note.className = 'analysis-note';
      note.textContent = `${text('首年增長比較基準', 'First-year growth reference')}: ${reference.date || 'N/A'} · $${amount(reference.revenue)} M · ${
        reference.source === 'reportedAnnual' ? text('已報告年度營收（按預測匯率對齊）', 'Reported annual revenue (forecast FX basis)')
          : text('前一年度分析師營收；不是已公布實績', 'Prior-year analyst revenue; not reported actuals')}.`;
      detail.append(note);
    }
    const history = snapshot()?.history;
    const annualHistory = history?.annual || [];
    if (assumptionTab === 'workingCapital') {
      const quarters = (history?.quarterly || []).slice(-4);
      detail.innerHTML += `<p class="analysis-note">${text(
        '非現金 NWC＝流動資產－現金及短期投資－流動負債＋流動借款及列示流動租賃。每個季度餘額除以同季度結束的 LTM 營收，並非四季餘額相加；負 NWC 減少會增加 FCFF。租賃／債務未核對時，這些數字只作暫定財務支持。',
        'Noncash NWC = current assets − cash/short-term investments − current liabilities + current borrowings and reported current leases. Each balance uses its own matching LTM revenue, not summed quarterly balances. A fall in NWC increases FCFF. Unreconciled lease/debt inputs remain provisional support, not a validated valuation.')}</p>` +
        schedule([text('季度', 'Quarter'), ...quarters.map(row => row.date)], [
          [text('流動資產', 'Current assets'), quarters.map(row => amount(row.currentAssets))],
          [text('現金及短期投資', 'Cash / short-term investments'), quarters.map(row => amount(row.cash))],
          [text('流動負債', 'Current liabilities'), quarters.map(row => amount(row.currentLiabilities))],
          [text('流動借款及列示租賃', 'Current debt and reported leases'), quarters.map(row => amount(row.currentDebt))],
          ['NWC', quarters.map(row => amount(row.workingCapital))],
          [text('對應 LTM 營收', 'Matching LTM revenue'), quarters.map(row => amount(row.ltmRevenue))],
          [text('NWC／LTM 營收', 'NWC / LTM revenue'), quarters.map(row => percent(row.workingCapitalRate))]
        ]);
      if (quarters.length === 4 && quarters.every(row => finite(row.workingCapitalRate))) {
        addAverageControl(detail, 'workingCapital', quarters.map(row => row.workingCapitalRate), true);
      }
    } else if (['capex', 'depreciation', 'tax'].includes(assumptionTab)) {
      const key = assumptionTab;
      const observed = annualHistory.map(row => key === 'tax' ? row.tax
        : finite(row[key]) && row.revenue > 0 ? row[key] / row.revenue : null);
      detail.innerHTML += schedule([text('實際可用年度', 'Available reported years'), ...annualHistory.map(row => row.date)], [
        [key === 'tax' ? text('有效稅率', 'Effective tax') : key === 'capex' ? 'CapEx' : 'D&A',
          annualHistory.map(row => key === 'tax' ? finite(row.tax) ? `${amount(row.tax)}%` : 'N/A' : amount(row[key]))],
        [text('營收', 'Revenue'), annualHistory.map(row => amount(row.revenue))],
        ...(key === 'tax' ? [] : [[text('佔營收比率', 'Ratio to revenue'), observed.map(percent)]])
      ]);
      if (observed.some(finite)) addAverageControl(detail, key, observed.filter(finite), false);
    }
    for (const input of detail.querySelectorAll('.fcff-year-input')) input.addEventListener('change', () => {
      const { end, key, pair, ratio } = input.dataset;
      const edit = yearEdits[end] || {};
      if (input.value.trim() === '') delete edit[key];
      else {
        edit[key] = Number(input.value) / (ratio === 'true' ? 100 : 1);
        if (pair) delete edit[pair];
      }
      if (Object.keys(edit).length) yearEdits[end] = edit;
      else delete yearEdits[end];
      recalculate();
    });
  }
  function addAverageControl(detail, key, values, quarterly) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const note = document.createElement('p');
    note.className = 'analysis-note';
    note.textContent = quarterly ? text('最近四季各自 NWC／LTM 營收比率的簡單平均', 'Simple average of four matching quarterly NWC/LTM ratios')
      : text(`實際可用 ${values.length} 個年度比率的簡單平均（不補缺值）`, `Simple average of ${values.length} available annual ratios (no gap filling)`);
    note.textContent += `: ${key === 'tax' ? amount(mean) + '%' : percent(mean)}. `;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text('套用為全期起點', 'Apply as baseline');
    button.addEventListener('click', () => {
      document.getElementById(`fcff-${key}`).value = key === 'tax' ? mean : mean * 100;
      if (key === 'depreciation') document.getElementById('fcff-depreciationBasis').value = 'ttm';
      recalculate();
    });
    note.append(button);
    detail.append(note);
  }
  function renderSupport(result) {
    document.getElementById('fcff-support-cashflow').hidden = supportTab !== 'cashflow';
    document.getElementById('fcff-support-equity').hidden = supportTab !== 'equity';
    const other = document.getElementById('fcff-support-other');
    other.hidden = ['cashflow', 'equity'].includes(supportTab);
    const periods = result.periods, headers = [text('期間', 'Period'), ...periods.map(row => row.end)];
    if (supportTab === 'periods' || supportTab === 'factors') {
      other.innerHTML = schedule(headers, [
        [text('完整財年起點', 'Fiscal-year start'), periods.map(row => escape(row.fiscalStart))],
        [text('現金流起點', 'Cash-flow start'), periods.map(row => escape(row.start))],
        [text('財年期末', 'Fiscal-year end'), periods.map(row => escape(row.end))],
        [text('採用折現日期 (UTC)', 'Discount date (UTC)'), periods.map(row => escape(row.discountDate))],
        [text('Actual/365.25 年數', 'Actual/365.25 years'), periods.map(row => finite(row.time) ? row.time.toFixed(6) : 'N/A')],
        [text('折現因子', 'Discount factor'), periods.map(row => finite(row.df) ? row.df.toFixed(6) : 'N/A')],
        ['FCFF', periods.map(row => amount(row.fcff))],
        [text('現值', 'Present value'), periods.map(row => amount(row.pv))]
      ]);
    } else if (supportTab === 'enterprise') {
      other.innerHTML = caseTable(result, [[text('預測 FCFF 現值', 'Forecast FCFF present value'), 'sumPV'],
        [text('終值 FCFF（下一年度）', 'Terminal FCFF (next year)'), 'terminalFcff'],
        [text('未折現終值', 'Undiscounted terminal value'), 'tv'],
        [text('終值現值', 'Terminal present value'), 'pvTV'],
        [text('企業價值', 'Enterprise value'), 'ModelEV'],
        [text('普通股權價值', 'Common equity value'), 'EquityVal'],
        [text('每股價值', 'Value per share'), 'fairVal']]);
    } else if (supportTab === 'history') {
      const rows = snapshot()?.history?.annual || [];
      other.innerHTML = `<p class="analysis-note">${text(
        `目前實際可用 ${rows.length} 個年度；不假造缺少的第五年。歷史流量採期間美元匯率，非以今日匯率重寫；缺失的現金流／稅率顯示 N/A。`,
        `${rows.length} annual periods are currently available; a missing fifth year is not fabricated. Historical flows use period-matched USD exchange rates, not today's FX. Missing cash-flow or tax inputs remain N/A.`)}</p>` +
        schedule([text('報表截止日', 'Statement date'), ...rows.map(row => row.date)], [
          [text('營收', 'Revenue'), rows.map(row => amount(row.revenue))], ['EBITDA', rows.map(row => amount(row.ebitda))],
          [text('營業 EBIT', 'Operating EBIT'), rows.map(row => amount(row.ebit))],
          ['D&A', rows.map(row => amount(row.depreciation))], ['CapEx', rows.map(row => amount(row.capex))],
          [text('有效稅率', 'Effective tax'), rows.map(row => finite(row.tax) ? amount(row.tax) + '%' : 'N/A')]
        ]);
      if (snapshot()?.history?.warnings?.length) other.innerHTML += `<p class="analysis-note">${text(
        '部分歷史來源的代碼／公布日期無法核對，已排除。', 'Some historical rows were excluded because ticker/publication dates could not be reconciled.')}</p>`;
    } else if (supportTab === 'multiples') {
      const value = metrics({ ...context.stock, mcap: result.E }, snapshot(), result);
      other.innerHTML = schedule([text('指標（非模型終值倍數）', 'Metric (not terminal exit multiples)'), 'USD / TTM'], [
        [text('報價市值 ($M)', 'Quoted market cap ($M)'), [amount(result.E)]],
        [text('報價企業價值 ($M)', 'Quoted enterprise value ($M)'), [amount(value.EV)]],
        [text('實際 TTM EBITDA ($M)', 'Reported TTM EBITDA ($M)'), [amount(snapshot()?.ttm?.ebitda)]],
        ['EV / EBITDA', [finite(value.ev_to_ebitda) ? amount(value.ev_to_ebitda) + 'x' : 'N/A']],
        [text('總債務／EBITDA', 'Total debt / EBITDA'), [finite(value.debt_to_ebitda) ? amount(value.debt_to_ebitda) + 'x' : 'N/A']]
      ]);
    }
  }
  function renderTable(result) {
    const periods = result.periods;
    const rows = [
      ['來源', 'Source', row => sourceLabel(row.sources?.revenue)],
      ['營收 ($M)', 'Revenue ($M)', row => amount(row.revenue)],
      ['營收增長率 (%)', 'Revenue growth (%)', (row, i) => {
        const previous = result.periods[i - 1];
        return previous && !previous.partial && !row.partial && previous.revenue > 0
          ? percent(row.revenue / previous.revenue - 1) : text('部分期間／不適用', 'Stub / not comparable');
      }],
      ['EBITDA ($M)', 'EBITDA ($M)', row => amount(row.ebitda)],
      ['EBIT ($M)', 'EBIT ($M)', row => amount(row.ebit)],
      ['稅項 ($M)', 'Tax expense ($M)', row => amount(row.taxExpense)],
      ['稅後營業利潤 NOPAT ($M)', 'NOPAT ($M)', row => amount(row.nopat)],
      ['折舊攤銷 ($M)', 'D&A ($M)', row => amount(row.depreciation)],
      ['資本支出 ($M)', 'Capital expenditure ($M)', row => amount(row.capex)],
      ['營運資金增加 ($M)', 'Increase in NWC ($M)', row => amount(row.nwcChange)],
      ['NWC 現金流貢獻 ($M)', 'NWC cash-flow contribution ($M)', row => amount(-row.nwcChange)],
      ['企業自由現金流 FCFF ($M)', 'FCFF ($M)', row => amount(row.fcff)],
      ['折現因子', 'Discount factor', row => finite(row.df) ? row.df.toFixed(6) : 'N/A'],
      ['折現現值 ($M)', 'Present value ($M)', row => amount(row.pv)]
    ];
    document.getElementById('fcff-table').innerHTML = `<thead><tr><th>${text('期間', 'Period')}</th>${periods.map(row =>
      `<th>${escape(row.end)}${row.partial ? ` (${text('部分', 'stub')})` : ''}</th>`).join('')}</tr></thead>
      <tbody>${periods.length ? rows.map(([zh, en, fn]) =>
        `<tr><th>${text(zh, en)}</th>${periods.map((row, i) => `<td>${fn(row, i)}</td>`).join('')}</tr>`).join('')
        : `<tr><td>N/A · ${escape(reasonText(result.reason, context.language()))}</td></tr>`}</tbody>`;
  }
  function renderBridge(result) {
    const input = readScenario();
    const rows = [
      ['預測期 FCFF 現值', 'Forecast FCFF present value', result.sumPV],
      ['終值 NOPAT（年化）', 'Terminal NOPAT (annualized)', result.terminalNopat],
      ['終值再投資', 'Terminal reinvestment', result.terminalReinvestment],
      ['終值 FCFF', 'Terminal FCFF', result.terminalFcff],
      ['終值現值', 'Terminal present value', result.pvTV],
      ['模型企業價值', 'Modeled enterprise value', result.ModelEV],
      ['帳面總債務', 'Reported total debt', input.debt],
      ['減：FCFF 已承擔之對應租賃負債', 'Less: corresponding lease debt already borne by FCFF', input.leaseOverlap],
      ['估值用融資債務', 'Valuation financing debt', result.financingDebt],
      ['加：非營運現金及短期投資', 'Add: nonoperating cash and short-term investments', input.cash],
      ['加：非營運長期投資', 'Add: nonoperating long-term investments', input.investments],
      ['減：優先股權益', 'Less: preferred equity', input.preferred],
      ['減：非控制權益', 'Less: noncontrolling interests', input.minority],
      ['普通股權價值', 'Common equity value', result.EquityVal]
    ];
    document.getElementById('fcff-bridge').innerHTML = rows.map(([zh, en, value]) =>
      `<tr><th>${text(zh, en)} ($M)</th><td>${amount(value)}</td></tr>`).join('');
    document.getElementById('fcff-terminal-note').textContent = result.assumptions
      ? [result.assumptions.terminalMethod === 'roic'
        ? `${text('終值 ROIC', 'Terminal ROIC')}: ${amount(result.assumptions.terminalRoic)}%; ${text('再投資＝NOPAT × g／ROIC。', 'Reinvestment = NOPAT × g / ROIC.')}`
        : text('終值 FCFF＝NOPAT＋D&A－CapEx－新增 NWC。', 'Terminal FCFF = NOPAT + D&A − capex − incremental NWC.'),
      text('終值 FCF 已是下一年度數值，Gordon 分子不再次乘（1＋g）。終值採第十財年期末折現因子，而非年中因子。', 'Terminal FCF is already next-year cash flow: do not multiply the Gordon numerator by (1 + g) again. Terminal value uses the tenth fiscal year-end factor, not its mid-year factor.'),
      result.terminalWarning ? text('注意：正成長但終值淨再投資非正；須自行確認經濟可持續性，或改用 ROIC 法。', 'Warning: growth is positive but terminal net reinvestment is nonpositive; verify economic sustainability or use the ROIC method.') : ''
      ].filter(Boolean).join(' ') : '';
  }
  function renderSensitivity(source, scenario, result) {
    const table = document.getElementById('fcff-sensitivity');
    if (result.reason) { table.innerHTML = '<tbody><tr><td>N/A</td></tr></tbody>'; return; }
    const gs = [-0.5, 0, 0.5].map(delta => scenario.g + delta);
    const ws = [-0.005, 0, 0.005].map(delta => result.WACC + delta);
    table.innerHTML = `<thead><tr><th>WACC / g</th>${gs.map(g => `<th>${g.toFixed(2)}%</th>`).join('')}</tr></thead><tbody>${ws.map((w, wi) =>
      `<tr><th>${percent(w)}</th>${gs.map((g, gi) => {
        const value = window.Fcff.calculate(source, { ...scenario, discountRate: w, g });
        return `<td class="sens-cell${wi === 1 && gi === 1 ? ' sens-base' : ''}">${finite(value.fairVal) ? `$${amount(value.fairVal)}` : 'N/A'}</td>`;
      }).join('')}</tr>`).join('')}</tbody>`;
  }
  function save() {
    const result = recalculate();
    if (!result || result.fairVal === null) return;
    context.save({ targetPrice: result.fairVal, savedAt: new Date().toISOString(), params: readScenario() });
    context.saved = { params: readScenario() };
    document.getElementById('fcff-legacy').textContent = '';
  }
  return { compatible, metrics, reasonText, load, rerender, recalculate, save };
});
