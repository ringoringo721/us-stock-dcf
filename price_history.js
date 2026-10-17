(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PriceHistory = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const DAY = 86400000;
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

  function validate(record, ticker) {
    const currency = /\.HK$/i.test(ticker) ? 'HKD' : 'USD';
    if (record?.version !== 1 || record.ticker !== ticker || record.currency !== currency
        || currency === 'HKD' && record.providerSymbol != null && record.providerSymbol !== ticker
        || record.priceBasis !== 'splitAdjustedClose' || record.source !== 'FMP historical-price-eod/full'
        || !validDate(record.requestedFrom) || !validDate(record.requestedTo)
        || record.requestedFrom > record.requestedTo || !Array.isArray(record.rows)) {
      throw new TypeError('Unsupported historical price record');
    }
    let previous = '';
    for (const row of record.rows) {
      if (!Array.isArray(row) || row.length !== 3 || !validDate(row[0]) || row[0] <= previous
          || row[0] < record.requestedFrom || row[0] > record.requestedTo
          || typeof row[1] !== 'number' || !Number.isFinite(row[1]) || row[1] <= 0
          || row[2] !== null && (!Number.isSafeInteger(row[2]) || row[2] < 0)) {
        throw new TypeError('Invalid historical price date, close or volume');
      }
      previous = row[0];
    }
    return record;
  }

  function periodRange(rows, period) {
    if (!rows.length) return null;
    const end = rows.at(-1)[0];
    if (period === 'all') return [rows[0][0], end];
    const date = new Date(end);
    const year = date.getUTCFullYear(), month = date.getUTCMonth(), day = date.getUTCDate();
    let cutoff;
    if (period === 'ytd') cutoff = `${year}-01-01`;
    else {
      const months = { '3m': 3, '6m': 6, '1y': 12, '3y': 36, '5y': 60, '10y': 120 }[period];
      if (!months) throw new TypeError('Unknown price period');
      const target = new Date(Date.UTC(year, month - months, 1));
      target.setUTCDate(Math.min(day, new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()));
      cutoff = target.toISOString().slice(0, 10);
    }
    // YTD includes the preceding year's last actual close as its return baseline.
    const baseline = period === 'ytd' ? rows.findLast(row => row[0] < cutoff) : null;
    return [baseline?.[0] || rows.find(row => row[0] >= cutoff)?.[0] || end, end];
  }

  function select(rows, start, end) {
    if (!validDate(start) || !validDate(end) || start > end) throw new RangeError('Invalid price date range');
    return rows.filter(row => row[0] >= start && row[0] <= end);
  }

  function summarize(rows) {
    if (!rows.length) return { price: null, change: null, cagr: null, years: null };
    const first = rows[0], last = rows.at(-1);
    const days = (Date.parse(last[0]) - Date.parse(first[0])) / DAY;
    const change = rows.length > 1 ? (last[1] / first[1] - 1) * 100 : null;
    const cagr = days >= 365 ? (Math.pow(last[1] / first[1], 365.25 / days) - 1) * 100 : null;
    return { price: last[1], change: Number.isFinite(change) ? change : null,
      cagr: Number.isFinite(cagr) ? cagr : null, years: days / 365.25 };
  }

  function csv(rows, currency = 'USD') {
    if (!['USD', 'HKD'].includes(currency)) throw new TypeError('Unsupported price currency');
    return `Date,Split-adjusted close (${currency}),Provider volume (shares)\r\n`
      + rows.map(row => `${row[0]},${row[1]},${row[2] ?? ''}`).join('\r\n') + '\r\n';
  }

  const cache = new Map();
  async function load(ticker, reload = false) {
    if (!/^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/.test(ticker)) throw new TypeError('Invalid price ticker');
    if (reload || !cache.has(ticker)) {
      const promise = fetch(`cache/price_charts/${encodeURIComponent(ticker)}.json`, { cache: reload ? 'reload' : 'default' })
        .then(response => {
          if (!response.ok) throw new Error(`Historical prices HTTP ${response.status}`);
          return response.json();
        }).then(record => validate(record, ticker));
      cache.set(ticker, promise);
      while (cache.size > 8) cache.delete(cache.keys().next().value);
      promise.catch(() => { if (cache.get(ticker) === promise) cache.delete(ticker); });
    }
    return cache.get(ticker);
  }

  const get = suffix => document.getElementById(`price-${suffix}`);
  const preferences = new Map();
  let active = null, requestId = 0, bound = false, charts = [], selected = [];
  function destroy() { charts.forEach(chart => chart.destroy()); charts = []; }
  function deactivate() {
    requestId++; active = null; selected = []; destroy();
    if (typeof document !== 'undefined' && document.fullscreenElement === get('history-panel')) {
      document.exitFullscreen().catch(error => console.error('Price chart fullscreen exit failed', error));
    }
  }
  const number = (value, digits = 2) => value === null ? 'N/A'
    : value.toLocaleString(active.lang === 'zh' ? 'zh-TW' : 'en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
  const signed = value => value === null ? 'N/A' : `${value >= 0 ? '+' : ''}${number(value)}%`;
  const compact = value => new Intl.NumberFormat(active.lang === 'zh' ? 'zh-TW' : 'en-US',
    { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const price = value => value === null ? 'N/A' : `${active?.record?.currency || 'USD'} ${number(value)}`;
  function colorValue(suffix, value) {
    get(suffix).textContent = signed(value);
    get(suffix).className = value === null ? '' : value >= 0 ? 'text-green' : 'text-red';
  }

  function draw() {
    if (!active?.record) return;
    destroy();
    const { record, labels, range } = active;
    const all = record.rows;
    selected = range ? select(all, ...range) : [];
    const summary = summarize(selected);
    get('last-close').textContent = price(summary.price);
    colorValue('return', summary.change);
    colorValue('cagr', summary.cagr);
    get('cagr').title = labels.price_cagr_note;
    get('history-plots').hidden = selected.length === 0 || typeof Chart === 'undefined';
    get('download').disabled = !selected.length;
    get('fullscreen').disabled = !selected.length || !document.fullscreenEnabled;
    get('point').textContent = labels.price_hover;
    get('history-status').textContent = !all.length ? labels.price_empty : !selected.length ? labels.price_no_range
      : `${selected[0][0]} — ${selected.at(-1)[0]} · ${selected.length.toLocaleString(active.lang === 'zh' ? 'zh-TW' : 'en-US')} ${labels.price_sessions}`
        + ` · ${labels.price_available}: ${all[0][0]} — ${all.at(-1)[0]}`;
    get('retry').hidden = all.length > 0;
    get('controls').hidden = !all.length;
    if (!all.length) return;
    for (const suffix of ['from', 'to']) {
      get(suffix).min = all[0][0];
      get(suffix).max = all.at(-1)[0];
    }
    if (range) { get('from').value = range[0]; get('to').value = range[1]; }
    for (const button of get('periods').querySelectorAll('button')) {
      button.classList.toggle('active', button.dataset.period === active.period);
      button.setAttribute('aria-pressed', String(button.dataset.period === active.period));
    }
    if (!selected.length) return;
    if (typeof Chart === 'undefined') {
      get('history-status').textContent += ` · ${labels.price_library_error}`;
      return;
    }
    const theme = name => SiteTheme.color(name);
    const gold = theme('--gold'), muted = theme('--text-muted');
    const points = rows => rows.map(row => ({ x: Date.parse(row[0]), y: row[1] }));
    const xTicks = value => new Date(value).toLocaleDateString(active.lang === 'zh' ? 'zh-TW' : 'en-US',
      selected.length > 2500 ? { year: 'numeric', timeZone: 'UTC' } : { year: '2-digit', month: 'short', timeZone: 'UTC' });
    const minimum = Date.parse(selected[0][0]), maximum = Date.parse(selected.at(-1)[0]);
    const xScale = {
      type: 'linear', min: minimum, max: maximum > minimum ? maximum : minimum + DAY, offset: false,
      grid: { display: false }, ticks: { align: 'inner', padding: 0, color: muted, maxTicksLimit: innerWidth < 600 ? 4 : 8, maxRotation: 0, callback: xTicks }
    };
    const tooltip = {
      backgroundColor: theme('--card-bg'), titleColor: theme('--text'), bodyColor: theme('--text-secondary'),
      borderColor: theme('--card-border'), borderWidth: 1, displayColors: false,
      callbacks: {
        title: items => selected[items[0]?.dataIndex]?.[0] || '',
        label: item => {
          const row = selected[item.dataIndex];
          return [`${labels.price_close}: ${price(row[1])}`,
            `${labels.price_volume}: ${row[2] === null ? 'N/A' : row[2].toLocaleString(active.lang === 'zh' ? 'zh-TW' : 'en-US')}`];
        }
      }
    };
    const details = index => {
      const row = selected[index];
      if (row) get('point').textContent = `${row[0]} · ${labels.price_close}: ${price(row[1])} · ${labels.price_volume}: ${row[2] === null ? 'N/A' : compact(row[2])}`;
    };
    const crosshair = {
      id: 'priceCrosshair',
      afterDraw(chart) {
        const element = chart.getActiveElements()[0];
        if (!element) return;
        const context = chart.ctx, { top, bottom } = chart.chartArea;
        context.save(); context.strokeStyle = muted; context.setLineDash([4, 4]);
        context.beginPath(); context.moveTo(element.element.x, top); context.lineTo(element.element.x, bottom);
        context.stroke(); context.restore();
      }
    };
    const common = {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false, normalized: true,
      layout: { autoPadding: false, padding: { left: 6, top: 4 } },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      onHover(event, elements) { if (elements.length) details(elements[0].index); },
      plugins: { legend: { display: false }, tooltip }
    };
    charts.push(new Chart(get('chart'), {
      type: 'line', plugins: [crosshair],
      data: { datasets: [{
        label: labels.price_close, data: points(selected), borderColor: gold, borderWidth: 2,
        pointRadius: selected.length === 1 ? 3 : 0, pointHoverRadius: 4, fill: true, tension: 0,
        backgroundColor: context => {
          const area = context.chart.chartArea;
          if (!area) return `${gold}18`;
          const gradient = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
          gradient.addColorStop(0, `${gold}45`); gradient.addColorStop(1, `${gold}00`);
          return gradient;
        }
      }] },
      options: { ...common, scales: {
        x: { ...xScale, ticks: { display: false }, border: { display: false } },
        y: {
          position: 'right', grace: '5%', afterFit(axis) { axis.width = 66; },
          ticks: { color: muted, maxTicksLimit: 6, callback: value => compact(value) },
          grid: { color: theme('--chart-grid') }, title: { display: true, text: active.record.currency, color: muted }
        }
      } }
    }));
    charts.push(new Chart(get('volume-chart'), {
      type: 'bar', plugins: [crosshair],
      data: { datasets: [{ label: labels.price_volume, data: selected.map(row => ({ x: Date.parse(row[0]), y: row[2] })),
        backgroundColor: `${gold}aa`, barPercentage: 1, categoryPercentage: 1 }] },
      options: { ...common, scales: {
        x: xScale,
        y: { position: 'right', beginAtZero: true, afterFit(axis) { axis.width = 66; },
          ticks: { color: muted, maxTicksLimit: 2, callback: value => compact(value) }, grid: { display: false } }
      } }
    }));
    const selection = {
      id: 'priceSelection',
      afterDraw(chart) {
        const { ctx, chartArea: area, scales: { x } } = chart;
        const left = x.getPixelForValue(minimum), right = x.getPixelForValue(maximum);
        ctx.save(); ctx.fillStyle = `${gold}30`; ctx.fillRect(left, area.top, right - left, area.bottom - area.top);
        ctx.strokeStyle = gold; ctx.lineWidth = 2;
        for (const edge of [left, right]) { ctx.beginPath(); ctx.moveTo(edge, area.top); ctx.lineTo(edge, area.bottom); ctx.stroke(); }
        ctx.restore();
      }
    };
    charts.push(new Chart(get('navigator'), {
      type: 'line', plugins: [selection],
      data: { datasets: [{ data: points(all), borderColor: gold, borderWidth: 1, pointRadius: 0 }] },
      options: { ...common, events: [], plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { type: 'linear', min: Date.parse(all[0][0]),
            max: all.length > 1 ? Date.parse(all.at(-1)[0]) : Date.parse(all[0][0]) + DAY,
            offset: false, grid: { display: false }, ticks: {
            align: 'inner', padding: 0, color: muted, maxTicksLimit: 6, maxRotation: 0, font: { size: 10 },
            callback: value => new Date(value).getUTCFullYear()
          } },
          y: { display: false }
        }
      }
    }));
    const startIndex = all.findIndex(row => row[0] >= range[0]);
    const endIndex = all.findLastIndex(row => row[0] <= range[1]);
    for (const suffix of ['range-start', 'range-end']) { get(suffix).max = all.length - 1; get(suffix).disabled = all.length < 2; }
    get('range-start').value = startIndex;
    get('range-end').value = endIndex;
    get('range-start').setAttribute('aria-valuetext', all[startIndex][0]);
    get('range-end').setAttribute('aria-valuetext', all[endIndex][0]);
    get('chart').setAttribute('aria-label', `${active.ticker} · ${labels.price_title} · ${selected[0][0]} — ${selected.at(-1)[0]}`);
    details(selected.length - 1);
  }

  function updateRange(period, range) {
    if (!active?.record) return;
    active.period = period;
    active.range = range;
    preferences.set(active.ticker, { period, range });
    get('range-error').textContent = '';
    draw();
  }

  function bind() {
    if (bound) return;
    bound = true;
    get('periods').addEventListener('click', event => {
      const period = event.target.closest('button')?.dataset.period;
      if (period && active?.record) updateRange(period, periodRange(active.record.rows, period));
    });
    get('custom').addEventListener('submit', event => {
      event.preventDefault();
      if (!active?.record?.rows.length) return;
      const from = get('from').value, to = get('to').value, rows = active.record.rows;
      if (!validDate(from) || !validDate(to) || from > to || from < rows[0][0] || to > rows.at(-1)[0]) {
        get('range-error').textContent = active.labels.price_invalid_range;
        return;
      }
      updateRange('custom', [from, to]);
    });
    for (const suffix of ['range-start', 'range-end']) {
      get(suffix).addEventListener('input', () => {
        if (!active?.record) return;
        const rows = active.record.rows;
        let first = Number(get('range-start').value), last = Number(get('range-end').value);
        if (first > last) { if (suffix === 'range-start') first = last; else last = first; }
        updateRange('custom', [rows[first][0], rows[last][0]]);
      });
    }
    get('retry').addEventListener('click', () => { if (active) render(active.ticker, active.stock, active.lang, active.labels, true); });
    get('download').addEventListener('click', () => {
      if (!selected.length) return;
      const url = URL.createObjectURL(new Blob(['\uFEFF', csv(selected, active.record.currency)], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = `${active.ticker}-${selected[0][0]}-${selected.at(-1)[0]}.csv`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    get('fullscreen').addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await get('history-panel').requestFullscreen();
      } catch (error) {
        console.error('Price chart fullscreen failed', error);
        if (active) get('range-error').textContent = active.labels.price_fullscreen_error;
      }
    });
    get('chart').addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !selected.length || !charts[0]) return;
      event.preventDefault();
      const chart = charts[0], previous = chart.getActiveElements()[0]?.index ?? selected.length - 1;
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? selected.length - 1
        : Math.max(0, Math.min(selected.length - 1, previous + (event.key === 'ArrowLeft' ? -1 : 1)));
      const items = [{ datasetIndex: 0, index }];
      chart.setActiveElements(items);
      chart.tooltip.setActiveElements(items, { x: chart.scales.x.getPixelForValue(Date.parse(selected[index][0])),
        y: chart.scales.y.getPixelForValue(selected[index][1]) });
      get('point').textContent = `${selected[index][0]} · ${active.labels.price_close}: ${price(selected[index][1])} · ${active.labels.price_volume}: ${selected[index][2] === null ? 'N/A' : compact(selected[index][2])}`;
      chart.update('none');
    });
    document.addEventListener('fullscreenchange', () => {
      if (!active) return;
      const fullscreen = document.fullscreenElement === get('history-panel');
      get('fullscreen').textContent = active.labels[fullscreen ? 'price_exit_fullscreen' : 'price_fullscreen'];
      get('fullscreen').setAttribute('aria-pressed', String(fullscreen));
    });
    window.addEventListener('themechange', () => { if (active?.record) draw(); });
  }

  async function render(ticker, stock, lang, labels, reload = false) {
    bind();
    const id = ++requestId;
    destroy();
    selected = [];
    active = { ticker, stock, lang, labels, record: null };
    get('periods').setAttribute('aria-label', labels.price_title);
    get('range-start').setAttribute('aria-label', labels.price_from);
    get('range-end').setAttribute('aria-label', labels.price_to);
    get('fullscreen').textContent = labels.price_fullscreen;
    get('fullscreen').title = document.fullscreenEnabled ? '' : labels.price_fullscreen_error;
    get('company').textContent = `${ticker} · ${stock.company_name || stock.companyName || ticker}`;
    get('last-close').textContent = 'N/A';
    colorValue('return', null); colorValue('cagr', null);
    get('history-status').textContent = labels.price_loading;
    get('history-plots').hidden = true; get('controls').hidden = true;
    get('point').textContent = ''; get('range-error').textContent = '';
    get('retry').hidden = true; get('download').disabled = true; get('fullscreen').disabled = true;
    try {
      const record = await load(ticker, reload);
      if (id !== requestId) return;
      active.record = record;
      const previous = preferences.get(ticker);
      active.period = previous?.period || '5y';
      active.range = previous?.period === 'custom' ? previous.range : periodRange(record.rows, active.period);
      draw();
    } catch (error) {
      if (id !== requestId) return;
      console.error('Profile historical prices could not be loaded', ticker, error);
      destroy();
      get('history-plots').hidden = true;
      get('history-status').textContent = labels.price_error;
      get('retry').hidden = false;
    }
  }
  return { validate, periodRange, select, summarize, csv, load, render, deactivate };
});
