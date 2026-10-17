(function () {
  'use strict';
  let current;
  let requestId = 0;
  let chart;
  let bound = false;
  const metrics = ['eps', 'fcf', 'dividend'];
  const get = suffix => document.getElementById(`earnings-${suffix}`);
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };

  function deactivate() {
    requestId++;
    if (chart) chart.destroy();
    chart = null;
  }

  async function render(ticker, lang, labels, reload = false) {
    const previousDate = current?.ticker === ticker ? get('date').selectedOptions[0]?.dataset.date : '';
    current = { ticker, lang, labels };
    if (!bound) {
      get('panel').addEventListener('change', () => render(current.ticker, current.lang, current.labels));
      get('retry').addEventListener('click', () => render(current.ticker, current.lang, current.labels, true));
      bound = true;
    }
    deactivate();
    const id = requestId;
    const period = get('period').value;
    const flow = get('flow').value;
    get('flow').disabled = period === 'annual';
    get('status').textContent = labels.fcf_loading;
    get('retry').hidden = true;
    for (const part of ['cards', 'head', 'body', 'notes', 'date']) get(part).replaceChildren();
    get('date').disabled = true;
    get('chart-wrap').hidden = get('table-wrap').hidden = true;
    try {
      const data = await FcfRatios.loadStatements(ticker, reload);
      if (id !== requestId) return;
      const columns = FcfRatios.calculateEarnings(data, { period, flow });
      if (!columns.length) {
        get('status').textContent = labels.fcf_no_periods;
        return;
      }
      columns.forEach((column, i) => {
        const option = node('option', `${column.label} · ${column.date || 'N/A'}`);
        option.value = String(i);
        option.dataset.date = column.date || '';
        get('date').append(option);
      });
      const previous = columns.findIndex(column => column.date === previousDate);
      const selectedIndex = previous < 0 ? columns.length - 1 : previous;
      get('date').value = String(selectedIndex);
      get('date').disabled = false;
      const selected = columns[selectedIndex];
      const number = new Intl.NumberFormat(lang === 'zh' ? 'zh-TW' : 'en-US', {
        minimumFractionDigits: 2, maximumFractionDigits: 2
      });
      const notes = new Set();
      const format = (result, metric) => {
        const reason = result.reason
          ? labels[`earnings_reason_${result.reason}`] || labels[`fcf_reason_${result.reason}`] || labels[`balance_reason_${result.reason}`] : '';
        if (reason) notes.add(reason);
        return { text: result.value === null ? 'N/A' : number.format(result.value / (metric === 'eps' ? 1 : 1e6)), reason };
      };
      get('status').textContent = `${ticker} · ${selected.label} · ${selected.date || 'N/A'} · ${selected.currency || 'N/A'} · ${
        period === 'annual' ? labels.fcf_annual : flow === 'ttm' ? labels.fcf_ttm : labels.fcf_single}`;
      for (const metric of metrics) {
        const formatted = format(selected.amounts[metric], metric);
        const card = node('div', undefined, 'balance-card');
        const value = node('strong', formatted.text);
        value.title = formatted.reason;
        card.append(node('span', labels[`earnings_${metric}`], 'stat-label'), value);
        get('cards').append(card);
      }
      const heading = node('tr');
      heading.append(node('th', labels.earnings_metric, 'table-sticky-col'));
      columns.forEach((column, i) => {
        const cell = node('th', undefined, i === selectedIndex ? 'balance-selected' : '');
        cell.scope = 'col';
        cell.append(node('div', column.label),
          node('div', `${column.date || 'N/A'} · ${column.currency || 'N/A'}`, 'th-period-subdate'));
        heading.append(cell);
      });
      get('head').append(heading);
      for (const metric of metrics) {
        const row = node('tr');
        const label = node('th', labels[`earnings_${metric}`], 'table-sticky-col');
        label.scope = 'row';
        row.append(label);
        columns.forEach((column, i) => {
          const formatted = format(column.amounts[metric], metric);
          const cell = node('td', formatted.text, i === selectedIndex ? 'balance-selected' : '');
          cell.title = formatted.reason;
          row.append(cell);
        });
        get('body').append(row);
      }
      for (const note of notes) get('notes').append(node('li', note));
      let table = get('view').value === 'table';
      if (!table && typeof Chart === 'undefined') {
        console.error('Earnings trend chart library is unavailable');
        get('status').textContent += ` · ${labels.balance_chart_unavailable}`;
        table = true;
      }
      get('chart-wrap').hidden = table;
      get('table-wrap').hidden = !table;
      if (table) {
        const cell = get('head').querySelector('.balance-selected');
        get('table-wrap').scrollLeft = Math.max(0, cell.offsetLeft - get('head').querySelector('th').offsetWidth);
        return;
      }
      const axis = text => ({
        title: { display: true, text, color: SiteTheme.color('--text-muted') },
        ticks: { color: SiteTheme.color('--text-muted') }, grid: { color: SiteTheme.color('--chart-grid') }
      });
      chart = new Chart(get('chart'), {
        type: 'line',
        data: {
          labels: columns.map(column => [column.label, column.date || 'N/A']),
          datasets: metrics.map((metric, i) => ({
            label: labels[`earnings_${metric}`],
            data: columns.map(column => column.currency !== selected.currency || column.amounts[metric].value === null
              ? null : column.amounts[metric].value / (metric === 'eps' ? 1 : 1e6)),
            yAxisID: metric === 'eps' ? 'y' : 'cash',
            borderColor: SiteTheme.color(['--accent', '--green', '--orange'][i]),
            backgroundColor: SiteTheme.color(['--accent', '--green', '--orange'][i]),
            borderDash: i === 2 ? [6, 4] : [], borderWidth: 2,
            pointRadius: columns.map((_, index) => index === selectedIndex ? 5 : 2),
            tension: 0, spanGaps: false
          }))
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { position: 'bottom', labels: { color: SiteTheme.color('--text-secondary') } },
            tooltip: { callbacks: { label: item => `${item.dataset.label}: ${number.format(item.parsed.y)} ${selected.currency}` } }
          },
          scales: {
            x: { ticks: { color: SiteTheme.color('--text-muted'), maxTicksLimit: innerWidth < 600 ? 3 : 8, maxRotation: 0 }, grid: { display: false } },
            y: axis(`${selected.currency || 'N/A'} ${labels.earnings_per_share}`),
            cash: { ...axis(`${selected.currency || 'N/A'} ${labels.balance_millions}`), position: 'right', grid: { drawOnChartArea: false } }
          }
        }
      });
    } catch (error) {
      if (id !== requestId) return;
      console.error('Earnings trend could not be loaded', ticker, error);
      get('status').textContent = labels.fcf_error;
      get('retry').hidden = false;
      get('chart-wrap').hidden = get('table-wrap').hidden = true;
    }
  }
  window.EarningsTrend = { render, deactivate };
})();
