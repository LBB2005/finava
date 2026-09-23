// No Firebase, no network. The Firestore handle is injected on every call, and
// src/test/fakeFirestore.ts is WRAPPED (it has no runTransaction or batch) rather
// than modified, since it is shared with other suites.
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeFirestore } from "@/test/fakeFirestore";
import type {
  DecisionCacheKey,
  InvestmentReport,
  ResearchMandate,
  ResearchSnapshot,
} from "./contracts";
import type { EvidenceItem } from "./schemas";
import {
  EVIDENCE_CHUNKS,
  EVIDENCE_CHUNK_CHARS,
  OwnershipError,
  RunConflictError,
  RunNotFoundError,
  acquireStageLease,
  attachReport,
  cacheKeysMatch,
  cancelRun,
  chunkJson,
  commitStage,
  countUncertainAttempts,
  createRun,
  decisionCacheKeyHash,
  findReusableReport,
  hashMandate,
  isTerminal,
  nextStage,
  openAttempt,
  readAttempts,
  readReport,
  readRun,
  readSnapshot,
  readStageResult,
  releaseLease,
  reportRef,
  saveReport,
  saveSnapshot,
  settleAttempt,
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
  // Transactions are SERIALIZED. Real Firestore resolves this contention
  // optimistically (the loser re-reads and retries), and every transaction here
  // keeps its read and its write together, so both models give the same answer —
  // serializing just makes the concurrency assertions deterministic.
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
const OTHER = "user_b";

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

function evidence(id: string, excerpt: string): EvidenceItem {
  return {
    id,
    ticker: "AAPL",
    kind: "filing",
    source: "sec",
    url: null,
    publishedAt: "2026-08-01T00:00:00Z",
    observedAt: "2026-09-22T00:00:00Z",
    period: "FY2026",
    contentHash: `h_${id}`,
    excerpt,
    standing: "clean",
  };
}

function snapshotFixture(overrides: Partial<ResearchSnapshot> = {}): ResearchSnapshot {
  return {
    id: "snap_1",
    ownerUid: UID,
    ticker: "AAPL",
    asOf: "2026-09-22T00:00:00Z",
    mandate: MANDATE,
    evidence: [evidence("e1", "short excerpt")],
    gaps: [],
    coverage: { fcff_dcf: 0.9 },
    contentHash: "snapshot_hash_1",
    createdAt: "2026-09-22T00:00:00Z",
    ...overrides,
  };
}

function reportFixture(overrides: Partial<InvestmentReport> = {}): InvestmentReport {
  return {
    id: "rep_1",
    ownerUid: UID,
    snapshotId: "snap_1",
    ticker: "AAPL",
    status: "complete",
    rating: "watch",
    reasonCodes: ["below_return_hurdle"],
    hurdle: 0.1,
    experimental: true,
    valuation: {
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
    },
    scenarios: null,
    weights: {
      values: { bear: 0.25, base: 0.5, bull: 0.25 },
      basis: "fixed_prior",
      model: null,
      calibrationVersion: null,
    },
    returns: {
      cumulative: 0.08,
      annualizedWealthEquivalent: 0.08,
      bearScenarioLoss: 0.2,
      scenarioReturns: { bear: -0.2, base: 0.1, bull: 0.3 },
    },
    buckets: { boundaries: [-0.1, 0.1] },
    claims: [],
    dissent: [],
    probabilityBasis: "fixed_prior",
    versions: {
      policyVersion: "policy_1",
      valuationVersion: "val_1",
      questionSetVersion: null,
      agentVersion: "agent_1",
    },
    costUsd: 0.42,
    completedAt: "2026-09-22T01:00:00Z",
    ...overrides,
  };
}

function cacheKey(overrides: Partial<DecisionCacheKey> = {}): DecisionCacheKey {
  return {
    ticker: "AAPL",
    horizonCount: 12,
    horizonUnit: "calendar_months",
    snapshotHash: "snapshot_hash_1",
    mandateHash: hashMandate(MANDATE),
    policyVersion: "policy_1",
    valuationVersion: "val_1",
    questionSetVersion: null,
    agentVersion: "agent_1",
    ownerUid: UID,
    ...overrides,
  };
}

let fake: ReturnType<typeof makeDb>;
let seq: number;
const deps = () => ({ db: fake.db, now: () => new Date("2026-09-22T10:00:00Z"), newId: () => `id_${++seq}` });

beforeEach(() => {
  fake = makeDb();
  seq = 0;
});

describe("createRun", () => {
  it("starts at the first stage, pending, with nothing spent", async () => {
    const { run, created } = await createRun(UID, MANDATE, null, deps());
    expect(created).toBe(true);
    expect(run).toMatchObject({
      ownerUid: UID,
      stage: "snapshot",
      status: "pending",
      creditsSpent: 0,
      leaseUntil: null,
      reportId: null,
      supersedes: null,
    });
  });

  it("returns the SAME run for a repeated uid + idempotencyKey", async () => {
    const first = await createRun(UID, MANDATE, "key-1", deps());
    const second = await createRun(UID, MANDATE, "key-1", deps());
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    const runDocs = [...fake.docs.keys()].filter((k) => k.includes("/investmentRuns/"));
    expect(runDocs).toHaveLength(1);
  });

  it("refuses a reused key that carries a different mandate", async () => {
    await createRun(UID, MANDATE, "key-1", deps());
    await expect(
      createRun(UID, { ...MANDATE, ticker: "MSFT" }, "key-1", deps())
    ).rejects.toBeInstanceOf(RunConflictError);
  });

  it("does not let two users collide on the same key", async () => {
    const mine = await createRun(UID, MANDATE, "key-1", deps());
    const theirs = await createRun(OTHER, { ...MANDATE, ownerUid: OTHER } as ResearchMandate, "key-1", deps());
    expect(theirs.run.id).not.toBe(mine.run.id);
    expect(theirs.run.ownerUid).toBe(OTHER);
  });

  it("records the run it refreshes instead of mutating that run's report", async () => {
    const prior = await createRun(UID, MANDATE, null, deps());
    const refresh = await createRun(UID, MANDATE, null, { ...deps(), supersedes: prior.run.id });
    expect(refresh.run.supersedes).toBe(prior.run.id);
    expect(refresh.run.id).not.toBe(prior.run.id);
  });
});

describe("readRun", () => {
  it("404s a run id that belongs to another account", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    // The other user's tree simply does not contain it. Answering 403 would confirm
    // the id exists, which is the disclosure the path scoping exists to prevent.
    await expect(readRun(OTHER, run.id, deps())).rejects.toBeInstanceOf(RunNotFoundError);
  });

  it("403s a document whose stored ownerUid disagrees with the path", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    fake.docs.set(`users/${UID}/investmentRuns/${run.id}`, {
      ...(fake.docs.get(`users/${UID}/investmentRuns/${run.id}`) as Data),
      ownerUid: OTHER,
    });
    await expect(readRun(UID, run.id, deps())).rejects.toBeInstanceOf(OwnershipError);
  });

  it("rejects an id that would address a different collection", async () => {
    await expect(readRun(UID, "../../user_b/investmentRuns/x", deps())).rejects.toBeInstanceOf(
      RunNotFoundError
    );
  });

  it("404s a run that was never created", async () => {
    await expect(readRun(UID, "missing", deps())).rejects.toBeInstanceOf(RunNotFoundError);
  });
});

describe("cancelRun", () => {
  it("marks the run cancelled but leaves the lease alone", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    await acquireStageLease(UID, run.id, deps());
    const cancelled = await cancelRun(UID, run.id, deps());
    expect(cancelled.status).toBe("cancelled");
    // Clearing the lease would let a third request start the paid stage that is
    // still executing somewhere else.
    expect(fake.docs.get(`users/${UID}/investmentRuns/${run.id}`)?.leaseUntil).toBeTruthy();
  });

  it("is idempotent", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    await cancelRun(UID, run.id, deps());
    await expect(cancelRun(UID, run.id, deps())).resolves.toMatchObject({ status: "cancelled" });
  });

  it("refuses to relabel a completed run", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    await attachReport(UID, run.id, "rep_1", "complete", deps());
    await expect(cancelRun(UID, run.id, deps())).rejects.toBeInstanceOf(RunConflictError);
  });

  it("denies cancelling another account's run", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    await expect(cancelRun(OTHER, run.id, deps())).rejects.toBeInstanceOf(RunNotFoundError);
  });
});

describe("acquireStageLease", () => {
  it("gives the lease to exactly one of two concurrent callers", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    const [a, b] = await Promise.all([
      acquireStageLease(UID, run.id, deps()),
      acquireStageLease(UID, run.id, deps()),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["acquired", "held"]);
  });

  it("re-acquires once the lease has expired", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    await acquireStageLease(UID, run.id, { ...deps(), leaseMs: 1000 });
    const later = await acquireStageLease(UID, run.id, {
      ...deps(),
      now: () => new Date("2026-09-22T10:05:00Z"),
    });
    expect(later.kind).toBe("acquired");
  });

  it("returns the stored result instead of the lease when the stage is already done", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    fake.docs.set(`users/${UID}/investmentRuns/${run.id}/stageResults/snapshot`, {
      stage: "snapshot",
      result: { snapshotId: "snap_1" },
      credits: 11,
      completedAt: "2026-09-22T09:00:00Z",
    });
    const outcome = await acquireStageLease(UID, run.id, deps());
    expect(outcome.kind).toBe("replay");
  });

  it("refuses a cancelled run", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    await cancelRun(UID, run.id, deps());
    expect((await acquireStageLease(UID, run.id, deps())).kind).toBe("terminal");
  });
});

describe("commitStage", () => {
  it("stores the result and advances the pointer atomically", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    const out = await commitStage(
      UID,
      run.id,
      { stage: "snapshot", result: { snapshotId: "snap_1" }, credits: 5, nextStage: "research", status: "paused", gaps: ["sec.revenue: rate_limited"] },
      deps()
    );
    expect(out.committed).toBe(true);
    expect(out.run).toMatchObject({ stage: "research", status: "paused", leaseUntil: null });
    expect(await readStageResult(UID, run.id, "snapshot", deps())).toMatchObject({ credits: 5 });
  });

  it("deduplicates gaps rather than letting them pile up on a replay", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    const commit = { stage: "snapshot" as const, result: {}, credits: 0, nextStage: "research" as const, status: "paused" as const, gaps: ["sec.revenue: rate_limited"] };
    await commitStage(UID, run.id, commit, deps());
    const second = await commitStage(UID, run.id, commit, deps());
    expect(second.run.gaps).toEqual(["sec.revenue: rate_limited"]);
  });

  it("keeps a cancelled run cancelled but still stores the work that was paid for", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    await cancelRun(UID, run.id, deps());
    const out = await commitStage(
      UID,
      run.id,
      { stage: "snapshot", result: { snapshotId: "snap_1" }, credits: 7, nextStage: "research", status: "paused" },
      deps()
    );
    expect(out.committed).toBe(false);
    expect(out.run.status).toBe("cancelled");
    expect(await readStageResult(UID, run.id, "snapshot", deps())).toMatchObject({ credits: 7 });
    expect(fake.docs.get(`users/${UID}/investmentRuns/${run.id}`)?.stage).toBe("snapshot");
  });

  it("preserves the original completion time on a replay", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    await commitStage(
      UID,
      run.id,
      { stage: "snapshot", result: {}, credits: 1, nextStage: "research", status: "paused", completedAt: "2026-09-22T08:00:00Z" },
      deps()
    );
    expect((await readStageResult(UID, run.id, "snapshot", deps()))?.completedAt).toBe(
      "2026-09-22T08:00:00Z"
    );
  });
});

describe("releaseLease", () => {
  it("pauses rather than claiming the run is still progressing", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    await acquireStageLease(UID, run.id, deps());
    const released = await releaseLease(UID, run.id, { status: "paused", error: "timeout" }, deps());
    expect(released).toMatchObject({ status: "paused", leaseUntil: null, error: "timeout" });
  });

  it("does not revive a run that was cancelled mid-stage", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    await acquireStageLease(UID, run.id, deps());
    await cancelRun(UID, run.id, deps());
    const released = await releaseLease(UID, run.id, { status: "paused" }, deps());
    expect(released.status).toBe("cancelled");
  });
});

describe("attempt log", () => {
  it("records an attempt before the stage runs and settles it afterwards", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    const attempt = await openAttempt(UID, run.id, "research", deps());
    expect(attempt.outcome).toBe("in_flight");
    await settleAttempt(UID, run.id, attempt.id, "committed", "", deps());
    expect((await readAttempts(UID, run.id, deps()))[0].outcome).toBe("committed");
  });

  it("counts unconfirmable outcomes per stage", async () => {
    const { run } = await createRun(UID, MANDATE, null, deps());
    for (const stage of ["research", "research", "valuation"] as const) {
      const a = await openAttempt(UID, run.id, stage, deps());
      await settleAttempt(UID, run.id, a.id, "uncertain", "provider timed out", deps());
    }
    expect(await countUncertainAttempts(UID, run.id, "research", deps())).toBe(2);
    expect(await countUncertainAttempts(UID, run.id, "valuation", deps())).toBe(1);
    expect(await countUncertainAttempts(UID, run.id, "decision", deps())).toBe(0);
  });
});

describe("snapshots", () => {
  it("chunks long evidence instead of writing one oversized document", async () => {
    const long = "x".repeat(EVIDENCE_CHUNK_CHARS - 500);
    const snapshot = snapshotFixture({
      evidence: [evidence("e1", long), evidence("e2", long), evidence("e3", long)],
    });
    await saveSnapshot(UID, snapshot, deps());

    const chunkPaths = [...fake.docs.keys()].filter((k) => k.includes(`/${EVIDENCE_CHUNKS}/`));
    expect(chunkPaths.length).toBeGreaterThan(1);
    for (const path of chunkPaths) {
      expect(String(fake.docs.get(path)?.text ?? "").length).toBeLessThanOrEqual(
        EVIDENCE_CHUNK_CHARS
      );
    }
    // The snapshot document itself carries no evidence, which is what keeps it
    // under Firestore's 1 MiB ceiling however long the excerpts get.
    expect(fake.docs.get(`users/${UID}/investmentSnapshots/snap_1`)?.evidence).toBeUndefined();
  });

  it("round-trips a chunked snapshot exactly", async () => {
    const long = "y".repeat(EVIDENCE_CHUNK_CHARS + 17);
    const snapshot = snapshotFixture({ evidence: [evidence("e1", long)] });
    await saveSnapshot(UID, snapshot, deps());
    const read = await readSnapshot(UID, "snap_1", deps());
    expect(read?.evidence).toEqual(snapshot.evidence);
    expect(read?.contentHash).toBe(snapshot.contentHash);
  });

  it("refuses to overwrite a frozen snapshot", async () => {
    await saveSnapshot(UID, snapshotFixture(), deps());
    await expect(saveSnapshot(UID, snapshotFixture(), deps())).rejects.toBeInstanceOf(
      RunConflictError
    );
  });

  it("refuses to write a snapshot attributed to someone else", async () => {
    await expect(
      saveSnapshot(UID, snapshotFixture({ ownerUid: OTHER }), deps())
    ).rejects.toBeInstanceOf(OwnershipError);
  });

  it("returns null for a snapshot that does not exist", async () => {
    expect(await readSnapshot(UID, "nope", deps())).toBeNull();
  });

  it("chunks nothing for empty text", () => {
    expect(chunkJson("")).toEqual([]);
    expect(() => chunkJson("abc", 0)).toThrow(RangeError);
  });
});

describe("reports", () => {
  it("writes a report and its reuse pointer", async () => {
    await saveReport(UID, reportFixture(), cacheKey(), deps());
    expect(await readReport(UID, "rep_1", deps())).toMatchObject({ rating: "watch" });
    expect(reportRef(UID, "rep_1")).toBe("users/user_a/investmentReports/rep_1");
  });

  it("refuses to overwrite a published report", async () => {
    await saveReport(UID, reportFixture(), cacheKey(), deps());
    await expect(
      saveReport(UID, reportFixture({ rating: "buy" }), cacheKey(), deps())
    ).rejects.toBeInstanceOf(RunConflictError);
  });

  it("reuses a report that answers exactly the same question", async () => {
    await saveReport(UID, reportFixture(), cacheKey(), deps());
    expect(await findReusableReport(UID, cacheKey(), deps())).toMatchObject({ id: "rep_1" });
  });

  it.each([
    ["the policy version", { policyVersion: "policy_2" }],
    ["the valuation version", { valuationVersion: "val_2" }],
    ["the question-set version", { questionSetVersion: "q_1" }],
    ["the agent version", { agentVersion: "agent_2" }],
    ["the snapshot hash", { snapshotHash: "other_hash" }],
    ["the mandate hash", { mandateHash: "other_mandate" }],
    ["the horizon count", { horizonCount: 24 }],
    ["the horizon unit", { horizonUnit: "trading_days" }],
    ["the ticker", { ticker: "MSFT" }],
  ])("invalidates reuse when %s differs", async (_label, diff) => {
    await saveReport(UID, reportFixture(), cacheKey(), deps());
    expect(await findReusableReport(UID, cacheKey(diff), deps())).toBeNull();
  });

  it("never serves another owner's report through a key", async () => {
    await expect(findReusableReport(UID, cacheKey({ ownerUid: OTHER }), deps())).rejects.toBeInstanceOf(
      OwnershipError
    );
  });

  it("ignores a pointer whose stored key no longer matches field for field", async () => {
    await saveReport(UID, reportFixture(), cacheKey(), deps());
    const pointerPath = `users/${UID}/investmentReportKeys/${decisionCacheKeyHash(cacheKey())}`;
    const pointer = fake.docs.get(pointerPath) as Data;
    fake.docs.set(pointerPath, {
      ...pointer,
      key: { ...(pointer.key as Data), policyVersion: "policy_99" },
    });
    expect(await findReusableReport(UID, cacheKey(), deps())).toBeNull();
  });

  it("403s a report filed under one owner but attributed to another", async () => {
    await saveReport(UID, reportFixture(), cacheKey(), deps());
    fake.docs.set(`users/${UID}/investmentReports/rep_1`, {
      ...(fake.docs.get(`users/${UID}/investmentReports/rep_1`) as Data),
      ownerUid: OTHER,
    });
    await expect(readReport(UID, "rep_1", deps())).rejects.toBeInstanceOf(OwnershipError);
  });
});

describe("cache key comparison", () => {
  it("matches an identical key", () => {
    expect(cacheKeysMatch(cacheKey(), cacheKey())).toBe(true);
  });

  it("rejects a key differing in any single field", () => {
    expect(cacheKeysMatch(cacheKey(), cacheKey({ agentVersion: "agent_2" }))).toBe(false);
  });

  it("hashes a key stably and distinctly", () => {
    expect(decisionCacheKeyHash(cacheKey())).toBe(decisionCacheKeyHash(cacheKey()));
    expect(decisionCacheKeyHash(cacheKey())).not.toBe(
      decisionCacheKeyHash(cacheKey({ policyVersion: "policy_2" }))
    );
  });
});

describe("mandate hashing", () => {
  it("does not depend on key order", () => {
    const reordered = {
      qualitativeCriteria: [],
      hardFilter: null,
      universeVersion: MANDATE.universeVersion,
      benchmark: MANDATE.benchmark,
      horizon: MANDATE.horizon,
      ticker: MANDATE.ticker,
      query: MANDATE.query,
      mode: MANDATE.mode,
    } as ResearchMandate;
    expect(hashMandate(reordered)).toBe(hashMandate(MANDATE));
  });

  it("changes when the horizon changes", () => {
    expect(
      hashMandate({ ...MANDATE, horizon: { ...MANDATE.horizon, count: 24 } })
    ).not.toBe(hashMandate(MANDATE));
  });
});

describe("stage sequencing", () => {
  it("walks the stages and stops at complete", () => {
    expect(nextStage("snapshot")).toBe("research");
    expect(nextStage("decision")).toBe("complete");
    expect(nextStage("complete")).toBe("complete");
  });

  it("treats cancelled, failed and complete as terminal", () => {
    expect(["complete", "cancelled", "failed"].every((s) => isTerminal(s as never))).toBe(true);
    expect(["pending", "running", "paused"].some((s) => isTerminal(s as never))).toBe(false);
  });
});
