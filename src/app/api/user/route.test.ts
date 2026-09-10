import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getUser: vi.fn(),
  updateUser: vi.fn(),
  settingsGet: vi.fn(),
  settingsSet: vi.fn(),
  conversationsGet: vi.fn(),
  briefingsGet: vi.fn(),
  resolvePlan: vi.fn(),
  capabilitiesFor: vi.fn(),
  sanitizeAppearance: vi.fn(),
}));

vi.mock("@/lib/requireAuth", () => ({ requireAuth: deps.requireAuth }));
vi.mock("@/lib/plans", () => ({ TRIAL_DAYS: 3 }));
vi.mock("@/lib/entitlements", () => ({
  resolvePlan: deps.resolvePlan,
  capabilitiesFor: deps.capabilitiesFor,
}));
vi.mock("@/lib/appearance", () => ({ sanitizeAppearance: deps.sanitizeAppearance }));
vi.mock("@/lib/firebase-admin", () => ({
  adminAuth: {
    getUser: deps.getUser,
    updateUser: deps.updateUser,
  },
  db: {
    collection: vi.fn((name: string) => ({
      doc: vi.fn(() => {
        if (name === "userSettings") {
          return { get: deps.settingsGet, set: deps.settingsSet };
        }
        if (name === "users") {
          return {
            collection: vi.fn((sub: string) => ({
              select: vi.fn(() => ({
                get: sub === "conversations" ? deps.conversationsGet : deps.briefingsGet,
              })),
            })),
          };
        }
        return { get: vi.fn(), set: vi.fn() };
      }),
    })),
  },
}));

import { GET, PATCH } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
  deps.requireAuth.mockResolvedValue({ userId: "user_123" });
  deps.getUser.mockResolvedValue({
    uid: "user_123",
    displayName: "Liam",
    email: "liam@example.com",
    photoURL: "https://example.com/liam.png",
    metadata: {
      creationTime: "2026-01-01T00:00:00Z",
      lastSignInTime: "2026-06-15T10:00:00Z",
    },
  });
  deps.settingsGet.mockResolvedValue({
    exists: true,
    data: () => ({
      allowDataTraining: false,
      locationMetadata: false,
      appearance: { theme: "dark" },
      currentPeriodEnd: "2026-07-01T00:00:00Z",
      cancelAtPeriodEnd: true,
    }),
  });
  deps.conversationsGet.mockResolvedValue({ size: 7 });
  deps.briefingsGet.mockResolvedValue({ size: 2 });
  deps.resolvePlan.mockResolvedValue({
    plan: "Pro",
    source: "stripe",
    subscriptionStatus: "active",
    trialEndsAt: null,
  });
  deps.capabilitiesFor.mockReturnValue({ maxWatchlist: 100 });
  deps.sanitizeAppearance.mockReturnValue({ theme: "dark", density: "compact" });
});

describe("GET /api/user", () => {
  it("short-circuits auth failures before reading account data", async () => {
    deps.requireAuth.mockResolvedValueOnce({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const res = await GET();

    expect(res.status).toBe(401);
    expect(deps.getUser).not.toHaveBeenCalled();
    expect(deps.settingsGet).not.toHaveBeenCalled();
  });

  it("returns profile, entitlement, settings, and usage stats", async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    expect(deps.resolvePlan).toHaveBeenCalledWith("user_123");
    expect(deps.capabilitiesFor).toHaveBeenCalledWith("Pro");
    await expect(res.json()).resolves.toMatchObject({
      uid: "user_123",
      name: "Liam",
      email: "liam@example.com",
      plan: "Pro",
      planSource: "stripe",
      subscriptionStatus: "active",
      currentPeriodEnd: "2026-07-01T00:00:00Z",
      cancelAtPeriodEnd: true,
      capabilities: { maxWatchlist: 100 },
      allowDataTraining: false,
      locationMetadata: false,
      appearance: { theme: "dark" },
      stats: { conversations: 7, briefings: 2 },
    });
  });

  it("stamps a first-touch trial for unpaid users exactly once", async () => {
    deps.settingsGet.mockResolvedValueOnce({ exists: true, data: () => ({}) });

    await GET();

    expect(deps.settingsSet).toHaveBeenCalledWith(
      { trialEndsAt: "2026-06-18T12:00:00.000Z", trialInitialized: true },
      { merge: true }
    );

    deps.settingsSet.mockClear();
    deps.settingsGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ trialInitialized: true }),
    });

    await GET();

    expect(deps.settingsSet).not.toHaveBeenCalled();
  });

  it("does not stamp trials for paid active users", async () => {
    deps.settingsGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ plan: "Pro", subscriptionStatus: "past_due" }),
    });

    await GET();

    expect(deps.settingsSet).not.toHaveBeenCalled();
  });

  it("returns a stable 500 response on profile lookup failures", async () => {
    deps.getUser.mockRejectedValueOnce(new Error("auth down"));

    const res = await GET();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to load user" });
  });
});

describe("PATCH /api/user", () => {
  it("updates only client-writable settings and display name", async () => {
    const req = new Request("http://localhost/api/user", {
      method: "PATCH",
      body: JSON.stringify({
        displayName: "Finava User",
        allowDataTraining: true,
        locationMetadata: false,
        plan: "Enterprise",
        appearance: { theme: "purple", density: "compact" },
      }),
    });

    const res = await PATCH(req);

    expect(res.status).toBe(200);
    expect(deps.updateUser).toHaveBeenCalledWith("user_123", { displayName: "Finava User" });
    expect(deps.sanitizeAppearance).toHaveBeenCalledWith({ theme: "purple", density: "compact" });
    expect(deps.settingsSet).toHaveBeenCalledWith(
      {
        allowDataTraining: true,
        locationMetadata: false,
        appearance: { theme: "dark", density: "compact" },
      },
      { merge: true }
    );
    expect(JSON.stringify(deps.settingsSet.mock.calls[0][0])).not.toContain("Enterprise");
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("persists the notification preferences it offers in Settings", async () => {
    // These toggles used to be local component state that silently reverted.
    const res = await PATCH(new Request("http://localhost/api/user", {
      method: "PATCH",
      body: JSON.stringify({ notifyWeeklyBriefing: false, notifyProductUpdates: true }),
    }));

    expect(res.status).toBe(200);
    expect(deps.settingsSet).toHaveBeenCalledWith(
      { notifyWeeklyBriefing: false, notifyProductUpdates: true },
      { merge: true }
    );
  });

  it("skips empty sanitized appearance updates", async () => {
    deps.sanitizeAppearance.mockReturnValueOnce({});

    const res = await PATCH(new Request("http://localhost/api/user", {
      method: "PATCH",
      body: JSON.stringify({ appearance: { unsafe: true } }),
    }));

    expect(res.status).toBe(200);
    expect(deps.settingsSet).not.toHaveBeenCalled();
  });

  it("returns auth and failure responses without leaking internals", async () => {
    deps.requireAuth.mockResolvedValueOnce({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    expect((await PATCH(new Request("http://localhost/api/user", { method: "PATCH" }))).status).toBe(401);

    deps.updateUser.mockRejectedValueOnce(new Error("auth write failed"));
    const res = await PATCH(new Request("http://localhost/api/user", {
      method: "PATCH",
      body: JSON.stringify({ displayName: "Boom" }),
    }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to update user" });
  });
});
