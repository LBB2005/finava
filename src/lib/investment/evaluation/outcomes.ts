// Outcome resolution — turning a stored prediction into a scored one, or into a
// published reason why it could not be scored.
//
// The governing rule here is the same one live/evaluation.ts enforces for
// invalidation conditions, applied one level up: NOT KNOWING IS NOT AN OUTCOME.
// A prediction we cannot resolve must come back as `unresolved` with a named
// reason that a reader can count, because silent non-resolution is precisely how
// an inconvenient case disappears. The cases hardest to resolve — the delisting,
// the bankruptcy, the cash acquisition at a discount — are exactly the ones whose
// quiet omission would bias a track record upward. A survivorship-filtered hit
// rate looks excellent and means nothing.
//
// Four separate resolutions, four separate reasons
// -----------------------------------------------
// "Was it up", "did it beat SPY", "which scenario bucket", and "did the thesis
// break" are four different questions with four different failure modes. A price
// series can resolve the first and third while the benchmark series is missing,
// and the thesis question can be indeterminate while all three price questions
// resolve cleanly. Each target therefore carries its own status, and none of them
// is inferred from another.
//
// What the caller must supply, and why
// ------------------------------------
//  - CORPORATE-ACTION-ADJUSTED prices, declared as such. An unadjusted series
//    across a 4:1 split reads as a 75% loss, which would be recorded as a
//    catastrophic miss. We refuse rather than guess, because a split is not
//    detectable from two endpoints.
//  - EXPLICIT DISTRIBUTIONS, dated. Total return is the subject of the forecast,
//    and dropping dividends silently understates every income name. No
//    reinvestment is assumed, matching returns.ts.
//  - A MATCHED BENCHMARK WINDOW. Comparing eleven months of a stock to twelve
//    months of SPY is not an outperformance measurement, and the direction of the
//    error depends on the market — so it is not even a consistent bias. The
//    benchmark window must equal the subject's effective window exactly.
//
// When a corporate action ends the position early, BOTH windows end on the action
// date and the record says so. The alternative — holding the proceeds to the
// target date — requires a reinvestment or cash rate we do not have, and inventing
// one would move every resolution of every delisted name by an unstated amount.

import { z } from "zod";
import { classifyRealisedReturn } from "../scenarioBuckets";
import type { ScenarioId } from "../schemas";
import { ConditionStatusSchema } from "@/lib/schemas/live/evaluation";
import type { PredictionRecord } from "./predictions";

// ── Reasons ──────────────────────────────────────────────────────────────────

/**
 * Stable, machine-readable non-resolution reasons.
 *
 * Machine-readable because the point is to COUNT them: a cohort where 30% of the
 * rows are `missing_end_price` has a data problem, and one where 30% are
 * `corporate_action_proceeds_unknown` has a survivorship problem. An opaque
 * free-text reason would let both hide as "n/a".
 */
export const NON_RESOLUTION = {
  notMatured: "not_yet_matured",
  malformedData: "malformed_outcome_data",
  tickerMismatch: "ticker_mismatch",
  windowMismatch: "subject_window_mismatch",
  missingStartPrice: "missing_start_price",
  missingEndPrice: "missing_end_price",
  unadjustedPrices: "prices_not_corporate_action_adjusted",
  proceedsUnknown: "corporate_action_proceeds_unknown",
  zeroStartPrice: "start_price_not_positive",
  benchmarkMissing: "benchmark_series_missing",
  benchmarkWindowMismatch: "benchmark_window_mismatch",
  benchmarkUnadjusted: "benchmark_not_corporate_action_adjusted",
  noStoredBuckets: "no_stored_bucket_boundaries",
  bucketUnclassifiable: "realised_return_unclassifiable",
  noConditions: "no_invalidation_conditions",
  conditionsNotObserved: "invalidation_conditions_not_observed",
} as const;

export type NonResolutionReason = (typeof NON_RESOLUTION)[keyof typeof NON_RESOLUTION];

// ── Input contract ───────────────────────────────────────────────────────────

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

/**
 * A dated cash distribution per share.
 *
 * Ex-date, not pay-date: entitlement is what matters, and a holder buying at the
 * window's start close does not receive a distribution whose ex-date is that day.
 */
export const DistributionSchema = z.object({
  exDate: IsoDate,
  amountPerShare: z.number().min(0),
  kind: z.enum(["cash_dividend", "special_dividend", "return_of_capital"]),
});

/**
 * A corporate action that terminated the position before the target date.
 *
 * `proceedsPerShare` is the realised cash value per share on the effective date:
 * 0 for a wipeout, the offer price for a cash acquisition, the market value of
 * the share consideration for a stock deal. Null means the data source could not
 * tell us — which makes the name UNRESOLVABLE, and that is reported rather than
 * dropped. A dropped bankruptcy is a free win for the track record.
 */
export const CorporateActionSchema = z.object({
  kind: z.enum(["delisting", "bankruptcy", "cash_acquisition", "stock_acquisition", "merger"]),
  effectiveDate: IsoDate,
  proceedsPerShare: z.number().min(0).nullable(),
  detail: z.string(),
});

const PriceSeriesSchema = z.object({
  symbol: z.string().min(1),
  windowStart: IsoDate,
  windowEnd: IsoDate,
  /** Null when the provider had no price. Never 0 as a stand-in. */
  startPrice: z.number().nullable(),
  endPrice: z.number().nullable(),
  distributions: z.array(DistributionSchema),
  /**
   * The caller asserts the series is split- and spin-off-adjusted. Declared
   * rather than assumed: we cannot detect an unadjusted split from endpoints, so
   * an undeclared series is refused.
   */
  corporateActionAdjusted: z.boolean(),
  adjustmentSource: z.string().min(1),
});

export const InvalidationObservationSchema = z.object({
  conditionId: z.string().min(1),
  /** live's three-valued vocabulary, reused: indeterminate never means holding. */
  status: ConditionStatusSchema,
  observedOn: IsoDate.nullable(),
});

export const TotalReturnDataSchema = z.object({
  subject: PriceSeriesSchema,
  /** Null when no benchmark series was obtained. Blocks outperformance only. */
  benchmark: PriceSeriesSchema.nullable(),
  corporateAction: CorporateActionSchema.nullable(),
  /** One per condition named on the prediction. A missing one is not "holding". */
  invalidationObservations: z.array(InvalidationObservationSchema),
});
export type TotalReturnData = z.infer<typeof TotalReturnDataSchema>;

// ── Output contract ──────────────────────────────────────────────────────────

export type TargetOutcome<T> =
  | { status: "resolved"; value: T }
  | { status: "unresolved"; reason: NonResolutionReason; detail: string };

export interface ResolvedPrediction {
  predictionId: string;
  ticker: string;
  disposition: "selected" | "rejected";
  asOf: string;
  targetDate: string;
  /** Where the subject window actually ended — the action date when one intervened. */
  effectiveWindowEnd: string;
  horizonCount: number;
  horizonUnit: string;
  resolvedAt: string;

  /** Corporate-action-adjusted total return over the effective window. */
  realisedTotalReturn: number | null;
  benchmarkTotalReturn: number | null;
  /** Arithmetic difference, gross of costs. Null when either leg is missing. */
  excessReturn: number | null;
  /** Non-null when the position was terminated early, with what we know about it. */
  corporateAction: z.infer<typeof CorporateActionSchema> | null;

  targets: {
    positiveTotalReturn: TargetOutcome<0 | 1>;
    outperformBenchmark: TargetOutcome<0 | 1>;
    scenarioBucket: TargetOutcome<ScenarioId>;
    thesisInvalidation: TargetOutcome<0 | 1>;
  };

  /** The forecasts, carried forward so metrics.ts can pair them without a second read. */
  forecasts: PredictionRecord["forecasts"];
  /** "full" when all four resolved, "none" when none did. */
  coverage: "full" | "partial" | "none";
  /** Every reason, deduplicated — the publishable account of what could not be scored. */
  unresolvedReasons: NonResolutionReason[];
  versions: PredictionRecord["versions"];
  latencyMs: number | null;
  costUsd: number | null;
}

export type ResolutionResult =
  | { status: "resolved"; outcome: ResolvedPrediction }
  | { status: "unresolved"; reason: NonResolutionReason; detail: string };

// ── Helpers ──────────────────────────────────────────────────────────────────

function unresolved<T>(reason: NonResolutionReason, detail: string): TargetOutcome<T> {
  return { status: "unresolved", reason, detail };
}

function dayMs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

/**
 * Distributions the holder was entitled to over (start, end].
 *
 * Half-open at the start for the ex-date reason above, and inclusive at the end
 * so a distribution going ex on the final day is not lost. Half-open at both ends
 * would quietly shave a quarter's dividend off every annual holding period that
 * happens to end on an ex-date.
 */
function distributionsInWindow(
  distributions: readonly z.infer<typeof DistributionSchema>[],
  start: string,
  end: string
): number {
  const from = dayMs(start);
  const to = dayMs(end);
  let total = 0;
  for (const d of distributions) {
    const ex = dayMs(d.exDate);
    if (ex > from && ex <= to) total += d.amountPerShare;
  }
  return total;
}

/** (end + cash received − start) / start. No reinvestment, matching returns.ts. */
function totalReturn(startPrice: number, endValue: number, cash: number): number {
  return (endValue + cash - startPrice) / startPrice;
}

type SeriesResolution =
  | { status: "ok"; value: number }
  | { status: "unresolved"; reason: NonResolutionReason; detail: string };

/**
 * Resolve one leg's total return.
 *
 * `terminalValue` is supplied by the caller for a terminated position: the
 * proceeds stand in for a closing price, which is how a delisting at zero becomes
 * a clean −100% rather than a missing row.
 */
function resolveSeries(
  series: z.infer<typeof PriceSeriesSchema>,
  effectiveEnd: string,
  terminalValue: number | null,
  reasons: {
    unadjusted: NonResolutionReason;
    missingStart: NonResolutionReason;
    missingEnd: NonResolutionReason;
  }
): SeriesResolution {
  if (!series.corporateActionAdjusted) {
    return {
      status: "unresolved",
      reason: reasons.unadjusted,
      detail: `${series.symbol} series from ${series.adjustmentSource} is not declared corporate-action adjusted; an unadjusted split would be scored as a total loss`,
    };
  }
  if (series.startPrice === null) {
    return {
      status: "unresolved",
      reason: reasons.missingStart,
      detail: `${series.symbol} has no start price at ${series.windowStart}`,
    };
  }
  if (!(series.startPrice > 0)) {
    return {
      status: "unresolved",
      reason: NON_RESOLUTION.zeroStartPrice,
      detail: `${series.symbol} start price is ${series.startPrice}; a return needs a positive base`,
    };
  }

  const endValue = terminalValue ?? series.endPrice;
  if (endValue === null) {
    return {
      status: "unresolved",
      reason: reasons.missingEnd,
      detail: `${series.symbol} has no end value at ${effectiveEnd}`,
    };
  }

  const cash = distributionsInWindow(series.distributions, series.windowStart, effectiveEnd);
  return { status: "ok", value: totalReturn(series.startPrice, endValue, cash) };
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolve a matured prediction against outcome data, or publish why not.
 *
 * A whole-record `unresolved` return is reserved for the cases where the record
 * itself cannot be lined up with the data — the window is wrong, the ticker does
 * not match, the horizon has not closed. Everything else resolves per target, so
 * a missing benchmark costs us the outperformance question and nothing else.
 */
export function resolvePrediction(
  prediction: PredictionRecord,
  totalReturnData: unknown,
  options: { now?: Date } = {}
): ResolutionResult {
  const now = options.now ?? new Date();

  const parsed = TotalReturnDataSchema.safeParse(totalReturnData);
  if (!parsed.success) {
    return {
      status: "unresolved",
      reason: NON_RESOLUTION.malformedData,
      detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  const data = parsed.data;

  if (data.subject.symbol.toUpperCase() !== prediction.ticker.toUpperCase()) {
    return {
      status: "unresolved",
      reason: NON_RESOLUTION.tickerMismatch,
      detail: `prediction is for ${prediction.ticker}, data is for ${data.subject.symbol}`,
    };
  }

  const targetMs = dayMs(prediction.targetDate);
  if (Number.isNaN(targetMs) || now.getTime() < targetMs) {
    return {
      status: "unresolved",
      reason: NON_RESOLUTION.notMatured,
      detail: `target date ${prediction.targetDate} has not passed as of ${now.toISOString()}; scoring a partial window is look-ahead in reverse`,
    };
  }

  // The action date wins only when it precedes the target date. An action after
  // the horizon closed is irrelevant to this forecast and must not shorten it.
  const action = data.corporateAction;
  const actionEndsEarly =
    action !== null && dayMs(action.effectiveDate) < targetMs && dayMs(action.effectiveDate) > dayMs(prediction.asOf.slice(0, 10));
  const effectiveEnd = actionEndsEarly && action ? action.effectiveDate : prediction.targetDate;

  // The subject window must be the window we forecast over. A provider that
  // returned a different range answers a different question.
  if (data.subject.windowEnd !== effectiveEnd) {
    return {
      status: "unresolved",
      reason: NON_RESOLUTION.windowMismatch,
      detail: `subject window ends ${data.subject.windowEnd}, expected ${effectiveEnd}`,
    };
  }

  // A terminated position's terminal value is its proceeds. Unknown proceeds
  // leave the name unresolvable — reported, never dropped.
  let terminalValue: number | null = null;
  let proceedsUnknown = false;
  if (actionEndsEarly && action) {
    if (action.proceedsPerShare === null) proceedsUnknown = true;
    else terminalValue = action.proceedsPerShare;
  }

  const subjectResolution: SeriesResolution = proceedsUnknown
    ? {
        status: "unresolved",
        reason: NON_RESOLUTION.proceedsUnknown,
        detail: `${action?.kind} effective ${action?.effectiveDate}: proceeds per share unknown (${action?.detail}). Excluding this name would bias the record upward, so it is recorded unresolved.`,
      }
    : resolveSeries(data.subject, effectiveEnd, terminalValue, {
        unadjusted: NON_RESOLUTION.unadjustedPrices,
        missingStart: NON_RESOLUTION.missingStartPrice,
        missingEnd: NON_RESOLUTION.missingEndPrice,
      });

  const realisedTotalReturn = subjectResolution.status === "ok" ? subjectResolution.value : null;

  // ── Target 1: positive total return ────────────────────────────────────────
  const positiveTotalReturn: TargetOutcome<0 | 1> =
    subjectResolution.status === "ok"
      ? { status: "resolved", value: subjectResolution.value > 0 ? 1 : 0 }
      : unresolved(subjectResolution.reason, subjectResolution.detail);

  // ── Target 2: outperformance, on a matched window ──────────────────────────
  let benchmarkTotalReturn: number | null = null;
  let outperformBenchmark: TargetOutcome<0 | 1>;
  if (data.benchmark === null) {
    outperformBenchmark = unresolved(
      NON_RESOLUTION.benchmarkMissing,
      `no ${prediction.benchmark} series supplied; relative performance is unanswerable without one`
    );
  } else if (
    data.benchmark.windowStart !== data.subject.windowStart ||
    data.benchmark.windowEnd !== effectiveEnd
  ) {
    outperformBenchmark = unresolved(
      NON_RESOLUTION.benchmarkWindowMismatch,
      `benchmark window ${data.benchmark.windowStart}..${data.benchmark.windowEnd} does not match subject window ${data.subject.windowStart}..${effectiveEnd}; mismatched windows make the comparison meaningless in an unknown direction`
    );
  } else {
    const benchResolution = resolveSeries(data.benchmark, effectiveEnd, null, {
      unadjusted: NON_RESOLUTION.benchmarkUnadjusted,
      missingStart: NON_RESOLUTION.benchmarkMissing,
      missingEnd: NON_RESOLUTION.benchmarkMissing,
    });
    if (benchResolution.status !== "ok") {
      outperformBenchmark = unresolved(benchResolution.reason, benchResolution.detail);
    } else {
      benchmarkTotalReturn = benchResolution.value;
      outperformBenchmark =
        subjectResolution.status === "ok"
          ? {
              status: "resolved",
              value: subjectResolution.value - benchResolution.value > 0 ? 1 : 0,
            }
          : unresolved(subjectResolution.reason, subjectResolution.detail);
    }
  }

  // ── Target 3: scenario bucket, against the STORED boundaries ───────────────
  let scenarioBucket: TargetOutcome<ScenarioId>;
  if (prediction.buckets === null) {
    scenarioBucket = unresolved(
      NON_RESOLUTION.noStoredBuckets,
      "no boundaries were stored with this prediction; re-deriving them now would score the forecast against a question it was never asked"
    );
  } else if (subjectResolution.status !== "ok") {
    scenarioBucket = unresolved(subjectResolution.reason, subjectResolution.detail);
  } else {
    const bucket = classifyRealisedReturn(subjectResolution.value, {
      boundaries: prediction.buckets.boundaries,
    });
    scenarioBucket =
      bucket === null
        ? unresolved(
            NON_RESOLUTION.bucketUnclassifiable,
            `realised return ${subjectResolution.value} could not be classified`
          )
        : { status: "resolved", value: bucket };
  }

  // ── Target 4: thesis invalidation ──────────────────────────────────────────
  const thesisInvalidation = resolveThesis(prediction, data.invalidationObservations);

  const targets = {
    positiveTotalReturn,
    outperformBenchmark,
    scenarioBucket,
    thesisInvalidation,
  };

  const all = Object.values(targets);
  const resolvedCount = all.filter((t) => t.status === "resolved").length;
  const unresolvedReasons = Array.from(
    new Set(
      all
        .filter((t): t is { status: "unresolved"; reason: NonResolutionReason; detail: string } =>
          t.status === "unresolved"
        )
        .map((t) => t.reason)
    )
  );

  return {
    status: "resolved",
    outcome: {
      predictionId: prediction.id,
      ticker: prediction.ticker,
      disposition: prediction.disposition,
      asOf: prediction.asOf,
      targetDate: prediction.targetDate,
      effectiveWindowEnd: effectiveEnd,
      horizonCount: prediction.horizonCount,
      horizonUnit: prediction.horizonUnit,
      resolvedAt: now.toISOString(),
      realisedTotalReturn,
      benchmarkTotalReturn,
      excessReturn:
        realisedTotalReturn !== null && benchmarkTotalReturn !== null
          ? realisedTotalReturn - benchmarkTotalReturn
          : null,
      corporateAction: action,
      targets,
      forecasts: prediction.forecasts,
      coverage: resolvedCount === all.length ? "full" : resolvedCount === 0 ? "none" : "partial",
      unresolvedReasons,
      versions: prediction.versions,
      latencyMs: prediction.latencyMs,
      costUsd: prediction.costUsd,
    },
  };
}

/**
 * Did the thesis break?
 *
 * Every condition named on the prediction must have an observation. A condition
 * with no observation is NOT holding — that is live/evaluation.ts's rule, and
 * collapsing the two here would let a thesis nobody could check be recorded as
 * one that survived, which is the most flattering possible error.
 *
 * One breach is enough for a 1: invalidation conditions are disjunctive by
 * construction. A 0 requires every condition to have been observed holding.
 */
function resolveThesis(
  prediction: PredictionRecord,
  observations: readonly z.infer<typeof InvalidationObservationSchema>[]
): TargetOutcome<0 | 1> {
  if (prediction.invalidationConditions.length === 0) {
    return unresolved(
      NON_RESOLUTION.noConditions,
      "the prediction named no invalidation conditions, so there is nothing to resolve against"
    );
  }

  const byId = new Map(observations.map((o) => [o.conditionId, o]));
  if (observations.some((o) => o.status === "breached")) {
    return { status: "resolved", value: 1 };
  }

  const unobserved: string[] = [];
  for (const condition of prediction.invalidationConditions) {
    const observation = byId.get(condition.id);
    if (!observation || observation.status === "indeterminate") unobserved.push(condition.id);
  }
  if (unobserved.length > 0) {
    return unresolved(
      NON_RESOLUTION.conditionsNotObserved,
      `conditions not observed: ${unobserved.join(", ")}. Unobserved is not holding.`
    );
  }

  return { status: "resolved", value: 0 };
}

/**
 * Resolve a batch, keeping the non-resolutions.
 *
 * The unresolved list is returned rather than filtered away because the ratio of
 * the two is itself a finding: a cohort that resolves 60% of its rows cannot
 * support the same claims as one that resolves 98%, however good the 60% look.
 */
export function resolveBatch(
  pairs: readonly { prediction: PredictionRecord; data: unknown }[],
  options: { now?: Date } = {}
): {
  resolved: ResolvedPrediction[];
  unresolved: { predictionId: string; ticker: string; reason: NonResolutionReason; detail: string }[];
} {
  const resolved: ResolvedPrediction[] = [];
  const unresolvedRows: {
    predictionId: string;
    ticker: string;
    reason: NonResolutionReason;
    detail: string;
  }[] = [];

  for (const { prediction, data } of pairs) {
    const result = resolvePrediction(prediction, data, options);
    if (result.status === "resolved") resolved.push(result.outcome);
    else
      unresolvedRows.push({
        predictionId: prediction.id,
        ticker: prediction.ticker,
        reason: result.reason,
        detail: result.detail,
      });
  }

  return { resolved, unresolved: unresolvedRows };
}
