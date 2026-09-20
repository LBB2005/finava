import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { tickerFactsFixture } from "@/test/factsFixture";

const deps = vi.hoisted(() => ({ guardDataRoute: vi.fn(), getTickerFacts: vi.fn() }));
vi.mock("@/lib/dataRouteGuard", () => ({ guardDataRoute: deps.guardDataRoute }));
vi.mock("@/lib/facts/ticker", () => ({ getTickerFacts: deps.getTickerFacts }));

import { GET } from "./route";

const ctx = (ticker: string) => ({ params: Promise.resolve({ ticker }) });

beforeEach(() => {
  vi.clearAllMocks();
  deps.guardDataRoute.mockResolvedValue({ userId: "u1" });
  deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("AAPL"));
});

describe("GET /api/facts/[ticker]", () => {
  it("returns the ticker's facts, uppercased", async () => {
    const res = await GET(new Request("http://t/api/facts/aapl"), ctx("aapl"));
    expect(res.status).toBe(200);
    expect((await res.json()).ticker).toBe("AAPL");
    expect(deps.getTickerFacts).toHaveBeenCalledWith("AAPL", { cachedOnly: false });
  });

  it("passes cachedOnly through", async () => {
    await GET(new Request("http://t/api/facts/AAPL?cachedOnly=1"), ctx("AAPL"));
    expect(deps.getTickerFacts).toHaveBeenCalledWith("AAPL", { cachedOnly: true });
  });

  it("400s an invalid ticker without loading", async () => {
    expect((await GET(new Request("http://t"), ctx("not a ticker!"))).status).toBe(400);
    expect(deps.getTickerFacts).not.toHaveBeenCalled();
  });

  it("honours the rate limit", async () => {
    deps.guardDataRoute.mockResolvedValueOnce({ error: NextResponse.json({ error: "slow" }, { status: 429 }) });
    expect((await GET(new Request("http://t"), ctx("AAPL"))).status).toBe(429);
  });

  it("502s if the loader unexpectedly throws", async () => {
    deps.getTickerFacts.mockRejectedValueOnce(new Error("boom"));
    expect((await GET(new Request("http://t"), ctx("AAPL"))).status).toBe(502);
  });
});
