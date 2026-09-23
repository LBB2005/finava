import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  createRun: vi.fn(),
  userRateLimit: vi.fn(),
  enabled: vi.fn(() => true),
  userId: "user_a",
}));

// The real schema is applied inside this mock, so the route's edge validation is
// exercised rather than stubbed away.
vi.mock("@/lib/withRoute", () => ({
  withRoute:
    (
      opts: { body?: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } },
      handler: (ctx: { req: Request; userId: string; body: unknown }, routeCtx?: unknown) => Promise<Response>
    ) =>
    async (req: Request, routeCtx?: unknown) => {
      let body: unknown;
      if (opts.body) {
        let raw: unknown;
        try {
          raw = await req.json();
        } catch {
          return NextResponse.json({ error: { code: "invalid_json" } }, { status: 400 });
        }
        const parsed = opts.body.safeParse(raw);
        if (!parsed.success) {
          return NextResponse.json({ error: { code: "validation_error" } }, { status: 400 });
        }
        body = parsed.data;
      }
      return handler({ req, userId: deps.userId, body }, routeCtx);
    },
}));
vi.mock("@/lib/rateLimit", () => ({ userRateLimit: deps.userRateLimit }));
vi.mock("@/lib/investment/jev/client", () => ({ investmentResearchEnabled: deps.enabled }));
vi.mock("@/lib/investment/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/investment/store")>()),
  createRun: deps.createRun,
}));

import { OwnershipError, RunConflictError } from "@/lib/investment/store";
import { POST } from "./route";

const MANDATE = {
  mode: "analyze",
  query: "Is AAPL worth owning for a year?",
  ticker: "aapl",
  horizon: {
    count: 12,
    unit: "calendar_months",
    assumed: false,
    targetDate: "2027-09-22",
    yearFraction: 1,
    note: null,
  },
  benchmark: "SPY",
  universeVersion: "universe_2026_09",
  hardFilter: null,
  qualitativeCriteria: [],
};

function post(body: unknown): Request {
  return new Request("http://t/api/investment/runs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.userId = "user_a";
  deps.enabled.mockReturnValue(true);
  deps.userRateLimit.mockResolvedValue(null);
  deps.createRun.mockResolvedValue({
    run: { id: "run_1", status: "pending", stage: "snapshot" },
    created: true,
  });
});

describe("POST /api/investment/runs", () => {
  it("creates a run and returns 201", async () => {
    const res = await POST(post({ mandate: MANDATE, idempotencyKey: "key-1" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ runId: "run_1", status: "pending", created: true });
  });

  it("uppercases the ticker before it becomes a path segment or a cache key", async () => {
    await POST(post({ mandate: MANDATE }));
    expect(deps.createRun.mock.calls[0][1].ticker).toBe("AAPL");
  });

  it("passes the idempotency key through so a retry gets the same run", async () => {
    deps.createRun.mockResolvedValue({
      run: { id: "run_1", status: "pending", stage: "snapshot" },
      created: false,
    });
    const res = await POST(post({ mandate: MANDATE, idempotencyKey: "key-1" }));
    expect(deps.createRun.mock.calls[0][2]).toBe("key-1");
    // 201 with created:false — a duplicate create is a success, which is the point.
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ runId: "run_1", created: false });
  });

  it.each([
    ["an analyze mandate with no ticker", { ...MANDATE, ticker: null }],
    ["a discover mandate carrying a ticker", { ...MANDATE, mode: "discover" }],
    ["a ticker that would address another collection", { ...MANDATE, ticker: "../user_b" }],
    ["an empty query", { ...MANDATE, query: "" }],
    ["an oversized query", { ...MANDATE, query: "x".repeat(2001) }],
    ["an unresolved horizon", { ...MANDATE, horizon: { ...MANDATE.horizon, count: 0 } }],
  ])("rejects %s", async (_label, mandate) => {
    expect((await POST(post({ mandate }))).status).toBe(400);
    expect(deps.createRun).not.toHaveBeenCalled();
  });

  it("rejects a supersedes id that is not a document id", async () => {
    expect((await POST(post({ mandate: MANDATE, supersedes: "../x" }))).status).toBe(400);
  });

  it("honours the rate limit", async () => {
    deps.userRateLimit.mockResolvedValue(NextResponse.json({}, { status: 429 }));
    expect((await POST(post({ mandate: MANDATE }))).status).toBe(429);
    expect(deps.createRun).not.toHaveBeenCalled();
  });

  it("409s a reused idempotency key with a different mandate", async () => {
    deps.createRun.mockRejectedValue(new RunConflictError("idempotency_key_reused", "reused"));
    const res = await POST(post({ mandate: MANDATE, idempotencyKey: "key-1" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("idempotency_key_reused");
  });

  it("403s an ownership violation", async () => {
    deps.createRun.mockRejectedValue(new OwnershipError("run_1"));
    expect((await POST(post({ mandate: MANDATE }))).status).toBe(403);
  });

  it("is inert with the feature flag off", async () => {
    deps.enabled.mockReturnValue(false);
    const res = await POST(post({ mandate: MANDATE }));
    expect(res.status).toBe(404);
    // Nothing was authenticated, rate-limited or written.
    expect(deps.createRun).not.toHaveBeenCalled();
    expect(deps.userRateLimit).not.toHaveBeenCalled();
  });
});
