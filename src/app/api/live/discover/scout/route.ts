// Step 4 — scout the universe down to a shortlist.
//
// Its own invocation with NOTHING else in it. A cold getFactorUniverse() fans
// ~500 tickers; even pre-warmed in step 1, pairing the scout with any other work
// is what pushes a step past Vercel's 300s. The chunking of this pipeline is not
// tidiness, it is the constraint the whole GitHub Actions design exists to solve.
//
// Calls runScoutAgent — the same function the chat Discover mode calls, with the
// same universe and the same prompt. That is the point: a shortlist the harness
// could not have produced for a real user proves nothing about the product.

import { NextResponse } from "next/server";
import { z } from "zod";
import { withHarness, runStep, easternDay } from "@/lib/live/harness";
import { runScoutAgent } from "@/agents/sub-agents/scout-agent";
import { collector } from "@/lib/live/collect";
import { planWaves } from "@/lib/discoveryRun";
import { apiError } from "@/lib/apiError";
import { logger } from "@/lib/logger";

const log = logger("live:scout");

export const maxDuration = 300;

const BodySchema = z.object({
  runId: z.string().min(1).optional(),
  /** The standing mandate query. Frozen with the mandate, not tuned per day. */
  query: z.string().min(1).max(500).optional(),
});

/**
 * The standing scout query.
 *
 * Fixed for the life of the run and stated in the public log. A query rewritten
 * day to day would be an unrecorded degree of freedom — the book would look like
 * it was picking names when it was really picking questions, and no amount of
 * outcome data could separate the two after the fact.
 */
/**
 * How many names reach the research waves.
 *
 * The deep tier's own default is twenty. Twelve is the deliberate figure: the
 * mandate admits at most three entries a day and the run debates four, so the
 * back half of a twenty-name shortlist was being researched to be discarded.
 * Narrowing here is the cheapest place to save — a name dropped before the
 * waves costs nothing, while a name dropped after them has already been paid
 * for. It does lean harder on the scout's ranking, which is the real trade.
 */
export const SHORTLIST_SIZE = 12;

export const STANDING_QUERY =
  "High-quality US-listed companies trading below what their fundamentals and " +
  "momentum justify, suitable for a concentrated long-biased book held weeks to months.";

export const POST = withHarness(async (req) => {
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return apiError("validation_error", "Invalid body", 400, z.flattenError(parsed.error));
  }

  const tradingDay = easternDay();
  const runId = parsed.data.runId ?? tradingDay;
  const query = parsed.data.query ?? STANDING_QUERY;

  const { result, replayed } = await runStep(runId, "scout", async () => {
    const { emit, collected } = collector();
    await runScoutAgent({ query, tier: "deep", limit: SHORTLIST_SIZE }, emit);

    // Deep tier emits deep_shortlist. A clarify event means the scout judged the
    // query too vague — for a FIXED standing query that is a bug in the query,
    // not a question to answer, so it fails the step loudly.
    const clarify = collected.first("discover_clarify");
    if (clarify) {
      throw new Error(
        `Scout asked for clarification on the standing query — the query needs fixing, ` +
          `not answering: ${clarify.questions.map((q) => q.question).join(" / ")}`
      );
    }

    const shortlist = collected.first("deep_shortlist");
    if (!shortlist) {
      throw new Error("Scout produced no shortlist");
    }

    const waves = planWaves(shortlist.picks);
    log.info("scout complete", { runId, picks: shortlist.picks.length, waves: waves.length });

    return {
      runId,
      tradingDay,
      query,
      interpretation: shortlist.interpretation,
      picks: shortlist.picks,
      totalWaves: waves.length,
    };
  });

  return NextResponse.json({ ...result, replayed });
});
