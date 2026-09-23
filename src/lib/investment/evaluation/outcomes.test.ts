import { describe, expect, it } from "vitest";
import {
  NON_RESOLUTION,
  resolveBatch,
  resolvePrediction,
  type TotalReturnData,
} from "./outcomes";
import { buildPredictionRecord, type PredictionInput, type PredictionRecord } from "./predictions";

const AS_OF = "2026-01-15T14:30:00.000Z";
const TARGET = "2027-01-15";
const MATURED = new Date("2027-01-16T00:00:00.000Z");

function input(overrides: Partial<PredictionInput> = {}): PredictionInput {
  return {
    ownerUid: "uid_1",
    reportId: "report_1",
    snapshotId: "snap_1",
    ticker: "AAPL",
    disposition: "selected",
    rating: "buy",
    reasonCodes: ["clears_return_hurdle"],
    asOf: AS_OF,
    targetDate: TARGET,
    horizonCount: 12,
    horizonUnit: "calendar_months",
    yearFraction: 1,
    forecasts: {
      positiveTotalReturn: 0.62,
      outperformBenchmark: 0.55,
      scenarioBucket: { bear: 0.2, base: 0.5, bull: 0.3 },
      thesisInvalidation: 0.18,
    },
    buckets: { boundaries: [-0.05, 0.22] },
    expectedTotalReturn: 0.11,
    scenarioReturns: { bear: -0.3, base: 0.12, bull: 0.4 },
    invalidationConditions: [{ id: "gm_below_40", description: "Gross margin below 40%" }],
    provenance: {
      basis: "model_unvalidated",
      model: "claude-opus-5",
      calibrationVersion: null,
      promptHash: null,
    },
    policyVersion: "policy_v1",
    valuationVersion: "val_v1",
    agentVersion: "agent_v1",
    latencyMs: 40_000,
    costUsd: 0.3,
    createdAt: AS_OF,
    ...overrides,
  };
}

function record(overrides: Partial<PredictionInput> = {}): PredictionRecord {
  const built = buildPredictionRecord(input(overrides));
  if (built.status !== "ok") throw new Error(`fixture invalid: ${built.reason}`);
  return built.record;
}

function data(overrides: Partial<TotalReturnData> = {}): TotalReturnData {
  return {
    subject: {
      symbol: "AAPL",
      windowStart: "2026-01-15",
      windowEnd: TARGET,
      startPrice: 100,
      endPrice: 130,
      distributions: [{ exDate: "2026-06-01", amountPerShare: 2, kind: "cash_dividend" }],
      corporateActionAdjusted: true,
      adjustmentSource: "polygon_adjusted",
    },
    benchmark: {
      symbol: "SPY",
      windowStart: "2026-01-15",
      windowEnd: TARGET,
      startPrice: 400,
      endPrice: 440,
      distributions: [],
      corporateActionAdjusted: true,
      adjustmentSource: "polygon_adjusted",
    },
    corporateAction: null,
    invalidationObservations: [
      { conditionId: "gm_below_40", status: "holding", observedOn: TARGET },
    ],
    ...overrides,
  };
}

describe("resolvePrediction — the clean case", () => {
  it("resolves all four targets independently", () => {
    const result = resolvePrediction(record(), data(), { now: MATURED });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    const o = result.outcome;

    expect(o.realisedTotalReturn).toBeCloseTo(0.32, 12);
    expect(o.benchmarkTotalReturn).toBeCloseTo(0.1, 12);
    expect(o.excessReturn).toBeCloseTo(0.22, 12);
    expect(o.targets.positiveTotalReturn).toEqual({ status: "resolved", value: 1 });
    expect(o.targets.outperformBenchmark).toEqual({ status: "resolved", value: 1 });
    expect(o.targets.scenarioBucket).toEqual({ status: "resolved", value: "bull" });
    expect(o.targets.thesisInvalidation).toEqual({ status: "resolved", value: 0 });
    expect(o.coverage).toBe("full");
    expect(o.unresolvedReasons).toEqual([]);
  });

  it("classifies against the STORED boundaries, not boundaries re-derived from the scenarios", () => {
    // Re-deriving midpoints from the scenario returns (-0.3 / 0.12 / 0.4) would
    // give [-0.09, 0.26] and call a 0.32 return "bull". The boundaries actually
    // stored with this prediction say "base", and that is the question that was asked.
    const result = resolvePrediction(record({ buckets: { boundaries: [0.1, 0.9] } }), data(), {
      now: MATURED,
    });
    if (result.status !== "resolved") throw new Error("expected resolution");
    expect(result.outcome.targets.scenarioBucket).toEqual({ status: "resolved", value: "base" });
  });

  it("counts a distribution going ex on the final day and excludes one on the first", () => {
    const withBoundaryDividends = resolvePrediction(
      record(),
      data({
        subject: {
          ...data().subject,
          distributions: [
            { exDate: "2026-01-15", amountPerShare: 5, kind: "cash_dividend" },
            { exDate: TARGET, amountPerShare: 3, kind: "cash_dividend" },
          ],
        },
      }),
      { now: MATURED }
    );
    if (withBoundaryDividends.status !== "resolved") throw new Error("expected resolution");
    // Only the final-day dividend counts: a buyer at the start close does not
    // receive one that has already gone ex that day.
    expect(withBoundaryDividends.outcome.realisedTotalReturn).toBeCloseTo(0.33, 12);
  });
});

describe("resolvePrediction — whole-record non-resolution", () => {
  it("publishes a reason when the horizon has not closed", () => {
    const result = resolvePrediction(record(), data(), {
      now: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(result).toMatchObject({ status: "unresolved", reason: NON_RESOLUTION.notMatured });
    if (result.status === "unresolved") expect(result.detail).toContain("look-ahead in reverse");
  });

  it("publishes a reason when the data is for another ticker", () => {
    const result = resolvePrediction(
      record(),
      data({ subject: { ...data().subject, symbol: "MSFT" } }),
      { now: MATURED }
    );
    expect(result).toMatchObject({ status: "unresolved", reason: NON_RESOLUTION.tickerMismatch });
  });

  it("publishes a reason when the subject window is not the forecast window", () => {
    const result = resolvePrediction(
      record(),
      data({ subject: { ...data().subject, windowEnd: "2026-12-31" } }),
      { now: MATURED }
    );
    expect(result).toMatchObject({ status: "unresolved", reason: NON_RESOLUTION.windowMismatch });
  });

  it("publishes a reason for malformed outcome data instead of throwing", () => {
    const result = resolvePrediction(record(), { subject: { symbol: "AAPL" } }, { now: MATURED });
    expect(result).toMatchObject({ status: "unresolved", reason: NON_RESOLUTION.malformedData });
  });
});

describe("resolvePrediction — the difficult outcomes", () => {
  it("resolves a bankruptcy wipeout as a total loss rather than dropping it", () => {
    const result = resolvePrediction(
      record(),
      data({
        subject: {
          ...data().subject,
          windowEnd: "2026-08-01",
          endPrice: null,
          distributions: [],
        },
        benchmark: { ...data().benchmark!, windowEnd: "2026-08-01", endPrice: 410 },
        corporateAction: {
          kind: "bankruptcy",
          effectiveDate: "2026-08-01",
          proceedsPerShare: 0,
          detail: "Chapter 7, equity cancelled",
        },
      }),
      { now: MATURED }
    );
    if (result.status !== "resolved") throw new Error("expected resolution");
    const o = result.outcome;
    expect(o.effectiveWindowEnd).toBe("2026-08-01");
    expect(o.realisedTotalReturn).toBeCloseTo(-1, 12);
    expect(o.targets.positiveTotalReturn).toEqual({ status: "resolved", value: 0 });
    expect(o.targets.scenarioBucket).toEqual({ status: "resolved", value: "bear" });
    expect(o.targets.outperformBenchmark).toEqual({ status: "resolved", value: 0 });
    expect(o.coverage).toBe("full");
  });

  it("resolves a cash acquisition on the matched shortened window", () => {
    const result = resolvePrediction(
      record(),
      data({
        subject: {
          ...data().subject,
          windowEnd: "2026-09-30",
          endPrice: null,
          distributions: [],
        },
        benchmark: { ...data().benchmark!, windowEnd: "2026-09-30", endPrice: 420 },
        corporateAction: {
          kind: "cash_acquisition",
          effectiveDate: "2026-09-30",
          proceedsPerShare: 118,
          detail: "acquired for $118/share cash",
        },
      }),
      { now: MATURED }
    );
    if (result.status !== "resolved") throw new Error("expected resolution");
    expect(result.outcome.realisedTotalReturn).toBeCloseTo(0.18, 12);
    expect(result.outcome.benchmarkTotalReturn).toBeCloseTo(0.05, 12);
    expect(result.outcome.targets.outperformBenchmark).toEqual({ status: "resolved", value: 1 });
  });

  it("records unknown proceeds as unresolved rather than silently dropping the name", () => {
    const result = resolvePrediction(
      record(),
      data({
        subject: { ...data().subject, windowEnd: "2026-09-30", endPrice: null },
        benchmark: { ...data().benchmark!, windowEnd: "2026-09-30", endPrice: 420 },
        corporateAction: {
          kind: "delisting",
          effectiveDate: "2026-09-30",
          proceedsPerShare: null,
          detail: "delisted to OTC; no reliable close",
        },
      }),
      { now: MATURED }
    );
    if (result.status !== "resolved") throw new Error("expected a record with published reasons");
    const o = result.outcome;
    expect(o.realisedTotalReturn).toBeNull();
    expect(o.targets.positiveTotalReturn).toMatchObject({
      status: "unresolved",
      reason: NON_RESOLUTION.proceedsUnknown,
    });
    expect(o.targets.scenarioBucket).toMatchObject({ status: "unresolved" });
    // The thesis question is unaffected by the price problem.
    expect(o.targets.thesisInvalidation).toEqual({ status: "resolved", value: 0 });
    expect(o.coverage).toBe("partial");
    expect(o.unresolvedReasons).toContain(NON_RESOLUTION.proceedsUnknown);
  });

  it("ignores a corporate action that happened after the horizon closed", () => {
    const result = resolvePrediction(
      record(),
      data({
        corporateAction: {
          kind: "merger",
          effectiveDate: "2027-06-01",
          proceedsPerShare: 150,
          detail: "merged five months after the horizon",
        },
      }),
      { now: MATURED }
    );
    if (result.status !== "resolved") throw new Error("expected resolution");
    expect(result.outcome.effectiveWindowEnd).toBe(TARGET);
    expect(result.outcome.realisedTotalReturn).toBeCloseTo(0.32, 12);
  });
});

describe("resolvePrediction — per-target refusals", () => {
  it("refuses a series that is not declared corporate-action adjusted", () => {
    const result = resolvePrediction(
      record(),
      data({ subject: { ...data().subject, corporateActionAdjusted: false } }),
      { now: MATURED }
    );
    if (result.status !== "resolved") throw new Error("expected a record with published reasons");
    expect(result.outcome.targets.positiveTotalReturn).toMatchObject({
      status: "unresolved",
      reason: NON_RESOLUTION.unadjustedPrices,
    });
    expect(result.outcome.coverage).toBe("partial");
  });

  it("refuses outperformance on a mismatched benchmark window but keeps the rest", () => {
    const result = resolvePrediction(
      record(),
      data({ benchmark: { ...data().benchmark!, windowEnd: "2026-12-31" } }),
      { now: MATURED }
    );
    if (result.status !== "resolved") throw new Error("expected a record with published reasons");
    const o = result.outcome;
    expect(o.targets.outperformBenchmark).toMatchObject({
      status: "unresolved",
      reason: NON_RESOLUTION.benchmarkWindowMismatch,
    });
    expect(o.targets.positiveTotalReturn).toEqual({ status: "resolved", value: 1 });
    expect(o.benchmarkTotalReturn).toBeNull();
    expect(o.excessReturn).toBeNull();
  });

  it("refuses outperformance when no benchmark series was obtained", () => {
    const result = resolvePrediction(record(), data({ benchmark: null }), { now: MATURED });
    if (result.status !== "resolved") throw new Error("expected a record with published reasons");
    expect(result.outcome.targets.outperformBenchmark).toMatchObject({
      status: "unresolved",
      reason: NON_RESOLUTION.benchmarkMissing,
    });
  });

  it("refuses every return target when the start price is missing", () => {
    const result = resolvePrediction(
      record(),
      data({ subject: { ...data().subject, startPrice: null } }),
      { now: MATURED }
    );
    if (result.status !== "resolved") throw new Error("expected a record with published reasons");
    expect(result.outcome.targets.positiveTotalReturn).toMatchObject({
      reason: NON_RESOLUTION.missingStartPrice,
    });
  });

  it("refuses the bucket when no boundaries were stored", () => {
    const noBuckets = record({
      buckets: null,
      forecasts: {
        positiveTotalReturn: 0.6,
        outperformBenchmark: 0.5,
        scenarioBucket: null,
        thesisInvalidation: 0.2,
      },
    });
    const result = resolvePrediction(noBuckets, data(), { now: MATURED });
    if (result.status !== "resolved") throw new Error("expected a record with published reasons");
    expect(result.outcome.targets.scenarioBucket).toMatchObject({
      status: "unresolved",
      reason: NON_RESOLUTION.noStoredBuckets,
    });
  });
});

describe("resolvePrediction — thesis invalidation", () => {
  it("records a breach as invalidated", () => {
    const result = resolvePrediction(
      record(),
      data({
        invalidationObservations: [
          { conditionId: "gm_below_40", status: "breached", observedOn: "2026-10-30" },
        ],
      }),
      { now: MATURED }
    );
    if (result.status !== "resolved") throw new Error("expected resolution");
    expect(result.outcome.targets.thesisInvalidation).toEqual({ status: "resolved", value: 1 });
  });

  it("never treats an unobserved condition as holding", () => {
    const result = resolvePrediction(
      record(),
      data({
        invalidationObservations: [
          { conditionId: "gm_below_40", status: "indeterminate", observedOn: null },
        ],
      }),
      { now: MATURED }
    );
    if (result.status !== "resolved") throw new Error("expected a record with published reasons");
    expect(result.outcome.targets.thesisInvalidation).toMatchObject({
      status: "unresolved",
      reason: NON_RESOLUTION.conditionsNotObserved,
    });
  });

  it("refuses when a named condition has no observation at all", () => {
    const result = resolvePrediction(record(), data({ invalidationObservations: [] }), {
      now: MATURED,
    });
    if (result.status !== "resolved") throw new Error("expected a record with published reasons");
    expect(result.outcome.targets.thesisInvalidation).toMatchObject({
      reason: NON_RESOLUTION.conditionsNotObserved,
    });
  });

  it("refuses when the prediction named no conditions", () => {
    const noConditions = record({
      invalidationConditions: [],
      forecasts: {
        positiveTotalReturn: 0.6,
        outperformBenchmark: 0.5,
        scenarioBucket: { bear: 0.2, base: 0.5, bull: 0.3 },
        thesisInvalidation: null,
      },
    });
    const result = resolvePrediction(noConditions, data(), { now: MATURED });
    if (result.status !== "resolved") throw new Error("expected a record with published reasons");
    expect(result.outcome.targets.thesisInvalidation).toMatchObject({
      reason: NON_RESOLUTION.noConditions,
    });
  });
});

describe("resolveBatch", () => {
  it("keeps the non-resolutions instead of filtering them away", () => {
    const { resolved, unresolved } = resolveBatch(
      [
        { prediction: record({ ticker: "AAPL" }), data: data() },
        {
          prediction: record({ ticker: "MSFT", snapshotId: "snap_2" }),
          data: data({ subject: { ...data().subject, symbol: "MSFT", windowEnd: "2026-12-31" } }),
        },
      ],
      { now: MATURED }
    );
    expect(resolved).toHaveLength(1);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]).toMatchObject({
      ticker: "MSFT",
      reason: NON_RESOLUTION.windowMismatch,
    });
  });
});
