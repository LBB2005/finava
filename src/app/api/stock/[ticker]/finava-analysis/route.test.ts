import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { tickerFactsFixture, scoreInputs as inputs } from "@/test/factsFixture";
import { fact, missing } from "@/lib/facts/types";

const deps = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  userRateLimit: vi.fn(),
  checkUsageLimit: vi.fn(),
  usageEnterWith: vi.fn(),
  generate: vi.fn(),
  getStockBundle: vi.fn(),
  getTickerFacts: vi.fn(),
  saveVerdict: vi.fn(),
}));

vi.mock("@/lib/requireAuth", () => ({ requireAuth: deps.requireAuth }));
vi.mock("@/lib/rateLimit", () => ({ userRateLimit: deps.userRateLimit }));
vi.mock("@/lib/usage", () => ({
  checkUsageLimit: deps.checkUsageLimit,
  makeRunContext: (u: string) => ({ userId: u }),
  usageStore: { enterWith: deps.usageEnterWith },
}));
vi.mock("@/lib/llm", () => ({
  AGENT_MODELS: { finavaSynthesis: "synth-model" },
  generate: deps.generate,
}));
vi.mock("@/lib/stockData", () => ({ getStockBundle: deps.getStockBundle }));
vi.mock("@/lib/facts/ticker", () => ({ getTickerFacts: deps.getTickerFacts }));
vi.mock("@/lib/verdictStore", () => ({ saveVerdict: deps.saveVerdict }));

// The scoring engine itself is NOT mocked — these tests assert that the route
// ships the engine's number, so stubbing it would defeat the point.
import { POST } from "./route";

function ctx(ticker: string) {
  return { params: Promise.resolve({ ticker }) };
}

/** Parse the SSE body back into the events the client would receive. */
async function events(res: Response) {
  const body = await res.text();
  return body
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)));
}

/** Facts whose score comes from `inputs` through the real engine. */
function factsFor(over: Parameters<typeof inputs>[0] = {}) {
  const i = inputs(over);
  return tickerFactsFixture("AAPL", {
    price: fact(200, { source: "Finnhub quote", asOf: "2026-09-15T20:00:00.000Z", unit: "USD" }),
    streetTarget: fact(225, { source: "Finnhub price target", asOf: "2026-09-15T20:00:00.000Z", unit: "USD" }),
  }, i);
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.requireAuth.mockResolvedValue({ userId: "user_123" });
  deps.userRateLimit.mockResolvedValue(null);
  deps.checkUsageLimit.mockResolvedValue(null);
  deps.getStockBundle.mockResolvedValue({
    ticker: "AAPL",
    profile: { name: "Apple Inc.", currency: "USD" },
    quote: { price: 200, changePct: 1.25 },
    analysts: { targetMean: 225 },
    sentiment: { score: 62 },
    insider: [{ direction: "buy", shares: 1000 }],
  });
  deps.getTickerFacts.mockResolvedValue(factsFor());
  deps.generate.mockResolvedValue(
    JSON.stringify({
      take: "Fundamentals carry the score; valuation is the drag.",
      catalysts: ["Services growth", "Buybacks"],
      risks: ["Multiple compression", ""],
    })
  );
});

describe("POST /api/stock/[ticker]/finava-analysis", () => {
  it("short-circuits auth, rate-limit, usage, ticker, and missing-stock checks", async () => {
    deps.requireAuth.mockResolvedValueOnce({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    expect((await POST(new Request("http://test.local"), ctx("AAPL"))).status).toBe(401);

    deps.requireAuth.mockResolvedValueOnce({ userId: "user_123" });
    deps.userRateLimit.mockResolvedValueOnce(NextResponse.json({ error: "slow" }, { status: 429 }));
    expect((await POST(new Request("http://test.local"), ctx("AAPL"))).status).toBe(429);

    deps.userRateLimit.mockResolvedValueOnce(null);
    deps.checkUsageLimit.mockResolvedValueOnce(NextResponse.json({ error: "quota" }, { status: 429 }));
    expect((await POST(new Request("http://test.local"), ctx("AAPL"))).status).toBe(429);

    expect((await POST(new Request("http://test.local"), ctx("   "))).status).toBe(400);

    deps.getStockBundle.mockResolvedValueOnce({ quote: null, profile: null });
    expect((await POST(new Request("http://test.local"), ctx("NOPE"))).status).toBe(404);
  });

  it("streams all six computed pillars and a deterministic verdict", async () => {
    const res = await POST(new Request("http://test.local"), ctx("aapl"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(deps.usageEnterWith).toHaveBeenCalledWith({ userId: "user_123" });

    const evs = await events(res);
    const signals = evs.filter((e) => e.type === "signal").map((e) => e.signal);
    expect(signals.map((s) => s.key)).toEqual([
      "fundamentals", "valuation", "analyst", "momentum", "sentiment", "insider",
    ]);
    // Every pillar carries its factor breakdown for the expandable rows.
    expect(signals[0].factors.length).toBeGreaterThan(0);

    const verdict = evs.find((e) => e.type === "verdict")!.verdict;
    // Fair value blends the DCF with the Street target; upside is measured off it.
    expect(verdict.fairValue).toBe(220); // (215 + 225) / 2
    expect(verdict.upsidePct).toBeCloseTo(10, 5);
    expect(verdict.comparison).toEqual({ finava: 220, street: 225, dcf: 215 });
    // Peer premium: P/E 30 vs 26 (+15.4%) and P/S 7 vs 6 (+16.7%), averaged.
    expect(verdict.peerPremiumPct).toBeCloseTo(16.03, 1);
    expect(verdict.take).toContain("Fundamentals carry the score");
    expect(verdict.catalysts).toEqual(["Services growth", "Buybacks"]);
    expect(verdict.risks).toEqual(["Multiple compression"]); // blanks dropped
    expect(verdict.model).toBe("synth-model");

    // Persisted for the cached-first stock page.
    expect(deps.saveVerdict).toHaveBeenCalledWith(
      "user_123",
      "AAPL",
      expect.objectContaining({ score: verdict.score }),
      expect.arrayContaining([expect.objectContaining({ key: "valuation" })])
    );
  });

  it("ignores any score the narrative model tries to invent", async () => {
    const res = await POST(new Request("http://test.local"), ctx("AAPL"));
    const baseline = (await events(res)).find((e) => e.type === "verdict")!.verdict.score;

    // Same inputs, but the model now claims a wildly different score.
    deps.generate.mockResolvedValueOnce(
      JSON.stringify({ score: 3, take: "Bearish.", catalysts: [], risks: [] })
    );
    const res2 = await POST(new Request("http://test.local"), ctx("AAPL"));
    const verdict = (await events(res2)).find((e) => e.type === "verdict")!.verdict;

    expect(verdict.score).toBe(baseline); // the engine decides, the LLM narrates
    expect(verdict.take).toBe("Bearish.");
  });

  it("marks a pillar with no data instead of scoring it a neutral 50", async () => {
    deps.getTickerFacts.mockResolvedValueOnce(
      factsFor({ ratingSkew: null, targetUpsidePct: null, estimateRevisionPct: null, earningsSurprisePct: null })
    );

    const res = await POST(new Request("http://test.local"), ctx("AAPL"));
    const analyst = (await events(res))
      .filter((e) => e.type === "signal")
      .map((e) => e.signal)
      .find((s) => s.key === "analyst");

    expect(analyst.isNoData).toBe(true);
    expect(analyst.headline).toBe("No data yet");
  });

  it("flags a narrative failure as fallback: no model badge, and nothing cached", async () => {
    deps.generate.mockRejectedValueOnce(new Error("provider down"));

    const res = await POST(new Request("http://test.local"), ctx("AAPL"));
    const evs = await events(res);
    const verdict = evs.find((e) => e.type === "verdict")!.verdict;

    // The deterministic score still ships…
    expect(evs.filter((e) => e.type === "signal")).toHaveLength(6);
    expect(verdict.score).toBeGreaterThan(0);
    // …but it is labelled as factor data only, never as a model's analysis.
    expect(verdict.fallback).toBe(true);
    expect(verdict.model).toBeUndefined();
    expect(verdict.take).toBe("AI analysis unavailable right now — showing factor data only.");
    expect(verdict.catalysts).toEqual([]);
    expect(verdict.risks).toEqual([]);
    // A canned sentence must not be cached under a "Powered by" label.
    expect(deps.saveVerdict).not.toHaveBeenCalled();
  });

  it("treats an unusable model response (no take) as a fallback too", async () => {
    deps.generate.mockResolvedValueOnce("Sorry, I can't help with that.");

    const res = await POST(new Request("http://test.local"), ctx("AAPL"));
    const verdict = (await events(res)).find((e) => e.type === "verdict")!.verdict;

    expect(verdict.fallback).toBe(true);
    expect(verdict.model).toBeUndefined();
    expect(deps.saveVerdict).not.toHaveBeenCalled();
  });

  it("badges and caches only a real model response", async () => {
    const res = await POST(new Request("http://test.local"), ctx("AAPL"));
    const verdict = (await events(res)).find((e) => e.type === "verdict")!.verdict;

    expect(verdict.fallback).toBe(false);
    expect(verdict.model).toBe("synth-model");
    expect(deps.saveVerdict).toHaveBeenCalledTimes(1);
  });

  it("emits an error and persists nothing when facts fail to load", async () => {
    deps.getTickerFacts.mockRejectedValueOnce(new Error("SEC down"));
    const evs = await events(await POST(new Request("http://test.local"), ctx("AAPL")));
    expect(evs).toContainEqual({ type: "error", message: "Failed to compute the Finava Score." });
    expect(deps.saveVerdict).not.toHaveBeenCalled();
  });

  it("says so when there is not enough data to score, instead of streaming 50s", async () => {
    deps.getTickerFacts.mockResolvedValueOnce(tickerFactsFixture("AAPL", { score: missing("Finava Score v2 (15 factors)", "No factor data available for this symbol") }));
    const evs = await events(await POST(new Request("http://test.local"), ctx("AAPL")));
    expect(evs.filter((e) => e.type === "signal")).toHaveLength(0);
    expect(evs).toContainEqual({ type: "error", message: "Not enough data to compute the Finava Score for AAPL." });
  });

  it("asks facts for a fresh score on a user-requested run", async () => {
    await events(await POST(new Request("http://test.local"), ctx("AAPL")));
    expect(deps.getTickerFacts).toHaveBeenCalledWith("AAPL", { refreshDerived: true });
  });
});
