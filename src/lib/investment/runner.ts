// The stage runner: advances an investment research run by exactly ONE stage.
//
// WHAT THIS ARCHITECTURE PROMISES, AND WHAT IT REFUSES TO PROMISE.
//
// One HTTP request advances one bounded stage and returns. There is no background
// worker. When a stage finishes, the run's status becomes `paused`, because that
// is the truth: nobody is working on it, and it will not progress until another
// request arrives. The tempting alternative — kick off the remaining stages after
// the response and tell the user it is "processing" — was rejected deliberately.
// Serverless invocations are frozen once the response is flushed, so the promised
// work would silently die mid-stage, after paying for part of it, with the run
// left saying `running` forever. A paused run that the UI can honestly label is
// worth more than a running one that is lying.
//
// STAGES ARE INJECTED. The snapshot, research, valuation, scenario and decision
// implementations are built independently; this file imports none of them. It
// defines the narrow interfaces they must satisfy (see RunnerStages) and wires
// persistence, leasing, budgeting, cancellation and report assembly around them.
// Tests pass fakes. That boundary is also a safety property: a stage receives a
// StageContext containing the uid, the mandate, the as-of cutoff and an
// AbortSignal — and no Firestore handle, so no stage can write outside the
// owner's tree or mutate a run pointer.
//
// EXACTLY-ONCE IS NOT CLAIMED FOR EXTERNAL BILLING. A lease makes it true that
// only one caller EXECUTES a stage, and a stored result makes it true that a
// completed stage is never paid for twice. But a stage that throws after calling a
// paid provider leaves an outcome nobody can observe: the vendor may or may not
// have billed us. That attempt is recorded as `uncertain` rather than retried
// silently, and the number of uncertain attempts per stage is capped — an
// unbounded retry on an unknown outcome is how a single failing provider turns
// into an open-ended bill.

import { randomUUID } from "node:crypto";
import { creditsToUsd } from "@/lib/plans";
import {
  InvestmentReportSchema,
  ResearchSnapshotSchema,
  ScenarioBucketsSchema,
  ValuationOutcomeSchema,
  type DecisionCacheKey,
  type InvestmentReport,
  type InvestmentRun,
  type ResearchMandate,
  type ResearchSnapshot,
  type RunStage,
  type ValuationOutcome,
} from "./contracts";
import {
  ProbabilityBasisSchema,
  RatingSchema,
  ReportStatusSchema,
  ResearchClaimSchema,
  ScenarioValueSchema,
  ScenarioWeightsSchema,
  ReturnEstimateSchema,
  type ProbabilityBasis,
  type Rating,
  type ReportStatus,
  type ResearchClaim,
  type ReturnEstimate,
  type ScenarioValue,
  type ScenarioWeights,
} from "./schemas";
import {
  BudgetExceededError,
  assertBudgetAvailable,
  chargeStage,
  type BudgetDeps,
} from "./runBudget";
import {
  acquireStageLease,
  commitStage,
  countUncertainAttempts,
  hashMandate,
  nextStage,
  openAttempt,
  readSnapshot,
  readStageResult,
  releaseLease,
  saveReport,
  saveSnapshot,
  settleAttempt,
  type StoreDeps,
  type StoredStageResult,
} from "./store";
import { z } from "zod";
import { logger } from "@/lib/logger";

// ── The injected stage interfaces ────────────────────────────────────────────
//
// These are the contract between this runner and the independently-built stages.
// Widening StageContext is a security decision, not a convenience: anything added
// here is handed to every stage.

/**
 * Everything a stage is given.
 *
 * Deliberately excludes any database handle. A stage computes and returns; the
 * runner alone decides what is persisted and where, which is what keeps tenant
 * isolation a property of one file rather than of five.
 */
export interface StageContext {
  readonly uid: string;
  readonly runId: string;
  readonly mandate: ResearchMandate;
  /**
   * The single cutoff every piece of evidence in this run is stamped against.
   * Minted once, by the snapshot stage, and read by all later stages — a stage
   * that resolved its own "now" could admit information the snapshot could not
   * have seen, which is how a backtest quietly acquires lookahead.
   */
  readonly asOf: string;
  /**
   * Aborted when the stage deadline elapses or the client disconnects. Pass it
   * to every fetch: a provider call still running after the response has gone is
   * spend nobody is waiting for.
   */
  readonly signal: AbortSignal;
}

/**
 * What every stage returns.
 *
 * `credits` is MEASURED spend — what the stage actually observed its providers
 * charge. A stage that cannot measure must report 0 and say so in `gaps`, never a
 * plausible estimate: an estimated cost that flows into the report's `costUsd`
 * would be indistinguishable from a real one.
 */
export interface StageEnvelope<T> {
  result: T;
  credits: number;
  /** Appended to the run's gaps. Surfaced to the user; never silently dropped. */
  gaps?: readonly string[];
}

/**
 * The snapshot stage returns everything EXCEPT the identity fields.
 *
 * `id`, `ownerUid` and `createdAt` are minted by the runner. A stage that could
 * set `ownerUid` could write a snapshot attributed to another user.
 */
export type SnapshotDraft = Omit<ResearchSnapshot, "id" | "ownerUid" | "createdAt">;

/** Stage 1. Freezes the information set, and mints the run's as-of cutoff. */
export type SnapshotStage = (
  ctx: Omit<StageContext, "asOf"> & { asOf: null }
) => Promise<StageEnvelope<SnapshotDraft>>;

export interface ResearchStageResult {
  claims: ResearchClaim[];
  /** Disagreements left unresolved. Kept, never smoothed away. */
  dissent: string[];
}

/** Stage 2. Turns frozen evidence into structured, attributed claims. */
export type ResearchStage = (
  ctx: StageContext,
  snapshot: ResearchSnapshot
) => Promise<StageEnvelope<ResearchStageResult>>;

/** Stage 3. Values the company from the snapshot, naming every missing input. */
export type ValuationStage = (
  ctx: StageContext,
  snapshot: ResearchSnapshot
) => Promise<StageEnvelope<ValuationOutcome>>;

export interface ScenarioStageResult {
  /** Null when gaps prevented scenario values. Never a placeholder. */
  scenarios: ScenarioValue[] | null;
  /** Null when no distribution was available. An equal-weight default is forbidden. */
  weights: ScenarioWeights | null;
  /** The bucket boundaries the probabilities were asked against. */
  buckets: { boundaries: [number, number] } | null;
  probabilityBasis: ProbabilityBasis;
  questionSetVersion: string | null;
}

/** Stage 4. Attaches probabilities to scenarios. */
export type ScenarioStage = (
  ctx: StageContext,
  snapshot: ResearchSnapshot,
  valuation: ValuationOutcome
) => Promise<StageEnvelope<ScenarioStageResult>>;

export interface DecisionStageInput {
  snapshot: ResearchSnapshot;
  research: ResearchStageResult;
  valuation: ValuationOutcome;
  scenarios: ScenarioStageResult;
}

export interface DecisionStageResult {
  rating: Rating;
  status: ReportStatus;
  reasonCodes: string[];
  /** The hurdle this horizon was judged against. Null when a gate blocked it. */
  hurdle: number | null;
  /** True while the rating rests on weights nothing has tested. */
  experimental: boolean;
  returns: ReturnEstimate | null;
}

/** Stage 5. Applies the rating policy. Deterministic; no model call. */
export type DecisionStage = (
  ctx: StageContext,
  input: DecisionStageInput
) => Promise<StageEnvelope<DecisionStageResult>>;

/** Version stamps for the report and the reuse key. Constant per deploy. */
export interface ReportVersions {
  policyVersion: string;
  valuationVersion: string;
  questionSetVersion: string | null;
  agentVersion: string;
}

/** The full set of injected dependencies the runner needs to execute a run. */
export interface RunnerStages {
  snapshot: SnapshotStage;
  research: ResearchStage;
  valuation: ValuationStage;
  scenarios: ScenarioStage;
  decision: DecisionStage;
  versions: () => ReportVersions;
  /** Mints snapshot and report ids. Injected so tests are deterministic. */
  newId?: () => string;
}

// ── Runner configuration ─────────────────────────────────────────────────────

/**
 * How long a single stage may run.
 *
 * Below the platform's function timeout, so the runner gets to release its lease
 * and record the attempt rather than being killed with the lease still held.
 */
export const STAGE_DEADLINE_MS = 50_000;

/**
 * How many times one stage may end in an outcome we could not confirm before the
 * run refuses to try it again.
 *
 * Two, not unbounded. Each uncertain attempt may already have been billed by a
 * provider, so "retry until it works" has no upper bound on cost, and the failure
 * mode that produces uncertainty — a timeout against a slow paid endpoint — is
 * exactly the one that repeats.
 */
export const MAX_UNCERTAIN_ATTEMPTS = 2;

/**
 * THE SINGLE WIRING POINT for the real stage implementations.
 *
 * The valuation, evidence and scenario stages are built independently of this
 * runner and are deliberately NOT imported here — this file knows only the
 * interfaces above. Until they are wired, loadStages returns null and the advance
 * route answers 503 rather than pretending a run can progress.
 *
 * `./stages` now supplies implementations of exactly these types via
 * `buildStages(collectors)`. Wiring is therefore a lazy dynamic import, kept lazy
 * so the valuation, evidence and Jev module graphs stay out of the cold start of
 * every route that never advances a run:
 *
 *   const { buildStages } = await import("./stages");
 *   return buildStages(await resolveCollectors());
 *
 * It is deliberately NOT done here yet. `StageCollectors` requires a provider
 * bundle (evidence collection, the research specialists, the valuation request
 * builder, optional Jev) that only the caller can choose, and the honest interim
 * behaviour is a 503 saying the stages are unconfigured rather than a run that
 * starts and cannot finish. Any adapter must satisfy exactly one of the stage
 * types above, including the measured-credits contract on StageEnvelope.
 */
let registeredStages: RunnerStages | null = null;

/** Test and bootstrap seam. Passing null restores the unwired state. */
export function registerStages(stages: RunnerStages | null): void {
  registeredStages = stages;
}

export async function loadStages(): Promise<RunnerStages | null> {
  if (registeredStages) return registeredStages;

  try {
    // Lazily imported so routes that never advance a run — create, read, cancel —
    // keep the provider and model graph out of their cold start.
    const [{ buildStages }, { productionCollectors }] = await Promise.all([
      import("./stages"),
      import("./stageCollectors"),
    ]);
    return buildStages(productionCollectors());
  } catch (err) {
    // A missing provider credential or an unset Firebase env must degrade to
    // "stages not wired", which the advance route answers as 503, rather than
    // throwing a 500 out of a route. Logged rather than swallowed, because a
    // misconfigured deploy that silently refuses every run is its own failure.
    logger("investment-runner").error("stages_unavailable", {
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface RunnerDeps extends StoreDeps, BudgetDeps {
  stages: RunnerStages;
  /** The request's signal, so a client disconnect stops provider calls. */
  signal?: AbortSignal;
  deadlineMs?: number;
  leaseMs?: number;
}

// ── Outcomes ─────────────────────────────────────────────────────────────────

export type AdvanceOutcome =
  /** The stage ran, was charged, and its result is durable. */
  | { kind: "advanced"; run: InvestmentRun; stage: RunStage; result: unknown; credits: number }
  /** Already done. The stored result is returned and nothing was paid for. */
  | { kind: "replayed"; run: InvestmentRun; stage: RunStage; result: unknown }
  /** Another invocation is executing this stage. Not an error. */
  | { kind: "lease_held"; run: InvestmentRun; leaseUntil: string }
  /** The run is cancelled. No further work will start. */
  | { kind: "cancelled"; run: InvestmentRun }
  /** Nothing left to advance. */
  | { kind: "complete"; run: InvestmentRun }
  /** The run failed terminally and will not be advanced again. */
  | { kind: "failed"; run: InvestmentRun }
  /** A ceiling was reached. The run is paused, not failed — money, not correctness. */
  | { kind: "budget_exceeded"; run: InvestmentRun; scope: string; spent: number; cap: number }
  /** The stage threw and we cannot say whether a provider billed us. */
  | { kind: "uncertain"; run: InvestmentRun; stage: RunStage; detail: string; attempts: number };

// ── Reading stage results back ───────────────────────────────────────────────
//
// Each payload is validated against its CONTRACT schema on the way back in, not
// merely cast. The documents were written by an earlier invocation and may have
// been written by an earlier DEPLOY; a shape that no longer parses must fail
// loudly rather than flow into a rating as undefined.

const ResearchStageResultSchema = z.object({
  claims: z.array(ResearchClaimSchema),
  dissent: z.array(z.string()),
});

const ScenarioStageResultSchema = z.object({
  scenarios: z.array(ScenarioValueSchema).nullable(),
  weights: ScenarioWeightsSchema.nullable(),
  buckets: ScenarioBucketsSchema.nullable(),
  probabilityBasis: ProbabilityBasisSchema,
  questionSetVersion: z.string().nullable(),
});

const DecisionStageResultSchema = z.object({
  rating: RatingSchema,
  status: ReportStatusSchema,
  reasonCodes: z.array(z.string()),
  hurdle: z.number().nullable(),
  experimental: z.boolean(),
  returns: ReturnEstimateSchema.nullable(),
});

async function requireStageResult<T>(
  uid: string,
  runId: string,
  stage: RunStage,
  schema: z.ZodType<T>,
  deps: StoreDeps
): Promise<T> {
  const stored = await readStageResult(uid, runId, stage, deps);
  if (!stored) {
    // The run pointer says this stage is done but its document is not there. That
    // is a corrupted run, not a recoverable state: re-running the stage would
    // spend money to fill a hole whose cause we do not understand.
    throw new Error(`stage "${stage}" has no stored result on run ${runId}`);
  }
  return schema.parse(stored.result);
}

// ── Cancellation and deadlines ───────────────────────────────────────────────

/**
 * One signal that aborts on the stage deadline OR on the caller's signal.
 *
 * Mid-stage cancellation from ANOTHER request is not observed here, and the
 * comment matters more than the code: polling Firestore during a stage would cost
 * a read per second per run for a race that resolves itself. Cancellation is
 * checked before the stage starts and again inside commitStage's transaction, so
 * a cancel that lands mid-stage cannot advance the run or start the next stage.
 * The signal exists for the deadline and for client disconnects.
 */
function stageSignal(deps: RunnerDeps): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("stage deadline elapsed")), deps.deadlineMs ?? STAGE_DEADLINE_MS);
  const onAbort = () => controller.abort(deps.signal?.reason);
  if (deps.signal?.aborted) controller.abort(deps.signal.reason);
  else deps.signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      deps.signal?.removeEventListener("abort", onAbort);
    },
  };
}

// ── Report assembly ──────────────────────────────────────────────────────────

/** Everything the reuse key needs, derived from server-side state only. */
export function buildCacheKey(
  uid: string,
  snapshot: ResearchSnapshot,
  mandate: ResearchMandate,
  versions: ReportVersions
): DecisionCacheKey {
  return {
    ticker: snapshot.ticker,
    horizonCount: mandate.horizon.count,
    horizonUnit: mandate.horizon.unit,
    snapshotHash: snapshot.contentHash,
    mandateHash: hashMandate(mandate),
    policyVersion: versions.policyVersion,
    valuationVersion: versions.valuationVersion,
    questionSetVersion: versions.questionSetVersion,
    agentVersion: versions.agentVersion,
    ownerUid: uid,
  };
}

/**
 * Compose the report from the persisted stage results.
 *
 * Assembled by the runner rather than by the decision stage so that every field
 * traces to a stage that produced it — the narrative cannot alter a number, and no
 * single stage can write the whole document.
 */
function assembleReport(args: {
  reportId: string;
  uid: string;
  snapshot: ResearchSnapshot;
  research: ResearchStageResult;
  valuation: ValuationOutcome;
  scenarios: ScenarioStageResult;
  decision: DecisionStageResult;
  versions: ReportVersions;
  creditsSpent: number;
  completedAt: string;
}): InvestmentReport {
  return InvestmentReportSchema.parse({
    id: args.reportId,
    ownerUid: args.uid,
    snapshotId: args.snapshot.id,
    ticker: args.snapshot.ticker,
    status: args.decision.status,
    rating: args.decision.rating,
    reasonCodes: args.decision.reasonCodes,
    hurdle: args.decision.hurdle,
    experimental: args.decision.experimental,
    valuation: ValuationOutcomeSchema.parse(args.valuation),
    scenarios: args.scenarios.scenarios,
    weights: args.scenarios.weights,
    returns: args.decision.returns,
    buckets: args.scenarios.buckets,
    claims: args.research.claims,
    dissent: args.research.dissent,
    probabilityBasis: args.scenarios.probabilityBasis,
    versions: {
      policyVersion: args.versions.policyVersion,
      valuationVersion: args.versions.valuationVersion,
      // The question set the SCENARIO stage actually used, which can differ from
      // the deploy's default if the stage fell back.
      questionSetVersion: args.scenarios.questionSetVersion ?? args.versions.questionSetVersion,
      agentVersion: args.versions.agentVersion,
    },
    // Derived from the credits this run measurably spent. Zero measured credits
    // means nothing reported a cost, which is reported as unknown rather than $0.
    costUsd: args.creditsSpent > 0 ? creditsToUsd(args.creditsSpent) : null,
    // Mirrored from the valuation, not re-fetched. Re-fetching would substitute
    // today's price for the one the scenarios were computed against, silently
    // changing every return in the report. `undefined` stays undefined: the
    // valuation producer recording no price is not the same as no price existing.
    priceAtAsOf: args.valuation.priceAtAsOf,
    completedAt: args.completedAt,
  });
}

// ── The one public entrypoint ────────────────────────────────────────────────

/**
 * Advance the run by exactly one stage.
 *
 * The order of operations is the whole design, and each step is placed where it is
 * because of what breaks otherwise:
 *
 *   1. Take the lease transactionally. Only the winner may spend money. A stage
 *      whose result already exists short-circuits to a replay and spends nothing.
 *   2. Check the budget BEFORE calling a provider. Post-hoc checking cannot
 *      prevent the spend it discovers.
 *   3. Refuse a stage that has already ended in too many unconfirmable outcomes.
 *   4. Open an attempt record BEFORE the stage runs, so a crashed invocation
 *      leaves evidence that it may have been billed.
 *   5. Run the stage under a deadline-and-disconnect signal.
 *   6. Persist the result and advance the pointer in ONE transaction, which
 *      re-checks cancellation. The caller is never told a stage completed before
 *      the result is durable.
 *   7. Charge the measured spend afterwards, because only now is it known.
 */
export async function advanceRun(
  uid: string,
  runId: string,
  deps: RunnerDeps
): Promise<AdvanceOutcome> {
  const lease = await acquireStageLease(uid, runId, deps);

  if (lease.kind === "terminal") {
    const { run } = lease;
    if (run.status === "cancelled") return { kind: "cancelled", run };
    if (run.status === "failed") return { kind: "failed", run };
    return { kind: "complete", run };
  }
  if (lease.kind === "held") return { kind: "lease_held", run: lease.run, leaseUntil: lease.leaseUntil };

  if (lease.kind === "replay") {
    // Paid for already. Re-commit the stored result byte-identically so the run
    // pointer moves on, then return it. No stage is called and nothing is charged.
    const committed = await recommit(uid, runId, lease.stage, lease.stored, deps);
    return { kind: "replayed", run: committed, stage: lease.stage, result: lease.stored.result };
  }

  const stage = lease.stage;

  try {
    await assertBudgetAvailable(uid, runId, stage, deps);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      const run = await releaseLease(uid, runId, { status: "paused", error: err.message }, deps);
      return { kind: "budget_exceeded", run, scope: err.scope, spent: err.spent, cap: err.cap };
    }
    throw err;
  }

  const priorUncertain = await countUncertainAttempts(uid, runId, stage, deps);
  if (priorUncertain >= MAX_UNCERTAIN_ATTEMPTS) {
    const detail = `stage "${stage}" ended in an unconfirmed outcome ${priorUncertain} times`;
    const run = await releaseLease(uid, runId, { status: "paused", error: detail }, deps);
    return { kind: "uncertain", run, stage, detail, attempts: priorUncertain };
  }

  const attempt = await openAttempt(uid, runId, stage, deps);
  const { signal, done } = stageSignal(deps);

  let envelope: StageEnvelope<unknown>;
  let commit: Awaited<ReturnType<typeof commitStage>>;
  try {
    const executed = await executeStage(uid, runId, stage, lease.run, signal, deps);
    envelope = executed.envelope;
    commit = await commitStage(uid, runId, executed.commit, deps);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // UNCERTAIN, not failed. The stage may have called a paid provider before it
    // threw, and we have no way to ask the vendor whether it billed us. Recording
    // it as a clean failure would let a retry loop spend indefinitely while the
    // ledger showed nothing was ever charged.
    await settleAttempt(uid, runId, attempt.id, "uncertain", detail, deps);
    const run = await releaseLease(uid, runId, { status: "paused", error: detail }, deps);
    return { kind: "uncertain", run, stage, detail, attempts: priorUncertain + 1 };
  } finally {
    done();
  }

  await settleAttempt(uid, runId, attempt.id, "committed", "", deps);

  if (!commit.committed) {
    // Cancelled while the stage was in flight. The result was stored (the money is
    // spent either way) but the run was not advanced.
    await chargeQuietly(uid, runId, stage, envelope.credits, deps);
    return { kind: "cancelled", run: commit.run };
  }

  try {
    await chargeStage(uid, runId, stage, envelope.credits, deps);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      // The stage's result is already durable — losing it would waste the spend
      // that just exhausted the budget. The run is paused with the reason, and the
      // pre-flight check will refuse the next stage.
      const run = await releaseLease(uid, runId, { status: "paused", error: err.message }, deps);
      return { kind: "budget_exceeded", run, scope: err.scope, spent: err.spent, cap: err.cap };
    }
    throw err;
  }

  return {
    kind: "advanced",
    run: commit.run,
    stage,
    result: envelope.result,
    credits: envelope.credits,
  };
}

/** Charge without letting a ceiling breach mask the outcome the caller cares about. */
async function chargeQuietly(
  uid: string,
  runId: string,
  stage: RunStage,
  credits: number,
  deps: RunnerDeps
): Promise<void> {
  try {
    await chargeStage(uid, runId, stage, credits, deps);
  } catch (err) {
    if (!(err instanceof BudgetExceededError)) throw err;
  }
}

/** Move the pointer past a stage whose result is already stored. */
async function recommit(
  uid: string,
  runId: string,
  stage: RunStage,
  stored: StoredStageResult,
  deps: RunnerDeps
): Promise<InvestmentRun> {
  const next = nextStage(stage);
  const commit = await commitStage(
    uid,
    runId,
    {
      stage,
      result: stored.result,
      credits: stored.credits,
      completedAt: stored.completedAt,
      nextStage: next,
      status: next === "complete" ? "complete" : "paused",
    },
    deps
  );
  return commit.run;
}

/**
 * Run one stage and describe how to commit it.
 *
 * Split out so advanceRun's try/catch covers the stage call AND the commit with
 * one uncertainty policy: a throw anywhere in here means we do not know what the
 * providers did.
 */
async function executeStage(
  uid: string,
  runId: string,
  stage: RunStage,
  run: InvestmentRun,
  signal: AbortSignal,
  deps: RunnerDeps
): Promise<{ envelope: StageEnvelope<unknown>; commit: Parameters<typeof commitStage>[2] }> {
  const { stages } = deps;
  const newId = stages.newId ?? deps.newId ?? (() => randomUUID());
  const next = nextStage(stage);
  const pausedOrDone = next === "complete" ? "complete" : "paused";

  if (stage === "snapshot") {
    const ctx = { uid, runId, mandate: run.mandate, asOf: null, signal } as const;
    const envelope = await stages.snapshot(ctx);
    const snapshot = ResearchSnapshotSchema.parse({
      ...envelope.result,
      id: newId(),
      ownerUid: uid,
      createdAt: new Date().toISOString(),
    });
    // Persisted BEFORE the stage is acknowledged, and immutable once written.
    await saveSnapshot(uid, snapshot, deps);
    return {
      envelope,
      commit: {
        stage,
        result: { snapshotId: snapshot.id, asOf: snapshot.asOf, contentHash: snapshot.contentHash },
        credits: envelope.credits,
        gaps: [...(envelope.gaps ?? []), ...snapshot.gaps.map((g) => `${g.source}.${g.field}: ${g.reason}`)],
        nextStage: next,
        status: pausedOrDone,
        snapshotId: snapshot.id,
      },
    };
  }

  const snapshot = await loadSnapshot(uid, run, deps);
  const ctx: StageContext = { uid, runId, mandate: run.mandate, asOf: snapshot.asOf, signal };

  if (stage === "research") {
    const envelope = await stages.research(ctx, snapshot);
    return { envelope, commit: { stage, result: envelope.result, credits: envelope.credits, gaps: envelope.gaps, nextStage: next, status: pausedOrDone } };
  }

  if (stage === "valuation") {
    const envelope = await stages.valuation(ctx, snapshot);
    return { envelope, commit: { stage, result: ValuationOutcomeSchema.parse(envelope.result), credits: envelope.credits, gaps: envelope.gaps, nextStage: next, status: pausedOrDone } };
  }

  if (stage === "scenarios") {
    const valuation = await requireStageResult(uid, runId, "valuation", ValuationOutcomeSchema, deps);
    const envelope = await stages.scenarios(ctx, snapshot, valuation);
    return { envelope, commit: { stage, result: envelope.result, credits: envelope.credits, gaps: envelope.gaps, nextStage: next, status: pausedOrDone } };
  }

  if (stage === "decision") {
    const research = await requireStageResult(uid, runId, "research", ResearchStageResultSchema, deps);
    const valuation = await requireStageResult(uid, runId, "valuation", ValuationOutcomeSchema, deps);
    const scenarios = await requireStageResult(uid, runId, "scenarios", ScenarioStageResultSchema, deps);
    const envelope = await stages.decision(ctx, { snapshot, research, valuation, scenarios });
    const decision = DecisionStageResultSchema.parse(envelope.result);
    const versions = stages.versions();

    const report = assembleReport({
      reportId: newId(),
      uid,
      snapshot,
      research,
      valuation,
      scenarios,
      decision,
      versions,
      // Spend recorded through the END of the previous stage plus this one. The
      // decision stage's own charge lands after the commit, so it is added here
      // rather than read back from a document that has not been written yet.
      creditsSpent: run.creditsSpent + envelope.credits,
      completedAt: new Date().toISOString(),
    });
    await saveReport(uid, report, buildCacheKey(uid, snapshot, run.mandate, versions), deps);

    return {
      envelope,
      commit: {
        stage,
        result: { reportId: report.id, rating: report.rating, status: report.status },
        credits: envelope.credits,
        gaps: envelope.gaps,
        nextStage: "complete",
        status: "complete",
        reportId: report.id,
      },
    };
  }

  // "complete" is terminal and is filtered out by acquireStageLease. Reaching
  // here means RUN_STAGES grew without this switch being updated.
  throw new Error(`no implementation for stage "${stage}"`);
}

/** The run's frozen snapshot. A later stage without one is a corrupted run. */
async function loadSnapshot(
  uid: string,
  run: InvestmentRun,
  deps: StoreDeps
): Promise<ResearchSnapshot> {
  if (!run.snapshotId) throw new Error(`run ${run.id} reached ${run.stage} with no snapshot`);
  const snapshot = await readSnapshot(uid, run.snapshotId, deps);
  if (!snapshot) throw new Error(`snapshot ${run.snapshotId} is missing for run ${run.id}`);
  return snapshot;
}
