import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  getBoardData: vi.fn(),
  rateLimitGuard: vi.fn(),
}));

vi.mock("@/lib/leaderboardData", () => ({ getBoardData: deps.getBoardData }));
vi.mock("@/lib/rateLimit", () => ({ rateLimitGuard: deps.rateLimitGuard }));
vi.mock("@/lib/extraUniverse", () => ({
  ALL_CONSTITUENTS: [{ ticker: "AAPL" }, { ticker: "MSFT" }],
}));
vi.mock("@/lib/tickers", () => ({
  parseTickersParam: (s: string) => (s ? s.split(",").filter(Boolean) : []),
}));

import { GET } from "./route";

function req(qs = "") {
  return new Request(`http://test.local/api/leaderboard${qs}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.rateLimitGuard.mockResolvedValue(null); // allow by default
  deps.getBoardData.mockResolvedValue([{ ticker: "AAPL", price: 1 }]);
});

describe("GET /api/leaderboard", () => {
  it("returns the limiter response when throttled", async () => {
    const limited = new Response("rate limited", { status: 429 });
    deps.rateLimitGuard.mockResolvedValueOnce(limited);
    const res = await GET(req());
    expect(res.status).toBe(429);
    expect(deps.getBoardData).not.toHaveBeenCalled();
  });

  it("400s when more than the max tickers are requested", async () => {
    const many = Array.from({ length: 601 }, (_, i) => `T${i}`).join(",");
    const res = await GET(req(`?tickers=${many}`));
    expect(res.status).toBe(400);
    expect(deps.getBoardData).not.toHaveBeenCalled();
  });

  it("defaults to the seed universe when no tickers are supplied", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ rows: [{ ticker: "AAPL", price: 1 }] });
    expect(deps.getBoardData).toHaveBeenCalledWith(["AAPL", "MSFT"]);
  });

  it("uses the explicit ticker list when provided", async () => {
    await GET(req("?tickers=NVDA,TSLA"));
    expect(deps.getBoardData).toHaveBeenCalledWith(["NVDA", "TSLA"]);
  });

  it("500s when the data layer throws", async () => {
    deps.getBoardData.mockRejectedValueOnce(new Error("down"));
    const res = await GET(req());
    expect(res.status).toBe(500);
  });
});
