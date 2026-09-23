// Calibration — the machinery that could one day license a probability claim, and
// the gate that stops us making one before it can.
//
// Everything in this file is PROTOTYPE infrastructure. It exists now because
// calibration data cannot be collected retroactively: if the prediction log is not
// running today, the earliest honest claim moves further away, not closer. But the
// same reasoning means the claim itself must be impossible to make early, so the
// promotion path is guarded rather than documented.
//
// FOUR RULES, in descending order of how badly violating them would mislead.
//
//  1. PRODUCTION KEEPS RAW MODEL WEIGHTS UNTIL AN ARTIFACT PASSES A PREDECLARED
//     HELD-OUT PROTOCOL. `promoteProbabilityBasis` is the only route to
//     `empirically_calibrated`, it requires an artifact marked eligible, and
//     `ScenarioWeightsSchema` independently refuses the basis without a
//     `calibrationVersion`. Two locks, because this is the field that converts
//     "a model said 65%" into "65% of these happen".
//
//  2. SPLITS ARE CHRONOLOGICAL, NEVER RANDOM. A random split puts a June forecast
//     in train and an overlapping May forecast in validation; the two share most of
//     a market, so the validation score measures memorisation of a period rather
//     than out-of-sample skill. There is no random-split function here, on purpose.
//     `chronologicalSplit` also PURGES train rows whose horizon extends past the
//     cutoff, because their outcomes were not knowable at the split point.
//
//  3. 200 MATURED PREDICTIONS PER HORIZON COHORT IS A GATE, NOT PROOF. It is a
//     floor chosen so that a cohort cannot be scored on a handful of rows. It is
//     NOT a power calculation and it does NOT establish statistical adequacy:
//     200 twelve-month predictions issued monthly on overlapping windows may carry
//     the independent information of fifteen or twenty observations
//     (see metrics.ts `independenceDiagnostics`). Passing the gate means "we are
//     allowed to look", not "the number is trustworthy".
//
//  4. ANY HISTORICAL BACKTEST RUN THROUGH CURRENT LLMS IS LABELLED POTENTIALLY
//     HINDSIGHT-CONTAMINATED, and a contaminated artifact can never be eligible for
//     production. Date-filtering the retrieved evidence does NOT fix this. The
//     as-of rails control what we HAND the model; they cannot control what the model
//     already read in training. A 2026-vintage model asked about NVDA in 2023 may
//     simply remember what happened, and there is no filter on memory. A backtest
//     is therefore a debugging tool for the pipeline, never evidence of forecasting
//     skill.

import { createHash } from "node:crypto";
import { z } from "zod";
import { ProbabilityTripleSchema, ScenarioWeightsSchema, type ProbabilityBasis } from "../schemas";
import { brierScore, independenceDiagnostics, type IndependenceDiagnostics } from "./metrics";
import { isMatured, type PredictionRecord } from "./predictions";
import type { ResolvedPrediction } from "./outcomes";

/**
 * Matured predictions required in a horizon cohort before it may be scored at all.
 *
 * A GATE, NOT PROOF — see rule 3 in the header. Raising it would not turn it into
 * proof either; only the clustered effective sample size speaks to that, and it is
 * reported alongside every cohort so the difference stays visible.
 */
export const MIN_MATURED_PER_COHORT = 200;

/** Effective (clustered) observations before an arm comparison may be ordered. */
export const MIN_EFFECTIVE_FOR_ARM_COMPARISON = 100;

// ── Cohorts ──────────────────────────────────────────────────────────────────

/**
 * Cohort identity: the horizon. A three-month forecast and a three-year forecast
 * are not the same forecasting problem and their errors are not poolable — pooling
 * them would let a large, easy cohort carry a small, hard one.
 */
export function cohortKey(record: Pick<PredictionRecord, "horizonCount" | "horizonUnit">): string {
  return `${record.horizonCount}_${record.horizonUnit}`;
}

export interface CohortStatus {
  cohort: string;
  total: number;
  matured: number;
  required: number;
  /** matured >= required. Permission to compute, not evidence of adequacy. */
  gatePassed: boolean;
  independence: IndependenceDiagnostics;
  note: string;
}

/**
 * Cohort readiness. Honest about immaturity rather than scoring what has arrived.
 *
 * An immature cohort returns `gatePassed: false` and a count — not a Brier score
 * computed over the forty rows that happen to have matured, which would be
 * systematically biased toward whatever the market did in the earliest window.
 */
export function assessCohorts(
  records: readonly PredictionRecord[],
  options: { now: Date; minMatured?: number }
): CohortStatus[] {
  const required = options.minMatured ?? MIN_MATURED_PER_COHORT;
  const groups = new Map<string, PredictionRecord[]>();
  for (const record of records) {
    const key = cohortKey(record);
    const list = groups.get(key) ?? [];
    list.push(record);
    groups.set(key, list);
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([cohort, list]) => {
      const matured = list.filter((r) => isMatured(r, options.now));
      const independence = independenceDiagnostics(
        matured.map((r) => ({
          issuer: r.ticker,
          windowStart: r.asOf.slice(0, 10),
          windowEnd: r.targetDate,
        }))
      );
      const gatePassed = matured.length >= required;
      return {
        cohort,
        total: list.length,
        matured: matured.length,
        required,
        gatePassed,
        independence,
        note: gatePassed
          ? `gate passed at ${matured.length} matured rows, which cluster into ${independence.effectiveSampleSize} overlap-free group(s). The gate permits computation; it does not establish adequacy.`
          : `${matured.length} of ${required} matured. No score is computed: the matured subset is the earliest window and would be scored against whatever that one market did.`,
      };
    });
}

// ── Chronological splitting ──────────────────────────────────────────────────

export interface SplitOptions {
  validationFraction?: number;
  /**
   * Days of separation required between a train row's horizon end and the
   * validation cutoff. Purging removes rows whose windows reach into validation;
   * the embargo removes rows that end suspiciously close to it, since prices near
   * the boundary are shared information.
   */
  embargoDays?: number;
}

export type SplitResult =
  | {
      status: "ok";
      train: PredictionRecord[];
      validation: PredictionRecord[];
      /** ISO instant. Validation is everything forecast at or after this. */
      cutoff: string;
      /** Train rows dropped because their horizon crossed the cutoff. */
      purged: number;
      embargoDays: number;
      note: string;
    }
  | { status: "insufficient"; reason: string };

function dayMs(date: string): number {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isNaN(ms) ? Date.parse(date) : ms;
}

const DAY = 86_400_000;

/**
 * Split a cohort in TIME, then purge the leakage a plain time split still leaves.
 *
 * A naive chronological cut is not enough on its own: a twelve-month forecast made
 * one month before the cutoff resolves deep inside the validation period, so
 * fitting on it fits on validation-period outcomes. Those rows are purged. What
 * remains is a train set whose every outcome was knowable strictly before the
 * cutoff — which is the only kind of train set that makes the validation score
 * mean "out of sample".
 *
 * There is deliberately no shuffled counterpart to this function. See rule 2.
 */
export function chronologicalSplit(
  records: readonly PredictionRecord[],
  options: SplitOptions = {}
): SplitResult {
  const validationFraction = options.validationFraction ?? 0.3;
  const embargoDays = options.embargoDays ?? 0;
  if (!(validationFraction > 0 && validationFraction < 1)) {
    return { status: "insufficient", reason: "validationFraction must be between 0 and 1" };
  }
  if (records.length < 2) {
    return { status: "insufficient", reason: "need at least two records to split" };
  }

  const sorted = [...records].sort((a, b) => {
    const delta = Date.parse(a.asOf) - Date.parse(b.asOf);
    // Ties broken by id so the split is reproducible rather than sort-stability
    // dependent — an irreproducible split cannot be audited.
    return delta !== 0 ? delta : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const cutoffIndex = Math.floor(sorted.length * (1 - validationFraction));
  if (cutoffIndex <= 0 || cutoffIndex >= sorted.length) {
    return {
      status: "insufficient",
      reason: `validationFraction ${validationFraction} leaves one side of the split empty at ${sorted.length} records`,
    };
  }

  const cutoff = sorted[cutoffIndex].asOf;
  const cutoffMs = Date.parse(cutoff);
  const embargoMs = cutoffMs - embargoDays * DAY;

  const validation = sorted.filter((r) => Date.parse(r.asOf) >= cutoffMs);
  const trainCandidates = sorted.filter((r) => Date.parse(r.asOf) < cutoffMs);
  const train = trainCandidates.filter((r) => dayMs(r.targetDate) <= embargoMs);
  const purged = trainCandidates.length - train.length;

  if (!train.length || !validation.length) {
    return {
      status: "insufficient",
      reason: `after purging ${purged} overlapping row(s), one side of the split is empty — the cohort's horizons are long relative to its history`,
    };
  }

  return {
    status: "ok",
    train,
    validation,
    cutoff,
    purged,
    embargoDays,
    note: `train = forecasts resolved before ${new Date(embargoMs).toISOString()}; validation = forecasts made at or after ${cutoff}. ${purged} train row(s) purged for crossing the cutoff.`,
  };
}

// ── Predeclared held-out protocol ────────────────────────────────────────────

export const CalibrationMethodSchema = z.enum(["identity", "platt", "isotonic"]);
export type CalibrationMethod = z.infer<typeof CalibrationMethodSchema>;

/**
 * The protocol, fixed BEFORE the validation outcomes existed.
 *
 * Predeclaration is the whole mechanism. Without it, "the method that worked" is
 * selected after seeing which method worked, and the held-out score is no longer
 * held out — it is the maximum over however many variants were tried, which is
 * biased upward by an amount nobody records. So the method, the metric, the
 * required improvement and the split are all named in advance and hashed, and
 * `declaredAt` must precede the cutoff.
 */
export const HeldOutProtocolSchema = z.object({
  id: z.string().min(1),
  /** When the protocol was fixed. Must be at or before the split cutoff. */
  declaredAt: z.string().min(1),
  cohort: z.string().min(1),
  /** The validation boundary, named in advance rather than chosen afterwards. */
  splitCutoff: z.string().min(1),
  validationFraction: z.number().min(0.05).max(0.95),
  embargoDays: z.number().int().min(0),
  method: CalibrationMethodSchema,
  target: z.enum(["positiveTotalReturn", "outperformBenchmark", "thesisInvalidation"]),
  primaryMetric: z.literal("brier"),
  /** Absolute Brier improvement required on the held-out set. Declared up front. */
  minImprovement: z.number().min(0),
  minMatured: z.number().int().positive(),
});
export type HeldOutProtocol = z.infer<typeof HeldOutProtocolSchema>;

/** sha256 over the protocol's canonical form, so a later edit is detectable. */
export function protocolHash(protocol: HeldOutProtocol): string {
  const canonical = Object.entries(protocol)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("&");
  return createHash("sha256").update(canonical).digest("hex");
}

// ── Contamination labelling ──────────────────────────────────────────────────

export const ProvenanceKindSchema = z.enum([
  /** Forecasts made forward in time, stored before the target date. The only clean source. */
  "live_forward",
  /** Replayed history through a model whose training data may include the outcome. */
  "historical_backtest",
]);

export const HindsightRiskSchema = z.enum([
  "none_live_forward",
  "potentially_hindsight_contaminated",
]);
export type HindsightRisk = z.infer<typeof HindsightRiskSchema>;

export interface ContaminationLabel {
  risk: HindsightRisk;
  /** False for any backtest through a current LLM, whatever the evidence filtering. */
  usableAsEvidenceOfSkill: boolean;
  note: string;
}

/**
 * Label a data source for hindsight contamination.
 *
 * `evidenceDateFiltered` is accepted and then explicitly discounted, because the
 * belief that it helps is the error this function exists to block. Filtering
 * controls the model's INPUTS. It does not touch the model's WEIGHTS, which were
 * trained on text written after the period under test. Asking a 2026 model about a
 * 2023 setup is not a forecast; it is a recall test with a forecast's formatting.
 */
export function labelContamination(source: {
  kind: z.infer<typeof ProvenanceKindSchema>;
  /** Whether retrieved evidence was filtered to the as-of. */
  evidenceDateFiltered: boolean;
  /** Whether the model generating the probabilities post-dates the test period. */
  modelPostDatesPeriod: boolean;
}): ContaminationLabel {
  if (source.kind === "live_forward") {
    return {
      risk: "none_live_forward",
      usableAsEvidenceOfSkill: true,
      note: "forecasts stored before their target dates; no outcome could have been known",
    };
  }
  return {
    risk: "potentially_hindsight_contaminated",
    usableAsEvidenceOfSkill: false,
    note:
      "historical backtest through a current model. " +
      (source.evidenceDateFiltered
        ? "Retrieved evidence was date-filtered, which does NOT remove contamination: "
        : "Evidence was not even date-filtered. ") +
      (source.modelPostDatesPeriod
        ? "the model's training data post-dates the test period, so it may simply remember the outcome. "
        : "the model's vintage relative to the period is unverified, so memory leakage cannot be excluded. ") +
      "Usable for pipeline debugging only; never as evidence of forecasting skill, and never as the basis for promoting a probability basis.",
  };
}

// ── Fitting ──────────────────────────────────────────────────────────────────

export type CalibrationModel =
  | { method: "identity" }
  | { method: "platt"; a: number; b: number }
  | { method: "isotonic"; breakpoints: { upTo: number; value: number }[] };

const CLIP = 1e-6;

function clip(p: number): number {
  return Math.min(1 - CLIP, Math.max(CLIP, p));
}

function logit(p: number): number {
  const c = clip(p);
  return Math.log(c / (1 - c));
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Two-parameter Platt scaling by Newton steps, with a ridge on the Hessian.
 *
 * Deterministic and iteration-capped so the same train set always produces the
 * same model: a calibration artifact that cannot be reproduced from its inputs is
 * not auditable, and an unauditable artifact is exactly what rule 1 is guarding
 * against.
 */
function fitPlatt(p: readonly number[], y: readonly number[]): { a: number; b: number } {
  const x = p.map(logit);
  let a = 1;
  let b = 0;
  for (let iteration = 0; iteration < 100; iteration++) {
    let g0 = 0;
    let g1 = 0;
    let h00 = 0;
    let h01 = 0;
    let h11 = 0;
    for (let i = 0; i < x.length; i++) {
      const mu = sigmoid(a * x[i] + b);
      const residual = mu - y[i];
      const w = Math.max(mu * (1 - mu), 1e-12);
      g0 += residual * x[i];
      g1 += residual;
      h00 += w * x[i] * x[i];
      h01 += w * x[i];
      h11 += w;
    }
    const ridge = 1e-8;
    const m00 = h00 + ridge;
    const m11 = h11 + ridge;
    const det = m00 * m11 - h01 * h01;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-18) break;
    const da = (m11 * g0 - h01 * g1) / det;
    const db = (m00 * g1 - h01 * g0) / det;
    a -= da;
    b -= db;
    if (Math.abs(da) < 1e-12 && Math.abs(db) < 1e-12) break;
  }
  return { a, b };
}

/**
 * Isotonic regression by pool-adjacent-violators.
 *
 * Non-parametric and monotone, which is the right shape for a calibration map, and
 * also the reason it overfits small samples badly — a 40-row fit reproduces its
 * train set almost exactly. That is one more reason the 200-row gate exists, and
 * one more reason the held-out score is the only one that counts.
 */
function fitIsotonic(
  p: readonly number[],
  y: readonly number[]
): { upTo: number; value: number }[] {
  const pairs = p.map((value, i) => ({ x: value, y: y[i] })).sort((l, r) => l.x - r.x);
  const blocks: { sum: number; count: number; maxX: number }[] = [];
  for (const pair of pairs) {
    blocks.push({ sum: pair.y, count: 1, maxX: pair.x });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const previous = blocks[blocks.length - 2];
      if (previous.sum / previous.count <= last.sum / last.count) break;
      blocks.pop();
      previous.sum += last.sum;
      previous.count += last.count;
      previous.maxX = Math.max(previous.maxX, last.maxX);
    }
  }
  return blocks.map((b) => ({ upTo: b.maxX, value: b.sum / b.count }));
}

/** Apply a fitted map to a raw forecast. Clamped to a probability. */
export function applyCalibration(model: CalibrationModel, p: number): number {
  if (model.method === "identity") return clip(p);
  if (model.method === "platt") return clip(sigmoid(model.a * logit(p) + model.b));
  for (const block of model.breakpoints) {
    if (p <= block.upTo) return clip(block.value);
  }
  const last = model.breakpoints[model.breakpoints.length - 1];
  return last ? clip(last.value) : clip(p);
}

function fit(method: CalibrationMethod, p: readonly number[], y: readonly number[]): CalibrationModel {
  if (method === "identity") return { method: "identity" };
  if (method === "platt") return { method: "platt", ...fitPlatt(p, y) };
  return { method: "isotonic", breakpoints: fitIsotonic(p, y) };
}

// ── Artifact ─────────────────────────────────────────────────────────────────

export const CalibrationArtifactSchema = z.object({
  /** The value that would appear as `calibrationVersion` on calibrated weights. */
  version: z.string().min(1),
  createdAt: z.string().min(1),
  cohort: z.string().min(1),
  target: z.string().min(1),
  protocolId: z.string().min(1),
  protocolHash: z.string().length(64),
  protocolDeclaredAt: z.string().min(1),
  predeclared: z.boolean(),
  method: CalibrationMethodSchema,
  trainCount: z.number().int().min(0),
  validationCount: z.number().int().min(0),
  /** Clustered observations behind the validation score. The honest denominator. */
  validationEffectiveSampleSize: z.number().int().min(0),
  baselineBrier: z.number().nullable(),
  calibratedBrier: z.number().nullable(),
  improvement: z.number().nullable(),
  minImprovement: z.number(),
  protocolPassed: z.boolean(),
  hindsightRisk: HindsightRiskSchema,
  /**
   * The single field production reads. True only when the protocol was
   * predeclared, the gate passed, the held-out improvement was met, and the data
   * is live-forward. Any one of those failing leaves raw model weights in place.
   */
  eligibleForProduction: z.boolean(),
  /** Every reason eligibility was withheld. Published, so nothing fails silently. */
  blockers: z.array(z.string()),
  note: z.string(),
});
export type CalibrationArtifact = z.infer<typeof CalibrationArtifactSchema>;

export type CalibrationAttempt =
  | { status: "attempted"; artifact: CalibrationArtifact; model: CalibrationModel }
  | { status: "refused"; blockers: string[]; note: string };

export interface CalibrationInput {
  cohort: string;
  protocol: HeldOutProtocol;
  /** Matured predictions, paired with their resolutions. */
  rows: readonly { prediction: PredictionRecord; outcome: ResolvedPrediction }[];
  source: Parameters<typeof labelContamination>[0];
  now: Date;
}

/**
 * Attempt a calibration fit and produce an artifact describing what happened.
 *
 * Returns `refused` only when nothing could be attempted at all. Otherwise it
 * returns an artifact — INCLUDING when the protocol failed, because a failed
 * calibration attempt is a result worth keeping. Deleting the failures and keeping
 * the successes is how a predeclared protocol quietly becomes a search over
 * protocols.
 */
export function attemptCalibration(input: CalibrationInput): CalibrationAttempt {
  const { protocol } = input;
  const blockers: string[] = [];

  const target = protocol.target;
  const scorable = input.rows.filter((row) => {
    const resolution = row.outcome.targets[target];
    const forecast = row.prediction.forecasts[target];
    return resolution.status === "resolved" && forecast !== null;
  });

  const contamination = labelContamination(input.source);
  if (!contamination.usableAsEvidenceOfSkill) blockers.push(contamination.note);

  const declaredMs = Date.parse(protocol.declaredAt);
  const cutoffMs = Date.parse(protocol.splitCutoff);
  const predeclared =
    Number.isFinite(declaredMs) && Number.isFinite(cutoffMs) && declaredMs <= cutoffMs;
  if (!predeclared) {
    blockers.push(
      `protocol ${protocol.id} was declared at ${protocol.declaredAt}, not before its split cutoff ${protocol.splitCutoff}; a protocol chosen after seeing the validation period is not held out`
    );
  }

  const maturedCount = scorable.filter((row) => isMatured(row.prediction, input.now)).length;
  if (maturedCount < protocol.minMatured) {
    blockers.push(
      `${maturedCount} scorable matured row(s) against a gate of ${protocol.minMatured}; the gate is a floor on computation, not a power calculation`
    );
  }

  if (scorable.length < 2) {
    return {
      status: "refused",
      blockers: [...blockers, "fewer than two scorable rows; nothing can be fitted or validated"],
      note: "no calibration attempted",
    };
  }

  const split = chronologicalSplit(
    scorable.map((row) => row.prediction),
    { validationFraction: protocol.validationFraction, embargoDays: protocol.embargoDays }
  );
  if (split.status !== "ok") {
    return {
      status: "refused",
      blockers: [...blockers, split.reason],
      note: "chronological split could not be formed; a random split is not an available fallback",
    };
  }

  const byId = new Map(scorable.map((row) => [row.prediction.id, row]));
  const extract = (records: readonly PredictionRecord[]) => {
    const p: number[] = [];
    const y: number[] = [];
    const overlap: { issuer: string; windowStart: string; windowEnd: string }[] = [];
    for (const record of records) {
      const row = byId.get(record.id);
      if (!row) continue;
      const resolution = row.outcome.targets[target];
      const forecast = row.prediction.forecasts[target];
      if (resolution.status !== "resolved" || forecast === null) continue;
      p.push(forecast);
      y.push(resolution.value);
      overlap.push({
        issuer: record.ticker,
        windowStart: record.asOf.slice(0, 10),
        windowEnd: row.outcome.effectiveWindowEnd,
      });
    }
    return { p, y, overlap };
  };

  const trainSet = extract(split.train);
  const validationSet = extract(split.validation);

  if (!trainSet.p.length || !validationSet.p.length) {
    return {
      status: "refused",
      blockers: [...blockers, "train or validation side had no scorable rows after the split"],
      note: "no calibration attempted",
    };
  }

  const model = fit(protocol.method, trainSet.p, trainSet.y);
  const baselineBrier = brierScore([...validationSet.p], [...validationSet.y]);
  const calibratedBrier = brierScore(
    validationSet.p.map((value) => applyCalibration(model, value)),
    [...validationSet.y]
  );
  const improvement = baselineBrier - calibratedBrier;
  const protocolPassed = improvement >= protocol.minImprovement;
  if (!protocolPassed) {
    blockers.push(
      `held-out Brier improvement ${improvement.toFixed(4)} did not reach the predeclared ${protocol.minImprovement}`
    );
  }

  const independence = independenceDiagnostics(validationSet.overlap);
  const hash = protocolHash(protocol);
  const artifact: CalibrationArtifact = {
    version: `cal_${input.cohort}_${target}_${hash.slice(0, 12)}`,
    createdAt: input.now.toISOString(),
    cohort: input.cohort,
    target,
    protocolId: protocol.id,
    protocolHash: hash,
    protocolDeclaredAt: protocol.declaredAt,
    predeclared,
    method: protocol.method,
    trainCount: trainSet.p.length,
    validationCount: validationSet.p.length,
    validationEffectiveSampleSize: independence.effectiveSampleSize,
    baselineBrier,
    calibratedBrier,
    improvement,
    minImprovement: protocol.minImprovement,
    protocolPassed,
    hindsightRisk: contamination.risk,
    eligibleForProduction: blockers.length === 0,
    blockers,
    note:
      `Validation rows cluster into ${independence.effectiveSampleSize} overlap-free group(s); ` +
      `the ${validationSet.p.length}-row count overstates the independent evidence. ` +
      `${split.purged} train row(s) purged for crossing the cutoff. ` +
      (blockers.length === 0
        ? "Eligible: predeclared protocol met on live-forward data."
        : "NOT eligible; production keeps raw model weights."),
  };

  return { status: "attempted", artifact: CalibrationArtifactSchema.parse(artifact), model };
}

// ── Promotion gate ───────────────────────────────────────────────────────────

export interface PromotionResult {
  basis: ProbabilityBasis;
  calibrationVersion: string | null;
  promoted: boolean;
  reason: string;
}

/**
 * The ONLY route to `empirically_calibrated`.
 *
 * Refusing is the default and the common case. `empirically_calibrated` asserts
 * that these probabilities were measured against resolved outcomes; asserting it
 * without the artifact would be the most consequential false statement this system
 * could make, because every downstream number — the rating, the hurdle comparison,
 * the "experimental" flag on the report — reads it as settled.
 */
export function promoteProbabilityBasis(
  current: ProbabilityBasis,
  artifact: CalibrationArtifact | null,
  context: { cohort: string; target: string }
): PromotionResult {
  const keep = (reason: string): PromotionResult => ({
    basis: current,
    calibrationVersion: null,
    promoted: false,
    reason,
  });

  if (artifact === null) {
    return keep(
      "no calibration artifact: production keeps raw model weights until one passes a predeclared held-out protocol"
    );
  }
  if (!artifact.eligibleForProduction) {
    return keep(`artifact ${artifact.version} is not eligible: ${artifact.blockers.join("; ")}`);
  }
  if (artifact.hindsightRisk !== "none_live_forward") {
    return keep(
      `artifact ${artifact.version} is labelled ${artifact.hindsightRisk}; a backtest through a current model cannot license a calibration claim`
    );
  }
  if (artifact.cohort !== context.cohort || artifact.target !== context.target) {
    return keep(
      `artifact ${artifact.version} measured ${artifact.cohort}/${artifact.target}, not ${context.cohort}/${context.target}; calibration does not transfer across horizons or questions`
    );
  }

  return {
    basis: "empirically_calibrated",
    calibrationVersion: artifact.version,
    promoted: true,
    reason: `measured by ${artifact.version} on ${artifact.validationCount} held-out rows (${artifact.validationEffectiveSampleSize} overlap-free groups)`,
  };
}

export type CalibratedWeightsResult =
  | { status: "ok"; weights: z.infer<typeof ScenarioWeightsSchema> }
  | { status: "refused"; reason: string };

/**
 * Build a weight triple at whatever basis the evidence supports.
 *
 * Note the second lock: even if this function were wrong, `ScenarioWeightsSchema`
 * refuses `empirically_calibrated` without a `calibrationVersion`. Belt and
 * braces, deliberately, because the two guards fail independently.
 */
export function buildCalibratedWeights(
  values: unknown,
  params: {
    currentBasis: ProbabilityBasis;
    model: string | null;
    artifact: CalibrationArtifact | null;
    cohort: string;
    target: string;
  }
): CalibratedWeightsResult {
  const triple = ProbabilityTripleSchema.safeParse(values);
  if (!triple.success) {
    return { status: "refused", reason: triple.error.issues.map((i) => i.message).join("; ") };
  }

  const promotion = promoteProbabilityBasis(params.currentBasis, params.artifact, {
    cohort: params.cohort,
    target: params.target,
  });

  const parsed = ScenarioWeightsSchema.safeParse({
    values: triple.data,
    basis: promotion.basis,
    model: params.model,
    calibrationVersion: promotion.calibrationVersion,
  });
  if (!parsed.success) {
    return { status: "refused", reason: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  return { status: "ok", weights: parsed.data };
}

// ── Three-arm benchmark ──────────────────────────────────────────────────────

/**
 * The three arms a comparison must include to mean anything.
 *
 * Without arm A, "our agents beat nothing in particular" is indistinguishable from
 * skill: a deterministic factor screen is free, fast and historically hard to beat,
 * so it is the floor. Without the A/B pair, agent value and model-probability value
 * are confounded and a gain from either gets attributed to both. And note the
 * reason arm C exists separately: adding scenario probabilities makes the output
 * more fluent and more decisive whether or not it makes it more accurate. A faster
 * or more articulate system is not automatically a better stock selector, and this
 * comparison is the only thing that can tell the two apart.
 */
export const BENCHMARK_ARMS = {
  screenOnly: {
    id: "deterministic_screen_only",
    description:
      "The deterministic factor screen alone, no agents and no model probabilities. The floor any agent stack must clear.",
  },
  scoutAndAgents: {
    id: "scout_plus_agents",
    description:
      "Existing scout and research agents, rating by policy, with no model-authored scenario probabilities.",
  },
  scoutAgentsAndModelProbabilities: {
    id: "scout_plus_agents_plus_model_probabilities",
    description:
      "The same system with model scenario probabilities feeding the expected-return arithmetic.",
  },
} as const;

export interface ArmResult {
  arm: string;
  samples: number;
  effectiveSampleSize: number;
  /** Null when the arm did not reach the reporting floor. */
  brier: number | null;
  hitRate: number | null;
  meanExcessReturn: number | null;
  medianLatencyMs: number | null;
  meanCostUsd: number | null;
}

export interface ArmComparison {
  status: "ranked" | "inconclusive";
  arms: ArmResult[];
  /** Arm ids best-first by Brier. Present only when every arm cleared the floor. */
  ranking: string[] | null;
  note: string;
}

/**
 * Order the arms, or refuse to.
 *
 * Refusal is not timidity: with overlapping windows and repeated issuers, a Brier
 * gap of a few thousandths over a hundred clustered observations is noise, and
 * naming a winner from it is how a system gets tuned toward whichever arm was
 * lucky. When the comparison is publishable, it is published as an ORDERING with
 * no significance claim attached — see the metrics.ts header for why no interval
 * appears anywhere in this module.
 */
export function compareArms(
  arms: readonly ArmResult[],
  options: { minEffective?: number } = {}
): ArmComparison {
  const minEffective = options.minEffective ?? MIN_EFFECTIVE_FOR_ARM_COMPARISON;
  const missing = Object.values(BENCHMARK_ARMS)
    .map((a) => a.id)
    .filter((id) => !arms.some((arm) => arm.arm === id));

  const thin = arms.filter((a) => a.effectiveSampleSize < minEffective || a.brier === null);

  if (missing.length || thin.length) {
    return {
      status: "inconclusive",
      arms: [...arms],
      ranking: null,
      note:
        (missing.length
          ? `missing arm(s): ${missing.join(", ")} — a comparison without the deterministic screen cannot show the agents add anything. `
          : "") +
        (thin.length
          ? `arm(s) below ${minEffective} overlap-free observations or unscored: ${thin.map((a) => a.arm).join(", ")}. `
          : "") +
        "No ordering published.",
    };
  }

  const ranking = [...arms]
    .sort((a, b) => (a.brier ?? Infinity) - (b.brier ?? Infinity))
    .map((a) => a.arm);

  return {
    status: "ranked",
    arms: [...arms],
    ranking,
    note:
      "Ordering by held-out Brier only. This is an ordering, not a significance claim: overlapping horizons and repeated issuers make the effective sample far smaller than the row count. Latency and cost are reported beside it precisely so a faster, more fluent arm is not mistaken for a more accurate one.",
  };
}
