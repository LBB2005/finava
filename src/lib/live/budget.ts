// Daily spend cap for the Finava Live harness.
//
// Why this exists: resolveRunCap() in @/agents/ceo returns Infinity both when
// there is no userId AND for admin UIDs — so a headless daily crew is uncapped
// by construction. A silent 4am runaway is the most likely way this feature
// costs real money, and nothing else in the stack would stop it.
//
// The cap is DAILY, not per-run, because the harness is ~11 separate HTTP
// invocations and each one gets its own AsyncLocalStorage run context. Per-call
// credits are therefore meaningless on their own; the running total has to be
// persisted between steps, which is what chargeStep does.
//
// liveRuns is mutable working state, not part of the append-only ledger, so
// writing it directly here is deliberate and does not breach ledger discipline.

import { db } from "@/lib/firebase-admin";
import { currentRunCredits } from "@/lib/runContext";
import {
  validateReservation,
  validateMeasurement,
  type ReservationStore,
  type SpendReservation,
} from "./budgetReservation";

/** Shared, persisted, pre-request reservations. No admin exemption. Keeping the
 * full upper bound after settlement makes failures and retries conservative. */
export function tournamentReservations(
  day: string,
  namespace: "tournament" | "tournament_dryrun",
): ReservationStore {
  const ref = db.collection("tournamentBudget").doc(`${namespace}_${day}`);
  return {
    async reserve(id, upperUsd, cap) {
      validateReservation(upperUsd, cap);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref),
          data = snap.data() ?? {},
          entries = data.entries ?? {};
        if (
          data.blocked ||
          entries[id] ||
          Number(data.reservedUsd ?? 0) + upperUsd > cap
        )
          return false;
        tx.set(ref, {
          reservedUsd: Number(data.reservedUsd ?? 0) + upperUsd,
          entries: { ...entries, [id]: { id, upperUsd, measuredUsd: null } },
        });
        return true;
      });
    },
    async measure(id, usd) {
      validateMeasurement(usd);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref),
          data = snap.data();
        const item = data?.entries?.[id];
        if (!item) throw new Error("Unknown reservation");
        tx.update(ref, {
          [`entries.${id}.measuredUsd`]: usd,
          blocked:
            Boolean(data?.blocked) || (usd !== null && usd > item.upperUsd),
        });
      });
    },
    async entries() {
      const s = await ref.get();
      return Object.values(s.data()?.entries ?? {}) as SpendReservation[];
    },
  };
}

/** Fallback when LIVE_DAILY_CREDIT_CAP is unset. 3000 credits ≈ $3.00/day. */
export const DEFAULT_DAILY_CREDIT_CAP = 3000;

export class BudgetExceededError extends Error {
  constructor(
    readonly runId: string,
    readonly step: string,
    readonly spent: number,
    readonly cap: number,
  ) {
    super(
      `Finava Live daily budget exceeded at step "${step}": ${spent.toFixed(1)} of ${cap} credits`,
    );
    this.name = "BudgetExceededError";
  }
}

/** Parse the configured cap. An unparseable or non-positive value falls back. */
export function resolveDailyCap(
  raw: string | undefined = process.env.LIVE_DAILY_CREDIT_CAP,
): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_CREDIT_CAP;
}

export interface BudgetStatus {
  cap: number;
  spent: number;
  remaining: number;
  pctUsed: number;
  exhausted: boolean;
  /** True past 80% — the run keeps going but the day's export flags it. */
  warning: boolean;
}

/** Pure. The whole decision, so it can be table-tested without Firestore. */
export function budgetStatus(cap: number, spent: number): BudgetStatus {
  const remaining = Math.max(0, cap - spent);
  const pctUsed = cap > 0 ? (spent / cap) * 100 : 100;
  return {
    cap,
    spent,
    remaining,
    pctUsed,
    exhausted: spent >= cap,
    warning: pctUsed >= 80,
  };
}

function runRef(runId: string) {
  return db.collection("liveRuns").doc(runId);
}

/**
 * Add this invocation's spend to the day's total and refuse to continue once the
 * cap is reached.
 *
 * Checked AFTER adding rather than before: a step that has already run has
 * already cost the money, so the honest thing is to record it and then stop the
 * NEXT step. Refusing before recording would lose the spend from the total and
 * under-report what the day actually cost — and the day's cost is itself an eval
 * datum we publish.
 */
export async function chargeStep(
  runId: string,
  step: string,
  credits: number = currentRunCredits(),
  cap: number = resolveDailyCap(),
): Promise<BudgetStatus> {
  const status = await db.runTransaction(async (tx) => {
    const snap = await tx.get(runRef(runId));
    const prior = Number(snap.data()?.creditsSpent ?? 0);
    const spent = prior + Math.max(0, credits);
    // Written under `stepCredits`, NOT under `steps`. runStep owns `steps` and
    // records each step's result there; if both writers touched the same subtree
    // this would depend on Firestore's nested-map merge semantics to avoid
    // clobbering the `done` flag — and a step marked not-done is a step that
    // re-runs and re-spends, which is precisely what this module exists to stop.
    tx.set(
      runRef(runId),
      {
        creditsSpent: spent,
        stepCredits: { [step]: { credits, at: new Date().toISOString() } },
      },
      { merge: true },
    );
    return budgetStatus(cap, spent);
  });

  if (status.exhausted)
    throw new BudgetExceededError(runId, step, status.spent, status.cap);
  return status;
}

/** Read the day's spend without charging — used by /session/open to fail fast. */
export async function readBudget(
  runId: string,
  cap: number = resolveDailyCap(),
): Promise<BudgetStatus> {
  const snap = await runRef(runId).get();
  return budgetStatus(cap, Number(snap.data()?.creditsSpent ?? 0));
}
