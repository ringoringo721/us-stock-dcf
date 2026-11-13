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
        // 404 = no curated seed yet; other HTTP failures must not look like "empty seed".
        const missing = response.status === 404;
        const err = new Error(missing
          ? `SUPPLY_CHAIN_NO_SEED:${key}`
          : `SUPPLY_CHAIN_LOAD_FAILED:${key}:${response.status}`);
        err.code = missing ? 'SUPPLY_CHAIN_NO_SEED' : 'SUPPLY_CHAIN_LOAD_FAILED';
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

  /**
   * Spider / radial layout for SVG rendering.
   * Hub at center; stages on an inner ring (ordered clockwise from upstream);
   * Top-3 players on an outer ring near their stage; competitors on a lower arc.
   * Flow edges: stage[i]→stage[i+1] and upstream→hub / hub→downstream.
   * Competitor edges: dashed rivalry links hub↔competitor (not supply flow).
   */
  function layoutSpider(pack, options = {}) {
    const data = pack?.stages ? pack : normalize(pack);
    const width = Number(options.width) || 1100;
    const height = Number(options.height) || 760;
    const cx = width / 2;
    const cy = height / 2 - 18;
    const stageR = Number(options.stageRadius) || Math.min(width, height) * 0.28;
    const playerR = Number(options.playerRadius) || Math.min(width, height) * 0.42;
    const competitorR = Number(options.competitorRadius) || Math.min(width, height) * 0.46;
    const stages = data.stages;
    const n = stages.length || 1;
    // Even spider ring, start west (upstream) and proceed clockwise.
    const startAngle = Math.PI;

    function polar(radius, angle) {
      return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
    }

    const stageNodes = stages.map((stage, index) => {
      const angle = startAngle + (2 * Math.PI * index) / n;
      const pos = polar(stageR, angle);
      return {
        id: `stage:${stage.id}`,
        kind: 'stage',
        stageId: stage.id,
        order: stage.order,
        label_en: stage.label_en,
        label_zh: stage.label_zh,
        angle,
        x: pos.x,
        y: pos.y,
        r: 34
      };
    });

    const playerNodes = [];
    stages.forEach((stage, index) => {
      const stageNode = stageNodes[index];
      const count = stage.players.length || 1;
      stage.players.forEach((player, pIndex) => {
        const spread = 0.38;
        const offset = count === 1 ? 0 : ((pIndex / (count - 1)) - 0.5) * spread;
        const angle = stageNode.angle + offset;
        const pos = polar(playerR, angle);
        playerNodes.push({
          id: `player:${stage.id}:${player.ticker}`,
          kind: 'player',
          stageId: stage.id,
          ticker: player.ticker,
          name_en: player.name_en,
          name_zh: player.name_zh,
          listedInApp: player.listedInApp !== false,
          angle,
          x: pos.x,
          y: pos.y,
          r: 22,
          stageX: stageNode.x,
          stageY: stageNode.y
        });
      });
    });

    const competitors = Array.isArray(data.competitors) ? data.competitors : [];
    const compCount = Math.max(competitors.length, 1);
    // Rivalry row under the spider so gold links stay visually distinct from the stage ring.
    const rivalY = Math.min(height - 40, cy + competitorR * 0.78);
    const rivalSpan = Math.min(width * 0.78, Math.max(220, (compCount - 1) * 96));
    const competitorNodes = competitors.map((row, index) => {
      const t = competitors.length <= 1 ? 0.5 : index / (competitors.length - 1);
      const x = cx - rivalSpan / 2 + rivalSpan * t;
      return {
        id: `competitor:${row.ticker}`,
        kind: 'competitor',
        ticker: row.ticker,
        name_en: row.name_en,
        name_zh: row.name_zh,
        listedInApp: row.listedInApp !== false,
        x,
        y: rivalY,
        r: 20
      };
    });

    const hub = {
      id: `hub:${data.ticker}`,
      kind: 'hub',
      ticker: data.ticker,
      name_en: data.name_en,
      name_zh: data.name_zh,
      x: cx,
      y: cy,
      r: 46
    };

    const mid = (n - 1) / 2;
    const edges = [];

    // Animated supply-flow chain between consecutive stages.
    for (let i = 0; i < stageNodes.length - 1; i += 1) {
      const a = stageNodes[i];
      const b = stageNodes[i + 1];
      edges.push({
        id: `flow:${a.stageId}->${b.stageId}`,
        kind: 'flow',
        from: a.id,
        to: b.id,
        x1: a.x, y1: a.y, x2: b.x, y2: b.y
      });
    }

    // Hub spokes: upstream stages feed the company; company feeds downstream stages.
    stageNodes.forEach((stageNode, index) => {
      const upstream = index <= mid;
      edges.push({
        id: upstream ? `in:${stageNode.stageId}->hub` : `out:hub->${stageNode.stageId}`,
        kind: 'flow',
        from: upstream ? stageNode.id : hub.id,
        to: upstream ? hub.id : stageNode.id,
        x1: upstream ? stageNode.x : hub.x,
        y1: upstream ? stageNode.y : hub.y,
        x2: upstream ? hub.x : stageNode.x,
        y2: upstream ? hub.y : stageNode.y
      });
    });

    // Thin membership spokes player → stage (not animated as primary flow).
    playerNodes.forEach(player => {
      edges.push({
        id: `member:${player.id}`,
        kind: 'member',
        from: player.id,
        to: `stage:${player.stageId}`,
        x1: player.x, y1: player.y, x2: player.stageX, y2: player.stageY
      });
    });

    // Rivalry links (distinct style): hub ↔ competitor.
    competitorNodes.forEach(node => {
      edges.push({
        id: `rival:${node.ticker}`,
        kind: 'competitor',
        from: hub.id,
        to: node.id,
        x1: hub.x, y1: hub.y, x2: node.x, y2: node.y
      });
    });

    return {
      width,
      height,
      hub,
      stages: stageNodes,
      players: playerNodes,
      competitors: competitorNodes,
      edges,
      pack: data
    };
  }

  /** Quadratic control point for a soft bow between two nodes (spider look). */
  function edgePath(edge, bend = 0.18) {
    const mx = (edge.x1 + edge.x2) / 2;
    const my = (edge.y1 + edge.y2) / 2;
    const dx = edge.x2 - edge.x1;
    const dy = edge.y2 - edge.y1;
    const cx = mx - dy * bend;
    const cy = my + dx * bend;
    return `M ${edge.x1.toFixed(1)} ${edge.y1.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${edge.x2.toFixed(1)} ${edge.y2.toFixed(1)}`;
  }

  return {
    TAB_KEY,
    CACHE_DIR,
    normalize,
    flattenPlayers,
    inUniverse,
    load,
    clearCache,
    layoutSpider,
    edgePath,
    symbol
  };
}));
