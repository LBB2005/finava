import { describe, it, expect } from "vitest";
import {
  HorizonMismatchError,
  assertSingleHorizon,
  compareExpectedReturn,
  horizonKey,
  rankAssessedCandidates,
  type AssessedResult,
} from "./discoveryRanking";
import { HIGHLIGHT_CEILING } from "./discovery";
import type { InvestmentReport } from "./contracts";
import type { Rating, ReportStatus, ReturnEstimate } from "./schemas";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const YEAR = { count: 12, unit: "calendar_months" };
const QUARTER = { count: 3, unit: "calendar_months" };

function returns(cumulative: number, bearLoss = 0.2): ReturnEstimate {
  return {
    cumulative,
    annualizedWealthEquivalent: cumulative,
    bearScenarioLoss: bearLoss,
    scenarioReturns: { bear: -bearLoss, base: cumulative, bull: cumulative + 0.3 },
  };
}

function report(
  ticker: string,
  over: Partial<InvestmentReport> & { rating?: Rating; status?: ReportStatus } = {}
): InvestmentReport {
  return {
    id: `report-${ticker}`,
    ownerUid: "uid-1",
    snapshotId: `snap-${ticker}`,
    ticker,
    status: "complete",
    rating: "buy",
    reasonCodes: [],
    hurdle: 0.1,
    experimental: true,
    valuation: {
      method: "forward_multiple",
      gaps: [],
      scenarios: null,
      proxies: [],
      criticalCoverage: 1,
      valuationVersion: "val-v1",
    },
    scenarios: null,
    weights: null,
    returns: returns(0.2),
    buckets: null,
    claims: [],
    dissent: [],
    probabilityBasis: "fixed_prior",
    versions: {
      policyVersion: "policy-v1",
      valuationVersion: "val-v1",
      questionSetVersion: null,
      agentVersion: "agent-v1",
    },
    costUsd: null,
    completedAt: "2026-09-22T12:00:00.000Z",
    ...over,
  };
}

function assessed(
  ticker: string,
  over: Partial<InvestmentReport> = {},
  horizon = YEAR
): AssessedResult {
  return { report: report(ticker, over), horizon };
}

// ── The horizon guard ────────────────────────────────────────────────────────

describe("horizon identity", () => {
  it("distinguishes count and unit, and nothing else", () => {
    expect(horizonKey(YEAR)).toBe("12:calendar_months");
    expect(horizonKey(QUARTER)).not.toBe(horizonKey(YEAR));
    expect(horizonKey({ count: 12, unit: "trading_days" })).not.toBe(horizonKey(YEAR));
  });
});

describe("compareExpectedReturn — mixing horizons is rejected", () => {
  it("throws rather than comparing a quarter to a year", () => {
    const quarter = assessed("SHORT", { returns: returns(0.05) }, QUARTER);
    const year = assessed("LONG", { returns: returns(0.4) }, YEAR);
    expect(() => compareExpectedReturn(quarter, year)).toThrow(HorizonMismatchError);
    expect(() => compareExpectedReturn(quarter, year)).toThrow(/different horizons/);
  });

  it("throws when only the unit differs, even at the same count", () => {
    const a = assessed("A", {}, { count: 12, unit: "calendar_months" });
    const b = assessed("B", {}, { count: 12, unit: "trading_days" });
    expect(() => compareExpectedReturn(a, b)).toThrow(HorizonMismatchError);
  });

  it("names both horizons on the error, so the caller can find its bug", () => {
    try {
      compareExpectedReturn(assessed("A", {}, QUARTER), assessed("B", {}, YEAR));
      throw new Error("expected a HorizonMismatchError");
    } catch (err) {
      expect(err).toBeInstanceOf(HorizonMismatchError);
      const mismatch = err as HorizonMismatchError;
      expect(mismatch.left).toBe("3:calendar_months");
      expect(mismatch.right).toBe("12:calendar_months");
    }
  });

  it("compares like-for-like horizons, highest expected return first", () => {
    const low = assessed("LOW", { returns: returns(0.1) });
    const high = assessed("HIGH", { returns: returns(0.3) });
    expect(compareExpectedReturn(high, low)).toBeLessThan(0);
    expect(compareExpectedReturn(low, high)).toBeGreaterThan(0);
  });

  it("breaks an equal expected return by the smaller bear-scenario loss", () => {
    const safer = assessed("SAFER", { returns: returns(0.2, 0.1) });
    const riskier = assessed("RISKIER", { returns: returns(0.2, 0.4) });
    expect(compareExpectedReturn(safer, riskier)).toBeLessThan(0);
  });

  it("sorts a missing estimate after every present one, never as a zero", () => {
    const none = assessed("NONE", { returns: null });
    const negative = assessed("NEG", { returns: returns(-0.5) });
    expect(compareExpectedReturn(negative, none)).toBeLessThan(0);
    expect(compareExpectedReturn(none, negative)).toBeGreaterThan(0);
  });
});

describe("assertSingleHorizon", () => {
  it("accepts a uniform list and returns its key", () => {
    expect(assertSingleHorizon([assessed("A"), assessed("B")])).toBe("12:calendar_months");
  });

  it("accepts an empty list with no horizon to report", () => {
    expect(assertSingleHorizon([])).toBeNull();
  });

  it("rejects a list that mixes horizons", () => {
    expect(() =>
      assertSingleHorizon([assessed("A"), assessed("B", {}, QUARTER)])
    ).toThrow(HorizonMismatchError);
  });
});

describe("rankAssessedCandidates — mixed horizons never rank together", () => {
  it("throws before producing any ordering", () => {
    expect(() =>
      rankAssessedCandidates([
        assessed("YEARLY", { returns: returns(0.2) }),
        assessed("QUARTERLY", { returns: returns(0.9) }, QUARTER),
      ])
    ).toThrow(HorizonMismatchError);
  });
});

// ── Ordering ─────────────────────────────────────────────────────────────────

describe("rankAssessedCandidates — order of precedence", () => {
  const RESULTS: AssessedResult[] = [
    assessed("AVOID_HI", { rating: "avoid", returns: returns(0.9) }),
    assessed("WATCH_HI", { rating: "watch", returns: returns(0.8) }),
    assessed("BUY_LO", { rating: "buy", returns: returns(0.12) }),
    assessed("BUY_HI", { rating: "buy", returns: returns(0.5) }),
  ];

  it("puts the rating group ahead of the raw expected return", () => {
    const ranking = rankAssessedCandidates(RESULTS);
    expect(ranking.complete.map((r) => r.ticker)).toEqual([
      "BUY_HI",
      "BUY_LO",
      "WATCH_HI",
      "AVOID_HI",
    ]);
  });

  it("falls to the bear-scenario loss when expected returns tie", () => {
    const ranking = rankAssessedCandidates([
      assessed("RISKIER", { returns: returns(0.25, 0.33) }),
      assessed("SAFER", { returns: returns(0.25, 0.05) }),
    ]);
    expect(ranking.complete.map((r) => r.ticker)).toEqual(["SAFER", "RISKIER"]);
  });

  it("falls to the ticker when everything else ties", () => {
    const ranking = rankAssessedCandidates([
      assessed("ZZZ", { returns: returns(0.25, 0.1) }),
      assessed("AAA", { returns: returns(0.25, 0.1) }),
      assessed("MMM", { returns: returns(0.25, 0.1) }),
    ]);
    expect(ranking.complete.map((r) => r.ticker)).toEqual(["AAA", "MMM", "ZZZ"]);
  });

  it("keeps a complete Avoid with no arithmetic behind it, sorted last in its group", () => {
    // An evidence-backed exclusion is a complete Avoid with null returns.
    const ranking = rankAssessedCandidates([
      assessed("EXCLUDED", { rating: "avoid", returns: null, hurdle: null }),
      assessed("RATED_AVOID", { rating: "avoid", returns: returns(-0.1) }),
    ]);
    expect(ranking.complete.map((r) => r.ticker)).toEqual(["RATED_AVOID", "EXCLUDED"]);
    expect(ranking.incomplete).toEqual([]);
  });

  it("numbers each group from 1", () => {
    const ranking = rankAssessedCandidates([
      ...RESULTS,
      assessed("THIN", { status: "partial", reasonCodes: ["low_critical_coverage"] }),
    ]);
    expect(ranking.complete.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(ranking.incomplete.map((r) => r.rank)).toEqual([1]);
  });

  it("is stable and deterministic across shuffled input", () => {
    const shuffles = [
      [...RESULTS],
      [...RESULTS].reverse(),
      [RESULTS[2], RESULTS[0], RESULTS[3], RESULTS[1]],
      [RESULTS[1], RESULTS[3], RESULTS[2], RESULTS[0]],
    ];
    const orders = shuffles.map((input) =>
      rankAssessedCandidates(input).complete.map((r) => r.ticker)
    );
    for (const order of orders) expect(order).toEqual(orders[0]);
  });
});

// ── Completeness ─────────────────────────────────────────────────────────────

describe("rankAssessedCandidates — incomplete results are separate, not dropped", () => {
  const MIXED: AssessedResult[] = [
    assessed("COMPLETE_A", { returns: returns(0.4) }),
    assessed("PARTIAL", {
      status: "partial",
      rating: "watch",
      returns: returns(9.9),
      reasonCodes: ["low_scenario_confidence"],
    }),
    assessed("NO_DATA", {
      status: "insufficient_data",
      rating: "watch",
      returns: null,
      reasonCodes: ["no_return_estimate"],
    }),
    assessed("COMPLETE_B", { returns: returns(0.2) }),
  ];

  it("never interleaves an incomplete result with the complete ones", () => {
    const ranking = rankAssessedCandidates(MIXED);
    expect(ranking.complete.map((r) => r.ticker)).toEqual(["COMPLETE_A", "COMPLETE_B"]);
    expect(ranking.incomplete.map((r) => r.ticker)).toEqual(["NO_DATA", "PARTIAL"]);
    // The partial's 990% expected return does not buy it a place in the ranking.
    expect(ranking.complete.map((r) => r.ticker)).not.toContain("PARTIAL");
  });

  it("retains every input, so nothing researched disappears", () => {
    const ranking = rankAssessedCandidates(MIXED);
    expect(ranking.retainedCount).toBe(MIXED.length);
    const retained = [...ranking.complete, ...ranking.incomplete].map((r) => r.ticker).sort();
    expect(retained).toEqual(MIXED.map((r) => r.report.ticker).sort());
  });

  it("says why each incomplete result is incomplete", () => {
    const ranking = rankAssessedCandidates(MIXED);
    const byTicker = new Map(ranking.incomplete.map((r) => [r.ticker, r]));
    expect(byTicker.get("PARTIAL")!.incompleteReason).toContain("low_scenario_confidence");
    expect(byTicker.get("NO_DATA")!.incompleteReason).toContain("insufficient data");
    for (const entry of ranking.complete) expect(entry.incompleteReason).toBeNull();
  });

  it("keeps all ten deep-researched names when only five are highlighted", () => {
    const ten: AssessedResult[] = [
      ...Array.from({ length: 6 }, (_, i) =>
        assessed(`BUY${i}`, { rating: "buy", returns: returns(0.5 - i * 0.01) })
      ),
      assessed("AVOID1", { rating: "avoid", returns: returns(-0.2) }),
      assessed("AVOID2", { rating: "avoid", returns: returns(-0.3) }),
      assessed("THIN1", { status: "partial", rating: "watch", reasonCodes: ["stale_price"] }),
      assessed("THIN2", { status: "insufficient_data", rating: "watch", returns: null }),
    ];
    const ranking = rankAssessedCandidates(ten);
    expect(ranking.retainedCount).toBe(10);
    expect(ranking.highlighted).toHaveLength(HIGHLIGHT_CEILING);
    // Highlighting is presentation: the Avoids and the incomplete names are still
    // on the record, just not on the highlight reel.
    const everyone = [...ranking.complete, ...ranking.incomplete].map((r) => r.ticker);
    expect(everyone).toContain("AVOID1");
    expect(everyone).toContain("THIN2");
  });
});

// ── Highlighting ─────────────────────────────────────────────────────────────

describe("rankAssessedCandidates — highlighting", () => {
  it("highlights only complete reports", () => {
    const ranking = rankAssessedCandidates([
      assessed("GOOD1", { returns: returns(0.4) }),
      assessed("THIN1", { status: "partial", returns: returns(5) }),
      assessed("GOOD2", { returns: returns(0.3) }),
      assessed("THIN2", { status: "insufficient_data", returns: null }),
    ]);
    expect(ranking.highlighted.map((r) => r.ticker)).toEqual(["GOOD1", "GOOD2"]);
    for (const entry of ranking.highlighted) {
      expect(entry.report.status).toBe("complete");
      expect(entry.completeness).toBe("complete");
    }
  });

  it("highlights fewer than five when fewer than five are complete, without padding", () => {
    const ranking = rankAssessedCandidates([
      assessed("ONE", { returns: returns(0.4) }),
      assessed("THIN", { status: "partial" }),
    ]);
    expect(ranking.highlighted).toHaveLength(1);
  });

  it("highlights nothing when nothing completed", () => {
    const ranking = rankAssessedCandidates([
      assessed("THIN1", { status: "partial" }),
      assessed("THIN2", { status: "insufficient_data", returns: null }),
    ]);
    expect(ranking.highlighted).toEqual([]);
    expect(ranking.incomplete).toHaveLength(2);
  });

  it("lets a caller tighten the highlight ceiling but never widen it", () => {
    const eight = Array.from({ length: 8 }, (_, i) =>
      assessed(`B${i}`, { returns: returns(0.5 - i * 0.01) })
    );
    expect(rankAssessedCandidates(eight, { highlightCeiling: 2 }).highlighted).toHaveLength(2);
    expect(rankAssessedCandidates(eight, { highlightCeiling: 99 }).highlighted).toHaveLength(
      HIGHLIGHT_CEILING
    );
  });

  it("reports the one horizon the whole ranking covers", () => {
    const ranking = rankAssessedCandidates([assessed("A"), assessed("B")]);
    expect(ranking.horizonKey).toBe("12:calendar_months");
  });

  it("handles an empty run without inventing a horizon", () => {
    const ranking = rankAssessedCandidates([]);
    expect(ranking.horizonKey).toBe("");
    expect(ranking.complete).toEqual([]);
    expect(ranking.incomplete).toEqual([]);
    expect(ranking.highlighted).toEqual([]);
    expect(ranking.retainedCount).toBe(0);
  });
});
