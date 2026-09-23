// GET /api/investment/runs/:runId — the run's current state.
//
// READ-ONLY, ABSOLUTELY. A GET must never advance a stage, and therefore never
// spend money. That is not a style preference: a URL is followed by link
// prefetchers, by a browser restoring tabs, by the user hitting refresh, and by
// anything that scans a page. If polling this endpoint advanced the run, leaving a
// tab open overnight would bill the user for research nobody asked for. Progress
// happens only on an explicit POST to /advance.
//
// Ownership is enforced by the path (`users/{uid}/investmentRuns/{runId}`), so a
// run id belonging to another account is simply not there. That returns 404 rather
// than 403 on purpose: answering 403 would confirm the id exists, which is itself
// a disclosure. 403 is reserved for a stored document whose ownerUid disagrees
// with the path it was found at — a corrupted tree, not a cross-tenant guess.

import { NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { userRateLimit } from "@/lib/rateLimit";
import { withRoute } from "@/lib/withRoute";
import { investmentResearchEnabled } from "@/lib/investment/jev/client";
import {
  OwnershipError,
  RunNotFoundError,
  readRun,
  reportRef,
} from "@/lib/investment/store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ runId: string }> };

const handler = withRoute({}, async ({ userId }, { params }: Ctx) => {
  const { runId } = await params;
  // Generous: the UI polls this while a run is paused between stages, and the read
  // costs one document.
  const limited = await userRateLimit(userId, "investment-run-read", {
    capacity: 60,
    refillPerSec: 2,
  });
  if (limited) return limited;

  try {
    const run = await readRun(userId, runId);
    return NextResponse.json({
      runId: run.id,
      status: run.status,
      stage: run.stage,
      reportRef: run.reportId ? reportRef(userId, run.reportId) : null,
      snapshotId: run.snapshotId,
      gaps: run.gaps,
      creditsSpent: run.creditsSpent,
      error: run.error,
      supersedes: run.supersedes,
      updatedAt: run.updatedAt,
    });
  } catch (err) {
    if (err instanceof OwnershipError) return apiError("forbidden", "Forbidden", 403);
    if (err instanceof RunNotFoundError) return apiError("not_found", "Not found", 404);
    throw err;
  }
});

export const GET = async (req: Request, ctx: Ctx): Promise<Response> =>
  investmentResearchEnabled() ? handler(req, ctx) : apiError("not_found", "Not found", 404);
