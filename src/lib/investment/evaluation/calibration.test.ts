import { describe, expect, it } from "vitest";
import { ScenarioWeightsSchema } from "../schemas";
import {
  BENCHMARK_ARMS,
  MIN_MATURED_PER_COHORT,
  applyCalibration,
  assessCohorts,
  attemptCalibration,
  buildCalibratedWeights,
  chronologicalSplit,
  cohortKey,
  compareArms,
  labelContamination,
  promoteProbabilityBasis,
  protocolHash,
  type ArmResult,
  type CalibrationArtifact,
  type HeldOutProtocol,
} from "./calibration";
import { NON_RESOLUTION, type ResolvedPrediction } from "./outcomes";
import { buildPredictionRecord, type PredictionInput, type PredictionRecord } from "./predictions";

const TRIPLE = { bear: 0.2, base: 0.5, bull: 0.3 };

/** YYYY-MM-01 for a zero-based month offset from 2020-01. */
function monthStart(offset: number): string {
  const year = 2020 + Math.floor(offset / 12);
  const month = (offset % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function input(overrides: Partial<PredictionInput> = {}): PredictionInput {
  return {
    ownerUid: "uid_1",
    reportId: "report_1",
    snapshotId: "snap_1",
    ticker: "AAPL",
    disposition: "selected",
    rating: "buy",
    reasonCodes: ["clears_return_hurdle"],
    asOf: "2026-01-15T00:00:00.000Z",
    targetDate: "2027-01-15",
    horizonCount: 12,
    horizonUnit: "calendar_months",
    yearFraction: 1,
    forecasts: {
      positiveTotalReturn: 0.6,
      outperformBenchmark: null,
      scenarioBucket: TRIPLE,
      thesisInvalidation: null,
    },
    buckets: { boundaries: [-0.05, 0.22] },
    expectedTotalReturn: 0.1,
    scenarioReturns: { bear: -0.3, base: 0.12, bull: 0.4 },
    invalidationConditions: [],
    provenance: {
      basis: "model_unvalidated",
      model: "claude-opus-5",
      calibrationVersion: null,
      promptHash: null,
    },
    policyVersion: "policy_v1",
    valuationVersion: "val_v1",
    agentVersion: "agent_v1",
    latencyMs: 1_000,
    costUsd: 0.2,
    createdAt: "2026-01-15T00:00:00.000Z",
    ...overrides,
  };
}

function record(overrides: Partial<PredictionInput> = {}): PredictionRecord {
  const built = buildPredictionRecord(input(overrides));
  if (built.status !== "ok") throw new Error(`fixture invalid: ${built.reason}`);
  return built.record;
}

/** A monthly series of one-month forecasts, each on its own issuer. */
function monthlyRow(
  offset: number,
  forecast: number,
  outcome: 0 | 1
): { prediction: PredictionRecord; outcome: ResolvedPrediction } {
  const asOfDate = monthStart(offset);
  const targetDate = monthStart(offset + 1);
  const prediction = record({
    ticker: `T${offset}`,
    snapshotId: `snap_${offset}`,
    asOf: `${asOfDate}T00:00:00.000Z`,
    targetDate,
    horizonCount: 1,
    horizonUnit: "calendar_months",
    yearFraction: 1 / 12,
    forecasts: {
      positiveTotalReturn: forecast,
      outperformBenchmark: null,
      scenarioBucket: TRIPLE,
      thesisInvalidation: null,
    },
  });

  const unresolvedTarget = {
    status: "unresolved" as const,
    reason: NON_RESOLUTION.benchmarkMissing,
    detail: "no benchmark",
  };

  return {
    prediction,
    outcome: {
      predictionId: prediction.id,
      ticker: prediction.ticker,
      disposition: "selected",
      asOf: prediction.asOf,
      targetDate,
      effectiveWindowEnd: targetDate,
      horizonCount: 1,
      horizonUnit: "calendar_months",
      resolvedAt: `${targetDate}T00:00:00.000Z`,
      realisedTotalReturn: outcome === 1 ? 0.05 : -0.05,
      benchmarkTotalReturn: null,
      excessReturn: null,
      corporateAction: null,
      targets: {
        positiveTotalReturn: { status: "resolved", value: outcome },
        outperformBenchmark: unresolvedTarget,
        scenarioBucket: unresolvedTarget,
        thesisInvalidation: unresolvedTarget,
      },
      forecasts: prediction.forecasts,
      coverage: "partial",
      unresolvedReasons: [NON_RESOLUTION.benchmarkMissing],
      versions: prediction.versions,
      latencyMs: prediction.latencyMs,
      costUsd: prediction.costUsd,
    },
  };
}

function protocol(overrides: Partial<HeldOutProtocol> = {}): HeldOutProtocol {
  return {
    id: "proto_1",
    declaredAt: "2019-12-01T00:00:00.000Z",
    cohort: "1_calendar_months",
    splitCutoff: "2021-05-01T00:00:00.000Z",
    validationFraction: 0.3,
    embargoDays: 0,
    method: "identity",
    target: "positiveTotalReturn",
    primaryMetric: "brier",
    minImprovement: 0,
    minMatured: 4,
    ...overrides,
  };
}

describe("the gate is a gate, not proof", () => {
  it("requires 200 matured predictions per horizon cohort", () => {
    expect(MIN_MATURED_PER_COHORT).toBe(200);
  });

  it("segments cohorts by horizon, because a 3-month and a 3-year problem are not poolable", () => {
    expect(cohortKey({ horizonCount: 12, horizonUnit: "calendar_months" })).toBe(
      "12_calendar_months"
    );
    expect(cohortKey({ horizonCount: 3, horizonUnit: "calendar_months" })).not.toBe(
      "12_calendar_months"
    );
  });

  it("reports an immature cohort honestly instead of scoring what has arrived", () => {
    const rows = [record({ ticker: "AAPL" }), record({ ticker: "MSFT", snapshotId: "snap_2" })];
    const [status] = assessCohorts(rows, { now: new Date("2026-06-01T00:00:00.000Z") });
    expect(status.cohort).toBe("12_calendar_months");
    expect(status.total).toBe(2);
    expect(status.matured).toBe(0);
    expect(status.gatePassed).toBe(false);
    expect(status.note).toContain(`of ${MIN_MATURED_PER_COHORT} matured`);
  });

  it("says the gate permits computation rather than establishing adequacy", () => {
    const rows = [record({ ticker: "AAPL" }), record({ ticker: "MSFT", snapshotId: "snap_2" })];
    const [status] = assessCohorts(rows, {
      now: new Date("2027-06-01T00:00:00.000Z"),
      minMatured: 2,
    });
    expect(status.gatePassed).toBe(true);
    expect(status.matured).toBe(2);
    expect(status.note).toContain("does not establish adequacy");
  });

  it("separates cohorts by horizon", () => {
    const statuses = assessCohorts(
      [
        record({ ticker: "AAPL" }),
        record({
          ticker: "MSFT",
          snapshotId: "snap_2",
          horizonCount: 3,
          targetDate: "2026-04-15",
          yearFraction: 0.25,
        }),
      ],
      { now: new Date("2026-06-01T00:00:00.000Z") }
    );
    expect(statuses.map((s) => s.cohort)).toEqual(["12_calendar_months", "3_calendar_months"]);
  });
});

describe("chronologicalSplit", () => {
  it("splits in time and purges train rows whose horizon crossed the cutoff", () => {
    // 20 monthly forecasts with 12-month horizons: almost every train row's window
    // reaches into the validation period and must be purged.
    const records = Array.from({ length: 20 }, (_, i) =>
      record({
        ticker: `T${i}`,
        snapshotId: `snap_${i}`,
        asOf: `${monthStart(i)}T00:00:00.000Z`,
        targetDate: monthStart(i + 12),
      })
    );

    const split = chronologicalSplit(records, { validationFraction: 0.3 });
    expect(split.status).toBe("ok");
    if (split.status !== "ok") return;

    const cutoffMs = Date.parse(split.cutoff);
    expect(split.purged).toBeGreaterThan(0);
    for (const row of split.train) {
      expect(Date.parse(`${row.targetDate}T00:00:00.000Z`)).toBeLessThanOrEqual(cutoffMs);
    }
    for (const row of split.validation) {
      expect(Date.parse(row.asOf)).toBeGreaterThanOrEqual(cutoffMs);
    }
    expect(split.note).toContain("purged");
  });

  it("is reproducible regardless of the input order", () => {
    const records = Array.from({ length: 12 }, (_, i) =>
      monthlyRow(i, 0.6, 1).prediction
    );
    const forward = chronologicalSplit(records);
    const reversed = chronologicalSplit([...records].reverse());
    if (forward.status !== "ok" || reversed.status !== "ok") throw new Error("expected splits");
    expect(reversed.cutoff).toBe(forward.cutoff);
    expect(reversed.train.map((r) => r.id)).toEqual(forward.train.map((r) => r.id));
  });

  it("refuses a fraction or a sample that leaves one side empty", () => {
    expect(chronologicalSplit([record()], {})).toMatchObject({ status: "insufficient" });
    expect(
      chronologicalSplit([record(), record({ ticker: "MSFT", snapshotId: "s2" })], {
        validationFraction: 1.5,
      })
    ).toMatchObject({ status: "insufficient" });
  });

  it("refuses when every train row has to be purged", () => {
    // Horizons far longer than the available history: nothing resolves before the cutoff.
    const records = Array.from({ length: 6 }, (_, i) =>
      record({
        ticker: `T${i}`,
        snapshotId: `snap_${i}`,
        asOf: `${monthStart(i)}T00:00:00.000Z`,
        targetDate: monthStart(i + 60),
      })
    );
    const split = chronologicalSplit(records, { validationFraction: 0.3 });
    expect(split.status).toBe("insufficient");
    if (split.status === "insufficient") expect(split.reason).toContain("purging");
  });
});

describe("hindsight contamination labelling", () => {
  it("labels live-forward data as clean", () => {
    const label = labelContamination({
      kind: "live_forward",
      evidenceDateFiltered: true,
      modelPostDatesPeriod: false,
    });
    expect(label.risk).toBe("none_live_forward");
    expect(label.usableAsEvidenceOfSkill).toBe(true);
  });

  it("still labels a backtest contaminated even when evidence was date-filtered", () => {
    const label = labelContamination({
      kind: "historical_backtest",
      evidenceDateFiltered: true,
      modelPostDatesPeriod: true,
    });
    expect(label.risk).toBe("potentially_hindsight_contaminated");
    expect(label.usableAsEvidenceOfSkill).toBe(false);
    expect(label.note).toContain("does NOT remove contamination");
    expect(label.note).toContain("may simply remember the outcome");
  });

  it("notes that an unverified model vintage does not exclude memory leakage", () => {
    const label = labelContamination({
      kind: "historical_backtest",
      evidenceDateFiltered: false,
      modelPostDatesPeriod: false,
    });
    expect(label.usableAsEvidenceOfSkill).toBe(false);
    expect(label.note).toContain("cannot be excluded");
  });
});

describe("attemptCalibration", () => {
  const now = new Date("2022-06-01T00:00:00.000Z");
  const liveForward = {
    kind: "live_forward" as const,
    evidenceDateFiltered: true,
    modelPostDatesPeriod: false,
  };

  /** 24 monthly rows, alternating outcomes, all forecast at `forecast`. */
  function series(forecast: number) {
    return Array.from({ length: 24 }, (_, i) => monthlyRow(i, forecast, i % 2 === 0 ? 1 : 0));
  }

  it("produces an eligible artifact when the predeclared protocol is met on live-forward data", () => {
    const attempt = attemptCalibration({
      cohort: "1_calendar_months",
      protocol: protocol(),
      rows: series(0.5),
      source: liveForward,
      now,
    });
    expect(attempt.status).toBe("attempted");
    if (attempt.status !== "attempted") return;
    expect(attempt.artifact.predeclared).toBe(true);
    expect(attempt.artifact.protocolPassed).toBe(true);
    expect(attempt.artifact.hindsightRisk).toBe("none_live_forward");
    expect(attempt.artifact.blockers).toEqual([]);
    expect(attempt.artifact.eligibleForProduction).toBe(true);
    expect(attempt.artifact.validationEffectiveSampleSize).toBeGreaterThan(0);
    expect(attempt.artifact.note).toContain("overstates the independent evidence");
  });

  it("measures a real improvement when isotonic corrects an overconfident forecaster", () => {
    const attempt = attemptCalibration({
      cohort: "1_calendar_months",
      protocol: protocol({ method: "isotonic", minImprovement: 0.1 }),
      rows: series(0.9),
      source: liveForward,
      now,
    });
    if (attempt.status !== "attempted") throw new Error("expected an attempt");
    expect(attempt.artifact.baselineBrier).toBeCloseTo(0.41, 12);
    expect(attempt.artifact.calibratedBrier).toBeCloseTo(0.25, 12);
    expect(attempt.artifact.improvement).toBeCloseTo(0.16, 12);
    expect(attempt.artifact.protocolPassed).toBe(true);
    expect(attempt.artifact.eligibleForProduction).toBe(true);
  });

  it("blocks eligibility on a contaminated backtest however good the fit looks", () => {
    const attempt = attemptCalibration({
      cohort: "1_calendar_months",
      protocol: protocol({ method: "isotonic", minImprovement: 0.1 }),
      rows: series(0.9),
      source: {
        kind: "historical_backtest",
        evidenceDateFiltered: true,
        modelPostDatesPeriod: true,
      },
      now,
    });
    if (attempt.status !== "attempted") throw new Error("expected an attempt");
    expect(attempt.artifact.protocolPassed).toBe(true);
    expect(attempt.artifact.hindsightRisk).toBe("potentially_hindsight_contaminated");
    expect(attempt.artifact.eligibleForProduction).toBe(false);
    expect(attempt.artifact.blockers.join(" ")).toContain("never as evidence of forecasting skill");
  });

  it("blocks eligibility when the protocol was declared after the split cutoff", () => {
    const attempt = attemptCalibration({
      cohort: "1_calendar_months",
      protocol: protocol({ declaredAt: "2022-01-01T00:00:00.000Z" }),
      rows: series(0.5),
      source: liveForward,
      now,
    });
    if (attempt.status !== "attempted") throw new Error("expected an attempt");
    expect(attempt.artifact.predeclared).toBe(false);
    expect(attempt.artifact.eligibleForProduction).toBe(false);
    expect(attempt.artifact.blockers.join(" ")).toContain("is not held out");
  });

  it("blocks eligibility when the maturity gate is not met", () => {
    const attempt = attemptCalibration({
      cohort: "1_calendar_months",
      protocol: protocol({ minMatured: MIN_MATURED_PER_COHORT }),
      rows: series(0.5),
      source: liveForward,
      now,
    });
    if (attempt.status !== "attempted") throw new Error("expected an attempt");
    expect(attempt.artifact.eligibleForProduction).toBe(false);
    expect(attempt.artifact.blockers.join(" ")).toContain("not a power calculation");
  });

  it("keeps a failed attempt rather than discarding it", () => {
    const attempt = attemptCalibration({
      cohort: "1_calendar_months",
      protocol: protocol({ method: "identity", minImprovement: 0.2 }),
      rows: series(0.5),
      source: liveForward,
      now,
    });
    if (attempt.status !== "attempted") throw new Error("expected an attempt");
    expect(attempt.artifact.protocolPassed).toBe(false);
    expect(attempt.artifact.eligibleForProduction).toBe(false);
    expect(attempt.artifact.blockers.join(" ")).toContain("did not reach the predeclared");
  });

  it("refuses outright when there is nothing to fit", () => {
    const attempt = attemptCalibration({
      cohort: "1_calendar_months",
      protocol: protocol(),
      rows: [monthlyRow(0, 0.6, 1)],
      source: liveForward,
      now,
    });
    expect(attempt.status).toBe("refused");
    if (attempt.status === "refused") {
      expect(attempt.blockers.join(" ")).toContain("fewer than two scorable rows");
    }
  });

  it("refuses when the chronological split cannot be formed, with no random fallback", () => {
    const longHorizons = Array.from({ length: 6 }, (_, i) => {
      const row = monthlyRow(i, 0.6, i % 2 === 0 ? 1 : 0);
      const prediction = record({
        ticker: `L${i}`,
        snapshotId: `lsnap_${i}`,
        asOf: `${monthStart(i)}T00:00:00.000Z`,
        targetDate: monthStart(i + 60),
        horizonCount: 1,
        horizonUnit: "calendar_months",
        yearFraction: 1 / 12,
        forecasts: row.prediction.forecasts,
      });
      return { prediction, outcome: { ...row.outcome, predictionId: prediction.id } };
    });

    const attempt = attemptCalibration({
      cohort: "1_calendar_months",
      protocol: protocol(),
      rows: longHorizons,
      source: liveForward,
      now,
    });
    expect(attempt.status).toBe("refused");
    if (attempt.status === "refused") {
      expect(attempt.note).toContain("random split is not an available fallback");
    }
  });

  it("hashes the protocol so a later edit is detectable", () => {
    const original = protocolHash(protocol());
    expect(original).toHaveLength(64);
    expect(protocolHash(protocol({ minImprovement: 0.01 }))).not.toBe(original);
  });
});

describe("applyCalibration", () => {
  it("leaves a forecast alone under the identity map", () => {
    expect(applyCalibration({ method: "identity" }, 0.6)).toBeCloseTo(0.6, 12);
  });

  it("applies a platt map monotonically", () => {
    const model = { method: "platt", a: 1, b: 0 } as const;
    expect(applyCalibration(model, 0.3)).toBeLessThan(applyCalibration(model, 0.7));
  });

  it("returns the fitted block value for an isotonic map, and the last block above its range", () => {
    const model = {
      method: "isotonic" as const,
      breakpoints: [
        { upTo: 0.4, value: 0.1 },
        { upTo: 0.8, value: 0.6 },
      ],
    };
    expect(applyCalibration(model, 0.2)).toBeCloseTo(0.1, 12);
    expect(applyCalibration(model, 0.5)).toBeCloseTo(0.6, 12);
    expect(applyCalibration(model, 0.99)).toBeCloseTo(0.6, 12);
  });
});

describe("the promotion gate", () => {
  function artifact(overrides: Partial<CalibrationArtifact> = {}): CalibrationArtifact {
    return {
      version: "cal_1_calendar_months_positiveTotalReturn_abc123def456",
      createdAt: "2022-06-01T00:00:00.000Z",
      cohort: "1_calendar_months",
      target: "positiveTotalReturn",
      protocolId: "proto_1",
      protocolHash: "a".repeat(64),
      protocolDeclaredAt: "2019-12-01T00:00:00.000Z",
      predeclared: true,
      method: "isotonic",
      trainCount: 16,
      validationCount: 8,
      validationEffectiveSampleSize: 8,
      baselineBrier: 0.41,
      calibratedBrier: 0.25,
      improvement: 0.16,
      minImprovement: 0.1,
      protocolPassed: true,
      hindsightRisk: "none_live_forward",
      eligibleForProduction: true,
      blockers: [],
      note: "ok",
      ...overrides,
    };
  }

  const context = { cohort: "1_calendar_months", target: "positiveTotalReturn" };

  it("keeps raw model weights when there is no artifact", () => {
    const result = promoteProbabilityBasis("model_unvalidated", null, context);
    expect(result.promoted).toBe(false);
    expect(result.basis).toBe("model_unvalidated");
    expect(result.calibrationVersion).toBeNull();
    expect(result.reason).toContain("keeps raw model weights");
  });

  it("keeps raw model weights when the artifact is not eligible", () => {
    const result = promoteProbabilityBasis(
      "model_unvalidated",
      artifact({ eligibleForProduction: false, blockers: ["gate not met"] }),
      context
    );
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain("gate not met");
  });

  it("keeps raw model weights for a hindsight-contaminated artifact", () => {
    const result = promoteProbabilityBasis(
      "model_unvalidated",
      artifact({ hindsightRisk: "potentially_hindsight_contaminated" }),
      context
    );
    expect(result.promoted).toBe(false);
    expect(result.reason).toContain("cannot license a calibration claim");
  });

  it("refuses to transfer a calibration across horizons or questions", () => {
    expect(
      promoteProbabilityBasis("model_unvalidated", artifact(), {
        cohort: "12_calendar_months",
        target: "positiveTotalReturn",
      }).promoted
    ).toBe(false);
    expect(
      promoteProbabilityBasis("model_unvalidated", artifact(), {
        cohort: "1_calendar_months",
        target: "outperformBenchmark",
      }).reason
    ).toContain("does not transfer");
  });

  it("promotes only with an eligible, matching, live-forward artifact", () => {
    const result = promoteProbabilityBasis("model_unvalidated", artifact(), context);
    expect(result.promoted).toBe(true);
    expect(result.basis).toBe("empirically_calibrated");
    expect(result.calibrationVersion).toBe(artifact().version);
  });

  it("cannot set empirically_calibrated without a calibrationVersion — the schema lock", () => {
    const parsed = ScenarioWeightsSchema.safeParse({
      values: TRIPLE,
      basis: "empirically_calibrated",
      model: "claude-opus-5",
      calibrationVersion: null,
    });
    expect(parsed.success).toBe(false);
  });

  it("builds uncalibrated weights when no artifact exists, and calibrated ones when it does", () => {
    const withoutArtifact = buildCalibratedWeights(TRIPLE, {
      currentBasis: "model_unvalidated",
      model: "claude-opus-5",
      artifact: null,
      ...context,
    });
    expect(withoutArtifact.status).toBe("ok");
    if (withoutArtifact.status === "ok") {
      expect(withoutArtifact.weights.basis).toBe("model_unvalidated");
      expect(withoutArtifact.weights.calibrationVersion).toBeNull();
    }

    const withArtifact = buildCalibratedWeights(TRIPLE, {
      currentBasis: "model_unvalidated",
      model: "claude-opus-5",
      artifact: artifact(),
      ...context,
    });
    if (withArtifact.status !== "ok") throw new Error("expected weights");
    expect(withArtifact.weights.basis).toBe("empirically_calibrated");
    expect(withArtifact.weights.calibrationVersion).toBe(artifact().version);
  });

  it("refuses a triple that is not a probability distribution", () => {
    const result = buildCalibratedWeights(
      { bear: 0.5, base: 0.5, bull: 0.5 },
      {
        currentBasis: "model_unvalidated",
        model: null,
        artifact: null,
        ...context,
      }
    );
    expect(result.status).toBe("refused");
  });
});

describe("compareArms", () => {
  function arm(id: string, brier: number | null, effective: number): ArmResult {
    return {
      arm: id,
      samples: 400,
      effectiveSampleSize: effective,
      brier,
      hitRate: 0.55,
      meanExcessReturn: 0.01,
      medianLatencyMs: 30_000,
      meanCostUsd: 0.25,
    };
  }

  it("refuses to order the arms when the deterministic screen is missing", () => {
    const comparison = compareArms([
      arm(BENCHMARK_ARMS.scoutAndAgents.id, 0.21, 150),
      arm(BENCHMARK_ARMS.scoutAgentsAndModelProbabilities.id, 0.2, 150),
    ]);
    expect(comparison.status).toBe("inconclusive");
    expect(comparison.ranking).toBeNull();
    expect(comparison.note).toContain("deterministic screen");
  });

  it("refuses to order the arms when any arm is below the effective-sample floor", () => {
    const comparison = compareArms([
      arm(BENCHMARK_ARMS.screenOnly.id, 0.22, 150),
      arm(BENCHMARK_ARMS.scoutAndAgents.id, 0.21, 12),
      arm(BENCHMARK_ARMS.scoutAgentsAndModelProbabilities.id, 0.2, 150),
    ]);
    expect(comparison.status).toBe("inconclusive");
    expect(comparison.note).toContain("overlap-free observations");
  });

  it("publishes an ordering with no significance claim when all three arms qualify", () => {
    const comparison = compareArms([
      arm(BENCHMARK_ARMS.screenOnly.id, 0.22, 150),
      arm(BENCHMARK_ARMS.scoutAndAgents.id, 0.2, 150),
      arm(BENCHMARK_ARMS.scoutAgentsAndModelProbabilities.id, 0.21, 150),
    ]);
    expect(comparison.status).toBe("ranked");
    expect(comparison.ranking).toEqual([
      BENCHMARK_ARMS.scoutAndAgents.id,
      BENCHMARK_ARMS.scoutAgentsAndModelProbabilities.id,
      BENCHMARK_ARMS.screenOnly.id,
    ]);
    expect(comparison.note).toContain("not a significance claim");
    expect(comparison.note).toContain("more fluent arm is not mistaken for a more accurate one");
  });
});
