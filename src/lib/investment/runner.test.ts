// End-to-end over the REAL store with an injected fake Firestore and fake stages.
// No Firebase, no network, no provider keys. The fake stages are spies, so "did
// this spend money again?" is an assertion rather than an inference.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeFirestore } from "@/test/fakeFirestore";
import type { ResearchMandate, ValuationOutcome } from "./contracts";
import type { EvidenceItem } from "./schemas";
import { MAX_UNCERTAIN_ATTEMPTS, advanceRun, buildCacheKey, loadStages, registerStages } from "./runner";
import type {
  DecisionStageResult,
  ReportVersions,
  ResearchStageResult,
  RunnerStages,
  ScenarioStageResult,
  SnapshotDraft,
  StageEnvelope,
} from "./runner";
import {
  cancelRun,
  createRun,
  findReusableReport,
  readAttempts,
  readReport,
  readRun,
  readSnapshot,
  type FirestoreLike,
} from "./store";

type Data = Record<string, unknown>;

function makeDb() {
  const base = createFakeFirestore();
  const { docs } = base;
  const write = (ref: { path: string }, data: Data, o?: { merge?: boolean }) => {
    const prev = o?.merge ? (docs.get(ref.path) ?? {}) : {};
    docs.set(ref.path, structuredClone({ ...prev, ...data }));
  };
  const snapOf = (path: string) => {
    const d = docs.get(path);
    return {
      id: path.split("/").at(-1) ?? path,
      exists: d !== undefined,
      data: () => (d ? structuredClone(d) : undefined),
    };
  };
  // Serialized transactions. Firestore resolves the same contention optimistically;
  // the lease keeps its read and write in one transaction, so both models agree and
  // this one makes the concurrency assertion deterministic.
  let chain: Promise<unknown> = Promise.resolve();
  const db = {
    collection: base.db.collection,
    batch() {
      const ops: Array<() => void> = [];
      return {
        set: (r: { path: string }, d: Data, o?: { merge?: boolean }) => ops.push(() => write(r, d, o)),
        delete: (r: { path: string }) => ops.push(() => docs.delete(r.path)),
        commit: async () => ops.forEach((op) => op()),
      };
    },
    runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        const writes: Array<() => void> = [];
        const out = await fn({
          get: async (r: { path: string }) => snapOf(r.path),
          set: (r: { path: string }, d: Data, o?: { merge?: boolean }) =>
            writes.push(() => write(r, d, o)),
        });
        writes.forEach((w) => w());
        return out;
      };
      const next = chain.then(run, run);
      chain = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    },
  };
  return { db: db as unknown as FirestoreLike, docs };
}

const UID = "user_a";
const AS_OF = "2026-09-22T00:00:00Z";

const MANDATE: ResearchMandate = {
  mode: "analyze",
  query: "Is AAPL worth owning for a year?",
  ticker: "AAPL",
  horizon: {
    count: 12,
    unit: "calendar_months",
    assumed: false,
    targetDate: "2027-09-22",
    yearFraction: 1,
    note: null,
  },
  benchmark: "SPY",
  universeVersion: "universe_2026_09",
  hardFilter: null,
  qualitativeCriteria: [],
};

const EVIDENCE: EvidenceItem = {
  id: "e1",
  ticker: "AAPL",
  kind: "filing",
  source: "sec",
  url: null,
  publishedAt: "2026-08-01T00:00:00Z",
  observedAt: AS_OF,
  period: "FY2026",
  contentHash: "h_e1",
  excerpt: "Revenue grew 6% year over year.",
  standing: "clean",
};

const VALUATION: ValuationOutcome = {
  method: "fcff_dcf",
  gaps: [],
  scenarios: [
    {
      id: "base",
      priceAtHorizon: 220,
      distributionsPerShare: 1,
      assumptionsRef: "assump_1",
      method: "fcff_dcf",
      evidenceIds: ["e1"],
    },
  ],
  proxies: [],
  criticalCoverage: 0.9,
  valuationVersion: "val_1",
  priceAtAsOf: 200,
};

const SCENARIOS: ScenarioStageResult = {
  scenarios: VALUATION.scenarios,
  weights: {
    values: { bear: 0.25, base: 0.5, bull: 0.25 },
    basis: "fixed_prior",
    model: null,
    calibrationVersion: null,
  },
  buckets: { boundaries: [-0.1, 0.1] },
  probabilityBasis: "fixed_prior",
  questionSetVersion: null,
};

const DECISION: DecisionStageResult = {
  rating: "watch",
  status: "partial",
  reasonCodes: ["experimental_scenario_weights"],
  hurdle: 0.1,
  experimental: true,
  returns: {
    cumulative: 0.08,
    annualizedWealthEquivalent: 0.08,
    bearScenarioLoss: 0.2,
    scenarioReturns: { bear: -0.2, base: 0.1, bull: 0.3 },
  },
};

const VERSIONS: ReportVersions = {
  policyVersion: "policy_1",
  valuationVersion: "val_1",
  questionSetVersion: null,
  agentVersion: "agent_1",
};

const DRAFT: SnapshotDraft = {
  ticker: "AAPL",
  asOf: AS_OF,
  mandate: MANDATE,
  evidence: [EVIDENCE],
  gaps: [{ source: "finnhub", field: "priceTarget", reason: "unauthorized", detail: "premium" }],
  coverage: { fcff_dcf: 0.9 },
  contentHash: "snapshot_hash_1",
};

function env<T>(result: T, credits = 10): StageEnvelope<T> {
  return { result, credits };
}

function makeStages(overrides: Partial<RunnerStages> = {}) {
  // Spies, so "did this spend money again?" is an assertion. Kept out of the
  // spread below so the mock types survive for `.mock.calls`.
  const spies = {
    snapshot: vi.fn(async () => env<SnapshotDraft>(DRAFT, 12)),
    research: vi.fn(async () =>
      env<ResearchStageResult>({ claims: [], dissent: ["valuation disputed"] }, 20)
    ),
    valuation: vi.fn(async () => env<ValuationOutcome>(VALUATION, 5)),
    scenarios: vi.fn(async () => env<ScenarioStageResult>(SCENARIOS, 30)),
    decision: vi.fn(async () => env<DecisionStageResult>(DECISION, 1)),
    versions: vi.fn(() => VERSIONS),
  };
  return { ...spies, ...overrides } as unknown as RunnerStages & typeof spies;
}

let fake: ReturnType<typeof makeDb>;
let seq: number;

function deps(stages: RunnerStages, extra: Record<string, unknown> = {}) {
  return {
    db: fake.db,
    now: () => new Date("2026-09-22T10:00:00Z"),
    newId: () => `id_${++seq}`,
    caps: { run: 10_000, day: 100_000 },
    stages,
    ...extra,
  };
}

beforeEach(() => {
  fake = makeDb();
  seq = 0;
  registerStages(null);
});

describe("advancing a run to completion", () => {
  it("runs one stage per request and pauses between them", async () => {
    const stages = makeStages();
    const { run } = await createRun(UID, MANDATE, null, { db: fake.db, newId: () => "run_1" });

    const first = await advanceRun(UID, run.id, deps(stages));
    expect(first.kind).toBe("advanced");
    // PAUSED, not running. No background worker exists, and saying "running" would
    // promise progress that only another request can produce.
    expect(first.kind === "advanced" && first.run.status).toBe("paused");
    expect(first.kind === "advanced" && first.run.stage).toBe("research");
    expect(stages.research).not.toHaveBeenCalled();

    for (let stage = 0; stage < 3; stage++) {
      expect((await advanceRun(UID, run.id, deps(stages))).kind).toBe("advanced");
    }

    const last = await advanceRun(UID, run.id, deps(stages));
    expect(last.kind).toBe("advanced");
    const final = await readRun(UID, run.id, { db: fake.db });
    expect(final).toMatchObject({ stage: "complete", status: "complete" });
    expect(final.reportId).toBeTruthy();

    const report = await readReport(UID, final.reportId!, { db: fake.db });
    expect(report).toMatchObject({ rating: "watch", status: "partial", ticker: "AAPL" });
    // Measured spend only: 12 + 20 + 5 + 30 + 1 credits.
    expect(report?.costUsd).toBeGreaterThan(0);
    expect(report?.priceAtAsOf).toBe(200);

    // A further advance has nothing to do and spends nothing.
    expect((await advanceRun(UID, run.id, deps(stages))).kind).toBe("complete");
    expect(stages.decision).toHaveBeenCalledTimes(1);
  });

  it("mints the snapshot's identity itself, so no stage can attribute one elsewhere", async () => {
    const stages = makeStages();
    const { run } = await createRun(UID, MANDATE, null, { db: fake.db, newId: () => "run_1" });
    await advanceRun(UID, run.id, deps(stages));

    const stored = await readRun(UID, run.id, { db: fake.db });
    const snapshot = await readSnapshot(UID, stored.snapshotId!, { db: fake.db });
    expect(snapshot?.ownerUid).toBe(UID);
    expect(snapshot?.evidence).toEqual([EVIDENCE]);
    // Source gaps reach the run, where the UI can show what was missing.
    expect(stored.gaps).toContain("finnhub.priceTarget: unauthorized");
  });

  it("gives each stage the run's single as-of cutoff and an abort signal", async () => {
    const stages = makeStages();
    const { run } = await createRun(UID, MANDATE, null, { db: fake.db, newId: () => "run_1" });
    await advanceRun(UID, run.id, deps(stages));
    await advanceRun(UID, run.id, deps(stages));

    const [ctx] = stages.research.mock.calls[0] as unknown as [
      { asOf: string; signal: AbortSignal; uid: string },
    ];
    expect(ctx.asOf).toBe(AS_OF);
    expect(ctx.uid).toBe(UID);
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
  });

  it("writes a reuse pointer that the cache key finds", async () => {
    const stages = makeStages();
    const { run } = await createRun(UID, MANDATE, null, { db: fake.db, newId: () => "run_1" });
    for (let i = 0; i < 5; i++) await advanceRun(UID, run.id, deps(stages));

    const stored = await readRun(UID, run.id, { db: fake.db });
    const snapshot = await readSnapshot(UID, stored.snapshotId!, { db: fake.db });
    const key = buildCacheKey(UID, snapshot!, MANDATE, VERSIONS);
    expect(await findReusableReport(UID, key, { db: fake.db })).toMatchObject({ id: stored.reportId });
    // Any version change invalidates it, so a policy edit cannot re-serve an old rating.
    expect(
      await findReusableReport(UID, { ...key, policyVersion: "policy_2" }, { db: fake.db })
    ).toBeNull();
  });
});

describe("concurrency", () => {
  it("lets only one concurrent caller execute a stage", async () => {
    const stages = makeStages();
    const { run } = await createRun(UID, MANDATE, null, { db: fake.db, newId: () => "run_1" });

    const [a, b] = await Promise.all([
      advanceRun(UID, run.id, deps(stages)),
      advanceRun(UID, run.id, deps(stages)),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["advanced", "lease_held"]);
    // The load-bearing assertion: the paid stage ran exactly once.
    expect(stages.snapshot).toHaveBeenCalledTimes(1);
  });

  it("returns a stored stage result without repeating the provider call", async () => {
    const stages = makeStages();
    const { run } = await createRun(UID, MANDATE, null, { db: fake.db, newId: () => "run_1" });

    // A stage whose result landed but whose pointer move was lost — the crash
    // window this design has to survive without paying twice.
    fake.docs.set(`users/${UID}/investmentRuns/${run.id}/stageResults/snapshot`, {
      stage: "snapshot",
      result: { snapshotId: "snap_x", asOf: AS_OF, contentHash: "snapshot_hash_1" },
      credits: 12,
      completedAt: "2026-09-22T09:00:00Z",
    });

    const outcome = await advanceRun(UID, run.id, deps(stages));
    expect(outcome.kind).toBe("replayed");
    expect(stages.snapshot).not.toHaveBeenCalled();
    expect(outcome.kind === "replayed" && outcome.result).toMatchObject({ snapshotId: "snap_x" });
    // Nothing was charged for work that was already paid for.
    expect(fake.docs.get(`users/${UID}/investmentRuns/${run.id}`)?.creditsSpent ?? 0).toBe(0);
    expect(outcome.kind === "replayed" && outcome.run.stage).toBe("research");
  });
});

describe("cancellation", () => {
  it("starts no further work on a cancelled run", async () => {
    const stages = makeStages();
    const { run } = await createRun(UID, MANDATE, null, { db: fake.db, newId: () => "run_1" });
    await cancelRun(UID, run.id, { db: fake.db });

    const outcome = await advanceRun(UID, run.id, deps(stages));
    expect(outcome.kind).toBe("cancelled");
    expect(stages.snapshot).not.toHaveBeenCalled();
  });

  it("does not advance a run cancelled while a stage was in flight", async () => {
    let cancelDuringStage: () => Promise<unknown> = async () => undefined;
    const stages = makeStages({
      snapshot: vi.fn(async () => {
        await cancelDuringStage();
        return env<SnapshotDraft>(DRAFT, 12);
      }) as unknown as RunnerStages["snapshot"],
    });
    const { run } = await createRun(UID, MANDATE, null, { db: fake.db, newId: () => "run_1" });
    cancelDuringStage = () => cancelRun(UID, run.id, { db: fake.db });

    const outcome = await advanceRun(UID, run.id, deps(stages));
    expect(outcome.kind).toBe("cancelled");
    const stored = await readRun(UID, run.id, { db: fake.db });
    expect(stored).toMatchObject({ status: "cancelled", stage: "snapshot" });
    // The work was paid for, so it is kept — but it advances nothing.
    expect(
      fake.docs.get(`users/${UID}/investmentRuns/${run.id}/stageResults/snapshot`)
    ).toBeDefined();
  });
});

describe("budget", () => {
  it("refuses a stage BEFORE calling a provider when the run is out of budget", async () => {
    const stages = makeStages();
    const { run } = await createRun(UID, MANDATE, null, { db: fake.db, newId: () => "run_1" });
    fake.docs.set(`users/${UID}/investmentRuns/${run.id}`, {
      ...(fake.docs.get(`users/${UID}/investmentRuns/${run.id}`) as Data),
      creditsSpent: 500,
    });

    const outcome = await advanceRun(UID, run.id, deps(stages, { caps: { run: 500, day: 100_000 } }));
    expect(outcome.kind).toBe("budget_exceeded");
    expect(stages.snapshot).not.toHaveBeenCalled();
    expect(outcome.kind === "budget_exceeded" && outcome.run.status).toBe("paused");
  });

  it("still caps an ADMIN uid, because this ceiling never consults the allowlist", async () => {
    vi.stubEnv("ADMIN_UIDS", UID);
    vi.stubEnv("OWNER_UIDS", UID);
    vi.stubEnv("INVESTMENT_RUN_CREDIT_CAP", "10");
    vi.stubEnv("INVESTMENT_DAILY_CREDIT_CAP", "100000");

    const stages = makeStages();
    const { run } = await createRun(UID, MANDATE, null, { db: fake.db, newId: () => "run_1" });
    // caps deliberately omitted so the env-resolved ceiling is exercised.
    const first = await advanceRun(UID, run.id, {
      db: fake.db,
      newId: () => `id_${++seq}`,
      stages,
    });
    // The snapshot stage measured 12 credits against a 10-credit ceiling: its result
    // is kept (the money is gone either way) and the run is paused, not failed.
    expect(first.kind).toBe("budget_exceeded");
    const second = await advanceRun(UID, run.id, { db: fake.db, newId: () => "x", stages });
    expect(second.kind).toBe("budget_exceeded");
    expect(stages.research).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });
});

describe("uncertain outcomes", () => {
  it("records an uncertain attempt rather than claiming the stage failed cleanly", async () => {
    const stages = makeStages({
      snapshot: vi.fn(async () => {
        throw new Error("provider timed out after the request was sent");
      }) as unknown as RunnerStages["snapshot"],
    });
    const { run } = await createRun(UID, MANDATE, null, { db: fake.db, newId: () => "run_1" });

    const outcome = await advanceRun(UID, run.id, deps(stages));
    expect(outcome.kind).toBe("uncertain");
    const attempts = await readAttempts(UID, run.id, { db: fake.db });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ stage: "snapshot", outcome: "uncertain" });
    // Paused, with the reason on the run. Not "failed": the vendor may have billed us.
    expect(outcome.kind === "uncertain" && outcome.run.status).toBe("paused");
  });

  it("stops retrying a stage that keeps ending unconfirmably", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("provider timed out");
    });
    const stages = makeStages({ snapshot: throwing as unknown as RunnerStages["snapshot"] });
    const { run } = await createRun(UID, MANDATE, null, { db: fake.db, newId: () => "run_1" });

    for (let i = 0; i < MAX_UNCERTAIN_ATTEMPTS; i++) {
      expect((await advanceRun(UID, run.id, deps(stages))).kind).toBe("uncertain");
    }
    const refused = await advanceRun(UID, run.id, deps(stages));
    expect(refused.kind).toBe("uncertain");
    // The cap is the point: each attempt may already have been billed, so "retry
    // until it works" has no upper bound on cost.
    expect(throwing).toHaveBeenCalledTimes(MAX_UNCERTAIN_ATTEMPTS);
  });
});

describe("loadStages", () => {
  it("degrades to null instead of throwing when the environment cannot build stages", async () => {
    // This used to assert an unwired null. loadStages now builds the production
    // stages via a lazy import, which needs provider and Firebase env this test
    // environment does not have. The point of the assertion is that a missing
    // credential surfaces as "stages not wired" — which /advance answers as 503 —
    // rather than throwing a 500 out of the route.
    await expect(loadStages()).resolves.toBeNull();
  });

  it("returns what was registered", async () => {
    const stages = makeStages();
    registerStages(stages);
    expect(await loadStages()).toBe(stages);
    registerStages(null);
  });
});
