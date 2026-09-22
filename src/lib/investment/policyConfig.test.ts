import { describe, it, expect } from "vitest";
import { POLICY_V1, POLICY_VERSION, hurdleForYearFraction } from "./policyConfig";

describe("hurdleForYearFraction", () => {
  it("compounds the annual hurdle over a two-year horizon", () => {
    // The plan's worked case: a 10% annual hurdle over 2 years is ~21%, so a
    // 14.5% cumulative expected return is a Watch, not a Buy.
    expect(hurdleForYearFraction(2)).toBeCloseTo(0.21, 10);
    expect(0.145).toBeLessThan(hurdleForYearFraction(2));
  });

  it("returns the plain annual hurdle at exactly one year", () => {
    expect(hurdleForYearFraction(1)).toBeCloseTo(POLICY_V1.annualReturnHurdle, 12);
  });

  it("scales below the annual hurdle for a sub-year horizon", () => {
    const quarter = hurdleForYearFraction(0.25);
    expect(quarter).toBeGreaterThan(0);
    expect(quarter).toBeLessThan(POLICY_V1.annualReturnHurdle);
    expect(quarter).toBeCloseTo(1.1 ** 0.25 - 1, 12);
  });

  it("honours an explicit hurdle override", () => {
    expect(hurdleForYearFraction(1, 0.2)).toBeCloseTo(0.2, 12);
  });

  it("throws rather than returning a hurdle for a non-positive or non-finite horizon", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(() => hurdleForYearFraction(bad)).toThrow(/positive finite/);
    }
  });
});

describe("POLICY_V1", () => {
  it("ships a default prior that is a valid probability distribution", () => {
    const w = POLICY_V1.defaultScenarioWeights;
    expect(w.bear + w.base + w.bull).toBeCloseTo(1, 12);
    for (const v of Object.values(w)) expect(v).toBeGreaterThan(0);
  });

  it("carries a version so a stored report can be read against its own rules", () => {
    expect(POLICY_VERSION).toMatch(/^policy-v\d/);
  });
});
