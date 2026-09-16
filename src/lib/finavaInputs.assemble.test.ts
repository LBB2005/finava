// assembleScoreInputs — the I/O half of finavaInputs. Every upstream is mocked at
// the module boundary; the pure extractor helpers are covered in finavaInputs.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  getBasicFinancials: vi.fn(),
  getEarnings: vi.fn(),
  getPeerMetrics: vi.fn(),
  getRecommendationTrends: vi.fn(),
  getCandles: vi.fn(),
  getCikByTicker: vi.fn(),
  getCompanyFacts: vi.fn(),
  extractFinancialMetrics: vi.fn(),
  extractFundamentalTimeSeries: vi.fn(),
  extractCurrentSharesOutstanding: vi.fn(() => null),
  suggestedWaccFromBeta: vi.fn(() => 0.09),
  defaultFairValue: vi.fn(() => 210),
  getGrokSentiment: vi.fn(),
  insiderNetFlow: vi.fn(() => 0.01),
}));

vi.mock("@/lib/finnhub", () => ({
  getBasicFinancials: deps.getBasicFinancials,
  getEarnings: deps.getEarnings,
  getPeerMetrics: deps.getPeerMetrics,
  getRecommendationTrends: deps.getRecommendationTrends,
  getCandles: deps.getCandles,
}));
vi.mock("@/lib/edgar", () => ({
  getCikByTicker: deps.getCikByTicker,
  getCompanyFacts: deps.getCompanyFacts,
  extractFinancialMetrics: deps.extractFinancialMetrics,
  extractFundamentalTimeSeries: deps.extractFundamentalTimeSeries,
  extractCurrentSharesOutstanding: deps.extractCurrentSharesOutstanding,
}));
vi.mock("@/lib/dcf", () => ({
  suggestedWaccFromBeta: deps.suggestedWaccFromBeta,
  defaultFairValue: deps.defaultFairValue,
}));
vi.mock("@/lib/sentiment/grok", () => ({ getGrokSentiment: deps.getGrokSentiment }));
vi.mock("@/lib/stockData", () => ({ insiderNetFlow: deps.insiderNetFlow }));

import { assembleScoreInputs } from "@/lib/finavaInputs";

/** A closes array long enough to satisfy the 200-bar momentum gate. */
function closes(n: number, fn: (i: number) => number = () => 100) {
  return Array.from({ length: n }, (_, i) => fn(i));
}

/** Revenue series as extractFundamentalTimeSeries returns it (oldest first). */
function revenue(values: number[]) {
  return { revenue: values.map((value, i) => ({ period: `FY${i}`, value })) };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.getBasicFinancials.mockResolvedValue({
    metric: { roeTTM: 140, peTTM: 30, sharesOutstanding: 15_000 /* millions */ },
  });
  deps.getEarnings.mockResolvedValue([{ actual: 1.2, estimate: 1.0 }]);
  deps.getRecommendationTrends.mockResolvedValue([{ strongBuy: 10, buy: 5, hold: 2, sell: 0, strongSell: 0 }]);
  deps.getPeerMetrics.mockResolvedValue({ peerPe: 25, peerPs: 6 });
  deps.getGrokSentiment.mockResolvedValue({ score: 0.5, degraded: false, foundPosts: 40 });
  deps.getCandles.mockResolvedValue({ c: closes(300, (i) => 100 + i * 0.1) });
  deps.getCikByTicker.mockResolvedValue("0000320193");
  deps.getCompanyFacts.mockResolvedValue({ facts: {} });
  deps.extractFinancialMetrics.mockReturnValue({
    operatingCashFlow: 120,
    capex: 20,
    netIncome: 50,
    sharesOutstanding: 15e9,
    totalDebt: 100,
    cash: 60,
  });
  deps.extractFundamentalTimeSeries.mockReturnValue(revenue([100, 110, 120, 130]));
});

describe("assembleScoreInputs — happy path", () => {
  it("folds every source into one ScoreInputs object", async () => {
    const out = await assembleScoreInputs("AAPL", 190, [{ shares: 1000 }], 62, "Apple Inc.");

    expect(out).toMatchObject({
      price: 190,
      newsSentiment: 62,
      roe: 140,
      peTTM: 30,
      peerPe: 25,
      peerPs: 6,
      dcfFair: 210,
      insiderFlow: 0.01,
    });
    expect(out.earningsSurprisePct).toBeCloseTo(0.2, 5);
    expect(out.ratingSkew).toBeCloseTo((2 * 10 + 5) / (2 * 17), 5);
  });

  it("passes the company name through to the X/social read", async () => {
    await assembleScoreInputs("AAPL", 190, null, null, "Apple Inc.");
    expect(deps.getGrokSentiment).toHaveBeenCalledWith("AAPL", "Apple Inc.");
  });

  it("benchmarks relative strength against SPY", async () => {
    await assembleScoreInputs("AAPL", 190, null, null);
    const symbols = deps.getCandles.mock.calls.map((c) => c[0]);
    expect(symbols).toEqual(["AAPL", "SPY"]);
  });
});

describe("assembleScoreInputs — X/social sentiment", () => {
  it("maps Grok polarity [-1,1] onto a 0–100 scale", async () => {
    deps.getGrokSentiment.mockResolvedValueOnce({ score: 0.5, degraded: false, foundPosts: 10 });
    expect((await assembleScoreInputs("AAPL", 190, null, null)).xSentiment).toBe(75);

    deps.getGrokSentiment.mockResolvedValueOnce({ score: -1, degraded: false, foundPosts: 10 });
    expect((await assembleScoreInputs("AAPL", 190, null, null)).xSentiment).toBe(0);
  });

  it("clamps an out-of-range polarity into 0–100", async () => {
    deps.getGrokSentiment.mockResolvedValueOnce({ score: 5, degraded: false, foundPosts: 10 });
    expect((await assembleScoreInputs("AAPL", 190, null, null)).xSentiment).toBe(100);
  });

  it("excludes a degraded read or one with no posts", async () => {
    deps.getGrokSentiment.mockResolvedValueOnce({ score: 0.9, degraded: true, foundPosts: 10 });
    expect((await assembleScoreInputs("AAPL", 190, null, null)).xSentiment).toBeNull();

    deps.getGrokSentiment.mockResolvedValueOnce({ score: 0.9, degraded: false, foundPosts: 0 });
    expect((await assembleScoreInputs("AAPL", 190, null, null)).xSentiment).toBeNull();
  });

  it("excludes X sentiment entirely when Grok fails", async () => {
    deps.getGrokSentiment.mockRejectedValueOnce(new Error("xai 402"));
    expect((await assembleScoreInputs("AAPL", 190, null, null)).xSentiment).toBeNull();
  });
});

describe("assembleScoreInputs — momentum", () => {
  it("computes trendVs200 and ret3m from at least 200 bars", async () => {
    deps.getCandles.mockResolvedValue({ c: closes(300, () => 100) });
    const out = await assembleScoreInputs("AAPL", 190, null, null);
    expect(out.trendVs200).toBeCloseTo(0, 10);
    expect(out.ret3m).toBeCloseTo(0, 10);
  });

  it("leaves momentum null with fewer than 200 bars", async () => {
    deps.getCandles.mockResolvedValue({ c: closes(150) });
    const out = await assembleScoreInputs("AAPL", 190, null, null);
    expect(out.trendVs200).toBeNull();
    expect(out.ret3m).toBeNull();
  });

  it("computes 6-month relative strength when both series are long enough", async () => {
    deps.getCandles.mockImplementation(async (symbol: string) =>
      symbol === "SPY"
        ? { c: closes(300, () => 100) } // flat benchmark
        : { c: closes(300, (i) => 100 + i) }, // rising stock
    );
    expect((await assembleScoreInputs("AAPL", 190, null, null)).relStrength6m).toBeGreaterThan(0);
  });

  it("leaves relative strength null when the benchmark is short", async () => {
    deps.getCandles.mockImplementation(async (symbol: string) =>
      symbol === "SPY" ? { c: closes(50) } : { c: closes(300) },
    );
    expect((await assembleScoreInputs("AAPL", 190, null, null)).relStrength6m).toBeNull();
  });

  it("survives a candle fetch failure with momentum and volatility null", async () => {
    deps.getCandles.mockRejectedValue(new Error("finnhub 429"));
    const out = await assembleScoreInputs("AAPL", 190, null, null);
    expect(out.trendVs200).toBeNull();
    expect(out.relStrength6m).toBeNull();
    expect(out.annualizedVol).toBeNull();
  });

  it("guards a zero 200-day average and a zero 63-day-ago price", async () => {
    deps.getCandles.mockResolvedValue({ c: closes(300, () => 0) });
    const out = await assembleScoreInputs("AAPL", 190, null, null);
    expect(out.trendVs200).toBeNull();
    expect(out.ret3m).toBeNull();
  });
});

describe("assembleScoreInputs — the DCF bundle", () => {
  it("derives fair value, FCF conversion and a 3-year revenue CAGR", async () => {
    const out = await assembleScoreInputs("AAPL", 190, null, null);
    expect(out.dcfFair).toBe(210);
    expect(out.fcfConversion).toBeCloseTo((120 - 20) / 50, 5);
    expect(out.revenueCagr3y).toBeCloseTo(Math.pow(130 / 100, 1 / 3) - 1, 5);
  });

  it("nets debt against cash and marks capex-less FCF as a proxy", async () => {
    deps.extractFinancialMetrics.mockReturnValueOnce({
      operatingCashFlow: 120,
      netIncome: 50,
      sharesOutstanding: 15e9,
      totalDebt: 100,
      cash: 60,
    });
    await assembleScoreInputs("AAPL", 190, null, null);
    expect(deps.defaultFairValue).toHaveBeenCalledWith(
      expect.objectContaining({ baseFcf: 120, fcfIsProxy: true, netDebt: 40, currentPrice: 190 }),
    );
  });

  it("skips the whole bundle when the ticker has no CIK", async () => {
    deps.getCikByTicker.mockResolvedValueOnce(null);
    const out = await assembleScoreInputs("AAPL", 190, null, null);
    expect(out).toMatchObject({ dcfFair: null, fcfConversion: null, revenueCagr3y: null });
    expect(deps.getCompanyFacts).not.toHaveBeenCalled();
  });

  it("nulls FCF conversion when net income is missing or non-positive", async () => {
    deps.extractFinancialMetrics.mockReturnValueOnce({ operatingCashFlow: 120, capex: 20, netIncome: 0 });
    expect((await assembleScoreInputs("AAPL", 190, null, null)).fcfConversion).toBeNull();
  });

  it("nulls the 3-year CAGR with fewer than four revenue periods", async () => {
    deps.extractFundamentalTimeSeries.mockReturnValueOnce(revenue([100, 110, 120]));
    expect((await assembleScoreInputs("AAPL", 190, null, null)).revenueCagr3y).toBeNull();
  });

  it("nulls the CAGR when a revenue endpoint is non-positive", async () => {
    deps.extractFundamentalTimeSeries.mockReturnValueOnce(revenue([0, 110, 120, 130]));
    expect((await assembleScoreInputs("AAPL", 190, null, null)).revenueCagr3y).toBeNull();
  });

  it("survives an EDGAR failure without failing the whole assembly", async () => {
    deps.getCompanyFacts.mockRejectedValueOnce(new Error("sec 503"));
    const out = await assembleScoreInputs("AAPL", 190, null, null);
    expect(out.dcfFair).toBeNull();
    expect(out.roe).toBe(140); // the rest still assembled
  });
});

describe("assembleScoreInputs — failure isolation", () => {
  it("keeps going when every optional source fails", async () => {
    deps.getBasicFinancials.mockRejectedValueOnce(new Error("down"));
    deps.getEarnings.mockRejectedValueOnce(new Error("down"));
    deps.getRecommendationTrends.mockRejectedValueOnce(new Error("down"));
    deps.getPeerMetrics.mockRejectedValueOnce(new Error("down"));
    deps.getGrokSentiment.mockRejectedValueOnce(new Error("down"));
    deps.getCandles.mockRejectedValue(new Error("down"));
    deps.getCikByTicker.mockRejectedValueOnce(new Error("down"));

    const out = await assembleScoreInputs("AAPL", 190, null, 55);
    expect(out).toMatchObject({
      price: 190,
      newsSentiment: 55,
      roe: null,
      peTTM: null,
      peerPe: null,
      ratingSkew: null,
      earningsSurprisePct: null,
      dcfFair: null,
      xSentiment: null,
    });
  });

  it("normalises insider flow against absolute shares (Finnhub reports millions)", async () => {
    await assembleScoreInputs("AAPL", 190, [{ shares: 1000 }], null);
    expect(deps.insiderNetFlow).toHaveBeenCalledWith([{ shares: 1000 }], 15_000 * 1e6);
  });

  it("passes a null share count through when the metric is missing", async () => {
    deps.getBasicFinancials.mockResolvedValueOnce({ metric: {} });
    await assembleScoreInputs("AAPL", 190, [{ shares: 1000 }], null);
    expect(deps.insiderNetFlow).toHaveBeenCalledWith([{ shares: 1000 }], null);
  });

  it("tolerates a metrics payload with no `metric` key", async () => {
    deps.getBasicFinancials.mockResolvedValueOnce({});
    expect((await assembleScoreInputs("AAPL", 190, null, null)).roe).toBeNull();
  });

  it("accepts a null price", async () => {
    const out = await assembleScoreInputs("AAPL", null, null, null);
    expect(out.price).toBeNull();
    expect(deps.defaultFairValue).toHaveBeenCalledWith(
      expect.objectContaining({ currentPrice: null }),
    );
  });
  it("uses precomputed DCF parts and skips the filing fetch", async () => {
    const out = await assembleScoreInputs("AAPL", 200, null, null, "Apple", {
      dcf: { dcfFair: 171, fcfConversion: 0.9, revenueCagr3y: 0.05 },
    });
    expect(out.dcfFair).toBe(171);
    expect(out.fcfConversion).toBe(0.9);
    expect(out.revenueCagr3y).toBe(0.05);
    expect(deps.getCikByTicker).not.toHaveBeenCalled();
  });

  it("overrides peTTM with the canonical P/E when given, including null", async () => {
    expect((await assembleScoreInputs("AAPL", 200, null, null, "Apple", { peTTM: 33.1 })).peTTM).toBe(33.1);
    expect((await assembleScoreInputs("AAPL", 200, null, null, "Apple", { peTTM: null })).peTTM).toBeNull();
  });
});
