#!/usr/bin/env node
'use strict';
/**
 * Restore HK expansion company-cache Buffett moat comments wiped when
 * repair_hkex_share_capital_apply.cjs merged score-only expansion compact rows
 * over full cache/hk_companies snapshots (PR #106).
 *
 * Zero Gemini. Restores moat + score breakdowns + ratingSources.moat.businessResearch
 * from a pre-wipe git revision while keeping current verified share fields.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const DIMS = [
  'm1_brand_pricing', 'm2_patents_regulatory', 'm3_high_switching_costs',
  'm4_network_effects', 'm5_cost_advantage_scale', 'm6_unique_geography_assets',
  'm7_operational_efficiency', 'm8_capital_allocation', 'm9_customer_retention',
  'm10_durability'
];
const SHARE_KEYS = new Set([
  'shares', 'shares_display', 'shares_outstanding', 'shareBasis', 'shareSource',
  'fair_val', 'default_fair_val', 'premium_pct', 'is_undervalued', 'fin_valuation',
  'liquidation', 'mcap'
]);

const priorRev = process.argv.find(arg => arg.startsWith('--prior='))?.slice('--prior='.length)
  || '0caa9db81';
const dryRun = process.argv.includes('--dry-run');

function zhCount(moat) {
  if (!moat || typeof moat !== 'object') return 0;
  return DIMS.reduce((n, key) => n + (((moat[key] || {}).comment_zh || '').trim() ? 1 : 0), 0);
}

function scoreCount(moat) {
  if (!moat || typeof moat !== 'object') return 0;
  return DIMS.reduce((n, key) => {
    const score = moat[key]?.score;
    return n + (typeof score === 'number' && Number.isFinite(score) ? 1 : 0);
  }, 0);
}

function readPriorCompany(ticker) {
  const file = `cache/hk_companies/${ticker}.json`;
  try {
    return JSON.parse(execFileSync('git', ['show', `${priorRev}:${file}`], {
      cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
    }));
  } catch {
    return null;
  }
}

function restoreOne(ticker) {
  const file = path.join(root, 'cache', 'hk_companies', `${ticker}.json`);
  if (!fs.existsSync(file)) return { status: 'missing' };
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const prior = readPriorCompany(ticker);
  if (!prior?.stock) return { status: 'missingPrior' };

  const curMoat = current.stock.moat;
  const priorMoat = prior.stock.moat;
  const curZh = zhCount(curMoat);
  const priorZh = zhCount(priorMoat);
  if (priorZh < 10) return { status: 'priorIncomplete', priorZh, curZh };
  if (curZh === 10) return { status: 'alreadyFull', priorZh, curZh };
  if (scoreCount(curMoat) === 0 && scoreCount(priorMoat) === 0) {
    return { status: 'noScores', priorZh, curZh };
  }

  const nextStock = { ...current.stock, moat: priorMoat };
  for (const key of ['f_score_breakdown', 'z_score_breakdown', 'm_score_breakdown']) {
    const priorRows = prior.stock[key];
    const curRows = current.stock[key];
    if (Array.isArray(priorRows) && priorRows.length
        && (!Array.isArray(curRows) || curRows.length === 0)) {
      nextStock[key] = priorRows;
    }
  }
  const priorMoatSource = prior.stock.ratingSources?.moat;
  const curMoatSource = current.stock.ratingSources?.moat;
  if (priorMoatSource?.businessResearch && !curMoatSource?.businessResearch) {
    nextStock.ratingSources = {
      ...(current.stock.ratingSources || {}),
      moat: {
        ...(curMoatSource || {}),
        businessResearch: priorMoatSource.businessResearch
      }
    };
    if ('businessResearchSourceCount' in (nextStock.ratingSources.moat || {})) {
      delete nextStock.ratingSources.moat.businessResearchSourceCount;
    }
  }
  // Never let prior share fields overwrite the verified capital repair.
  for (const key of SHARE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(current.stock, key)) {
      nextStock[key] = current.stock[key];
    }
  }

  if (!dryRun) {
    fs.writeFileSync(file, `${JSON.stringify({ ...current, stock: nextStock })}\n`);
  }
  return {
    status: 'restored',
    priorZh,
    curZh,
    shares: nextStock.shares,
    shareBasis: nextStock.shareBasis
  };
}

function listTargets() {
  const dir = path.join(root, 'cache', 'hk_companies');
  return fs.readdirSync(dir).filter(name => name.endsWith('.HK.json')).map(name => name.replace(/\.json$/, ''));
}

const summary = {
  priorRev,
  dryRun,
  restored: [],
  alreadyFull: 0,
  priorIncomplete: [],
  missingPrior: [],
  missing: [],
  noScores: []
};

for (const ticker of listTargets()) {
  const file = path.join(root, 'cache', 'hk_companies', `${ticker}.json`);
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const curZh = zhCount(current.stock?.moat);
  const curScores = scoreCount(current.stock?.moat);
  if (!(curScores > 0 && curZh < 10)) continue;
  const result = restoreOne(ticker);
  if (result.status === 'restored') summary.restored.push({ ticker, ...result });
  else if (result.status === 'alreadyFull') summary.alreadyFull += 1;
  else if (result.status === 'priorIncomplete') summary.priorIncomplete.push({ ticker, ...result });
  else if (result.status === 'missingPrior') summary.missingPrior.push(ticker);
  else if (result.status === 'missing') summary.missing.push(ticker);
  else if (result.status === 'noScores') summary.noScores.push(ticker);
}

console.log(JSON.stringify({
  priorRev: summary.priorRev,
  dryRun: summary.dryRun,
  restored: summary.restored.length,
  alreadyFull: summary.alreadyFull,
  priorIncomplete: summary.priorIncomplete.length,
  missingPrior: summary.missingPrior.length,
  missing: summary.missing.length,
  noScores: summary.noScores.length,
  includes1766: summary.restored.some(row => row.ticker === '1766.HK'),
  sample: summary.restored.filter(row => row.ticker === '1766.HK')
    .concat(summary.restored.slice(0, 8)).slice(0, 9),
  priorIncompleteSample: summary.priorIncomplete.slice(0, 12)
}, null, 2));
