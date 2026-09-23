import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/firebase-admin", () => ({ db: null }));

import { runDecisionStage, makeScenarioStage, makeValuationStage, reportVersions } from "./stages";
import { POLICY_V1 } from "./policyConfig";
import type { ResearchMandate, ResearchSnapshot, ValuationOutcome } from "./contracts";
import type { ScenarioValue } from "./schemas";
import type { StageContext } from "./runner";

const ASOF = "2026-09-22T13:45:00.000Z";

function mandate(over: Partial<ResearchMandate> = {}): ResearchMandate {
  return {
    mode: "analyze",
    query: "Analyze TEST for 24 months",
    ticker: "TEST",
    horizon: {
      count: 24,
      unit: "calendar_months",
      assumed: false,
      targetDate: "2028-09-22",
      yearFraction: 2,
      note: null,
    },
    benchmark: "SPY",
    universeVersion: "u1",
    hardFilter: null,
    qualitativeCriteria: [],
    ...over,
  };
}

function ctx(over: Partial<StageContext> = {}): StageContext {
  return {
    uid: "user-1",
    runId: "run-1",
    mandate: mandate(),
    asOf: ASOF,
    signal: new AbortController().signal,
    ...over,
  };
}

function snapshot(over: Partial<ResearchSnapshot> = {}): ResearchSnapshot {
  return {
    id: "snap-1",
    ownerUid: "user-1",
    ticker: "TEST",
    asOf: ASOF,
    mandate: mandate(),
    evidence: [],
    gaps: [],
    coverage: {},
    contentHash: "hash-1",
    createdAt: ASOF,
    ...over,
  };
}

function scenario(id: "bear" | "base" | "bull", price: number, dist = 0): ScenarioValue {
  return {
    id,
    priceAtHorizon: price,
    distributionsPerShare: dist,
    assumptionsRef: `a-${id}`,
    method: "forward_multiple",
    evidenceIds: [],
  };
}

/** The worked fixture: price 100, terminal 70/115/150, each paying 2. */
const SCENARIOS = [scenario("bear", 70, 2), scenario("base", 115, 2), scenario("bull", 150, 2)];

function valuation(over: Partial<ValuationOutcome> = {}): ValuationOutcome {
  return {
    method: "forward_multiple",
    gaps: [],
    scenarios: SCENARIOS,
    proxies: [],
    criticalCoverage: 1,
    valuationVersion: "valuation-test",
    priceAtAsOf: 100,
    ...over,
  };
}

/** A collector bundle whose unused members throw, so a stage cannot lean on them. */
function collectors(over: Record<string, unknown> = {}) {
  return {
    collect: async () => {
      throw new Error("collect not used in this test");
    },
    db: null,
    research: async () => {
      throw new Error("research not used in this test");
    },
    valuationRequest: async () => null,
    ...over,
  } as Parameters<typeof makeScenarioStage>[0];
}

describe("scenario stage — the fixed prior is a labelled fallback, never a guess", () => {
  it("falls back to POLICY_V1's prior when no provider is configured", async () => {
    const stage = makeScenarioStage(collectors());
    const env = await stage(ctx(), snapshot(), valuation());

    expect(env.result.weights).not.toBeNull();
    expect(env.result.weights!.values).toEqual(POLICY_V1.defaultScenarioWeights);
    expect(env.result.probabilityBasis).toBe("fixed_prior");
    // The report must be able to say this was an assumption, not a forecast.
    expect(env.gaps?.join(" ")).toMatch(/not a forecast/i);
    expect(env.credits).toBe(0);
  });

  it("records the bucket boundaries it would have asked against", async () => {
    const stage = makeScenarioStage(collectors());
    const env = await stage(ctx(), snapshot(), valuation());
    // Midpoints of -0.28 / 0.17 / 0.52.
    expect(env.result.buckets!.boundaries[0]).toBeCloseTo(-0.055, 12);
    expect(env.result.buckets!.boundaries[1]).toBeCloseTo(0.345, 12);
  });

  it("does not attach probabilities when nothing was priced", async () => {
    const stage = makeScenarioStage(collectors());
    const env = await stage(ctx(), snapshot(), valuation({ scenarios: null }));
    expect(env.result.weights).toBeNull();
    expect(env.result.buckets).toBeNull();
  });

  it("does not attach probabilities when the as-of price is missing", async () => {
    // Without the price the scenarios were measured from, a return cannot be
    // computed, so a distribution over returns would be meaningless.
    const stage = makeScenarioStage(collectors());
    const env = await stage(ctx(), snapshot(), valuation({ priceAtAsOf: null }));
    expect(env.result.weights).toBeNull();
  });

  it("refuses unordered scenarios rather than weighting them", async () => {
    const stage = makeScenarioStage(collectors());
    const flat = [scenario("bear", 100), scenario("base", 100), scenario("bull", 100)];
    const env = await stage(ctx(), snapshot(), valuation({ scenarios: flat }));
    expect(env.result.weights).toBeNull();
    expect(env.gaps?.join(" ")).toMatch(/strictly ordered/i);
  });
});

describe("decision stage — deterministic, and driven only by computed inputs", () => {
  const scenarioResult = {
    scenarios: SCENARIOS,
    weights: {
      values: { bear: 0.25, base: 0.5, bull: 0.25 },
      basis: "fixed_prior" as const,
      model: null,
      calibrationVersion: null,
    },
    buckets: { boundaries: [-0.055, 0.345] as [number, number] },
    probabilityBasis: "fixed_prior" as const,
    questionSetVersion: null,
  };

  const research = { claims: [], dissent: [] };

  it("produces the worked fixture's expected return and a Watch over 24 months", async () => {
    const env = await runDecisionStage(ctx(), {
      snapshot: snapshot(),
      research,
      valuation: valuation(),
      scenarios: scenarioResult,
    });

    // 14.5% cumulative against a two-year hurdle of ~21%.
    expect(env.result.returns!.cumulative).toBeCloseTo(0.145, 12);
    expect(env.result.hurdle).toBeCloseTo(0.21, 10);
    expect(env.result.rating).toBe("watch");
    expect(env.result.status).toBe("complete");
    expect(env.result.experimental).toBe(true);
  });

  it("rates the same numbers a Buy over 12 months — the horizon decides", async () => {
    const oneYear = mandate({
      horizon: {
        count: 12,
        unit: "calendar_months",
        assumed: false,
        targetDate: "2027-09-22",
        yearFraction: 1,
        note: null,
      },
    });
    const env = await runDecisionStage(ctx({ mandate: oneYear }), {
      snapshot: snapshot(),
      research,
      valuation: valuation(),
      scenarios: scenarioResult,
    });
    expect(env.result.rating).toBe("buy");
  });

  it("returns Watch, never Avoid, when the as-of price is missing", async () => {
    const env = await runDecisionStage(ctx(), {
      snapshot: snapshot(),
      research,
      valuation: valuation({ priceAtAsOf: null }),
      scenarios: scenarioResult,
    });
    expect(env.result.rating).toBe("watch");
    expect(env.result.returns).toBeNull();
    expect(env.result.reasonCodes).toContain("stale_price");
  });

  it("returns Watch, never Avoid, on thin coverage", async () => {
    const env = await runDecisionStage(ctx(), {
      snapshot: snapshot(),
      research,
      valuation: valuation({ criticalCoverage: 0.2 }),
      scenarios: scenarioResult,
    });
    expect(env.result.rating).toBe("watch");
    expect(env.result.reasonCodes).toContain("low_critical_coverage");
  });

  it("returns Watch, never Avoid, when no distribution was available", async () => {
    const env = await runDecisionStage(ctx(), {
      snapshot: snapshot(),
      research,
      valuation: valuation(),
      scenarios: { ...scenarioResult, weights: null },
    });
    expect(env.result.rating).toBe("watch");
    expect(env.result.status).toBe("insufficient_data");
  });

  it("carries unresolved dissent into a Watch rather than smoothing it away", async () => {
    const env = await runDecisionStage(ctx(), {
      snapshot: snapshot(),
      research: { claims: [], dissent: ["guidance conflicts with the 10-Q"] },
      valuation: valuation(),
      scenarios: scenarioResult,
    });
    expect(env.result.rating).toBe("watch");
    expect(env.result.reasonCodes).toContain("unresolved_contradiction");
  });

  it("surfaces snapshot source gaps without turning them into a verdict", async () => {
    const env = await runDecisionStage(ctx(), {
      snapshot: snapshot({
        gaps: [
          { source: "sec", field: "netDebt", reason: "rate_limited", detail: "429" },
        ],
      }),
      research,
      valuation: valuation(),
      scenarios: scenarioResult,
    });
    expect(env.gaps?.join(" ")).toMatch(/source gap/i);
    expect(env.result.rating).not.toBe("avoid");
  });

  it("spends nothing — it is arithmetic, not a provider call", async () => {
    const env = await runDecisionStage(ctx(), {
      snapshot: snapshot(),
      research,
      valuation: valuation(),
      scenarios: scenarioResult,
    });
    expect(env.credits).toBe(0);
  });
});

describe("valuation stage", () => {
  it("names the gap when the snapshot cannot support any method", async () => {
    const stage = makeValuationStage(collectors({ valuationRequest: async () => null }));
    const env = await stage(ctx(), snapshot());
    expect(env.result.scenarios).toBeNull();
    expect(env.result.criticalCoverage).toBe(0);
    expect(env.result.priceAtAsOf).toBeNull();
    expect(env.result.gaps[0].field).toBe("inputs");
  });
});

describe("reportVersions", () => {
  it("stamps every version a stored report is read against", () => {
    const v = reportVersions();
    expect(v.policyVersion).toMatch(/^policy-v/);
    expect(v.valuationVersion).toMatch(/^valuation-v/);
    expect(v.questionSetVersion).toMatch(/^jevq-v/);
    expect(v.agentVersion).toBeTruthy();
  });
});
