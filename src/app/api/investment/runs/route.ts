// POST /api/investment/runs — start an investment research run.
//
// Creating a run is CHEAP: it writes one document and spends nothing. No provider
// is called and no stage executes until a later POST to /advance. That split is
// deliberate — it is what lets the create route be safe to retry and keeps paid
// research behind an explicit, separate action.
//
// The feature flag is checked BEFORE the auth wrapper runs, so a flag-off deploy
// verifies no token, reads no document and calls nothing. 404 rather than 503
// because an unreleased feature should not advertise that it exists.

import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/apiError";
import { isSafeDocId } from "@/lib/docId";
import { userRateLimit } from "@/lib/rateLimit";
import { withRoute } from "@/lib/withRoute";
import { investmentResearchEnabled } from "@/lib/investment/jev/client";
import { ResearchMandateSchema } from "@/lib/investment/contracts";
import { RunConflictError, createRun, OwnershipError } from "@/lib/investment/store";
import { resolveHorizon } from "@/lib/investment/horizon";
import { establishAsOf } from "@/lib/live/asOf";

export const runtime = "nodejs";

/**
 * The mandate, hardened at the edge.
 *
 * ResearchMandateSchema is the cross-module contract; these extra bounds exist
 * because this is the only place the mandate arrives from a client. The ticker
 * becomes a Firestore path segment and part of a cache key, so it is uppercased
 * once here and checked against the document-id alphabet — "/" in a symbol would
 * address a different collection (see docId.ts). The length caps bound what is
 * hashed into the idempotency and reuse keys.
 */
const MandateSchema = ResearchMandateSchema.extend({
  query: z.string().min(1).max(2000),
  ticker: z.string().min(1).max(20).nullable(),
  qualitativeCriteria: z.array(z.string().max(500)).max(20),
})
  .transform((m) => ({ ...m, ticker: m.ticker ? m.ticker.toUpperCase() : null }))
  .refine((m) => m.ticker === null || isSafeDocId(m.ticker), {
    message: "ticker is not a usable symbol",
  })
  // An analyze run with no ticker has nothing to analyze; discover screens a
  // universe and must not be handed one, or the screen silently becomes a lookup.
  .refine((m) => (m.mode === "analyze") === (m.ticker !== null), {
    message: "analyze requires a ticker; discover must not carry one",
  });

const CreateRunSchema = z.object({
  mandate: MandateSchema,
  /**
   * Makes create idempotent. A client that retries after a lost response gets the
   * SAME run back rather than a second one — which matters because each run is a
   * separate budget with its own ceiling.
   */
  idempotencyKey: z.string().min(1).max(200).nullish(),
  /** The run this one refreshes. The earlier run's report is never mutated. */
  supersedes: z.string().refine(isSafeDocId, "not a valid run id").nullish(),
});

/**
 * Re-derive the horizon on the server, keeping only the client's INTENT.
 *
 * `yearFraction` is what the return hurdle compounds over, so a client that sent
 * 24 months with a yearFraction of 0.01 would face a hurdle of ~0.1% and turn
 * every mediocre holding into a Buy. The count and unit are the user's to choose;
 * `targetDate` and `yearFraction` are derived, and derived values are ours.
 *
 * An unsupported unit (trading days, which needs an exchange calendar this repo
 * does not have) or an out-of-range count is rejected here rather than resolved
 * into a date we cannot stand behind.
 */
function reresolveHorizon(mandate: z.infer<typeof MandateSchema>) {
  const resolved = resolveHorizon(
    { count: mandate.horizon.count, unit: mandate.horizon.unit },
    establishAsOf()
  );
  if (resolved.status !== "resolved") return { ok: false as const, resolved };
  return {
    ok: true as const,
    // `assumed` is the client's to report: only the UI knows whether the user
    // actually chose this duration or accepted the default.
    mandate: {
      ...mandate,
      horizon: { ...resolved.horizon, assumed: mandate.horizon.assumed },
    },
  };
}

const handler = withRoute({ body: CreateRunSchema }, async ({ userId, body }) => {
  // Tight and slow-refilling: each run is a fresh budget, so the create route is
  // the only place a caller can multiply spend without any single request looking
  // expensive. Roughly 5 immediately, then one every 20 seconds.
  const limited = await userRateLimit(userId, "investment-run-create", {
    capacity: 5,
    refillPerSec: 0.05,
  });
  if (limited) return limited;

  const horizon = reresolveHorizon(body.mandate);
  if (!horizon.ok) {
    const reason = horizon.resolved.status === "unsupported_calendar" ? "unsupported_horizon" : "invalid_horizon";
    return apiError(reason, horizon.resolved.reason, 400);
  }

  try {
    const { run, created } = await createRun(userId, horizon.mandate, body.idempotencyKey ?? null, {
      supersedes: body.supersedes ?? null,
    });
    // 201 either way: the run exists and this is its identity. A duplicate create
    // is a success, not a conflict — that is the whole point of the key.
    return NextResponse.json(
      { runId: run.id, status: run.status, stage: run.stage, created },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof OwnershipError) return apiError("forbidden", "Forbidden", 403);
    if (err instanceof RunConflictError) return apiError(err.reason, err.message, 409);
    throw err;
  }
});

export const POST = async (req: Request): Promise<Response> =>
  investmentResearchEnabled() ? handler(req) : apiError("not_found", "Not found", 404);
