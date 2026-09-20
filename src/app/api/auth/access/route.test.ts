import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({ requireAuth: vi.fn() }));
vi.mock("@/lib/requireAuth", () => ({ requireAuth: deps.requireAuth }));

import { GET } from "./route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/auth/access", () => {
  it("answers 200 for an allowed account", async () => {
    deps.requireAuth.mockResolvedValue({ userId: "u1" });
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("passes the private-beta 403 through unchanged, so the client can bounce the user", async () => {
    deps.requireAuth.mockResolvedValue({
      error: NextResponse.json({ error: "Private beta" }, { status: 403 }),
    });
    const res = await GET();
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Private beta" });
  });

  it("401s without a valid session", async () => {
    deps.requireAuth.mockResolvedValue({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    expect((await GET()).status).toBe(401);
  });
});
