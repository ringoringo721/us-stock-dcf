(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FcffView = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const compatible = saved => saved?.params?.modelVersion === 'fcff-v1'
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
    forecastConflictsWithActual: ['本年度預測與已公布營收衝突。', 'The current annual forecast conflicts with reported revenue.'],
    incompatibleSavedModel: ['舊版 FCF 情境不能轉作 FCFF。', 'A legacy FCF scenario cannot be reinterpreted as FCFF.'],
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
    ['depreciation', '折舊攤銷／營收 (%)；TTM', 'D&A / revenue (%); TTM', 'ratio'],
    ['capex', '資本支出／營收 (%)；TTM', 'Capital expenditure / revenue (%); TTM', 'ratio'],
    ['workingCapital', '非現金營運資金／營收 (%)；TTM 營收與期末餘額', 'Noncash NWC / revenue (%); TTM revenue and closing balance', 'ratio']
  ];
  let context = null;
  const text = (zh, en) => context.language() === 'en' ? en : zh;
  function snapshot() { return window.FCFF_DATA?.stocks?.[context.ticker]; }
  function readScenario() {
    const scenario = { modelVersion: 'fcff-v1' };
    for (const [key, , , mode] of fields) {
      const input = document.getElementById(`fcff-${key}`);
      const value = input.value.trim() === '' ? null : Number(input.value);
      scenario[key] = mode === 'ratio' && value !== null ? value / 100 : value;
    }
    return scenario;
  }
  function load(options) {
    context = options;
    const source = snapshot();
    const saved = compatible(options.saved) ? options.saved.params : {};
    const scenario = options.stock.fcffScenario || saved;
    const ratios = window.Fcff.operatingRatios(source?.ttm);
    const defaults = { ...source?.defaults, ...ratios,
      terminalMargin: ratios?.operatingMargin, ...scenario };
    const panel = document.getElementById('fcff-workspace');
    panel.hidden = false;
    panel.innerHTML = `<section class="panel historical-ratio-panel">
      <div class="panel-title">FCFF · ${text('來源與模型假設', 'Sources and model assumptions')}</div>
      <p id="fcff-source-note" class="analysis-note"></p>
      <p id="fcff-status" class="model-reference-note" role="status"></p>
      <p id="fcff-legacy" class="analysis-note"></p>
      <details><summary>${text('來源、代理值與假設說明', 'Source, proxy and assumption disclosures')}</summary>
        <p id="fcff-assumptions" class="analysis-note"></p>
      </details>
      <details id="fcff-input-controls"><summary>${text('調整假設（美元百萬；除每股／百分比）', 'Edit assumptions (USD millions, except per-share / percentages)')}</summary>
        <div class="fcff-inputs">${fields.map(([key, zh, en, mode]) => {
          const value = mode === 'ratio' && finite(defaults[key]) ? defaults[key] * 100 : defaults[key];
          return `<div class="form-group"><label for="fcff-${key}">${escape(text(zh, en))}</label>
            <input type="number" id="fcff-${key}" step="any" value="${finite(value) ? value : ''}"
              ${source?.reason ? 'disabled' : ''}></div>`;
        }).join('')}</div></details>
    </section>
    <section class="panel historical-ratio-panel">
      <div class="panel-title">${text('十年 FCFF 預測：分析師錨點與模型推算', 'Ten-year FCFF forecast: analyst anchors and model extrapolation')}</div>
      <p class="analysis-note">${text(
        'FCFF＝EBIT ×（1－稅率）＋折舊攤銷－資本支出－營運資金增加。分析師只提供營收／EBIT 錨點，不是十年 FCF 預測。首尾財年為部分期間；尚未公布期間按日均分，並非已知實績。',
        'FCFF = EBIT × (1 − tax) + D&A − capex − increase in NWC. Analysts supply revenue/EBIT anchors, not ten years of FCF. First/last fiscal years are partial periods; unreported elapsed flows are allocated uniformly by day, not presented as known actuals.')}</p>
      <div class="table-scroll-wrapper"><table id="fcff-table"></table></div>
    </section>
    <section class="panel historical-ratio-panel">
      <div class="panel-title">${text('企業價值至普通股權價值', 'Enterprise-to-common-equity bridge')}</div>
      <div class="table-scroll-wrapper"><table><tbody id="fcff-bridge"></tbody></table></div>
      <p id="fcff-terminal-note" class="analysis-note"></p>
    </section>
    <section class="panel historical-ratio-panel">
      <div class="panel-title">${text('敏感度：WACC 與終值增長率', 'Sensitivity: WACC and terminal growth')}</div>
      <p class="analysis-note">${text('每一格重跑相同 FCFF 模型；ROIC 空白時隨該格 WACC 變動，不套用隱藏利差下限。', 'Every cell reruns the same FCFF model. A blank ROIC follows that cell’s WACC; no hidden spread floor is applied.')}</p>
      <div class="table-scroll-wrapper"><table id="fcff-sensitivity"></table></div>
    </section>`;
    for (const input of panel.querySelectorAll('input')) input.addEventListener('input', recalculate);
    document.getElementById('fcff-legacy').textContent = options.saved && !compatible(options.saved)
      ? text('舊版自訂目標價已保留，但舊 FCF 參數不會套入 FCFF；儲存新情境前將封存舊紀錄。',
        'Your legacy target is retained, but old FCF inputs are not applied to FCFF. Saving a new scenario archives the previous record.')
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
      text('Beta 預設來自 FMP Profile，回應未明示年期／頻率／基準；手動修改均屬使用者情境，不是 FMP 預測。', 'Default beta comes from FMP Profile; lookback/frequency/benchmark are unspecified. Manual edits are user scenarios, not FMP forecasts.'),
      text('租賃付款已在 FCFF 承擔時，只排除對應負債；WACC 與股權橋接使用相同債務口徑。', 'Only matching lease claims already borne by FCFF are excluded; WACC and the equity bridge use identical financing debt.')
    ].filter(Boolean).join(' · ');
    document.getElementById('fcff-status').textContent = result.reason
      ? reasonText(result.reason, context.language())
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
    return result;
  }
  function renderTable(result) {
    const periods = result.periods;
    const rows = [
      ['來源', 'Source', row => row.anchor ? text('分析師營收／EBIT；FCFF 為模型值', 'Analyst revenue/EBIT; modeled FCFF') : text('模型推算', 'Model extrapolation')],
      ['營收 ($M)', 'Revenue ($M)', row => amount(row.revenue)],
      ['營收增長率 (%)', 'Revenue growth (%)', (row, i) => {
        const previous = result.periods[i - 1];
        return previous && !previous.partial && !row.partial && previous.revenue > 0
          ? percent(row.revenue / previous.revenue - 1) : text('部分期間／不適用', 'Stub / not comparable');
      }],
      ['EBIT ($M)', 'EBIT ($M)', row => amount(row.ebit)],
      ['稅後營業利潤 NOPAT ($M)', 'NOPAT ($M)', row => amount(row.nopat)],
      ['折舊攤銷 ($M)', 'D&A ($M)', row => amount(row.depreciation)],
      ['資本支出 ($M)', 'Capital expenditure ($M)', row => amount(row.capex)],
      ['營運資金增加 ($M)', 'Increase in NWC ($M)', row => amount(row.nwcChange)],
      ['企業自由現金流 FCFF ($M)', 'FCFF ($M)', row => amount(row.fcff)],
      ['折現因子', 'Discount factor', row => row.df.toFixed(4)],
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
      ? `${text('終值 ROIC', 'Terminal ROIC')}: ${result.assumptions.terminalRoic.toFixed(2)}% (${result.assumptions.terminalRoicBasis}); ${text('再投資率＝g／ROIC；終值使用最末財年的年化營收與長期利潤率。', 'Reinvestment rate = g / ROIC; terminal cash flow uses the final fiscal year’s annualized revenue and terminal margin.')} Actual/365.25 · ${text('期末折現；估值日至十年後，可能跨十一個財年區段。', 'Period-end discounting; ten calendar years can span eleven fiscal buckets.')}`
      : '';
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
