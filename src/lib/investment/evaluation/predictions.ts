// Prediction capture — writing down what we forecast, before we could know.
//
// This module is the foundation the rest of the evaluation stack stands on, and
// it is worth being blunt about why it exists. A track record assembled after the
// fact is not a track record. If the forecast is written down only for the names
// we liked, and only once the outcome is visible, then every number computed from
// it is a statement about our memory rather than about our skill. So:
//
//  1. A PREDICTION IS ONLY A PREDICTION IF IT IS STORED BEFORE ITS TARGET DATE.
//     `savePredictions` refuses a record whose target date has already arrived.
//     That refusal is not defensive programming; it is the property that makes
//     the whole ledger worth reading. Backfilling one row would invalidate every
//     calibration number the system could ever publish, because a reader can no
//     longer tell which rows were honest.
//
//  2. REJECTED CANDIDATES ARE STORED TOO. Evaluating only the names the process
//     selected is how a selection process flatters itself: if the rejects
//     outperform, a selected-only record shows a fine hit rate and hides the fact
//     that the screen is inverted. The disposition (`selected` / `rejected`) is a
//     FIELD, not a filter on what gets written.
//
//  3. THE FOUR TARGETS ARE FORECAST SEPARATELY. "Will it be up", "will it beat
//     SPY", "which scenario bucket", and "will the thesis break" are four
//     different questions. A single probability cannot answer all four, so each
//     has its own nullable field, and `null` means "no probability was forecast
//     for this target" — never "infer it from one of the others". metrics.ts will
//     only score a target where an actual probability exists.
//
//  4. THE QUESTION IS VERSIONED WITH THE ANSWER. Target definitions and the
//     scenario bucket boundaries are stored ON the record. Re-deriving boundaries
//     at resolution time would score a forecast against a question it was never
//     asked (see scenarioBuckets.ts, which stores them for the same reason).
//
// This infrastructure ships NOW, years before any outcome cohort matures, because
// the data cannot be collected retroactively. Nothing here computes or licenses a
// calibration CLAIM — that gate lives in calibration.ts.

import { createHash } from "node:crypto";
import { z } from "zod";
import { ScenarioBucketsSchema } from "../contracts";
import {
  HorizonUnitSchema,
  ProbabilityBasisSchema,
  ProbabilityTripleSchema,
  RatingSchema,
} from "../schemas";

// ── Versioned question definitions ───────────────────────────────────────────

/**
 * The definitions of the four targets, as a version string stamped onto every
 * record. Changing what "outperformance" means — gross vs net of fees, close vs
 * VWAP, SPY price return vs SPY total return — changes the question, so it must
 * change this string rather than silently re-interpret stored rows.
 */
export const TARGET_DEFINITIONS_VERSION = "investment_targets_v1";

/**
 * The bucket convention in force when this prediction was made: midpoints
 * between strictly ordered scenario returns, half-open intervals, bear below the
 * lower boundary and bull at or above the upper one. Stored alongside the
 * boundaries themselves so a future convention change is detectable rather than
 * retroactive.
 */
export const BUCKET_POLICY_VERSION = "scenario_buckets_midpoint_v1";

export const PREDICTION_TARGETS = {
  positiveTotalReturn: {
    id: "positive_total_return",
    kind: "binary",
    definition:
      "Corporate-action-adjusted total return of the subject over [asOf, targetDate] is strictly greater than zero.",
  },
  outperformBenchmark: {
    id: "outperform_benchmark",
    kind: "binary",
    definition:
      "Subject total return minus benchmark total return over the SAME window is strictly greater than zero. Arithmetic difference, gross of costs and taxes.",
  },
  scenarioBucket: {
    id: "scenario_bucket",
    kind: "categorical",
    definition:
      "Which of bear / base / bull the realised total return fell into, against the boundaries stored on this record.",
  },
  thesisInvalidation: {
    id: "thesis_invalidation",
    kind: "binary",
    definition:
      "At least one of the named invalidation conditions was observed to fire on or before the target date. An unobservable condition resolves as indeterminate, never as holding.",
  },
} as const;

export type PredictionTargetKey = keyof typeof PREDICTION_TARGETS;

// ── Record shape ─────────────────────────────────────────────────────────────

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const Probability = z.number().min(0).max(1);

/**
 * The four forecasts, each independently nullable.
 *
 * A null is a first-class answer: it says the system declined to put a number on
 * this question. Filling one in from another — deriving P(beats SPY) from
 * P(up), say — would fabricate a forecast and then score ourselves on it.
 */
export const ForecastSetSchema = z.object({
  positiveTotalReturn: Probability.nullable(),
  outperformBenchmark: Probability.nullable(),
  /** The full bucket distribution, not a single number. */
  scenarioBucket: ProbabilityTripleSchema.nullable(),
  thesisInvalidation: Probability.nullable(),
});
export type ForecastSet = z.infer<typeof ForecastSetSchema>;

/**
 * Where the forecast came from, carried so a calibration table can be segmented
 * by it. A `model_unvalidated` row and an `empirically_calibrated` row must never
 * be pooled: the second claims to have been measured and the first does not.
 */
export const ForecastProvenanceSchema = z
  .object({
    basis: ProbabilityBasisSchema,
    /** The model that produced the distribution, when one did. */
    model: z.string().nullable(),
    /** Only ever set — and required — when basis is empirically_calibrated. */
    calibrationVersion: z.string().nullable(),
    /** Fingerprint of the agent configuration; see live/promptHash.ts. */
    promptHash: z.string().nullable(),
  })
  .refine((p) => p.basis !== "empirically_calibrated" || p.calibrationVersion !== null, {
    message:
      "empirically_calibrated forecasts require a calibrationVersion referencing the artifact that measured them",
    path: ["calibrationVersion"],
  })
  .refine((p) => p.basis === "empirically_calibrated" || p.calibrationVersion === null, {
    message: "calibrationVersion may only be set on empirically_calibrated forecasts",
    path: ["calibrationVersion"],
  });

/**
 * A named invalidation condition, copied onto the prediction.
 *
 * Copied rather than referenced because a thesis edited after the fact would
 * otherwise quietly change what "the thesis broke" meant. Resolution reads these.
 */
export const InvalidationConditionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
});

export const PredictionRecordSchema = z
  .object({
    id: z.string().min(1),
    ownerUid: z.string().min(1),
    /** The report this forecast came from. Null for a rejected candidate that never produced one. */
    reportId: z.string().nullable(),
    snapshotId: z.string().min(1),
    ticker: z.string().min(1),

    /** Selected or rejected — a field, never a filter on what gets stored. */
    disposition: z.enum(["selected", "rejected"]),
    rating: RatingSchema,
    /** Why it was rejected. Required when rejected, so the reject arm is analysable. */
    reasonCodes: z.array(z.string()),

    /** The run's as-of instant: the moment after which nothing was knowable. */
    asOf: z.string().min(1),
    /** The date the forecast is about. Must be strictly after asOf. */
    targetDate: IsoDate,
    horizonCount: z.number().int().positive(),
    horizonUnit: HorizonUnitSchema,
    yearFraction: z.number().positive(),
    benchmark: z.literal("SPY"),

    forecasts: ForecastSetSchema,
    /** The boundaries the bucket probabilities were asked against. Stored, never re-derived. */
    buckets: ScenarioBucketsSchema.nullable(),
    /** Expected cumulative total return, for point-error reporting. Null when unavailable. */
    expectedTotalReturn: z.number().nullable(),
    /** The three scenario returns, kept so a resolution can be audited by hand. */
    scenarioReturns: z
      .object({ bear: z.number(), base: z.number(), bull: z.number() })
      .nullable(),

    invalidationConditions: z.array(InvalidationConditionSchema),
    provenance: ForecastProvenanceSchema,

    versions: z.object({
      targetDefinitions: z.string().min(1),
      bucketPolicy: z.string().min(1),
      policyVersion: z.string().min(1),
      valuationVersion: z.string().min(1),
      agentVersion: z.string().min(1),
    }),

    /** Wall-clock milliseconds the producing run took. Null when not measured. */
    latencyMs: z.number().min(0).nullable(),
    /** Measured spend, not an estimate. Null when a provider would not report it. */
    costUsd: z.number().min(0).nullable(),
    createdAt: z.string().min(1),
  })
  .refine((r) => r.disposition !== "rejected" || r.reasonCodes.length > 0, {
    message: "a rejected candidate must record why it was rejected",
    path: ["reasonCodes"],
  })
  .refine((r) => r.forecasts.scenarioBucket === null || r.buckets !== null, {
    message:
      "a scenario bucket forecast without stored boundaries is unresolvable — the question would have to be re-derived later",
    path: ["buckets"],
  })
  .refine((r) => r.forecasts.thesisInvalidation === null || r.invalidationConditions.length > 0, {
    message:
      "a thesis-invalidation probability with no named conditions can never be resolved against anything",
    path: ["invalidationConditions"],
  });
export type PredictionRecord = z.infer<typeof PredictionRecordSchema>;

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * Deterministic document id.
 *
 * Deterministic so that a retried write collides instead of creating a second,
 * subtly different copy of the same forecast — duplicate rows would double-count
 * that name in every aggregate. The target-definitions version is in the hash
 * because the same run under a changed question genuinely is a different
 * prediction.
 */
export function predictionDocId(parts: {
  ownerUid: string;
  snapshotId: string;
  ticker: string;
  targetDate: string;
  targetDefinitionsVersion?: string;
}): string {
  return createHash("sha256")
    .update(parts.ownerUid)
    .update("|")
    .update(parts.snapshotId)
    .update("|")
    .update(parts.ticker.toUpperCase())
    .update("|")
    .update(parts.targetDate)
    .update("|")
    .update(parts.targetDefinitionsVersion ?? TARGET_DEFINITIONS_VERSION)
    .digest("hex")
    .slice(0, 32);
}

// ── Persistence boundary ─────────────────────────────────────────────────────

/** Thrown by a store when the doc id already exists. A replay, not a failure. */
export class PredictionConflictError extends Error {
  constructor(readonly docId: string) {
    super(`prediction ${docId} already exists — the prediction log is append-only`);
    this.name = "PredictionConflictError";
  }
}

/**
 * The narrow persistence surface this module needs, injected rather than
 * imported.
 *
 * Deliberately three methods over a Firestore-shaped interface: tests get a
 * dictionary-backed fake with no emulator, no credentials and no network, and the
 * append-only rule becomes a property of this contract instead of a convention
 * each call site has to remember.
 */
export interface PredictionStore {
  /** Must throw PredictionConflictError when docId exists. Never overwrite. */
  create(docId: string, record: PredictionRecord): Promise<void>;
  get(docId: string): Promise<PredictionRecord | null>;
  /** Every prediction whose targetDate is on or before `onOrBefore` (YYYY-MM-DD). */
  listMatured(onOrBefore: string): Promise<PredictionRecord[]>;
}

// ── Building ─────────────────────────────────────────────────────────────────

export interface PredictionInput {
  ownerUid: string;
  reportId: string | null;
  snapshotId: string;
  ticker: string;
  disposition: "selected" | "rejected";
  rating: z.infer<typeof RatingSchema>;
  reasonCodes: readonly string[];
  asOf: string;
  targetDate: string;
  horizonCount: number;
  horizonUnit: z.infer<typeof HorizonUnitSchema>;
  yearFraction: number;
  forecasts: ForecastSet;
  buckets: { boundaries: [number, number] } | null;
  expectedTotalReturn: number | null;
  scenarioReturns: { bear: number; base: number; bull: number } | null;
  invalidationConditions: readonly { id: string; description: string }[];
  provenance: z.infer<typeof ForecastProvenanceSchema>;
  policyVersion: string;
  valuationVersion: string;
  agentVersion: string;
  latencyMs: number | null;
  costUsd: number | null;
  createdAt: string;
}

export type BuildResult =
  | { status: "ok"; record: PredictionRecord }
  | { status: "invalid"; reason: string };

/**
 * Validate and stamp one prediction. Pure — no clock, no store.
 *
 * Validation happens here rather than at the store so a malformed forecast is
 * rejected before it can occupy an id: a half-written row in an append-only log
 * cannot be corrected, only annotated.
 */
export function buildPredictionRecord(input: PredictionInput): BuildResult {
  const candidate = {
    id: predictionDocId(input),
    ownerUid: input.ownerUid,
    reportId: input.reportId,
    snapshotId: input.snapshotId,
    ticker: input.ticker.toUpperCase(),
    disposition: input.disposition,
    rating: input.rating,
    reasonCodes: [...input.reasonCodes],
    asOf: input.asOf,
    targetDate: input.targetDate,
    horizonCount: input.horizonCount,
    horizonUnit: input.horizonUnit,
    yearFraction: input.yearFraction,
    benchmark: "SPY" as const,
    forecasts: input.forecasts,
    buckets: input.buckets,
    expectedTotalReturn: input.expectedTotalReturn,
    scenarioReturns: input.scenarioReturns,
    invalidationConditions: input.invalidationConditions.map((c) => ({ ...c })),
    provenance: input.provenance,
    versions: {
      targetDefinitions: TARGET_DEFINITIONS_VERSION,
      bucketPolicy: BUCKET_POLICY_VERSION,
      policyVersion: input.policyVersion,
      valuationVersion: input.valuationVersion,
      agentVersion: input.agentVersion,
    },
    latencyMs: input.latencyMs,
    costUsd: input.costUsd,
    createdAt: input.createdAt,
  };

  const parsed = PredictionRecordSchema.safeParse(candidate);
  if (!parsed.success) {
    return { status: "invalid", reason: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  return { status: "ok", record: parsed.data };
}

// ── Saving ───────────────────────────────────────────────────────────────────

export type SaveStatus = "saved" | "duplicate" | "refused";

export interface SaveOutcome {
  ticker: string;
  docId: string | null;
  status: SaveStatus;
  /** Populated for `duplicate` and `refused`. Always reported, never swallowed. */
  reason: string | null;
}

/** Midnight UTC of a YYYY-MM-DD date, in ms. */
function dayStartMs(date: string): number | null {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Persist a batch of predictions — selected and rejected alike.
 *
 * Three rails, in order:
 *
 *  - The target date must be strictly AFTER the as-of the forecast was made
 *    under. A "prediction" about a window that has already begun to resolve is a
 *    description.
 *  - The target date must not have arrived yet as of `now`. This is what stops a
 *    late write from entering the log as though it had been made on time.
 *  - A duplicate id is reported as `duplicate`, not silently ignored and not
 *    overwritten, because both of those hide a producer bug.
 *
 * Failures are returned per record rather than thrown, so one bad candidate does
 * not discard the rest of a run's forecasts. Nothing is dropped quietly: every
 * record comes back with a status and, when it was not saved, a reason.
 */
export async function savePredictions(
  store: PredictionStore,
  records: readonly PredictionRecord[],
  options: { now: Date }
): Promise<SaveOutcome[]> {
  const nowMs = options.now.getTime();
  const outcomes: SaveOutcome[] = [];

  for (const record of records) {
    const target = dayStartMs(record.targetDate);
    const asOfMs = Date.parse(record.asOf);

    if (target === null || Number.isNaN(asOfMs)) {
      outcomes.push({
        ticker: record.ticker,
        docId: null,
        status: "refused",
        reason: "unparseable asOf or targetDate",
      });
      continue;
    }
    if (target <= asOfMs) {
      outcomes.push({
        ticker: record.ticker,
        docId: null,
        status: "refused",
        reason: `targetDate ${record.targetDate} is not after asOf ${record.asOf}`,
      });
      continue;
    }
    if (nowMs >= target) {
      outcomes.push({
        ticker: record.ticker,
        docId: null,
        status: "refused",
        reason: `targetDate ${record.targetDate} has already arrived — a prediction stored at or after its target date is not a prediction`,
      });
      continue;
    }

    try {
      await store.create(record.id, record);
      outcomes.push({ ticker: record.ticker, docId: record.id, status: "saved", reason: null });
    } catch (error) {
      if (error instanceof PredictionConflictError) {
        outcomes.push({
          ticker: record.ticker,
          docId: record.id,
          status: "duplicate",
          reason: error.message,
        });
        continue;
      }
      throw error;
    }
  }

  return outcomes;
}

/**
 * Whether a prediction's window has closed, which is the only condition under
 * which outcomes.ts is allowed to look at it.
 *
 * Reading a prediction early and scoring it on a partial window would import
 * exactly the look-ahead the as-of machinery exists to prevent, in the opposite
 * direction: a name down 30% at month six of a twelve-month call is not a miss.
 */
export function isMatured(record: PredictionRecord, now: Date): boolean {
  const target = dayStartMs(record.targetDate);
  if (target === null) return false;
  return now.getTime() >= target;
}
