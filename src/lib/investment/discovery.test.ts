import { describe, it, expect } from "vitest";
import {
  ASSESSMENT_CEILING,
  DEEP_RESEARCH_CEILING,
  DISCOVERY_DETERMINISTIC_ORDER_LABEL,
  DISCOVERY_NO_MATCHES_LABEL,
  DISCOVERY_PRIORITISER_UNAVAILABLE_LABEL,
  HIGHLIGHT_CEILING,
  defaultEvidenceProbe,
  discoveryPlanKey,
  hardFilterFromMandate,
  planInvestmentDiscovery,
  type QualitativePrioritizer,
  type QualitativePriorityResult,
} from "./discovery";
import type { ResearchMandate } from "./contracts";
import type { FactorScores, Stock } from "@/lib/research";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function factors(partial: Partial<FactorScores> = {}): FactorScores {
  return { mom: 60, growth: 60, quality: 60, analyst: 60, value: 60, health: 60, ...partial };
}

function stock(ticker: string, over: Partial<Stock> = {}): Stock {
  return {
    ticker,
    name: `${ticker} Inc`,
    sector: "Technology",
    price: 100,
    chg: 0,
    f: factors(),
    mv: { week: 0, month: 0, year: 0 },
    marketCap: 5e10,
    pe: 20,
    fundStatus: "ok",
    ...over,
  };
}

function mandate(over: Partial<ResearchMandate> = {}): ResearchMandate {
  return {
    mode: "discover",
    query: "cheap industrial compounders",
    ticker: null,
    horizon: {
      count: 12,
      unit: "calendar_months",
      assumed: false,
      targetDate: "2027-09-22",
      yearFraction: 1.0,
      note: null,
    },
    benchmark: "SPY",
    universeVersion: "universe-2026-09-22",
    hardFilter: null,
    qualitativeCriteria: [],
    ...over,
  };
}

/** A universe of `n` names with descending factor scores, so order is predictable. */
function universeOf(n: number, over: (i: number) => Partial<Stock> = () => ({})): Stock[] {
  return Array.from({ length: n }, (_, i) => {
    const score = 90 - i;
    return stock(`T${String(i).padStart(3, "0")}`, {
      f: factors({ mom: score, growth: score, quality: score, analyst: score, value: score, health: score }),
      ...over(i),
    });
  });
}

function prioritizer(
  result: QualitativePriorityResult | (() => never),
  id = "jev"
): QualitativePrioritizer {
  return {
    id,
    prioritize: () => (typeof result === "function" ? result() : result),
  };
}

// ── Hard filters are binding ─────────────────────────────────────────────────

describe("planInvestmentDiscovery — hard filters", () => {
  const MIXED: Stock[] = [
    stock("AAA", { sector: "Health Care", price: 40, pe: 12 }),
    stock("BBB", { sector: "Health Care", price: 45, pe: 30 }),
    stock("CCC", { sector: "Technology", price: 30, pe: 10 }),
    stock("DDD", { sector: "Health Care", price: 400, pe: 11 }),
    stock("EEE", { sector: "Health Care", price: 20, pe: null }),
  ];

  const HARD = { sectors: ["Health Care"], maxPrice: 50, maxPe: 25 };

  it("lets only names satisfying every stated limit reach the funnel", async () => {
    const plan = await planInvestmentDiscovery(mandate({ hardFilter: HARD }), MIXED);
    // AAA alone: BBB fails P/E, CCC the sector, DDD the price, EEE has no P/E.
    expect(plan.assess.map((c) => c.ticker)).toEqual(["AAA"]);
    expect(plan.deepResearch.map((c) => c.ticker)).toEqual(["AAA"]);
  });

  it("holds for every final ticker, at both the assess and deep stages", async () => {
    const plan = await planInvestmentDiscovery(mandate({ hardFilter: HARD }), MIXED);
    const byTicker = new Map(MIXED.map((s) => [s.ticker, s]));
    for (const candidate of [...plan.assess, ...plan.deepResearch]) {
      const row = byTicker.get(candidate.ticker)!;
      expect(row.sector).toBe("Health Care");
      expect(row.price).toBeLessThanOrEqual(50);
      expect(row.pe).not.toBeNull();
      expect(row.pe!).toBeGreaterThan(0);
      expect(row.pe!).toBeLessThanOrEqual(25);
    }
  });

  it("computes eligibility against the whole universe, not a truncated slice", async () => {
    // 120 names all pass, which is three times the screener's truncating default.
    const plan = await planInvestmentDiscovery(
      mandate({ hardFilter: { sectors: ["Technology"] } }),
      universeOf(120)
    );
    expect(plan.universeSize).toBe(120);
    expect(plan.eligibleCount).toBe(120);
    expect(plan.assess).toHaveLength(ASSESSMENT_CEILING);
  });

  it("drops a mandate-supplied limit rather than letting it truncate eligibility", () => {
    const filter = hardFilterFromMandate(mandate({ hardFilter: { sectors: ["Tech"], limit: 5 } }));
    expect(filter).toEqual({ sectors: ["Tech"] });
    expect(filter && "limit" in filter).toBe(false);
  });

  it("treats an absent hard filter as no screen at all", async () => {
    const plan = await planInvestmentDiscovery(mandate(), universeOf(3));
    expect(hardFilterFromMandate(mandate())).toBeNull();
    expect(plan.eligibleCount).toBe(3);
  });
});

// ── Ceilings are ceilings ────────────────────────────────────────────────────

describe("planInvestmentDiscovery — ceilings are not quotas", () => {
  it("returns three names when only three fit, and does not pad", async () => {
    const plan = await planInvestmentDiscovery(mandate(), universeOf(3));
    expect(plan.assess).toHaveLength(3);
    expect(plan.deepResearch).toHaveLength(3);
    expect(plan.highlightCeiling).toBe(HIGHLIGHT_CEILING);
    expect(plan.status).toBe("planned");
  });

  it("narrows the funnel to 40 assessed and 10 deep-researched", async () => {
    const plan = await planInvestmentDiscovery(mandate(), universeOf(200));
    expect(plan.eligibleCount).toBe(200);
    expect(plan.assess).toHaveLength(ASSESSMENT_CEILING);
    expect(plan.deepResearch).toHaveLength(DEEP_RESEARCH_CEILING);
    expect(plan.deepResearch.map((c) => c.ticker)).toEqual(
      plan.assess.slice(0, DEEP_RESEARCH_CEILING).map((c) => c.ticker)
    );
  });

  it("lets a caller tighten a ceiling but never widen one", async () => {
    const tight = await planInvestmentDiscovery(mandate(), universeOf(50), {
      assessmentCeiling: 5,
      deepResearchCeiling: 2,
    });
    expect(tight.assess).toHaveLength(5);
    expect(tight.deepResearch).toHaveLength(2);

    const widened = await planInvestmentDiscovery(mandate(), universeOf(200), {
      assessmentCeiling: 500,
      deepResearchCeiling: 99,
      highlightCeiling: 99,
    });
    expect(widened.assess).toHaveLength(ASSESSMENT_CEILING);
    expect(widened.deepResearch).toHaveLength(DEEP_RESEARCH_CEILING);
    expect(widened.highlightCeiling).toBe(HIGHLIGHT_CEILING);
  });
});

// ── Zero matches is a real answer ────────────────────────────────────────────

describe("planInvestmentDiscovery — zero matches", () => {
  it("returns an empty, explained plan rather than widening the search", async () => {
    const plan = await planInvestmentDiscovery(
      mandate({ hardFilter: { sectors: ["Utilities"], maxPrice: 1 } }),
      universeOf(25)
    );
    expect(plan.status).toBe("no_matches");
    expect(plan.eligibleCount).toBe(0);
    expect(plan.assess).toEqual([]);
    expect(plan.deepResearch).toEqual([]);
    expect(plan.notes[0]).toBe(DISCOVERY_NO_MATCHES_LABEL);
    expect(plan.notes.join(" ")).toContain("nothing qualified");
  });

  it("still accounts for every name it rejected", async () => {
    const universe = universeOf(25);
    const plan = await planInvestmentDiscovery(
      mandate({ hardFilter: { sectors: ["Utilities"] } }),
      universe
    );
    expect(plan.rejected).toHaveLength(universe.length);
  });
});

// ── Rejections keep their reasons ────────────────────────────────────────────

describe("planInvestmentDiscovery — rejected candidates keep their reasons", () => {
  it("names the binding limit for a screened-out candidate", async () => {
    const plan = await planInvestmentDiscovery(
      mandate({ hardFilter: { maxPrice: 50 } }),
      [stock("KEEP", { price: 20 }), stock("DROP", { price: 500 })]
    );
    const drop = plan.rejected.find((r) => r.ticker === "DROP");
    expect(drop).toBeDefined();
    expect(drop!.reason).toBe("hard_filter");
    expect(drop!.stage).toBe("eligibility");
    expect(drop!.detail).toContain("500");
    expect(drop!.detail.length).toBeGreaterThan(0);
  });

  it("distinguishes a ceiling from a failed screen", async () => {
    const plan = await planInvestmentDiscovery(mandate(), universeOf(60));
    const byReason = new Map<string, number>();
    for (const r of plan.rejected) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
    expect(byReason.get("assessment_ceiling")).toBe(60 - ASSESSMENT_CEILING);
    expect(byReason.get("deep_research_ceiling")).toBe(ASSESSMENT_CEILING - DEEP_RESEARCH_CEILING);
    expect(byReason.get("hard_filter")).toBeUndefined();
    for (const r of plan.rejected) expect(r.detail).not.toBe("");
  });

  it("records a duplicate row instead of assessing the name twice", async () => {
    const plan = await planInvestmentDiscovery(mandate(), [
      stock("DUP"),
      stock("DUP", { price: 7 }),
      stock("OTHER"),
    ]);
    expect(plan.assess.map((c) => c.ticker).filter((t) => t === "DUP")).toHaveLength(1);
    expect(plan.rejected).toEqual(
      expect.arrayContaining([expect.objectContaining({ ticker: "DUP", reason: "duplicate_ticker" })])
    );
  });

  it("records a row with no ticker as malformed", async () => {
    const plan = await planInvestmentDiscovery(mandate(), [stock("GOOD"), stock("  ")]);
    expect(plan.assess.map((c) => c.ticker)).toEqual(["GOOD"]);
    expect(plan.rejected).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "malformed_row" })])
    );
  });

  it("accounts for every universe row exactly once, across every stage", async () => {
    const universe = universeOf(60);
    const plan = await planInvestmentDiscovery(
      mandate({ hardFilter: { minMarketCap: 1e9 } }),
      universe
    );
    const accountedFor = new Set([
      ...plan.deepResearch.map((c) => c.ticker),
      ...plan.rejected.map((r) => r.ticker),
    ]);
    expect(accountedFor.size).toBe(universe.length);
  });
});

// ── A neutral 50 is not coverage ─────────────────────────────────────────────

describe("planInvestmentDiscovery — placeholder factors are not evidence", () => {
  it("counts a failed fundamentals feed as placeholder, never as coverage", async () => {
    const plan = await planInvestmentDiscovery(mandate(), [
      stock("REAL", { fundStatus: "ok" }),
      stock("DARK", { fundStatus: "failed", f: factors({ growth: 50, quality: 50, value: 50, health: 50 }) }),
    ]);
    const dark = plan.assess.find((c) => c.ticker === "DARK")!;
    const real = plan.assess.find((c) => c.ticker === "REAL")!;

    expect(dark.coverage.placeholderFactors).toEqual(
      expect.arrayContaining(["growth", "quality", "value", "health"])
    );
    expect(dark.coverage.observedFactors).not.toEqual(expect.arrayContaining(["growth"]));
    expect(dark.coverage.observedFraction).toBeLessThan(real.coverage.observedFraction);
  });

  it("does not credit coverage it cannot establish", () => {
    // `analyst` has no per-ticker provenance on a universe row, so it is in
    // neither list — unknown is not coverage, and it is not a placeholder claim.
    const evidence = defaultEvidenceProbe(stock("X", { fundStatus: "ok" }));
    expect(evidence.observedFactors).not.toContain("analyst");
    expect(evidence.placeholderFactors).not.toContain("analyst");
  });

  it("never reports a fully-outaged name as fully covered", async () => {
    const plan = await planInvestmentDiscovery(mandate(), [
      stock("VOID", { fundStatus: "failed", price: 0 }),
    ]);
    const void_ = plan.assess[0];
    expect(void_.coverage.observedFraction).toBe(0);
    expect(void_.coverage.placeholderOnly).toBe(true);
    expect(plan.status).toBe("partial");
  });

  it("refuses to judge a factor band against a placeholder score", async () => {
    // A band of `min: 40` is satisfied by the neutral 50, so admitting this name
    // would let an outage manufacture a match.
    const plan = await planInvestmentDiscovery(
      mandate({ hardFilter: { factors: { growth: { min: 40 } } } }),
      [
        stock("MEASURED", { fundStatus: "ok", f: factors({ growth: 80 }) }),
        stock("PLACEHOLD", { fundStatus: "failed", f: factors({ growth: 50 }) }),
      ]
    );
    expect(plan.assess.map((c) => c.ticker)).toEqual(["MEASURED"]);
    const held = plan.rejected.find((r) => r.ticker === "PLACEHOLD")!;
    expect(held.reason).toBe("unverified_factor_band");
    expect(held.detail).toContain("growth");
  });

  it("surfaces per-candidate source failures at the run level", async () => {
    const plan = await planInvestmentDiscovery(mandate(), [stock("DARK", { fundStatus: "failed" })]);
    expect(plan.sourceFailures.map((g) => g.source)).toContain("fundamentals");
    expect(plan.notes.join(" ")).toContain("fundamentals");
  });

  it("carries a caller-supplied outage into the plan", async () => {
    const plan = await planInvestmentDiscovery(mandate(), universeOf(3), {
      sourceFailures: [
        { source: "analyst", field: "priceTarget", reason: "rate_limited", detail: "429 from the feed" },
      ],
    });
    expect(plan.status).toBe("partial");
    expect(plan.sourceFailures).toHaveLength(1);
    expect(plan.notes.join(" ")).toContain("429 from the feed");
  });
});

// ── Determinism ──────────────────────────────────────────────────────────────

describe("planInvestmentDiscovery — deterministic and stable", () => {
  it("yields the same order for a shuffled universe", async () => {
    const universe = universeOf(60);
    const shuffled = [...universe].reverse();
    const a = await planInvestmentDiscovery(mandate(), universe);
    const b = await planInvestmentDiscovery(mandate(), shuffled);
    expect(b.assess.map((c) => c.ticker)).toEqual(a.assess.map((c) => c.ticker));
    expect(b.deepResearch.map((c) => c.ticker)).toEqual(a.deepResearch.map((c) => c.ticker));
  });

  it("breaks ties by ticker rather than by arrival order", async () => {
    // Identical factor scores, so the composite is identical for all four.
    const tied = ["DELTA", "ALPHA", "CHARLIE", "BRAVO"].map((t) => stock(t));
    const forward = await planInvestmentDiscovery(mandate(), tied);
    const backward = await planInvestmentDiscovery(mandate(), [...tied].reverse());
    expect(forward.assess.map((c) => c.ticker)).toEqual(["ALPHA", "BRAVO", "CHARLIE", "DELTA"]);
    expect(backward.assess.map((c) => c.ticker)).toEqual(forward.assess.map((c) => c.ticker));
  });

  it("honours a stated sort direction and still tie-breaks by ticker", async () => {
    const plan = await planInvestmentDiscovery(
      mandate({ hardFilter: { sort: { key: "marketCap", dir: "asc" } } }),
      [
        stock("BIG", { marketCap: 9e11 }),
        stock("SAME_B", { marketCap: 1e10 }),
        stock("SAME_A", { marketCap: 1e10 }),
      ]
    );
    expect(plan.assess.map((c) => c.ticker)).toEqual(["SAME_A", "SAME_B", "BIG"]);
  });

  it("assigns a stable 1-based deterministic rank", async () => {
    const plan = await planInvestmentDiscovery(mandate(), universeOf(12));
    expect(plan.assess.map((c) => c.deterministicRank)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });
});

// ── Reuse identity ───────────────────────────────────────────────────────────

describe("discoveryPlanKey — reuse identity", () => {
  it("is unchanged by a re-stated identical mandate", () => {
    expect(discoveryPlanKey(mandate())).toBe(discoveryPlanKey(mandate()));
  });

  it("changes when ONLY the horizon count changes", () => {
    const twelve = mandate();
    const three = mandate({ horizon: { ...twelve.horizon, count: 3 } });
    expect(discoveryPlanKey(three)).not.toBe(discoveryPlanKey(twelve));
  });

  it("changes when ONLY the horizon unit changes", () => {
    const months = mandate();
    const days = mandate({ horizon: { ...months.horizon, unit: "trading_days" } });
    expect(discoveryPlanKey(days)).not.toBe(discoveryPlanKey(months));
  });

  it("ignores the derived target date, which slides with the calendar", () => {
    const today = mandate();
    const tomorrow = mandate({
      horizon: { ...today.horizon, targetDate: "2027-09-23", yearFraction: 1.003 },
    });
    expect(discoveryPlanKey(tomorrow)).toBe(discoveryPlanKey(today));
  });

  it("changes when the screen limits change", () => {
    const open = mandate();
    const screened = mandate({ hardFilter: { maxPe: 15 } });
    expect(discoveryPlanKey(screened)).not.toBe(discoveryPlanKey(open));
  });

  it("does not depend on key order in the hard filter", () => {
    const a = mandate({ hardFilter: { maxPe: 15, sectors: ["Energy"] } });
    const b = mandate({ hardFilter: { sectors: ["Energy"], maxPe: 15 } });
    expect(discoveryPlanKey(a)).toBe(discoveryPlanKey(b));
  });

  it("is carried on the plan it produced", async () => {
    const m = mandate();
    const plan = await planInvestmentDiscovery(m, universeOf(3));
    expect(plan.planKey).toBe(discoveryPlanKey(m));
  });
});

// ── The injected qualitative prioritiser ─────────────────────────────────────

describe("planInvestmentDiscovery — qualitative prioritisation", () => {
  const THREE = [stock("AAA"), stock("BBB"), stock("CCC")];

  it("labels the order as not model-prioritised when none is wired in", async () => {
    const plan = await planInvestmentDiscovery(mandate(), THREE);
    expect(plan.ordering.kind).toBe("deterministic");
    expect(plan.ordering.providerId).toBeNull();
    expect(plan.ordering.label).toBe(DISCOVERY_DETERMINISTIC_ORDER_LABEL);
    expect(plan.notes).toContain(DISCOVERY_DETERMINISTIC_ORDER_LABEL);
    expect(plan.status).toBe("planned");
  });

  it("reorders the assessed pool when the prioritiser answers", async () => {
    const plan = await planInvestmentDiscovery(mandate(), THREE, {
      prioritizer: prioritizer({
        status: "ok",
        ranks: [
          { ticker: "CCC", priority: 0.9, note: "best fit" },
          { ticker: "AAA", priority: 0.4, note: null },
          { ticker: "BBB", priority: 0.1, note: null },
        ],
      }),
    });
    expect(plan.assess.map((c) => c.ticker)).toEqual(["CCC", "AAA", "BBB"]);
    expect(plan.ordering.kind).toBe("model_prioritised");
    expect(plan.ordering.providerId).toBe("jev");
    expect(plan.assess[0].qualitativeNote).toBe("best fit");
    expect(plan.status).toBe("planned");
  });

  it("keeps the deterministic rank alongside the model's order", async () => {
    const plan = await planInvestmentDiscovery(mandate(), THREE, {
      prioritizer: prioritizer({ status: "ok", ranks: [{ ticker: "CCC", priority: 1, note: null }] }),
    });
    expect(plan.assess[0].ticker).toBe("CCC");
    expect(plan.assess[0].deterministicRank).toBe(3);
  });

  it("puts names the prioritiser did not rank after every ranked one", async () => {
    const plan = await planInvestmentDiscovery(mandate(), THREE, {
      prioritizer: prioritizer({ status: "ok", ranks: [{ ticker: "BBB", priority: 0.5, note: null }] }),
    });
    expect(plan.assess.map((c) => c.ticker)).toEqual(["BBB", "AAA", "CCC"]);
    expect(plan.assess[1].qualitativePriority).toBeNull();
    expect(plan.assess[2].qualitativePriority).toBeNull();
  });

  it("refuses a name the screen excluded, even when the prioritiser ranks it", async () => {
    const plan = await planInvestmentDiscovery(
      mandate({ hardFilter: { maxPrice: 50 } }),
      [stock("CHEAP", { price: 20 }), stock("DEAR", { price: 900 })],
      {
        prioritizer: prioritizer({
          status: "ok",
          ranks: [
            { ticker: "DEAR", priority: 1, note: "ignore the limit" },
            { ticker: "CHEAP", priority: 0.2, note: null },
          ],
        }),
      }
    );
    expect(plan.assess.map((c) => c.ticker)).toEqual(["CHEAP"]);
  });

  it("falls back and labels the fallback when the prioritiser reports unavailable", async () => {
    const plan = await planInvestmentDiscovery(mandate(), THREE, {
      prioritizer: prioritizer({ status: "unavailable", reason: "429 from the provider" }),
    });
    expect(plan.assess.map((c) => c.ticker)).toEqual(["AAA", "BBB", "CCC"]);
    expect(plan.ordering.kind).toBe("deterministic_fallback");
    expect(plan.ordering.label).toBe(DISCOVERY_PRIORITISER_UNAVAILABLE_LABEL);
    expect(plan.ordering.fallbackReason).toBe("429 from the provider");
    expect(plan.status).toBe("partial");
  });

  it("treats a thrown provider error as a partial run, not a fabricated one", async () => {
    const plan = await planInvestmentDiscovery(mandate(), THREE, {
      prioritizer: prioritizer(() => {
        throw new Error("socket hang up");
      }),
    });
    expect(plan.status).toBe("partial");
    expect(plan.ordering.kind).toBe("deterministic_fallback");
    expect(plan.ordering.fallbackReason).toBe("socket hang up");
    // The pool itself is untouched: a provider outage removes no candidate and
    // invents no priority.
    expect(plan.assess.map((c) => c.ticker)).toEqual(["AAA", "BBB", "CCC"]);
    for (const candidate of plan.assess) {
      expect(candidate.qualitativePriority).toBeNull();
      expect(candidate.qualitativeNote).toBeNull();
    }
  });

  it("falls back when the prioritiser ranks nothing we screened", async () => {
    const plan = await planInvestmentDiscovery(mandate(), THREE, {
      prioritizer: prioritizer({ status: "ok", ranks: [{ ticker: "ZZZ", priority: 1, note: null }] }),
    });
    expect(plan.ordering.kind).toBe("deterministic_fallback");
    expect(plan.ordering.fallbackReason).toContain("no usable ranking");
  });

  it("ignores a non-finite priority rather than ordering on it", async () => {
    const plan = await planInvestmentDiscovery(mandate(), THREE, {
      prioritizer: prioritizer({
        status: "ok",
        ranks: [
          { ticker: "CCC", priority: Number.NaN, note: null },
          { ticker: "BBB", priority: 0.5, note: null },
        ],
      }),
    });
    expect(plan.assess.map((c) => c.ticker)).toEqual(["BBB", "AAA", "CCC"]);
    expect(plan.assess.find((c) => c.ticker === "CCC")!.qualitativePriority).toBeNull();
  });

  it("does not call an empty pool an outage", async () => {
    const plan = await planInvestmentDiscovery(
      mandate({ hardFilter: { sectors: ["Utilities"] } }),
      THREE,
      { prioritizer: prioritizer({ status: "unavailable", reason: "never asked" }) }
    );
    expect(plan.status).toBe("no_matches");
    expect(plan.ordering.kind).toBe("deterministic");
  });
});
