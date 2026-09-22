// Decision policy v1 — the configurable product rules behind a Buy / Watch / Avoid.
//
// Every number here is a PRODUCT DECISION, not a validated optimal investment
// threshold. A 10% annual hurdle is a choice about what is worth the user's
// attention; nothing in this repository establishes that it maximises anything.
// They live in code (not a model prompt) so they are reviewable and diffable, and
// `POLICY_VERSION` is persisted with every result so a report can be re-read
// against the rules that produced it — and so changing a threshold invalidates
// caches instead of silently re-rating yesterday's reports.
//
// Bump POLICY_VERSION in the same commit as any threshold change, never
// retroactively. This mirrors live/version.ts, which does the same for agents.

/** Bump with any change to the values below. Persisted on every report. */
export const POLICY_VERSION = "policy-v1-2026-09-21";

export const POLICY_V1 = {
  /** Annual total return below which a name is not worth holding over the benchmark. */
  annualReturnHurdle: 0.1,
  /** Bear-scenario loss above which a name is an Avoid regardless of upside. */
  maxBearScenarioLoss: 0.35,
  /** Fraction of the ENUMERATED required inputs for the chosen valuation method. */
  minCriticalCoverage: 0.8,
  /** Below this, a model's scenario distribution is too diffuse to rate on. */
  minScenarioConfidence: 0.6,
  /**
   * The default scenario weights, used when no model distribution is available.
   *
   * This is an explicit, uninformative prior — NOT a forecast, and never to be
   * displayed as one. It exists so the deterministic return arithmetic is
   * complete and testable without any probability provider: the report says
   * `basis: "fixed_prior"` and the UI labels it a fixed assumption. A labelled
   * prior is more honest than a model-authored distribution presented as
   * knowledge, and it costs nothing per run.
   */
  defaultScenarioWeights: { bear: 0.25, base: 0.5, bull: 0.25 },
  /** Max age of an intraday price during the regular session, in seconds. */
  maxIntradayPriceAgeSeconds: 15 * 60,
} as const;

/**
 * The cumulative return a horizon must clear to meet the annual hurdle.
 *
 * Compounds the annual hurdle over the horizon's actual year fraction, so a
 * two-year report is judged against ~21% rather than 10%. Comparing a multi-year
 * cumulative return to a single-year hurdle is the most likely way this engine
 * would call a mediocre holding a Buy.
 */
export function hurdleForYearFraction(
  yearFraction: number,
  annualHurdle: number = POLICY_V1.annualReturnHurdle
): number {
  if (!Number.isFinite(yearFraction) || yearFraction <= 0) {
    throw new Error(`yearFraction must be a positive finite number, got ${yearFraction}`);
  }
  return (1 + annualHurdle) ** yearFraction - 1;
}
