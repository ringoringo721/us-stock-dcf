/**
 * Supply chain & competitors — curated value-chain graph per ticker.
 * Shape is reusable: cache/supply-chain/{TICKER}.json → load() → normalize.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SupplyChain = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const TAB_KEY = 'supply-chain';
  const CACHE_DIR = 'cache/supply-chain';

  function symbol(value) {
    return typeof value === 'string' ? value.trim().toUpperCase() : '';
  }

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function normalizePlayer(raw, stageId) {
    if (!raw || typeof raw !== 'object') return null;
    const ticker = text(raw.ticker);
    if (!ticker) return null;
    return {
      ticker,
      name_en: text(raw.name_en) || ticker,
      name_zh: text(raw.name_zh) || text(raw.name_en) || ticker,
      role_en: text(raw.role_en) || text(raw.basis_en) || '',
      role_zh: text(raw.role_zh) || text(raw.basis_zh) || '',
      exchange: text(raw.exchange) || '',
      listedInApp: raw.listedInApp !== false,
      stageId: stageId || null,
      kind: 'player'
    };
  }

  function normalizeCompetitor(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const ticker = text(raw.ticker);
    if (!ticker) return null;
    return {
      ticker,
      name_en: text(raw.name_en) || ticker,
      name_zh: text(raw.name_zh) || text(raw.name_en) || ticker,
      role_en: text(raw.basis_en) || text(raw.role_en) || '',
      role_zh: text(raw.basis_zh) || text(raw.role_zh) || '',
      exchange: text(raw.exchange) || '',
      listedInApp: raw.listedInApp !== false,
      stageId: null,
      kind: 'competitor'
    };
  }

  function normalize(pack) {
    if (!pack || typeof pack !== 'object') throw new TypeError('Supply-chain pack missing');
    const ticker = symbol(pack.ticker);
    if (!ticker) throw new TypeError('Supply-chain pack missing ticker');
    const stages = (Array.isArray(pack.stages) ? pack.stages : [])
      .map((stage, index) => {
        if (!stage || typeof stage !== 'object') return null;
        const id = text(stage.id) || `stage-${index + 1}`;
        const players = (Array.isArray(stage.players) ? stage.players : [])
          .map(player => normalizePlayer(player, id))
          .filter(Boolean)
          .slice(0, 3);
        return {
          id,
          order: Number.isFinite(stage.order) ? stage.order : index + 1,
          label_en: text(stage.label_en) || id,
          label_zh: text(stage.label_zh) || text(stage.label_en) || id,
          summary_en: text(stage.summary_en),
          summary_zh: text(stage.summary_zh),
          players
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

    const competitors = (Array.isArray(pack.competitors) ? pack.competitors : [])
      .map(normalizeCompetitor)
      .filter(Boolean);

    return {
      version: pack.version || 1,
      ticker,
      name_en: text(pack.name_en) || ticker,
      name_zh: text(pack.name_zh) || text(pack.name_en) || ticker,
      updatedAt: text(pack.updatedAt) || '',
      source: pack.source && typeof pack.source === 'object' ? pack.source : { type: 'curated' },
      model: pack.model && typeof pack.model === 'object' ? pack.model : null,
      stages,
      competitors
    };
  }

  /** Flatten Top-3 players across stages for the roster table. */
  function flattenPlayers(pack) {
    const data = pack?.stages ? pack : normalize(pack);
    return data.stages.flatMap(stage => stage.players.map(player => ({
      ...player,
      stageId: stage.id,
      stageLabel_en: stage.label_en,
      stageLabel_zh: stage.label_zh
    })));
  }

  function inUniverse(universe, ticker) {
    if (!universe || typeof universe !== 'object') return false;
    const key = symbol(ticker);
    if (!key) return false;
    if (universe[ticker] || universe[key]) return true;
    // Soft match: strip exchange suffix for rare cases (usually exact keys).
    const bare = key.replace(/\.(HK|US|TW|SZ|SS|KS)$/i, '');
    return !!(universe[bare] || Object.keys(universe).some(k => symbol(k) === key));
  }

  const memory = Object.create(null);

  function load(ticker, options = {}) {
    const key = symbol(ticker);
    if (!key) return Promise.reject(new RangeError('Supply-chain ticker required'));
    if (!options.reload && memory[key]) return Promise.resolve(memory[key]);
    const url = `${CACHE_DIR}/${encodeURIComponent(key)}.json`;
    return fetch(url, { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) {
        const err = new Error(`SUPPLY_CHAIN_NO_SEED:${key}`);
        err.code = 'SUPPLY_CHAIN_NO_SEED';
        err.status = response.status;
        throw err;
      }
      const raw = await response.json();
      const normalized = normalize(raw);
      if (symbol(normalized.ticker) !== key) {
        throw new TypeError(`Supply-chain pack ticker mismatch: ${normalized.ticker}`);
      }
      memory[key] = normalized;
      return normalized;
    });
  }

  function clearCache(ticker) {
    if (ticker) delete memory[symbol(ticker)];
    else Object.keys(memory).forEach(k => delete memory[k]);
  }

  return {
    TAB_KEY,
    CACHE_DIR,
    normalize,
    flattenPlayers,
    inUniverse,
    load,
    clearCache,
    symbol
  };
}));
