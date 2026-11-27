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
  const CACHE_DIR = '/cache/supply-chain';

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
  const quoteMemory = Object.create(null);

  function finiteNumber(value) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function normalizeQuote(raw, tickerHint) {
    if (!raw || typeof raw !== 'object') return null;
    const ticker = symbol(raw.ticker || tickerHint);
    if (!ticker) return null;
    return {
      ticker,
      price: finiteNumber(raw.price),
      previousClose: finiteNumber(raw.previousClose),
      changePct: finiteNumber(raw.changePct ?? raw.changesPercentage ?? raw.changePercentage),
      mcap: finiteNumber(raw.mcap),
      currency: text(raw.currency) || 'USD',
      asOf: text(raw.asOf) || text(raw.date) || '',
      source: text(raw.source) || ''
    };
  }

  function normalizeQuotesPack(pack, expectedTicker) {
    if (!pack || typeof pack !== 'object') return { ticker: symbol(expectedTicker), quotes: {} };
    const ticker = symbol(pack.ticker || expectedTicker);
    const quotes = Object.create(null);
    const rawMap = pack.quotes && typeof pack.quotes === 'object' ? pack.quotes : {};
    Object.keys(rawMap).forEach((key) => {
      const row = normalizeQuote(rawMap[key], key);
      if (row) quotes[row.ticker] = row;
    });
    return {
      version: pack.version || 1,
      ticker,
      updatedAt: text(pack.updatedAt) || '',
      basis: text(pack.basis) || '',
      notes_en: text(pack.notes_en),
      notes_zh: text(pack.notes_zh),
      quotes
    };
  }

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

  /**
   * Optional quote snapshot for spider node badges.
   * Missing file → empty map (UI shows N/A); non-404 HTTP → reject so callers can warn.
   */
  function loadQuotes(ticker, options = {}) {
    const key = symbol(ticker);
    if (!key) return Promise.reject(new RangeError('Supply-chain ticker required'));
    if (!options.reload && quoteMemory[key]) return Promise.resolve(quoteMemory[key]);
    const url = `${CACHE_DIR}/${encodeURIComponent(key)}.quotes.json`;
    return fetch(url, { cache: 'no-store' }).then(async (response) => {
      if (response.status === 404) {
        const empty = normalizeQuotesPack({ ticker: key, quotes: {} }, key);
        quoteMemory[key] = empty;
        return empty;
      }
      if (!response.ok) {
        const err = new Error(`SUPPLY_CHAIN_QUOTES_FAILED:${key}:${response.status}`);
        err.code = 'SUPPLY_CHAIN_QUOTES_FAILED';
        err.status = response.status;
        throw err;
      }
      const pack = normalizeQuotesPack(await response.json(), key);
      quoteMemory[key] = pack;
      return pack;
    });
  }

  /** Overlay live universe price/mcap onto quote snapshot when present. */
  function mergeUniverseQuotes(quotesPack, universe, tickers) {
    const pack = quotesPack && quotesPack.quotes
      ? quotesPack
      : normalizeQuotesPack(quotesPack, quotesPack?.ticker);
    const out = { ...pack, quotes: { ...pack.quotes } };
    const list = Array.isArray(tickers) ? tickers : Object.keys(out.quotes);
    list.forEach((rawTicker) => {
      const key = symbol(rawTicker);
      if (!key) return;
      const stock = universe && (universe[key] || universe[rawTicker]);
      const base = out.quotes[key] || { ticker: key, price: null, changePct: null, mcap: null, currency: 'USD', asOf: '', source: '' };
      if (!stock) {
        out.quotes[key] = base;
        return;
      }
      const price = finiteNumber(stock.price);
      const mcap = finiteNumber(stock.mcap);
      out.quotes[key] = {
        ...base,
        price: price != null ? price : base.price,
        mcap: mcap != null ? mcap : base.mcap,
        currency: text(stock.calculationCurrency) || base.currency || 'USD'
      };
    });
    return out;
  }

  function clearCache(ticker) {
    if (ticker) {
      const key = symbol(ticker);
      delete memory[key];
      delete quoteMemory[key];
    } else {
      Object.keys(memory).forEach(k => delete memory[k]);
      Object.keys(quoteMemory).forEach(k => delete quoteMemory[k]);
    }
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
    const stages = data.stages;
    const n = Math.max(stages.length, 1);
    // 6-stage packs (e.g. passenger airlines) need a taller canvas so the southern
    // rivalry arc + quote lines stay inside the viewBox instead of clipping.
    const width = Number(options.width) || (n >= 6 ? 1220 : 1100);
    // Extra height + lower hub for n≥6 so northern stage players (ASR/PAC/AER) are not clipped.
    let height = Number(options.height) || (n >= 6 ? 1120 : 860);
    const cx = width / 2;
    let cy = height * (n >= 6 ? 0.44 : 0.40);
    const stageR = Number(options.stageRadius) || Math.min(width, height) * (n >= 6 ? 0.22 : 0.25);
    const playerR = Number(options.playerRadius) || Math.min(width, height) * (n >= 6 ? 0.33 : 0.38);
    // Competitors live on a separate outer southern arc — never on the player ring.
    const competitorR = Number(options.competitorRadius) || Math.min(width, height) * (n >= 6 ? 0.48 : 0.54);
    // With more stages, shrink the south reserve so stages are not crushed into ~30° wedges
    // (LTM screenshot: 6 stages + Top-3 fan cap left awkward gaps and edge collisions).
    // Keep enough south for rivals, but prefer stage readability when n≥6.
    const southGap = n >= 6
      ? Math.PI * 0.78
      : n >= 5
        ? Math.PI * 0.90
        : Math.PI * 1.02;
    const stageSweep = (2 * Math.PI) - southGap;
    const stageStart = (Math.PI / 2) + (southGap / 2); // leave south, sweep CCW through W→N→E
    // Match competitor packing: ticker + company name + quote + mcap under the node.
    const playerNodeR = 24;
    // Chord clearance at playerR for packing Top-N in a fan.
    const minPlayerGap = (2 * playerNodeR) + 14;
    const gapAngle = minPlayerGap / Math.max(playerR, 1);
    const minFanForThree = 2 * gapAngle;
    const playerEdgePad = Math.max(0.06, gapAngle * 0.30);
    const provisionalStep = n <= 1 ? stageSweep : stageSweep / (n - 1);
    // Cap any stage fan so neighbouring stages cannot collide; still allow Top-3 clearance.
    const playerFanCap = Math.min(
      provisionalStep * (n >= 6 ? 0.58 : 0.72),
      Math.max(minFanForThree, n >= 6 ? 0.34 : 0.42)
    );
    /** Fan width in radians for this stage's actual player count (no empty Top-3 pad). */
    function fanWidthForCount(count) {
      const c = Math.max(1, count | 0);
      if (c <= 1) return 0;
      const needed = (c - 1) * gapAngle;
      // 2-player stages stay tight under their stage node (LTM stage 5 BKNG/EXPE).
      const floor = c === 2 ? Math.min(0.26, needed) : Math.min(minFanForThree, needed);
      return Math.min(playerFanCap, Math.max(floor, needed * 0.92));
    }
    const maxStageFan = stages.reduce(
      (max, stage) => Math.max(max, fanWidthForCount((stage.players || []).length)),
      0
    );
    // Inset end stages by the largest fan so players never enter the rival south gap.
    const stageInset = (Math.max(maxStageFan, playerFanCap) / 2) + playerEdgePad;
    const usableSweep = Math.max(stageSweep - (2 * stageInset), minFanForThree);
    const stageStep = n <= 1 ? usableSweep : usableSweep / (n - 1);

    function polar(radius, angle) {
      return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
    }

    function overlaps(a, b, pad = 10) {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const min = (a.r || 0) + (b.r || 0) + pad;
      return (dx * dx + dy * dy) < (min * min);
    }

    /** Param along the stage sweep only (0…stageSweep). No wrap into the rival gap. */
    function stageParam(angle) {
      let t = angle - stageStart;
      const twoPi = Math.PI * 2;
      t = ((t % twoPi) + twoPi) % twoPi;
      return Math.min(Math.max(t, 0), stageSweep);
    }

    const stageNodes = stages.map((stage, index) => {
      const param = n === 1
        ? stageSweep / 2
        : stageInset + (stageStep * index);
      const angle = stageStart + param;
      const pos = polar(stageR, angle);
      return {
        id: `stage:${stage.id}`,
        kind: 'stage',
        stageId: stage.id,
        order: stage.order,
        label_en: stage.label_en,
        label_zh: stage.label_zh,
        angle,
        param,
        x: pos.x,
        y: pos.y,
        r: 34
      };
    });

    const playerNodes = [];
    stages.forEach((stage, index) => {
      const stageNode = stageNodes[index];
      const count = stage.players.length || 1;
      const fan = fanWidthForCount(count);
      const half = fan / 2;
      // Symmetric fan in param-space, hard-clamped to the inset legal arc (no rival bearings).
      const loParam = Math.max(playerEdgePad, stageNode.param - half);
      const hiParam = Math.min(stageSweep - playerEdgePad, stageNode.param + half);
      stage.players.forEach((player, pIndex) => {
        const param = count === 1
          ? stageNode.param
          : loParam + ((hiParam - loParam) * pIndex) / (count - 1);
        const angle = stageStart + param;
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
          param,
          x: pos.x,
          y: pos.y,
          r: playerNodeR,
          stageX: stageNode.x,
          stageY: stageNode.y
        });
      });
    });

    const competitors = Array.isArray(data.competitors) ? data.competitors : [];
    // Keep rivals in a compact southern band under the hub — do not stretch to the
    // full southGap edges (that pulled end rivals into stage-1/6 players and clipped).
    const rivalPad = n >= 6 ? 0.18 : 0.22;
    const rivalSpanCap = n >= 6 ? Math.PI * 0.52 : Math.PI * 0.70;
    const rivalSpan = Math.min(Math.max(southGap - (2 * rivalPad), Math.PI * 0.36), rivalSpanCap);
    const rivalMid = Math.PI / 2;
    const rivalStart = rivalMid - (rivalSpan / 2);
    const rivalEnd = rivalMid + (rivalSpan / 2);
    // Side padding so leftmost/rightmost rivals stay inside the SVG (badge + name width).
    const rivalXPad = 56;
    const competitorNodes = competitors.map((row, index) => {
      const t = competitors.length <= 1 ? 0.5 : index / (competitors.length - 1);
      const angle = rivalStart + (rivalEnd - rivalStart) * t;
      const pos = polar(competitorR, angle);
      return {
        id: `competitor:${row.ticker}`,
        kind: 'competitor',
        ticker: row.ticker,
        name_en: row.name_en,
        name_zh: row.name_zh,
        role_en: row.role_en,
        role_zh: row.role_zh,
        listedInApp: row.listedInApp !== false,
        angle,
        x: Math.min(width - rivalXPad, Math.max(rivalXPad, pos.x)),
        y: pos.y,
        // Larger hit target: rival nodes carry badge + name + quote lines.
        r: 24
      };
    });

    // Safety: if any rival still collides with a player/stage, push it farther south on the same ray.
    const rivalBottomPad = 58; // room for quote/mcap under the node + rivalry caption
    competitorNodes.forEach(comp => {
      let guard = 0;
      while (guard < 8 && [...playerNodes, ...stageNodes].some(node => overlaps(comp, node, 16))) {
        const next = polar(competitorR + 36 * (guard + 1), comp.angle);
        comp.x = Math.min(width - rivalXPad, Math.max(rivalXPad, next.x));
        comp.y = Math.min(height - rivalBottomPad, next.y);
        guard += 1;
      }
      // Keep badge (drawn above the circle) inside the viewBox.
      if (comp.y - 40 < cy + stageR) {
        comp.y = Math.min(height - rivalBottomPad, Math.max(comp.y, cy + competitorR * 0.92));
      }
    });

    const rivalMaxY = competitorNodes.reduce((m, node) => Math.max(m, node.y), cy + competitorR);
    // Geometry for a southern “rivalry zone” caption (rendered by the SVG layer).
    const rivalryZone = {
      kind: 'rivalry-zone',
      x: cx,
      y: Math.min(height - 22, rivalMaxY + 48),
      width: Math.max(220, Math.min(width - 80, competitorR * 1.05)),
      label_en: 'Competitors (rivalry — not supply flow)',
      label_zh: '競爭對手區（對抗關係｜非供應流）'
    };

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

    // Primary whole-chain flow: consecutive stages (materials → … → retail).
    for (let i = 0; i < stageNodes.length - 1; i += 1) {
      const a = stageNodes[i];
      const b = stageNodes[i + 1];
      edges.push({
        id: `chain:${a.stageId}->${b.stageId}`,
        kind: 'flow-chain',
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

    // Fit vertical bounds: keep player labels (~28px above) and rivalry caption inside viewBox.
    const topPad = 52;
    const bottomPad = 36;
    const allNodes = [hub, ...stageNodes, ...playerNodes, ...competitorNodes];
    let minY = Infinity;
    let maxY = -Infinity;
    allNodes.forEach(node => {
      const top = node.y - (node.kind === 'competitor' ? 40 : node.r + 6);
      const bot = node.y + (node.r || 24) + 30;
      if (top < minY) minY = top;
      if (bot > maxY) maxY = bot;
    });
    if (rivalryZone.y + 18 > maxY) maxY = rivalryZone.y + 18;
    const shiftY = minY < topPad ? (topPad - minY) : 0;
    if (shiftY > 0) {
      allNodes.forEach(node => { node.y += shiftY; });
      playerNodes.forEach(node => { node.stageY += shiftY; });
      edges.forEach(edge => {
        edge.y1 += shiftY;
        edge.y2 += shiftY;
      });
      rivalryZone.y += shiftY;
      maxY += shiftY;
      cy += shiftY;
    }
    const needHeight = Math.ceil(maxY + bottomPad);
    if (needHeight > height) height = needHeight;

    // Pull endpoints back to each node's rim so marker-end arrowheads are not
    // buried under the destination circle (edges previously terminated at centers).
    const nodesById = Object.fromEntries(allNodes.map(node => [node.id, node]));
    edges.forEach(edge => {
      const from = nodesById[edge.from];
      const to = nodesById[edge.to];
      if (!from || !to) return;
      const dx = edge.x2 - edge.x1;
      const dy = edge.y2 - edge.y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const tipPad = edge.kind === 'flow-chain' ? 3 : 2;
      const startInset = (from.r || 0) + tipPad;
      const endInset = (to.r || 0) + tipPad;
      if (startInset + endInset >= len - 4) return;
      edge.x1 += ux * startInset;
      edge.y1 += uy * startInset;
      edge.x2 -= ux * endInset;
      edge.y2 -= uy * endInset;
    });

    return {
      width,
      height,
      hub,
      stages: stageNodes,
      players: playerNodes,
      competitors: competitorNodes,
      rivalryZone,
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

  /** Point at t∈[0,1] along the same quadratic used by edgePath (for labels). */
  function edgePoint(edge, t = 0.5, bend = 0.18) {
    const mx = (edge.x1 + edge.x2) / 2;
    const my = (edge.y1 + edge.y2) / 2;
    const dx = edge.x2 - edge.x1;
    const dy = edge.y2 - edge.y1;
    const cpx = mx - dy * bend;
    const cpy = my + dx * bend;
    const u = 1 - t;
    return {
      x: (u * u * edge.x1) + (2 * u * t * cpx) + (t * t * edge.x2),
      y: (u * u * edge.y1) + (2 * u * t * cpy) + (t * t * edge.y2)
    };
  }

  return {
    TAB_KEY,
    CACHE_DIR,
    normalize,
    flattenPlayers,
    inUniverse,
    load,
    loadQuotes,
    mergeUniverseQuotes,
    clearCache,
    layoutSpider,
    edgePath,
    edgePoint,
    symbol
  };
}));
