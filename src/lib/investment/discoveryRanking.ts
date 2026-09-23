// Ranking the names discovery actually researched.
//
// The order is fixed and, deliberately, boring: rating group, then expected
// cumulative return, then the smaller bear-scenario loss, then the ticker. No
// prose and no model can move it, and the same inputs in any order produce the
// same ranking.
//
// The single most likely bug in this file would be comparing a three-month
// expected return to a three-year one. Both are `ReturnEstimate.cumulative`, both
// are plain fractions, and nothing in the number itself says which horizon it
// covers — so a mixed list would sort the longest horizons to the top and call it
// conviction. Every comparison here therefore goes through one horizon identity,
// and a mismatch THROWS rather than silently returning a number. See
// `policyConfig.hurdleForYearFraction`, which compounds the hurdle for exactly the
// same reason.
//
// The second rule is that highlighting is presentation, not deletion. All ten
// deep-researched names keep a result — Avoids and incomplete ones included — even
// though at most five are shown. A name that was researched and then vanished from
// the record is indistinguishable from one that was never researched, and the user
// paid for the difference.

import { HIGHLIGHT_CEILING } from "./discovery";
import type { InvestmentReport } from "./contracts";
import type { Rating } from "./schemas";

// ── Horizon identity ─────────────────────────────────────────────────────────

/**
 * The part of a horizon that makes two expected returns comparable.
 *
 * Count and unit only. `yearFraction` is a derived float and `targetDate` slides
 * with the calendar, so neither is a safe identity — but 12 calendar_months is
 * always the same question as 12 calendar_months.
 */
export interface HorizonIdentity {
  count: number;
  unit: string;
}

export function horizonKey(horizon: HorizonIdentity): string {
  return `${horizon.count}:${horizon.unit}`;
}

/**
 * Thrown when two figures covering different horizons are compared.
 *
 * An error rather than a `null` or a best guess: a caller that mixed horizons has
 * a bug in how it assembled its inputs, and the only safe outcome is that it finds
 * out. Swallowing this would produce a plausible, wrong ranking.
 */
export class HorizonMismatchError extends Error {
  readonly left: string;
  readonly right: string;

  constructor(left: string, right: string) {
    super(
      `refusing to compare expected returns across different horizons: ${left} vs ${right}. ` +
        "A cumulative return is only meaningful against the horizon it was computed over."
    );
    this.name = "HorizonMismatchError";
    this.left = left;
    this.right = right;
  }
}

// ── Inputs ───────────────────────────────────────────────────────────────────

/**
 * One deep-researched name's outcome.
 *
 * The horizon travels alongside the report because `InvestmentReport` does not
 * carry one — it lives on the mandate, via the snapshot — and the comparison below
 * must not have to trust that every caller remembered they all matched.
 */
export interface AssessedResult {
  report: InvestmentReport;
  horizon: HorizonIdentity;
}

export type CompletenessKind = "complete" | "incomplete";

export interface RankedAssessment {
  ticker: string;
  report: InvestmentReport;
  horizon: HorizonIdentity;
  completeness: CompletenessKind;
  /** 1-based, within this entry's own group. Groups are never interleaved. */
  rank: number;
  /** Why this entry is in the incomplete group. Null for complete ones. */
  incompleteReason: string | null;
}

export interface AssessmentRanking {
  /** The one horizon every entry shares. */
  horizonKey: string;
  /** Buy, then Watch, then Avoid; within a rating, by expected return. */
  complete: readonly RankedAssessment[];
  /** A separate group. Never interleaved with `complete`, never dropped. */
  incomplete: readonly RankedAssessment[];
  /** The leading slice of `complete`. Every entry has a complete report. */
  highlighted: readonly RankedAssessment[];
  /** Equals the input length. The assertion that nothing was lost. */
  retainedCount: number;
}

export interface RankingOptions {
  /** Tightened for a narrower page. Never widened past `HIGHLIGHT_CEILING`. */
  highlightCeiling?: number;
}

// ── Rating groups ────────────────────────────────────────────────────────────

/**
 * Rating dominates expected return, and that ordering is intentional.
 *
 * A Buy is a name that cleared its hurdle on inputs that passed the quality gates.
 * A Watch with a higher raw expected return did not — usually because the estimate
 * rests on data too thin to rate on — so promoting it above the Buy on the
 * strength of that very number would invert the gates decision.ts applies.
 */
const RATING_ORDER: Record<Rating, number> = { buy: 0, watch: 1, avoid: 2 };

// ── Comparison primitives ────────────────────────────────────────────────────

/**
 * Compare two results by expected return, highest first.
 *
 * Exported because the horizon guard is the useful part: any caller doing its own
 * sorting should come through here rather than reaching for `.cumulative`.
 *
 * @throws HorizonMismatchError when the two cover different horizons.
 */
export function compareExpectedReturn(a: AssessedResult, b: AssessedResult): number {
  const left = horizonKey(a.horizon);
  const right = horizonKey(b.horizon);
  if (left !== right) throw new HorizonMismatchError(left, right);

  const ar = a.report.returns;
  const br = b.report.returns;
  // A missing estimate is not a low one. Names without a return sort after every
  // name with one, rather than being treated as zero.
  if (ar == null && br == null) return 0;
  if (ar == null) return 1;
  if (br == null) return -1;
  if (ar.cumulative !== br.cumulative) return br.cumulative - ar.cumulative;
  // Same expected return, so the one that loses less in its bear case wins.
  if (ar.bearScenarioLoss !== br.bearScenarioLoss) {
    return ar.bearScenarioLoss - br.bearScenarioLoss;
  }
  return 0;
}

/**
 * Assert every result covers the same horizon, and return it.
 *
 * @throws HorizonMismatchError on the first result that disagrees with the first.
 */
export function assertSingleHorizon(results: readonly AssessedResult[]): string | null {
  let key: string | null = null;
  for (const result of results) {
    const candidate = horizonKey(result.horizon);
    if (key == null) key = candidate;
    else if (key !== candidate) throw new HorizonMismatchError(key, candidate);
  }
  return key;
}

/**
 * Whether a report can be read as a conclusion.
 *
 * `status` is the authority — decision.ts already decided, and re-deriving it here
 * would let the two drift. A complete report with no return estimate is possible
 * (an evidence-backed exclusion is an Avoid without any arithmetic) and stays in
 * the complete group; the comparison above sorts it after the ones with numbers
 * rather than inventing one.
 */
function completenessOf(report: InvestmentReport): {
  kind: CompletenessKind;
  reason: string | null;
} {
  if (report.status === "complete") return { kind: "complete", reason: null };
  if (report.status === "partial") {
    return {
      kind: "incomplete",
      reason:
        report.reasonCodes.length > 0
          ? `partial: ${report.reasonCodes.join(", ")}`
          : "partial: some inputs were missing",
    };
  }
  return {
    kind: "incomplete",
    reason:
      report.reasonCodes.length > 0
        ? `insufficient data: ${report.reasonCodes.join(", ")}`
        : "insufficient data",
  };
}

function clampHighlight(requested: number | undefined): number {
  if (requested == null || !Number.isFinite(requested)) return HIGHLIGHT_CEILING;
  return Math.max(0, Math.min(HIGHLIGHT_CEILING, Math.floor(requested)));
}

// ── The ranking ──────────────────────────────────────────────────────────────

/**
 * Rank the assessed results of one discovery run.
 *
 * Pure and total: every input appears in exactly one of `complete` or
 * `incomplete`, `retainedCount` equals the input length, and shuffling the input
 * cannot change either list.
 *
 * @throws HorizonMismatchError when the results do not all cover one horizon.
 */
export function rankAssessedCandidates(
  results: readonly AssessedResult[],
  options: RankingOptions = {}
): AssessmentRanking {
  const sharedHorizon = assertSingleHorizon(results);

  const complete: AssessedResult[] = [];
  const incomplete: AssessedResult[] = [];
  const reasons = new Map<string, string | null>();

  for (const result of results) {
    const { kind, reason } = completenessOf(result.report);
    reasons.set(result.report.ticker, reason);
    (kind === "complete" ? complete : incomplete).push(result);
  }

  const byTicker = (a: AssessedResult, b: AssessedResult): number => {
    const at = a.report.ticker;
    const bt = b.report.ticker;
    return at < bt ? -1 : at > bt ? 1 : 0;
  };

  const orderedComplete = [...complete].sort((a, b) => {
    const ag = RATING_ORDER[a.report.rating];
    const bg = RATING_ORDER[b.report.rating];
    if (ag !== bg) return ag - bg;
    // Within a rating group the comparison is like-for-like by construction: the
    // single-horizon assertion above already ran over the whole list.
    const byReturn = compareExpectedReturn(a, b);
    if (byReturn !== 0) return byReturn;
    return byTicker(a, b);
  });

  // The incomplete group carries no investment ordering — there is nothing
  // trustworthy to order it by — so it is alphabetical, which at least makes it
  // reproducible and easy to scan for a specific name.
  const orderedIncomplete = [...incomplete].sort(byTicker);

  const toRanked = (
    list: readonly AssessedResult[],
    completeness: CompletenessKind
  ): RankedAssessment[] =>
    list.map((result, index) => ({
      ticker: result.report.ticker,
      report: result.report,
      horizon: result.horizon,
      completeness,
      rank: index + 1,
      incompleteReason: completeness === "incomplete" ? reasons.get(result.report.ticker) ?? null : null,
    }));

  const rankedComplete = toRanked(orderedComplete, "complete");
  const rankedIncomplete = toRanked(orderedIncomplete, "incomplete");

  // Highlighting slices the complete group and nothing else. No rating is excluded:
  // the rating groups already sort Buys first, so an Avoid only ever reaches the
  // highlight when nothing better was found — which is itself the answer, and
  // suppressing it would leave the page looking empty for no stated reason.
  const highlighted = rankedComplete.slice(0, clampHighlight(options.highlightCeiling));

  return {
    horizonKey: sharedHorizon ?? "",
    complete: rankedComplete,
    incomplete: rankedIncomplete,
    highlighted,
    retainedCount: rankedComplete.length + rankedIncomplete.length,
  };
}
