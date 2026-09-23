// Spend ceilings for investment research runs.
//
// WHY THIS EXISTS, AND WHY IT CANNOT REUSE THE EXISTING CAP.
//
// `resolveRunCap()` in @/lib/usageRunCost (called from agents/ceo.ts) returns
// Infinity when there is no userId AND for admin UIDs. During the private beta the
// only accounts that can sign in are admin accounts, so for every single person
// who can currently run this feature, the existing per-run cap does not exist. A
// feature that fans out to filings, price history, model calls and Jev and whose
// cap resolves to Infinity is a feature with no cap. This module is therefore
// deliberately blind to plans, entitlements and the admin allowlist: it never
// imports them, so there is no code path by which an admin is exempt. See the
// test named "binds an admin UID".
//
// WHY THE TOTAL IS PERSISTED. A run advances one stage per HTTP request, and each
// serverless invocation gets its own AsyncLocalStorage run context — so
// `currentRunCredits()` reports what THIS call spent and nothing more. Five calls
// each under the cap add up to five times the cap. The running total has to live
// in Firestore between invocations, which is what chargeStage does. This is the
// same lesson live/budget.ts learned for the daily harness.
//
// TWO CEILINGS, because they stop different runaways. The per-RUN cap bounds one
// answer: a stage that loops internally, or a valuation that fans out over a
// hundred comparables. The per-USER-per-DAY cap bounds the number of answers: a
// client retry loop, or a script creating runs, cannot be stopped by a per-run cap
// at all because every new run starts at zero.
//
// The Firestore handle is INJECTED, for the reason store.ts explains.

import { z } from "zod";
import { resolveDb, runDoc, type FirestoreLike, type StoreDeps } from "./store";
import type { RunStage } from "./contracts";

/** Per-user daily budget documents: `users/{uid}/investmentBudget/{YYYY-MM-DD}`. */
export const BUDGET_DAYS = "investmentBudget";

/**
 * Fallback per-run ceiling when INVESTMENT_RUN_CREDIT_CAP is unset.
 *
 * 1500 credits ≈ $1.50 for one researched answer across five stages. The Sep
 * 13–14 readout found every lane capped at 300 credits including the $100 tier,
 * which truncated legitimate deep work; this is deliberately looser than that and
 * still finite, which is the property that matters.
 */
export const DEFAULT_RUN_CREDIT_CAP = 1500;

/** Fallback per-user daily ceiling. Roughly four full runs a day. */
export const DEFAULT_DAILY_CREDIT_CAP = 6000;

export type BudgetScope = "run" | "day";

export class BudgetExceededError extends Error {
  constructor(
    readonly scope: BudgetScope,
    readonly runId: string,
    readonly stage: string,
    readonly spent: number,
    readonly cap: number
  ) {
    super(
      `Investment research ${scope} budget exceeded at stage "${stage}": ` +
        `${spent.toFixed(1)} of ${cap} credits`
    );
    this.name = "BudgetExceededError";
  }
}

/** Parse a configured cap. Unparseable or non-positive falls back to the default. */
function parseCap(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveRunCreditCap(
  raw: string | undefined = process.env.INVESTMENT_RUN_CREDIT_CAP
): number {
  return parseCap(raw, DEFAULT_RUN_CREDIT_CAP);
}

export function resolveDailyCap(
  raw: string | undefined = process.env.INVESTMENT_DAILY_CREDIT_CAP
): number {
  return parseCap(raw, DEFAULT_DAILY_CREDIT_CAP);
}

export interface BudgetCaps {
  run: number;
  day: number;
}

export function resolveCaps(env: NodeJS.ProcessEnv = process.env): BudgetCaps {
  return {
    run: resolveRunCreditCap(env.INVESTMENT_RUN_CREDIT_CAP),
    day: resolveDailyCap(env.INVESTMENT_DAILY_CREDIT_CAP),
  };
}

export interface ScopeStatus {
  cap: number;
  spent: number;
  remaining: number;
  pctUsed: number;
  exhausted: boolean;
  /** Past 80%. The run continues; the UI can warn before a stage is refused. */
  warning: boolean;
}

/** Pure. The whole decision for one scope, so it is table-testable. */
export function scopeStatus(cap: number, spent: number): ScopeStatus {
  const remaining = Math.max(0, cap - spent);
  const pctUsed = cap > 0 ? (spent / cap) * 100 : 100;
  return { cap, spent, remaining, pctUsed, exhausted: spent >= cap, warning: pctUsed >= 80 };
}

export interface BudgetStatus {
  run: ScopeStatus;
  day: ScopeStatus;
  /** The scope that is out of room, or null. Run is reported first when both are. */
  blockedBy: BudgetScope | null;
}

/** Pure. Combines both ceilings; either one alone is enough to stop a stage. */
export function budgetStatus(
  caps: BudgetCaps,
  spent: { run: number; day: number }
): BudgetStatus {
  const run = scopeStatus(caps.run, spent.run);
  const day = scopeStatus(caps.day, spent.day);
  return { run, day, blockedBy: run.exhausted ? "run" : day.exhausted ? "day" : null };
}

/**
 * The UTC calendar day a charge belongs to.
 *
 * UTC rather than local time so the ceiling cannot be reset twice in one real day
 * by a client, a cron, or a deploy in a different region.
 */
export function budgetDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

function dayDoc(db: FirestoreLike, uid: string, day: string) {
  return db.collection("users").doc(uid).collection(BUDGET_DAYS).doc(day);
}

const SpentSchema = z.object({ creditsSpent: z.number().min(0).catch(0) }).partial();

function spentOf(data: Record<string, unknown> | undefined): number {
  const parsed = SpentSchema.safeParse(data ?? {});
  return parsed.success ? (parsed.data.creditsSpent ?? 0) : 0;
}

export interface BudgetDeps extends StoreDeps {
  caps?: BudgetCaps;
}

/**
 * Read both ceilings without charging anything.
 *
 * Called BEFORE a stage starts, so a run that is already out of budget is refused
 * without spending another cent. chargeStage's post-hoc check cannot do this job:
 * by the time it runs, the money is gone.
 */
export async function readBudget(
  uid: string,
  runId: string,
  deps: BudgetDeps = {}
): Promise<BudgetStatus> {
  const db = await resolveDb(deps.db);
  const caps = deps.caps ?? resolveCaps();
  const day = budgetDay((deps.now ?? (() => new Date()))());
  const [runSnap, daySnap] = await Promise.all([
    runDoc(db, uid, runId).get(),
    dayDoc(db, uid, day).get(),
  ]);
  return budgetStatus(caps, { run: spentOf(runSnap.data()), day: spentOf(daySnap.data()) });
}

/**
 * Add a stage's measured spend to both running totals, then refuse to continue if
 * either ceiling is reached.
 *
 * Checked AFTER adding, exactly as live/budget.ts does it and for the same reason:
 * the stage has already run, so the money has already been spent. Refusing before
 * recording would drop that spend from the total and under-report what the run
 * cost — and the measured cost is itself a number this product publishes. The
 * honest order is to record it and then stop the NEXT stage.
 *
 * Both totals are written in ONE transaction. If the run total committed and the
 * day total did not, a crash-retry loop would charge the run twice while the daily
 * ceiling — the only thing that bounds a loop — stayed behind.
 *
 * Written under `creditsSpent` and `stageCredits` only. store.ts owns `stage`,
 * `status`, `leaseUntil` and the stageResults subcollection; a writer touching
 * both would depend on Firestore's nested-merge semantics to avoid clobbering a
 * stage's completion marker, and a stage marked not-done is a stage that re-runs
 * and re-spends — precisely what this module exists to prevent.
 */
export async function chargeStage(
  uid: string,
  runId: string,
  stage: RunStage | string,
  credits: number,
  deps: BudgetDeps = {}
): Promise<BudgetStatus> {
  const db = await resolveDb(deps.db);
  const caps = deps.caps ?? resolveCaps();
  const at = (deps.now ?? (() => new Date()))();
  const day = budgetDay(at);
  const charge = Number.isFinite(credits) ? Math.max(0, credits) : 0;

  const status = await db.runTransaction(async (tx) => {
    const runRef = runDoc(db, uid, runId);
    const dayRef = dayDoc(db, uid, day);
    const runSnap = await tx.get(runRef);
    const daySnap = await tx.get(dayRef);

    const runSpent = spentOf(runSnap.data()) + charge;
    const daySpent = spentOf(daySnap.data()) + charge;

    tx.set(
      runRef,
      {
        creditsSpent: runSpent,
        stageCredits: { [stage]: { credits: charge, at: at.toISOString() } },
      },
      { merge: true }
    );
    tx.set(dayRef, { creditsSpent: daySpent, day, updatedAt: at.toISOString() }, { merge: true });

    return budgetStatus(caps, { run: runSpent, day: daySpent });
  });

  if (status.blockedBy) {
    const scope = status.blockedBy;
    const s = scope === "run" ? status.run : status.day;
    throw new BudgetExceededError(scope, runId, String(stage), s.spent, s.cap);
  }
  return status;
}

/**
 * Refuse a stage that has no budget left, before any provider is called.
 *
 * Throws the same error type as chargeStage so callers have one thing to catch.
 */
export async function assertBudgetAvailable(
  uid: string,
  runId: string,
  stage: RunStage | string,
  deps: BudgetDeps = {}
): Promise<BudgetStatus> {
  const status = await readBudget(uid, runId, deps);
  if (status.blockedBy) {
    const scope = status.blockedBy;
    const s = scope === "run" ? status.run : status.day;
    throw new BudgetExceededError(scope, runId, String(stage), s.spent, s.cap);
  }
  return status;
}
