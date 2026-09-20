import { beforeEach, describe, expect, it, vi } from "vitest";
import { tickerFactsFixture } from "@/test/factsFixture";
import { missing } from "@/lib/facts/types";

const deps = vi.hoisted(() => ({ guardDataRoute: vi.fn(), getTickerFacts: vi.fn() }));
vi.mock("@/lib/dataRouteGuard", () => ({ guardDataRoute: deps.guardDataRoute }));
vi.mock("@/lib/facts/ticker", () => ({ getTickerFacts: deps.getTickerFacts }));

import { GET } from "./route";
const ctx = (ticker: string) => ({ params: Promise.resolve({ ticker }) });

beforeEach(() => {
  vi.clearAllMocks();
  deps.guardDataRoute.mockResolvedValue({ userId: "u1" });
});

describe("GET /api/stock/[ticker]/score", () => {
  it("returns the canonical facts score, grade, pillars and as-of", async () => {
    const f = tickerFactsFixture("NVDA");
    deps.getTickerFacts.mockResolvedValue(f);
    const body = await (await GET(new Request("http://t"), ctx("nvda"))).json();
    expect(body).toEqual({
      ticker: "NVDA", score: f.score.value!.total, grade: f.score.value!.grade, pillars: f.score.value!.pillars,
      confidence: f.score.value!.confidence, asOf: f.score.asOf, version: f.score.value!.version, note: null,
    });
  });

  it("returns a null score with the note rather than a stand-in", async () => {
    deps.getTickerFacts.mockResolvedValue(tickerFactsFixture("SPY", { score: missing("Finava Score v2 (15 factors)", "No factor data available for this symbol", "2026-09-15") }));
    const res = await GET(new Request("http://t"), ctx("SPY"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.score).toBeNull();
    expect(body.grade).toBeNull();
    expect(body.note).toBe("No factor data available for this symbol");
  });

  it("400s a blank ticker and 502s a loader failure", async () => {
    expect((await GET(new Request("http://t"), ctx("  "))).status).toBe(400);
    deps.getTickerFacts.mockRejectedValueOnce(new Error("boom"));
    expect((await GET(new Request("http://t"), ctx("AAPL"))).status).toBe(502);
  });
});

// Regression: Next decodes route params, so `%26`/`%23`/`%2F` arrive as `&`/`#`/`/`
// and went straight into Finnhub query strings and the Polygon URL path.
describe("ticker validation", () => {
  it.each(["AAPL&X=1", "AAPL#", "../../V2/AGGS", "AAPL?TOKEN=X"])("400s on %s before any upstream call", async (t) => {
      const res = await GET(new Request("http://t"), ctx(t));
      expect(res.status).toBe(400);
      expect(deps.getTickerFacts).not.toHaveBeenCalled();
  });
});
