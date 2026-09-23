import { describe, expect, it } from "vitest";
import {
  BUCKET_POLICY_VERSION,
  PredictionConflictError,
  TARGET_DEFINITIONS_VERSION,
  buildPredictionRecord,
  isMatured,
  predictionDocId,
  savePredictions,
  type PredictionInput,
  type PredictionRecord,
  type PredictionStore,
} from "./predictions";

/**
 * Dictionary-backed store. No emulator, no credentials, no network — the
 * append-only rule is enforced here exactly as the interface documents it, so the
 * tests exercise the contract rather than Firestore's behaviour.
 */
function fakeStore(): PredictionStore & { rows: Map<string, PredictionRecord> } {
  const rows = new Map<string, PredictionRecord>();
  return {
    rows,
    async create(docId, record) {
      if (rows.has(docId)) throw new PredictionConflictError(docId);
      rows.set(docId, record);
    },
    async get(docId) {
      return rows.get(docId) ?? null;
    },
    async listMatured(onOrBefore) {
      return [...rows.values()].filter((r) => r.targetDate <= onOrBefore);
    },
  };
}

function input(overrides: Partial<PredictionInput> = {}): PredictionInput {
  return {
    ownerUid: "uid_1",
    reportId: "report_1",
    snapshotId: "snap_1",
    ticker: "aapl",
    disposition: "selected",
    rating: "buy",
    reasonCodes: ["clears_return_hurdle"],
    asOf: "2026-01-15T14:30:00.000Z",
    targetDate: "2027-01-15",
    horizonCount: 12,
    horizonUnit: "calendar_months",
    yearFraction: 1.0,
    forecasts: {
      positiveTotalReturn: 0.62,
      outperformBenchmark: 0.55,
      scenarioBucket: { bear: 0.2, base: 0.5, bull: 0.3 },
      thesisInvalidation: 0.18,
    },
    buckets: { boundaries: [-0.05, 0.22] },
    expectedTotalReturn: 0.11,
    scenarioReturns: { bear: -0.3, base: 0.12, bull: 0.4 },
    invalidationConditions: [{ id: "gm_below_40", description: "Gross margin below 40% for 2 quarters" }],
    provenance: {
      basis: "model_unvalidated",
      model: "claude-opus-5",
      calibrationVersion: null,
      promptHash: "a".repeat(64),
    },
    policyVersion: "policy_v1",
    valuationVersion: "val_v1",
    agentVersion: "agent_v1",
    latencyMs: 42_000,
    costUsd: 0.31,
    createdAt: "2026-01-15T14:31:00.000Z",
    ...overrides,
  };
}

function record(overrides: Partial<PredictionInput> = {}): PredictionRecord {
  const built = buildPredictionRecord(input(overrides));
  if (built.status !== "ok") throw new Error(`fixture invalid: ${built.reason}`);
  return built.record;
}

describe("buildPredictionRecord", () => {
  it("stamps the versioned question definitions onto the record", () => {
    const built = record();
    expect(built.versions.targetDefinitions).toBe(TARGET_DEFINITIONS_VERSION);
    expect(built.versions.bucketPolicy).toBe(BUCKET_POLICY_VERSION);
    expect(built.buckets).toEqual({ boundaries: [-0.05, 0.22] });
    expect(built.ticker).toBe("AAPL");
  });

  it("keeps the four forecasts separate, including nulls", () => {
    const built = record({
      forecasts: {
        positiveTotalReturn: 0.6,
        outperformBenchmark: null,
        scenarioBucket: null,
        thesisInvalidation: null,
      },
      buckets: null,
    });
    expect(built.forecasts.positiveTotalReturn).toBe(0.6);
    expect(built.forecasts.outperformBenchmark).toBeNull();
    expect(built.forecasts.scenarioBucket).toBeNull();
    expect(built.forecasts.thesisInvalidation).toBeNull();
  });

  it("refuses a bucket forecast with no stored boundaries", () => {
    const built = buildPredictionRecord(input({ buckets: null }));
    expect(built.status).toBe("invalid");
    if (built.status === "invalid") expect(built.reason).toContain("unresolvable");
  });

  it("refuses a thesis probability with no named conditions", () => {
    const built = buildPredictionRecord(input({ invalidationConditions: [] }));
    expect(built.status).toBe("invalid");
    if (built.status === "invalid") expect(built.reason).toContain("never be resolved");
  });

  it("refuses a rejected candidate with no rejection reason", () => {
    const built = buildPredictionRecord(input({ disposition: "rejected", reasonCodes: [] }));
    expect(built.status).toBe("invalid");
    if (built.status === "invalid") expect(built.reason).toContain("why it was rejected");
  });

  it("refuses an empirically_calibrated basis with no calibration artifact reference", () => {
    const built = buildPredictionRecord(
      input({
        provenance: {
          basis: "empirically_calibrated",
          model: "claude-opus-5",
          calibrationVersion: null,
          promptHash: null,
        },
      })
    );
    expect(built.status).toBe("invalid");
    if (built.status === "invalid") expect(built.reason).toContain("calibrationVersion");
  });

  it("refuses a calibrationVersion on an uncalibrated basis", () => {
    const built = buildPredictionRecord(
      input({
        provenance: {
          basis: "model_unvalidated",
          model: "claude-opus-5",
          calibrationVersion: "cal_12_calendar_months_x",
          promptHash: null,
        },
      })
    );
    expect(built.status).toBe("invalid");
  });

  it("refuses a weight triple that does not sum to one", () => {
    const built = buildPredictionRecord(
      input({
        forecasts: {
          positiveTotalReturn: 0.5,
          outperformBenchmark: null,
          scenarioBucket: { bear: 0.2, base: 0.2, bull: 0.2 },
          thesisInvalidation: null,
        },
      })
    );
    expect(built.status).toBe("invalid");
  });
});

describe("predictionDocId", () => {
  it("is deterministic and case-insensitive on the ticker", () => {
    const a = predictionDocId({
      ownerUid: "uid_1",
      snapshotId: "snap_1",
      ticker: "aapl",
      targetDate: "2027-01-15",
    });
    const b = predictionDocId({
      ownerUid: "uid_1",
      snapshotId: "snap_1",
      ticker: "AAPL",
      targetDate: "2027-01-15",
    });
    expect(a).toBe(b);
  });

  it("changes when the question definition changes", () => {
    const base = predictionDocId({
      ownerUid: "uid_1",
      snapshotId: "snap_1",
      ticker: "AAPL",
      targetDate: "2027-01-15",
    });
    const next = predictionDocId({
      ownerUid: "uid_1",
      snapshotId: "snap_1",
      ticker: "AAPL",
      targetDate: "2027-01-15",
      targetDefinitionsVersion: "investment_targets_v2",
    });
    expect(next).not.toBe(base);
  });
});

describe("savePredictions", () => {
  const now = new Date("2026-01-15T15:00:00.000Z");

  it("stores selected and rejected candidates alike", async () => {
    const store = fakeStore();
    const selected = record({ ticker: "AAPL" });
    const rejected = record({
      ticker: "MSFT",
      snapshotId: "snap_1",
      disposition: "rejected",
      rating: "watch",
      reasonCodes: ["below_return_hurdle"],
      reportId: null,
    });

    const outcomes = await savePredictions(store, [selected, rejected], { now });
    expect(outcomes.map((o) => o.status)).toEqual(["saved", "saved"]);
    expect(store.rows.size).toBe(2);
    const dispositions = [...store.rows.values()].map((r) => r.disposition).sort();
    expect(dispositions).toEqual(["rejected", "selected"]);
  });

  it("refuses a prediction whose target date has already arrived", async () => {
    const store = fakeStore();
    const outcomes = await savePredictions(store, [record()], {
      now: new Date("2027-01-15T00:00:00.000Z"),
    });
    expect(outcomes[0].status).toBe("refused");
    expect(outcomes[0].reason).toContain("already arrived");
    expect(store.rows.size).toBe(0);
  });

  it("refuses a target date that is not after the as-of", async () => {
    const store = fakeStore();
    const backdated = record({ asOf: "2027-06-01T00:00:00.000Z", targetDate: "2027-01-15" });
    const outcomes = await savePredictions(store, [backdated], { now });
    expect(outcomes[0].status).toBe("refused");
    expect(outcomes[0].reason).toContain("is not after asOf");
  });

  it("reports a duplicate rather than overwriting it", async () => {
    const store = fakeStore();
    const row = record();
    await savePredictions(store, [row], { now });
    const second = await savePredictions(store, [row], { now });
    expect(second[0].status).toBe("duplicate");
    expect(second[0].reason).toContain("append-only");
    expect(store.rows.size).toBe(1);
  });

  it("refuses one bad record without discarding the rest of the batch", async () => {
    const store = fakeStore();
    const good = record({ ticker: "AAPL" });
    const bad = record({ ticker: "MSFT", asOf: "not-a-date" });
    const outcomes = await savePredictions(store, [bad, good], { now });
    expect(outcomes[0].status).toBe("refused");
    expect(outcomes[1].status).toBe("saved");
  });

  it("propagates an unexpected store failure rather than reporting a silent refusal", async () => {
    const store = fakeStore();
    store.create = async () => {
      throw new Error("firestore unavailable");
    };
    await expect(savePredictions(store, [record()], { now })).rejects.toThrow(
      "firestore unavailable"
    );
  });
});

describe("isMatured", () => {
  it("is false before the target date and true on it", () => {
    const row = record();
    expect(isMatured(row, new Date("2027-01-14T23:59:59.000Z"))).toBe(false);
    expect(isMatured(row, new Date("2027-01-15T00:00:00.000Z"))).toBe(true);
  });
});
