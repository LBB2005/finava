// Scenario outcome buckets — how a forecast becomes resolvable.
//
// Three scenario returns are three representative points, not an estimated
// continuous distribution. To ask a model for a probability over them, and to
// score that probability once the horizon matures, the three need to partition
// the real line: every possible realised return must fall in exactly one bucket.
//
// Boundaries sit at the midpoints between adjacent scenario returns:
//
//     bear ....... b1 ....... base ....... b2 ....... bull
//     └── bear ──┘└─────── base ───────┘└──── bull ────┘
//
// bear is below b1; base is [b1, b2); bull is at or above b2. Half-open intervals
// mean a realised return landing exactly on a boundary has one answer, not two.
//
// The boundaries are stored WITH the report, because they are part of what was
// forecast. Recomputing them later from re-derived scenarios would silently
// re-score a prediction against a question it was never asked.
//
// This makes a forecast resolvable. It does not make it accurate.

import type { ScenarioId } from "./schemas";

export interface ScenarioBuckets {
  /** [lower, upper] — the two midpoints, ascending. */
  boundaries: [number, number];
}

export type BucketResult =
  | { status: "ok"; buckets: ScenarioBuckets }
  | { status: "invalid"; reason: string };

export interface ScenarioReturnTriple {
  bear: number;
  base: number;
  bull: number;
}

/**
 * Derive bucket boundaries from three scenario returns.
 *
 * Requires STRICT ordering bear < base < bull. Equal or inverted scenarios fail
 * rather than being reordered: if the bear case is not worse than the base case,
 * the valuation disagrees with its own labels, and the honest response is to
 * refuse the buckets instead of quietly sorting the numbers into agreement.
 */
export function buildScenarioBuckets(returns: ScenarioReturnTriple): BucketResult {
  const { bear, base, bull } = returns;

  for (const [name, value] of Object.entries(returns)) {
    if (!Number.isFinite(value)) {
      return { status: "invalid", reason: `${name} scenario return is not finite` };
    }
  }
  if (!(bear < base && base < bull)) {
    return {
      status: "invalid",
      reason: `scenario returns must be strictly ordered bear < base < bull, got ${bear} / ${base} / ${bull}`,
    };
  }

  return {
    status: "ok",
    buckets: { boundaries: [(bear + base) / 2, (base + bull) / 2] },
  };
}

/**
 * Which bucket a realised total return fell into. Used at resolution time,
 * against the boundaries stored on the original report.
 */
export function classifyRealisedReturn(
  realised: number,
  buckets: ScenarioBuckets
): ScenarioId | null {
  if (!Number.isFinite(realised)) return null;
  const [lower, upper] = buckets.boundaries;
  if (realised < lower) return "bear";
  if (realised < upper) return "base";
  return "bull";
}
