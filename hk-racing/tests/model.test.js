import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyseRace, marketImpliedProbs, scoreRunner, softmax } from "../js/model.js";
import { SAMPLE_RACES } from "../js/data.js";

describe("softmax", () => {
  it("sums to 1", () => {
    const p = softmax([1.2, 0.4, -0.3, 0.1]);
    const sum = p.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });

  it("ranks higher scores ahead", () => {
    const p = softmax([2, 0, -1]);
    assert.ok(p[0] > p[1] && p[1] > p[2]);
  });

  it("flattens when temperature rises", () => {
    const sharp = softmax([1.5, 0.2], 0.8);
    const flat = softmax([1.5, 0.2], 1.8);
    assert.ok(sharp[0] > flat[0]);
  });
});

describe("marketImpliedProbs", () => {
  it("normalizes decimal odds", () => {
    const p = marketImpliedProbs([2, 4, 4]);
    const sum = p.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
    assert.ok(p[0] > p[1]);
  });
});

describe("scoreRunner", () => {
  it("returns contributions for all factors", () => {
    const { score, contributions } = scoreRunner({
      ratingAdv: 0.5,
      form: 0.2,
      jockeySkill: 0.8,
    });
    assert.equal(typeof score, "number");
    assert.ok(contributions.length >= 10);
    assert.ok(contributions.some((c) => c.key === "jockeySkill" && c.contrib > 0));
  });
});

describe("analyseRace", () => {
  it("assigns win probs that sum to 100% on sample cards", () => {
    for (const race of SAMPLE_RACES) {
      const result = analyseRace(race);
      const sum = result.rows.reduce((a, r) => a + r.winProb, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, race.id);
      assert.equal(result.rows.length, race.runners.length);
      assert.ok(result.rows[0].winProb >= result.rows.at(-1).winProb);
    }
  });

  it("marks positive edge when model exceeds market", () => {
    const result = analyseRace(SAMPLE_RACES[0]);
    for (const row of result.rows) {
      assert.ok(Math.abs(row.edge - (row.winProb - row.marketProb)) < 1e-9);
    }
  });
});
