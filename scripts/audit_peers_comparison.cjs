#!/usr/bin/env node
'use strict';
/**
 * Offline peers-comparison audit for US + HK tracked stocks.
 * Counts statement-dependent TTM/FY metrics that are blank for in-universe peers
 * when the compact expansion catalogue is used (pre-hydration) vs after loading
 * company evidence caches (post-hydration).
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { select } = require('../peer_comparison.js');

const root = path.resolve(__dirname, '..');

function loadWindowScript(file) {
  const context = { window: {}, console };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  return context;
}

function lastFinite(series) {
  if (!Array.isArray(series)) return null;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(series[i])) return series[i];
  }
  return null;
}

function hasTtmStatements(stock) {
  return Number.isFinite(lastFinite(stock?.statements_raw?.income?.revenue));
}

function loadUsCompany(ticker) {
  const file = path.join(root, 'cache', 'us_companies', `${ticker}.json`);
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.version !== 1 || record.ticker !== ticker || record.stock?.ticker !== ticker) return null;
  return record.stock;
}

function loadHkCompany(ticker) {
  const file = path.join(root, 'cache', 'hk_companies', `${ticker}.json`);
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.version !== 1 || record.ticker !== ticker || record.stock?.ticker !== ticker) return null;
  return record.stock;
}

function loadHkStatements(ticker) {
  const file = path.join(root, 'cache', 'financials', `${ticker}_statements_v2.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ttmMetricAvailability(stock) {
  const income = stock?.statements_raw?.income || {};
  const cashflow = stock?.statements_raw?.cashflow || {};
  const balance = stock?.statements_raw?.balance || {};
  const revenue = lastFinite(income.revenue);
  const operatingIncome = lastFinite(income.operatingIncome);
  const ebitda = lastFinite(income.ebitda);
  const fcf = lastFinite(cashflow.freeCashFlow);
  const equity = lastFinite(balance.totalStockholdersEquity);
  const mcap = Number(stock.mcap);
  const ev = Number(stock.EV ?? stock.ev ?? stock.fmp_official_ev);
  const quotedEv = Number.isFinite(ev) ? ev : mcap;
  const financial = !!stock.fin_valuation?.is_financial;
  return {
    hasStatements: hasTtmStatements(stock),
    revenue: Number.isFinite(revenue),
    operatingIncome: Number.isFinite(operatingIncome),
    ebitda: Number.isFinite(ebitda),
    fcf: Number.isFinite(fcf),
    equity: Number.isFinite(equity),
    evFcf: Number.isFinite(quotedEv) && fcf > 0,
    evRevenue: Number.isFinite(quotedEv) && revenue > 0,
    mcapFcf: Number.isFinite(mcap) && fcf > 0,
    mcapEbitda: Number.isFinite(mcap) && ebitda > 0,
    pbEstimated: Number.isFinite(mcap) && equity > 0,
    operatingMargin: Number.isFinite(revenue) && revenue !== 0 && Number.isFinite(operatingIncome),
    // Gross profit intentionally blank for financials.
    grossProfitApplicable: !financial,
    fcfNonPositive: Number.isFinite(fcf) && fcf <= 0
  };
}

function annualMetricAvailability(stock, statements) {
  if (!statements?.annual?.income || !statements?.annual?.cashflow || !statements?.annual?.balance) {
    return { hasStatements: false };
  }
  const PeerComparison = require('../peer_comparison.js');
  try {
    const viewed = PeerComparison.annualView(stock, statements);
    const income = viewed.peerAnnual.income;
    const cashflow = viewed.peerAnnual.cashflow;
    const balance = viewed.peerAnnual.balance;
    const revenue = income.revenue;
    const fcf = cashflow.freeCashFlow;
    const ebitda = income.ebitda;
    const equity = balance.totalStockholdersEquity;
    const ev = viewed.EV;
    const mcap = Number(stock.mcap);
    return {
      hasStatements: true,
      revenue: Number.isFinite(revenue),
      operatingIncome: Number.isFinite(income.operatingIncome),
      ebitda: Number.isFinite(ebitda),
      fcf: Number.isFinite(fcf),
      equity: Number.isFinite(equity),
      evFcf: Number.isFinite(ev) && fcf > 0,
      evRevenue: Number.isFinite(ev) && revenue > 0,
      mcapFcf: Number.isFinite(mcap) && fcf > 0,
      mcapEbitda: Number.isFinite(mcap) && ebitda > 0,
      pbEstimated: Number.isFinite(mcap) && equity > 0,
      operatingMargin: Number.isFinite(revenue) && revenue !== 0 && Number.isFinite(income.operatingIncome),
      grossProfitApplicable: !viewed.fin_valuation?.is_financial,
      fcfNonPositive: Number.isFinite(fcf) && fcf <= 0
    };
  } catch (error) {
    return { hasStatements: false, error: error.message };
  }
}

const FILLABLE_KEYS = [
  'revenue', 'operatingIncome', 'ebitda', 'fcf', 'equity',
  'evFcf', 'evRevenue', 'mcapFcf', 'mcapEbitda', 'pbEstimated', 'operatingMargin'
];

function blankFillable(availability) {
  if (!availability?.hasStatements) {
    return { blank: FILLABLE_KEYS.length, fillable: FILLABLE_KEYS.length, keys: [...FILLABLE_KEYS] };
  }
  const keys = FILLABLE_KEYS.filter(key => !availability[key]);
  // Exclude expected blanks: non-positive FCF multiples / PB when equity missing for real reasons
  const unexpected = keys.filter(key => {
    if ((key === 'evFcf' || key === 'mcapFcf') && availability.fcfNonPositive) return false;
    return true;
  });
  return { blank: unexpected.length, fillable: FILLABLE_KEYS.length, keys: unexpected, expectedFcfBlank: availability.fcfNonPositive };
}

function auditUs() {
  const ctx = loadWindowScript('us_universe_data.js');
  vm.runInNewContext(fs.readFileSync(path.join(root, 'us_expansion_data.js'), 'utf8'), ctx);
  vm.runInNewContext(fs.readFileSync(path.join(root, 'market_data.js'), 'utf8'), ctx);
  vm.runInNewContext(fs.readFileSync(path.join(root, 'financial_industry.js'), 'utf8'), ctx);
  vm.runInNewContext(fs.readFileSync(path.join(root, 'us_universe.js'), 'utf8'), ctx);
  const universe = ctx.UsUniverse.merge(ctx.FULL_MARKET_DATA, ctx.US_LISTINGS, ctx.US_EXPANSION);
  const targets = Object.keys(universe).filter(ticker => universe[ticker]?.expansion?.status !== 'pendingCapture'
    && universe[ticker]?.expansion?.status !== 'unavailable');
  const summary = {
    market: 'US', mode: 'TTM', targets: 0, peerSlots: 0,
    compactMissingStatements: 0, cacheMissing: 0,
    compactBlankMetrics: 0, hydratedBlankMetrics: 0,
    compactFillableMetrics: 0, hydratedFillableMetrics: 0,
    targetsWithCompactPeerBlanks: 0,
    patternCounts: {
      expansionCompactNoStatements: 0,
      companyCacheMissing: 0,
      nonPositiveFcfMultiples: 0,
      remainingAfterHydration: 0
    },
    examples: []
  };
  for (const ticker of targets) {
    let selection;
    try { selection = select(universe, ticker); } catch { continue; }
    summary.targets += 1;
    let targetHadBlank = false;
    for (const peer of selection.peers) {
      summary.peerSlots += 1;
      const compact = peer.stock;
      const compactAvail = ttmMetricAvailability(compact);
      const compactBlank = blankFillable(compactAvail);
      summary.compactFillableMetrics += compactBlank.fillable;
      summary.compactBlankMetrics += compactBlank.blank;
      if (!compactAvail.hasStatements) {
        summary.compactMissingStatements += 1;
        summary.patternCounts.expansionCompactNoStatements += 1;
      }
      const full = loadUsCompany(peer.ticker) || (hasTtmStatements(compact) ? compact : null);
      if (!full) {
        summary.cacheMissing += 1;
        summary.patternCounts.companyCacheMissing += 1;
        summary.hydratedFillableMetrics += FILLABLE_KEYS.length;
        summary.hydratedBlankMetrics += FILLABLE_KEYS.length;
        targetHadBlank = true;
        continue;
      }
      const hydratedAvail = ttmMetricAvailability(full);
      const hydratedBlank = blankFillable(hydratedAvail);
      summary.hydratedFillableMetrics += hydratedBlank.fillable;
      summary.hydratedBlankMetrics += hydratedBlank.blank;
      if (hydratedAvail.fcfNonPositive) summary.patternCounts.nonPositiveFcfMultiples += 1;
      if (hydratedBlank.blank) {
        summary.patternCounts.remainingAfterHydration += 1;
        targetHadBlank = true;
      }
      if (compactBlank.blank && summary.examples.length < 12) {
        summary.examples.push({
          target: ticker, peer: peer.ticker, basis: peer.basis,
          compactBlankKeys: compactBlank.keys, hydratedBlankKeys: hydratedBlank.keys,
          compactHasStatements: compactAvail.hasStatements, cacheLoaded: true
        });
      }
      if (compactBlank.blank) targetHadBlank = true;
    }
    if (targetHadBlank) summary.targetsWithCompactPeerBlanks += 1;
  }
  return summary;
}

function auditHk() {
  const ctx = loadWindowScript('hkex_universe_data.js');
  const expansionFile = path.join(root, 'hkex_expansion_data.js');
  if (fs.existsSync(expansionFile)) {
    vm.runInNewContext(fs.readFileSync(expansionFile, 'utf8'), ctx);
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, 'hk_market_data.js'), 'utf8'), ctx);
  vm.runInNewContext(fs.readFileSync(path.join(root, 'hkex_universe.js'), 'utf8'), ctx);
  const universe = ctx.HkUniverse.merge(ctx.HK_MARKET_DATA || ctx.window?.HK_MARKET_DATA,
    ctx.HKEX_LISTINGS || ctx.window?.HKEX_LISTINGS,
    ctx.HKEX_EXPANSION || ctx.window?.HKEX_EXPANSION);
  const summary = {
    market: 'HK', mode: 'latest full FY', targets: 0, peerSlots: 0,
    compactMissingStatements: 0, cacheMissing: 0,
    compactBlankMetrics: 0, hydratedBlankMetrics: 0,
    compactFillableMetrics: 0, hydratedFillableMetrics: 0,
    targetsWithCompactPeerBlanks: 0,
    patternCounts: {
      expansionCompactNoStatements: 0,
      companyCacheMissing: 0,
      statementsLoadFailed: 0,
      nonPositiveFcfMultiples: 0,
      remainingAfterHydration: 0
    },
    examples: []
  };
  // HK UI loads statements for every column; compact omission is OK if financials cache exists.
  for (const ticker of Object.keys(universe)) {
    const stock = universe[ticker];
    if (stock?.expansion?.status === 'pendingCapture' || stock?.expansion?.status === 'unavailable') continue;
    let selection;
    try { selection = select(universe, ticker); } catch { continue; }
    summary.targets += 1;
    let targetHadBlank = false;
    for (const peer of selection.peers) {
      summary.peerSlots += 1;
      const compact = peer.stock;
      const compactHas = hasTtmStatements(compact);
      if (!compactHas) {
        summary.compactMissingStatements += 1;
        summary.patternCounts.expansionCompactNoStatements += 1;
      }
      // Pre-hydration "TTM-style" blank if someone read statements_raw without loading annual packs.
      const compactBlank = blankFillable(ttmMetricAvailability(compact));
      summary.compactFillableMetrics += compactBlank.fillable;
      summary.compactBlankMetrics += compactBlank.blank;

      const company = loadHkCompany(peer.ticker);
      const statements = loadHkStatements(peer.ticker);
      if (!statements) {
        summary.cacheMissing += 1;
        summary.patternCounts.companyCacheMissing += 1;
        summary.hydratedFillableMetrics += FILLABLE_KEYS.length;
        summary.hydratedBlankMetrics += FILLABLE_KEYS.length;
        targetHadBlank = true;
        continue;
      }
      const hydratedStock = company || compact;
      const hydratedAvail = annualMetricAvailability(hydratedStock, statements);
      if (!hydratedAvail.hasStatements) {
        summary.patternCounts.statementsLoadFailed += 1;
        summary.hydratedFillableMetrics += FILLABLE_KEYS.length;
        summary.hydratedBlankMetrics += FILLABLE_KEYS.length;
        targetHadBlank = true;
        continue;
      }
      const hydratedBlank = blankFillable(hydratedAvail);
      summary.hydratedFillableMetrics += hydratedBlank.fillable;
      summary.hydratedBlankMetrics += hydratedBlank.blank;
      if (hydratedAvail.fcfNonPositive) summary.patternCounts.nonPositiveFcfMultiples += 1;
      if (hydratedBlank.blank) {
        summary.patternCounts.remainingAfterHydration += 1;
        targetHadBlank = true;
      }
      if (compactBlank.blank && summary.examples.length < 8) {
        summary.examples.push({
          target: ticker, peer: peer.ticker, basis: peer.basis,
          compactBlankKeys: compactBlank.keys, hydratedBlankKeys: hydratedBlank.keys,
          compactHasStatements: compactHas, cacheLoaded: true
        });
      }
      if (compactBlank.blank) targetHadBlank = true;
    }
    if (targetHadBlank) summary.targetsWithCompactPeerBlanks += 1;
  }
  return summary;
}

function rate(blank, fillable) {
  return fillable ? `${((100 * blank) / fillable).toFixed(1)}%` : 'n/a';
}

function main() {
  const us = auditUs();
  const hk = auditHk();
  const report = {
    generatedAt: new Date().toISOString(),
    fillableMetricKeys: FILLABLE_KEYS,
    us, hk,
    pypl: (() => {
      const ctx = loadWindowScript('us_universe_data.js');
      vm.runInNewContext(fs.readFileSync(path.join(root, 'us_expansion_data.js'), 'utf8'), ctx);
      vm.runInNewContext(fs.readFileSync(path.join(root, 'market_data.js'), 'utf8'), ctx);
      vm.runInNewContext(fs.readFileSync(path.join(root, 'financial_industry.js'), 'utf8'), ctx);
      vm.runInNewContext(fs.readFileSync(path.join(root, 'us_universe.js'), 'utf8'), ctx);
      const universe = ctx.UsUniverse.merge(ctx.FULL_MARKET_DATA, ctx.US_LISTINGS, ctx.US_EXPANSION);
      const selection = select(universe, 'PYPL');
      return {
        unavailableOutsideUniverse: selection.unavailable,
        peers: selection.peers.map(peer => {
          const compact = ttmMetricAvailability(peer.stock);
          const full = loadUsCompany(peer.ticker);
          const hydrated = full ? ttmMetricAvailability(full) : null;
          return {
            ticker: peer.ticker, basis: peer.basis,
            compactHasStatements: compact.hasStatements,
            compactBlank: blankFillable(compact),
            hydratedBlank: hydrated ? blankFillable(hydrated) : null,
            fcf: full ? lastFinite(full.statements_raw?.cashflow?.freeCashFlow) : null
          };
        })
      };
    })()
  };
  const out = process.argv[2] || path.join(root, 'cache', 'peers_comparison_audit.json');
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    wrote: out,
    us: {
      targets: us.targets, peerSlots: us.peerSlots,
      compactBlankRate: rate(us.compactBlankMetrics, us.compactFillableMetrics),
      hydratedBlankRate: rate(us.hydratedBlankMetrics, us.hydratedFillableMetrics),
      compactMissingStatements: us.compactMissingStatements,
      cacheMissing: us.cacheMissing,
      patterns: us.patternCounts
    },
    hk: {
      targets: hk.targets, peerSlots: hk.peerSlots,
      compactBlankRate: rate(hk.compactBlankMetrics, hk.compactFillableMetrics),
      hydratedBlankRate: rate(hk.hydratedBlankMetrics, hk.hydratedFillableMetrics),
      compactMissingStatements: hk.compactMissingStatements,
      cacheMissing: hk.cacheMissing,
      patterns: hk.patternCounts
    },
    pyplPeers: report.pypl.peers.map(p => p.ticker)
  }, null, 2));
}

main();
