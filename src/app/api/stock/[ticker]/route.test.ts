import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  getStockBundle: vi.fn(),
  guardDataRoute: vi.fn(),
}));

vi.mock("@/lib/stockData", () => ({ getStockBundle: deps.getStockBundle }));
vi.mock("@/lib/dataRouteGuard", () => ({ guardDataRoute: deps.guardDataRoute }));

import { GET } from "./route";

const ctx = (ticker: string) => ({ params: Promise.resolve({ ticker }) });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FINNHUB_API_KEY = "fh_key";
  deps.guardDataRoute.mockResolvedValue({ userId: "u1" });
  deps.getStockBundle.mockResolvedValue({ ticker: "AAPL", quote: { price: 200 }, profile: { name: "Apple" } });
});

describe("GET /api/stock/[ticker]", () => {
  it("applies rate limits and validates ticker/provider configuration", async () => {
    deps.guardDataRoute.mockResolvedValueOnce({ error: NextResponse.json({ error: "slow" }, { status: 429 }) });
    expect((await GET(new Request("http://test.local"), ctx("AAPL"))).status).toBe(429);
    expect((await GET(new Request("http://test.local"), ctx("  "))).status).toBe(400);
    expect((await GET(new Request("http://test.local"), ctx("BAD!"))).status).toBe(400);

    delete process.env.FINNHUB_API_KEY;
    expect((await GET(new Request("http://test.local"), ctx("AAPL"))).status).toBe(503);
  });

  it("returns stock bundles, 404s unknown symbols, and 500s thrown lookups", async () => {
    const res = await GET(new Request("http://test.local"), ctx("aapl"));
    expect(res.status).toBe(200);
    expect(deps.getStockBundle).toHaveBeenCalledWith("AAPL");
    await expect(res.json()).resolves.toMatchObject({ ticker: "AAPL" });

    deps.getStockBundle.mockResolvedValueOnce({ quote: null, profile: null });
    expect((await GET(new Request("http://test.local"), ctx("NOPE"))).status).toBe(404);

    deps.getStockBundle.mockRejectedValueOnce(new Error("down"));
    expect((await GET(new Request("http://test.local"), ctx("AAPL"))).status).toBe(500);
  });
});
