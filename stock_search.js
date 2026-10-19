(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StockSearch = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const normalize = value => String(value || '').normalize('NFKC').trim().toLowerCase()
    .replace(/腾/g, '\u9a30').replace(/讯/g, '\u8a0a').replace(/汇/g, '\u532f').replace(/\u6ed9/g, '\u532f');

  function oneEdit(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length <= b.length) j++;
      if (a.length >= b.length) i++;
    }
    return edits + Number(i < a.length || j < b.length) <= 1;
  }

  function matches(stock, query) {
    const needle = normalize(query);
    if (!needle) return true;
    const ticker = normalize(stock.ticker);
    if (/^\d{1,5}(?:\.hk)?$/.test(needle) && /^\d{4,5}\.hk$/.test(ticker)
        && Number(needle.replace(/\.hk$/, '')) === Number(ticker.replace(/\.hk$/, ''))) return true;
    const names = [stock.name, stock.company_name, stock.name_en, stock.name_zh, ...(stock.searchAliases || [])]
      .map(normalize);
    if ([ticker, stock.displayCode, stock.sector, stock.industry, ...names].some(value => normalize(value).includes(needle))) return true;
    return /^[a-z]{4,}$/.test(needle) && names.some(name => name.split(/[^a-z]+/)
      .some(word => word.length >= 4 && oneEdit(word, needle)));
  }

  return { matches };
});
