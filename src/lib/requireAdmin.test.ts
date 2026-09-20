import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/requireAuth", () => ({ requireAuth: deps.requireAuth }));

import { requireAdmin } from "./requireAdmin";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireAdmin", () => {
  it("passes through authentication errors", async () => {
    deps.requireAuth.mockResolvedValueOnce({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const result = await requireAdmin();

    expect(result.userId).toBeUndefined();
    expect(result.error?.status).toBe(401);
  });

  it("allows configured operators after trimming OWNER_UIDS", async () => {
    vi.stubEnv("OWNER_UIDS", " other-user, user_123 ");
    deps.requireAuth.mockResolvedValueOnce({ userId: "user_123" });

    await expect(requireAdmin()).resolves.toEqual({ userId: "user_123" });
  });

  // Regression: the admin tools used to accept the tester allowlist, so every
  // beta tester could lift their own plan cap, mail the waitlist, and drive the
  // Live harness. Beta access must never imply operator access.
  it("refuses a tester allowlisted by UID who is not an operator", async () => {
    vi.stubEnv("ADMIN_UIDS", "tester_uid");
    vi.stubEnv("OWNER_UIDS", "owner_uid");
    deps.requireAuth.mockResolvedValueOnce({ userId: "tester_uid" });

    const blocked = await requireAdmin();
    expect(blocked.error?.status).toBe(403);
  });

  it("fails closed when OWNER_UIDS is unset, even for ADMIN_UIDS members", async () => {
    vi.stubEnv("ADMIN_UIDS", "user_123");
    vi.stubEnv("OWNER_UIDS", "");
    deps.requireAuth.mockResolvedValueOnce({ userId: "user_123" });

    const blocked = await requireAdmin();
    expect(blocked.error?.status).toBe(403);
  });

  it("allows the dev user outside production and blocks non-admins", async () => {
    deps.requireAuth.mockResolvedValueOnce({ userId: "dev-user" });
    await expect(requireAdmin()).resolves.toEqual({ userId: "dev-user" });

    deps.requireAuth.mockResolvedValueOnce({ userId: "regular-user" });
    const blocked = await requireAdmin();

    expect(blocked.error?.status).toBe(403);
    await expect(blocked.error?.json()).resolves.toEqual({ error: "Forbidden" });
  });
});
