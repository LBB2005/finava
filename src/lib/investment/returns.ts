// Scenario returns — the arithmetic behind every expected-return number shown.
//
// Deliberately the dullest module in the feature. Its whole value is that it is
// reproducible: given a price, three scenario valuations and a weight triple, the
// cumulative return is a fixed calculation that no prose can move. A model may
// argue about the inputs; it may not author the output.
//
// The counterpart property is that it returns `unavailable` rather than a number
// whenever an input is missing. A missing price must never become 0, and missing
// weights must never become an equal-probability triple — an invented
// distribution presented as a forecast is worse than an absent one, because the
// reader cannot tell it was invented.

import { ProbabilityTripleSchema, type ReturnEstimate, type ScenarioId, type ScenarioValue, type ScenarioWeights } from "./schemas";

export type ReturnsResult =
  | { status: "ok"; estimate: ReturnEstimate }
  | { status: "unavailable"; reason: string };

const SCENARIO_IDS: readonly ScenarioId[] = ["bear", "base", "bull"] as const;

function unavailable(reason: string): ReturnsResult {
  return { status: "unavailable", reason };
}

/**
 * Total return for one scenario, as a fraction of the current price.
 *
 * Distributions are cash received over the horizon and are added once, with no
 * assumed reinvestment. Modelling reinvestment would require a reinvestment rate
 * we do not have, and guessing one inflates every long-horizon estimate.
 */
function scenarioReturn(priceNow: number, s: ScenarioValue): number {
  return (s.priceAtHorizon + s.distributionsPerShare - priceNow) / priceNow;
}

/**
 * Compute the scenario-weighted expected return over a horizon.
 *
 * `yearFraction` is the horizon's actual elapsed-calendar fraction, used only to
 * annualize. The annualized figure is the annualized equivalent of expected
 * TERMINAL WEALTH — not expected CAGR, which is a different and smaller number —
 * and it is withheld below one year, where annualizing a three-month view
 * manufactures confidence the horizon cannot support.
 */
export function computeReturns(
  priceNow: number | null | undefined,
  scenarios: readonly ScenarioValue[],
  weights: ScenarioWeights | null | undefined,
  yearFraction: number
): ReturnsResult {
  if (priceNow == null) {
    return unavailable("no current price — an expected return needs a price to measure from");
  }
  if (!Number.isFinite(priceNow) || priceNow <= 0) {
    return unavailable(`current price must be a positive finite number, got ${priceNow}`);
  }
  if (!Number.isFinite(yearFraction) || yearFraction <= 0) {
    return unavailable(`horizon year fraction must be positive, got ${yearFraction}`);
  }
  if (weights == null) {
    return unavailable(
      "no scenario weights — equal probabilities are not a substitute for an unavailable distribution"
    );
  }
  if (!ProbabilityTripleSchema.safeParse(weights.values).success) {
    return unavailable("scenario weights are not a valid probability distribution");
  }

  // Exactly one valuation per scenario. A duplicate would be silently weighted
  // twice; a missing one would leave part of the distribution unpriced.
  const byId = new Map<ScenarioId, ScenarioValue>();
  for (const s of scenarios) {
    if (byId.has(s.id)) return unavailable(`duplicate ${s.id} scenario valuation`);
    byId.set(s.id, s);
  }
  const missing = SCENARIO_IDS.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return unavailable(`missing scenario valuation${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  }

  const scenarioReturns = {
    bear: scenarioReturn(priceNow, byId.get("bear")!),
    base: scenarioReturn(priceNow, byId.get("base")!),
    bull: scenarioReturn(priceNow, byId.get("bull")!),
  };

  const cumulative =
    weights.values.bear * scenarioReturns.bear +
    weights.values.base * scenarioReturns.base +
    weights.values.bull * scenarioReturns.bull;

  if (!Number.isFinite(cumulative)) {
    return unavailable("expected return did not resolve to a finite number");
  }

  return {
    status: "ok",
    estimate: {
      cumulative,
      annualizedWealthEquivalent:
        yearFraction >= 1 ? (1 + cumulative) ** (1 / yearFraction) - 1 : null,
      // A positive magnitude, so "how much could I lose" reads without a sign
      // flip. This is the BEAR SCENARIO's loss, not the maximum possible loss and
      // not a drawdown — the report must keep those three apart.
      bearScenarioLoss: Math.max(0, -scenarioReturns.bear),
      scenarioReturns,
    },
  };
}
