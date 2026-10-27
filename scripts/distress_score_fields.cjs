'use strict';

const Distress = require('../statement_distress_scores.js');
const { usesFinancialValuationModel } = require('../financial_industry.js');

function isDistressFinancial(stock, ticker = stock?.ticker) {
  if (stock?.fin_valuation?.is_financial === true) return true;
  return usesFinancialValuationModel(stock?.industry, ticker);
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
  nullPfForFinancials = true
} = {}) {
  const financial = isDistressFinancial(stock, ticker);
  const { altman, beneish } = Distress.calculateAll(statements || {}, {
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

  stock.ratingSources = stock.ratingSources || {};
  stock.ratingSources.zScore = { ...ratingPayload(altman, checkedAt), evidenceHash };
  stock.ratingSources.mScore = { ...ratingPayload(beneish, checkedAt), evidenceHash };
  return { altman, beneish, financial };
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
  ratingPayload
};
