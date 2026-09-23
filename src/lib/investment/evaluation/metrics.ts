// Scoring metrics for resolved predictions.
//
// ══════════════════════════════════════════════════════════════════════════════
// READ THIS FIRST: OVERLAPPING HORIZONS AND REPEATED ISSUERS
// ══════════════════════════════════════════════════════════════════════════════
//
// Every number this file produces is a point estimate over a sample that is NOT
// independent, and the error is large enough to change conclusions.
//
// Two mechanisms, both severe:
//
//  1. OVERLAPPING WINDOWS. Twelve-month forecasts issued monthly share eleven
//     months of the same market. If the market falls in that period, nearly every
//     "will it be up" forecast misses together. Those are not 12 independent
//     observations of our skill; they are closer to one observation of a market,
//     repeated. Treating them as independent inflates the apparent sample size by
//     roughly the overlap factor and shrinks a naive confidence interval by
//     roughly its square root — so a genuinely uninformative forecaster can look
//     significantly skilled at conventional thresholds.
//
//  2. REPEATED ISSUERS. Twenty forecasts on the same name over two years are one
//     company's idiosyncratic path, not twenty draws. The same applies at sector
//     level: eight semiconductor names in one cycle move together.
//
// So: `independenceDiagnostics` accompanies every aggregate, and this module
// deliberately publishes NO confidence intervals, NO p-values and NO significance
// claims. An interval computed as if the rows were independent would be the single
// most misleading number the system could print, because it would look like exactly
// the rigour it lacks. The honest summary is a point estimate, the raw count, the
// clustered effective count, and the warning that the two differ.
//
// ── On the metrics themselves ─────────────────────────────────────────────────
//
// BRIER IS BOUNDED. A binary Brier score lies in [0, 1] and a three-class Brier in
// [0, 2]. It is a proper score, so it still rewards honest probabilities, but it is
// NOT infinitely punitive: forecasting 0 on something that then happens costs 1,
// the same finite amount as being wrong by one full unit anywhere else. That
// boundedness is a real property and a real limitation — a forecaster who says
// "impossible" and is wrong once a year is barely penalised by Brier.
//
// LOG LOSS IS UNBOUNDED, and that is its point: it is infinite on a realised
// outcome assigned probability zero. We do NOT silently clip that away, because
// clipping quietly converts "this forecaster claimed an impossibility and was
// wrong" into a merely bad score, and the clipping epsilon then sets the penalty.
// `multiclassLogLoss` returns Infinity by default and counts the offending rows;
// an epsilon must be passed explicitly and is reported alongside the value.
//
// Both are reported. Brier alone hides confident errors; log loss alone is
// dominated by them.

import type { ScenarioId } from "../schemas";
import type { NonResolutionReason, ResolvedPrediction } from "./outcomes";
import type { PredictionRecord } from "./predictions";

const SCENARIO_IDS: readonly ScenarioId[] = ["bear", "base", "bull"] as const;

/**
 * Reporting floor for an aggregate score.
 *
 * A Brier score over four predictions is arithmetic, not evidence, and printing
 * one invites it to be quoted. Below this floor the report says
 * `insufficient_samples` and gives the count. This is a floor on DISPLAY; the
 * calibration gate in calibration.ts is a separate and much higher bar, and
 * neither one is a claim of statistical adequacy.
 */
export const MIN_SAMPLES_TO_REPORT = 30;

// ── Proper scores ────────────────────────────────────────────────────────────

/**
 * Mean squared error of a binary probability forecast. Lower is better; 0.25 is
 * what a constant 0.5 scores.
 *
 * Binary events ONLY, and only where a probability was actually forecast: the
 * caller must have filtered out rows whose forecast was null. Coercing a null to
 * 0.5 would silently insert a forecast nobody made and then grade it.
 */
export function brierScore(p: number[], y: number[]) {
  if (!p.length || p.length !== y.length) throw new Error('invalid samples');
  if (p.some(v => !Number.isFinite(v) || v < 0 || v > 1) ||
      y.some(v => v !== 0 && v !== 1)) throw new Error('invalid samples');
  return p.reduce((sum, value, i) => sum + (value - y[i]) ** 2, 0) / p.length;
}

export interface ProbabilityTripleLike {
  bear: number;
  base: number;
  bull: number;
}

function validateTriples(
  forecasts: readonly ProbabilityTripleLike[],
  actual: readonly ScenarioId[]
): void {
  if (!forecasts.length || forecasts.length !== actual.length) {
    throw new Error("invalid samples");
  }
  for (const f of forecasts) {
    let sum = 0;
    for (const id of SCENARIO_IDS) {
      const v = f[id];
      if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error("invalid samples");
      sum += v;
    }
    // Looser than WEIGHT_SUM_TOLERANCE: these triples have made a round trip
    // through Firestore, and rejecting a 1e-9 drift would discard real rows.
    if (Math.abs(sum - 1) > 1e-6) throw new Error("invalid samples");
  }
  for (const a of actual) {
    if (!SCENARIO_IDS.includes(a)) throw new Error("invalid samples");
  }
}

/**
 * Multiclass Brier over the three scenario buckets.
 *
 * Sum of squared errors against the one-hot outcome, averaged over rows. Range
 * [0, 2]: the worst case puts all mass on one wrong class, costing 1 for the
 * missed class plus 1 for the asserted one. A uniform third scores 2/3.
 */
export function multiclassBrier(
  forecasts: readonly ProbabilityTripleLike[],
  actual: readonly ScenarioId[]
): number {
  validateTriples(forecasts, actual);
  let total = 0;
  forecasts.forEach((f, i) => {
    for (const id of SCENARIO_IDS) {
      const target = actual[i] === id ? 1 : 0;
      total += (f[id] - target) ** 2;
    }
  });
  return total / forecasts.length;
}

export interface LogLossResult {
  /** Infinity when a realised bucket was assigned probability 0 and no epsilon was given. */
  value: number;
  /** Rows where the realised class carried probability 0. The interesting rows. */
  zeroProbabilityRows: number;
  /** The clipping floor, or null when none was applied. Reported so the penalty is attributable. */
  epsilon: number | null;
  samples: number;
  note: string;
}

/**
 * Mean negative log likelihood of the realised bucket.
 *
 * Returns Infinity when the forecaster assigned zero probability to something
 * that happened, unless the caller explicitly passes an epsilon. An automatic
 * default would make the most informative failure mode in the whole dataset
 * disappear into a finite number chosen by this file rather than by the analyst.
 */
export function multiclassLogLoss(
  forecasts: readonly ProbabilityTripleLike[],
  actual: readonly ScenarioId[],
  options: { epsilon?: number } = {}
): LogLossResult {
  validateTriples(forecasts, actual);
  const epsilon = options.epsilon ?? null;
  if (epsilon !== null && (!Number.isFinite(epsilon) || epsilon <= 0 || epsilon >= 0.5)) {
    throw new Error("invalid epsilon");
  }

  let total = 0;
  let zeroProbabilityRows = 0;
  forecasts.forEach((f, i) => {
    const raw = f[actual[i]];
    if (raw <= 0) zeroProbabilityRows++;
    const p = epsilon === null ? raw : Math.min(1 - epsilon, Math.max(epsilon, raw));
    total += p <= 0 ? Number.POSITIVE_INFINITY : -Math.log(p);
  });

  const value = total / forecasts.length;
  return {
    value,
    zeroProbabilityRows,
    epsilon,
    samples: forecasts.length,
    note:
      zeroProbabilityRows === 0
        ? "no realised outcome was assigned zero probability"
        : epsilon === null
          ? `${zeroProbabilityRows} row(s) assigned zero probability to the realised bucket; log loss is infinite and deliberately unclipped`
          : `${zeroProbabilityRows} row(s) clipped at epsilon=${epsilon}; the penalty on those rows is set by the epsilon, not by the forecast`,
  };
}

/**
 * Mean absolute error of the point return forecast.
 *
 * A companion to the probability scores, not a substitute: a forecaster can carry
 * a fine MAE while being badly miscalibrated, because MAE says nothing about
 * whether the stated confidence matched the hit rate.
 */
export function returnMae(predictions: readonly number[], outcomes: readonly number[]): number {
  if (!predictions.length || predictions.length !== outcomes.length) {
    throw new Error("invalid samples");
  }
  if (predictions.some((v) => !Number.isFinite(v)) || outcomes.some((v) => !Number.isFinite(v))) {
    throw new Error("invalid samples");
  }
  let total = 0;
  predictions.forEach((p, i) => {
    total += Math.abs(p - outcomes[i]);
  });
  return total / predictions.length;
}

// ── Reliability ──────────────────────────────────────────────────────────────

export interface CalibrationBin {
  lower: number;
  upper: number;
  /** Rows in this bin. The number that decides whether the bin says anything. */
  count: number;
  meanForecast: number | null;
  empiricalRate: number | null;
  /** False when the bin has too few rows to read. Kept in the output, not dropped. */
  readable: boolean;
}

export interface ReliabilityReport {
  bins: CalibrationBin[];
  samples: number;
  /** Count-weighted mean |forecast − outcome rate| across readable bins. */
  expectedCalibrationError: number | null;
  /** Bins whose count is below the readability floor. */
  thinBins: number;
  note: string;
}

/** A bin needs at least this many rows before its empirical rate means anything. */
export const MIN_BIN_COUNT = 10;

/**
 * Reliability bins WITH their sample sizes.
 *
 * The counts are not decoration. A reliability curve drawn from bins of 2, 3 and
 * 400 rows looks like a curve and is mostly noise at both ends, and the usual
 * presentation — a line through the bin means — hides that completely. Bins below
 * the floor are marked unreadable and reported rather than merged away, because
 * merging them manufactures a smooth curve out of missing data.
 */
export function reliabilityBins(
  p: readonly number[],
  y: readonly number[],
  binCount = 10
): ReliabilityReport {
  if (p.length !== y.length) throw new Error("invalid samples");
  if (!Number.isInteger(binCount) || binCount < 2) throw new Error("invalid binCount");
  if (
    p.some((v) => !Number.isFinite(v) || v < 0 || v > 1) ||
    y.some((v) => v !== 0 && v !== 1)
  ) {
    throw new Error("invalid samples");
  }

  const buckets: { forecastSum: number; outcomeSum: number; count: number }[] = Array.from(
    { length: binCount },
    () => ({ forecastSum: 0, outcomeSum: 0, count: 0 })
  );

  p.forEach((value, i) => {
    // The top bin is closed at 1 so a forecast of exactly 1.0 lands in the last
    // bin rather than in a phantom bin beyond the array.
    const index = Math.min(binCount - 1, Math.floor(value * binCount));
    buckets[index].forecastSum += value;
    buckets[index].outcomeSum += y[i];
    buckets[index].count += 1;
  });

  let weightedError = 0;
  let readableRows = 0;
  let thinBins = 0;

  const bins: CalibrationBin[] = buckets.map((b, i) => {
    const readable = b.count >= MIN_BIN_COUNT;
    if (b.count > 0 && !readable) thinBins++;
    const meanForecast = b.count ? b.forecastSum / b.count : null;
    const empiricalRate = b.count ? b.outcomeSum / b.count : null;
    if (readable && meanForecast !== null && empiricalRate !== null) {
      weightedError += b.count * Math.abs(meanForecast - empiricalRate);
      readableRows += b.count;
    }
    return {
      lower: i / binCount,
      upper: (i + 1) / binCount,
      count: b.count,
      meanForecast,
      empiricalRate,
      readable,
    };
  });

  return {
    bins,
    samples: p.length,
    expectedCalibrationError: readableRows ? weightedError / readableRows : null,
    thinBins,
    note:
      readableRows === 0
        ? `no bin reached ${MIN_BIN_COUNT} rows; there is no readable reliability curve here yet`
        : `expected calibration error computed over ${readableRows} of ${p.length} rows in bins of at least ${MIN_BIN_COUNT}; ${thinBins} bin(s) too thin to read`,
  };
}

// ── Independence ─────────────────────────────────────────────────────────────

export interface OverlapRow {
  /** The issuer. Repeats are the second source of dependence. */
  issuer: string;
  windowStart: string;
  windowEnd: string;
}

export interface IndependenceDiagnostics {
  samples: number;
  distinctIssuers: number;
  /** Most windows live at once, across all issuers — the market-wide overlap. */
  maxSimultaneousWindows: number;
  meanSimultaneousWindows: number;
  /** Issuer + overlapping-window clusters. Our effective count of observations. */
  clusters: number;
  effectiveSampleSize: number;
  /** samples / effectiveSampleSize. 1 means genuinely independent rows. */
  dependenceInflation: number;
  /** How far a naive standard error would understate the true one, roughly. */
  naiveStandardErrorUnderstatement: number;
  warning: string;
}

function dayMs(date: string): number {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isNaN(ms) ? Date.parse(date) : ms;
}

/**
 * Quantify how far from independent a sample is.
 *
 * Clustering is by ISSUER first and then by overlapping windows within the
 * issuer: two twelve-month calls on the same name three months apart are one
 * cluster, and the same call on two unrelated names is two. That is the coarsest
 * defensible unit, and it still UNDERSTATES dependence, because it does not
 * cluster across issuers that share a sector or factor — eight semis in one cycle
 * count as eight here and behave like rather fewer.
 *
 * `effectiveSampleSize` is therefore an upper bound on how much independent
 * evidence the sample contains, not an estimate of it. Use it to notice that
 * "1,200 predictions" is really 90 observations, which is the finding that stops a
 * premature calibration claim.
 */
export function independenceDiagnostics(rows: readonly OverlapRow[]): IndependenceDiagnostics {
  const samples = rows.length;
  if (samples === 0) {
    return {
      samples: 0,
      distinctIssuers: 0,
      maxSimultaneousWindows: 0,
      meanSimultaneousWindows: 0,
      clusters: 0,
      effectiveSampleSize: 0,
      dependenceInflation: 1,
      naiveStandardErrorUnderstatement: 1,
      warning: "no rows",
    };
  }

  const byIssuer = new Map<string, { start: number; end: number }[]>();
  for (const row of rows) {
    const list = byIssuer.get(row.issuer) ?? [];
    list.push({ start: dayMs(row.windowStart), end: dayMs(row.windowEnd) });
    byIssuer.set(row.issuer, list);
  }

  let clusters = 0;
  for (const windows of byIssuer.values()) {
    windows.sort((a, b) => a.start - b.start);
    let clusterEnd = Number.NEGATIVE_INFINITY;
    for (const w of windows) {
      // `<=` because windows that merely touch still share the same day's prices.
      if (w.start <= clusterEnd) {
        clusterEnd = Math.max(clusterEnd, w.end);
        continue;
      }
      clusters++;
      clusterEnd = w.end;
    }
  }

  // Sweep line over all windows for the market-wide picture. Starts are processed
  // before ends at the same instant, so touching windows count as overlapping.
  const events: { at: number; delta: number }[] = [];
  for (const row of rows) {
    events.push({ at: dayMs(row.windowStart), delta: 1 });
    events.push({ at: dayMs(row.windowEnd), delta: -1 });
  }
  events.sort((a, b) => (a.at === b.at ? b.delta - a.delta : a.at - b.at));

  let live = 0;
  let maxSimultaneousWindows = 0;
  let overlapAreaWeighted = 0;
  let observations = 0;
  for (const event of events) {
    live += event.delta;
    if (event.delta === 1) {
      maxSimultaneousWindows = Math.max(maxSimultaneousWindows, live);
      overlapAreaWeighted += live;
      observations++;
    }
  }

  const effectiveSampleSize = clusters;
  const dependenceInflation = effectiveSampleSize > 0 ? samples / effectiveSampleSize : samples;

  return {
    samples,
    distinctIssuers: byIssuer.size,
    maxSimultaneousWindows,
    meanSimultaneousWindows: observations ? overlapAreaWeighted / observations : 0,
    clusters,
    effectiveSampleSize,
    dependenceInflation,
    naiveStandardErrorUnderstatement: Math.sqrt(dependenceInflation),
    warning:
      `${samples} prediction(s) across ${byIssuer.size} issuer(s) cluster into ${clusters} ` +
      `overlap-free group(s); up to ${maxSimultaneousWindows} windows were open at once. ` +
      `Treating these as independent would overstate the sample by about ` +
      `${dependenceInflation.toFixed(1)}x and shrink a naive confidence interval by about ` +
      `${Math.sqrt(dependenceInflation).toFixed(1)}x. No interval or p-value is published for this reason, ` +
      `and the cluster count itself ignores shared sector and factor exposure, so it remains an upper bound.`,
  };
}

// ── Aggregate reports ────────────────────────────────────────────────────────

export type BinaryTargetKey =
  | "positiveTotalReturn"
  | "outperformBenchmark"
  | "thesisInvalidation";

export interface BinaryTargetReport {
  target: BinaryTargetKey;
  status: "ok" | "insufficient_samples";
  /** Rows with BOTH a forecast probability and a resolved outcome. */
  samples: number;
  required: number;
  /** Resolved outcomes that carried no forecast, so could not be scored. */
  resolvedWithoutForecast: number;
  brier: number | null;
  /** What a constant forecast of the base rate would have scored. The bar to beat. */
  baseRateBrier: number | null;
  baseRate: number | null;
  reliability: ReliabilityReport | null;
  independence: IndependenceDiagnostics;
  note: string;
}

function forecastFor(
  outcome: ResolvedPrediction,
  target: BinaryTargetKey
): number | null {
  if (target === "positiveTotalReturn") return outcome.forecasts.positiveTotalReturn;
  if (target === "outperformBenchmark") return outcome.forecasts.outperformBenchmark;
  return outcome.forecasts.thesisInvalidation;
}

/**
 * Score one binary target across a cohort.
 *
 * Rows where the target did not resolve are excluded from the score and counted
 * in `missingnessReport` instead — a Brier computed over the rows that happened to
 * resolve, with no statement of how many did not, is the flattering version of
 * this number. Rows that resolved but carried no forecast are counted separately
 * again, because "we declined to forecast" is not the same as "we forecast and
 * missed", and neither one may be quietly converted into the other.
 */
export function binaryTargetReport(
  outcomes: readonly ResolvedPrediction[],
  target: BinaryTargetKey,
  options: { minSamples?: number; binCount?: number } = {}
): BinaryTargetReport {
  const required = options.minSamples ?? MIN_SAMPLES_TO_REPORT;
  const p: number[] = [];
  const y: number[] = [];
  const overlap: OverlapRow[] = [];
  let resolvedWithoutForecast = 0;

  for (const outcome of outcomes) {
    const resolution = outcome.targets[target];
    if (resolution.status !== "resolved") continue;
    const forecast = forecastFor(outcome, target);
    if (forecast === null) {
      resolvedWithoutForecast++;
      continue;
    }
    p.push(forecast);
    y.push(resolution.value);
    overlap.push({
      issuer: outcome.ticker,
      windowStart: outcome.asOf.slice(0, 10),
      windowEnd: outcome.effectiveWindowEnd,
    });
  }

  const independence = independenceDiagnostics(overlap);

  if (p.length < required) {
    return {
      target,
      status: "insufficient_samples",
      samples: p.length,
      required,
      resolvedWithoutForecast,
      brier: null,
      baseRateBrier: null,
      baseRate: null,
      reliability: null,
      independence,
      note:
        `${p.length} scorable row(s) against a display floor of ${required}. ` +
        `No score is reported: an average over this few rows would be quoted as ` +
        `a track record it cannot support.`,
    };
  }

  const baseRate = y.reduce((s, v) => s + v, 0) / y.length;
  return {
    target,
    status: "ok",
    samples: p.length,
    required,
    resolvedWithoutForecast,
    brier: brierScore(p, y),
    baseRateBrier: brierScore(new Array(y.length).fill(baseRate), y),
    baseRate,
    reliability: reliabilityBins(p, y, options.binCount ?? 10),
    independence,
    note:
      `Compare brier against baseRateBrier: beating a constant base-rate forecast ` +
      `is the minimum bar, and the base rate was only knowable after the fact. ` +
      independence.warning,
  };
}

export interface ScenarioTargetReport {
  status: "ok" | "insufficient_samples";
  samples: number;
  required: number;
  resolvedWithoutForecast: number;
  multiclassBrier: number | null;
  logLoss: LogLossResult | null;
  /** Realised frequency of each bucket. The bar a uniform forecast would set. */
  realisedFrequencies: Record<ScenarioId, number> | null;
  independence: IndependenceDiagnostics;
  note: string;
}

/** Score the scenario-bucket forecast. Both a bounded and an unbounded score. */
export function scenarioTargetReport(
  outcomes: readonly ResolvedPrediction[],
  options: { minSamples?: number; epsilon?: number } = {}
): ScenarioTargetReport {
  const required = options.minSamples ?? MIN_SAMPLES_TO_REPORT;
  const forecasts: ProbabilityTripleLike[] = [];
  const actual: ScenarioId[] = [];
  const overlap: OverlapRow[] = [];
  let resolvedWithoutForecast = 0;

  for (const outcome of outcomes) {
    const resolution = outcome.targets.scenarioBucket;
    if (resolution.status !== "resolved") continue;
    const triple = outcome.forecasts.scenarioBucket;
    if (triple === null) {
      resolvedWithoutForecast++;
      continue;
    }
    forecasts.push(triple);
    actual.push(resolution.value);
    overlap.push({
      issuer: outcome.ticker,
      windowStart: outcome.asOf.slice(0, 10),
      windowEnd: outcome.effectiveWindowEnd,
    });
  }

  const independence = independenceDiagnostics(overlap);

  if (forecasts.length < required) {
    return {
      status: "insufficient_samples",
      samples: forecasts.length,
      required,
      resolvedWithoutForecast,
      multiclassBrier: null,
      logLoss: null,
      realisedFrequencies: null,
      independence,
      note: `${forecasts.length} scorable row(s) against a display floor of ${required}; no score reported.`,
    };
  }

  const counts: Record<ScenarioId, number> = { bear: 0, base: 0, bull: 0 };
  for (const id of actual) counts[id]++;

  const logLossOptions = options.epsilon === undefined ? {} : { epsilon: options.epsilon };

  return {
    status: "ok",
    samples: forecasts.length,
    required,
    resolvedWithoutForecast,
    multiclassBrier: multiclassBrier(forecasts, actual),
    logLoss: multiclassLogLoss(forecasts, actual, logLossOptions),
    independence,
    realisedFrequencies: {
      bear: counts.bear / actual.length,
      base: counts.base / actual.length,
      bull: counts.bull / actual.length,
    },
    note:
      `Brier is bounded in [0, 2] and a uniform third scores 0.667; log loss is ` +
      `unbounded and is the one that reacts to confident errors. ` +
      independence.warning,
  };
}

// ── Missingness, latency, cost ───────────────────────────────────────────────

export interface MissingnessReport {
  predictions: number;
  /** Whole records that could not be lined up with outcome data at all. */
  unresolvableRecords: number;
  resolvedRecords: number;
  fullCoverage: number;
  partialCoverage: number;
  /** Counts by reason, over whole-record and per-target non-resolutions alike. */
  byReason: Record<string, number>;
  perTarget: Record<string, { resolved: number; unresolved: number }>;
  /** resolvedRecords / predictions. The number every score below must be read against. */
  resolutionRate: number;
  note: string;
}

/**
 * What did not resolve, and why.
 *
 * This report is not an appendix. A cohort that resolves 70% of its rows supports
 * materially weaker claims than one that resolves 99%, and the pattern matters
 * more than the rate: non-resolution concentrated in delistings and acquisitions
 * biases a hit rate upward, while non-resolution spread evenly across a provider
 * outage mostly just costs sample size.
 */
export function missingnessReport(
  resolved: readonly ResolvedPrediction[],
  unresolvable: readonly { reason: NonResolutionReason }[]
): MissingnessReport {
  const byReason: Record<string, number> = {};
  const perTarget: Record<string, { resolved: number; unresolved: number }> = {};

  for (const row of unresolvable) {
    byReason[row.reason] = (byReason[row.reason] ?? 0) + 1;
  }

  let fullCoverage = 0;
  let partialCoverage = 0;
  for (const outcome of resolved) {
    if (outcome.coverage === "full") fullCoverage++;
    else if (outcome.coverage === "partial") partialCoverage++;

    for (const [key, target] of Object.entries(outcome.targets)) {
      const bucket = perTarget[key] ?? { resolved: 0, unresolved: 0 };
      if (target.status === "resolved") bucket.resolved++;
      else {
        bucket.unresolved++;
        byReason[target.reason] = (byReason[target.reason] ?? 0) + 1;
      }
      perTarget[key] = bucket;
    }
  }

  const predictions = resolved.length + unresolvable.length;
  return {
    predictions,
    unresolvableRecords: unresolvable.length,
    resolvedRecords: resolved.length,
    fullCoverage,
    partialCoverage,
    byReason,
    perTarget,
    resolutionRate: predictions ? resolved.length / predictions : 0,
    note:
      predictions === 0
        ? "no predictions in scope"
        : "Read every score alongside this rate. Check whether non-resolution concentrates in delistings and acquisitions, which would bias the record upward.",
  };
}

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

export interface OperationalReport {
  records: number;
  /** Records where the figure was not measured. Reported, never imputed. */
  missing: number;
  measured: number;
  mean: number | null;
  p50: number | null;
  p90: number | null;
  max: number | null;
  total: number | null;
  note: string;
}

function operational(
  values: readonly (number | null)[],
  label: string
): OperationalReport {
  const measured = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const sorted = [...measured].sort((a, b) => a - b);
  const total = measured.reduce((s, v) => s + v, 0);
  return {
    records: values.length,
    missing: values.length - measured.length,
    measured: measured.length,
    mean: measured.length ? total / measured.length : null,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted.length ? sorted[sorted.length - 1] : null,
    total: measured.length ? total : null,
    note: measured.length
      ? `${label} over ${measured.length} of ${values.length} record(s); ${values.length - measured.length} unmeasured and excluded rather than imputed`
      : `no ${label} was measured on any record`,
  };
}

/** Wall-clock latency of the runs that produced these predictions. */
export function latencyReport(records: readonly PredictionRecord[]): OperationalReport {
  return operational(
    records.map((r) => r.latencyMs),
    "latency"
  );
}

/**
 * Measured spend. Unmeasured rows are excluded from the mean and counted, never
 * filled in from an average — a per-run cost estimate presented as a measurement
 * is the same class of error as a fabricated price.
 */
export function costReport(records: readonly PredictionRecord[]): OperationalReport {
  return operational(
    records.map((r) => r.costUsd),
    "cost"
  );
}
