import { describe, it, expect } from "vitest";
import { buildPortfolioContext, computePortfolio } from "./portfolioContext";
import type { Quote } from "@/types/portfolio";

const NOW = new Date("2026-09-14T19:42:00Z"); // Mon 14 Sep 2026, 15:42 ET

const h = (ticker: string, shares: number, avgCost: number, extra: Record<string, unknown> = {}) => ({
  ticker,
  shares,
  avgCost,
  companyName: null,
  sector: null,
  ...extra,
});
const quotes = (entries: [string, number, number?][]) =>
  new Map<string, Quote>(
    entries.map(([ticker, price, changePct = 0]) => [
      ticker,
      { ticker, price, change: 0, changePct, timestamp: NOW.getTime() },
    ])
  );

/** Weight cells (last-but-… column) pulled back out of the rendered table. */
function weightsFromTable(ctx: string): number[] {
  return ctx
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| Ticker") && !l.startsWith("| **Total"))
    .map((l) => l.split("|").map((c) => c.trim())[5])
    .filter((c) => c.endsWith("%"))
    .map((c) => parseFloat(c));
}

describe("computePortfolio", () => {
  it("computes market value, cost basis (per-share × qty), P&L and weights including cash", () => {
    const p = computePortfolio([h("AAPL", 10, 100), h("MSFT", 5, 200)], 500, quotes([["AAPL", 150], ["MSFT", 300]]));
    // AAPL 1500, MSFT 1500, cash 500 → total 3500
    expect(p.totalValue).toBe(3500);
    const aapl = p.rows.find((r) => r.ticker === "AAPL")!;
    expect(aapl.marketValue).toBe(1500);
    expect(aapl.costBasis).toBe(1000);
    expect(aapl.pnl).toBe(500);
    expect(aapl.weightPct).toBeCloseTo(42.9, 1);
    expect(p.cashWeightPct).toBeCloseTo(14.3, 1);
  });

  it("rounds weights so holdings + cash sum to 100 ± 0.1 even with many awkward rows", () => {
    const hs = ["A1", "B2", "C3", "D4", "E5", "F6", "G7"].map((t) => h(t, 1, 1));
    const q = quotes(hs.map((x, i) => [x.ticker, 1 + i * 0.37] as [string, number]));
    const p = computePortfolio(hs, 3.33, q);
    const sum = p.rows.reduce((s, r) => s + (r.weightPct ?? 0), 0) + p.cashWeightPct!;
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.1);
  });

  it("excludes a holding with no quote from totals and weights and marks it unpriced", () => {
    const p = computePortfolio([h("AAPL", 10, 100), h("MRNA", 50, 80)], 0, quotes([["AAPL", 150]]));
    const mrna = p.rows.find((r) => r.ticker === "MRNA")!;
    expect(mrna.marketValue).toBeNull();
    expect(mrna.weightPct).toBeNull();
    expect(mrna.pnl).toBeNull();
    expect(p.totalValue).toBe(1500);
    expect(p.unpriced).toEqual(["MRNA"]);
    expect(p.rows.find((r) => r.ticker === "AAPL")!.weightPct).toBe(100);
  });
});

describe("buildPortfolioContext", () => {
  it("returns an empty string for an empty account", () => {
    expect(buildPortfolioContext([], 0, new Map(), NOW)).toBe("");
  });

  it("renders a table whose weights (holdings + cash) sum to 100 ± 0.1 and states the sum", () => {
    const ctx = buildPortfolioContext(
      [h("AAPL", 10, 100), h("MSFT", 3, 250), h("NVDA", 7, 90)],
      1234.56,
      quotes([["AAPL", 151.23], ["MSFT", 402.1], ["NVDA", 177.7]]),
      NOW
    );
    const weights = weightsFromTable(ctx);
    expect(weights.length).toBe(4); // 3 holdings + cash
    expect(Math.abs(weights.reduce((a, b) => a + b, 0) - 100)).toBeLessThanOrEqual(0.1);
    expect(ctx).toContain("Weights sum: 100.0%");
    expect(ctx).toMatch(/\| Cash \|/);
    expect(ctx).toContain("Use these weights verbatim; do not recompute.");
  });

  it("states the price as-of time from the quotes", () => {
    const ctx = buildPortfolioContext([h("AAPL", 1, 1)], 0, quotes([["AAPL", 2]]), NOW);
    expect(ctx).toContain("Prices as of 14 Sep 2026, 15:42 US/Eastern");
  });

  it("shows per-holding market value, cost basis, unrealized P&L and the totals row", () => {
    const ctx = buildPortfolioContext([h("AAPL", 10, 100)], 500, quotes([["AAPL", 150, 1.25]]), NOW);
    expect(ctx).toContain("| AAPL | 10 | $150.00 | $1,500.00 | 75.0% | $1,000.00 | +$500.00 (+50.0%) | +1.25% |");
    expect(ctx).toContain("| Cash | — | — | $500.00 | 25.0% | — | — | — |");
    expect(ctx).toMatch(/\| \*\*Total\*\* \| — \| — \| \$2,000\.00 \| 100\.0% \| \$1,000\.00 \| \+\$500\.00 \(\+50\.0%\) \| — \|/);
  });

  it("writes Unavailable for a missing quote, excludes it from weights, and says so", () => {
    const ctx = buildPortfolioContext([h("AAPL", 10, 100), h("MRNA", 50, 80)], 0, quotes([["AAPL", 150]]), NOW);
    expect(ctx).toContain("| MRNA | 50 | Unavailable | Unavailable | Unavailable | $4,000.00 | Unavailable | Unavailable |");
    expect(ctx).toMatch(/MRNA.*no live quote.*excluded from the total and the weights/);
    expect(weightsFromTable(ctx)).toEqual([100, 0]); // AAPL + cash
  });

  it("marks weights Unavailable when nothing can be priced", () => {
    const ctx = buildPortfolioContext([h("MRNA", 50, 80)], 0, new Map(), NOW);
    expect(ctx).toContain("Weights sum: Unavailable");
    expect(ctx).not.toContain("100.0%");
  });

  it("keeps the table free of uppercase words that would be mistaken for tickers", () => {
    const ctx = buildPortfolioContext([h("AAPL", 10, 100)], 50, quotes([["AAPL", 150]]), NOW);
    const caps = (ctx.match(/\b[A-Z]{2,5}\b/g) ?? []).filter((t) => t !== "US");
    expect([...new Set(caps)]).toEqual(["AAPL"]);
  });
});
