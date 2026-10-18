(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FmpModels = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
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
    return saved?.schemaVersion === 1 && saved.modelType === 'FMP_CUSTOM_DCF'
      && ['advanced', 'customLevered'].includes(saved.kind);
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
      params: previous?.params || { advanced: {}, customLevered: {}, ...(saved ? { [saved.kind]: saved.params } : {}) },
      dirty: previous?.dirty || { advanced: false, customLevered: false,
        ...(saved ? { [saved.kind]: Object.keys(saved.params || {}).length > 0 && !saved.modelSummary } : {}) },
      data: previous?.data || options.data || record(options.ticker), requestId: (state?.requestId || 0) + 1 };
    if (!previous && saved?.modelSummary && saved.ticker === options.ticker && saved.issuedShares === issuedShares(options.stock)) {
      state.data = { ...state.data, models: { ...state.data.models,
        [saved.kind]: { ...state.data.models[saved.kind], data: [saved.modelSummary],
          capturedAt: saved.sourceCapturedAt, reason: null } } };
    }
    render();
  }

  function render() {
    const { stock, ticker, kind, data } = state, en = state.language() === 'en';
    const box = root.document.getElementById('fmp-workspace');
    const result = value(data, kind, stock), row = result.row || first(data?.models?.[kind]?.data);
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
    set('det-res-status', result.reason ? reasonText(result.reason, state.language()) : `${name(kind)} · ${data.capturedAt}`);
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
    root.document.querySelector('[onclick="saveCustomModel()"]').disabled = result.fairVal === null || state.dirty[kind];
    box.innerHTML = `<div class="panel">
      <h3>${text('FMP 雙軌可編輯估值模型', 'Two editable FMP valuation models')}</h3>
      <label for="fmp-model">${text('模型', 'Model')}</label>
      <select id="fmp-model"><option value="advanced">${name('advanced')}</option><option value="customLevered">${name('customLevered')}</option></select>
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
        ? text('用戶情境尚未向 FMP 重新計算；不可儲存舊結果。', 'Overrides have not been recalculated with FMP; the previous result cannot be saved.')
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
      <div class="table-scroll-wrapper"><table><thead><tr><th>${text('模型年度', 'Model year')}</th><th>${text('營收', 'Revenue')}</th><th>${text('EBIT／CFO', 'EBIT / CFO')}</th><th>CapEx</th><th>${text('模型現金流', 'Model cash flow')}</th></tr></thead>
        <tbody>${(data?.models?.[kind]?.data || []).slice().sort((a,b) => Number(a.year)-Number(b.year)).map(r => `<tr>
          <th>${escape(r.year)}</th><td>${money(r.revenue)}</td><td>${money(kind === 'advanced' ? r.ebit : r.operatingCashFlow)}</td><td>${money(r.capitalExpenditure)}</td><td>${money(kind === 'advanced' ? r.ufcf : r.freeCashFlow)}</td></tr>`).join('')}</tbody></table></div>
      <p class="analysis-note">${text('FMP 的租賃、投資、非控制權益及優先股處理未等同本網站原官方 FCFF 對帳；不保證兩模型可直接比較。此處顯示供應商模型，不代表所有假設均經獨立驗證。', 'FMP treatment of leases, investments, NCI and preferred claims is not the prior issuer-reconciled FCFF bridge. Models are not guaranteed comparable; displaying a vendor model does not independently certify all assumptions.')}</p>
      <details><summary>${text('現有官方來源 FCFF（舊模型，分開顯示）', 'Existing issuer-sourced FCFF (legacy, separate model)')}</summary><button type="button" id="fmp-legacy">${text('檢視舊 FCFF', 'Inspect legacy FCFF')}</button></details>
    </div>`;
    box.querySelector('#fmp-model').value = kind;
    box.querySelector('#fmp-model').addEventListener('change', event => { state.kind = event.target.value; render(); });
    box.querySelectorAll('[data-fmp-input]').forEach(input => input.addEventListener('input', () => {
      const field = fields.find(field => field[0] === input.dataset.fmpInput);
      if (input.value.trim()) state.params[kind][field[0]] = Number(input.value) / field[4];
      else delete state.params[kind][field[0]];
      state.dirty[kind] = true;
      state.requestId++;
      root.document.querySelector('[onclick="saveCustomModel()"]').disabled = true;
      box.querySelector('#fmp-status').textContent = text('用戶情境尚未向 FMP 重新計算；不可儲存舊結果。', 'Overrides have not been recalculated with FMP; the previous result cannot be saved.');
    }));
    box.querySelector('#fmp-calculate').addEventListener('click', calculate);
    box.querySelector('#fmp-legacy').addEventListener('click', state.legacy);
  }

  async function calculate() {
    const current = state, id = ++state.requestId, kind = state.kind;
    const status = root.document.getElementById('fmp-status');
    if ([...root.document.querySelectorAll('#fmp-workspace input')].some(input => !input.reportValidity())) {
      status.textContent = state.language() === 'en' ? 'Correct the invalid numeric inputs before calculating.' : '請先修正無效的數字輸入。';
      return;
    }
    const query = new URLSearchParams({ action: kind === 'advanced' ? 'custom-dcf' : 'custom-levered-dcf', symbol: state.ticker,
      ...Object.fromEntries(Object.entries(state.params[kind]).map(([key, value]) => [key, String(value)])) });
    const button = root.document.getElementById('fmp-calculate');
    button.disabled = true;
    status.textContent = state.language() === 'en' ? 'Calculating with FMP…' : '正在向 FMP 計算…';
    try {
      const response = await root.fetch(`/api/fmp?${query}`);
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('FMP_API_UNAVAILABLE');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP_${response.status}`);
      if (!Array.isArray(result.data) || result.source?.symbol !== state.ticker) throw new Error('FMP_INVALID_RESPONSE');
      if (state !== current || id !== state.requestId || kind !== state.kind) return;
      state.data = { ...state.data,
        models: { ...state.data.models, [kind]: { ...state.data.models[kind], data: result.data,
          capturedAt: result.source.capturedAt,
          reason: result.data.length ? null : 'FMP_NO_COVERAGE' } } };
      state.dirty[kind] = false;
      render();
    } catch (error) {
      if (state !== current || id !== state.requestId) return;
      console.error('FMP custom valuation failed', state.ticker, error.message);
      status.textContent = `${state.language() === 'en' ? 'Calculation failed; no new result was saved' : '計算失敗，未儲存新結果'}: ${error.message}`;
      root.document.querySelector('[onclick="saveCustomModel()"]').disabled = true;
    } finally { if (button.isConnected) button.disabled = false; }
  }

  function save() {
    if (!state || root.document.querySelector('[onclick="saveCustomModel()"]').disabled) return;
    const result = value(state.data, state.kind, state.stock);
    if (result.fairVal === null) return;
    state.save({ schemaVersion: 1, modelType: 'FMP_CUSTOM_DCF', kind: state.kind, ticker: state.ticker,
      currency: result.currency, targetPrice: result.fairVal, issuedShares: result.issuedShares,
      shareSource: state.stock.shareSource, providerShares: result.providerShares, providerEquityValue: result.row.equityValue,
      modelSummary: { ...result.row }, params: { ...state.params[state.kind] },
      sourceCapturedAt: result.capturedAt, savedAt: new Date().toISOString() });
  }
  function reset() { if (state) { state.requestId++; state.params = { advanced: {}, customLevered: {} };
    state.dirty = { advanced: false, customLevered: false }; state.data = record(state.ticker); render(); } }
  function detailsError(ticker, reason) {
    if (!state || state.ticker !== ticker) return;
    const status = root.document.getElementById('fmp-status');
    if (status) status.textContent = `${state.language() === 'en'
      ? 'Detailed model source unavailable; only the dated summary is shown'
      : '詳細模型來源無法載入；目前僅顯示附日期的摘要'}: ${reason}`;
  }
  function details(data) {
    if (state && state.ticker === data.symbol && state.data === record(state.ticker)) {
      state.data = data;
      if (!root.document.getElementById('fmp-workspace').hidden) render();
    }
  }
  return { record, value, issuedShares, reference, compatible, load, save, reset, details, detailsError, reasonText,
    showLegacy: () => { if (state) state.legacy(); }, rerender: () => { if (state) render(); } };
});
