import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  getStockCandles: vi.fn(),
  guardDataRoute: vi.fn(),
}));

vi.mock("@/lib/dataRouteGuard", () => ({ guardDataRoute: deps.guardDataRoute }));

vi.mock("@/lib/stockData", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stockData")>("@/lib/stockData");
  return { ...actual, getStockCandles: deps.getStockCandles };
});

import { GET } from "./route";

const ctx = (ticker: string) => ({ params: Promise.resolve({ ticker }) });

beforeEach(() => {
  vi.clearAllMocks();
  deps.guardDataRoute.mockResolvedValue({ userId: "u1" });
  process.env.FINNHUB_API_KEY = "fh_key";
  deps.getStockCandles.mockResolvedValue({ s: "ok", c: [1], o: [1], h: [1], l: [1], v: [1], t: [1] });
});

describe("GET /api/stock/[ticker]/candles", () => {
  it("validates ticker, range, and provider config", async () => {
    expect((await GET(new Request("http://test.local?range=1D"), ctx("  "))).status).toBe(400);
    expect((await GET(new Request("http://test.local?range=BAD"), ctx("AAPL"))).status).toBe(400);

    delete process.env.FINNHUB_API_KEY;
    expect((await GET(new Request("http://test.local?range=1D"), ctx("AAPL"))).status).toBe(503);
  });

  it("returns candle data and handles fetch failures", async () => {
    const res = await GET(new Request("http://test.local?range=1M"), ctx("aapl"));
    expect(res.status).toBe(200);
    expect(deps.getStockCandles).toHaveBeenCalledWith("AAPL", "1M");
    await expect(res.json()).resolves.toEqual({
      range: "1M",
      candles: { s: "ok", c: [1], o: [1], h: [1], l: [1], v: [1], t: [1] },
    });

    deps.getStockCandles.mockRejectedValueOnce(new Error("down"));
    expect((await GET(new Request("http://test.local?range=1D"), ctx("AAPL"))).status).toBe(500);
  });
});

// Regression: Next decodes route params, so `%26`/`%23`/`%2F` arrive as `&`/`#`/`/`
// and went straight into Finnhub query strings and the Polygon URL path.
describe("ticker validation", () => {
  it.each(["AAPL&X=1", "AAPL#", "../../V2/AGGS", "AAPL?TOKEN=X"])("400s on %s before any upstream call", async (t) => {
      const res = await GET(new Request("http://test.local?range=1D"), ctx(t));
      expect(res.status).toBe(400);
      expect(deps.getStockCandles).not.toHaveBeenCalled();
  });
});
