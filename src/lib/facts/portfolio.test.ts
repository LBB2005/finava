// src/lib/facts/portfolio.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeFirestore } from "@/test/fakeFirestore";

const fs = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeFirestore> | null }));
const deps = vi.hoisted(() => ({ getTickerQuoteFacts: vi.fn() }));
vi.mock("@/lib/firebase-admin", () => ({ get db() { return fs.current!.db; } }));
vi.mock("./ticker", () => ({ getTickerQuoteFacts: deps.getTickerQuoteFacts }));

import { buildPortfolioFacts, getPortfolioFacts } from "./portfolio";
import { fact, missing, SCORE_VERSION } from "./types";

const NOW = new Date("2026-09-15T18:00:00.000Z");
const priced = (ticker: string, price: number) => ({
  ticker,
  price: fact(price, { source: "Finnhub quote", asOf: "2026-09-15T17:59:00.000Z", unit: "USD" }),
  change1d: fact(1, { source: "Finnhub quote", asOf: "2026-09-15T17:59:00.000Z", unit: "%" }),
  score: fact({ total: 58, grade: "C", pillars: [], confidence: "Moderate" as const, coverage: 1, peerPremiumPct: null, version: SCORE_VERSION }, { source: "Finava Score v2 (15 factors)", asOf: NOW.toISOString() }),
});

describe("buildPortfolioFacts", () => {
  it("computes weights as fractions that sum to 1 with cash", () => {
    const p = buildPortfolioFacts(
      [{ ticker: "AAPL", shares: 10, avgCost: 150 }, { ticker: "MSFT", shares: 5, avgCost: 300 }],
      700,
      new Map([["AAPL", priced("AAPL", 230)], ["MSFT", priced("MSFT", 460)]]),
      NOW
    );
    expect(p.totalValue.value).toBe(2300 + 2300 + 700);
    expect(p.holdings[0].weight.value).toBeCloseTo(0.434, 3);
    expect(p.weightsSum).toBe(1);
    expect(p.cash.value).toBe(700);
    expect(p.holdings[0].costBasis.value).toBe(150);
    expect(p.holdings[0].score.value).toEqual({ total: 58, grade: "C", version: SCORE_VERSION });
  });

  it("leaves an unpriced holding out of the totals, with notes", () => {
    const p = buildPortfolioFacts(
      [{ ticker: "AAPL", shares: 10, avgCost: 150 }, { ticker: "XYZ", shares: 1, avgCost: 10 }],
      0,
      new Map([["AAPL", priced("AAPL", 230)], ["XYZ", { ...priced("XYZ", 1), price: missing("Finnhub quote", "Source unavailable right now") }]]),
      NOW
    );
    expect(p.totalValue.value).toBe(2300);
    expect(p.totalValue.note).toBe("Excludes unpriced: XYZ");
    expect(p.holdings[1].weight.value).toBeNull();
    expect(p.holdings[1].weight.note).toBe("No live price; excluded from totals");
    expect(p.holdings[1].marketValue.value).toBeNull();
    expect(p.weightsSum).toBe(1);
  });

  it("an empty account is worth zero, not unavailable", () => {
    const p = buildPortfolioFacts([], 0, new Map(), NOW);
    expect(p.totalValue.value).toBe(0);
    expect(p.weightsSum).toBe(0);
  });

  it("a book with nothing priced and no cash is unavailable", () => {
    const p = buildPortfolioFacts([{ ticker: "XYZ", shares: 1, avgCost: 10 }], 0, new Map(), NOW);
    expect(p.totalValue.value).toBeNull();
    expect(p.totalValue.note).toBe("No holdings could be priced");
  });
});

describe("getPortfolioFacts", () => {
  beforeEach(async () => {
    fs.current = createFakeFirestore();
    const u = fs.current.db.collection("users").doc("u1");
    await u.collection("holdings").doc("AAPL").set({ ticker: "AAPL", shares: 10, avgCost: 150 });
    await u.collection("portfolioSettings").doc("default").set({ cashBalance: 100 });
    deps.getTickerQuoteFacts.mockImplementation(async (t: string) => priced(t, 230));
  });

  it("reads holdings and cash for the user and prices them from facts", async () => {
    const p = await getPortfolioFacts("u1", { now: () => NOW });
    expect(p.holdings.map((h) => h.ticker)).toEqual(["AAPL"]);
    expect(p.totalValue.value).toBe(2400);
    expect(deps.getTickerQuoteFacts).toHaveBeenCalledWith("AAPL", expect.anything());
  });
});
