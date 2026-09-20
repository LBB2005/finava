import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ getFactorUniverse: vi.fn(), guardDataRoute: vi.fn() }));
vi.mock("@/lib/factorUniverse", () => ({ getFactorUniverse: deps.getFactorUniverse }));
vi.mock("@/lib/dataRouteGuard", () => ({ guardDataRoute: deps.guardDataRoute }));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  deps.guardDataRoute.mockResolvedValue({ userId: "u1" });
});

describe("GET /api/research/factors", () => {
  // A cold compute walks ~500 names for up to 300 s; anonymous callers must not
  // be able to start one.
  it("refuses a caller the data-route guard rejects, before any compute", async () => {
    deps.guardDataRoute.mockResolvedValueOnce({ error: new Response(null, { status: 401 }) });
    const res = await GET();
    expect(res.status).toBe(401);
    expect(deps.getFactorUniverse).not.toHaveBeenCalled();
  });

  it("returns the shared factor universe", async () => {
    const universe = [{ ticker: "AAPL", f: { mom: 70 } }];
    deps.getFactorUniverse.mockResolvedValueOnce(universe);

    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(universe);
  });

  it("takes no arguments — the memo lives in the lib, shared with the discovery scout", async () => {
    deps.getFactorUniverse.mockResolvedValueOnce([]);
    await GET();
    expect(deps.getFactorUniverse).toHaveBeenCalledWith();
  });

  it("500s (without leaking the cause) on an unexpected failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    deps.getFactorUniverse.mockRejectedValueOnce(new Error("polygon down"));

    const res = await GET();
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to compute factor universe" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
