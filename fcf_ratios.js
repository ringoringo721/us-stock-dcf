(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FcfRatios = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const metrics = ['equity', 'assets', 'sales', 'ebitda'];
  const dayMs = 86400000;

  function numeric(value) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  }

  function indexRows(rows, annual) {
    const index = new Map();
    for (const row of rows) {
      if (!row || !validDate(row.date)) continue;
      const year = Number(row.fiscalYear || row.calendarYear);
      const quarter = /^Q[1-4]$/.test(row.period) ? Number(row.period[1]) : null;
      if (!Number.isInteger(year) || year < 1900 || year > 9999) continue;
      if (annual ? row.period !== 'FY' : quarter === null) continue;
      const key = annual ? year : year * 4 + quarter - 1;
      // Ambiguous duplicate fiscal periods must not silently pick a statement.
      index.set(key, index.has(key) ? null : row);
    }
    return index;
  }

  function unavailable(reason) {
    return { value: null, reason, warnings: [] };
  }

  function sameCurrency(rows) {
    const currencies = rows.map(row => row.reportedCurrency);
    return currencies.every(value => typeof value === 'string' && value.length > 0)
      && new Set(currencies).size === 1;
  }

  function calculate(data, options = {}) {
    const { period = 'quarterly', flow = 'ttm', balance = 'beginning' } = options;
    if (!['quarterly', 'annual'].includes(period) || !['single', 'ttm'].includes(flow)
        || !['beginning', 'ending', 'average'].includes(balance)) {
      throw new RangeError('Invalid FCF ratio options');
    }
    const annual = period === 'annual';
    const source = data && data[period];
    if (!source || !['income', 'balance', 'cashflow'].every(key => Array.isArray(source[key]))) {
      throw new TypeError('Missing financial statement arrays');
    }
    const income = indexRows(source.income, annual);
    const balances = indexRows(source.balance, annual);
    const cashflow = indexRows(source.cashflow, annual);
    const keys = [...new Set([...income.keys(), ...cashflow.keys()])].sort((a, b) => a - b);
    const windowSize = !annual && flow === 'ttm' ? 4 : 1;

    return keys.map(key => {
      const end = cashflow.get(key);
      const labelRow = end || income.get(key);
      const year = annual ? key : Math.floor(key / 4);
      const label = annual ? `FY ${year}` : `FY ${year} Q${key % 4 + 1}`;
      const column = { label, date: labelRow ? labelRow.date : '', ratios: {} };
      const window = Array.from({ length: windowSize }, (_, i) => cashflow.get(key - windowSize + 1 + i));
      let issue = null;
      if (window.some(row => !row)) issue = windowSize === 4 ? 'incompleteTtm' : 'missingFcf';
      else if (window.some((row, i) => i > 0 && (
        (Date.parse(row.date) - Date.parse(window[i - 1].date)) / dayMs < 60
        || (Date.parse(row.date) - Date.parse(window[i - 1].date)) / dayMs > 120
      ))) issue = 'nonConsecutive';
      else if (window.some(row => numeric(row.freeCashFlow) === null)) issue = 'missingFcf';
      else if (!sameCurrency(window)) issue = 'currencyMismatch';
      if (issue) {
        for (const metric of metrics) column.ratios[metric] = unavailable(issue);
        return column;
      }
      const fcf = window.reduce((total, row) => total + numeric(row.freeCashFlow), 0);

      for (const metric of metrics) {
        let denominator;
        let denominatorRows;
        let denominatorValues;
        if (metric === 'sales' || metric === 'ebitda') {
          const rows = window.map(row => {
            const rowKey = annual ? Number(row.fiscalYear || row.calendarYear)
              : Number(row.fiscalYear || row.calendarYear) * 4 + Number(row.period[1]) - 1;
            return income.get(rowKey);
          });
          if (rows.some(row => !row)) issue = 'missingIncome';
          else if (rows.some((row, i) => row.date !== window[i].date)) issue = 'dateMismatch';
          else {
            denominatorValues = rows.map(row => numeric(row[metric === 'sales' ? 'revenue' : 'ebitda']));
            if (denominatorValues.some(value => value === null)) issue = 'missingDenominator';
            else {
              denominator = denominatorValues.reduce((total, value) => total + value, 0);
              denominatorRows = rows;
            }
          }
        } else {
          const closing = balances.get(key);
          const opening = balances.get(key - windowSize);
          const field = metric === 'equity' ? 'totalStockholdersEquity' : 'totalAssets';
          const needsOpening = balance !== 'ending';
          const needsClosing = balance !== 'beginning';
          if (needsOpening && !opening) issue = 'missingOpening';
          else if (needsClosing && !closing) issue = 'missingDenominator';
          else if (needsClosing && closing.date !== end.date) issue = 'dateMismatch';
          else if (needsOpening) {
            const days = (Date.parse(end.date) - Date.parse(opening.date)) / dayMs;
            const previousFlow = cashflow.get(key - windowSize);
            const longPeriod = annual || windowSize === 4;
            if (days < (longPeriod ? 300 : 60) || days > (longPeriod ? 430 : 120)
                || (previousFlow && previousFlow.date !== opening.date)) issue = 'dateMismatch';
          }
          if (!issue) {
            denominatorRows = balance === 'beginning' ? [opening]
              : balance === 'ending' ? [closing] : [opening, closing];
            denominatorValues = denominatorRows.map(row => numeric(row[field]));
            if (denominatorValues.some(value => value === null)) {
              issue = balance === 'beginning' ? 'missingOpening' : 'missingDenominator';
            } else denominator = denominatorValues.reduce((sum, value) => sum + value, 0) / denominatorValues.length;
          }
        }
        if (!issue && !sameCurrency([...window, ...denominatorRows])) issue = 'currencyMismatch';
        if (!issue && denominator === 0) issue = 'zeroDenominator';
        const value = !issue ? fcf / denominator * 100 : null;
        if (!issue && !Number.isFinite(value)) issue = 'invalidValue';
        const warnings = [];
        if (fcf < 0) warnings.push('negativeFcf');
        if (denominatorValues && denominatorValues.some(number => number < 0)) {
          warnings.push({ equity: 'negativeEquity', assets: 'negativeAssets',
            sales: 'negativeSales', ebitda: 'negativeEbitda' }[metric]);
        }
        column.ratios[metric] = issue ? unavailable(issue) : { value, reason: null, warnings };
        issue = null;
      }
      return column;
    });
  }

  const cache = new Map();
  let current = null;
  let requestId = 0;
  let bound = false;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  async function render(ticker, lang, labels) {
    const panel = document.getElementById('fcf-ratio-panel');
    if (!panel) return;
    current = { ticker, lang, labels };
    if (!bound) {
      panel.addEventListener('change', () => render(current.ticker, current.lang, current.labels));
      document.getElementById('fcf-ratio-retry').addEventListener('click', () => render(current.ticker, current.lang, current.labels));
      bound = true;
    }
    const id = ++requestId;
    const period = document.getElementById('fcf-ratio-period').value;
    const flow = document.getElementById('fcf-ratio-flow').value;
    const balance = document.getElementById('fcf-ratio-balance').value;
    document.getElementById('fcf-ratio-flow').disabled = period === 'annual';
    const selected = metrics.filter(metric => document.getElementById(`fcf-ratio-${metric}`).checked);
    document.getElementById('fcf-ratio-balance').disabled = !selected.some(metric => metric === 'equity' || metric === 'assets');
    const head = document.getElementById('fcf-ratio-head');
    const body = document.getElementById('fcf-ratio-body');
    const status = document.getElementById('fcf-ratio-status');
    const notes = document.getElementById('fcf-ratio-notes');
    const retry = document.getElementById('fcf-ratio-retry');
    head.replaceChildren();
    body.replaceChildren();
    notes.replaceChildren();
    retry.hidden = true;
    if (!selected.length) {
      status.textContent = labels.fcf_select_ratio;
      return;
    }
    status.textContent = labels.fcf_loading;
    try {
      if (!cache.has(ticker)) {
        const pending = fetch(`cache/financials/${encodeURIComponent(ticker)}_statements_v2.json`)
          .then(response => {
            if (!response.ok) throw new Error(`Financial statements HTTP ${response.status}`);
            return response.json();
          }).catch(error => {
            cache.delete(ticker);
            throw error;
          });
        cache.set(ticker, pending);
      }
      const data = await cache.get(ticker);
      if (id !== requestId) return;
      const columns = calculate(data, { period, flow, balance });
      const explanation = period === 'annual' ? labels.fcf_annual
        : flow === 'ttm' ? labels.fcf_ttm : labels.fcf_single;
      status.textContent = `${ticker} · ${explanation} · ${labels[`fcf_${balance}`]}`;
      if (!columns.length) {
        status.textContent = labels.fcf_no_periods;
        return;
      }
      const heading = element('tr');
      const first = element('th', labels.fcf_metric, 'table-sticky-col');
      first.scope = 'col';
      heading.append(first);
      for (const column of columns) {
        const cell = element('th');
        cell.scope = 'col';
        cell.append(element('div', column.label), element('div', column.date, 'th-period-subdate'));
        heading.append(cell);
      }
      head.append(heading);
      const explanations = new Set();
      for (const metric of selected) {
        const row = element('tr');
        const name = element('th', labels[`fcf_${metric}`], 'table-sticky-col');
        name.scope = 'row';
        row.append(name);
        for (const column of columns) {
          const ratio = column.ratios[metric];
          const text = ratio.value === null ? 'N/A' : `${ratio.value.toFixed(2)}%`;
          const messages = ratio.reason ? [labels[`fcf_reason_${ratio.reason}`]] : ratio.warnings.map(warning => labels[`fcf_reason_${warning}`]);
          messages.forEach(message => explanations.add(message));
          const cell = element('td', text + (ratio.warnings.length ? ' !' : ''));
          if (messages.length) {
            cell.title = messages.join('; ');
            cell.setAttribute('aria-label', `${text}: ${messages.join('; ')}`);
          }
          if (ratio.warnings.length) cell.className = 'text-gold';
          row.append(cell);
        }
        body.append(row);
      }
      for (const message of explanations) notes.append(element('li', message));
    } catch (error) {
      if (id !== requestId) return;
      cache.delete(ticker);
      console.error('FCF ratio statements could not be loaded', ticker, error);
      status.textContent = labels.fcf_error;
      retry.hidden = false;
    }
  }

  return { calculate, render };
});
