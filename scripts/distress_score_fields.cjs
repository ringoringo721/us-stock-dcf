'use strict';

const fs = require('fs');
const path = require('path');
const Distress = require('../statement_distress_scores.js');
const { usesFinancialValuationModel } = require('../financial_industry.js');

function isDistressFinancial(stock, ticker = stock?.ticker) {
  if (stock?.fin_valuation?.is_financial === true) return true;
  return usesFinancialValuationModel(stock?.industry, ticker);
}

function hasAnnualIncome(statements) {
  return Array.isArray(statements?.annual?.income) && statements.annual.income.length > 0;
}

// Preferred / unit tickers (SMCIP, MCHPP) often ship empty FMP packs; issuer common
// stock statements (SMCI, MCHP) are the correct Beneish/Altman inputs.
const STATEMENT_PARENT_ALIASES = Object.freeze({
  SMCIP: 'SMCI',
  MCHPP: 'MCHP',
  BIPI: 'BIP' // BIP Bermuda Holdings I — use Brookfield Infrastructure Partner packs
});

function preferredParentTicker(ticker) {
  const symbol = String(ticker || '').toUpperCase();
  if (STATEMENT_PARENT_ALIASES[symbol]) return STATEMENT_PARENT_ALIASES[symbol];
  if (!/^[A-Z0-9]{1,5}P$/.test(symbol)) return null;
  return symbol.slice(0, -1);
}

function resolveDistressStatements(ticker, statements, { rootDir = path.join(__dirname, '..') } = {}) {
  const parent = preferredParentTicker(ticker);
  const ownUsable = hasAnnualIncome(statements);
  // Prefer own pack when it can form scores; otherwise fall back to issuer common.
  // BIPI has misaligned cashflow years — force parent even if income rows exist.
  const forceParent = parent && STATEMENT_PARENT_ALIASES[String(ticker || '').toUpperCase()] === parent
    && String(ticker || '').toUpperCase() === 'BIPI';
  if (ownUsable && !forceParent) {
    return { statements, sourceTicker: ticker, inheritedFrom: null };
  }
  if (!parent) {
    return { statements: statements || null, sourceTicker: ticker, inheritedFrom: null };
  }
  const parentFile = path.join(rootDir, 'cache/financials', `${parent}_statements_v2.json`);
  if (!fs.existsSync(parentFile)) {
    return { statements: statements || null, sourceTicker: ticker, inheritedFrom: null };
  }
  const parentStatements = JSON.parse(fs.readFileSync(parentFile, 'utf8'));
  if (!hasAnnualIncome(parentStatements)) {
    return { statements: statements || null, sourceTicker: ticker, inheritedFrom: null };
  }
  return { statements: parentStatements, sourceTicker: parent, inheritedFrom: parent };
}

function ratingPayload(result, checkedAt = new Date().toISOString()) {
  return {
    asOfDate: result.date || null,
    period: result.period || null,
    basis: result.basis || null,
    model: result.model || null,
    zone: result.zone || null,
    reason: result.reason || null,
    scoringCurrency: result.scoringCurrency || null,
    applicability: result.applicability || (result.reason === 'financialSectorNotApplicable'
      ? 'financialSector' : null),
    checkedAt,
    evidenceHash: null
  };
}

function attachDistressScores(stock, statements, {
  ticker = stock?.ticker,
  checkedAt = new Date().toISOString(),
  evidenceHash = null,
  nullPfForFinancials = true,
  rootDir = path.join(__dirname, '..')
} = {}) {
  const financial = isDistressFinancial(stock, ticker);
  const resolved = resolveDistressStatements(ticker, statements, { rootDir });
  const { altman, beneish } = Distress.calculateAll(resolved.statements || {}, {
    isFinancial: financial,
    mcapMillions: Number.isFinite(stock?.mcap) ? stock.mcap : null,
    altmanModel: 'z'
  });

  if (nullPfForFinancials && financial) {
    stock.f_score = null;
    stock.f_score_breakdown = [];
    stock.ratingSources = stock.ratingSources || {};
    stock.ratingSources.fScore = {
      ...(stock.ratingSources.fScore || {}),
      score: null,
      reason: 'financialSectorNotApplicable',
      applicability: 'Banks and insurers use regulatory-capital metrics; standard PF / Altman / Beneish tests are not applicable',
      assessmentType: undefined,
      applicableTests: undefined,
      standardScore: undefined,
      currentRatioApplicability: undefined,
      checkedAt
    };
  }

  stock.z_score = altman.score;
  stock.z_score_model = altman.model || (financial ? null : 'z');
  stock.z_score_zone = altman.zone;
  stock.z_score_breakdown = Array.isArray(altman.items) ? altman.items : [];
  stock.m_score = beneish.score;
  stock.m_score_zone = beneish.zone;
  stock.m_score_breakdown = Array.isArray(beneish.items) ? beneish.items : [];

  const inheritMeta = resolved.inheritedFrom
    ? { statementSourceTicker: resolved.inheritedFrom, statementSource: 'preferredParentCommon' }
    : {};
  stock.ratingSources = stock.ratingSources || {};
  stock.ratingSources.zScore = { ...ratingPayload(altman, checkedAt), evidenceHash, ...inheritMeta };
  stock.ratingSources.mScore = { ...ratingPayload(beneish, checkedAt), evidenceHash, ...inheritMeta };
  return { altman, beneish, financial, inheritedFrom: resolved.inheritedFrom };
}

function stripCompactBreakdowns(stock) {
  if (!stock) return stock;
  stock.z_score_breakdown = [];
  stock.m_score_breakdown = [];
  return stock;
}

module.exports = {
  isDistressFinancial,
  attachDistressScores,
  stripCompactBreakdowns,
  ratingPayload,
  preferredParentTicker,
  resolveDistressStatements,
  hasAnnualIncome
};
