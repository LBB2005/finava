import { describe, it, expect } from "vitest";
import { standingOf } from "@/lib/live/asOf";
import {
  ProbabilityTripleSchema,
  ScenarioWeightsSchema,
  ScenarioValueSchema,
  ResolvedHorizonSchema,
  EvidenceItemSchema,
  toEvidenceStanding,
  toFactStanding,
} from "./schemas";

describe("ProbabilityTripleSchema", () => {
  it("accepts a distribution that sums to 1", () => {
    expect(ProbabilityTripleSchema.safeParse({ bear: 0.2, base: 0.5, bull: 0.3 }).success).toBe(true);
  });

  it("rejects a distribution that does not sum to 1", () => {
    expect(ProbabilityTripleSchema.safeParse({ bear: 0.2, base: 0.5, bull: 0.5 }).success).toBe(false);
  });

  it("rejects NaN and Infinity — a non-finite weight would poison the arithmetic", () => {
    expect(ProbabilityTripleSchema.safeParse({ bear: NaN, base: 0.5, bull: 0.5 }).success).toBe(false);
    expect(ProbabilityTripleSchema.safeParse({ bear: Infinity, base: 0, bull: 0 }).success).toBe(false);
  });

  it("rejects a negative weight even when the sum works out", () => {
    expect(ProbabilityTripleSchema.safeParse({ bear: -0.1, base: 0.6, bull: 0.5 }).success).toBe(false);
  });

  it("tolerates floating-point slack", () => {
    expect(ProbabilityTripleSchema.safeParse({ bear: 1 / 3, base: 1 / 3, bull: 1 / 3 }).success).toBe(true);
  });
});

describe("ScenarioWeightsSchema — basis integrity", () => {
  const values = { bear: 0.25, base: 0.5, bull: 0.25 };

  it("accepts a fixed prior with no calibration reference", () => {
    const r = ScenarioWeightsSchema.safeParse({ values, basis: "fixed_prior", model: null, calibrationVersion: null });
    expect(r.success).toBe(true);
  });

  it("refuses to call weights empirically_calibrated without a calibration artifact", () => {
    const r = ScenarioWeightsSchema.safeParse({
      values,
      basis: "empirically_calibrated",
      model: "m",
      calibrationVersion: null,
    });
    expect(r.success).toBe(false);
  });

  it("accepts empirically_calibrated when the artifact is referenced", () => {
    const r = ScenarioWeightsSchema.safeParse({
      values,
      basis: "empirically_calibrated",
      model: "m",
      calibrationVersion: "calib-2027-01",
    });
    expect(r.success).toBe(true);
  });

  it("refuses a calibration reference on weights that were not calibrated", () => {
    const r = ScenarioWeightsSchema.safeParse({
      values,
      basis: "model_unvalidated",
      model: "m",
      calibrationVersion: "calib-2027-01",
    });
    expect(r.success).toBe(false);
  });
});

describe("ScenarioValueSchema", () => {
  const base = {
    id: "bear" as const,
    priceAtHorizon: 0,
    distributionsPerShare: 0,
    assumptionsRef: "a1",
    method: "forward_multiple" as const,
    evidenceIds: ["e1"],
  };

  it("permits a zero horizon price — equity really can go to zero", () => {
    expect(ScenarioValueSchema.safeParse(base).success).toBe(true);
  });

  it("rejects a negative price or negative distributions", () => {
    expect(ScenarioValueSchema.safeParse({ ...base, priceAtHorizon: -1 }).success).toBe(false);
    expect(ScenarioValueSchema.safeParse({ ...base, distributionsPerShare: -1 }).success).toBe(false);
  });
});

describe("ResolvedHorizonSchema", () => {
  const ok = {
    count: 24,
    unit: "calendar_months" as const,
    assumed: false,
    targetDate: "2028-09-21",
    yearFraction: 2.0,
    note: null,
  };

  it("accepts a resolved horizon", () => {
    expect(ResolvedHorizonSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects a target date that is not YYYY-MM-DD", () => {
    for (const targetDate of ["21/09/2028", "2028-9-1", "2028-09-21T00:00:00Z", ""]) {
      expect(ResolvedHorizonSchema.safeParse({ ...ok, targetDate }).success).toBe(false);
    }
  });

  it("rejects a non-positive year fraction", () => {
    expect(ResolvedHorizonSchema.safeParse({ ...ok, yearFraction: 0 }).success).toBe(false);
  });
});

describe("evidence standing reuses Finava Live's vocabulary", () => {
  it("round-trips every standing live/asOf can produce", () => {
    const asOf = "2026-09-21T13:45:00.000Z";
    const cases = [
      standingOf("2026-09-01T00:00:00.000Z", asOf), // clean
      standingOf(null, asOf), // undated
      standingOf("2026-10-01T00:00:00.000Z", asOf), // post_asof
    ];
    expect(cases).toEqual(["clean", "undated", "post_asof"]);
    for (const kind of cases) {
      expect(toFactStanding(toEvidenceStanding(kind))).toBe(kind);
      expect(EvidenceItemSchema.shape.standing.safeParse(kind).success).toBe(true);
    }
  });

  it("rejects a standing outside the shared vocabulary", () => {
    expect(EvidenceItemSchema.shape.standing.safeParse("stale").success).toBe(false);
  });
});

describe("EvidenceItemSchema", () => {
  it("keeps observedAt required and publishedAt nullable", () => {
    // We always know when WE read something; the provider often will not say when
    // it is from. Collapsing the two is how look-ahead hides.
    const item = {
      id: "e1",
      ticker: "TEST",
      kind: "filing" as const,
      source: "sec",
      url: null,
      publishedAt: null,
      observedAt: "2026-09-21T13:45:00.000Z",
      period: "FY2025",
      contentHash: "h",
      excerpt: "…",
      standing: "undated" as const,
    };
    expect(EvidenceItemSchema.safeParse(item).success).toBe(true);
    const without: Record<string, unknown> = { ...item };
    delete without.observedAt;
    expect(EvidenceItemSchema.safeParse(without).success).toBe(false);
  });
});
