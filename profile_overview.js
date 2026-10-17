(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProfileOverview = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const numeric = value => ((typeof value === 'number' || typeof value === 'string' && value.trim())
    && Number.isFinite(Number(value))) ? Number(value) : null;

  function calculate(data) {
    const rows = data?.quarterly?.income;
    if (!Array.isArray(rows)) throw new TypeError('Missing quarterly income statements');
    const index = new Map();
    for (const row of rows) {
      const year = Number(row.fiscalYear || row.calendarYear);
      if (!Number.isInteger(year) || !/^Q[1-4]$/.test(row.period)
          || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(Date.parse(row.date))
          || new Date(row.date).toISOString().slice(0, 10) !== row.date) continue;
      const key = year * 4 + Number(row.period[1]) - 1;
      index.set(key, index.has(key) ? null : row);
    }
    const key = Math.max(...index.keys());
    const latest = index.get(key);
    const window = Array.from({ length: 4 }, (_, i) => index.get(key - 3 + i));
    const valid = rows => latest && rows.every((row, i) => row && typeof row.reportedCurrency === 'string'
      && /^[A-Z]{3}$/.test(row.reportedCurrency) && row.reportedCurrency === latest.reportedCurrency
      && (!i || (Date.parse(row.date) - Date.parse(rows[i - 1].date)) / 86400000 >= 60
        && (Date.parse(row.date) - Date.parse(rows[i - 1].date)) / 86400000 <= 120));
    const total = (field, rows = window) => {
      if (!valid(rows) || !rows.every(row => numeric(row[field]) !== null)) return null;
      const sum = rows.reduce((sum, row) => sum + numeric(row[field]), 0);
      return Number.isFinite(sum) ? sum : null;
    };
    const revenue = total('revenue');
    const divide = value => {
      const result = value === null || revenue === null || revenue === 0 ? null : value / revenue * 100;
      return Number.isFinite(result) ? result : null;
    };
    const history = Array.from({ length: 8 }, (_, i) => index.get(key - 7 + i));
    const growth = field => {
      if (!valid(history)) return null;
      const present = total(field);
      const previous = total(field, history.slice(0, 4));
      if (present === null || previous === null || previous <= 0) return null;
      const result = (present / previous - 1) * 100;
      return Number.isFinite(result) ? result : null;
    };
    return {
      date: latest?.date || null, currency: latest?.reportedCurrency || null,
      revenue, grossMargin: divide(total('grossProfit')), operatingMargin: divide(total('operatingIncome')),
      netMargin: divide(total('netIncome')),
      revenueGrowth: growth('revenue'), operatingGrowth: growth('operatingIncome'), netIncomeGrowth: growth('netIncome')
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
    const format = (value, unit = '') => numeric(value) === null ? 'N/A'
      : `${Number(value).toLocaleString(locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}${unit}`;
    const usd = value => numeric(value) === null ? 'N/A' : `USD ${format(value)}`;
    get('quote-price').textContent = usd(stock.price);
    get('quote-ticker').textContent = `${ticker} · ${stock.exchange || 'N/A'}`;
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
      group('profile_market', [
        ['profile_high', usd(stock.year_high)], ['profile_low', usd(stock.year_low)],
        ['profile_beta', format(stock.beta_5y)], ['profile_div_yield', format(stock.div_yield, '%')]
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
        ['profile_pe', format(stock.pe_trailing, '×')], ['profile_forward_pe', format(stock.pe_forward, '×')],
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
      const data = await FcfRatios.loadStatements(ticker, reload);
      if (id !== requestId) return;
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
  return { calculate, render, deactivate };
});
