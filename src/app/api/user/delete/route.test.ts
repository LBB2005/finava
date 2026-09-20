import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getUser: vi.fn(),
  deleteUser: vi.fn(),
  revokeRefreshTokens: vi.fn(),
  itemRemove: vi.fn(),
  plaidConfigured: vi.fn(),
  stripeConfigured: vi.fn(),
  subscriptionsList: vi.fn(),
  subscriptionsCancel: vi.fn(),
  plaidItemsGet: vi.fn(),
  settingsGet: vi.fn(),
  settingsDelete: vi.fn(),
  usageDelete: vi.fn(),
  waitlistDelete: vi.fn(),
  sharesGet: vi.fn(),
  memoryGet: vi.fn(),
  deleteRefsInBatches: vi.fn(),
  recursiveDelete: vi.fn(),
}));

vi.mock("@/lib/requireAuth", () => ({ requireAuth: deps.requireAuth }));
vi.mock("@/lib/plaid", () => ({
  plaidConfigured: deps.plaidConfigured,
  plaidClient: { itemRemove: deps.itemRemove },
}));
vi.mock("@/lib/stripe", () => ({
  stripeConfigured: deps.stripeConfigured,
  stripe: {
    subscriptions: {
      list: deps.subscriptionsList,
      cancel: deps.subscriptionsCancel,
    },
  },
}));
vi.mock("@/lib/firebase-admin", () => ({
  deleteRefsInBatches: deps.deleteRefsInBatches,
  adminAuth: {
    getUser: deps.getUser,
    deleteUser: deps.deleteUser,
    revokeRefreshTokens: deps.revokeRefreshTokens,
  },
  db: {
    recursiveDelete: deps.recursiveDelete,
    collection: vi.fn((name: string) => ({
      doc: vi.fn((id: string) => {
        if (name === "users") {
          return {
            id,
            path: `${name}/${id}`,
            collection: vi.fn(() => ({ get: deps.plaidItemsGet })),
          };
        }
        if (name === "userSettings") return { get: deps.settingsGet, delete: deps.settingsDelete };
        if (name === "userUsage") return { delete: deps.usageDelete };
        if (name === "waitlist") return { delete: deps.waitlistDelete };
        return { delete: vi.fn() };
      }),
      where: vi.fn(() => ({ get: name === "tickerMemory" ? deps.memoryGet : deps.sharesGet })),
    })),
  },
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  deps.memoryGet.mockResolvedValue({ docs: [] });
  deps.deleteRefsInBatches.mockResolvedValue(undefined);
  deps.requireAuth.mockResolvedValue({ userId: "user_123" });
  deps.getUser.mockResolvedValue({ email: "liam@example.com" });
  deps.plaidConfigured.mockReturnValue(true);
  deps.stripeConfigured.mockReturnValue(true);
  deps.plaidItemsGet.mockResolvedValue({
    docs: [
      { data: () => ({ accessToken: "access-good" }) },
      { data: () => ({}) },
    ],
  });
  deps.settingsGet.mockResolvedValue({ data: () => ({ stripeCustomerId: "cus_123" }) });
  deps.subscriptionsList.mockResolvedValue({ data: [{ id: "sub_1" }, { id: "sub_2" }] });
  deps.sharesGet.mockResolvedValue({ docs: [{ ref: { path: "shares/share_1" } }] });
  deps.itemRemove.mockResolvedValue({});
  deps.subscriptionsCancel.mockResolvedValue({});
  deps.recursiveDelete.mockResolvedValue({});
  deps.settingsDelete.mockResolvedValue({});
  deps.usageDelete.mockResolvedValue({});
  deps.waitlistDelete.mockResolvedValue({});
  deps.deleteUser.mockResolvedValue({});
  deps.revokeRefreshTokens.mockResolvedValue(undefined);
});

describe("POST /api/user/delete", () => {
  it("short-circuits auth errors before touching external services", async () => {
    deps.requireAuth.mockResolvedValueOnce({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const res = await POST();

    expect(res.status).toBe(401);
    expect(deps.itemRemove).not.toHaveBeenCalled();
    expect(deps.subscriptionsList).not.toHaveBeenCalled();
    expect(deps.recursiveDelete).not.toHaveBeenCalled();
  });

  it("revokes linked services, deletes Firestore data, cleans waitlist, and removes Auth user", async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    expect(deps.itemRemove).toHaveBeenCalledWith({ access_token: "access-good" });
    expect(deps.subscriptionsList).toHaveBeenCalledWith({ customer: "cus_123", limit: 10 });
    expect(deps.subscriptionsCancel).toHaveBeenCalledTimes(2);
    expect(deps.recursiveDelete).toHaveBeenCalledWith(expect.objectContaining({ path: "users/user_123" }));
    expect(deps.recursiveDelete).toHaveBeenCalledWith({ path: "shares/share_1" });
    expect(deps.settingsDelete).toHaveBeenCalled();
    expect(deps.usageDelete).toHaveBeenCalled();
    expect(deps.waitlistDelete).toHaveBeenCalled();
    expect(deps.deleteUser).toHaveBeenCalledWith("user_123");
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("continues through best-effort Plaid, Stripe, waitlist, and missing-auth failures", async () => {
    deps.itemRemove.mockRejectedValueOnce(new Error("plaid down"));
    deps.subscriptionsList.mockRejectedValueOnce(new Error("stripe down"));
    deps.waitlistDelete.mockRejectedValueOnce(new Error("waitlist down"));
    deps.deleteUser.mockRejectedValueOnce({ code: "auth/user-not-found" });

    const res = await POST();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("skips optional provider cleanup when providers are unconfigured", async () => {
    deps.plaidConfigured.mockReturnValueOnce(false);
    deps.stripeConfigured.mockReturnValueOnce(false);
    deps.getUser.mockRejectedValueOnce(new Error("missing auth user"));

    const res = await POST();

    expect(res.status).toBe(200);
    expect(deps.plaidItemsGet).not.toHaveBeenCalled();
    expect(deps.subscriptionsList).not.toHaveBeenCalled();
    expect(deps.waitlistDelete).not.toHaveBeenCalled();
  });

  it("returns a stable failure when required data deletion fails", async () => {
    deps.recursiveDelete.mockRejectedValueOnce(new Error("firestore down"));

    const res = await POST();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to delete account" });
  });

  it("revokes the caller's outstanding sessions before erasing their data", async () => {
    const order: string[] = [];
    deps.revokeRefreshTokens.mockImplementationOnce(async () => { order.push("revoke"); });
    deps.recursiveDelete.mockImplementationOnce(async () => { order.push("wipe"); });
    deps.deleteUser.mockImplementationOnce(async () => { order.push("deleteUser"); });

    const res = await POST();

    expect(res.status).toBe(200);
    expect(deps.revokeRefreshTokens).toHaveBeenCalledWith("user_123");
    // Revocation must land while the Auth record still exists AND before the
    // data wipe — otherwise the caller's live ID token stays valid for its full
    // ~1h and can POST holdings/conversations straight back after erasure.
    expect(order).toEqual(["revoke", "wipe", "deleteUser"]);
  });

  it("still deletes the account when session revocation fails", async () => {
    deps.revokeRefreshTokens.mockRejectedValueOnce(new Error("auth backend down"));

    const res = await POST();

    expect(res.status).toBe(200);
    expect(deps.deleteUser).toHaveBeenCalledWith("user_123");
  });
});

describe("POST /api/user/delete — top-level per-user rows", () => {
  // Regression: tickerMemory rows (portfolio-derived insights, no TTL) survived deletion.
  it("erases the user's tickerMemory rows", async () => {
    const refs = [{ id: "m1" }, { id: "m2" }];
    deps.memoryGet.mockResolvedValueOnce({ docs: refs.map((ref) => ({ ref })) });
    deps.subscriptionsList.mockResolvedValue({ data: [] });
    deps.settingsGet.mockResolvedValue({ data: () => ({}) });
    deps.sharesGet.mockResolvedValue({ docs: [] });
    deps.plaidItemsGet.mockResolvedValue({ docs: [] });
    deps.deleteUser.mockResolvedValue(undefined);

    const res = await POST();

    expect(res.status).toBe(200);
    expect(deps.deleteRefsInBatches).toHaveBeenCalledWith(refs);
  });
});
