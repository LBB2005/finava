import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  getSnapshots: vi.fn(),
  guardDataRoute: vi.fn(),
}));

vi.mock("@/lib/finnhub", () => ({ getSnapshots: deps.getSnapshots }));
vi.mock("@/lib/dataRouteGuard", () => ({ guardDataRoute: deps.guardDataRoute }));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FINNHUB_API_KEY = "fh_key";
  deps.guardDataRoute.mockResolvedValue({ userId: "u1" });
  deps.getSnapshots.mockResolvedValue([{ ticker: "AAPL", price: 200 }]);
});

describe("GET /api/quotes", () => {
  it("rate-limits before parsing/fetching and returns [] for no tickers", async () => {
    deps.guardDataRoute.mockResolvedValueOnce({ error: NextResponse.json({ error: "slow" }, { status: 429 }) });
    expect((await GET(new Request("http://test.local/api/quotes?tickers=AAPL"))).status).toBe(429);

    const res = await GET(new Request("http://test.local/api/quotes"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
    expect(deps.getSnapshots).not.toHaveBeenCalled();
  });

  it("rejects oversized batches and missing provider config", async () => {
    const many = Array.from({ length: 51 }, (_, i) => `T${i}`).join(",");
    expect((await GET(new Request(`http://test.local/api/quotes?tickers=${many}`))).status).toBe(400);

    delete process.env.FINNHUB_API_KEY;
    expect((await GET(new Request("http://test.local/api/quotes?tickers=AAPL"))).status).toBe(503);
  });

  it("fetches snapshots and handles provider errors", async () => {
    const res = await GET(new Request("http://test.local/api/quotes?tickers=aapl,msft"));
    expect(res.status).toBe(200);
    expect(deps.getSnapshots).toHaveBeenCalledWith(["AAPL", "MSFT"]);
    await expect(res.json()).resolves.toEqual([{ ticker: "AAPL", price: 200 }]);

    deps.getSnapshots.mockRejectedValueOnce(new Error("down"));
    expect((await GET(new Request("http://test.local/api/quotes?tickers=AAPL"))).status).toBe(500);
  });
});
