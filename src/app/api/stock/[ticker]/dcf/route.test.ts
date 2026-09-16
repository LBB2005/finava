// src/app/api/stock/[ticker]/dcf/route.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tickerFactsFixture } from "@/test/factsFixture";
import { missing } from "@/lib/facts/types";

const deps = vi.hoisted(() => ({ rateLimitGuard: vi.fn(), getTickerFacts: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ rateLimitGuard: deps.rateLimitGuard }));
vi.mock("@/lib/facts/ticker", () => ({ getTickerFacts: deps.getTickerFacts }));

import { GET } from "./route";
const ctx = (ticker: string) => ({ params: Promise.resolve({ ticker }) });

beforeEach(() => {
  vi.clearAllMocks();
  deps.rateLimitGuard.mockResolvedValue(null);
});

describe("GET /api/stock/[ticker]/dcf", () => {
  it("returns the canonical DCF inputs from facts", async () => {
    const f = tickerFactsFixture("AAPL");
    deps.getTickerFacts.mockResolvedValue(f);
    const res = await GET(new Request("http://t"), ctx("aapl"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticker: "AAPL", inputs: f.dcf.value!.inputs });
  });

  it("404s with the facts note when no DCF is available", async () => {
    deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("SPY", { dcf: missing("Finava DCF on SEC EDGAR filings", "No SEC filings for this symbol") }));
    const res = await GET(new Request("http://t"), ctx("SPY"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("DCF is unavailable for SPY (No SEC filings for this symbol).");
  });

  it("400s a blank ticker and 500s a loader failure", async () => {
    expect((await GET(new Request("http://t"), ctx(""))).status).toBe(400);
    deps.getTickerFacts.mockRejectedValueOnce(new Error("boom"));
    expect((await GET(new Request("http://t"), ctx("AAPL"))).status).toBe(500);
  });
});
