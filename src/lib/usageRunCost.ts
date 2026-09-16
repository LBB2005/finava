/**
 * Per-RUN cost: what one answer cost, and the ceiling it is allowed to reach.
 *
 * `usage.ts` meters individual calls against a user's daily/weekly/monthly
 * allowance. This module is the other half — it answers "what did THIS run
 * cost?" and "when must this run stop?", which is what the 13–14 Sep readout
 * exposed: every paid plan capped a run at 300 credits (~$0.30) including the
 * $100 Quant tier, and nobody had ever measured what a run actually costs.
 *
 * Three pieces:
 *   - resolveRunCap()  — the per-lane credit ceiling for a user's plan.
 *   - runCostReport()  — the run's spend, broken down by model and by agent.
 *   - logRunCost()     — one `run_cost` line at the end of a run (and, when
 *                        RUN_COST_LOG is set, a JSONL row the measurement
 *                        script reads).
 *
 * SERVER-ONLY. Entitlements (and through them Firestore) are imported lazily, so
 * a route that only wants the run_cost line at the end of a stream doesn't drag
 * the Admin SDK into its module graph.
 */
import { creditsToUsd, perRunCapFor, type RunLane } from "@/lib/plans";
import { usageStore, type RunCall } from "@/lib/runContext";
import { logger } from "@/lib/logger";

const log = logger("runcost");

/**
 * Admin and dev accounts are uncapped so internal testing is never cut off
 * mid-run. That also means nobody on the team ever SEES the cap fire — the beta
 * shipped a graceful-stop path no one had watched work. Set
 * ENFORCE_CAPS_FOR_ADMINS=1 to make an admin account behave like a paying one.
 */
export function capsEnforcedForAdmins(): boolean {
  return process.env.ENFORCE_CAPS_FOR_ADMINS === "1";
}

/**
 * Credit ceiling used when a user's plan can't be resolved (degraded read or
 * error). Deliberately the deep lane's cap, not the lane's own: during an
 * entitlements outage we bound the run rather than guess it tight and truncate a
 * legitimate answer.
 */
const FALLBACK_LANE: RunLane = "deep";

/** The per-run credit ceiling for a user on a lane (Infinity = uncapped). */
export async function resolveRunCap(
  userId: string | undefined,
  lane: RunLane
): Promise<number> {
  if (!userId) return Infinity; // internal/no-user context (cron, harness) — don't block
  try {
    const { resolvePlan } = await import("@/lib/entitlements");
    const ent = await resolvePlan(userId);
    if ((ent.source === "admin" || ent.source === "dev") && !capsEnforcedForAdmins()) {
      return Infinity;
    }
    // Couldn't read the plan — bound the run with the shared fallback table.
    if (ent.degraded) return perRunCapFor(null, FALLBACK_LANE);
    return perRunCapFor(ent.config, lane);
  } catch {
    return perRunCapFor(null, FALLBACK_LANE); // never disable the backstop on an infra blip
  }
}

/** What one run spent, ready to log or to sum across a measurement batch. */
export interface RunCostReport {
  runId: string;
  lane: RunLane;
  credits: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  durationMs: number;
  /** Credits per model slug, biggest first — where the money actually went. */
  byModel: Record<string, number>;
  /** Credits per agent, biggest first. Calls with no agent land under "unattributed". */
  byAgent: Record<string, number>;
}

function bucket(calls: RunCall[], key: (c: RunCall) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of calls) {
    const k = key(c);
    out[k] = Math.round(((out[k] ?? 0) + c.credits) * 100) / 100;
  }
  // Biggest spender first — the reason anyone reads this breakdown.
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

/**
 * The cost report for the run in scope, or null outside a run context (a cron,
 * a unit test, an unauthenticated call — nothing to attribute).
 */
export function runCostReport(now: () => number = Date.now): RunCostReport | null {
  const store = usageStore.getStore();
  if (!store) return null;

  const credits = Math.round(store.credits.total * 100) / 100;
  return {
    runId: store.requestId,
    lane: store.lane,
    credits,
    usd: creditsToUsd(credits),
    inputTokens: store.calls.reduce((n, c) => n + c.inputTokens, 0),
    outputTokens: store.calls.reduce((n, c) => n + c.outputTokens, 0),
    calls: store.calls.length,
    durationMs: now() - store.startedAt,
    byModel: bucket(store.calls, (c) => c.model),
    byAgent: bucket(store.calls, (c) => c.agent ?? "unattributed"),
  };
}

/**
 * Close out a run: emit the `run_cost` line, and append a JSONL row when
 * RUN_COST_LOG names a file.
 *
 * The JSONL sidecar is the measurement seam `scripts/measure-run-cost.ts` reads:
 * an SSE response carries the answer, not its cost, and the alternative — having
 * the script scrape the dev server's stdout — breaks the moment two runs
 * interleave. Never enabled in production; `extra` is merged into the log line
 * for lane-specific context (whether the run hit its cap, which crew ran).
 *
 * Best-effort throughout: a cost report that throws must not fail a user's
 * answer that already streamed.
 */
export function logRunCost(extra: Record<string, unknown> = {}): RunCostReport | null {
  let report: RunCostReport | null = null;
  try {
    report = runCostReport();
    if (!report) return null;
    // The logger flattens nested objects to "[object]" (they could smuggle PII),
    // so the breakdowns go in as the one line that is actually read at a glance:
    // the biggest spender in each dimension. The full maps go to the JSONL row.
    const { byModel, byAgent, ...flat } = report;
    log.info("run_cost", {
      ...flat,
      topModel: topSpender(byModel),
      topAgent: topSpender(byAgent),
      ...extra,
    });
    void writeCostRow({ ...report, ...extra });
  } catch (e) {
    log.warn("run_cost report failed", { err: e instanceof Error ? e.message : String(e) });
  }
  return report;
}

/** "model=123.4" for the biggest line in a breakdown, or null when empty. */
function topSpender(by: Record<string, number>): string | null {
  const [name, credits] = Object.entries(by)[0] ?? [];
  return name === undefined ? null : `${name}=${credits}`;
}

/** Append one JSONL row to RUN_COST_LOG. Dev-only, best-effort, never throws. */
async function writeCostRow(row: Record<string, unknown>): Promise<void> {
  const path = process.env.RUN_COST_LOG;
  if (!path || process.env.NODE_ENV === "production") return;
  try {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, `${JSON.stringify({ ...row, at: new Date().toISOString() })}\n`);
  } catch {
    /* the measurement sidecar is never worth failing a run over */
  }
}
