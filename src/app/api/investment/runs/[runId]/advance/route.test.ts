import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  advanceRun: vi.fn(),
  loadStages: vi.fn(),
  readRun: vi.fn(),
  readStageResult: vi.fn(),
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
vi.mock("@/lib/investment/runner", async (orig) => ({
  ...(await orig<typeof import("@/lib/investment/runner")>()),
  advanceRun: deps.advanceRun,
  loadStages: deps.loadStages,
}));
vi.mock("@/lib/investment/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/investment/store")>()),
  readRun: deps.readRun,
  readStageResult: deps.readStageResult,
}));

import { OwnershipError, RunNotFoundError } from "@/lib/investment/store";
import { POST } from "./route";

const ctx = { params: Promise.resolve({ runId: "run_1" }) };

function req(body?: unknown): Request {
  return new Request("http://t/api/investment/runs/run_1/advance", {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const RUN = { id: "run_1", status: "paused", stage: "research", gaps: [], reportId: null };

beforeEach(() => {
  vi.clearAllMocks();
  deps.userId = "user_a";
  deps.enabled.mockReturnValue(true);
  deps.userRateLimit.mockResolvedValue(null);
  deps.loadStages.mockResolvedValue({ snapshot: vi.fn() });
  deps.readRun.mockResolvedValue(RUN);
  deps.readStageResult.mockResolvedValue(null);
  deps.advanceRun.mockResolvedValue({
    kind: "advanced",
    run: { ...RUN, stage: "valuation", status: "paused", gaps: ["sec.revenue: rate_limited"] },
    stage: "research",
    result: { claims: [] },
    credits: 20,
  });
});

describe("POST /api/investment/runs/:runId/advance", () => {
  it("returns the stored stage result", async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      runId: "run_1",
      stage: "research",
      status: "paused",
      replayed: false,
      result: { claims: [] },
      credits: 20,
      gaps: ["sec.revenue: rate_limited"],
    });
  });

  it("works with no request body at all", async () => {
    expect((await POST(req(), ctx)).status).toBe(200);
    expect(deps.advanceRun).toHaveBeenCalledTimes(1);
  });

  it("hands the request's abort signal to the runner so a disconnect stops providers", async () => {
    await POST(req(), ctx);
    expect(deps.advanceRun.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
  });

  it("advances only the caller's own run", async () => {
    deps.userId = "user_b";
    await POST(req(), ctx);
    expect(deps.advanceRun.mock.calls[0][0]).toBe("user_b");
  });

  it("returns a replay without charging when the run is already past the stage", async () => {
    deps.readRun.mockResolvedValue({ ...RUN, stage: "valuation" });
    deps.readStageResult.mockResolvedValue({
      stage: "research",
      result: { claims: [] },
      credits: 20,
      completedAt: "2026-09-22T09:00:00Z",
    });
    const res = await POST(req({ expectedStage: "research" }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stage: "research", replayed: true });
    // The whole point: a retried request must not pay for the NEXT stage.
    expect(deps.advanceRun).not.toHaveBeenCalled();
  });

  it("409s when the expected stage is neither current nor stored", async () => {
    deps.readRun.mockResolvedValue({ ...RUN, stage: "valuation" });
    const res = await POST(req({ expectedStage: "decision" }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("stage_mismatch");
    expect(deps.advanceRun).not.toHaveBeenCalled();
  });

  it("advances when the expected stage matches", async () => {
    expect((await POST(req({ expectedStage: "research" }), ctx)).status).toBe(200);
    expect(deps.advanceRun).toHaveBeenCalledTimes(1);
  });

  it("400s an unknown stage name", async () => {
    expect((await POST(req({ expectedStage: "nonsense" }), ctx)).status).toBe(400);
    expect(deps.advanceRun).not.toHaveBeenCalled();
  });

  it("503s rather than pretending progress when no stages are wired", async () => {
    deps.loadStages.mockResolvedValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("stages_not_wired");
    expect(deps.advanceRun).not.toHaveBeenCalled();
  });

  it.each([
    ["lease_held", { kind: "lease_held", run: RUN, leaseUntil: "2026-09-22T10:02:00Z" }, 409, "lease_held"],
    ["a cancelled run", { kind: "cancelled", run: { ...RUN, status: "cancelled" } }, 409, "run_cancelled"],
    ["a failed run", { kind: "failed", run: { ...RUN, status: "failed", error: "boom" } }, 409, "run_failed"],
    [
      "a spend ceiling",
      { kind: "budget_exceeded", run: RUN, scope: "run", spent: 1600, cap: 1500 },
      429,
      "budget_exceeded",
    ],
    [
      "an unconfirmable provider outcome",
      { kind: "uncertain", run: RUN, stage: "research", detail: "timeout", attempts: 1 },
      502,
      "stage_uncertain",
    ],
  ])("maps %s to the right status", async (_label, outcome, status, code) => {
    deps.advanceRun.mockResolvedValue(outcome);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
  });

  it("returns the report reference once the run is complete", async () => {
    deps.advanceRun.mockResolvedValue({
      kind: "complete",
      run: { ...RUN, stage: "complete", status: "complete", reportId: "rep_1" },
    });
    expect(await (await POST(req(), ctx)).json()).toMatchObject({
      stage: "complete",
      status: "complete",
      reportRef: "users/user_a/investmentReports/rep_1",
    });
  });

  it("404s another account's run id", async () => {
    deps.advanceRun.mockRejectedValue(new RunNotFoundError("run_1"));
    expect((await POST(req(), ctx)).status).toBe(404);
  });

  it("403s a misfiled document", async () => {
    deps.advanceRun.mockRejectedValue(new OwnershipError("run_1"));
    expect((await POST(req(), ctx)).status).toBe(403);
  });

  it("honours the rate limit before any stage is considered", async () => {
    deps.userRateLimit.mockResolvedValue(NextResponse.json({}, { status: 429 }));
    expect((await POST(req(), ctx)).status).toBe(429);
    expect(deps.loadStages).not.toHaveBeenCalled();
    expect(deps.advanceRun).not.toHaveBeenCalled();
  });

  it("is inert with the feature flag off", async () => {
    deps.enabled.mockReturnValue(false);
    expect((await POST(req(), ctx)).status).toBe(404);
    expect(deps.advanceRun).not.toHaveBeenCalled();
    expect(deps.loadStages).not.toHaveBeenCalled();
    expect(deps.userRateLimit).not.toHaveBeenCalled();
  });
});
