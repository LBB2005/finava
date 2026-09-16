import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({ rateLimitGuard: vi.fn(), getTickerFactsSlim: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ rateLimitGuard: deps.rateLimitGuard }));
vi.mock("@/lib/facts/ticker", () => ({ getTickerFactsSlim: deps.getTickerFactsSlim }));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  deps.rateLimitGuard.mockResolvedValue(null);
  deps.getTickerFactsSlim.mockImplementation(async (ts: string[]) => ts.map((ticker) => ({ ticker, score: { value: null, source: "s", asOf: "a", note: "Not scored yet" } })));
});

describe("GET /api/facts?tickers=", () => {
  it("dedupes, uppercases and drops invalid symbols", async () => {
    const res = await GET(new Request("http://t/api/facts?tickers=aapl,AAPL,msft,%24%24"));
    expect(res.status).toBe(200);
    expect(deps.getTickerFactsSlim).toHaveBeenCalledWith(["AAPL", "MSFT"]);
    expect((await res.json()).facts).toHaveLength(2);
  });

  it("caps a request at 50 tickers", async () => {
    const many = Array.from({ length: 60 }, (_, i) => `T${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`);
    await GET(new Request(`http://t/api/facts?tickers=${many.join(",")}`));
    expect(deps.getTickerFactsSlim.mock.calls[0][0].length).toBeLessThanOrEqual(50);
  });

  it("400s with no valid tickers", async () => {
    expect((await GET(new Request("http://t/api/facts"))).status).toBe(400);
  });

  it("honours the rate limit", async () => {
    deps.rateLimitGuard.mockResolvedValueOnce(NextResponse.json({}, { status: 429 }));
    expect((await GET(new Request("http://t/api/facts?tickers=AAPL"))).status).toBe(429);
  });
});
