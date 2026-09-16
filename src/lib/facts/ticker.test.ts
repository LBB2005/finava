// src/lib/facts/ticker.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import aapl from "@/lib/__fixtures__/sec/aapl.json";
import { createFakeFirestore } from "@/test/fakeFirestore";

const fs = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeFirestore> | null }));
const deps = vi.hoisted(() => ({
  getQuote: vi.fn(), getBasicFinancials: vi.fn(), getEarningsCalendar: vi.fn(), getPriceTarget: vi.fn(),
  getCikByTicker: vi.fn(), getCompanyFacts: vi.fn(), getStockBundle: vi.fn(), assembleScoreInputs: vi.fn(),
}));

vi.mock("@/lib/firebase-admin", () => ({ get db() { return fs.current!.db; } }));
vi.mock("@/lib/llm", () => ({ generate: vi.fn() }));
vi.mock("@/lib/sentiment/grok", () => ({ getGrokSentiment: vi.fn() }));
vi.mock("@/agents/skills", () => ({ getSkillsPrompt: () => "" }));
vi.mock("@/lib/finnhub", () => ({
  getQuote: deps.getQuote, getBasicFinancials: deps.getBasicFinancials,
  getEarningsCalendar: deps.getEarningsCalendar, getPriceTarget: deps.getPriceTarget,
}));
vi.mock("@/lib/edgar", async (orig) => ({
  ...(await orig<typeof import("@/lib/edgar")>()),
  getCikByTicker: deps.getCikByTicker, getCompanyFacts: deps.getCompanyFacts,
}));
vi.mock("@/lib/stockData", () => ({ getStockBundle: deps.getStockBundle }));
vi.mock("@/lib/finavaInputs", async (orig) => ({
  ...(await orig<typeof import("@/lib/finavaInputs")>()),
  assembleScoreInputs: deps.assembleScoreInputs,
}));

import { getTickerFacts, getTickerFactsSlim } from "./ticker";
import { clearFactsMemo } from "./cache";
import { SCORE_VERSION, DCF_VERSION } from "./types";

const NOW = new Date("2026-09-15T18:00:00.000Z");
const now = () => NOW;

const INPUTS = {
  revenueYoY: 0.11, epsYoY: 0.14, revenueCagr3y: 0.09, grossMargin: 45, operatingMargin: 30, netMargin: 25,
  roe: 28, roa: 18, roic: 22, debtToEquity: 1.1, currentRatio: 1.3, fcfConversion: 1.05,
  price: 230, dcfFair: 215, peTTM: 30, peerPe: 26, psTTM: 7, peerPs: 6,
  ratingSkew: 0.6, targetUpsidePct: null, estimateRevisionPct: null, earningsSurprisePct: 0.04,
  trendVs200: 0.08, ret3m: 0.06, relStrength6m: 0.04, newsSentiment: 62, xSentiment: 58, insiderFlow: 0.2,
  beta: 1.2, annualizedVol: 0.24,
};

beforeEach(() => {
  vi.clearAllMocks();
  fs.current = createFakeFirestore();
  clearFactsMemo();
  deps.getQuote.mockResolvedValue({ ticker: "AAPL", price: 230, change: 2, changePct: 0.9, volume: 0, high: 0, low: 0, open: 0, prevClose: 0, asOf: "2026-09-15T17:59:00.000Z", asOfSource: "exchange" });
  deps.getBasicFinancials.mockResolvedValue({ metric: { epsTTM: 7.5, beta: 1.2, "52WeekLow": 170, "52WeekHigh": 260, marketCapitalization: 3_400_000, ebitdPerShareTTM: 11 } });
  deps.getEarningsCalendar.mockResolvedValue({ earningsCalendar: [{ symbol: "AAPL", date: "2026-10-28", epsEstimate: 2.02 }] });
  deps.getPriceTarget.mockResolvedValue({ targetMean: 250, numberOfAnalysts: 38 });
  deps.getCikByTicker.mockResolvedValue("0000320193");
  deps.getCompanyFacts.mockResolvedValue(aapl);
  deps.getStockBundle.mockResolvedValue({ insider: null, sentiment: { score: 60 }, profile: { name: "Apple Inc." } });
  deps.assembleScoreInputs.mockResolvedValue(INPUTS);
});

describe("getTickerFacts", () => {
  it("computes score and DCF on a miss, with versions, and caches them globally", async () => {
    const f = await getTickerFacts("aapl", { now });
    expect(f.ticker).toBe("AAPL");
    expect(f.score.value?.version).toBe(SCORE_VERSION);
    expect(f.score.value?.grade).toMatch(/^[A-F][+-]?$/);
    expect(f.score.value?.pillars).toHaveLength(6);
    expect(f.dcf.value?.version).toBe(DCF_VERSION);
    expect(f.dcf.value?.wacc).toBeCloseTo(0.04 + 1.2 * 0.05);
    expect(fs.current!.docs.has("factsCache/AAPL")).toBe(true);
    expect(f.dropped).toEqual([]);
  });

  it("feeds the score the canonical DCF fair value and P/E", async () => {
    const f = await getTickerFacts("AAPL", { now });
    const pre = deps.assembleScoreInputs.mock.calls[0][5];
    expect(pre.dcf.dcfFair).toBe(f.dcf.value!.fairValue);
    expect(pre.peTTM).toBeCloseTo(230 / 7.5);
  });

  it("serves a second read from the cache without re-assembling", async () => {
    await getTickerFacts("AAPL", { now });
    clearFactsMemo();
    await getTickerFacts("AAPL", { now });
    expect(deps.assembleScoreInputs).toHaveBeenCalledTimes(1);
  });

  it("cachedOnly never assembles, and says the score isn't computed yet", async () => {
    const f = await getTickerFacts("AAPL", { now, cachedOnly: true });
    expect(deps.assembleScoreInputs).not.toHaveBeenCalled();
    expect(deps.getStockBundle).not.toHaveBeenCalled();
    expect(f.score.value).toBeNull();
    expect(f.score.note).toBe("Not scored yet");
    expect(f.price.value).toBe(230);
  });

  it("refreshDerived recomputes even when cached", async () => {
    await getTickerFacts("AAPL", { now });
    await getTickerFacts("AAPL", { now, refreshDerived: true });
    expect(deps.assembleScoreInputs).toHaveBeenCalledTimes(2);
  });

  it("isolates a failing source and names it", async () => {
    deps.getQuote.mockRejectedValue(new Error("Finnhub 429"));
    const f = await getTickerFacts("AAPL", { now, cachedOnly: true });
    expect(f.dropped).toEqual(["quote"]);
    expect(f.price.note).toBe("Source unavailable right now");
    expect(f.revenueTTM.value).not.toBeNull();
  });

  it("drops a source that misses the deadline instead of waiting", async () => {
    deps.getCompanyFacts.mockImplementation(() => new Promise(() => {}));
    const t0 = Date.now();
    const f = await getTickerFacts("AAPL", { now, cachedOnly: true, deadlineMs: 50 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(f.dropped).toContain("edgar");
    expect(f.revenueTTM.note).toBe("Not retrieved in time");
  });

  it("a symbol without SEC filings gets a noted DCF and still a score", async () => {
    deps.getCikByTicker.mockResolvedValue(null);
    const f = await getTickerFacts("SPY", { now });
    expect(f.dcf.value).toBeNull();
    expect(f.dcf.note).toBe("No SEC filings for this symbol");
    expect(f.score.value).not.toBeNull();
  });

  it("does not cache a missing DCF", async () => {
    deps.getCikByTicker.mockResolvedValue(null);
    await getTickerFacts("SPY", { now });
    const doc = fs.current!.docs.get("factsCache/SPY")!;
    expect(doc.dcf).toBeUndefined();
    expect(doc.score).toBeDefined();
  });

  it("re-deriving a missing DCF does not re-stamp the cached score", async () => {
    deps.getCikByTicker.mockResolvedValue(null);
    await getTickerFacts("SPY", { now });
    const firstAt = fs.current!.docs.get("factsCache/SPY")!.scoreAt;
    clearFactsMemo();
    await getTickerFacts("SPY", { now: () => new Date(NOW.getTime() + 3_600_000) });
    expect(fs.current!.docs.get("factsCache/SPY")!.scoreAt).toBe(firstAt);
    expect(deps.assembleScoreInputs).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent computes for one ticker", async () => {
    await Promise.all([getTickerFacts("AAPL", { now }), getTickerFacts("AAPL", { now })]);
    expect(deps.assembleScoreInputs).toHaveBeenCalledTimes(1);
  });
});

describe("getTickerFactsSlim", () => {
  it("reads only the cache: scored names get their score, others a note", async () => {
    const full = await getTickerFacts("AAPL", { now });
    vi.clearAllMocks();
    const slim = await getTickerFactsSlim(["AAPL", "MSFT"], { now });
    expect(slim[0]).toEqual({ ticker: "AAPL", score: { ...full.score, value: { total: full.score.value!.total, grade: full.score.value!.grade, version: SCORE_VERSION } } });
    expect(slim[1].score.value).toBeNull();
    expect(slim[1].score.note).toMatch(/Not scored yet/);
    expect(deps.getQuote).not.toHaveBeenCalled();
  });
});
