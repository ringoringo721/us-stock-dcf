import { ALL_FACTORS, defaultWeights } from "./factors.js";

/**
 * Linear ability score for one runner.
 * @param {Record<string, number>} features scaled ≈ [-1, 1]
 * @param {Record<string, number>} [weights]
 * @returns {{ score: number, contributions: { key: string, value: number, weight: number, contrib: number }[] }}
 */
export function scoreRunner(features, weights = defaultWeights()) {
  const contributions = [];
  let score = 0;
  for (const f of ALL_FACTORS) {
    const value = Number(features?.[f.key] ?? 0);
    const weight = Number(weights[f.key] ?? f.weight);
    const contrib = weight * value;
    score += contrib;
    contributions.push({ key: f.key, value, weight, contrib });
  }
  contributions.sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib));
  return { score, contributions };
}

/**
 * Softmax win probabilities. Temperature > 1 flattens the distribution.
 * @param {number[]} scores
 * @param {number} [temperature=1.8]
 * @returns {number[]} probabilities summing to 1
 */
export function softmax(scores, temperature = 1.8) {
  if (!scores.length) return [];
  const t = Math.max(temperature, 1e-6);
  const scaled = scores.map((s) => s / t);
  const max = Math.max(...scaled);
  const exps = scaled.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

/**
 * Convert decimal win odds to implied probability, stripping a simple takeout
 * estimate so the field approximately sums to 1.
 * @param {number[]} odds decimal odds (e.g. 4.5)
 * @returns {number[]} market-implied probs
 */
export function marketImpliedProbs(odds) {
  const raw = odds.map((o) => {
    const n = Number(o);
    if (!Number.isFinite(n) || n <= 1) return 0;
    return 1 / n;
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum <= 0) return raw.map(() => 0);
  return raw.map((p) => p / sum);
}

/**
 * Rank runners in a race with model win % and edge vs market.
 * @param {{ runners: object[], temperature?: number, weights?: Record<string, number> }} race
 */
export function analyseRace(race) {
  const weights = race.weights || defaultWeights();
  const temperature = race.temperature ?? 1.8;
  const runners = race.runners || [];

  const scored = runners.map((r) => {
    const { score, contributions } = scoreRunner(r.features || {}, weights);
    return { runner: r, score, contributions };
  });

  const probs = softmax(
    scored.map((s) => s.score),
    temperature
  );
  const market = marketImpliedProbs(runners.map((r) => r.winOdds));

  const rows = scored.map((s, i) => {
    const winProb = probs[i];
    const marketProb = market[i];
    return {
      ...s.runner,
      score: s.score,
      contributions: s.contributions,
      winProb,
      marketProb,
      edge: winProb - marketProb,
      fairOdds: winProb > 0 ? 1 / winProb : Infinity,
    };
  });

  rows.sort((a, b) => b.winProb - a.winProb);
  return {
    raceMeta: {
      id: race.id,
      date: race.date,
      venue: race.venue,
      venueName: race.venueName,
      raceNo: race.raceNo,
      name: race.name,
      distance: race.distance,
      surface: race.surface,
      going: race.going,
      rail: race.rail,
    },
    temperature,
    rows,
  };
}

/** Format probability as percent string. */
export function pct(p, digits = 1) {
  return `${(100 * p).toFixed(digits)}%`;
}
