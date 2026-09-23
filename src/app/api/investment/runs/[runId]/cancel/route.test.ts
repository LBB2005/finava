import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  userRateLimit: vi.fn(),
  enabled: vi.fn(() => true),
  userId: "user_a",
}));

vi.mock("@/lib/withRoute", () => ({
  withRoute:
    (
      _opts: unknown,
      handler: (ctx: { req: Request; userId: string; body: undefined }, routeCtx: unknown) => Promise<Response>
    ) =>
    async (req: Request, routeCtx: unknown) =>
      handler({ req, userId: deps.userId, body: undefined }, routeCtx),
}));
vi.mock("@/lib/rateLimit", () => ({ userRateLimit: deps.userRateLimit }));
vi.mock("@/lib/investment/jev/client", () => ({ investmentResearchEnabled: deps.enabled }));
vi.mock("@/lib/investment/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/investment/store")>()),
  cancelRun: deps.cancelRun,
}));

import { OwnershipError, RunConflictError, RunNotFoundError } from "@/lib/investment/store";
import { POST } from "./route";

const ctx = { params: Promise.resolve({ runId: "run_1" }) };
const req = () =>
  new Request("http://t/api/investment/runs/run_1/cancel", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  deps.userId = "user_a";
  deps.enabled.mockReturnValue(true);
  deps.userRateLimit.mockResolvedValue(null);
  deps.cancelRun.mockResolvedValue({ id: "run_1", status: "cancelled", stage: "valuation" });
});

describe("POST /api/investment/runs/:runId/cancel", () => {
  it("returns the cancelled status", async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ runId: "run_1", status: "cancelled" });
  });

  it("cancels only within the caller's own tree", async () => {
    deps.userId = "user_b";
    await POST(req(), ctx);
    expect(deps.cancelRun).toHaveBeenCalledWith("user_b", "run_1");
  });

  it("404s another account's run id", async () => {
    deps.cancelRun.mockRejectedValue(new RunNotFoundError("run_1"));
    expect((await POST(req(), ctx)).status).toBe(404);
  });

  it("403s a misfiled document", async () => {
    deps.cancelRun.mockRejectedValue(new OwnershipError("run_1"));
    expect((await POST(req(), ctx)).status).toBe(403);
  });

  it("409s an attempt to relabel a completed run", async () => {
    deps.cancelRun.mockRejectedValue(
      new RunConflictError("already_complete", "A completed run cannot be cancelled")
    );
    const res = await POST(req(), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("already_complete");
  });

  it("honours the rate limit", async () => {
    deps.userRateLimit.mockResolvedValue(NextResponse.json({}, { status: 429 }));
    expect((await POST(req(), ctx)).status).toBe(429);
    expect(deps.cancelRun).not.toHaveBeenCalled();
  });

  it("is inert with the feature flag off", async () => {
    deps.enabled.mockReturnValue(false);
    expect((await POST(req(), ctx)).status).toBe(404);
    expect(deps.cancelRun).not.toHaveBeenCalled();
    expect(deps.userRateLimit).not.toHaveBeenCalled();
  });
});
