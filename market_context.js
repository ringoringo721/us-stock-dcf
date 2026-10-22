(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MarketContext = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  function resolve(location = root.location || {}) {
    const explicit = new URLSearchParams(location.search || '').get('market')?.toUpperCase();
    if (explicit === 'HKEX' || explicit === 'US') return explicit;
    return /(?:^|[/:#])\d{4,5}\.HK(?:[/:]|$)/i.test(decodeURIComponent(location.hash || '')) ? 'HKEX' : 'US';
  }
  const market = resolve();
  const currency = market === 'HKEX' ? 'HKD' : 'USD';
  const stocks = () => market === 'HKEX'
    ? root.HkUniverse ? root.HkUniverse.merge(root.HK_MARKET_DATA) : root.HK_MARKET_DATA
    : root.UsUniverse ? root.UsUniverse.merge(root.FULL_MARKET_DATA) : root.FULL_MARKET_DATA;
  const fcff = () => market === 'HKEX' ? root.HK_FCFF_DATA : root.FCFF_DATA;
  function currencyFor(ticker, stock) {
    return stock?.calculationCurrency || (/\.HK$/i.test(ticker || '') ? 'HKD' : 'USD');
  }
  function compatibleSaved(model, ticker, stock) {
    if (!model) return false;
    const target = currencyFor(ticker, stock);
    return (model.currency || model.calculationCurrency || model.params?.currency || 'USD') === target
      && (!model.params?.currency || model.params.currency === target);
  }
  function cadence(data, statement = 'income') {
    // The legacy quarterly container also holds genuine Q2/Q4 half-year reports.
    const frequency = data?.statementFrequencies?.[statement] || data?.reportingFrequency || 'quarterly';
    return { frequency, stride: frequency === 'semiannual' ? 2 : 1,
      count: frequency === 'semiannual' ? 2 : 4,
      minDays: frequency === 'semiannual' ? 150 : 60,
      maxDays: frequency === 'semiannual' ? 220 : 120 };
  }
  function label(key, annual, stride = 1) {
    return annual ? `FY ${key}` : `FY ${Math.floor(key / 4)} ${stride === 2 ? `H${(key % 4 + 1) / 2}` : `Q${key % 4 + 1}`}`;
  }
  function labels(dictionary, data) {
    const half = cadence(data).stride === 2;
    const result = Object.fromEntries(Object.entries(dictionary).map(([key, value]) => [key,
      typeof value !== 'string' || key.startsWith('market_') ? value : value.replace(/\bUSD\b/g, currency).replace(currency === 'HKD' ? /美元/g : /$^/g, '港元')
        .replace(currency === 'HKD' ? /\$/g : /$^/g, 'HKD ')
        .replace(half ? /QoQ|季增率/g : /$^/g, match => match === 'QoQ' ? 'HoH' : '半年增率')
        .replace(half ? /four consecutive|four quarterly|four matching quarterly|four quarters|四季|近20季|單季|季度|Quarterly|quarterly|Single-quarter/g : /$^/g,
          match => ({ '四季': '兩個半年', '近20季': '實際半年', '單季': '單一半年', '季度': '半年',
            'Quarterly': 'Semiannual', 'quarterly': 'semiannual', 'Single-quarter': 'Single-half-year' }[match] || 'two half-year periods'))]));
    if (currency === 'HKD' && result.title) result.title = result.title.replace('美股', '港股').replace('US Stock', 'HKEX Stock');
    if (half) {
      const en = /^(Quarterly|Semiannual|Annual|Full fiscal)/i.test(dictionary.fcf_quarterly || dictionary.fcf_annual || '');
      Object.assign(result, en ? {
        fcf_quarterly: 'Semiannual', btn_period_quarter: 'Reported half years', btn_ratio_quarter: 'Reported half years',
        fcf_ttm: 'TTM (two consecutive half years)', fcf_single: 'Single half year',
        fcf_basis_note: 'Single-half-year flows use the preceding half-year balance; TTM sums two consecutive half years and uses the balance one year earlier. Annual uses the prior fiscal year. Average is the simple mean of opening and closing balances.',
        returns_basis_note: 'Returns use actual net income: a single half year is not annualized; TTM sums two consecutive half years. Beginning and average balances cover the same period. Missing periods are never filled.',
        earnings_chart_note: 'Single-half-year flows use same-period diluted shares. TTM sums two separately translated half years and divides cash flow by their average diluted share counts. EPS sums actual half-year EPS when available; at fiscal-year end, matching reported annual EPS is used when H2 EPS cannot be derived. Missing reports and FX remain gaps.',
        profile_statement_basis: 'Margins use two consecutive reported half years; ROA/ROE use TTM and beginning balances. Statement date and currency',
        profile_source_note: 'Only actual reports are shown. TTM growth compares two consecutive half years with the preceding two, with a positive prior-year base. Missing values remain N/A.',
        analysis_growth_note: 'TTM growth compares two consecutive half years with the preceding two, aligned by actual fiscal periods and dates. Missing reports or a nonpositive prior base remain N/A.'
      } : {
        fcf_quarterly: '半年', btn_period_quarter: '實際半年報', btn_ratio_quarter: '實際半年報',
        fcf_ttm: 'TTM（連續兩個半年）', fcf_single: '單一半年',
        fcf_basis_note: '單一半年使用前一半年期末餘額；TTM 合計連續兩個半年並使用一年前的期初餘額。年度使用前一財年；平均為期初與期末的簡單平均。',
        returns_basis_note: '採實際淨利：單一半年不年化，TTM 合計連續兩個半年。分母為相同期間的期初或期初期末平均餘額；缺期不補造。',
        earnings_chart_note: '單一半年使用同期稀釋股數。TTM 合計各自換匯後的兩個半年，現金流除以兩期平均稀釋股數。EPS 優先合計實際半年稀釋 EPS；財年期末若無法推導 H2 EPS，採同日已報全年 EPS。缺少財報或匯率保留斷點。',
        profile_statement_basis: '獲利率採連續兩個半年實績；ROA／ROE 採 TTM／期初餘額。財報日與幣別',
        profile_source_note: '僅顯示實際報告。TTM 年增率比較連續兩個半年與之前兩個半年，去年基數須為正；缺值維持 N/A。',
        analysis_growth_note: 'TTM 年增率比較最近連續兩個半年與之前兩個半年，依實際財年及日期對齊。缺少報告或去年基數非正數顯示 N/A。'
      });
    }
    return result;
  }
  function localize(panel, dictionary, data) {
    const translated = labels(dictionary, data);
    panel?.querySelectorAll('select[id$="-period"]').forEach(select => {
      if (!select.querySelector('option[value="quarterly"]')) return;
      let half = select.querySelector('option[value="semiannual"]');
      if (market === 'HKEX' && !half) {
        half = root.document.createElement('option');
        half.value = 'semiannual';
        half.dataset.i18n = 'fcf_semiannual';
        select.append(half);
      }
      if (half) half.textContent = translated.fcf_semiannual || (root.document.documentElement.lang === 'en' ? 'Half year' : '半年');
      const quarter = select.querySelector('option[value="quarterly"]');
      const frequency = cadence(data, select.id === 'fcf-ratio-period' ? 'cashflow' : data?.presentationStatement || 'income').frequency;
      quarter.disabled = frequency !== 'quarterly' && data?.periodView !== 'semiannual';
      quarter.hidden = quarter.disabled || frequency === 'annual';
      if (half) {
        half.disabled = frequency === 'annual';
        half.hidden = half.disabled;
      }
      if (frequency === 'annual') select.value = 'annual';
      else if (quarter.disabled && select.value === 'quarterly') select.value = 'semiannual';
    });
    panel?.querySelectorAll('[data-i18n]').forEach(element => {
      const value = translated[element.dataset.i18n];
      if (value) element.innerHTML = element.tagName === 'OPTION' && element.value === 'quarterly' && data?.periodView === 'semiannual'
        ? dictionary[element.dataset.i18n] || value : value;
    });
    return translated;
  }
  function propertyFvNote(data, language = 'en') {
    if (!data?.propertyFvProvenance) return '';
    return language === 'en'
      ? 'Link FY2019–FY2026: operating income and EBIT exclude independently verified consolidated investment-property FV changes, retaining other impairments; EBITDA adds FMP D&A. Unseparated JV FV may remain in EBIT/EBITDA. Attributable NPAT uses the issuer’s property-FV/deferred-tax bridge, respecting JV/NCI scope; combined, inseparable adjustments show N/A. Basic EPS uses verified units; adjusted diluted EPS/P-E are unavailable pending convertible dilution review. Pretax, tax and other statement rows remain reported, not a restated GAAP income statement. CFO is statutory, already FV-free: no second addback. FCF deducts cash investment-property plus PPE additions, before financing-classified interest, not distributable equity cash. Native FMP forecasts/valuations and reported-basis F-score are unchanged. Earlier history is unreviewed; original FMP statements and official source pages are saved in the statement audit data.'
      : '領展 FY2019–FY2026：營業利益及 EBIT 按已核實的合併投資物業公允值變動調整，保留其他減值；EBITDA 加回 FMP 折舊攤銷。EBIT／EBITDA 仍可能含未能分拆的合營公允值影響。股東 NPAT 採官方分派調節中的物業公允值及遞延稅調整，保留合營／非控股歸屬；無法分拆的合併調整顯示 N/A。基本 EPS 採核實單位數；調整後稀釋 EPS／本益比因需重測可換股攤薄而不可用。稅前、稅項及其他列仍為報告值，並非重編會計損益表。CFO 採法定現金流，已排除非現金公允值，不再加回；FCF 扣投資物業及固定資產現金投入，未扣融資分類利息，非可分派股東現金。FMP 原生預測／估值及按報告值計算的 F-score 不變。更早歷史未核實；原始 FMP 數據及官方頁碼已存入報表審核資料。';
  }
  function renderProvenance(panel, data, ticker) {
    if (!panel || !data) return;
    let details = panel.querySelector('[data-financial-provenance]');
    if (!details) {
      details = root.document.createElement('details');
      details.className = 'analysis-note';
      details.dataset.financialProvenance = '';
      const summary = root.document.createElement('summary');
      const body = root.document.createElement('pre');
      body.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;';
      details.append(summary, body);
      panel.append(details);
    }
    details.querySelector('summary').textContent = root.document.documentElement.lang === 'en'
      ? 'Source periods, FX provenance and data limitations' : '原始報告期間、換匯與資料限制';
    const fields = ['date', 'period', 'periodStartDate', 'periodLength', 'duration', 'derivation',
      'sourceDates', 'sourceReleaseDate', 'sourceReportedCurrency', 'reportedCurrency', 'currencyConversion',
      'comparabilityGroup', 'operatingIncomeBasis', 'earningsIncludeDiscontinued', 'revenueCorrection', 'reportType'];
    const periods = {};
    for (const frequency of ['annual', 'quarterly']) {
      for (const statement of ['income', 'balance', 'cashflow']) {
        if (Array.isArray(data[frequency]?.[statement])) periods[`${frequency}.${statement}`] =
          data[frequency][statement].map(row => Object.fromEntries(fields.filter(key => row[key] != null).map(key => [key, row[key]])));
      }
    }
    details.querySelector('pre').textContent = JSON.stringify({
      ticker, calculationCurrency: data.calculationCurrency || currency, reportedCurrency: data.reportedCurrency,
      reportingFrequency: data.reportingFrequency, statementFrequencies: data.statementFrequencies,
      propertyFvProvenance: data.propertyFvProvenance,
      qualityWarnings: data.qualityWarnings, currencyConversion: data.currencyConversion,
      periods: Object.keys(periods).length ? periods : data.statements_raw?.periodMetadata,
      rawStatementWarnings: data.statements_raw?.qualityWarnings
    }, null, 2);
  }
  return { market, currency, resolve, stocks, fcff, currencyFor, compatibleSaved, cadence, label, labels, localize,
    propertyFvNote, renderProvenance };
});
