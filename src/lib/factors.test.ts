import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock universe + data sources ─────────────────────────────────────────────
// A tiny 4-name universe: two Tech names (strong AAA vs weak BBB), one Bank that
// only resolves via the EDGAR fallback, and one name with no data at all.
const constituents = vi.hoisted(() => [
  { ticker: "AAA", name: "Alpha", sector: "Tech" },
  { ticker: "BBB", name: "Beta", sector: "Tech" },
  { ticker: "CCC", name: "Gamma", sector: "Bank" },
  { ticker: "DDD", name: "Delta", sector: "Tech" },
]);

vi.mock("@/lib/sp500", () => ({ SP500: constituents }));

// Isolate the engine to the mocked S&P list — no curated extras in this test.
vi.mock("@/lib/extraUniverse", () => ({
  EXTRA_CONSTITUENTS: [],
  ALL_CONSTITUENTS: constituents,
  ETF_PROFILES: {},
}));

// Polygon annual financials, newest-year-first. AAA: growing + profitable + cheap.
// BBB: flat + low-margin + expensive + levered. CCC/DDD: empty (force fallback).
const incStmt = (revenues: number, eps: number, ni: number, gp: number, oi: number, sh: number) => ({
  revenues: { value: revenues },
  diluted_earnings_per_share: { value: eps },
  net_income_loss: { value: ni },
  gross_profit: { value: gp },
  operating_income_loss: { value: oi },
  diluted_average_shares: { value: sh },
});
const yearResult = (rev: number, eps: number, ni: number, gp: number, oi: number, bal: object, cf: object) => ({
  financials: {
    income_statement: incStmt(rev, eps, ni, gp, oi, 10),
    balance_sheet: bal,
    cash_flow_statement: cf,
  },
});
const POLY: Record<string, unknown> = {
  AAA: {
    results: [
      yearResult(120, 5, 30, 60, 36,
        { equity_attributable_to_parent: { value: 100 }, assets: { value: 200 }, current_assets: { value: 100 }, current_liabilities: { value: 50 }, long_term_debt: { value: 20 } },
        { net_cash_flow_from_operating_activities: { value: 40 } }),
      yearResult(100, 4, 25, 50, 30, {}, {}),
      yearResult(90, 3, 20, 45, 27, {}, {}),
      yearResult(80, 2, 15, 40, 24, {}, {}),
    ],
  },
  BBB: {
    results: [
      yearResult(100, 2, 5, 20, 5,
        { equity_attributable_to_parent: { value: 100 }, assets: { value: 400 }, current_assets: { value: 50 }, current_liabilities: { value: 100 }, long_term_debt: { value: 200 } },
        { net_cash_flow_from_operating_activities: { value: 5 } }),
      yearResult(100, 2, 5, 20, 5, {}, {}),
      yearResult(100, 2, 5, 20, 5, {}, {}),
      yearResult(100, 2, 5, 20, 5, {}, {}),
    ],
  },
  CCC: { results: [] }, // forces EDGAR fallback
  DDD: { results: [] }, // no fallback either → neutral
};
// Reference data: the CURRENT share count and the feed's own cap. AAA/BBB match
// their filings; EEE has split since its last 10-K (filing 10 → current 230).
const DETAILS: Record<string, { share_class_shares_outstanding?: number; market_cap?: number }> = {
  AAA: { share_class_shares_outstanding: 10, market_cap: 1000 },
  BBB: { share_class_shares_outstanding: 10, market_cap: 2000 },
  EEE: { share_class_shares_outstanding: 230, market_cap: 23_000 },
};
vi.mock("@/lib/polygon", () => ({
  getAnnualFinancials: vi.fn(async (t: string) => POLY[t] ?? { results: [] }),
  getTickerDetails: vi.fn(async (t: string) => ({ results: DETAILS[t] ?? {} })),
}));

// EDGAR fallback: only CCC has a CIK + facts.
const edgarUnit = (val: number, year: number) => ({ form: "10-K", end: `${year}-12-31`, val, frame: `CY${year}` });
vi.mock("@/lib/edgar", () => ({
  // CCC has no Polygon reference data; its cover-page count comes from EDGAR.
  extractCurrentSharesOutstanding: vi.fn(() => ({ shares: 6, asOf: "2026-06-30" })),
  getCikByTicker: vi.fn(async (t: string) => (t === "CCC" ? "0000123" : null)),
  getCompanyFacts: vi.fn(async () => ({
    facts: {
      "us-gaap": {
        Revenues: { units: { USD: [edgarUnit(500, 2024), edgarUnit(450, 2023)] } },
        EarningsPerShareDiluted: { units: { "USD/shares": [edgarUnit(8, 2024)] } },
        NetIncomeLoss: { units: { USD: [edgarUnit(60, 2024)] } },
        StockholdersEquity: { units: { USD: [edgarUnit(300, 2024)] } },
        Assets: { units: { USD: [edgarUnit(1000, 2024)] } },
      },
    },
  })),
}));

// Alpaca snapshots (price/changePct) and close history.
const snapMap = new Map<string, { price: number; changePct: number }>([
  ["AAA", { price: 100, changePct: 1.5 }],
  ["BBB", { price: 200, changePct: -0.5 }],
  ["CCC", { price: 50, changePct: 0.2 }],
  // DDD intentionally absent → price null, live false.
]);
const closes = (fn: (i: number) => number, n = 260) =>
  Array.from({ length: n }, (_, i) => ({ c: fn(i) }));
const closeMap = new Map<string, { c: number }[]>([
  ["AAA", closes((i) => 50 + i * 0.5)], // uptrend → positive momentum
  ["BBB", closes((i) => 300 - i * 0.5)], // downtrend → negative momentum
  ["CCC", closes(() => 50, 10)], // too short → null momentum (neutral)
]);
vi.mock("@/lib/alpaca", () => ({
  getAlpacaSnapshots: vi.fn(async () => snapMap),
  getAlpacaCloseHistory: vi.fn(async () => closeMap),
}));

// Finnhub recommendation trends: AAA bullish, BBB bearish, CCC neutral mix.
vi.mock("@/lib/finnhub", () => ({
  getRecommendationTrends: vi.fn(async (t: string) => {
    if (t === "AAA") return [{ strongBuy: 10, buy: 5, hold: 1, sell: 0, strongSell: 0 }];
    if (t === "BBB") return [{ strongBuy: 0, buy: 0, hold: 1, sell: 5, strongSell: 10 }];
    if (t === "CCC") return [{ strongBuy: 1, buy: 1, hold: 1, sell: 1, strongSell: 1 }];
    return []; // DDD → neutral
  }),
}));

beforeEach(() => vi.clearAllMocks());

describe("computeFactorUniverse", () => {
  it("returns one scored stock per universe name with all six factors in range", async () => {
    const { computeFactorUniverse } = await import("./factors");
    const { stocks, coverage, asOf } = await computeFactorUniverse();

    expect(stocks).toHaveLength(4);
    expect(coverage.total).toBe(4);
    expect(typeof asOf).toBe("string");

    for (const s of stocks) {
      for (const v of Object.values(s.f)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("ranks the stronger Tech name above the weaker one (sector-relative)", async () => {
    const { computeFactorUniverse } = await import("./factors");
    const { stocks } = await computeFactorUniverse();
    const aaa = stocks.find((s) => s.ticker === "AAA")!;
    const bbb = stocks.find((s) => s.ticker === "BBB")!;

    expect(aaa.f.growth).toBeGreaterThan(bbb.f.growth);
    expect(aaa.f.quality).toBeGreaterThan(bbb.f.quality);
    expect(aaa.f.value).toBeGreaterThan(bbb.f.value); // cheaper P/E = better value
    expect(aaa.f.health).toBeGreaterThan(bbb.f.health);
    expect(aaa.f.mom).toBeGreaterThan(bbb.f.mom); // uptrend vs downtrend
    expect(aaa.f.analyst).toBeGreaterThan(bbb.f.analyst);
  });

  it("derives marketCap and TTM P/E from price × CURRENT shares", async () => {
    const { computeFactorUniverse } = await import("./factors");
    const { stocks } = await computeFactorUniverse();
    const aaa = stocks.find((s) => s.ticker === "AAA")!;
    expect(aaa.marketCap).toBe(100 * 10); // price 100 × 10 current shares
    expect(aaa.pe).toBeCloseTo(1000 / 30, 6); // cap / net income
    expect(aaa.live).toBe(true);
  });

  it("uses the cover-page share count when the reference feed has nothing (CCC)", async () => {
    const { computeFactorUniverse } = await import("./factors");
    const { stocks } = await computeFactorUniverse();
    const ccc = stocks.find((s) => s.ticker === "CCC")!;
    expect(ccc.marketCap).toBe(50 * 6); // price × EDGAR cover-page shares
  });

  it("falls back to EDGAR when Polygon has no filing", async () => {
    const { computeFactorUniverse } = await import("./factors");
    const { stocks, coverage } = await computeFactorUniverse();
    const ccc = stocks.find((s) => s.ticker === "CCC")!;
    // CCC has fundamentals only via EDGAR → counted, and is its own sector.
    expect(coverage.fundamentals).toBe(3); // AAA, BBB, CCC (not DDD)
    expect(ccc.price).toBe(50);
  });

  it("keeps a no-data name on the board with neutral scores and live=false", async () => {
    const { computeFactorUniverse } = await import("./factors");
    const { stocks } = await computeFactorUniverse();
    const ddd = stocks.find((s) => s.ticker === "DDD")!;
    expect(ddd.live).toBe(false);
    expect(ddd.price).toBe(0);
    expect(ddd.marketCap).toBeNull();
    expect(ddd.pe).toBeNull();
    // No usable fundamentals/momentum/analyst → neutral 50 across factors.
    expect(ddd.f.growth).toBe(50);
    expect(ddd.f.analyst).toBe(50);
    // Both sources RESPONDED with no data (Polygon empty, no CIK) → "unavailable",
    // NOT "failed". This is the genuine-no-data half of the distinction.
    expect(ddd.fundStatus).toBe("unavailable");
  });

  it("reports coverage counts for analyst and priced names", async () => {
    const { computeFactorUniverse } = await import("./factors");
    const { coverage } = await computeFactorUniverse();
    expect(coverage.analyst).toBe(3); // AAA, BBB, CCC have a skew; DDD null
    expect(coverage.priced).toBe(3); // AAA, BBB, CCC priced; DDD absent
    // Happy path: nothing throws, so nothing is a transport failure.
    expect(coverage.fundamentalsFailed).toBe(0);
    expect(coverage.analystFailed).toBe(0);
  });

  it("marks a name 'failed' (not 'unavailable') when its sources can't be reached", async () => {
    // Distinguishing these is the whole point: a rate-limit blip must not read as
    // "this company has no financials". Force a transport failure for DDD.
    const { getAnnualFinancials } = await import("@/lib/polygon");
    const { getRecommendationTrends } = await import("@/lib/finnhub");
    const polyImpl = vi.mocked(getAnnualFinancials).getMockImplementation()!;
    const recImpl = vi.mocked(getRecommendationTrends).getMockImplementation()!;
    vi.mocked(getAnnualFinancials).mockImplementation(async (t: string) => {
      if (t === "DDD") throw new Error("429 rate limited");
      return polyImpl(t);
    });
    // DDD has no CIK (EDGAR fallback finds nothing to reach), and Finnhub throws too.
    vi.mocked(getRecommendationTrends).mockImplementation(async (t: string) => {
      if (t === "DDD") throw new Error("429 rate limited");
      return recImpl(t);
    });

    try {
      const { computeFactorUniverse } = await import("./factors");
      const { stocks, coverage } = await computeFactorUniverse();
      const ddd = stocks.find((s) => s.ticker === "DDD")!;
      expect(ddd.fundStatus).toBe("failed"); // couldn't reach the source, ≠ no data
      expect(ddd.f.growth).toBe(50); // still on the board with a neutral placeholder
      expect(coverage.fundamentalsFailed).toBe(1);
      expect(coverage.analystFailed).toBe(1);
      // The genuinely-scored names are unaffected.
      expect(coverage.fundamentals).toBe(3);
    } finally {
      vi.mocked(getAnnualFinancials).mockImplementation(polyImpl);
      vi.mocked(getRecommendationTrends).mockImplementation(recImpl);
    }
  });
});

describe("resolveMarketCap (split safety)", () => {
  it("uses the current share count, not the pre-split weighted average on the last 10-K", async () => {
    const { resolveMarketCap } = await import("./factors");
    // Booking Holdings after its split: the FY2025 10-K reports 32,639,000
    // weighted average diluted shares; the cover page of the next 10-Q reports
    // 751,380,500. At ~$175.33 the filing figure gives a $5.7B cap and a P/E of
    // about 1 — the readout's BKNG bug.
    const cap = resolveMarketCap({
      price: 175.33,
      currentShares: 751_380_500,
      filingShares: 32_639_000,
      feedCap: 131_754_570_675,
    });
    expect(cap).toBeGreaterThan(125e9);
    expect(cap! / 5_404_000_000).toBeGreaterThan(20); // P/E is sane, not ~1
  });

  it("prefers the feed's cap when our own is off by more than 3x", async () => {
    const { resolveMarketCap } = await import("./factors");
    // A stale/unadjusted share count slipped through: trust the feed instead.
    expect(
      resolveMarketCap({ price: 175.33, currentShares: 32_639_000, filingShares: null, feedCap: 131_754_570_675 })
    ).toBe(131_754_570_675);
  });

  it("returns Unavailable rather than mixing filing shares with today's price", async () => {
    const { resolveMarketCap } = await import("./factors");
    expect(resolveMarketCap({ price: 175.33, currentShares: null, filingShares: 32_639_000, feedCap: null })).toBeNull();
  });

  it("falls back to the feed's cap when we have no share count", async () => {
    const { resolveMarketCap } = await import("./factors");
    expect(resolveMarketCap({ price: 175.33, currentShares: null, filingShares: null, feedCap: 131_754_570_675 }))
      .toBe(131_754_570_675);
  });

  it("is null without a price", async () => {
    const { resolveMarketCap } = await import("./factors");
    expect(resolveMarketCap({ price: null, currentShares: 751_380_500, filingShares: null, feedCap: null })).toBeNull();
  });
});
