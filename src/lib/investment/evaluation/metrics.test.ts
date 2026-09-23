import { describe, expect, it } from "vitest";
import { NON_RESOLUTION, type ResolvedPrediction } from "./outcomes";
import type { PredictionRecord } from "./predictions";
import {
  MIN_BIN_COUNT,
  MIN_SAMPLES_TO_REPORT,
  binaryTargetReport,
  brierScore,
  costReport,
  independenceDiagnostics,
  latencyReport,
  missingnessReport,
  multiclassBrier,
  multiclassLogLoss,
  reliabilityBins,
  returnMae,
  scenarioTargetReport,
} from "./metrics";

/**
 * ResolvedPrediction is a plain interface, so the report functions can be tested
 * on hand-built rows — no clock, no store, no resolution pipeline in the way.
 */
function resolved(overrides: {
  ticker?: string;
  asOf?: string;
  windowEnd?: string;
  forecastPositive?: number | null;
  outcomePositive?: 0 | 1 | null;
  bucketForecast?: { bear: number; base: number; bull: number } | null;
  bucketOutcome?: "bear" | "base" | "bull" | null;
  latencyMs?: number | null;
  costUsd?: number | null;
} = {}): ResolvedPrediction {
  const ticker = overrides.ticker ?? "AAPL";
  const asOf = overrides.asOf ?? "2026-01-15T00:00:00.000Z";
  const windowEnd = overrides.windowEnd ?? "2027-01-15";
  const unresolvedTarget = {
    status: "unresolved" as const,
    reason: NON_RESOLUTION.benchmarkMissing,
    detail: "no benchmark",
  };
  const positiveOutcome = overrides.outcomePositive;
  const bucketOutcome = overrides.bucketOutcome;

  return {
    predictionId: `${ticker}_${asOf}`,
    ticker,
    disposition: "selected",
    asOf,
    targetDate: windowEnd,
    effectiveWindowEnd: windowEnd,
    horizonCount: 12,
    horizonUnit: "calendar_months",
    resolvedAt: "2027-01-16T00:00:00.000Z",
    realisedTotalReturn: 0.1,
    benchmarkTotalReturn: null,
    excessReturn: null,
    corporateAction: null,
    targets: {
      positiveTotalReturn:
        positiveOutcome === null || positiveOutcome === undefined
          ? unresolvedTarget
          : { status: "resolved", value: positiveOutcome },
      outperformBenchmark: unresolvedTarget,
      scenarioBucket:
        bucketOutcome === null || bucketOutcome === undefined
          ? unresolvedTarget
          : { status: "resolved", value: bucketOutcome },
      thesisInvalidation: unresolvedTarget,
    },
    forecasts: {
      positiveTotalReturn:
        overrides.forecastPositive === undefined ? 0.6 : overrides.forecastPositive,
      outperformBenchmark: null,
      scenarioBucket: overrides.bucketForecast ?? null,
      thesisInvalidation: null,
    },
    coverage: "partial",
    unresolvedReasons: [NON_RESOLUTION.benchmarkMissing],
    versions: {
      targetDefinitions: "investment_targets_v1",
      bucketPolicy: "scenario_buckets_midpoint_v1",
      policyVersion: "policy_v1",
      valuationVersion: "val_v1",
      agentVersion: "agent_v1",
    },
    latencyMs: overrides.latencyMs === undefined ? 1_000 : overrides.latencyMs,
    costUsd: overrides.costUsd === undefined ? 0.2 : overrides.costUsd,
  };
}

describe("brierScore", () => {
  it("matches the reference fixture", () => {
    expect(brierScore([0.7, 0.2], [1, 0])).toBeCloseTo(0.065, 12);
  });

  it("scores a constant 0.5 forecast at 0.25", () => {
    expect(brierScore([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0])).toBeCloseTo(0.25, 12);
  });

  it("is bounded at 1 for a confidently wrong forecast, not infinite", () => {
    expect(brierScore([0, 1], [1, 0])).toBe(1);
    expect(Number.isFinite(brierScore([0], [1]))).toBe(true);
  });

  it("rejects invalid samples rather than coercing them", () => {
    expect(() => brierScore([], [])).toThrow("invalid samples");
    expect(() => brierScore([0.5], [1, 0])).toThrow("invalid samples");
    expect(() => brierScore([1.5], [1])).toThrow("invalid samples");
    expect(() => brierScore([Number.NaN], [1])).toThrow("invalid samples");
    expect(() => brierScore([0.5], [2])).toThrow("invalid samples");
  });
});

describe("multiclass scores", () => {
  const perfect = [{ bear: 0, base: 1, bull: 0 }];
  const uniform = [{ bear: 1 / 3, base: 1 / 3, bull: 1 / 3 }];

  it("scores a perfect three-class forecast at 0 and the worst case at 2", () => {
    expect(multiclassBrier(perfect, ["base"])).toBeCloseTo(0, 12);
    expect(multiclassBrier([{ bear: 1, base: 0, bull: 0 }], ["bull"])).toBeCloseTo(2, 12);
  });

  it("scores a uniform three-class forecast at two thirds", () => {
    expect(multiclassBrier(uniform, ["base"])).toBeCloseTo(2 / 3, 12);
  });

  it("returns an infinite log loss, unclipped, when a realised bucket had zero probability", () => {
    const result = multiclassLogLoss(perfect, ["bear"]);
    expect(result.value).toBe(Number.POSITIVE_INFINITY);
    expect(result.zeroProbabilityRows).toBe(1);
    expect(result.epsilon).toBeNull();
    expect(result.note).toContain("deliberately unclipped");
  });

  it("clips only when an epsilon is passed explicitly, and attributes the penalty to it", () => {
    const result = multiclassLogLoss(perfect, ["bear"], { epsilon: 1e-3 });
    expect(result.value).toBeCloseTo(-Math.log(1e-3), 10);
    expect(result.epsilon).toBe(1e-3);
    expect(result.note).toContain("set by the epsilon");
  });

  it("rejects an out-of-range epsilon and malformed triples", () => {
    expect(() => multiclassLogLoss(perfect, ["bear"], { epsilon: 0.9 })).toThrow("invalid epsilon");
    expect(() => multiclassBrier([{ bear: 0.5, base: 0.2, bull: 0.1 }], ["base"])).toThrow(
      "invalid samples"
    );
    expect(() => multiclassBrier(perfect, [])).toThrow("invalid samples");
  });
});

describe("returnMae", () => {
  it("averages absolute point error", () => {
    expect(returnMae([0.1, -0.2], [0.15, -0.1])).toBeCloseTo(0.075, 12);
  });

  it("rejects mismatched or non-finite samples", () => {
    expect(() => returnMae([0.1], [])).toThrow("invalid samples");
    expect(() => returnMae([Number.POSITIVE_INFINITY], [0.1])).toThrow("invalid samples");
  });
});

describe("reliabilityBins", () => {
  it("reports each bin's sample size and marks thin bins unreadable", () => {
    const p = [...new Array(20).fill(0.35), 0.95, 0.95];
    const y = [...new Array(10).fill(1), ...new Array(10).fill(0), 1, 1];
    const report = reliabilityBins(p, y);

    const populated = report.bins.filter((b) => b.count > 0);
    expect(populated).toHaveLength(2);
    const [main, thin] = populated;
    expect(main.count).toBe(20);
    expect(main.readable).toBe(true);
    expect(main.meanForecast).toBeCloseTo(0.35, 12);
    expect(main.empiricalRate).toBeCloseTo(0.5, 12);
    expect(thin.count).toBe(2);
    expect(thin.readable).toBe(false);
    expect(report.thinBins).toBe(1);
    // ECE is computed over readable bins only, so the two-row bin cannot move it.
    expect(report.expectedCalibrationError).toBeCloseTo(0.15, 12);
  });

  it("puts a forecast of exactly 1 in the top bin", () => {
    const report = reliabilityBins([1, 1], [1, 0], 10);
    expect(report.bins[9].count).toBe(2);
  });

  it("says there is no readable curve when every bin is thin", () => {
    const report = reliabilityBins([0.1, 0.9], [0, 1]);
    expect(report.expectedCalibrationError).toBeNull();
    expect(report.note).toContain(`${MIN_BIN_COUNT} rows`);
  });

  it("rejects invalid inputs", () => {
    expect(() => reliabilityBins([0.5], [1], 1)).toThrow("invalid binCount");
    expect(() => reliabilityBins([0.5, 0.5], [1])).toThrow("invalid samples");
    expect(() => reliabilityBins([2], [1])).toThrow("invalid samples");
  });
});

describe("independenceDiagnostics", () => {
  it("collapses overlapping windows on one issuer into a single observation", () => {
    const diagnostics = independenceDiagnostics([
      { issuer: "AAPL", windowStart: "2026-01-01", windowEnd: "2027-01-01" },
      { issuer: "AAPL", windowStart: "2026-02-01", windowEnd: "2027-02-01" },
      { issuer: "AAPL", windowStart: "2026-03-01", windowEnd: "2027-03-01" },
    ]);
    expect(diagnostics.samples).toBe(3);
    expect(diagnostics.distinctIssuers).toBe(1);
    expect(diagnostics.clusters).toBe(1);
    expect(diagnostics.effectiveSampleSize).toBe(1);
    expect(diagnostics.dependenceInflation).toBeCloseTo(3, 12);
    expect(diagnostics.naiveStandardErrorUnderstatement).toBeCloseTo(Math.sqrt(3), 12);
    expect(diagnostics.maxSimultaneousWindows).toBe(3);
    expect(diagnostics.warning).toContain("No interval or p-value is published");
  });

  it("counts non-overlapping windows on one issuer separately", () => {
    const diagnostics = independenceDiagnostics([
      { issuer: "AAPL", windowStart: "2020-01-01", windowEnd: "2021-01-01" },
      { issuer: "AAPL", windowStart: "2023-01-01", windowEnd: "2024-01-01" },
    ]);
    expect(diagnostics.clusters).toBe(2);
    expect(diagnostics.dependenceInflation).toBeCloseTo(1, 12);
  });

  it("counts distinct issuers as distinct observations even when their windows coincide", () => {
    const diagnostics = independenceDiagnostics([
      { issuer: "AAPL", windowStart: "2026-01-01", windowEnd: "2027-01-01" },
      { issuer: "MSFT", windowStart: "2026-01-01", windowEnd: "2027-01-01" },
    ]);
    expect(diagnostics.clusters).toBe(2);
    expect(diagnostics.maxSimultaneousWindows).toBe(2);
    // Documented understatement: shared sector and factor exposure is not clustered.
    expect(diagnostics.warning).toContain("upper bound");
  });

  it("handles an empty sample without inventing a number", () => {
    const diagnostics = independenceDiagnostics([]);
    expect(diagnostics).toMatchObject({ samples: 0, effectiveSampleSize: 0, warning: "no rows" });
  });
});

describe("binaryTargetReport", () => {
  it("refuses to publish a score below the display floor and says how many rows it had", () => {
    const rows = [
      resolved({ ticker: "AAPL", outcomePositive: 1 }),
      resolved({ ticker: "MSFT", outcomePositive: 0 }),
    ];
    const report = binaryTargetReport(rows, "positiveTotalReturn");
    expect(report.status).toBe("insufficient_samples");
    expect(report.samples).toBe(2);
    expect(report.required).toBe(MIN_SAMPLES_TO_REPORT);
    expect(report.brier).toBeNull();
    expect(report.reliability).toBeNull();
    expect(report.note).toContain("No score is reported");
  });

  it("scores the target and reports the base-rate bar alongside it", () => {
    const rows = [
      resolved({ ticker: "AAPL", forecastPositive: 0.7, outcomePositive: 1 }),
      resolved({ ticker: "MSFT", forecastPositive: 0.2, outcomePositive: 0 }),
    ];
    const report = binaryTargetReport(rows, "positiveTotalReturn", { minSamples: 2 });
    expect(report.status).toBe("ok");
    expect(report.brier).toBeCloseTo(0.065, 12);
    expect(report.baseRate).toBeCloseTo(0.5, 12);
    expect(report.baseRateBrier).toBeCloseTo(0.25, 12);
    expect(report.independence.effectiveSampleSize).toBe(2);
  });

  it("counts a resolved outcome with no forecast separately from a miss", () => {
    const rows = [
      resolved({ ticker: "AAPL", forecastPositive: 0.7, outcomePositive: 1 }),
      resolved({ ticker: "MSFT", forecastPositive: null, outcomePositive: 0 }),
      resolved({ ticker: "NVDA", forecastPositive: 0.2, outcomePositive: 0 }),
    ];
    const report = binaryTargetReport(rows, "positiveTotalReturn", { minSamples: 2 });
    expect(report.samples).toBe(2);
    expect(report.resolvedWithoutForecast).toBe(1);
    // The unforecast row cannot move the score in either direction.
    expect(report.brier).toBeCloseTo(0.065, 12);
  });

  it("excludes unresolved targets from the score entirely", () => {
    const rows = [
      resolved({ ticker: "AAPL", forecastPositive: 0.7, outcomePositive: 1 }),
      resolved({ ticker: "MSFT", forecastPositive: 0.2, outcomePositive: 0 }),
      resolved({ ticker: "NVDA", forecastPositive: 0.9, outcomePositive: null }),
    ];
    const report = binaryTargetReport(rows, "positiveTotalReturn", { minSamples: 2 });
    expect(report.samples).toBe(2);
  });

  it("reports the overlap warning for repeated forecasts on one issuer", () => {
    const rows = [
      resolved({ ticker: "AAPL", asOf: "2026-01-15T00:00:00.000Z", windowEnd: "2027-01-15", forecastPositive: 0.7, outcomePositive: 1 }),
      resolved({ ticker: "AAPL", asOf: "2026-02-15T00:00:00.000Z", windowEnd: "2027-02-15", forecastPositive: 0.7, outcomePositive: 1 }),
      resolved({ ticker: "AAPL", asOf: "2026-03-15T00:00:00.000Z", windowEnd: "2027-03-15", forecastPositive: 0.2, outcomePositive: 0 }),
    ];
    const report = binaryTargetReport(rows, "positiveTotalReturn", { minSamples: 3 });
    expect(report.samples).toBe(3);
    expect(report.independence.effectiveSampleSize).toBe(1);
    expect(report.note).toContain("overstate the sample");
  });
});

describe("scenarioTargetReport", () => {
  const triple = { bear: 0.2, base: 0.5, bull: 0.3 };

  it("reports honest emptiness below the floor", () => {
    const report = scenarioTargetReport([
      resolved({ bucketForecast: triple, bucketOutcome: "base" }),
    ]);
    expect(report.status).toBe("insufficient_samples");
    expect(report.multiclassBrier).toBeNull();
    expect(report.logLoss).toBeNull();
    expect(report.realisedFrequencies).toBeNull();
  });

  it("publishes both a bounded and an unbounded score with realised frequencies", () => {
    const rows = [
      resolved({ ticker: "AAPL", bucketForecast: triple, bucketOutcome: "base" }),
      resolved({ ticker: "MSFT", bucketForecast: triple, bucketOutcome: "bull" }),
    ];
    const report = scenarioTargetReport(rows, { minSamples: 2 });
    expect(report.status).toBe("ok");
    expect(report.multiclassBrier).toBeGreaterThan(0);
    expect(report.multiclassBrier).toBeLessThanOrEqual(2);
    expect(report.logLoss?.value).toBeGreaterThan(0);
    expect(report.realisedFrequencies).toEqual({ bear: 0, base: 0.5, bull: 0.5 });
    expect(report.note).toContain("bounded in [0, 2]");
  });

  it("counts resolved buckets with no forecast rather than scoring them", () => {
    const rows = [
      resolved({ ticker: "AAPL", bucketForecast: triple, bucketOutcome: "base" }),
      resolved({ ticker: "MSFT", bucketForecast: null, bucketOutcome: "bear" }),
    ];
    const report = scenarioTargetReport(rows, { minSamples: 1 });
    expect(report.samples).toBe(1);
    expect(report.resolvedWithoutForecast).toBe(1);
  });
});

describe("missingnessReport", () => {
  it("reports the resolution rate and every reason, per target", () => {
    const report = missingnessReport(
      [resolved({ outcomePositive: 1 }), resolved({ ticker: "MSFT", outcomePositive: 0 })],
      [
        { reason: NON_RESOLUTION.proceedsUnknown },
        { reason: NON_RESOLUTION.proceedsUnknown },
        { reason: NON_RESOLUTION.notMatured },
      ]
    );
    expect(report.predictions).toBe(5);
    expect(report.resolvedRecords).toBe(2);
    expect(report.unresolvableRecords).toBe(3);
    expect(report.resolutionRate).toBeCloseTo(0.4, 12);
    expect(report.byReason[NON_RESOLUTION.proceedsUnknown]).toBe(2);
    expect(report.byReason[NON_RESOLUTION.notMatured]).toBe(1);
    // Per-target counts include the three targets these fixtures leave unresolved.
    expect(report.perTarget.positiveTotalReturn).toEqual({ resolved: 2, unresolved: 0 });
    expect(report.perTarget.outperformBenchmark).toEqual({ resolved: 0, unresolved: 2 });
    expect(report.note).toContain("bias the record upward");
  });

  it("says nothing is in scope rather than dividing by zero", () => {
    const report = missingnessReport([], []);
    expect(report.resolutionRate).toBe(0);
    expect(report.note).toBe("no predictions in scope");
  });
});

describe("operational reporting", () => {
  function prediction(latencyMs: number | null, costUsd: number | null): PredictionRecord {
    return { latencyMs, costUsd } as PredictionRecord;
  }

  it("excludes unmeasured latency rather than imputing it", () => {
    const report = latencyReport([prediction(1_000, null), prediction(3_000, null), prediction(null, null)]);
    expect(report.records).toBe(3);
    expect(report.measured).toBe(2);
    expect(report.missing).toBe(1);
    expect(report.mean).toBeCloseTo(2_000, 12);
    expect(report.p50).toBe(1_000);
    expect(report.p90).toBe(3_000);
    expect(report.max).toBe(3_000);
    expect(report.note).toContain("imputed");
  });

  it("totals measured cost and reports how much was unmeasured", () => {
    const report = costReport([prediction(null, 0.25), prediction(null, 0.75), prediction(null, null)]);
    expect(report.total).toBeCloseTo(1, 12);
    expect(report.mean).toBeCloseTo(0.5, 12);
    expect(report.missing).toBe(1);
  });

  it("says plainly when nothing was measured", () => {
    const report = costReport([prediction(null, null)]);
    expect(report.total).toBeNull();
    expect(report.mean).toBeNull();
    expect(report.note).toContain("no cost was measured");
  });
});
