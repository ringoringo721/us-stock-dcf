(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UsIndexBelt = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';

  const UsIndexes = typeof module === 'object' && module.exports
    ? require('./us_indexes.js')
    : root.UsIndexes;

  let mounted = null;
  let loadPromise = null;
  let payload = null;

  function prefersReducedMotion() {
    return !!root.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  }

  function language() {
    if (root.document?.documentElement?.lang === 'en') return 'en';
    if (typeof root.currentLang === 'string') return root.currentLang === 'en' ? 'en' : 'zh';
    return 'zh';
  }

  function labelFor(row, lang = language()) {
    return lang === 'en' ? (row.labelEn || row.id) : (row.labelZh || row.labelEn || row.id);
  }

  function formatChangePct(value) {
    if (!Number.isFinite(value)) return '—';
    const abs = Math.abs(value).toFixed(2);
    if (value > 0) return `+${abs}%`;
    if (value < 0) return `−${abs}%`;
    return `${abs}%`;
  }

  function changeClass(value) {
    if (!Number.isFinite(value) || value === 0) return 'flat';
    return value > 0 ? 'up' : 'down';
  }

  function sparklineSvg(points, direction) {
    if (!Array.isArray(points) || points.length < 2) return '';
    const width = 72;
    const height = 28;
    const pad = 1;
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;
    const coords = points.map((value, index) => {
      const x = pad + (index / (points.length - 1)) * (width - pad * 2);
      const y = height - pad - ((value - min) / span) * (height - pad * 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    const stroke = direction === 'up' ? 'var(--green)'
      : direction === 'down' ? 'var(--red)' : 'var(--text-muted)';
    return `<svg class="us-index-belt__spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true" focusable="false"><polyline fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" points="${coords.join(' ')}"/></svg>`;
  }

  function chipHtml(row, lang) {
    const direction = changeClass(row.changePct);
    const name = labelFor(row, lang);
    const pct = formatChangePct(row.changePct, lang);
    return `<div class="us-index-belt__chip" data-symbol="${escapeAttr(row.symbol)}" data-direction="${direction}">`
      + `<span class="us-index-belt__name">${escapeHtml(name)}</span>`
      + `<span class="us-index-belt__pct us-index-belt__pct--${direction}">${escapeHtml(pct)}</span>`
      + sparklineSvg(row.sparkline, direction)
      + `</div>`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll("'", '&#39;');
  }

  function ensureRoot() {
    let el = root.document.getElementById('us-index-belt');
    if (el) return el;
    el = root.document.createElement('div');
    el.id = 'us-index-belt';
    el.className = 'us-index-belt';
    el.hidden = true;
    el.setAttribute('role', 'region');
    const body = root.document.body;
    const container = root.document.querySelector('.container');
    if (container?.parentNode === body) body.insertBefore(el, container);
    else body.prepend(el);
    return el;
  }

  function render(data = payload) {
    const el = ensureRoot();
    const market = root.MarketContext?.market || 'US';
    if (market !== 'US') {
      el.hidden = true;
      el.innerHTML = '';
      mounted = null;
      return;
    }
    if (!data?.indexes?.length) {
      el.hidden = true;
      return;
    }
    const lang = language();
    const chips = data.indexes.map(row => chipHtml(row, lang)).join('');
    const reduced = prefersReducedMotion();
    const asOf = data.capturedAt ? String(data.capturedAt).slice(0, 10) : '';
    const aria = lang === 'en'
      ? `US index moves${asOf ? ` as of ${asOf}` : ''}`
      : `美股指數漲跌${asOf ? `（截至 ${asOf}）` : ''}`;
    el.setAttribute('aria-label', aria);
    el.dataset.reducedMotion = reduced ? '1' : '0';
    el.hidden = false;
    // Duplicate track content for seamless CSS marquee; reduced-motion shows one copy.
    el.innerHTML = `<div class="us-index-belt__viewport">`
      + `<div class="us-index-belt__track" data-marquee="${reduced ? 'off' : 'on'}">`
      + `<div class="us-index-belt__group">${chips}</div>`
      + (reduced ? '' : `<div class="us-index-belt__group" aria-hidden="true">${chips}</div>`)
      + `</div></div>`;
    mounted = { lang, count: data.indexes.length };
  }

  async function load({ refresh = false } = {}) {
    if (!refresh && payload?.indexes?.length) {
      render(payload);
      return payload;
    }
    if (loadPromise && !refresh) return loadPromise;
    loadPromise = (async () => {
      const url = refresh ? '/api/us-indexes?refresh=1' : '/api/us-indexes';
      const response = await root.fetch(url, { cache: refresh ? 'reload' : 'default' });
      if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error('US_INDEX_BELT_UNAVAILABLE');
      }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP_${response.status}`);
      payload = UsIndexes.validatePayload(body);
      render(payload);
      return payload;
    })();
    try {
      return await loadPromise;
    } finally {
      loadPromise = null;
    }
  }

  function mount() {
    ensureRoot();
    if ((root.MarketContext?.market || 'US') !== 'US') {
      render(null);
      return Promise.resolve(null);
    }
    return load().catch(error => {
      console.error('US index belt failed to load', error);
      const el = ensureRoot();
      el.hidden = true;
      return null;
    });
  }

  function applyLanguage() {
    if (payload) render(payload);
  }

  return { mount, load, render, applyLanguage, formatChangePct, sparklineSvg, labelFor };
});
