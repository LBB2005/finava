import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { RunLane } from "@/lib/plans";

/**
 * Request-scoped run context — shared by usage metering, log correlation, and the
 * in-run cost accumulator.
 *
 * Deliberately dependency-light (async_hooks + crypto, and a type-only import of
 * the lane union): the route wrapper and the logger enter/read this store, and
 * must NOT transitively pull in the heavy usage/Firestore chain just to get a
 * requestId.
 *
 *   - userId       → recordUsage() reads it when a caller doesn't pass one.
 *   - requestId    → every log line in one request/crew shares it (correlation).
 *                    It is also the runId the per-run cost report is keyed by.
 *   - lane         → which product surface is spending (fast / full / deep /
 *                    discover). Picks the per-run cap and buckets the cost report.
 *   - credits.total→ a running total each recordUsage() adds to, so a long crew
 *                    can abort before blowing its per-run cap.
 *   - calls        → one entry per metered model/paid-data call, so the run_cost
 *                    line at the end of a run can show where the money went.
 */

/** One metered call inside a run — what it was, and what it cost. */
export interface RunCall {
  /** Routable agent name, when the call site provided one. */
  agent?: string;
  model: string;
  credits: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * How many individual calls one run keeps. A deep crew makes tens of calls, not
 * thousands; the bound exists so a pathological loop can't grow the context for
 * the life of the request. Past it the totals keep accumulating — only the
 * per-call breakdown stops growing.
 */
export const MAX_TRACKED_CALLS = 200;

export interface RunContext {
  userId: string;
  requestId: string;
  lane: RunLane;
  credits: { total: number };
  calls: RunCall[];
  /** Wall-clock start, so the cost report can state $/run against duration. */
  startedAt: number;
}

export const usageStore = new AsyncLocalStorage<RunContext>();

/** A short correlation id for one request/run. */
export function newRequestId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * The shape a correlation id is allowed to take.
 *
 * `requestId` can originate in an inbound `x-request-id` header, which is
 * attacker-controlled, and from here it flows into every log line and into the
 * Langfuse sessionId. Constrain it to the alphabet real correlation ids use
 * (UUIDs, Vercel request ids, W3C traceparents) so nothing downstream has to
 * defend itself against control characters, delimiters, or unbounded length.
 */
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * Build a fresh run context (requestId auto-generated when not supplied).
 *
 * An unusable `requestId` is REPLACED, never rejected: a hostile header must not
 * be able to fail a request, and it must not be able to steer one either. It is
 * also not truncated — a 200-char id clipped to 64 would silently merge two
 * distinct upstream runs under one correlation key.
 *
 * `lane` defaults to "fast": an unlabelled run is metered under the cheapest
 * lane's cap, so forgetting to label a new surface bounds it tightly rather than
 * handing it the deep-research ceiling.
 */
export function makeRunContext(
  userId: string,
  requestId?: string,
  lane: RunLane = "fast"
): RunContext {
  const id = requestId && REQUEST_ID.test(requestId) ? requestId : newRequestId();
  return {
    userId,
    requestId: id,
    lane,
    credits: { total: 0 },
    calls: [],
    startedAt: Date.now(),
  };
}

/** The current request's correlation id (undefined outside a run context). */
export function currentRequestId(): string | undefined {
  return usageStore.getStore()?.requestId;
}

/** Credits spent so far in the current run (0 outside a run context). */
export function currentRunCredits(): number {
  return usageStore.getStore()?.credits.total ?? 0;
}

/** The lane the current run belongs to (undefined outside a run context). */
export function currentLane(): RunLane | undefined {
  return usageStore.getStore()?.lane;
}

/**
 * Attribute one metered call to the current run. No-op outside a run context.
 * Totals always accumulate; the per-call list stops growing at MAX_TRACKED_CALLS.
 */
export function attributeCall(call: RunCall): void {
  const store = usageStore.getStore();
  if (!store) return;
  store.credits.total += call.credits;
  if (store.calls.length < MAX_TRACKED_CALLS) store.calls.push(call);
}
