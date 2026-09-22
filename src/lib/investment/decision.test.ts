import { describe, it, expect } from "vitest";
import { decideInvestment, REASON, type DecisionInput } from "./decision";
import { buildScenarioBuckets, classifyRealisedReturn } from "./scenarioBuckets";
import { POLICY_V1 } from "./policyConfig";
import type { ReturnEstimate, ScenarioWeights } from "./schemas";

const WEIGHTS: ScenarioWeights = {
  values: { bear: 0.25, base: 0.5, bull: 0.25 },
  basis: "fixed_prior",
  model: null,
  calibrationVersion: null,
};

function estimate(over: Partial<ReturnEstimate> = {}): ReturnEstimate {
  return {
    cumulative: 0.3,
    annualizedWealthEquivalent: 0.14,
    bearScenarioLoss: 0.1,
    scenarioReturns: { bear: -0.1, base: 0.3, bull: 0.7 },
    ...over,
  };
}

function input(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    criticalCoverage: 1,
    hasFreshPrice: true,
    returns: estimate(),
    weights: WEIGHTS,
    scenarioConfidence: 0.8,
    yearFraction: 1,
    ...over,
  };
}

describe("decideInvestment — a lack of evidence is never an Avoid", () => {
  it("returns Watch, not Avoid, when critical coverage is too low", () => {
    const d = decideInvestment(input({ criticalCoverage: 0.4 }));
    expect(d.rating).toBe("watch");
    expect(d.reasonCodes).toContain(REASON.lowCriticalCoverage);
  });

  it("returns Watch when the return estimate could not be computed", () => {
    const d = decideInvestment(input({ returns: null }));
    expect(d.rating).toBe("watch");
    expect(d.status).toBe("insufficient_data");
    expect(d.reasonCodes).toContain(REASON.noReturnEstimate);
  });

  it("returns Watch when no scenario weights were available", () => {
    const d = decideInvestment(input({ weights: null }));
    expect(d.rating).toBe("watch");
    expect(d.status).toBe("insufficient_data");
    expect(d.reasonCodes).toContain(REASON.noWeights);
  });

  it("returns Watch on a stale price rather than rating on it", () => {
    const d = decideInvestment(input({ hasFreshPrice: false }));
    expect(d.rating).toBe("watch");
    expect(d.reasonCodes).toContain(REASON.stalePrice);
  });

  it("never emits Avoid for any combination of missing inputs", () => {
    for (const over of [
      { criticalCoverage: 0 },
      { returns: null },
      { weights: null },
      { hasFreshPrice: false },
      { criticalCoverage: 0, returns: null, weights: null, hasFreshPrice: false },
    ] as Partial<DecisionInput>[]) {
      expect(decideInvestment(input(over)).rating).not.toBe("avoid");
    }
  });
});

describe("decideInvestment — quality gates run before the thresholds", () => {
  it("does not reach the hurdle comparison when a gate fails", () => {
    // A spectacular expected return on inadequate data is still Watch.
    const d = decideInvestment(input({ criticalCoverage: 0.1, returns: estimate({ cumulative: 5 }) }));
    expect(d.rating).toBe("watch");
    expect(d.reasonCodes).not.toContain(REASON.clearsHurdle);
    expect(d.hurdle).toBeNull();
  });

  it("does not Avoid on a terrible expected return when the data is inadequate", () => {
    const d = decideInvestment(
      input({ criticalCoverage: 0.1, returns: estimate({ cumulative: -0.5, bearScenarioLoss: 0.9 }) })
    );
    expect(d.rating).toBe("watch");
    expect(d.reasonCodes).not.toContain(REASON.negativeExpectedReturn);
  });

  it("returns Watch on an unresolved material contradiction", () => {
    const d = decideInvestment(input({ unresolvedContradictions: ["guidance conflicts with the 10-Q"] }));
    expect(d.rating).toBe("watch");
    expect(d.status).toBe("partial");
    expect(d.reasonCodes).toContain(REASON.unresolvedContradiction);
  });

  it("returns Watch on low scenario confidence, keeping the estimate visible", () => {
    const d = decideInvestment(input({ scenarioConfidence: 0.2 }));
    expect(d.rating).toBe("watch");
    expect(d.reasonCodes).toContain(REASON.lowConfidence);
  });

  it("ignores confidence when it was never measured", () => {
    expect(decideInvestment(input({ scenarioConfidence: null })).rating).toBe("buy");
  });
});

describe("decideInvestment — thresholds", () => {
  it("rates Buy when the expected return clears the compounded hurdle", () => {
    const d = decideInvestment(input({ returns: estimate({ cumulative: 0.3 }), yearFraction: 1 }));
    expect(d.rating).toBe("buy");
    expect(d.status).toBe("complete");
    expect(d.reasonCodes).toContain(REASON.clearsHurdle);
  });

  it("rates Watch when the return is positive but below the hurdle", () => {
    const d = decideInvestment(input({ returns: estimate({ cumulative: 0.05 }) }));
    expect(d.rating).toBe("watch");
    expect(d.status).toBe("complete");
    expect(d.reasonCodes).toContain(REASON.belowHurdle);
  });

  it("never judges a two-year report against a one-year hurdle", () => {
    // 14.5% cumulative clears a 1-year hurdle (10%) but not a 2-year one (~21%).
    const returns = estimate({ cumulative: 0.145 });
    expect(decideInvestment(input({ returns, yearFraction: 1 })).rating).toBe("buy");

    const twoYear = decideInvestment(input({ returns, yearFraction: 2 }));
    expect(twoYear.rating).toBe("watch");
    expect(twoYear.hurdle).toBeCloseTo(0.21, 10);
  });

  it("rates Avoid on a negative expected return", () => {
    const d = decideInvestment(input({ returns: estimate({ cumulative: -0.05 }) }));
    expect(d.rating).toBe("avoid");
    expect(d.reasonCodes).toContain(REASON.negativeExpectedReturn);
  });

  it("rates Avoid when the bear-scenario loss breaches the limit", () => {
    const d = decideInvestment(
      input({ returns: estimate({ cumulative: 0.5, bearScenarioLoss: POLICY_V1.maxBearScenarioLoss + 0.01 }) })
    );
    expect(d.rating).toBe("avoid");
    expect(d.reasonCodes).toContain(REASON.bearLossTooLarge);
  });

  it("allows a bear loss exactly at the limit", () => {
    const d = decideInvestment(
      input({ returns: estimate({ cumulative: 0.5, bearScenarioLoss: POLICY_V1.maxBearScenarioLoss }) })
    );
    expect(d.rating).toBe("buy");
  });

  it("treats a return exactly at the hurdle as clearing it", () => {
    const d = decideInvestment(input({ returns: estimate({ cumulative: POLICY_V1.annualReturnHurdle }), yearFraction: 1 }));
    expect(d.rating).toBe("buy");
  });
});

describe("decideInvestment — exclusions are evidence-backed Avoids", () => {
  it("rates Avoid on a declared exclusion violation", () => {
    const d = decideInvestment(input({ exclusionViolations: ["tobacco revenue > 5%"] }));
    expect(d.rating).toBe("avoid");
    expect(d.reasonCodes).toContain(REASON.exclusionViolation);
  });

  it("applies an exclusion even when the data is otherwise thin", () => {
    // Unlike every other Avoid path, this one rests on something observed.
    const d = decideInvestment(input({ criticalCoverage: 0, returns: null, exclusionViolations: ["excluded sector"] }));
    expect(d.rating).toBe("avoid");
  });
});

describe("decideInvestment — labelling", () => {
  it("marks a Buy built on untested weights as experimental", () => {
    const d = decideInvestment(input());
    expect(d.rating).toBe("buy");
    expect(d.experimental).toBe(true);
    expect(d.reasonCodes).toContain(REASON.experimentalWeights);
  });

  it("does not mark a calibrated rating experimental", () => {
    const calibrated: ScenarioWeights = {
      ...WEIGHTS,
      basis: "empirically_calibrated",
      calibrationVersion: "calib-2027-01",
    };
    const d = decideInvestment(input({ weights: calibrated }));
    expect(d.experimental).toBe(false);
  });

  it("stamps the policy version on every result", () => {
    expect(decideInvestment(input()).policyVersion).toMatch(/^policy-v\d/);
  });
});

describe("buildScenarioBuckets", () => {
  it("places boundaries at the midpoints between adjacent scenario returns", () => {
    const r = buildScenarioBuckets({ bear: -0.28, base: 0.17, bull: 0.52 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.buckets.boundaries[0]).toBeCloseTo(-0.055, 12);
    expect(r.buckets.boundaries[1]).toBeCloseTo(0.345, 12);
  });

  it("rejects equal scenarios rather than sorting them into agreement", () => {
    expect(buildScenarioBuckets({ bear: 0.1, base: 0.1, bull: 0.5 }).status).toBe("invalid");
  });

  it("rejects inverted scenarios", () => {
    expect(buildScenarioBuckets({ bear: 0.5, base: 0.2, bull: 0.1 }).status).toBe("invalid");
  });

  it("rejects a non-finite scenario return", () => {
    expect(buildScenarioBuckets({ bear: NaN, base: 0.2, bull: 0.5 }).status).toBe("invalid");
  });
});

describe("classifyRealisedReturn — the partition is complete and non-overlapping", () => {
  const buckets = { boundaries: [-0.055, 0.345] as [number, number] };

  it("assigns each region to exactly one bucket", () => {
    expect(classifyRealisedReturn(-0.9, buckets)).toBe("bear");
    expect(classifyRealisedReturn(-0.056, buckets)).toBe("bear");
    expect(classifyRealisedReturn(0, buckets)).toBe("base");
    expect(classifyRealisedReturn(0.344, buckets)).toBe("base");
    expect(classifyRealisedReturn(0.345, buckets)).toBe("bull");
    expect(classifyRealisedReturn(12, buckets)).toBe("bull");
  });

  it("resolves a return landing exactly on a boundary to the upper bucket, once", () => {
    // Half-open intervals: a boundary value has one answer, not two.
    expect(classifyRealisedReturn(-0.055, buckets)).toBe("base");
  });

  it("returns null for a non-finite realised return instead of guessing", () => {
    expect(classifyRealisedReturn(NaN, buckets)).toBeNull();
  });
});
