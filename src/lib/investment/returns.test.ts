import { describe, it, expect } from "vitest";
import { computeReturns } from "./returns";
import type { ScenarioValue, ScenarioWeights } from "./schemas";

function scenario(id: "bear" | "base" | "bull", price: number, dist = 0): ScenarioValue {
  return {
    id,
    priceAtHorizon: price,
    distributionsPerShare: dist,
    assumptionsRef: `a-${id}`,
    method: "forward_multiple",
    evidenceIds: ["e1"],
  };
}

const WEIGHTS: ScenarioWeights = {
  values: { bear: 0.25, base: 0.5, bull: 0.25 },
  basis: "fixed_prior",
  model: null,
  calibrationVersion: null,
};

// The plan's worked fixture, hand-calculated independently of the implementation:
// price 100; terminal prices 70 / 115 / 150; each scenario pays 2 per share.
const FIXTURE = [scenario("bear", 70, 2), scenario("base", 115, 2), scenario("bull", 150, 2)];

describe("computeReturns — the worked fixture", () => {
  it("derives each scenario's total return from price and distributions", () => {
    const r = computeReturns(100, FIXTURE, WEIGHTS, 2);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.estimate.scenarioReturns.bear).toBeCloseTo(-0.28, 12);
    expect(r.estimate.scenarioReturns.base).toBeCloseTo(0.17, 12);
    expect(r.estimate.scenarioReturns.bull).toBeCloseTo(0.52, 12);
  });

  it("weights them into a cumulative expected return of 14.5%", () => {
    const r = computeReturns(100, FIXTURE, WEIGHTS, 2);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.estimate.cumulative).toBeCloseTo(0.145, 12);
  });

  it("annualizes expected terminal wealth, not expected CAGR", () => {
    const r = computeReturns(100, FIXTURE, WEIGHTS, 2);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.estimate.annualizedWealthEquivalent).toBeCloseTo(0.07004672795, 9);
    expect(Math.sqrt(1.145) - 1).toBeCloseTo(0.07004672795, 9);
  });

  it("reports the bear-scenario loss as a positive magnitude", () => {
    const r = computeReturns(100, FIXTURE, WEIGHTS, 2);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.estimate.bearScenarioLoss).toBeCloseTo(0.28, 12);
  });
});

describe("computeReturns — distributions", () => {
  it("counts distributions exactly once", () => {
    const withDist = computeReturns(100, [scenario("bear", 100, 5), scenario("base", 100, 5), scenario("bull", 100, 5)], WEIGHTS, 1);
    if (withDist.status !== "ok") throw new Error("expected ok");
    // +5 of cash on a flat $100 price is exactly 5%, not 10%.
    expect(withDist.estimate.cumulative).toBeCloseTo(0.05, 12);
  });

  it("assumes no reinvestment — cash is added, not compounded", () => {
    const r = computeReturns(100, [scenario("bear", 100, 10), scenario("base", 100, 10), scenario("bull", 100, 10)], WEIGHTS, 2);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.estimate.cumulative).toBeCloseTo(0.1, 12);
  });
});

describe("computeReturns — the annualized figure is hidden below a year", () => {
  it("returns null for a sub-year horizon rather than annualizing a 3-month view", () => {
    const r = computeReturns(100, FIXTURE, WEIGHTS, 0.25);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.estimate.cumulative).toBeCloseTo(0.145, 12);
    expect(r.estimate.annualizedWealthEquivalent).toBeNull();
  });

  it("provides it at exactly one year", () => {
    const r = computeReturns(100, FIXTURE, WEIGHTS, 1);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.estimate.annualizedWealthEquivalent).toBeCloseTo(0.145, 12);
  });
});

describe("computeReturns — equity loss", () => {
  it("permits a zero terminal price: total loss is -100%, not an error", () => {
    const r = computeReturns(100, [scenario("bear", 0), scenario("base", 100), scenario("bull", 200)], WEIGHTS, 1);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.estimate.scenarioReturns.bear).toBeCloseTo(-1, 12);
    expect(r.estimate.bearScenarioLoss).toBeCloseTo(1, 12);
  });

  it("reports zero bear loss when even the bear case is positive", () => {
    const r = computeReturns(100, [scenario("bear", 105), scenario("base", 120), scenario("bull", 140)], WEIGHTS, 1);
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.estimate.bearScenarioLoss).toBe(0);
  });
});

describe("computeReturns — unavailable rather than wrong", () => {
  it("refuses a zero or negative current price", () => {
    for (const price of [0, -10]) {
      const r = computeReturns(price, FIXTURE, WEIGHTS, 1);
      expect(r.status).toBe("unavailable");
    }
  });

  it("refuses a missing current price instead of substituting one", () => {
    expect(computeReturns(null, FIXTURE, WEIGHTS, 1).status).toBe("unavailable");
  });

  it("refuses missing weights instead of assuming equal probabilities", () => {
    const r = computeReturns(100, FIXTURE, null, 1);
    expect(r.status).toBe("unavailable");
    if (r.status !== "unavailable") return;
    expect(r.reason).toMatch(/weight/i);
  });

  it("refuses a non-finite price", () => {
    for (const price of [NaN, Infinity]) {
      expect(computeReturns(price, FIXTURE, WEIGHTS, 1).status).toBe("unavailable");
    }
  });

  it("refuses an incomplete scenario set", () => {
    expect(computeReturns(100, [scenario("bear", 70), scenario("base", 115)], WEIGHTS, 1).status).toBe("unavailable");
  });

  it("refuses duplicate scenarios", () => {
    const dup = [scenario("bear", 70), scenario("bear", 80), scenario("bull", 150)];
    expect(computeReturns(100, dup, WEIGHTS, 1).status).toBe("unavailable");
  });

  it("refuses a non-positive year fraction", () => {
    expect(computeReturns(100, FIXTURE, WEIGHTS, 0).status).toBe("unavailable");
  });

  it("refuses weights that do not form a distribution", () => {
    const bad = { ...WEIGHTS, values: { bear: 0.25, base: 0.5, bull: 0.5 } };
    expect(computeReturns(100, FIXTURE, bad, 1).status).toBe("unavailable");
  });
});
