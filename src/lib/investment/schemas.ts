// Runtime contracts for investment research.
//
// Zod at every boundary, with TypeScript types inferred from it — so a model,
// a Firestore document and an HTTP client all fail in the same place for the same
// reason, rather than a bad number reaching the rating arithmetic and producing a
// confident Buy from nonsense.
//
// Two conventions that hold throughout:
//
//  1. RETURNS ARE FRACTIONS. 0.15 means 15%. Formatting to a percentage happens
//     once, in presentation. Mixing the two units is the classic way a 1,450%
//     expected return ships.
//
//  2. NULL MEANS UNKNOWN, NEVER ZERO. A missing weight is `null` and blocks a
//     rating; it is never quietly replaced with an equal-probability triple, and a
//     missing price is never 0. Same discipline as live/candidateFacts.ts.
//
// Note on `z.number()`: Zod 4 rejects NaN and Infinity by default, so the finite
// bounds this contract requires come for free — no `.finite()` needed.

import { z } from "zod";
import type { FactStandingKind } from "@/lib/live/asOf";

// ── Core scalars ─────────────────────────────────────────────────────────────

export const RatingSchema = z.enum(["buy", "watch", "avoid"]);
export type Rating = z.infer<typeof RatingSchema>;

/**
 * Whether the report has enough behind it to be read as a conclusion.
 * `insufficient_data` is a real, publishable outcome — see the rule below that a
 * provider outage must never become an investment Avoid.
 */
export const ReportStatusSchema = z.enum(["complete", "partial", "insufficient_data"]);
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

/**
 * Where a scenario probability came from. The whole point of this field is that
 * the four cases are NOT interchangeable:
 *
 *  - `fixed_prior`          a configured, uninformative default. Not a forecast.
 *  - `user_assigned`        the user set the weights themselves.
 *  - `model_unvalidated`    a model produced a distribution. Untested. Experimental.
 *  - `empirically_calibrated` measured against resolved predictions — and only
 *                           ever set alongside a calibration artifact reference.
 *
 * Nothing may promote a basis without the evidence that defines it. In
 * particular, a rubric score, an agreement percentage, or a confidence number is
 * not a probability of anything.
 */
export const ProbabilityBasisSchema = z.enum([
  "fixed_prior",
  "user_assigned",
  "model_unvalidated",
  "empirically_calibrated",
]);
export type ProbabilityBasis = z.infer<typeof ProbabilityBasisSchema>;

export const ScenarioIdSchema = z.enum(["bear", "base", "bull"]);
export type ScenarioId = z.infer<typeof ScenarioIdSchema>;

export const HorizonUnitSchema = z.enum(["calendar_months", "trading_days"]);

// ── Evidence standing: reused from Finava Live, not redeclared ────────────────

/**
 * Where a piece of evidence sits relative to the run's as-of cutoff.
 *
 * This vocabulary is Finava Live's (`live/asOf.ts`), deliberately reused rather
 * than redefined. `undated` is its own state because a source that will not say
 * when a figure is from is neither clean nor excludable — it is unverifiable, and
 * the record says so. Two vocabularies for that idea is how the property rots.
 */
export const EvidenceStandingSchema = z.enum(["clean", "undated", "post_asof"]);
export type EvidenceStanding = z.infer<typeof EvidenceStandingSchema>;

/**
 * Conversions to and from Live's `FactStandingKind`. They look like no-ops, and
 * that is the point: they only compile while the two sets are identical, so
 * adding a standing on either side breaks the build here instead of silently
 * diverging. Use them when stamping evidence via `stampFact`.
 */
export function toEvidenceStanding(kind: FactStandingKind): EvidenceStanding {
  return kind;
}
export function toFactStanding(standing: EvidenceStanding): FactStandingKind {
  return standing;
}

// ── Horizon ──────────────────────────────────────────────────────────────────

export const ResolvedHorizonSchema = z.object({
  count: z.number().int().positive(),
  unit: HorizonUnitSchema,
  /** True when the user named no horizon and a default was applied. */
  assumed: z.boolean(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "targetDate must be YYYY-MM-DD"),
  yearFraction: z.number().positive(),
  note: z.string().nullable(),
});
export type ResolvedHorizonContract = z.infer<typeof ResolvedHorizonSchema>;

// ── Evidence and claims ──────────────────────────────────────────────────────

export const EvidenceKindSchema = z.enum([
  "price",
  "financial",
  "filing",
  "news",
  "transcript",
  "derived",
]);

export const EvidenceItemSchema = z.object({
  id: z.string().min(1),
  ticker: z.string().min(1),
  kind: EvidenceKindSchema,
  source: z.string().min(1),
  url: z.string().nullable(),
  /** When the provider says the value is from. Null when it will not say. */
  publishedAt: z.string().nullable(),
  /** When WE read it. Always known, because we did the reading. */
  observedAt: z.string().min(1),
  /** The financial period a figure covers, e.g. "FY2025" or "Q2 2026". */
  period: z.string().nullable(),
  contentHash: z.string().min(1),
  excerpt: z.string(),
  standing: EvidenceStandingSchema,
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

/**
 * `kind` separates what a source SAYS from what an analyst concluded from it.
 * An inference presented with the visual authority of a reported fact is the
 * single most misleading thing this system could render.
 */
export const ClaimKindSchema = z.enum(["observed", "inference", "assumption"]);

export const ResearchClaimSchema = z.object({
  id: z.string().min(1),
  agent: z.string().min(1),
  ticker: z.string().min(1),
  text: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)),
  kind: ClaimKindSchema,
  direction: z.enum(["bull", "bear", "neutral"]),
});
export type ResearchClaim = z.infer<typeof ResearchClaimSchema>;

// ── Scenarios, weights, returns ──────────────────────────────────────────────

export const ValuationMethodSchema = z.enum([
  "forward_multiple",
  "fcff_dcf",
  "fcfe_dcf",
  "historical_range",
]);
export type ValuationMethod = z.infer<typeof ValuationMethodSchema>;

export const ScenarioValueSchema = z.object({
  id: ScenarioIdSchema,
  /** USD per share at the horizon. Zero is permitted — equity can go to zero. */
  priceAtHorizon: z.number().min(0),
  /** Cash per share over the horizon. No reinvestment is assumed. */
  distributionsPerShare: z.number().min(0),
  assumptionsRef: z.string().min(1),
  method: ValuationMethodSchema,
  evidenceIds: z.array(z.string().min(1)),
});
export type ScenarioValue = z.infer<typeof ScenarioValueSchema>;

/** Sum tolerance for a probability triple. Floating-point slack, not a fudge. */
export const WEIGHT_SUM_TOLERANCE = 1e-6;

export const ProbabilityTripleSchema = z
  .object({
    bear: z.number().min(0).max(1),
    base: z.number().min(0).max(1),
    bull: z.number().min(0).max(1),
  })
  .refine(
    (p) => Math.abs(p.bear + p.base + p.bull - 1) <= WEIGHT_SUM_TOLERANCE,
    { message: "scenario probabilities must sum to 1" }
  );
export type ProbabilityTriple = z.infer<typeof ProbabilityTripleSchema>;

export const ScenarioWeightsSchema = z
  .object({
    values: ProbabilityTripleSchema,
    basis: ProbabilityBasisSchema,
    /** The model that produced the distribution, when one did. */
    model: z.string().nullable(),
    /** Required — and only permitted — when basis is empirically_calibrated. */
    calibrationVersion: z.string().nullable(),
  })
  .refine(
    (w) => w.basis !== "empirically_calibrated" || w.calibrationVersion !== null,
    {
      message:
        "empirically_calibrated weights require a calibrationVersion referencing the artifact that measured them",
      path: ["calibrationVersion"],
    }
  )
  .refine((w) => w.basis === "empirically_calibrated" || w.calibrationVersion === null, {
    message: "calibrationVersion may only be set on empirically_calibrated weights",
    path: ["calibrationVersion"],
  });
export type ScenarioWeights = z.infer<typeof ScenarioWeightsSchema>;

export const ReturnEstimateSchema = z.object({
  /** Fraction over the whole horizon. 0.15 = 15%. */
  cumulative: z.number(),
  /**
   * The annualized equivalent of expected TERMINAL WEALTH — not expected CAGR,
   * and not shown for horizons under a year.
   */
  annualizedWealthEquivalent: z.number().nullable(),
  /** max(0, -bearReturn). Distinct from max possible loss and from drawdown. */
  bearScenarioLoss: z.number().min(0),
  scenarioReturns: z.object({
    bear: z.number(),
    base: z.number(),
    bull: z.number(),
  }),
});
export type ReturnEstimate = z.infer<typeof ReturnEstimateSchema>;
