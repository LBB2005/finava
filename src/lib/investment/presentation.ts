// Formatting for investment reports. Pure, client-safe, no I/O.
//
// This module exists to hold one line: NULL RENDERS AS "Unavailable", NEVER AS A
// NUMBER. Every other honesty property in this feature — null weights on a
// provider failure, named valuation gaps, `insufficient_data` status, coverage
// distinct from accuracy — is undone the moment the UI prints a missing value as
// "0.0%". A reader cannot distinguish "we measured zero" from "we have nothing",
// and the second is far more common.
//
// It also keeps six easily-confused numbers apart, because they are routinely
// conflated and mean entirely different things:
//
//   as-of price               what the stock trades at now
//   fair value today         a model's estimate of present intrinsic value
//   horizon price            a scenario's projected price at the target date
//   expected return          probability-weighted, over the whole horizon
//   Finava Score             a factor ranking, NOT a probability
//   model confidence         how concentrated an answer distribution was,
//                            NOT how often the model has been right
//
// Nothing here may relabel one as another, and no function in this file invents a
// value to make a layout look complete.

import type { Rating, ReportStatus, ProbabilityBasis, ScenarioId } from "./schemas";

/** The one string every missing value renders as. Never "0", "0%", "—" or "N/A". */
export const UNAVAILABLE = "Unavailable";

/**
 * Format a fraction as a percentage. Null, undefined and non-finite all render as
 * `UNAVAILABLE` — a missing expected return must never appear as 0%.
 */
export function pct(fraction: number | null | undefined, digits = 1): string {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return UNAVAILABLE;
  const sign = fraction > 0 ? "+" : "";
  return `${sign}${(fraction * 100).toFixed(digits)}%`;
}

/** Percentage without a leading + (for magnitudes like a loss, already positive). */
export function pctMagnitude(fraction: number | null | undefined, digits = 1): string {
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return UNAVAILABLE;
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Format a USD per-share price. Zero is a REAL price here — equity can go to zero. */
export function money(value: number | null | undefined, digits = 2): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return UNAVAILABLE;
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export const RATING_LABEL: Record<Rating, string> = {
  buy: "Buy",
  watch: "Watch",
  avoid: "Avoid",
};

/**
 * Semantic token per rating. Watch is deliberately NEUTRAL, not a warning colour:
 * most Watch ratings mean "we do not have enough to judge", and dressing that as
 * a caution reads as a negative verdict on the company.
 */
export const RATING_TOKEN: Record<Rating, string> = {
  buy: "var(--color-bull)",
  watch: "var(--color-muted)",
  avoid: "var(--color-bear)",
};

export const SCENARIO_LABEL: Record<ScenarioId, string> = {
  bear: "Bear",
  base: "Base",
  bull: "Bull",
};

/**
 * What a status means for the reader, in plain words.
 *
 * `insufficient_data` says the data was missing — NOT that the company is bad. A
 * provider outage must never read as an investment judgment.
 */
export const STATUS_COPY: Record<ReportStatus, string> = {
  complete: "Complete — every required input was available.",
  partial: "Partial — some inputs were missing, so this is less certain than a complete report.",
  insufficient_data:
    "Insufficient data — we could not gather enough to judge this. That is a statement about our data, not about the company.",
};

/**
 * How to describe where the scenario probabilities came from.
 *
 * The distinctions are the point. A fixed prior is an ASSUMPTION we chose, not a
 * forecast; an unvalidated model distribution has never been tested against real
 * outcomes; only `empirically_calibrated` has been measured, and the schema
 * refuses that label without a calibration artifact behind it.
 */
export const BASIS_COPY: Record<ProbabilityBasis, string> = {
  fixed_prior:
    "Fixed assumption (25/50/25), not a forecast. No model estimated these probabilities.",
  user_assigned: "Probabilities you set yourself.",
  model_unvalidated:
    "Estimated by a model and never tested against real outcomes. Treat as experimental.",
  empirically_calibrated: "Calibrated against resolved predictions.",
};

/** Short badge text for the same thing, for use next to a rating. */
export const BASIS_BADGE: Record<ProbabilityBasis, string> = {
  fixed_prior: "Fixed assumption",
  user_assigned: "Your probabilities",
  model_unvalidated: "Experimental estimate",
  empirically_calibrated: "Calibrated",
};

/**
 * Human-readable reason codes. Unknown codes fall back to a de-slugged form
 * rather than being hidden, so a new code surfaces as prose instead of vanishing.
 */
const REASON_COPY: Record<string, string> = {
  no_return_estimate: "The expected return could not be computed.",
  low_critical_coverage: "Too many of the inputs this valuation needs were missing.",
  stale_price: "The price was too stale to judge against.",
  no_scenario_weights: "No scenario probabilities were available.",
  low_scenario_confidence: "The scenario distribution was too uncertain to act on.",
  exclusion_rule_violation: "It breaches a limit you set.",
  unresolved_contradiction: "Sources materially disagree and it was not resolved.",
  negative_expected_return: "The expected return is negative.",
  bear_loss_above_limit: "The bear-case loss exceeds the maximum you allow.",
  clears_return_hurdle: "The expected return clears the hurdle for this horizon.",
  below_return_hurdle: "The expected return is positive but below the hurdle for this horizon.",
  experimental_scenario_weights:
    "The probabilities behind this have never been tested against real outcomes.",
};

export function reasonCopy(code: string): string {
  return REASON_COPY[code] ?? code.replace(/_/g, " ");
}

/**
 * Describe a horizon in the words the user used.
 *
 * `assumed` must be visible: a default the user never chose has to be labelled,
 * or they will read a 12-month thesis as whatever horizon they had in mind.
 */
export function horizonLabel(horizon: {
  count: number;
  unit: string;
  assumed: boolean;
  targetDate: string;
}): string {
  const unit =
    horizon.unit === "calendar_months"
      ? horizon.count === 1
        ? "month"
        : "months"
      : "trading days";
  const base = `${horizon.count} ${unit} → ${horizon.targetDate}`;
  return horizon.assumed ? `${base} (assumed)` : base;
}

/**
 * Whether to show the annualized figure at all.
 *
 * Below a year it is withheld: annualizing a three-month view manufactures a
 * yearly number the horizon cannot support. `returns.ts` already returns null
 * there; this keeps the UI from inventing one from the cumulative figure.
 */
export function showAnnualized(yearFraction: number): boolean {
  return Number.isFinite(yearFraction) && yearFraction >= 1;
}

/** Caption for the annualized number, naming what it actually is. */
export const ANNUALIZED_CAPTION =
  "Annualized equivalent of expected terminal wealth — not expected CAGR.";

/** Caption that must accompany a Finava Score wherever it appears on a report. */
export const SCORE_CAPTION =
  "Factor ranking versus sector peers. Not a probability, and not part of the rating below.";
