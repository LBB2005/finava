// POST /api/investment/runs/:runId/advance — run exactly one stage.
//
// This is the ONLY route in the feature that spends money, and everything about it
// is shaped by that.
//
// It is a POST, and a URL alone can never reach it. Prefetchers, tab restores and
// refreshes issue GETs; paid research must require an action the user took on
// purpose.
//
// It advances ONE bounded stage and returns. There is no background continuation:
// a serverless invocation is frozen once the response is flushed, so work promised
// after the response would die mid-stage having already paid for part of itself.
// When this returns, the run's status is `paused` unless it just finished, and the
// UI must say so rather than showing an in-progress spinner that will never resolve.
//
// `expectedStage` makes the POST safe to retry. Without it, a client that lost the
// response and retried would advance the NEXT stage and be billed for research it
// did not know it had asked for. With it, a retry naming a stage that is already
// stored gets that stored result back and pays nothing.

import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/apiError";
import { userRateLimit } from "@/lib/rateLimit";
import { withRoute } from "@/lib/withRoute";
import { investmentResearchEnabled } from "@/lib/investment/jev/client";
import { RunStageSchema } from "@/lib/investment/contracts";
import {
  OwnershipError,
  RunConflictError,
  RunNotFoundError,
  readRun,
  readStageResult,
  reportRef,
} from "@/lib/investment/store";
import { advanceRun, loadStages } from "@/lib/investment/runner";

export const runtime = "nodejs";
/**
 * One stage, plus room to release the lease and record the attempt.
 *
 * STAGE_DEADLINE_MS aborts the stage below this, so the runner always gets to
 * write its attempt record instead of being killed with the lease still held — a
 * lease held by a dead invocation blocks the run until it expires.
 */
export const maxDuration = 60;

type Ctx = { params: Promise<{ runId: string }> };

const AdvanceBodySchema = z.object({
  /**
   * The stage the caller believes is next. Optional, but a client that retries
   * should always send it.
   */
  expectedStage: RunStageSchema.optional(),
});

/** A missing or unparseable body means "advance whatever is next". */
async function parseBody(req: Request): Promise<z.infer<typeof AdvanceBodySchema> | null> {
  let raw: unknown = {};
  try {
    const text = await req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
  const parsed = AdvanceBodySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const handler = withRoute({}, async ({ req, userId }, { params }: Ctx) => {
  const { runId } = await params;

  // Tight. Every allowed request here can spend real money, and the per-run and
  // per-user-per-day ceilings in runBudget are the backstop, not the first line.
  const limited = await userRateLimit(userId, "investment-run-advance", {
    capacity: 12,
    refillPerSec: 0.2,
  });
  if (limited) return limited;

  const body = await parseBody(req);
  if (!body) return apiError("validation_error", "expectedStage must be a known stage", 400);

  const stages = await loadStages();
  if (!stages) {
    // 503, not a fabricated success. Nothing has been charged and the run is
    // untouched. See loadStages() in runner.ts for the one place to wire this.
    return apiError(
      "stages_not_wired",
      "Investment research stages are not configured on this deployment",
      503
    );
  }

  try {
    if (body.expectedStage) {
      const run = await readRun(userId, runId);
      if (body.expectedStage !== run.stage) {
        const stored = await readStageResult(userId, runId, body.expectedStage);
        if (stored) {
          // A retry of a request whose response was lost. Return what was already
          // paid for; do not run anything.
          return NextResponse.json({
            runId,
            stage: stored.stage,
            status: run.status,
            replayed: true,
            result: stored.result,
          });
        }
        return apiError(
          "stage_mismatch",
          `Run is at stage "${run.stage}", not "${body.expectedStage}"`,
          409
        );
      }
    }

    const outcome = await advanceRun(userId, runId, { stages, signal: req.signal });

    switch (outcome.kind) {
      case "advanced":
        return NextResponse.json({
          runId,
          stage: outcome.stage,
          status: outcome.run.status,
          replayed: false,
          result: outcome.result,
          credits: outcome.credits,
          gaps: outcome.run.gaps,
          reportRef: outcome.run.reportId ? reportRef(userId, outcome.run.reportId) : null,
        });
      case "replayed":
        return NextResponse.json({
          runId,
          stage: outcome.stage,
          status: outcome.run.status,
          replayed: true,
          result: outcome.result,
        });
      case "complete":
        return NextResponse.json({
          runId,
          stage: "complete",
          status: outcome.run.status,
          replayed: false,
          result: null,
          reportRef: outcome.run.reportId ? reportRef(userId, outcome.run.reportId) : null,
        });
      case "lease_held":
        // Not an error: another invocation is doing exactly this work.
        return apiError("lease_held", "Another request is advancing this run", 409, {
          leaseUntil: outcome.leaseUntil,
        });
      case "cancelled":
        return apiError("run_cancelled", "This run was cancelled", 409);
      case "failed":
        return apiError("run_failed", outcome.run.error ?? "This run failed", 409);
      case "budget_exceeded":
        // 429, matching the credit meter's hard cap. The run is paused and can be
        // resumed once the ceiling resets or is raised; nothing is lost.
        return apiError("budget_exceeded", "This run reached its spend ceiling", 429, {
          scope: outcome.scope,
          spent: outcome.spent,
          cap: outcome.cap,
        });
      case "uncertain":
        // 502: the failure was upstream, and we are telling the caller plainly that
        // we cannot say whether the provider billed us for the attempt.
        return apiError(
          "stage_uncertain",
          "A provider call ended with an outcome we cannot confirm",
          502,
          { stage: outcome.stage, attempts: outcome.attempts, detail: outcome.detail }
        );
    }
  } catch (err) {
    if (err instanceof OwnershipError) return apiError("forbidden", "Forbidden", 403);
    if (err instanceof RunNotFoundError) return apiError("not_found", "Not found", 404);
    if (err instanceof RunConflictError) return apiError(err.reason, err.message, 409);
    throw err;
  }
});

export const POST = async (req: Request, ctx: Ctx): Promise<Response> =>
  investmentResearchEnabled() ? handler(req, ctx) : apiError("not_found", "Not found", 404);
