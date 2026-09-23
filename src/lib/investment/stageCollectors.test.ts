import { describe, it, expect, vi } from "vitest";

// The facts layer and the LLM router reach firebase-admin and the model config at
// module load. Every collector here takes its reader injected, so the real ones
// are never called — the mocks only keep the import graph from validating env.
vi.mock("@/lib/firebase-admin", () => ({ db: null }));
vi.mock("@/lib/facts/ticker", () => ({ getTickerFacts: async () => { throw new Error("not used"); } }));
vi.mock("@/lib/llm", () => ({ generate: async () => { throw new Error("not used"); } }));

import { draftsFromFacts, factsCollector, factsValuationRequest } from "./stageCollectors";
import { computeValuation } from "./valuation";
import type { TickerFacts } from "@/lib/facts/types";
import type { ResearchSnapshot } from "./contracts";

const ASOF = "2026-09-22T13:45:00.000Z";

/** A Fact<T>, matching the facts layer's shape. */
function f<T>(value: T | null, source: string, over: Record<string, unknown> = {}) {
  return { value, source, asOf: "2026-09-20T20:00:00.000Z", ...over } as never;
}

function facts(over: Partial<Record<keyof TickerFacts, unknown>> = {}): TickerFacts {
  return {
    ticker: "TEST",
    price: f(100, "polygon"),
    change1d: f(0.5, "polygon"),
    marketCap: f(1e11, "finnhub"),
    sharesOut: f(1e9, "sec"),
    pe: f(20, "finnhub"),
    evEbitda: f(14, "finnhub"),
    epsTTM: f(5, "finnhub"),
    range52w: f({ low: 70, high: 130 }, "polygon"),
    revenueTTM: f(5e10, "sec"),
    netIncomeTTM: f(12e9, "sec"),
    fcfTTM: f(10e9, "sec"),
    cashAndSTI: f(2e10, "sec"),
    debt: f(1e10, "sec"),
    beta: f(1.2, "finnhub"),
    dividendYield: f(0.02, "finnhub"),
    nextEarnings: f({ date: "2026-10-20", estimated: true }, "finnhub"),
    streetTarget: f(120, "finnhub"),
    score: f(null, "finava"),
    dcf: f(null, "finava"),
    dropped: [],
    ...over,
  } as unknown as TickerFacts;
}

function snapshot(): ResearchSnapshot {
  return {
    id: "s1",
    ownerUid: "u1",
    ticker: "TEST",
    asOf: ASOF,
    mandate: {
      mode: "analyze",
      query: "Analyze TEST",
      ticker: "TEST",
      horizon: {
        count: 24,
        unit: "calendar_months",
        assumed: false,
        targetDate: "2028-09-22",
        yearFraction: 2,
        note: null,
      },
      benchmark: "SPY",
      universeVersion: "u1",
      hardFilter: null,
      qualitativeCriteria: [],
    },
    evidence: [],
    gaps: [],
    coverage: {},
    contentHash: "h",
    createdAt: ASOF,
  };
}

describe("draftsFromFacts — a fact without a value is a gap, not a zero", () => {
  it("turns present facts into dated drafts with the provider's own as-of", () => {
    const { drafts } = draftsFromFacts(facts(), ASOF);
    const price = drafts.find((d) => d.field === "currentPrice");
    expect(price?.value).toBe(100);
    expect(price?.unit).toBe("usd_per_share");
    // The provider's as-of stays separate from when WE read it, so a figure
    // published after the cutoff can still be caught.
    expect(price?.publishedAt).toBe("2026-09-20T20:00:00.000Z");
    expect(price?.observedAt).toBe(ASOF);
  });

  it("never emits a draft with a null value", () => {
    const { drafts } = draftsFromFacts(facts({ netIncomeTTM: f(null, "sec") }), ASOF);
    expect(drafts.every((d) => typeof d.value === "number")).toBe(true);
    expect(drafts.some((d) => d.field === "netIncomeToCommon")).toBe(false);
  });

  it("records a missing value as a gap that keeps its source", () => {
    const { gaps } = draftsFromFacts(facts({ debt: f(null, "sec", { note: "not filed" }) }), ASOF);
    const gap = gaps.find((g) => g.field === "totalDebt");
    expect(gap?.source).toBe("sec");
    expect(gap?.detail).toBe("not filed");
  });

  it("distinguishes an OUTAGE from a genuine absence", () => {
    // Same missing value; the difference is whether the source failed this read.
    const absent = draftsFromFacts(facts({ debt: f(null, "sec") }), ASOF);
    expect(absent.gaps.find((g) => g.field === "totalDebt")?.reason).toBe("not_covered");

    const outage = draftsFromFacts(facts({ debt: f(null, "sec"), dropped: ["sec"] }), ASOF);
    expect(outage.gaps.find((g) => g.field === "totalDebt")?.reason).toBe("unavailable");
  });

  it("records a dropped source even when it supplied no field of its own", () => {
    const { gaps } = draftsFromFacts(facts({ dropped: ["grok"] }), ASOF);
    expect(gaps.some((g) => g.source === "grok" && g.reason === "unavailable")).toBe(true);
  });
});

describe("factsCollector", () => {
  it("turns a total provider failure into one gap rather than throwing", async () => {
    const collect = factsCollector({
      readFacts: async () => {
        throw new Error("upstream down");
      },
    });
    const out = await collect({ ticker: "TEST", asOf: ASOF, mandate: snapshot().mandate });
    expect(out.drafts).toEqual([]);
    expect(out.gaps[0].reason).toBe("unavailable");
    expect(out.gaps[0].detail).toContain("upstream down");
  });
});

describe("factsValuationRequest", () => {
  it("assembles a request whose price is reported alongside it", async () => {
    const build = factsValuationRequest({ readFacts: async () => facts() });
    const out = await build(snapshot());
    expect(out).not.toBeNull();
    expect(out!.priceAtAsOf).toBe(100);
    expect(out!.request.raw.method).toBe("forward_multiple");
    expect(out!.request.horizon.yearFraction).toBe(2);
  });

  it("derives the annual dividend from yield × price", async () => {
    const build = factsValuationRequest({ readFacts: async () => facts() });
    const out = await build(snapshot());
    // 2% of $100 is $2.00 per share.
    expect(
      (out!.request.raw as { distributionsPerShareAnnual: number | null }).distributionsPerShareAnnual
    ).toBeCloseTo(2, 12);
  });

  it("leaves the dividend NULL when the yield is unavailable, rather than zero", async () => {
    // A known zero means "pays nothing"; null means "we do not know", and only
    // the second should reduce coverage.
    const build = factsValuationRequest({
      readFacts: async () => facts({ dividendYield: f(null, "finnhub") }),
    });
    const out = await build(snapshot());
    expect(
      (out!.request.raw as { distributionsPerShareAnnual: number | null }).distributionsPerShareAnnual
    ).toBeNull();
  });

  it("returns null — not a guess — when price, shares or earnings are missing", async () => {
    for (const missing of ["price", "sharesOut", "netIncomeTTM"] as const) {
      const build = factsValuationRequest({
        readFacts: async () => facts({ [missing]: f(null, "x") }),
      });
      expect(await build(snapshot())).toBeNull();
    }
  });

  it("returns null when the facts read itself fails", async () => {
    const build = factsValuationRequest({
      readFacts: async () => {
        throw new Error("down");
      },
    });
    expect(await build(snapshot())).toBeNull();
  });

  it("produces a request the real valuation engine accepts end to end", async () => {
    // The point of this test: the collector's output is not merely well-typed, it
    // actually values through computeValuation and yields three ordered scenarios.
    const build = factsValuationRequest({ readFacts: async () => facts() });
    const out = await build(snapshot());
    const outcome = computeValuation(out!.request);

    expect(outcome.scenarios).not.toBeNull();
    expect(outcome.scenarios!.map((s) => s.id)).toEqual(["bear", "base", "bull"]);
    // Strictly increasing horizon prices, which is what the bucket partition needs.
    const prices = outcome.scenarios!.map((s) => s.priceAtHorizon);
    expect(prices[0]).toBeLessThan(prices[1]);
    expect(prices[1]).toBeLessThan(prices[2]);
    expect(outcome.criticalCoverage).toBe(1);
  });
});
