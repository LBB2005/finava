// POST /api/investment/runs/:runId/cancel — stop a run.
//
// Cancelling sets the status and nothing else. It does NOT clear the lease: a stage
// may be executing in another invocation right now, and releasing the lease would
// let a third request start that same paid stage. The runner checks the status
// before starting any stage and again inside the commit transaction, so a cancel
// that lands mid-stage cannot advance the run — the in-flight stage's result is
// still stored, because the money was already spent, but nothing follows it.
//
// Idempotent: cancelling a cancelled run succeeds. A COMPLETE run is refused with
// 409 — it owns an immutable report, and relabelling it would misdescribe a
// document the user has already read.

import { NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { userRateLimit } from "@/lib/rateLimit";
import { withRoute } from "@/lib/withRoute";
import { investmentResearchEnabled } from "@/lib/investment/jev/client";
import {
  OwnershipError,
  RunConflictError,
  RunNotFoundError,
  cancelRun,
} from "@/lib/investment/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ runId: string }> };

const handler = withRoute({}, async ({ userId }, { params }: Ctx) => {
  const { runId } = await params;
  const limited = await userRateLimit(userId, "investment-run-cancel", {
    capacity: 20,
    refillPerSec: 1,
  });
  if (limited) return limited;

  try {
    const run = await cancelRun(userId, runId);
    return NextResponse.json({ runId: run.id, status: run.status, stage: run.stage });
  } catch (err) {
    if (err instanceof OwnershipError) return apiError("forbidden", "Forbidden", 403);
    if (err instanceof RunNotFoundError) return apiError("not_found", "Not found", 404);
    if (err instanceof RunConflictError) return apiError(err.reason, err.message, 409);
    throw err;
  }
});

export const POST = async (req: Request, ctx: Ctx): Promise<Response> =>
  investmentResearchEnabled() ? handler(req, ctx) : apiError("not_found", "Not found", 404);
