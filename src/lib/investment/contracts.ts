// Cross-module contracts for investment research.
//
// This file exists so independently-built stages agree without importing each
// other: valuation, evidence, persistence, discovery and evaluation all depend on
// these shapes and not on one another's internals. Treat it as frozen — widening
// a type here ripples into every stage, so prefer adding a new field over
// changing an existing one's meaning.
//
// The scalar contracts (Rating, ScenarioValue, ScenarioWeights, ReturnEstimate,
// EvidenceItem, ResearchClaim) live in ./schemas. This file composes them into
// the documents that get persisted and rendered.

import { z } from "zod";
import {
  EvidenceItemSchema,
  ProbabilityBasisSchema,
  RatingSchema,
  ReportStatusSchema,
  ResearchClaimSchema,
  ResolvedHorizonSchema,
  ReturnEstimateSchema,
  ScenarioValueSchema,
  ScenarioWeightsSchema,
  ValuationMethodSchema,
} from "./schemas";

// ── Mandate ──────────────────────────────────────────────────────────────────

/**
 * What the user asked for, resolved. One mandate per run; hashed into the cache
 * key so changing any of it produces a new run rather than reusing a report that
 * answered a different question.
 */
export const ResearchMandateSchema = z.object({
  mode: z.enum(["analyze", "discover"]),
  query: z.string(),
  /** Null in discover mode, where the universe is screened rather than named. */
  ticker: z.string().nullable(),
  horizon: ResolvedHorizonSchema,
  benchmark: z.literal("SPY"),
  universeVersion: z.string(),
  /** Hard screen limits. Validated at the edge; opaque here to avoid a cycle. */
  hardFilter: z.record(z.string(), z.unknown()).nullable(),
  qualitativeCriteria: z.array(z.string()),
});
export type ResearchMandate = z.infer<typeof ResearchMandateSchema>;

// ── Snapshot ─────────────────────────────────────────────────────────────────

/** A source that was asked for and could not be obtained. Never silently dropped. */
export const SourceGapSchema = z.object({
  source: z.string(),
  field: z.string(),
  /** Why it is missing: an outage is not the same as "the company has none". */
  reason: z.enum(["unavailable", "rate_limited", "not_covered", "unauthorized", "stale"]),
  detail: z.string(),
});
export type SourceGap = z.infer<typeof SourceGapSchema>;

/**
 * The frozen information set a report was produced from.
 *
 * Frozen BEFORE any analyst judgment, so a later filing produces a new snapshot
 * rather than silently revising an old report. `contentHash` is what makes two
 * runs comparable, and `asOf` is the single cutoff every piece of evidence is
 * stamped against (see live/asOf.ts).
 */
export const ResearchSnapshotSchema = z.object({
  id: z.string().min(1),
  ownerUid: z.string().min(1),
  ticker: z.string().min(1),
  /** ISO instant. One per run, read by every later stage. */
  asOf: z.string().min(1),
  mandate: ResearchMandateSchema,
  evidence: z.array(EvidenceItemSchema),
  gaps: z.array(SourceGapSchema),
  /** Fraction of enumerated required inputs present, per valuation method. */
  coverage: z.record(z.string(), z.number().min(0).max(1)),
  contentHash: z.string().min(1),
  createdAt: z.string().min(1),
});
export type ResearchSnapshot = z.infer<typeof ResearchSnapshotSchema>;

// ── Valuation ────────────────────────────────────────────────────────────────

/** A named, missing input. The counterpart of never defaulting one to zero. */
export const ValuationGapSchema = z.object({
  field: z.string(),
  detail: z.string(),
});

export const ValuationOutcomeSchema = z.object({
  method: ValuationMethodSchema,
  /** Empty only when the method ran on complete inputs. */
  gaps: z.array(ValuationGapSchema),
  /** Null when the gaps prevented a value. Never a placeholder. */
  scenarios: z.array(ScenarioValueSchema).nullable(),
  /** Inputs that stood in for a better source, e.g. OCF used as FCF. */
  proxies: z.array(z.string()),
  /** criticalCoverage for the method actually used, as decision.ts consumes it. */
  criticalCoverage: z.number().min(0).max(1),
  valuationVersion: z.string().min(1),
  /**
   * The per-share price this valuation measured FROM, as of the run's cutoff.
   *
   * Recorded because it cannot be recovered later: `EvidenceItem` persists a
   * source and a standing but not the value, and re-fetching would substitute
   * today's price for the one the scenarios were computed against — which would
   * silently change every return in the report and make the prediction
   * unresolvable against what was actually forecast.
   *
   * Three states, deliberately: a number is the measured price, `null` means the
   * price was unavailable, and `undefined` means this producer did not record one.
   * Optional so the many existing construction sites keep compiling.
   */
  priceAtAsOf: z.number().positive().nullable().optional(),
});
export type ValuationOutcome = z.infer<typeof ValuationOutcomeSchema>;

// ── Report ───────────────────────────────────────────────────────────────────

/** The bucket boundaries a scenario probability was asked against. Stored, not re-derived. */
export const ScenarioBucketsSchema = z.object({
  boundaries: z.tuple([z.number(), z.number()]),
});

export const ReportVersionsSchema = z.object({
  policyVersion: z.string().min(1),
  valuationVersion: z.string().min(1),
  questionSetVersion: z.string().nullable(),
  agentVersion: z.string().min(1),
});

/**
 * The persisted result. Immutable once `status` leaves "pending": a refresh makes
 * a new report linked to this one.
 *
 * Every number here came from deterministic code. The narrative field explains
 * this document and cannot alter it — if a reviewer finds a numeric defect, the
 * responsible stage is re-run rather than the prose edited.
 */
export const InvestmentReportSchema = z.object({
  id: z.string().min(1),
  ownerUid: z.string().min(1),
  snapshotId: z.string().min(1),
  ticker: z.string().min(1),
  status: ReportStatusSchema,
  rating: RatingSchema,
  reasonCodes: z.array(z.string()),
  /** The hurdle this horizon was judged against. Null when gates blocked it. */
  hurdle: z.number().nullable(),
  /** True while the rating rests on weights nothing has tested. */
  experimental: z.boolean(),
  valuation: ValuationOutcomeSchema,
  scenarios: z.array(ScenarioValueSchema).nullable(),
  weights: ScenarioWeightsSchema.nullable(),
  returns: ReturnEstimateSchema.nullable(),
  buckets: ScenarioBucketsSchema.nullable(),
  claims: z.array(ResearchClaimSchema),
  /** Disagreements left unresolved. Kept, never smoothed away. */
  dissent: z.array(z.string()),
  probabilityBasis: ProbabilityBasisSchema,
  versions: ReportVersionsSchema,
  /** Measured, not estimated. Null when a provider would not report it. */
  costUsd: z.number().nullable(),
  /**
   * The as-of price the report was measured from, mirrored from the valuation so
   * the card and the outcome resolver do not have to reach through it.
   */
  priceAtAsOf: z.number().positive().nullable().optional(),
  completedAt: z.string().nullable(),
});
export type InvestmentReport = z.infer<typeof InvestmentReportSchema>;

// ── Runs ─────────────────────────────────────────────────────────────────────

/**
 * Stages, in order. A run advances one bounded stage per request so no single
 * HTTP call has to outlive a serverless timeout.
 */
export const RUN_STAGES = [
  "snapshot",
  "research",
  "valuation",
  "scenarios",
  "decision",
  "complete",
] as const;
export const RunStageSchema = z.enum(RUN_STAGES);
export type RunStage = (typeof RUN_STAGES)[number];

export const RunStatusSchema = z.enum([
  "pending",
  "running",
  /** No runner is advancing it. Shown as paused; never promised as background work. */
  "paused",
  "complete",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const InvestmentRunSchema = z.object({
  id: z.string().min(1),
  ownerUid: z.string().min(1),
  mandate: ResearchMandateSchema,
  stage: RunStageSchema,
  status: RunStatusSchema,
  snapshotId: z.string().nullable(),
  reportId: z.string().nullable(),
  /** Set by the caller so a retried create returns the same run. */
  idempotencyKey: z.string().nullable(),
  /** Held while a stage is advancing, so two callers cannot both run it. */
  leaseUntil: z.string().nullable(),
  gaps: z.array(z.string()),
  /** Credits spent so far, persisted BETWEEN requests — see live/budget.ts. */
  creditsSpent: z.number().min(0),
  error: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  /** The run this one refreshes, if any. Reports are never mutated in place. */
  supersedes: z.string().nullable(),
});
export type InvestmentRun = z.infer<typeof InvestmentRunSchema>;

// ── Cache identity ───────────────────────────────────────────────────────────

/**
 * Everything that must match for a stored report to be reusable.
 *
 * Horizon is in here because a 24-month answer is not a 12-month answer, and the
 * version fields are in here because changing a threshold or a valuation
 * semantic must invalidate rather than silently re-rate yesterday's reports.
 * Owner is included so private context can never leak through a shared key.
 */
export interface DecisionCacheKey {
  ticker: string;
  horizonCount: number;
  horizonUnit: string;
  snapshotHash: string;
  mandateHash: string;
  policyVersion: string;
  valuationVersion: string;
  questionSetVersion: string | null;
  agentVersion: string;
  ownerUid: string;
}
