import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  userRateLimit: vi.fn(),
}));

vi.mock("@/lib/requireAuth", () => ({ requireAuth: deps.requireAuth }));
vi.mock("@/lib/rateLimit", () => ({ userRateLimit: deps.userRateLimit }));

import { guardDataRoute } from "./dataRouteGuard";

beforeEach(() => {
  vi.clearAllMocks();
  deps.userRateLimit.mockResolvedValue(null);
});

describe("guardDataRoute", () => {
  it("rejects an anonymous caller before spending any rate-limit or upstream budget", async () => {
    deps.requireAuth.mockResolvedValue({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const gate = await guardDataRoute("quotes");

    expect(gate.error?.status).toBe(401);
    expect(deps.userRateLimit).not.toHaveBeenCalled();
  });

  it("rate-limits per user, passing the route's limits through", async () => {
    deps.requireAuth.mockResolvedValue({ userId: "u1" });
    const opts = { capacity: 10, refillPerSec: 0.2 };

    const gate = await guardDataRoute("leaderboard", opts);

    expect(gate).toEqual({ userId: "u1" });
    expect(deps.userRateLimit).toHaveBeenCalledWith("u1", "leaderboard", opts);
  });

  it("returns the 429 when the user is over their limit", async () => {
    deps.requireAuth.mockResolvedValue({ userId: "u1" });
    deps.userRateLimit.mockResolvedValue(
      NextResponse.json({ error: "Too many requests" }, { status: 429 })
    );

    const gate = await guardDataRoute("quotes");

    expect(gate.error?.status).toBe(429);
    expect(gate.userId).toBeUndefined();
  });
});
