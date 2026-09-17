import { beforeEach, describe, expect, it, vi } from "vitest";
import { tickerFactsFixture } from "@/test/factsFixture";

const deps = vi.hoisted(() => ({
  getTickerFacts: vi.fn(),
  getPortfolioFacts: vi.fn(),
  getInsiderTransactions: vi.fn(),
}));

vi.mock("./ticker", () => ({ getTickerFacts: deps.getTickerFacts }));
vi.mock("./portfolio", () => ({ getPortfolioFacts: deps.getPortfolioFacts }));
vi.mock("@/lib/finnhub", () => ({ getInsiderTransactions: deps.getInsiderTransactions }));

import { loadChatFacts } from "./chatFacts";

const PORTFOLIO = { holdings: [], totalValue: { value: 0, source: "x", asOf: "y" }, cash: { value: 0, source: "x", asOf: "y" }, weightsSum: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  deps.getTickerFacts.mockImplementation(async (t: string) => tickerFactsFixture(t));
  deps.getPortfolioFacts.mockResolvedValue(PORTFOLIO);
  deps.getInsiderTransactions.mockResolvedValue({ data: [{ name: "A", change: 100, transactionPrice: 10, transactionDate: "2026-09-01", transactionCode: "P" }] });
});

describe("loadChatFacts", () => {
  it("loads each ticker's facts, capped at three", async () => {
    const r = await loadChatFacts({ tickers: ["aapl", "MSFT", "NVDA", "AMD"], deadlineMs: 1_000 });
    expect(r.input.tickers?.map((t) => t.ticker)).toEqual(["AAPL", "MSFT", "NVDA"]);
    expect(deps.getTickerFacts).toHaveBeenCalledWith("AAPL", expect.objectContaining({ deadlineMs: 1_000 }));
    expect(r.dropped).toEqual([]);
  });

  it("loads insider facts and the portfolio only when asked", async () => {
    const none = await loadChatFacts({ tickers: ["PFE"], deadlineMs: 1_000 });
    expect(none.input.insider).toBeUndefined();
    expect(none.input.portfolio).toBeUndefined();
    expect(deps.getInsiderTransactions).not.toHaveBeenCalled();

    const both = await loadChatFacts({ tickers: ["PFE"], insider: true, portfolioUserId: "u1", deadlineMs: 1_000 });
    expect(both.input.insider?.[0].buyTotal.value).toBe(1_000);
    expect(both.input.portfolio).toBe(PORTFOLIO);
    expect(deps.getPortfolioFacts).toHaveBeenCalledWith("u1");
  });

  it("keeps a failed insider feed as missing facts rather than dropping the ticker", async () => {
    deps.getInsiderTransactions.mockRejectedValueOnce(new Error("429"));
    const r = await loadChatFacts({ tickers: ["PFE"], insider: true, deadlineMs: 1_000 });
    expect(r.input.insider?.[0].buyTotal.value).toBeNull();
    expect(r.dropped).toContain("insider");
  });

  it("drops what misses the deadline and names it", async () => {
    deps.getPortfolioFacts.mockImplementationOnce(() => new Promise(() => {}));
    deps.getTickerFacts.mockRejectedValueOnce(new Error("down"));
    const r = await loadChatFacts({ tickers: ["AAPL"], portfolioUserId: "u1", deadlineMs: 20 });
    expect(r.input.portfolio).toBeNull();
    expect(r.input.tickers).toEqual([]);
    expect(r.dropped).toEqual(expect.arrayContaining(["portfolio", "AAPL facts"]));
  });
});
