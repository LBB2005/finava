// Step 4 — narrow the universe to a shortlist using the SAME scout the chat
// Discover mode calls. The properties worth pinning: the standing query is fixed
// (a per-day rewrite would be an unrecorded degree of freedom), and a clarify
// request fails the step loudly rather than being answered.
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  runStepFn: vi.fn(),
  runScoutAgent: vi.fn(),
  planWaves: vi.fn(),
  first: vi.fn(),
}));

vi.mock("@/lib/live/harness", () => ({
  withHarness: (h: (req: Request) => Promise<Response>) => h,
  easternDay: () => "2026-08-31",
  runStep: async (_runId: string, _step: string, fn: () => Promise<unknown>) => {
    const replayed = await deps.runStepFn();
    if (replayed) return { result: replayed, replayed: true };
    return { result: await fn(), replayed: false };
  },
}));
vi.mock("@/agents/sub-agents/scout-agent", () => ({ runScoutAgent: deps.runScoutAgent }));
vi.mock("@/lib/discoveryRun", () => ({ planWaves: deps.planWaves }));
vi.mock("@/lib/live/collect", () => ({
  collector: () => ({ emit: vi.fn(), collected: { first: deps.first, events: [] } }),
}));

import { POST, STANDING_QUERY, SHORTLIST_SIZE } from "./route";

const req = (body?: unknown) =>
  new Request("http://test.local/api/live/discover/scout", {
    method: "POST",
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

async function scout(body?: unknown) {
  const res = await POST(req(body));
  return { status: res.status, json: await res.json() };
}

const PICKS = [{ ticker: "AAPL" }, { ticker: "MSFT" }];

beforeEach(() => {
  vi.clearAllMocks();
  deps.runStepFn.mockResolvedValue(null);
  deps.runScoutAgent.mockResolvedValue(undefined);
  deps.planWaves.mockReturnValue([{ tickers: ["AAPL"] }, { tickers: ["MSFT"] }]);
  deps.first.mockImplementation((type: string) =>
    type === "deep_shortlist" ? { interpretation: "Quality at a discount", picks: PICKS } : null,
  );
});

describe("POST /api/live/discover/scout", () => {
  it("returns the shortlist and the planned wave count", async () => {
    const { status, json } = await scout();
    expect(status).toBe(200);
    expect(json).toMatchObject({
      runId: "2026-08-31",
      tradingDay: "2026-08-31",
      query: STANDING_QUERY,
      interpretation: "Quality at a discount",
      picks: PICKS,
      totalWaves: 2,
    });
  });

  it("runs the shared scout at the deep tier with the standing query", async () => {
    await scout();
    expect(deps.runScoutAgent).toHaveBeenCalledWith(
      { query: STANDING_QUERY, tier: "deep", limit: SHORTLIST_SIZE },
      expect.any(Function),
    );
  });

  it("keeps the standing query fixed and stated in the result", async () => {
    expect(STANDING_QUERY).toContain("US-listed companies");
    const { json } = await scout();
    expect(json.query).toBe(STANDING_QUERY);
  });

  it("allows an explicit query override for a manual run", async () => {
    const { json } = await scout({ query: "Beaten-down semis" });
    expect(json.query).toBe("Beaten-down semis");
    expect(deps.runScoutAgent).toHaveBeenCalledWith(
      { query: "Beaten-down semis", tier: "deep", limit: SHORTLIST_SIZE },
      expect.any(Function),
    );
  });

  it("plans the waves from the scout's own picks", async () => {
    await scout();
    expect(deps.planWaves).toHaveBeenCalledWith(PICKS);
  });

  it("400s an invalid body", async () => {
    expect((await scout({ runId: "" })).status).toBe(400);
    expect((await scout({ query: "" })).status).toBe(400);
    expect((await scout({ query: "q".repeat(501) })).status).toBe(400);
  });

  it("treats an unparseable body as empty", async () => {
    expect((await scout("{not json")).status).toBe(200);
  });

  it("honours an explicit runId", async () => {
    expect((await scout({ runId: "manual-1" })).json.runId).toBe("manual-1");
  });

  it("fails loudly when the scout asks to clarify a FIXED query", async () => {
    deps.first.mockImplementation((type: string) =>
      type === "discover_clarify" ? { questions: [{ header: "Style", question: "Which sector?", options: [] }] } : null,
    );
    await expect(POST(req())).rejects.toThrow(/the query needs fixing, not answering: Which sector\?/);
  });

  it("fails when the scout produced no shortlist at all", async () => {
    deps.first.mockReturnValue(null);
    await expect(POST(req())).rejects.toThrow("Scout produced no shortlist");
  });

  it("returns the stored result on a replay without re-running the scout", async () => {
    deps.runStepFn.mockResolvedValueOnce({ runId: "2026-08-31", picks: PICKS, totalWaves: 2 });
    const { json } = await scout();
    expect(json.replayed).toBe(true);
    expect(deps.runScoutAgent).not.toHaveBeenCalled();
  });
});
