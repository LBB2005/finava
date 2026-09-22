// The rating policy — how numbers become Buy / Watch / Avoid.
//
// One rule governs the whole module, and it is a rule about honesty rather than
// about investing: NOT KNOWING IS NOT A VERDICT. A missing filing, a rate-limited
// provider, an unsupported sector — none of these are evidence against a company,
// so none of them can produce an Avoid. They produce `Watch` with a reason that
// names what was missing. Avoid is reserved for cases where the evidence we DO
// have argues against the investment.
//
// Getting this backwards would be the most damaging possible bug here: a provider
// outage would silently become investment advice, and the more broken the data
// pipeline got, the more confident the sell signals would look.
//
// Quality gates run BEFORE the investment thresholds, so a number computed from
// inadequate inputs is never compared to a hurdle in the first place. The order
// is fixed and tested.

import { POLICY_V1, POLICY_VERSION, hurdleForYearFraction } from "./policyConfig";
import type { Rating, ReportStatus, ReturnEstimate, ScenarioWeights } from "./schemas";

/**
 * Stable, machine-readable reasons. Persisted on the report so the UI can explain
 * a rating without re-deriving it, and so an eval can ask which gate fires most.
 */
export const REASON = {
  noReturnEstimate: "no_return_estimate",
  lowCriticalCoverage: "low_critical_coverage",
  stalePrice: "stale_price",
  noWeights: "no_scenario_weights",
  lowConfidence: "low_scenario_confidence",
  exclusionViolation: "exclusion_rule_violation",
  unresolvedContradiction: "unresolved_contradiction",
  negativeExpectedReturn: "negative_expected_return",
  bearLossTooLarge: "bear_loss_above_limit",
  clearsHurdle: "clears_return_hurdle",
  belowHurdle: "below_return_hurdle",
  experimentalWeights: "experimental_scenario_weights",
} as const;

export type ReasonCode = (typeof REASON)[keyof typeof REASON];

/** Floating-point slack when comparing a return to a compounded hurdle. */
const HURDLE_EPSILON = 1e-9;

export interface DecisionInput {
  /**
   * Fraction of the ENUMERATED required inputs for the chosen valuation method
   * that were actually present — not the fraction of arbitrary collected fields.
   */
  criticalCoverage: number;
  /** Whether the price meets the freshness rule for the current session. */
  hasFreshPrice: boolean;
  /** Null when the arithmetic could not be completed. */
  returns: ReturnEstimate | null;
  /** Null when no distribution was available. */
  weights: ScenarioWeights | null;
  /** How concentrated the scenario distribution is. Null when not measured. */
  scenarioConfidence: number | null;
  /** The horizon's actual year fraction, for compounding the hurdle. */
  yearFraction: number;
  /** Hard exclusions the user or mandate declared, with evidence behind them. */
  exclusionViolations?: readonly string[];
  /** Material disagreements the skeptic could not resolve. */
  unresolvedContradictions?: readonly string[];
  policy?: typeof POLICY_V1;
}

export interface DecisionOutput {
  rating: Rating;
  status: ReportStatus;
  reasonCodes: ReasonCode[];
  /** The hurdle this horizon was actually judged against, for display. */
  hurdle: number | null;
  policyVersion: string;
  /** True when the rating rests on weights that have never been tested. */
  experimental: boolean;
}

/**
 * Decide a rating from computed inputs.
 *
 * Deterministic and pure: the same input always produces the same rating. A
 * narrative writer downstream explains this result and cannot change it.
 */
export function decideInvestment(input: DecisionInput): DecisionOutput {
  const policy = input.policy ?? POLICY_V1;
  const reasonCodes: ReasonCode[] = [];

  // A rating that rests on an untested distribution must say so wherever it
  // appears, including on a Buy. Recorded before any early return.
  const experimental =
    input.weights != null &&
    input.weights.basis !== "empirically_calibrated";
  if (experimental) reasonCodes.push(REASON.experimentalWeights);

  const watch = (status: ReportStatus): DecisionOutput => ({
    rating: "watch",
    status,
    reasonCodes,
    hurdle: null,
    policyVersion: POLICY_VERSION,
    experimental,
  });

  // ── 1. Exclusions come first, because they are evidence-backed ──────────────
  // A declared hard exclusion the company demonstrably violates is a real Avoid:
  // it rests on something we observed, not on something we failed to observe.
  const violations = input.exclusionViolations ?? [];
  if (violations.length > 0) {
    reasonCodes.push(REASON.exclusionViolation);
    return {
      rating: "avoid",
      status: "complete",
      reasonCodes,
      hurdle: null,
      policyVersion: POLICY_VERSION,
      experimental,
    };
  }

  // ── 2. Quality gates — each yields Watch, never Avoid ──────────────────────
  // These are all statements about OUR data, not about the company.
  let gateFailed = false;

  if (!Number.isFinite(input.criticalCoverage) || input.criticalCoverage < policy.minCriticalCoverage) {
    reasonCodes.push(REASON.lowCriticalCoverage);
    gateFailed = true;
  }
  if (!input.hasFreshPrice) {
    reasonCodes.push(REASON.stalePrice);
    gateFailed = true;
  }
  if (input.weights == null) {
    reasonCodes.push(REASON.noWeights);
    gateFailed = true;
  }
  if (input.returns == null) {
    reasonCodes.push(REASON.noReturnEstimate);
    gateFailed = true;
  }

  if (gateFailed) {
    // insufficient_data when there is no usable estimate at all; partial when an
    // estimate exists but rests on inputs too thin to rate on.
    const status: ReportStatus =
      input.returns == null || input.weights == null ? "insufficient_data" : "partial";
    return watch(status);
  }

  const returns = input.returns!;

  // ── 3. An unresolved material contradiction is not a verdict either ────────
  if ((input.unresolvedContradictions ?? []).length > 0) {
    reasonCodes.push(REASON.unresolvedContradiction);
    return watch("partial");
  }

  // ── 4. A distribution too diffuse to act on. The estimate stays visible as
  //       uncertain rather than being hidden or hardened into a call.
  if (input.scenarioConfidence != null && input.scenarioConfidence < policy.minScenarioConfidence) {
    reasonCodes.push(REASON.lowConfidence);
    return watch("partial");
  }

  // ── 5. Investment thresholds — only now, on inputs that passed the gates ───
  const hurdle = hurdleForYearFraction(input.yearFraction, policy.annualReturnHurdle);

  const avoid = (code: ReasonCode): DecisionOutput => {
    reasonCodes.push(code);
    return {
      rating: "avoid",
      status: "complete",
      reasonCodes,
      hurdle,
      policyVersion: POLICY_VERSION,
      experimental,
    };
  };

  if (returns.cumulative < 0) return avoid(REASON.negativeExpectedReturn);
  if (returns.bearScenarioLoss > policy.maxBearScenarioLoss) return avoid(REASON.bearLossTooLarge);

  // The comparison is cumulative-to-cumulative: the hurdle was compounded over
  // this horizon precisely so a two-year report is not judged against one year.
  //
  // The epsilon is not a fudge factor — it absorbs the representation error in
  // the hurdle itself. `1.1 ** 1 - 1` is 0.10000000000000009, so an expected
  // return of exactly 0.1 would otherwise fail to clear a 10% hurdle. At 1e-9
  // (a ten-millionth of a percent) it cannot change any economically meaningful
  // comparison, only the ones floating point got wrong.
  const clears = returns.cumulative >= hurdle - HURDLE_EPSILON;
  reasonCodes.push(clears ? REASON.clearsHurdle : REASON.belowHurdle);

  return {
    rating: clears ? "buy" : "watch",
    status: "complete",
    reasonCodes,
    hurdle,
    policyVersion: POLICY_VERSION,
    experimental,
  };
}
