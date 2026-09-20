// Shared plumbing for every /api/live/* route: auth, configuration gate,
// idempotent step recording, and the ET trading-day clock.
//
// These routes are called by a GitHub Actions runner, not a browser, so they
// sit outside withRoute's Bearer-token model. They still establish a run context
// (so credits are metered) and they still refuse to exist when unconfigured.

import { NextResponse } from "next/server";
import { secretMatches } from "@/lib/secretMatches";
import { requireAdmin } from "@/lib/requireAdmin";
import { apiError } from "@/lib/apiError";
import { currentRequestId, makeRunContext } from "@/lib/runContext";
import { db } from "@/lib/firebase-admin";
import { logger } from "@/lib/logger";
import { chargeStep, BudgetExceededError } from "./budget";
import { promptHash } from "./promptHash";
import { flushTraces, runTraced } from "@/lib/observability";

const log = logger("live:harness");

/** The synthetic user the harness runs as. Its usage is metered, not exempted. */
export const LIVE_HARNESS_UID = process.env.LIVE_HARNESS_UID || "finava-live";

/**
 * Is the harness configured at all?
 *
 * A deployment with no LIVE_HARNESS_SECRET has not opted into any of this, and
 * every route 503s — the same shape as stripeConfigured(). Deliberately not a
 * 404: a silent "route doesn't exist" from a misconfigured production deploy is
 * indistinguishable from a bad URL in the Actions log, and the whole point of
 * publishing is that failures are legible.
 */
export function liveHarnessConfigured(): boolean {
  return Boolean(process.env.LIVE_HARNESS_SECRET);
}

/**
 * Authorize a harness call.
 *
 * Accepts EITHER the shared secret (how Actions calls it) or an admin session
 * (how a human debugs it). A dedicated LIVE_HARNESS_SECRET, never CRON_SECRET:
 * this secret lives in a public repo's Actions settings and authorizes a system
 * that places orders, so its blast radius must not overlap the cron routes'.
 */
export async function authorizeHarness(req: Request): Promise<NextResponse | null> {
  if (!liveHarnessConfigured()) {
    return apiError("not_configured", "Finava Live is not configured on this deployment", 503);
  }

  const header = req.headers.get("x-live-secret") ?? bearer(req);
  if (secretMatches(header, process.env.LIVE_HARNESS_SECRET)) return null;

  const admin = await requireAdmin();
  if (admin.error) {
    return apiError("unauthorized", "Finava Live harness credentials required", 401);
  }
  return null;
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

// ---------------------------------------------------------------------------
// Trading day / clock
// ---------------------------------------------------------------------------

/**
 * Today's date in US/Eastern as YYYY-MM-DD.
 *
 * The whole ledger is keyed on the ET calendar day. The Actions cron fires on a
 * UTC schedule that drifts an hour across DST, and a UTC date would silently
 * roll a pre-open run onto the wrong day twice a year, so the ET day is derived
 * here and never inferred from the trigger time.
 */
export function easternDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Minutes since ET midnight — used by the execute cutoff. */
export function easternMinutes(at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  // Intl renders midnight as hour 24 in some ICU versions.
  return (get("hour") % 24) * 60 + get("minute");
}

// ---------------------------------------------------------------------------
// Idempotent steps
// ---------------------------------------------------------------------------

/** A run id IS its ET trading day. */
export const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Thrown when a caller names a run that can't exist; mapped to a 400. */
export class InvalidRunIdError extends Error {
  constructor(readonly runId: string) {
    super("runId must be an ET trading day (YYYY-MM-DD)");
    this.name = "InvalidRunIdError";
  }
}

/** liveRuns is mutable working state, not the append-only ledger. */
function runRef(runId: string) {
  return db.collection("liveRuns").doc(runId);
}

export interface StepRecord<T> {
  result: T;
  replayed: boolean;
}

/**
 * Thrown when a completed step was produced by a different agent build.
 *
 * Not recoverable here on purpose. Re-running the step instead would be worse
 * than failing: a step that already appended to the ledger cannot run twice
 * (the chain is append-only and would throw ALREADY_EXISTS), and silently
 * re-spending a full crew debate is exactly what replay exists to prevent. The
 * operator decides — start a fresh runId, or redeploy the build that made it.
 */
export class StepVersionMismatchError extends Error {
  constructor(
    readonly runId: string,
    readonly step: string,
    readonly storedHash: string,
    readonly currentHash: string
  ) {
    super(
      `Step ${step} of run ${runId} was produced by a different agent build ` +
        `(${storedHash.slice(0, 12)}… vs ${currentHash.slice(0, 12)}…)`
    );
    this.name = "StepVersionMismatchError";
  }
}

/**
 * Run one harness step at most once per run.
 *
 * "Re-run failed jobs" is a button in the Actions UI and it re-runs SUCCEEDED
 * steps too, so without this a retry would re-spend a full crew debate and —
 * worse — append a second ledger entry for the same decision. A completed step
 * returns its stored result verbatim and costs nothing.
 *
 * The budget is charged AFTER the step body, on the way out: the work is already
 * paid for by then, and recording it is what lets the NEXT step refuse.
 *
 * A replay is REFUSED when the stored step came from a different agent build.
 * "Re-run failed jobs" can be pressed after a deploy, in which case the replayed
 * steps carry the old prompts while everything after them runs on the new ones,
 * and the decision that falls out is a mixture of two versions stamped with only
 * one. A record whose promptHash does not describe the code that produced it is
 * precisely the artifact promptHash exists to rule out.
 */
export async function runStep<T>(
  runId: string,
  step: string,
  fn: () => Promise<T>
): Promise<StepRecord<T>> {
  // Every step route funnels through here, so the id is checked once, centrally:
  // a free-text runId became a Firestore doc path.
  if (!RUN_ID_RE.test(runId)) throw new InvalidRunIdError(runId);
  const snap = await runRef(runId).get();
  const steps = (snap.data()?.steps ?? {}) as Record<
    string,
    { result?: T; done?: boolean; promptHash?: string }
  >;
  const prior = steps[step];
  const fingerprint = promptHash();
  if (prior?.done) {
    if (prior.promptHash && prior.promptHash !== fingerprint) {
      throw new StepVersionMismatchError(runId, step, prior.promptHash, fingerprint);
    }
    if (!prior.promptHash) {
      // A step recorded before fingerprinting shipped. Refusing would strand any
      // run already in flight at deploy time, and the gap closes on its own
      // within one run, so this is a warning rather than a wall.
      log.warn("replaying an unfingerprinted step", { runId, step });
    }
    log.info("step replayed from store", { runId, step });
    return { result: prior.result as T, replayed: true };
  }

  const result = await fn();

  await runRef(runId).set(
    {
      steps: {
        [step]: { done: true, result, at: new Date().toISOString(), promptHash: fingerprint },
      },
    },
    { merge: true }
  );
  await chargeStep(runId, step);

  return { result, replayed: false };
}

/**
 * Wrap a harness route: authorize, establish a metered run context, and map the
 * budget abort to a 429 rather than an opaque 500 so the Actions log says why.
 */
export function withHarness(
  handler: (req: Request) => Promise<Response>
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const denied = await authorizeHarness(req);
    if (denied) return denied;

    return runTraced(makeRunContext(LIVE_HARNESS_UID), async () => {
      try {
        return await handler(req);
      } catch (err) {
        if (err instanceof StepVersionMismatchError) {
          log.error("refused a cross-version replay", {
            runId: err.runId,
            step: err.step,
            storedHash: err.storedHash,
            currentHash: err.currentHash,
          });
          return apiError("version_mismatch", err.message, 409, {
            runId: err.runId,
            step: err.step,
            storedPromptHash: err.storedHash,
            currentPromptHash: err.currentHash,
          });
        }
        if (err instanceof InvalidRunIdError) {
          return apiError("invalid_run", err.message, 400);
        }
        if (err instanceof BudgetExceededError) {
          log.error("run aborted on budget", { runId: err.runId, step: err.step, spent: err.spent });
          return apiError("budget_exceeded", err.message, 429, {
            runId: err.runId,
            step: err.step,
            spent: err.spent,
            cap: err.cap,
          });
        }
        const requestId = currentRequestId();
        log.error("harness step failed", {
          path: new URL(req.url).pathname,
          err: err instanceof Error ? err.message : String(err),
        });
        // Generic body: the caller is a GitHub Actions runner whose logs are
        // PUBLIC, and raw error text carries provider messages (balances, quota
        // text) and internal URLs. The detail is in the server log, by request id.
        return apiError(
          "step_failed",
          `Harness step failed${requestId ? ` (request ${requestId})` : ""}. See server logs.`,
          500
        );
      } finally {
        // A harness step is the longest-running thing this app does and the
        // function is frozen the instant it returns, so anything still in the
        // tracer's batch queue is lost. Flushed on the failure path too: the
        // trace of a run that died is the one worth having.
        await flushTraces();
      }
    });
  };
}
