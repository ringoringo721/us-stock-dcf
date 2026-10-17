(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FcfRatios = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const metrics = ['equity', 'assets', 'sales', 'ebitda', 'netIncome'];
  const returnMetrics = ['roa', 'roe', 'rote'];
  const incomeFields = { sales: 'revenue', ebitda: 'ebitda', netIncome: 'netIncome' };
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

  function trend(values) {
    const valid = values.filter(value => typeof value === 'number' && Number.isFinite(value));
    if (!valid.length) return null;
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const points = values.map((value, i) => typeof value === 'number' && Number.isFinite(value) ? {
      x: 4 + (values.length > 1 ? i / (values.length - 1) : 0.5) * 100,
      y: max === min ? 16 : 4 + (max - value) / (max - min) * 24
    } : null);
    const segments = [];
    for (const point of points) {
      if (!point) {
        if (segments.length && segments[segments.length - 1].length) segments.push([]);
      } else {
        if (!segments.length) segments.push([]);
        segments[segments.length - 1].push(point);
      }
    }
    return {
      segments: segments.filter(segment => segment.length),
      last: points.filter(Boolean).at(-1),
      color: valid[valid.length - 1] >= valid[0] ? '#22c55e' : '#ef4444'
    };
  }

  function sameCurrency(rows) {
    const currencies = rows.map(row => row.reportedCurrency);
    return currencies.every(value => typeof value === 'string' && value.length > 0)
      && new Set(currencies).size === 1;
  }

  function calculate(data, options = {}) {
    return calculateRatios(data, options, false);
  }

  function calculateReturns(data, options = {}) {
    return calculateRatios(data, options, true);
  }

  function calculateBalances(data, { period = 'quarterly' } = {}) {
    if (!['quarterly', 'annual'].includes(period)) throw new RangeError('Invalid balance sheet period');
    if (!Array.isArray(data?.[period]?.balance)) throw new TypeError('Missing balance sheet array');
    const annual = period === 'annual';
    const rows = indexRows(data[period].balance, annual);
    const fields = {
      assets: 'totalAssets', currentAssets: 'totalCurrentAssets', nonCurrentAssets: 'totalNonCurrentAssets',
      cash: 'cashAndCashEquivalents', liabilities: 'totalLiabilities',
      currentLiabilities: 'totalCurrentLiabilities', nonCurrentLiabilities: 'totalNonCurrentLiabilities',
      equity: 'totalStockholdersEquity', tangibleEquity: null
    };
    const keys = [...rows.keys()].sort((a, b) => a - b);
    if (!keys.length) return [];
    return Array.from({ length: keys.at(-1) - keys[0] + 1 }, (_, index) => keys[0] + index).map(key => {
      const row = rows.get(key);
      const currency = row && typeof row.reportedCurrency === 'string' && /^[A-Z]{3}$/.test(row.reportedCurrency)
        ? row.reportedCurrency : null;
      const amounts = {};
      for (const [metric, field] of Object.entries(fields)) {
        const value = !row ? null : metric === 'tangibleEquity' ? balanceValue(row, 'rote') : numeric(row[field]);
        amounts[metric] = !row ? unavailable(rows.has(key) ? 'ambiguousPeriod' : 'missingPeriod')
          : row.currencyConversion?.reason ? unavailable('missingFx') : !currency ? unavailable('currencyMismatch')
          : value === null ? unavailable('missingField') : {
            value, reason: null,
            warnings: value < 0 ? [metric === 'equity' || metric === 'tangibleEquity' ? 'negativeEquity' : 'negativeBalance'] : []
          };
      }
      const ratio = (numerator, denominator, scale = 1) => {
        if (numerator.value === null) return unavailable(numerator.reason);
        if (denominator.value === null) return unavailable(denominator.reason);
        if (denominator.value === 0) return unavailable('zeroDenominator');
        const value = numerator.value / denominator.value * scale;
        return Number.isFinite(value)
          ? { value, reason: null, warnings: [...new Set([...numerator.warnings, ...denominator.warnings])] }
          : unavailable('invalidValue');
      };
      const year = annual ? key : Math.floor(key / 4);
      return {
        label: annual ? `FY ${year}` : `FY ${year} Q${key % 4 + 1}`,
        date: row?.date || null, currency, amounts,
        ratios: {
          currentRatio: ratio(amounts.currentAssets, amounts.currentLiabilities),
          liabilitiesRatio: ratio(amounts.liabilities, amounts.assets, 100),
          cashRatio: ratio(amounts.cash, amounts.currentLiabilities),
          leverage: ratio(amounts.assets, amounts.equity)
        }
      };
    });
  }

  function financialReference(data, { shares, fxRate = 1 } = {}) {
    if (fxRate !== 1 || data?.quarterly?.income?.some(row => row.reportedCurrency !== 'USD')) {
      throw new RangeError('Normalize financial statements with period-specific USD rates before valuation');
    }
    const columns = calculateReturns(data);
    const latest = columns.at(-1);
    if (!latest) throw new TypeError('No quarterly income statements for financial valuation');
    const income = indexRows(data.quarterly.income, false);
    const key = Math.max(...income.keys());
    const closing = indexRows(data.quarterly.balance, false).get(key);
    const incomeRow = income.get(key);
    let tbvps = null;
    let reason = latest.ratios.rote.reason;
    if (!closing || !incomeRow || closing.date !== incomeRow.date) reason = reason || 'dateMismatch';
    else if (!sameCurrency([closing, incomeRow])) reason = reason || 'currencyMismatch';
    else {
      const tangible = balanceValue(closing, 'rote');
      if (tangible === null) reason = reason || 'missingDenominator';
      else if (numeric(shares) === null || shares <= 0) {
        reason = reason || 'invalidSharesOrCurrency';
      } else {
        tbvps = tangible / (shares * 1e6);
        if (tbvps <= 0) reason = reason || 'nonPositiveTangibleEquity';
      }
    }
    return {
      date: latest.date, label: latest.label, period: 'quarterly', flow: 'ttm', balance: 'beginning',
      rote: latest.ratios.rote.value, warnings: latest.ratios.rote.warnings, tbvps, reason
    };
  }

  function calculateEarnings(data, { period = 'quarterly', flow = 'ttm' } = {}) {
    if (!['quarterly', 'annual'].includes(period) || !['single', 'ttm'].includes(flow)) {
      throw new RangeError('Invalid earnings trend options');
    }
    const source = data?.[period];
    if (!Array.isArray(source?.income) || !Array.isArray(source?.cashflow)) {
      throw new TypeError('Missing earnings statement arrays');
    }
    const annual = period === 'annual';
    const income = indexRows(source.income, annual);
    const cashflow = indexRows(source.cashflow, annual);
    const keys = [...new Set([...income.keys(), ...cashflow.keys()])].sort((a, b) => a - b);
    if (!keys.length) return [];
    const count = !annual && flow === 'ttm' ? 4 : 1;
    return Array.from({ length: keys.at(-1) - keys[0] + 1 }, (_, i) => keys[0] + i).map(key => {
      const end = income.get(key) || cashflow.get(key);
      const column = {
        label: annual ? `FY ${key}` : `FY ${Math.floor(key / 4)} Q${key % 4 + 1}`,
        date: end?.date || null, currency: end?.reportedCurrency || null, amounts: {}
      };
      for (const [metric, index, field] of [
        ['eps', income, 'epsDiluted'], ['fcf', cashflow, 'freeCashFlow'],
        ['dividend', cashflow, 'commonDividendsPaid']
      ]) {
        const rows = Array.from({ length: count }, (_, i) => index.get(key - count + 1 + i));
        let reason = null;
        if (rows.some(row => !row)) reason = count === 4 ? 'incompleteTtm' : 'missingPeriod';
        else if (rows.some((row, i) => i > 0 && (
          (Date.parse(row.date) - Date.parse(rows[i - 1].date)) / dayMs < 60
          || (Date.parse(row.date) - Date.parse(rows[i - 1].date)) / dayMs > 120
        ))) reason = 'nonConsecutive';
        else if (rows.some(row => {
          const rowKey = annual ? Number(row.fiscalYear || row.calendarYear)
            : Number(row.fiscalYear || row.calendarYear) * 4 + Number(row.period[1]) - 1;
          const other = (metric === 'eps' ? cashflow : income).get(rowKey);
          return other && other.date !== row.date;
        })) reason = 'dateMismatch';
        else if (rows.some(row => row.currencyConversion?.reason)) reason = 'missingFx';
        else if (!sameCurrency(rows) || rows.some(row => row.reportedCurrency !== column.currency)) reason = 'currencyMismatch';
        else if (rows.some(row => numeric(row[field]) === null)) reason = 'missingField';
        let denominator = 1;
        if (!reason && metric !== 'eps') {
          const shareRows = Array.from({ length: count }, (_, i) => income.get(key - count + 1 + i));
          if (shareRows.some(row => !row || numeric(row.weightedAverageShsOutDil) === null)) reason = 'missingDilutedShares';
          else if (shareRows.some((row, i) => row.date !== rows[i].date)) reason = 'dateMismatch';
          else if (!sameCurrency([...rows, ...shareRows])) reason = 'currencyMismatch';
          else if (shareRows.some(row => numeric(row.weightedAverageShsOutDil) <= 0)) reason = 'invalidDilutedShares';
          else denominator = shareRows.reduce((sum, row) => sum + numeric(row.weightedAverageShsOutDil), 0) / count;
        }
        const value = reason ? null : rows.reduce((sum, row) => sum + numeric(row[field]), 0)
          / denominator * (metric === 'dividend' ? -1 : 1);
        column.amounts[metric] = reason ? unavailable(reason) : !Number.isFinite(value)
          ? unavailable('invalidValue') : { value: value === 0 ? 0 : value, reason: null, warnings: [] };
      }
      return column;
    });
  }

  function balanceValue(row, metric) {
    if (metric !== 'rote') {
      return numeric(row[metric === 'equity' || metric === 'roe' ? 'totalStockholdersEquity' : 'totalAssets']);
    }
    const equity = numeric(row.totalStockholdersEquity);
    let intangibles = numeric(row.goodwillAndIntangibleAssets);
    if (intangibles === null) {
      const goodwill = numeric(row.goodwill);
      const otherIntangibles = numeric(row.intangibleAssets);
      if (goodwill === null || otherIntangibles === null) return null;
      intangibles = goodwill + otherIntangibles;
    }
    return equity === null ? null : equity - intangibles;
  }

  function calculateRatios(data, options, returns) {
    const selectedMetrics = returns ? returnMetrics : metrics;
    const numeratorField = returns ? 'netIncome' : 'freeCashFlow';
    const missingNumerator = returns ? 'missingNetIncome' : 'missingFcf';
    const { period = 'quarterly', flow = 'ttm', balance = 'beginning' } = options;
    if (!['quarterly', 'annual'].includes(period) || !['single', 'ttm'].includes(flow)
        || !['beginning', 'ending', 'average'].includes(balance)) {
      throw new RangeError('Invalid financial ratio options');
    }
    const annual = period === 'annual';
    const source = data && data[period];
    const required = returns ? ['income', 'balance'] : ['income', 'balance', 'cashflow'];
    if (!source || !required.every(key => Array.isArray(source[key]))) {
      throw new TypeError('Missing financial statement arrays');
    }
    const income = indexRows(source.income, annual);
    const balances = indexRows(source.balance, annual);
    const flows = returns ? income : indexRows(source.cashflow, annual);
    const keys = [...new Set([...income.keys(), ...flows.keys()])].sort((a, b) => a - b);
    const windowSize = !annual && flow === 'ttm' ? 4 : 1;

    return keys.map(key => {
      const end = flows.get(key);
      const labelRow = end || income.get(key);
      const year = annual ? key : Math.floor(key / 4);
      const label = annual ? `FY ${year}` : `FY ${year} Q${key % 4 + 1}`;
      const column = { label, date: labelRow ? labelRow.date : '', ratios: {} };
      const window = Array.from({ length: windowSize }, (_, i) => flows.get(key - windowSize + 1 + i));
      let issue = null;
      if (window.some(row => !row)) issue = windowSize === 4 ? 'incompleteTtm' : missingNumerator;
      else if (window.some((row, i) => i > 0 && (
        (Date.parse(row.date) - Date.parse(window[i - 1].date)) / dayMs < 60
        || (Date.parse(row.date) - Date.parse(window[i - 1].date)) / dayMs > 120
      ))) issue = 'nonConsecutive';
      else if (window.some(row => row.currencyConversion?.reason)) issue = 'missingFx';
      else if (window.some(row => numeric(row[numeratorField]) === null)) issue = missingNumerator;
      else if (!sameCurrency(window)) issue = 'currencyMismatch';
      if (issue) {
        for (const metric of selectedMetrics) column.ratios[metric] = unavailable(issue);
        return column;
      }
      const numerator = window.reduce((total, row) => total + numeric(row[numeratorField]), 0);

      for (const metric of selectedMetrics) {
        let denominator;
        let denominatorRows;
        let denominatorValues;
        if (incomeFields[metric]) {
          const rows = window.map(row => {
            const rowKey = annual ? Number(row.fiscalYear || row.calendarYear)
              : Number(row.fiscalYear || row.calendarYear) * 4 + Number(row.period[1]) - 1;
            return income.get(rowKey);
          });
          if (rows.some(row => !row)) issue = 'missingIncome';
          else if (rows.some((row, i) => row.date !== window[i].date)) issue = 'dateMismatch';
          else if (rows.some(row => row.currencyConversion?.reason)) issue = 'missingFx';
          else {
            denominatorValues = rows.map(row => numeric(row[incomeFields[metric]]));
            if (denominatorValues.some(value => value === null)) issue = 'missingDenominator';
            else {
              denominator = denominatorValues.reduce((total, value) => total + value, 0);
              denominatorRows = rows;
            }
          }
        } else {
          const closing = balances.get(key);
          const opening = balances.get(key - windowSize);
          const needsOpening = balance !== 'ending';
          const needsClosing = balance !== 'beginning';
          if (needsOpening && !opening) issue = 'missingOpening';
          else if (needsClosing && !closing) issue = 'missingDenominator';
          else if (needsClosing && closing.date !== end.date) issue = 'dateMismatch';
          else if (needsOpening) {
            const days = (Date.parse(end.date) - Date.parse(opening.date)) / dayMs;
            const previousFlow = flows.get(key - windowSize);
            const longPeriod = annual || windowSize === 4;
            if (days < (longPeriod ? 300 : 60) || days > (longPeriod ? 430 : 120)
                || (previousFlow && previousFlow.date !== opening.date)) issue = 'dateMismatch';
          }
          if (!issue) {
            denominatorRows = balance === 'beginning' ? [opening]
              : balance === 'ending' ? [closing] : [opening, closing];
            denominatorValues = denominatorRows.map(row => balanceValue(row, metric));
            if (denominatorRows.some(row => row.currencyConversion?.reason)) issue = 'missingFx';
            else if (denominatorValues.some(value => value === null)) {
              issue = balance === 'beginning' ? 'missingOpening' : 'missingDenominator';
            } else denominator = denominatorValues.reduce((sum, value) => sum + value, 0) / denominatorValues.length;
          }
        }
        if (!issue && !sameCurrency([...window, ...denominatorRows])) issue = 'currencyMismatch';
        if (!issue && denominator === 0) issue = 'zeroDenominator';
        const value = !issue ? numerator / denominator * 100 : null;
        if (!issue && !Number.isFinite(value)) issue = 'invalidValue';
        const warnings = [];
        if (numerator < 0) warnings.push(returns ? 'negativeNetIncome' : 'negativeFcf');
        if (denominatorValues && denominatorValues.some(number => number < 0)) {
          warnings.push({ equity: 'negativeEquity', assets: 'negativeAssets',
            sales: 'negativeSales', ebitda: 'negativeEbitda', netIncome: 'negativeNetIncome',
            roa: 'negativeAssets', roe: 'negativeEquity', rote: 'negativeTangibleEquity' }[metric]);
        }
        column.ratios[metric] = issue ? unavailable(issue) : { value, reason: null, warnings };
        issue = null;
      }
      return column;
    });
  }

  const cache = new Map();
  function loadStatements(ticker, reload = false) {
    if (reload) cache.delete(ticker);
    if (!cache.has(ticker)) {
      const pending = fetch(`cache/financials/${encodeURIComponent(ticker)}_statements_v2.json`)
        .then(response => {
          if (!response.ok) throw new Error(`Financial statements HTTP ${response.status}`);
          return response.json();
        }).then(data => UsdCurrency.normalize(data, reload)).catch(error => {
          if (cache.get(ticker) === pending) cache.delete(ticker);
          throw error;
        });
      cache.set(ticker, pending);
    }
    return cache.get(ticker);
  }
  const panels = {
    fcf: { prefix: 'fcf-ratio', metrics, calculate, current: null, requestId: 0, bound: false },
    returns: { prefix: 'return-ratio', metrics: returnMetrics, calculate: calculateReturns, current: null, requestId: 0, bound: false }
  };

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  async function render(ticker, lang, labels) {
    return renderPanel('fcf', ticker, lang, labels);
  }

  async function renderReturns(ticker, lang, labels) {
    return renderPanel('returns', ticker, lang, labels);
  }

  async function renderPanel(kind, ticker, lang, labels) {
    const state = panels[kind];
    const getElement = suffix => document.getElementById(`${state.prefix}-${suffix}`);
    const reasonLabel = reason => labels[`${kind}_reason_${reason}`] || labels[`fcf_reason_${reason}`];
    const panel = getElement('panel');
    if (!panel) return;
    state.current = { ticker, lang, labels };
    if (!state.bound) {
      const refresh = () => renderPanel(kind, state.current.ticker, state.current.lang, state.current.labels);
      panel.addEventListener('change', refresh);
      getElement('retry').addEventListener('click', refresh);
      state.bound = true;
    }
    const id = ++state.requestId;
    const period = getElement('period').value;
    const flow = getElement('flow').value;
    const balance = getElement('balance').value;
    getElement('flow').disabled = period === 'annual';
    const selected = state.metrics.filter(metric => getElement(metric).checked);
    getElement('balance').disabled = !selected.some(metric => kind === 'returns' || metric === 'equity' || metric === 'assets');
    const head = getElement('head');
    const body = getElement('body');
    const status = getElement('status');
    const notes = getElement('notes');
    const retry = getElement('retry');
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
      const data = await loadStatements(ticker);
      if (id !== state.requestId) return;
      const columns = state.calculate(data, { period, flow, balance });
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
      const trendHeading = element('th', labels.fcf_trend, 'fcf-trend-col');
      trendHeading.scope = 'col';
      heading.append(trendHeading);
      head.append(heading);
      const explanations = new Set();
      for (const metric of selected) {
        const row = element('tr');
        const name = element('th', labels[`${kind}_${metric}`], 'table-sticky-col');
        name.scope = 'row';
        row.append(name);
        for (const column of columns) {
          const ratio = column.ratios[metric];
          const text = ratio.value === null ? 'N/A' : `${ratio.value.toFixed(2)}%`;
          const messages = ratio.reason ? [reasonLabel(ratio.reason)] : ratio.warnings.map(reasonLabel);
          messages.forEach(message => explanations.add(message));
          const cell = element('td', text + (ratio.warnings.length ? ' !' : ''));
          if (messages.length) {
            cell.title = messages.join('; ');
            cell.setAttribute('aria-label', `${text}: ${messages.join('; ')}`);
          }
          if (ratio.warnings.length) cell.className = 'text-gold';
          row.append(cell);
        }
        const trendCell = element('td', undefined, 'fcf-trend-col');
        const values = columns.map(column => column.ratios[metric].value);
        const chart = trend(values);
        if (chart) {
          const ns = 'http://www.w3.org/2000/svg';
          const svg = document.createElementNS(ns, 'svg');
          svg.setAttribute('viewBox', '0 0 108 32');
          svg.setAttribute('class', 'spark-line-svg');
          svg.setAttribute('role', 'img');
          svg.setAttribute('aria-label', `${labels[`${kind}_${metric}`]} ${labels.fcf_trend}`);
          const title = document.createElementNS(ns, 'title');
          title.textContent = columns.map((column, i) => `${column.label}: ${values[i] === null ? 'N/A' : values[i].toFixed(2) + '%'}`).join('; ');
          svg.append(title);
          for (const segment of chart.segments) {
            const line = document.createElementNS(ns, 'path');
            line.setAttribute('d', segment.map((point, i) => `${i ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '));
            line.setAttribute('fill', 'none');
            line.setAttribute('stroke', chart.color);
            line.setAttribute('stroke-width', '2');
            line.setAttribute('stroke-linecap', 'round');
            svg.append(line);
          }
          const dot = document.createElementNS(ns, 'circle');
          dot.setAttribute('cx', chart.last.x);
          dot.setAttribute('cy', chart.last.y);
          dot.setAttribute('r', '2.5');
          dot.setAttribute('fill', chart.color);
          svg.append(dot);
          const wrap = element('span', undefined, 'spark-line-wrap');
          wrap.append(svg);
          trendCell.append(wrap);
        } else trendCell.textContent = 'N/A';
        row.append(trendCell);
        body.append(row);
      }
      for (const message of explanations) notes.append(element('li', message));
    } catch (error) {
      if (id !== state.requestId) return;
      cache.delete(ticker);
      console.error('Financial ratio statements could not be loaded', kind, ticker, error);
      status.textContent = labels.fcf_error;
      retry.hidden = false;
    }
  }

  return { calculate, calculateReturns, calculateBalances, calculateEarnings, loadStatements, financialReference, trend, render, renderReturns };
});
