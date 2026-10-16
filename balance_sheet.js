(function () {
  'use strict';
  let current = null;
  let requestId = 0;
  let chart = null;
  let bound = false;
  const get = suffix => document.getElementById(`balance-${suffix}`);
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
      const refresh = () => render(current.ticker, current.lang, current.labels);
      get('panel').addEventListener('change', refresh);
      get('retry').addEventListener('click', () => render(current.ticker, current.lang, current.labels, true));
      bound = true;
    }
    deactivate();
    const id = requestId;
    const period = get('period').value;
    const view = get('view').value;
    get('status').textContent = labels.fcf_loading;
    get('retry').hidden = true;
    get('cards').replaceChildren();
    get('head').replaceChildren();
    get('body').replaceChildren();
    get('notes').replaceChildren();
    get('date').replaceChildren();
    get('date').disabled = true;
    get('chart-wrap').hidden = true;
    get('table-wrap').hidden = true;
    try {
      const statements = await FcfRatios.loadStatements(ticker, reload);
      if (id !== requestId) return;
      const columns = FcfRatios.calculateBalances(statements, { period });
      if (!columns.length) {
        get('status').textContent = labels.fcf_no_periods;
        return;
      }
      for (let i = 0; i < columns.length; i++) {
        const column = columns[i];
        const option = node('option', `${column.label} · ${column.date || 'N/A'}`);
        option.value = String(i);
        option.dataset.date = column.date || '';
        get('date').append(option);
      }
      const previousIndex = columns.findIndex(column => column.date === previousDate);
      const selectedIndex = previousIndex < 0 ? columns.length - 1 : previousIndex;
      get('date').value = String(selectedIndex);
      get('date').disabled = false;
      const selected = columns[selectedIndex];
      const locale = lang === 'zh' ? 'zh-TW' : 'en-US';
      const number = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      const notes = new Set();
      const reasonLabel = reason => labels[`balance_reason_${reason}`] || labels[`fcf_reason_${reason}`];
      function format(result, suffix = '', amount = false) {
        const text = result.value === null ? 'N/A'
          : amount ? number.format(result.value / 1e6) : `${result.value.toFixed(2)}${suffix}`;
        const messages = result.reason ? [reasonLabel(result.reason)] : result.warnings.map(reasonLabel);
        messages.forEach(message => notes.add(message));
        return { text: text + (result.warnings.length ? ' !' : ''), title: messages.join('; ') };
      }
      get('status').textContent = `${ticker} · ${selected.label} · ${selected.date || 'N/A'} · ${selected.currency || 'N/A'} ${labels.balance_millions}`;
      const cards = [
        ['assets', 'currentRatio', '×'], ['liabilities', 'liabilitiesRatio', '%'],
        ['equity', 'leverage', '×'], ['cash', 'cashRatio', '×']
      ];
      for (const [metric, ratio, suffix] of cards) {
        const card = node('div', undefined, 'balance-card');
        const amount = format(selected.amounts[metric], '', true);
        const detail = format(selected.ratios[ratio], suffix);
        const value = node('strong', amount.text);
        if (selected.amounts[metric].warnings.length) value.className = 'text-gold';
        value.title = amount.title;
        const caption = node('span', `${labels[`balance_${ratio}`]}: ${detail.text}`);
        caption.title = detail.title;
        card.append(node('span', labels[`balance_${metric}`], 'stat-label'), value, caption);
        get('cards').append(card);
      }
      const heading = node('tr');
      const first = node('th', labels.balance_metric, 'table-sticky-col');
      first.scope = 'col';
      heading.append(first);
      for (let i = 0; i < columns.length; i++) {
        const column = columns[i];
        const cell = node('th', undefined, i === selectedIndex ? 'balance-selected' : '');
        cell.scope = 'col';
        cell.append(node('div', column.label),
          node('div', `${column.date || 'N/A'} · ${column.currency || 'N/A'}`, 'th-period-subdate'));
        heading.append(cell);
      }
      get('head').append(heading);
      for (const metric of Object.keys(selected.amounts)) {
        const row = node('tr', undefined, ['assets', 'liabilities', 'equity'].includes(metric) ? 'balance-total' : '');
        const label = node('th', labels[`balance_${metric}`], 'table-sticky-col');
        label.scope = 'row';
        row.append(label);
        columns.forEach((column, i) => {
          const result = column.amounts[metric];
          const formatted = format(result, '', true);
          const cell = node('td', formatted.text, i === selectedIndex ? 'balance-selected' : '');
          cell.title = formatted.title;
          if (result.warnings.length) cell.classList.add('text-gold');
          row.append(cell);
        });
        get('body').append(row);
      }
      for (const message of notes) get('notes').append(node('li', message));
      let showTable = view === 'table';
      if (!showTable && typeof Chart === 'undefined') {
        console.error('Balance sheet chart library is unavailable');
        get('status').textContent += ` · ${labels.balance_chart_unavailable}`;
        showTable = true;
      }
      get('chart-wrap').hidden = showTable;
      get('table-wrap').hidden = !showTable;
      if (showTable) {
        const box = get('table-wrap');
        const cell = get('head').querySelector('.balance-selected');
        const stickyWidth = get('head').querySelector('.table-sticky-col').getBoundingClientRect().width;
        const left = cell.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft;
        box.scrollLeft = Math.max(0, left - stickyWidth - (box.clientWidth - stickyWidth - cell.offsetWidth) / 2);
        return;
      }
      chart = new Chart(get('chart'), {
        type: 'line',
        data: {
          labels: columns.map(column => [column.label, column.date || 'N/A']),
          datasets: [['assets', '--accent'], ['liabilities', '--orange'], ['equity', '--green']].map(([metric, color]) => ({
            label: labels[`balance_${metric}`],
            data: columns.map(column => column.currency === selected.currency && column.amounts[metric].value !== null
              ? column.amounts[metric].value / 1e6 : null),
            borderColor: SiteTheme.color(color), backgroundColor: SiteTheme.color(color),
            borderDash: metric === 'liabilities' ? [6, 4] : metric === 'equity' ? [2, 3] : [],
            pointStyle: metric === 'liabilities' ? 'triangle' : metric === 'equity' ? 'rect' : 'circle',
            borderWidth: 2, pointRadius: columns.map((_, i) => i === selectedIndex ? 5 : 2),
            pointHoverRadius: 6, tension: 0, spanGaps: false
          }))
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          onResize(instance, size) { instance.options.scales.x.ticks.maxTicksLimit = size.width < 600 ? 3 : 8; },
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { position: 'bottom', labels: { color: SiteTheme.color('--text-secondary'), usePointStyle: true } },
            tooltip: {
              backgroundColor: SiteTheme.color('--card-bg'), titleColor: SiteTheme.color('--text'),
              bodyColor: SiteTheme.color('--text-secondary'), borderColor: SiteTheme.color('--card-border'), borderWidth: 1,
              callbacks: { label: item => `${item.dataset.label}: ${number.format(item.parsed.y)} ${selected.currency} ${labels.balance_millions}` }
            }
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: SiteTheme.color('--text-muted'), maxTicksLimit: innerWidth < 600 ? 3 : 8, maxRotation: 0 } },
            y: {
              beginAtZero: true, title: { display: true, text: `${selected.currency || 'N/A'} ${labels.balance_millions}`, color: SiteTheme.color('--text-muted') },
              ticks: { color: SiteTheme.color('--text-muted') }, grid: { color: SiteTheme.color('--chart-grid') }
            }
          }
        }
      });
    } catch (error) {
      if (id !== requestId) return;
      console.error('Balance sheet analysis could not be loaded', ticker, error);
      get('status').textContent = labels.fcf_error;
      get('retry').hidden = false;
      get('chart-wrap').hidden = true;
      get('table-wrap').hidden = true;
    }
  }

  window.BalanceSheet = { render, deactivate };
})();
