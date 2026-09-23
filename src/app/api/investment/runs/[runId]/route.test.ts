import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  readRun: vi.fn(),
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
  readRun: deps.readRun,
}));

import { OwnershipError, RunNotFoundError } from "@/lib/investment/store";
import { GET } from "./route";

const ctx = { params: Promise.resolve({ runId: "run_1" }) };
const req = () => new Request("http://t/api/investment/runs/run_1");

const RUN = {
  id: "run_1",
  status: "paused",
  stage: "valuation",
  reportId: null,
  snapshotId: "snap_1",
  gaps: ["finnhub.priceTarget: unauthorized"],
  creditsSpent: 37,
  error: null,
  supersedes: null,
  updatedAt: "2026-09-22T10:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  deps.userId = "user_a";
  deps.enabled.mockReturnValue(true);
  deps.userRateLimit.mockResolvedValue(null);
  deps.readRun.mockResolvedValue(RUN);
});

describe("GET /api/investment/runs/:runId", () => {
  it("returns status, stage, reportRef and gaps", async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      runId: "run_1",
      status: "paused",
      stage: "valuation",
      reportRef: null,
      gaps: ["finnhub.priceTarget: unauthorized"],
    });
  });

  it("resolves the report reference once a report exists", async () => {
    deps.readRun.mockResolvedValue({ ...RUN, reportId: "rep_1", status: "complete" });
    expect((await (await GET(req(), ctx)).json()).reportRef).toBe(
      "users/user_a/investmentReports/rep_1"
    );
  });

  it("reads the caller's own tree only", async () => {
    deps.userId = "user_b";
    await GET(req(), ctx);
    expect(deps.readRun).toHaveBeenCalledWith("user_b", "run_1");
  });

  // A GET must never cost money. Prefetchers, tab restores and refreshes all issue
  // GETs, so if reading advanced a stage, leaving a tab open would bill the user.
  it("advances nothing — it only reads", async () => {
    const runner = await import("@/lib/investment/runner");
    const spy = vi.spyOn(runner, "advanceRun");
    await GET(req(), ctx);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("404s a run in another account's tree", async () => {
    deps.readRun.mockRejectedValue(new RunNotFoundError("run_1"));
    expect((await GET(req(), ctx)).status).toBe(404);
  });

  it("403s a document whose stored owner disagrees with the path", async () => {
    deps.readRun.mockRejectedValue(new OwnershipError("run_1"));
    expect((await GET(req(), ctx)).status).toBe(403);
  });

  it("honours the rate limit", async () => {
    deps.userRateLimit.mockResolvedValue(NextResponse.json({}, { status: 429 }));
    expect((await GET(req(), ctx)).status).toBe(429);
    expect(deps.readRun).not.toHaveBeenCalled();
  });

  it("is inert with the feature flag off", async () => {
    deps.enabled.mockReturnValue(false);
    expect((await GET(req(), ctx)).status).toBe(404);
    expect(deps.readRun).not.toHaveBeenCalled();
    expect(deps.userRateLimit).not.toHaveBeenCalled();
  });
});
