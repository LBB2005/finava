// Persistence for investment research runs.
//
// This module owns every byte of a run: the run document itself, each bounded
// stage's stored result, the attempt log, the frozen snapshot, and the finished
// report. runner.ts orchestrates; nothing else writes these paths.
//
// Three rules shape the whole file, and each of them exists because of a
// specific way this feature can lose money or lie to the user.
//
// OWNERSHIP IS A PATH, NOT A FILTER. Everything lives under
// `users/{uid}/…`, so a query can never be written that forgets a `where
// ownerUid ==` clause. The `ownerUid` field is still stored and still checked on
// every read — see assertOwner — but as an assertion that the tree is intact,
// not as the security boundary. A tenant-isolation bug in this feature would
// leak a private research mandate, which is the most sensitive thing the app
// holds about a user.
//
// FINISHED WORK IS IMMUTABLE. A snapshot is the frozen information set a report
// was produced from, and a report is a dated opinion. Overwriting either would
// silently revise history: the same report id would answer a different question
// than the one the user read, and an evaluation harness comparing predictions to
// outcomes would be scoring a document that changed after the fact. A refresh
// therefore creates a NEW run whose `supersedes` points at the old one, and
// saveSnapshot/saveReport refuse to write over an existing id.
//
// PAID WORK IS PERSISTED BEFORE IT IS ACKNOWLEDGED. A stage result is committed
// in the same transaction that advances the run pointer, so there is no window in
// which the caller has been told a stage finished but the result is not durable.
// Replaying a stage whose result is already stored returns that result instead of
// paying for it again.
//
// The Firestore handle is INJECTED (see StoreDeps). firebase-admin validates
// server credentials at module load, so importing it eagerly would make this
// module untestable without real Firebase env; it is resolved lazily and only
// when no handle was supplied.

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { isSafeDocId } from "@/lib/docId";
import {
  InvestmentReportSchema,
  InvestmentRunSchema,
  RUN_STAGES,
  ResearchSnapshotSchema,
  RunStageSchema,
  RunStatusSchema,
  type DecisionCacheKey,
  type InvestmentReport,
  type InvestmentRun,
  type ResearchMandate,
  type ResearchSnapshot,
  type RunStage,
  type RunStatus,
} from "./contracts";
import type { EvidenceItem } from "./schemas";

// ── The Firestore surface this module actually uses ──────────────────────────
//
// Declared structurally rather than imported from firebase-admin so a test can
// pass an in-memory fake and this file never reaches the network. Only the
// operations below are permitted: no collection-group reads (they would escape
// the owner subtree) and no `where` filters (see OWNERSHIP IS A PATH above).

export interface DocSnapshotLike {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface DocRefLike {
  readonly id: string;
  readonly path: string;
  collection(name: string): CollectionRefLike;
  get(): Promise<DocSnapshotLike>;
  set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<unknown>;
}

export interface CollectionRefLike {
  doc(id: string): DocRefLike;
  get(): Promise<{ readonly docs: readonly DocSnapshotLike[] }>;
}

export interface TransactionLike {
  get(ref: DocRefLike): Promise<DocSnapshotLike>;
  set(ref: DocRefLike, data: Record<string, unknown>, options?: { merge?: boolean }): unknown;
}

export interface WriteBatchLike {
  set(ref: DocRefLike, data: Record<string, unknown>, options?: { merge?: boolean }): unknown;
  delete(ref: DocRefLike): unknown;
  commit(): Promise<unknown>;
}

export interface FirestoreLike {
  collection(name: string): CollectionRefLike;
  batch(): WriteBatchLike;
  runTransaction<T>(fn: (tx: TransactionLike) => Promise<T>): Promise<T>;
}

/** Injected clock and Firestore. Every exported function takes these. */
export interface StoreDeps {
  db?: FirestoreLike;
  /** Injected so lease expiry and `updatedAt` are testable without real time. */
  now?: () => Date;
  /** Injected so run/snapshot/report ids are deterministic in tests. */
  newId?: () => string;
}

let cachedDb: FirestoreLike | null = null;

/**
 * The real Firestore, resolved on first use.
 *
 * The cast is the one place this module admits firebase-admin's types exist. It
 * is deliberate and local: the Admin SDK's Transaction.get is overloaded for
 * queries and aggregations we never call, and widening FirestoreLike to match
 * those overloads would mean a test fake had to implement them too.
 */
export async function resolveDb(injected?: FirestoreLike): Promise<FirestoreLike> {
  if (injected) return injected;
  if (!cachedDb) {
    const mod = await import("@/lib/firebase-admin");
    cachedDb = mod.db as unknown as FirestoreLike;
  }
  return cachedDb;
}

/** Test seam: drop the memoized handle so a later call re-resolves. */
export function __resetStoreDb(): void {
  cachedDb = null;
}

// ── Collection names ─────────────────────────────────────────────────────────

export const RUNS = "investmentRuns";
/** idempotency-key pointers. A pointer doc avoids a `where` query, and with it an index. */
export const RUN_KEYS = "investmentRunKeys";
export const SNAPSHOTS = "investmentSnapshots";
export const REPORTS = "investmentReports";
/** DecisionCacheKey pointers, for reuse lookups. Same reason as RUN_KEYS. */
export const REPORT_KEYS = "investmentReportKeys";
/** Subcollection of a run: one document per completed stage. */
export const STAGE_RESULTS = "stageResults";
/** Subcollection of a run: the attempt log, including UNCERTAIN attempts. */
export const STAGE_ATTEMPTS = "stageAttempts";

/**
 * Subcollection of a snapshot holding chunked evidence JSON.
 *
 * Named specifically, for the same reason live/ledgerCollections.ts names
 * TRANSCRIPT_CHUNKS specifically: a single-field index exemption in
 * firestore.indexes.json keys on the COLLECTION GROUP, so a generic "chunks"
 * would apply the exemption to every subcollection of that name in the database.
 * Without the exemption a long excerpt eventually exceeds Firestore's
 * index-entry size limit and the write is rejected.
 */
export const EVIDENCE_CHUNKS = "investmentEvidenceChunks";

/**
 * Characters per evidence chunk.
 *
 * Firestore refuses any document over 1 MiB, and a UTF-8 character can take four
 * bytes, so 200k characters is at most ~800 KB — inside the ceiling with room for
 * the wrapper fields. The same figure live/transcripts.ts arrived at after a
 * 1,051,317-byte write was rejected and discarded an eleven-minute paid step.
 */
export const EVIDENCE_CHUNK_CHARS = 200_000;

// ── Errors ───────────────────────────────────────────────────────────────────

/** The stored ownerUid disagrees with the caller. Routes map this to 403. */
export class OwnershipError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} does not belong to this user`);
    this.name = "OwnershipError";
  }
}

/** No such run in the caller's tree. Routes map this to 404. */
export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} not found`);
    this.name = "RunNotFoundError";
  }
}

/** The request contradicts durable state. Routes map this to 409. */
export class RunConflictError extends Error {
  constructor(
    readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "RunConflictError";
  }
}

// ── Paths ────────────────────────────────────────────────────────────────────

function userDoc(db: FirestoreLike, uid: string): DocRefLike {
  // uid comes from a verified ID token, but an unchecked uid would still be a
  // path-injection sink if that ever stopped being true (see docId.ts).
  if (!isSafeDocId(uid)) throw new OwnershipError(uid);
  return db.collection("users").doc(uid);
}

export function runDoc(db: FirestoreLike, uid: string, runId: string): DocRefLike {
  if (!isSafeDocId(runId)) throw new RunNotFoundError(runId);
  return userDoc(db, uid).collection(RUNS).doc(runId);
}

function stageResultDoc(db: FirestoreLike, uid: string, runId: string, stage: RunStage): DocRefLike {
  return runDoc(db, uid, runId).collection(STAGE_RESULTS).doc(stage);
}

// ── Hashing ──────────────────────────────────────────────────────────────────

/**
 * Key order must not change a hash, or an idempotent retry that serialized its
 * JSON differently would create a second paid run.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Identity of the question a run was asked. Changing any field is a new question. */
export function hashMandate(mandate: ResearchMandate): string {
  return sha256(stableStringify(mandate));
}

/**
 * Pointer id for an idempotency key.
 *
 * Hashed because the key is caller-supplied and a raw value containing "/" would
 * address a different collection (docId.ts). Salted with the uid so two users
 * choosing the same key never collide, even though the pointer already lives in
 * the caller's subtree.
 */
export function idempotencyDocId(uid: string, key: string): string {
  return sha256(`${uid}\u0000${key}`);
}

// ── DecisionCacheKey ─────────────────────────────────────────────────────────

/**
 * Every field of DecisionCacheKey, enumerated.
 *
 * The mapped type is the point: adding a field to the contract and forgetting it
 * here is a COMPILE error rather than a silent reuse bug. Silent reuse is the bad
 * failure — a valuation-semantics change that does not invalidate the cache
 * re-serves yesterday's rating under today's rules, and nothing in the UI would
 * show that the number was computed by code that no longer exists.
 */
const CACHE_KEY_FIELDS: { readonly [K in keyof DecisionCacheKey]: true } = {
  ticker: true,
  horizonCount: true,
  horizonUnit: true,
  snapshotHash: true,
  mandateHash: true,
  policyVersion: true,
  valuationVersion: true,
  questionSetVersion: true,
  agentVersion: true,
  ownerUid: true,
};

/** Fixed order, so the hash is stable across deploys. */
export const DECISION_CACHE_KEY_FIELDS = (
  Object.keys(CACHE_KEY_FIELDS) as (keyof DecisionCacheKey)[]
).sort();

const DecisionCacheKeySchema: z.ZodType<DecisionCacheKey> = z.object({
  ticker: z.string(),
  horizonCount: z.number(),
  horizonUnit: z.string(),
  snapshotHash: z.string(),
  mandateHash: z.string(),
  policyVersion: z.string(),
  valuationVersion: z.string(),
  questionSetVersion: z.string().nullable(),
  agentVersion: z.string(),
  ownerUid: z.string(),
});

/** Pure. Every field must match exactly — no coercion, no "close enough". */
export function cacheKeysMatch(a: DecisionCacheKey, b: DecisionCacheKey): boolean {
  return DECISION_CACHE_KEY_FIELDS.every((field) => a[field] === b[field]);
}

export function decisionCacheKeyHash(key: DecisionCacheKey): string {
  const canonical = DECISION_CACHE_KEY_FIELDS.map((f) => `${f}=${String(key[f])}`).join("\u0000");
  return sha256(canonical);
}

// ── Reading and validating a run ─────────────────────────────────────────────

/** The run pointer's next stage. `complete` is terminal and maps to itself. */
export function nextStage(stage: RunStage): RunStage {
  const i = RUN_STAGES.indexOf(stage);
  if (i < 0 || i >= RUN_STAGES.length - 1) return "complete";
  return RUN_STAGES[i + 1];
}

/** True when nothing further will ever be advanced on this run. */
export function isTerminal(status: RunStatus): boolean {
  return status === "complete" || status === "cancelled" || status === "failed";
}

function assertOwner(uid: string, runId: string, data: Record<string, unknown>): void {
  if (data.ownerUid !== uid) throw new OwnershipError(runId);
}

/**
 * Parse a stored run, checking ownership first.
 *
 * Ownership is checked BEFORE validation so a misfiled document is reported as a
 * 403 rather than as a corrupt-data 500 — the caller learns it may not have this
 * run, and learns nothing about what the run contains.
 */
function parseRun(uid: string, runId: string, snap: DocSnapshotLike): InvestmentRun {
  const data = snap.data();
  if (!snap.exists || !data) throw new RunNotFoundError(runId);
  assertOwner(uid, runId, data);
  return InvestmentRunSchema.parse({ ...data, creditsSpent: Number(data.creditsSpent ?? 0) });
}

export async function readRun(
  uid: string,
  runId: string,
  deps: StoreDeps = {}
): Promise<InvestmentRun> {
  const db = await resolveDb(deps.db);
  return parseRun(uid, runId, await runDoc(db, uid, runId).get());
}

// ── Creating a run ───────────────────────────────────────────────────────────

export interface CreateRunOptions extends StoreDeps {
  /** The run this one refreshes. The prior run's report is never mutated. */
  supersedes?: string | null;
}

export interface CreateRunResult {
  run: InvestmentRun;
  /** False when an idempotency key matched an existing run. */
  created: boolean;
}

/**
 * Create a run, or return the one an earlier identical request already created.
 *
 * The idempotency check reads a POINTER document rather than querying runs by
 * key: a query would need a composite index, and worse, it would be eventually
 * consistent with the write that created the run — so two retries arriving
 * together could both miss and both create a paid run. The pointer is written in
 * the same transaction as the run, so the second caller either sees both or
 * neither.
 *
 * A key that matches but whose MANDATE differs is a conflict, not a hit.
 * Returning the stored run would answer a question the caller did not ask, and
 * the caller would have no way to tell.
 */
export async function createRun(
  uid: string,
  mandate: ResearchMandate,
  idempotencyKey: string | null = null,
  opts: CreateRunOptions = {}
): Promise<CreateRunResult> {
  const db = await resolveDb(opts.db);
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const newId = opts.newId ?? (() => randomUUID());
  const mandateHash = hashMandate(mandate);

  const draft = (id: string): InvestmentRun => ({
    id,
    ownerUid: uid,
    mandate,
    stage: "snapshot",
    status: "pending",
    snapshotId: null,
    reportId: null,
    idempotencyKey,
    leaseUntil: null,
    gaps: [],
    creditsSpent: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
    supersedes: opts.supersedes ?? null,
  });

  if (!idempotencyKey) {
    // Random id, deliberately. The Finava Live harness keys runs by trading day
    // because there is exactly one book per day; research runs are user-initiated
    // and several can legitimately exist for the same ticker on the same day, so a
    // date-derived id would make two distinct questions collide.
    const run = draft(newId());
    await runDoc(db, uid, run.id).set({ ...run });
    return { run, created: true };
  }

  const keyDoc = userDoc(db, uid).collection(RUN_KEYS).doc(idempotencyDocId(uid, idempotencyKey));

  return db.runTransaction(async (tx) => {
    const keySnap = await tx.get(keyDoc);
    const existingId = keySnap.exists ? String(keySnap.data()?.runId ?? "") : "";

    if (existingId) {
      const existing = parseRun(uid, existingId, await tx.get(runDoc(db, uid, existingId)));
      if (hashMandate(existing.mandate) !== mandateHash) {
        throw new RunConflictError(
          "idempotency_key_reused",
          "That idempotency key already belongs to a run with a different mandate"
        );
      }
      return { run: existing, created: false };
    }

    const run = draft(newId());
    tx.set(runDoc(db, uid, run.id), { ...run });
    tx.set(keyDoc, { runId: run.id, mandateHash, createdAt: now });
    return { run, created: true };
  });
}

// ── Cancelling ───────────────────────────────────────────────────────────────

/**
 * Mark a run cancelled so no further stage starts.
 *
 * `leaseUntil` is deliberately NOT cleared. A stage may be in flight in another
 * invocation, and clearing the lease would let a third caller start the same
 * paid stage while the first is still running. The lease expires on its own; the
 * status check refuses long before that.
 *
 * Idempotent for an already-cancelled run. A COMPLETE run is refused: it owns an
 * immutable report, and relabelling it cancelled would misdescribe a document the
 * user has already read.
 */
export async function cancelRun(
  uid: string,
  runId: string,
  deps: StoreDeps = {}
): Promise<InvestmentRun> {
  const db = await resolveDb(deps.db);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const ref = runDoc(db, uid, runId);

  return db.runTransaction(async (tx) => {
    const run = parseRun(uid, runId, await tx.get(ref));
    if (run.status === "cancelled") return run;
    if (run.status === "complete") {
      throw new RunConflictError("already_complete", "A completed run cannot be cancelled");
    }
    const updated: InvestmentRun = { ...run, status: "cancelled", updatedAt: now };
    tx.set(ref, { status: "cancelled", updatedAt: now }, { merge: true });
    return updated;
  });
}

// ── Stage results ────────────────────────────────────────────────────────────

/**
 * One completed stage, stored in its own document.
 *
 * `result` is `unknown` on purpose: this module must not know the stage payload
 * shapes, or adding a stage would mean editing persistence. runner.ts validates
 * each payload against its contract schema when it reads one back, which is where
 * the knowledge belongs.
 */
export const StoredStageResultSchema = z.object({
  stage: RunStageSchema,
  result: z.unknown(),
  /** MEASURED credits, as reported by the stage. Never an estimate. */
  credits: z.number().min(0),
  completedAt: z.string().min(1),
});
export type StoredStageResult = z.infer<typeof StoredStageResultSchema>;

/** A stage's stored result, or null when it has not completed. */
export async function readStageResult(
  uid: string,
  runId: string,
  stage: RunStage,
  deps: StoreDeps = {}
): Promise<StoredStageResult | null> {
  const db = await resolveDb(deps.db);
  const snap = await stageResultDoc(db, uid, runId, stage).get();
  if (!snap.exists) return null;
  return StoredStageResultSchema.parse(snap.data());
}

// ── Leases ───────────────────────────────────────────────────────────────────

/**
 * How long a lease is held.
 *
 * Longer than the longest stage, so a stage that is still running never has its
 * work duplicated; short enough that a crashed invocation does not wedge the run
 * for the user's whole session.
 */
export const LEASE_MS = 120_000;

export type LeaseOutcome =
  /** This caller owns the stage. It is the only one that may spend money on it. */
  | { kind: "acquired"; run: InvestmentRun; stage: RunStage; leaseUntil: string }
  /** Already paid for. Return it; do not re-run it. */
  | { kind: "replay"; run: InvestmentRun; stage: RunStage; stored: StoredStageResult }
  /** Someone else holds the lease. Not an error — the work is happening. */
  | { kind: "held"; run: InvestmentRun; leaseUntil: string }
  /** Cancelled, failed or complete. Nothing further will run. */
  | { kind: "terminal"; run: InvestmentRun };

/**
 * Take the lease on the run's current stage, in one transaction.
 *
 * Read and write are inside the SAME transaction, which is what makes the "only
 * one caller executes a stage" claim true. Two callers arriving together are
 * resolved by Firestore: the loser re-reads, sees the lease, and returns `held`.
 * If the check were a read followed by a separate write, both would pass it and
 * the user would be billed twice for one stage.
 *
 * A stage whose result is already stored short-circuits to `replay` BEFORE the
 * lease is considered, because there is nothing left to protect.
 */
export async function acquireStageLease(
  uid: string,
  runId: string,
  deps: StoreDeps & { leaseMs?: number } = {}
): Promise<LeaseOutcome> {
  const db = await resolveDb(deps.db);
  const clock = deps.now ?? (() => new Date());
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  const ref = runDoc(db, uid, runId);

  return db.runTransaction(async (tx) => {
    const run = parseRun(uid, runId, await tx.get(ref));
    if (isTerminal(run.status) || run.stage === "complete") return { kind: "terminal", run };

    const storedSnap = await tx.get(stageResultDoc(db, uid, runId, run.stage));
    if (storedSnap.exists) {
      return {
        kind: "replay",
        run,
        stage: run.stage,
        stored: StoredStageResultSchema.parse(storedSnap.data()),
      };
    }

    const nowMs = clock().getTime();
    if (run.leaseUntil && Date.parse(run.leaseUntil) > nowMs) {
      return { kind: "held", run, leaseUntil: run.leaseUntil };
    }

    const leaseUntil = new Date(nowMs + leaseMs).toISOString();
    const updatedAt = new Date(nowMs).toISOString();
    tx.set(ref, { leaseUntil, status: "running", updatedAt, error: null }, { merge: true });
    return {
      kind: "acquired",
      run: { ...run, leaseUntil, status: "running", updatedAt, error: null },
      stage: run.stage,
      leaseUntil,
    };
  });
}

/**
 * Release a lease without advancing the run.
 *
 * `paused` is the honest status here: no runner is working on this run, and the
 * architecture provides no background worker that will pick it up. Saying
 * "running" would promise progress that will never happen unless the user's next
 * request causes it.
 */
export async function releaseLease(
  uid: string,
  runId: string,
  outcome: { status: Extract<RunStatus, "paused" | "failed">; error?: string | null },
  deps: StoreDeps = {}
): Promise<InvestmentRun> {
  const db = await resolveDb(deps.db);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const ref = runDoc(db, uid, runId);

  return db.runTransaction(async (tx) => {
    const run = parseRun(uid, runId, await tx.get(ref));
    // A cancel that landed mid-stage wins. Reviving the run to `paused` would
    // let the very next request start another paid stage on it.
    const status: RunStatus = run.status === "cancelled" ? "cancelled" : outcome.status;
    const patch = { leaseUntil: null, status, error: outcome.error ?? null, updatedAt: now };
    tx.set(ref, patch, { merge: true });
    return { ...run, ...patch };
  });
}

export interface StageCommit {
  stage: RunStage;
  result: unknown;
  credits: number;
  /** Where the run points next. Usually nextStage(stage). */
  nextStage: RunStage;
  status: RunStatus;
  /** Appended to the run's gaps, deduplicated. Gaps are never dropped. */
  gaps?: readonly string[];
  snapshotId?: string | null;
  reportId?: string | null;
  /**
   * Preserves the original completion instant when a replay re-commits a stored
   * result. Without it a replay would stamp a new time onto work that was done
   * earlier, and the attempt log would disagree with the stage record.
   */
  completedAt?: string;
}

export interface StageCommitResult {
  run: InvestmentRun;
  /** False when the run was cancelled mid-stage: the result is stored, the pointer is not moved. */
  committed: boolean;
  stored: StoredStageResult;
}

/**
 * Store a stage result and move the run pointer, atomically.
 *
 * Both writes are in one transaction so the acknowledgement the caller receives
 * is never ahead of durability: there is no state in which the HTTP response said
 * "snapshot done" and a later request re-runs the snapshot.
 *
 * CANCELLATION IS CHECKED HERE, immediately before the commit. If the run was
 * cancelled while the stage was in flight, the result is still written — the
 * money was already spent and discarding the output would waste it — but the
 * pointer and status are left alone, so the cancellation stands and nothing else
 * starts.
 */
export async function commitStage(
  uid: string,
  runId: string,
  commit: StageCommit,
  deps: StoreDeps = {}
): Promise<StageCommitResult> {
  const db = await resolveDb(deps.db);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const ref = runDoc(db, uid, runId);
  const stored: StoredStageResult = {
    stage: commit.stage,
    result: commit.result,
    credits: commit.credits,
    completedAt: commit.completedAt ?? now,
  };

  return db.runTransaction(async (tx) => {
    const run = parseRun(uid, runId, await tx.get(ref));
    tx.set(stageResultDoc(db, uid, runId, commit.stage), { ...stored });

    if (run.status === "cancelled") return { run, committed: false, stored };

    const gaps = [...new Set([...run.gaps, ...(commit.gaps ?? [])])];
    const patch = {
      stage: commit.nextStage,
      status: commit.status,
      leaseUntil: null,
      gaps,
      error: null,
      updatedAt: now,
      snapshotId: commit.snapshotId ?? run.snapshotId,
      reportId: commit.reportId ?? run.reportId,
    };
    tx.set(ref, patch, { merge: true });
    return { run: { ...run, ...patch }, committed: true, stored };
  });
}

// ── Attempt log ──────────────────────────────────────────────────────────────

export const AttemptOutcomeSchema = z.enum([
  /** Started, outcome not yet known. What a crashed invocation leaves behind. */
  "in_flight",
  "committed",
  /**
   * The stage threw after it may already have called a paid provider. We do not
   * know whether the vendor billed us, and we will not pretend otherwise.
   */
  "uncertain",
]);
export type AttemptOutcome = z.infer<typeof AttemptOutcomeSchema>;

export const StageAttemptSchema = z.object({
  id: z.string().min(1),
  stage: RunStageSchema,
  outcome: AttemptOutcomeSchema,
  detail: z.string(),
  startedAt: z.string().min(1),
  settledAt: z.string().nullable(),
});
export type StageAttempt = z.infer<typeof StageAttemptSchema>;

/** Begin an attempt record. Written BEFORE the stage runs, so a crash leaves a trace. */
export async function openAttempt(
  uid: string,
  runId: string,
  stage: RunStage,
  deps: StoreDeps = {}
): Promise<StageAttempt> {
  const db = await resolveDb(deps.db);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const id = `${stage}-${(deps.newId ?? (() => randomUUID()))()}`;
  const attempt: StageAttempt = {
    id,
    stage,
    outcome: "in_flight",
    detail: "",
    startedAt: now,
    settledAt: null,
  };
  await runDoc(db, uid, runId).collection(STAGE_ATTEMPTS).doc(id).set({ ...attempt });
  return attempt;
}

/** Settle an attempt. `uncertain` is a real outcome, not a failure to classify. */
export async function settleAttempt(
  uid: string,
  runId: string,
  attemptId: string,
  outcome: Exclude<AttemptOutcome, "in_flight">,
  detail = "",
  deps: StoreDeps = {}
): Promise<void> {
  const db = await resolveDb(deps.db);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  await runDoc(db, uid, runId)
    .collection(STAGE_ATTEMPTS)
    .doc(attemptId)
    .set({ outcome, detail, settledAt: now }, { merge: true });
}

/**
 * Every attempt on this run, newest last.
 *
 * Read as a whole subcollection and filtered in memory rather than with a `where`
 * clause: the list is bounded by MAX_UNCERTAIN_ATTEMPTS times the stage count, so
 * the read is cheap, and a filtered ordered query would need a composite index
 * this feature does not otherwise require.
 */
export async function readAttempts(
  uid: string,
  runId: string,
  deps: StoreDeps = {}
): Promise<StageAttempt[]> {
  const db = await resolveDb(deps.db);
  const snap = await runDoc(db, uid, runId).collection(STAGE_ATTEMPTS).get();
  return snap.docs
    .map((d) => StageAttemptSchema.parse(d.data()))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** How many times this stage has ended in an outcome we could not confirm. */
export async function countUncertainAttempts(
  uid: string,
  runId: string,
  stage: RunStage,
  deps: StoreDeps = {}
): Promise<number> {
  const attempts = await readAttempts(uid, runId, deps);
  return attempts.filter((a) => a.stage === stage && a.outcome === "uncertain").length;
}

// ── Snapshots ────────────────────────────────────────────────────────────────

/** Pure. Empty text stores no chunks at all. */
export function chunkJson(text: string, size: number = EVIDENCE_CHUNK_CHARS): string[] {
  if (size <= 0) throw new RangeError("chunk size must be positive");
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Zero-padded so lexicographic document-id order IS chunk order past chunk 9. */
function chunkDocId(n: number): string {
  return String(n).padStart(4, "0");
}

export const SNAPSHOT_META_FIELDS = ["chunks", "chars"] as const;

/**
 * Freeze a snapshot.
 *
 * `evidence` is stored as chunked JSON in a subcollection, NOT on the snapshot
 * document. Evidence excerpts are the only unbounded thing a run produces, and a
 * single document holding a full filing's excerpts crosses Firestore's 1 MiB
 * ceiling — at which point the write is rejected and the paid work that produced
 * it is lost.
 *
 * Refuses to overwrite. A snapshot is what a report was computed from; replacing
 * it would leave a published report describing evidence it never saw.
 */
export async function saveSnapshot(
  uid: string,
  snapshot: ResearchSnapshot,
  deps: StoreDeps = {}
): Promise<ResearchSnapshot> {
  const db = await resolveDb(deps.db);
  const validated = ResearchSnapshotSchema.parse(snapshot);
  if (validated.ownerUid !== uid) throw new OwnershipError(validated.id);

  const ref = userDoc(db, uid).collection(SNAPSHOTS).doc(validated.id);
  if ((await ref.get()).exists) {
    throw new RunConflictError("snapshot_immutable", `Snapshot ${validated.id} already exists`);
  }

  const { evidence, ...meta } = validated;
  const chunks = chunkJson(JSON.stringify(evidence));
  const batch = db.batch();
  batch.set(ref, { ...meta, chunks: chunks.length, chars: JSON.stringify(evidence).length });
  chunks.forEach((text, n) => {
    batch.set(ref.collection(EVIDENCE_CHUNKS).doc(chunkDocId(n)), { n, text });
  });
  await batch.commit();
  return validated;
}

/** Reassemble a snapshot, or null when none was written at `id`. */
export async function readSnapshot(
  uid: string,
  snapshotId: string,
  deps: StoreDeps = {}
): Promise<ResearchSnapshot | null> {
  const db = await resolveDb(deps.db);
  if (!isSafeDocId(snapshotId)) return null;
  const ref = userDoc(db, uid).collection(SNAPSHOTS).doc(snapshotId);
  const snap = await ref.get();
  const data = snap.data();
  if (!snap.exists || !data) return null;
  if (data.ownerUid !== uid) throw new OwnershipError(snapshotId);

  const chunks = await ref.collection(EVIDENCE_CHUNKS).get();
  const json = [...chunks.docs]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((d) => String(d.data()?.text ?? ""))
    .join("");
  const evidence = json ? (JSON.parse(json) as EvidenceItem[]) : [];

  // Validated on the way out as well as in: the chunks are reassembled from
  // several documents, and a partial read must fail loudly rather than produce a
  // snapshot missing half its evidence.
  return ResearchSnapshotSchema.parse({ ...data, chunks: undefined, chars: undefined, evidence });
}

// ── Reports ──────────────────────────────────────────────────────────────────

/**
 * Persist a finished report and the pointer that makes it reusable.
 *
 * Refuses to overwrite: a report is a dated opinion, and every later evaluation
 * of this system's calibration depends on the document not changing after the
 * prediction was made. A refresh writes a NEW report under a new run.
 */
export async function saveReport(
  uid: string,
  report: InvestmentReport,
  key: DecisionCacheKey,
  deps: StoreDeps = {}
): Promise<InvestmentReport> {
  const db = await resolveDb(deps.db);
  const validated = InvestmentReportSchema.parse(report);
  if (validated.ownerUid !== uid) throw new OwnershipError(validated.id);
  if (key.ownerUid !== uid) throw new OwnershipError(validated.id);

  const ref = userDoc(db, uid).collection(REPORTS).doc(validated.id);
  if ((await ref.get()).exists) {
    throw new RunConflictError("report_immutable", `Report ${validated.id} already exists`);
  }

  const batch = db.batch();
  batch.set(ref, { ...validated });
  // The full key is stored beside the pointer, not just its hash, so
  // findReusableReport can verify field by field instead of trusting a digest.
  batch.set(userDoc(db, uid).collection(REPORT_KEYS).doc(decisionCacheKeyHash(key)), {
    reportId: validated.id,
    key: { ...key },
    createdAt: validated.completedAt ?? new Date().toISOString(),
  });
  await batch.commit();
  return validated;
}

export async function readReport(
  uid: string,
  reportId: string,
  deps: StoreDeps = {}
): Promise<InvestmentReport | null> {
  const db = await resolveDb(deps.db);
  if (!isSafeDocId(reportId)) return null;
  const snap = await userDoc(db, uid).collection(REPORTS).doc(reportId).get();
  const data = snap.data();
  if (!snap.exists || !data) return null;
  if (data.ownerUid !== uid) throw new OwnershipError(reportId);
  return InvestmentReportSchema.parse(data);
}

/** The stored reference form, as the API returns it. */
export function reportRef(uid: string, reportId: string): string {
  return `users/${uid}/${REPORTS}/${reportId}`;
}

/**
 * A stored report that answers EXACTLY this question, or null.
 *
 * Two independent checks, both required. The hash pointer finds a candidate; the
 * field-by-field comparison confirms it, so a hash collision or a pointer left
 * behind by an older key format cannot serve a report computed under different
 * versions. Any version mismatch — policy, valuation, question set, agent — makes
 * this return null, and the caller pays for a fresh run.
 */
export async function findReusableReport(
  uid: string,
  key: DecisionCacheKey,
  deps: StoreDeps = {}
): Promise<InvestmentReport | null> {
  const db = await resolveDb(deps.db);
  if (key.ownerUid !== uid) throw new OwnershipError(key.ticker);

  const pointer = await userDoc(db, uid).collection(REPORT_KEYS).doc(decisionCacheKeyHash(key)).get();
  const data = pointer.data();
  if (!pointer.exists || !data) return null;

  const stored = DecisionCacheKeySchema.safeParse(data.key);
  if (!stored.success || !cacheKeysMatch(stored.data, key)) return null;

  const reportId = String(data.reportId ?? "");
  return reportId ? readReport(uid, reportId, deps) : null;
}

/**
 * Attach a run to the report it produced.
 *
 * The run document is mutable working state — it carries the stage pointer and
 * the lease — so pointing it at an immutable report is not a revision of the
 * report. The status values that may be set here are terminal only.
 */
export async function attachReport(
  uid: string,
  runId: string,
  reportId: string,
  status: Extract<RunStatus, "complete" | "failed">,
  deps: StoreDeps = {}
): Promise<InvestmentRun> {
  const db = await resolveDb(deps.db);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const ref = runDoc(db, uid, runId);
  return db.runTransaction(async (tx) => {
    const run = parseRun(uid, runId, await tx.get(ref));
    const patch = { reportId, status, stage: "complete" as RunStage, leaseUntil: null, updatedAt: now };
    tx.set(ref, patch, { merge: true });
    return { ...run, ...patch };
  });
}

/** Re-export for consumers that only import this module. */
export { RunStatusSchema, RunStageSchema };
