'use strict';

const fs = require('fs');
const path = require('path');
const Distress = require('../statement_distress_scores.js');
const { usesFinancialValuationModel } = require('../financial_industry.js');
const { rateFor } = require('../usd_currency.js');

const USD_RATES_PATH = path.join(__dirname, '..', 'cache', 'fx', 'usd_rates.json');
let cachedUsdRates = null;

function loadUsdRates(rootDir = path.join(__dirname, '..')) {
  const file = path.join(rootDir, 'cache', 'fx', 'usd_rates.json');
  if (cachedUsdRates && file === USD_RATES_PATH) return cachedUsdRates;
  if (!fs.existsSync(file)) return null;
  const rates = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (file === USD_RATES_PATH) cachedUsdRates = rates;
  return rates;
}

function normalizeCurrency(code) {
  const upper = String(code || '').toUpperCase();
  return ({ NTD: 'TWD', RMB: 'CNY' })[upper] || upper || null;
}

// Currencies absent from Fed H10 but with a durable official peg.
// MOP is pegged near 1.03 per HKD; USD/MOP = (USD/HKD) / mopPerHkd.
const FX_PEGS = Object.freeze({
  MOP: { via: 'HKD', unitsPerVia: 1.03 }
});

function usdPerUnit(rates, currency, asOf) {
  const code = normalizeCurrency(currency);
  if (!code) return { rate: null, reason: 'missingFxCurrency', observationDate: null, peg: null };
  if (code === 'USD') return { rate: 1, reason: null, observationDate: asOf || null, peg: null };
  const peg = FX_PEGS[code];
  if (peg) {
    const via = closingFxRaw(rates, peg.via, asOf, 'USD');
    if (!(Number.isFinite(via.rate) && via.rate > 0)) {
      return { rate: null, reason: via.reason || 'missingFxCurrency', observationDate: null, peg };
    }
    return {
      rate: via.rate / peg.unitsPerVia,
      reason: null,
      observationDate: via.observationDate,
      peg: { currency: code, via: peg.via, unitsPerVia: peg.unitsPerVia }
    };
  }
  return { ...closingFxRaw(rates, code, asOf, 'USD'), peg: null };
}

function latestFxObservationDate(rates, currency) {
  const observations = rates?.currencies?.[normalizeCurrency(currency)]?.observations;
  if (!Array.isArray(observations) || !observations.length) return null;
  return observations.at(-1)?.[0] || null;
}

function closingFxRaw(rates, currency, asOf, target = 'USD') {
  const source = normalizeCurrency(currency);
  const dest = normalizeCurrency(target);
  if (!source || !dest) return { rate: null, reason: 'missingFxCurrency', observationDate: null };
  if (source === dest) return { rate: 1, reason: null, observationDate: asOf || null };
  let fx = rateFor(rates, source, null, asOf, 'closing', dest);
  if (Number.isFinite(fx.rate) && fx.rate > 0) return fx;
  // Quote/as-of can sit a few days past the last Fed observation; use latest available.
  const last = latestFxObservationDate(rates, source === 'USD' ? dest : source);
  if (last && (!asOf || last < asOf)) {
    fx = rateFor(rates, source, null, last, 'closing', dest);
  }
  return fx;
}

function closingFx(rates, currency, asOf, target = 'USD') {
  return closingFxRaw(rates, currency, asOf, target);
}

// Site mcap is millions of calculationCurrency; Altman X4 needs statement currency.
function mcapMillionsInStatementCurrency(stock, scoringCurrency, {
  rates = null,
  rootDir = path.join(__dirname, '..'),
  asOf = null
} = {}) {
  const mcap = Number.isFinite(stock?.mcap) ? stock.mcap : null;
  if (!(Number.isFinite(mcap) && mcap > 0)) {
    return { mcapMillions: null, reason: 'missingMarketCap', fx: null };
  }
  const from = normalizeCurrency(stock?.calculationCurrency || 'USD');
  const to = normalizeCurrency(scoringCurrency);
  if (!to) return { mcapMillions: null, reason: 'missingScoringCurrency', fx: null };
  if (from === to) return { mcapMillions: mcap, reason: null, fx: null };

  const book = rates || loadUsdRates(rootDir);
  if (!book) return { mcapMillions: null, reason: 'missingFxCurrency', fx: null };
  const quoteAsOf = asOf
    || stock?.quoteDate
    || stock?.shareSource?.date
    || latestFxObservationDate(book, from === 'USD' ? to : from);
  // Bridge via USD: mcap_to = mcap_from * (USD/from) / (USD/to).
  const fromUsd = usdPerUnit(book, from, quoteAsOf);
  const toUsd = usdPerUnit(book, to, quoteAsOf);
  if (!(Number.isFinite(fromUsd.rate) && fromUsd.rate > 0
      && Number.isFinite(toUsd.rate) && toUsd.rate > 0)) {
    return {
      mcapMillions: null,
      reason: fromUsd.reason || toUsd.reason || 'missingFxDate',
      fx: { fromUsd, toUsd, asOf: quoteAsOf }
    };
  }
  return {
    mcapMillions: mcap * fromUsd.rate / toUsd.rate,
    reason: null,
    fx: {
      asOf: quoteAsOf,
      from,
      to,
      fromUsdPerUnit: fromUsd.rate,
      toUsdPerUnit: toUsd.rate,
      fromObservationDate: fromUsd.observationDate,
      toObservationDate: toUsd.observationDate,
      ...(fromUsd.peg || toUsd.peg ? { peg: fromUsd.peg || toUsd.peg } : {})
    }
  };
}

function scoringCurrencyFromStatements(statements) {
  const obs = Distress.annualObservation(statements || {}, { needPrior: false });
  if (obs?.scoringCurrency) return obs.scoringCurrency;
  const income = statements?.annual?.income;
  if (Array.isArray(income) && income.length) {
    return income[income.length - 1]?.reportedCurrency || null;
  }
  return null;
}

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
  rootDir = path.join(__dirname, '..'),
  fxRates = null
} = {}) {
  const financial = isDistressFinancial(stock, ticker);
  const resolved = resolveDistressStatements(ticker, statements, { rootDir });
  const scoringCurrency = scoringCurrencyFromStatements(resolved.statements || {});
  const mcapFx = financial
    ? { mcapMillions: null, reason: null, fx: null }
    : mcapMillionsInStatementCurrency(stock, scoringCurrency, { rates: fxRates, rootDir });
  const { altman, beneish } = Distress.calculateAll(resolved.statements || {}, {
    isFinancial: financial,
    mcapMillions: mcapFx.mcapMillions,
    altmanModel: 'z'
  });
  if (!financial && !Number.isFinite(altman.score) && mcapFx.reason
      && (altman.reason === 'missingMarketCap' || !altman.reason)) {
    altman.reason = mcapFx.reason;
  }

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
  stock.ratingSources.zScore = {
    ...ratingPayload(altman, checkedAt),
    evidenceHash,
    ...inheritMeta,
    ...(mcapFx.fx ? { mcapFx: mcapFx.fx } : {}),
    ...(mcapFx.reason && !Number.isFinite(altman.score) ? { mcapFxReason: mcapFx.reason } : {})
  };
  stock.ratingSources.mScore = { ...ratingPayload(beneish, checkedAt), evidenceHash, ...inheritMeta };
  return { altman, beneish, financial, inheritedFrom: resolved.inheritedFrom, mcapFx };
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
  hasAnnualIncome,
  mcapMillionsInStatementCurrency,
  scoringCurrencyFromStatements,
  loadUsdRates
};
