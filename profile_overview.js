(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProfileOverview = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const context = typeof module === 'object' && module.exports ? require('./market_context.js') : MarketContext;
  const industryApi = typeof module === 'object' && module.exports
    ? require('./financial_industry.js')
    : (typeof globalThis !== 'undefined' ? globalThis.FinancialIndustry : null);
  const Beta = typeof module === 'object' && module.exports
    ? (typeof require === 'function' ? (() => { try { return require('./beta_lookback.js'); } catch { return null; } })() : null)
    : (typeof BetaLookback !== 'undefined' ? BetaLookback : null);
  const numeric = value => ((typeof value === 'number' || typeof value === 'string' && value.trim())
    && Number.isFinite(Number(value))) ? Number(value) : null;

  function indexRows(rows) {
    const index = new Map();
    for (const row of rows) {
      const year = Number(row.fiscalYear || row.calendarYear);
      if (!Number.isInteger(year) || !/^Q[1-4]$/.test(row.period)
          || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(Date.parse(row.date))
          || new Date(row.date).toISOString().slice(0, 10) !== row.date) continue;
      const key = year * 4 + Number(row.period[1]) - 1;
      index.set(key, index.has(key) ? null : row);
    }
    return index;
  }

  function growth(data, statement, field) {
    const { stride, count, minDays, maxDays, frequency } = context.cadence(data, statement);
    const rows = data?.quarterly?.[statement];
    const income = data?.quarterly?.income;
    const result = { value: null, date: null, previousDate: null, reason: null };
    const unavailable = reason => ({ ...result, reason });
    if (frequency === 'annual') return unavailable('annualCashflowOnly');
    if (!Array.isArray(rows) || !Array.isArray(income)) return unavailable('missingPeriod');
    const anchors = indexRows(income);
    const index = statement === 'income' ? anchors : indexRows(rows);
    const key = Math.max(...anchors.keys());
    const latest = anchors.get(key);
    result.date = latest?.date || null;
    result.previousDate = anchors.get(key - 4)?.date || null;
    const keys = Array.from({ length: count * 2 }, (_, i) => key - (count * 2 - 1 - i) * stride);
    const history = keys.map(key => index.get(key));
    if (!latest || history.some(row => !row)) {
      return unavailable(keys.some(key => index.has(key) && index.get(key) === null) || anchors.get(key) === null
        ? 'ambiguousPeriod' : 'missingPeriod');
    }
    if (history.some((row, i) => i && ((Date.parse(row.date) - Date.parse(history[i - 1].date)) / 86400000 < minDays
      || (Date.parse(row.date) - Date.parse(history[i - 1].date)) / 86400000 > maxDays))) return unavailable('nonConsecutive');
    if (history.some((row, i) => row.date !== anchors.get(keys[i])?.date)) return unavailable('dateMismatch');
    if (history.some(row => row.periodLength !== undefined && row.periodLength !== stride * 3)) return unavailable('invalidPeriodLength');
    if (new Set(history.map(row => row.comparabilityGroup).filter(Boolean)).size > 1) return unavailable('accountingBasisMismatch');
    if (history.some(row => row.currencyConversion?.reason)) return unavailable('missingFx');
    if (history.some(row => !/^[A-Z]{3}$/.test(row.reportedCurrency) || row.reportedCurrency !== latest.reportedCurrency)) {
      return unavailable('currencyMismatch');
    }
    if (history.some(row => numeric(row[field]) === null)) return unavailable('missingField');
    const previous = history.slice(0, count).reduce((sum, row) => sum + numeric(row[field]), 0);
    const present = history.slice(count).reduce((sum, row) => sum + numeric(row[field]), 0);
    if (previous <= 0) return unavailable('nonPositivePrior');
    const value = (present / previous - 1) * 100;
    return Number.isFinite(value) ? { ...result, value } : unavailable('missingField');
  }

  function annualGrowth(data, statement, field) {
    const rows = data?.annual?.[statement] || [];
    const present = rows.at(-1), previous = rows.at(-2);
    const result = { value: null, date: present?.date || null, previousDate: previous?.date || null,
      reason: null, basis: 'annual' };
    const unavailable = reason => ({ ...result, reason });
    if (!present || !previous) return unavailable('missingPeriod');
    if ([present, previous].some(row => !/^\d{4}-\d{2}-\d{2}$/.test(row.date)
        || !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0, 10) !== row.date)) {
      return unavailable('dateMismatch');
    }
    const days = (Date.parse(present.date) - Date.parse(previous.date)) / 86400000;
    if (!(days >= 330 && days <= 400)) return unavailable('nonConsecutive');
    if ([present, previous].some(row => row.periodLength !== undefined && row.periodLength !== 12)) return unavailable('invalidPeriodLength');
    if (present.comparabilityGroup && previous.comparabilityGroup
        && present.comparabilityGroup !== previous.comparabilityGroup) return unavailable('accountingBasisMismatch');
    if (present.currencyConversion?.reason || previous.currencyConversion?.reason) return unavailable('missingFx');
    if (!/^[A-Z]{3}$/.test(present.reportedCurrency) || present.reportedCurrency !== previous.reportedCurrency) {
      return unavailable('currencyMismatch');
    }
    const a = numeric(previous[field]), b = numeric(present[field]);
    if (a === null || b === null) return unavailable('missingField');
    if (a <= 0) return unavailable('nonPositivePrior');
    const value = (b / a - 1) * 100;
    return Number.isFinite(value) ? { ...result, value } : unavailable('missingField');
  }

  const growthFields = {
    revenue: 'income', grossProfit: 'income', operatingIncome: 'income', netIncome: 'income',
    ebitda: 'income', epsDiluted: 'income', operatingCashFlow: 'cashflow', freeCashFlow: 'cashflow'
  };

  // Build the same reported_growth payload peers/profile store; data must already be FX-normalized.
  function buildReportedGrowth(data, options = {}) {
    const normalized = industryApi && (options.industry || options.ticker)
      ? industryApi.normalizeBankStatements(data, options.industry, options.ticker)
      : data;
    return {
      version: 1,
      currency: normalized.calculationCurrency || 'USD',
      basis: 'TTM versus prior-year TTM',
      date: calculate(normalized).date,
      ...(context.cadence(normalized, 'cashflow').frequency === 'annual'
        ? { annualDate: normalized.annual?.cashflow?.at(-1)?.date || null } : {}),
      fields: Object.fromEntries(Object.entries(growthFields).map(([field, statement]) => [field,
        context.cadence(normalized, statement).frequency === 'annual'
          ? annualGrowth(normalized, statement, field)
          : growth(normalized, statement, field)]))
    };
  }

  function storedGrowth(stock, field) {
    const record = stock?.reported_growth;
    const result = record?.fields?.[field];
    if (record?.version !== 1 || record.currency !== (stock.calculationCurrency || 'USD') || !result) return null;
    if (result.basis === 'annual') {
      if (result.date !== record.annualDate || result.date > record.date) return null;
    } else if (result.date !== record.date) return null;
    const latest = stock.statements_raw?.annual_dates?.at(-1);
    if (latest && record.date?.slice(0, 7) !== latest.slice(0, 7)) return null;
    return result;
  }

  function calculate(data) {
    const { stride, count, minDays, maxDays } = context.cadence(data);
    const rows = data?.quarterly?.income;
    if (!Array.isArray(rows)) throw new TypeError('Missing quarterly income statements');
    const index = indexRows(rows);
    const key = Math.max(...index.keys());
    const latest = index.get(key);
    const window = Array.from({ length: count }, (_, i) => index.get(key - (count - 1 - i) * stride));
    const valid = rows => latest && rows.every((row, i) => row && typeof row.reportedCurrency === 'string'
      && /^[A-Z]{3}$/.test(row.reportedCurrency) && row.reportedCurrency === latest.reportedCurrency
      && !row.currencyConversion?.reason
      && (row.periodLength === undefined || row.periodLength === stride * 3)
      && (!i || (Date.parse(row.date) - Date.parse(rows[i - 1].date)) / 86400000 >= minDays
        && (Date.parse(row.date) - Date.parse(rows[i - 1].date)) / 86400000 <= maxDays));
    const total = (field, rows = window) => {
      if (!valid(rows) || new Set(rows.map(row => row?.comparabilityGroup).filter(Boolean)).size > 1
          || !rows.every(row => numeric(row[field]) !== null)) return null;
      const sum = rows.reduce((sum, row) => sum + numeric(row[field]), 0);
      return Number.isFinite(sum) ? sum : null;
    };
    const revenue = total('revenue');
    const divide = value => {
      const result = value === null || revenue === null || revenue === 0 ? null : value / revenue * 100;
      return Number.isFinite(result) ? result : null;
    };
    return {
      date: latest?.date || null, currency: latest?.reportedCurrency || null,
      revenue, grossMargin: divide(total('grossProfit')), operatingMargin: divide(total('operatingIncome')),
      netMargin: divide(total(window.some(row => row?.earningsIncludeDiscontinued) ? 'netIncomeFromContinuingOperations' : 'netIncome')),
      revenueGrowth: growth(data, 'income', 'revenue').value,
      operatingGrowth: growth(data, 'income', 'operatingIncome').value,
      netIncomeGrowth: growth(data, 'income', 'netIncome').value
    };
  }

  let requestId = 0;
  let current;
  let bound = false;
  const get = suffix => document.getElementById(`profile-${suffix}`);
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  function deactivate() { requestId++; }

  async function render(ticker, stock, lang, labels, reload = false) {
    current = { ticker, stock, lang, labels };
    if (!bound) {
      get('overview-retry').addEventListener('click', () => render(current.ticker, current.stock, current.lang, current.labels, true));
      bound = true;
    }
    const id = ++requestId;
    const locale = lang === 'zh' ? 'zh-TW' : 'en-US';
    const format = (value, unit = '', digits = 2) => numeric(value) === null ? 'N/A'
      : `${Number(value).toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: 2 })}${unit}`;
    const usd = value => numeric(value) === null ? 'N/A' : `${context.currencyFor(ticker, stock)} ${format(value)}`;
    get('quote-price').textContent = usd(stock.price);
    get('quote-ticker').textContent = `${ticker} · ${stock.exchange || 'N/A'}`;
    if (stock.businessScopeNote) get('quote-ticker').textContent += ` · ${stock.businessScopeNote[lang] || stock.businessScopeNote.en}`;
    if (stock.quoteAvailability?.reason === 'staleQuote' && stock.lastTrade) {
      get('quote-ticker').textContent += lang === 'zh'
        ? ` · 現價不可用；最後成交 ${stock.lastTrade.date}：${usd(stock.lastTrade.price)}（非現價）`
        : ` · Current price unavailable; last trade ${stock.lastTrade.date}: ${usd(stock.lastTrade.price)} (not current)`;
    }
    get('range-low').textContent = usd(stock.year_low);
    get('range-high').textContent = usd(stock.year_high);
    const low = numeric(stock.year_low), high = numeric(stock.year_high), price = numeric(stock.price);
    const availableRange = low !== null && high !== null && price !== null && high > low;
    get('range-dot').hidden = !availableRange;
    if (availableRange) get('range-dot').style.left = `${Math.max(0, Math.min(100, (price - low) / (high - low) * 100))}%`;
    get('overview-status').textContent = labels.fcf_loading;
    get('overview-retry').hidden = true;

    const group = (title, items) => {
      const panel = node('section', undefined, 'profile-metric-group');
      const heading = node('h3', labels[title]);
      const table = node('table', undefined, 'profile-metric-table');
      const body = node('tbody');
      for (const [label, value, title] of items) {
        const row = node('tr');
        const cell = node('th', labels[label]);
        cell.scope = 'row';
        const amount = node('td', value, value.endsWith(' !') ? 'text-gold' : value.startsWith('-') ? 'text-red' : '');
        if (title || value === 'N/A') amount.title = title || labels.profile_source_note;
        row.append(cell, amount);
        body.append(row);
      }
      table.append(body);
      panel.append(heading, table);
      get('overview-groups').append(panel);
    };
    const draw = (summary, returns) => {
      const returnCell = (metric, label) => {
        const ratio = returns?.ratios[metric];
        const messages = ratio
          ? (ratio.reason ? [ratio.reason] : ratio.warnings).map(reason => labels[`returns_reason_${reason}`] || labels[`fcf_reason_${reason}`])
          : [];
        return [label, `${format(ratio?.value, '%')}${ratio?.warnings.length ? ' !' : ''}`, messages.join(' ')];
      };
      get('overview-groups').replaceChildren();
      const betaResult = Beta?.lastResult?.get(ticker);
      const betaValue = betaResult && betaResult.mode !== Beta.PROVIDER
        ? betaResult.beta : context.fcff()?.betaSources?.[ticker]?.value;
      const betaTitle = betaResult?.reason
        ? (labels[`beta_reason_${betaResult.reason}`] || Beta.reasonText(betaResult.reason, lang))
        : (betaResult && betaResult.mode !== Beta.PROVIDER
          ? Beta.statusText(betaResult, lang) : labels.profile_beta_default_note || '');
      group('profile_market', [
        ['profile_high', usd(stock.year_high)], ['profile_low', usd(stock.year_low)],
        ['profile_beta', format(betaValue, '', 6), betaTitle],
        ['profile_div_yield', format(stock.div_yield, '%')]
      ]);
      group('profile_capital', [
        ['profile_market_cap', usd(stock.mcap)], ['profile_ev', usd(stock.ev)],
        ['profile_shares', format(stock.shares)], ['profile_net_debt', usd(stock.net_debt)]
      ]);
      group('profile_efficiency', [
        ['profile_gross_margin', format(summary?.grossMargin, '%')],
        ['profile_operating_margin', format(summary?.operatingMargin, '%')],
        ['profile_net_margin', format(summary?.netMargin, '%')],
        returnCell('roa', 'profile_roa'), returnCell('roe', 'profile_roe')
      ]);
      group('profile_valuation', [
        ['profile_pe', format(stock.pe_trailing, '×')],
        ['profile_forward_pe', format(stock.pe_forward, '×'),
          stock.pe_forward_source?.[lang === 'en' ? 'noteEn' : 'noteZh'] || stock.pe_forward_source?.reason || ''],
        ['profile_pb', format(stock.pb_trailing, '×')], ['profile_ev_ebitda', format(stock.ev_to_ebitda, '×')]
      ]);
      group('profile_growth', [
        ['profile_revenue_growth', format(summary?.revenueGrowth, '%')],
        ['profile_operating_growth', format(summary?.operatingGrowth, '%')],
        ['profile_income_growth', format(summary?.netIncomeGrowth, '%')]
      ]);
    };
    draw(null, null);
    try {
      const loaded = await FcfRatios.loadStatements(ticker, reload);
      if (id !== requestId) return;
      const data = industryApi
        ? industryApi.normalizeBankStatements(loaded, stock.industry, ticker)
        : loaded;
      labels = context.localize(get('overview-groups').parentElement, labels, data);
      context.renderProvenance(get('overview-groups').parentElement, data, ticker);
      const summary = calculate(data);
      const returns = FcfRatios.calculateReturns(data).at(-1);
      draw(summary, returns?.date === summary.date ? returns : null);
      get('overview-status').textContent = `${ticker} · ${labels.profile_statement_basis} · ${summary.date || 'N/A'} · ${summary.currency || 'N/A'}`;
    } catch (error) {
      if (id !== requestId) return;
      console.error('Company overview financial statements could not be loaded', ticker, error);
      get('overview-status').textContent = labels.fcf_error;
      get('overview-retry').hidden = false;
    }
  }
  return { calculate, growth, annualGrowth, buildReportedGrowth, growthFields, storedGrowth, render, deactivate };
});
