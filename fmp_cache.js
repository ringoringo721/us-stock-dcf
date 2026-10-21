(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FmpCache = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  let database;
  const pending = new Map();
  function open() {
    if (!database) database = new Promise((resolve, reject) => {
      if (!root.indexedDB) { reject(new Error('PERSISTENT_CACHE_UNAVAILABLE')); return; }
      const request = root.indexedDB.open('us-stock-dcf-fmp-responses', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('responses', { keyPath: 'key' });
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); database = null; };
        resolve(request.result);
      };
      request.onerror = () => reject(new Error(`PERSISTENT_CACHE_${request.error?.name || 'OPEN_FAILED'}`));
      request.onblocked = () => reject(new Error('PERSISTENT_CACHE_BLOCKED'));
    }).catch(error => { database = null; throw error; });
    return database;
  }
  async function access(key, entry) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('responses', entry ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('responses');
      const request = entry ? store.put(entry) : store.get(key);
      let value;
      request.onsuccess = () => { value = request.result; };
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(new Error(`PERSISTENT_CACHE_${transaction.error?.name || 'TRANSACTION_FAILED'}`));
      transaction.onerror = () => reject(new Error(`PERSISTENT_CACHE_${transaction.error?.name || 'TRANSACTION_FAILED'}`));
    });
  }
  function valid(result, query) {
    if (!Array.isArray(result?.data) || result.source?.symbol !== query.get('symbol')
        || Object.hasOwn(result, 'error')) return false;
    if (query.get('action') === 'news') return result.page === Number(query.get('page') || 0)
      && result.data.every(row => row?.symbol === query.get('symbol'));
    if (query.get('action') === 'technical') return result.source.indicator === query.get('indicator')
      && result.source.periodLength === Number(query.get('periodLength')) && result.source.timeframe === '1day'
      && result.source.from === query.get('from') && result.source.to === query.get('to');
    if (query.get('action') === 'historical-price') {
      return result.source.from === query.get('from') && result.source.to === query.get('to')
        && result.data.every(row => row?.symbol === query.get('symbol')
          && typeof row.date === 'string' && typeof row.close === 'number' && Number.isFinite(row.close) && row.close > 0);
    }
    return result.data.every(row => row?.symbol === query.get('symbol'));
  }
  function request(parameters, { scope = '', refresh = false, snapshot = null } = {}) {
    const query = new URLSearchParams(parameters);
    query.sort();
    const key = `v1:${scope}:${query}`, inFlightKey = `${key}:${refresh}`;
    if (pending.has(inFlightKey)) return pending.get(inFlightKey);
    const promise = (async () => {
      let warning = null;
      if (!refresh) {
        try {
          const entry = await access(key);
          if (entry?.version === 1 && valid(entry.result, query)) {
            return { ...entry.result, cache: { hit: true, persisted: true, storedAt: entry.storedAt } };
          }
          if (entry) throw new Error('PERSISTENT_CACHE_INVALID_ENTRY');
        } catch (error) {
          warning = error.message;
          console.error('Saved FMP response could not be read', query.get('symbol'), warning);
        }
      }
      let result;
      if (!refresh && snapshot) {
        if (!valid(snapshot, query)) throw new Error('FMP_INVALID_SNAPSHOT');
        result = snapshot;
      } else {
        const response = await root.fetch(`/api/fmp?${query}`, { cache: refresh ? 'reload' : 'default' });
        if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('FMP_API_UNAVAILABLE');
        result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP_${response.status}`);
        if (!valid(result, query)) throw new Error('FMP_INVALID_RESPONSE');
      }
      const storedAt = new Date().toISOString();
      try {
        await access(key, { key, version: 1, result, storedAt });
        warning = null;
      } catch (error) {
        warning = error.message;
        console.error('FMP response could not be saved', query.get('symbol'), warning);
      }
      return { ...result, cache: { hit: !refresh && !!snapshot, persisted: !warning, storedAt, warning } };
    })();
    pending.set(inFlightKey, promise);
    promise.finally(() => { if (pending.get(inFlightKey) === promise) pending.delete(inFlightKey); }).catch(() => {});
    return promise;
  }
  function note(result, language) {
    const cache = result?.cache;
    if (!cache) return '';
    if (cache.warning) return language === 'en'
      ? `Local cache could not be saved (${cache.warning}); this result may need to be fetched again.`
      : `本機快取無法保存（${cache.warning}）；此結果下次可能需要重新查詢。`;
    const date = result.source?.capturedAt || (language === 'en' ? 'capture date unavailable' : '擷取日期未提供');
    return language === 'en'
      ? `${cache.hit ? 'Saved snapshot; no new FMP request.' : 'FMP result saved in this browser.'} Source captured: ${date}. No automatic refresh; cached data is not live.`
      : `${cache.hit ? '讀取已存快照；未重新呼叫 FMP。' : 'FMP 結果已保存到此瀏覽器。'}來源擷取：${date}。不會自動重查；快取並非即時資料。`;
  }
  return { request, valid, note };
});
