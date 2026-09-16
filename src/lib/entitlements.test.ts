import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFirestoreMock } from "@/test/mocks/firestore";
import { PLANS } from "./plans";

const fs = makeFirestoreMock();
vi.mock("@/lib/firebase-admin", () => ({ db: fs.db }));

beforeEach(async () => {
  fs.store.clear();
  vi.stubEnv("ADMIN_UIDS", "");
  // Tester-plan assignments are memoized per UID; start every test cold.
  const { forgetTesterPlan } = await import("./entitlements");
  forgetTesterPlan();
});
afterEach(() => vi.unstubAllEnvs());

describe("resolvePlan", () => {
  it("defaults to the Free floor when no settings doc exists", async () => {
    const { resolvePlan } = await import("./entitlements");
    const ent = await resolvePlan("nobody");
    expect(ent.plan).toBe("Free");
    expect(ent.source).toBe("free");
    expect(ent.degraded).toBe(false);
  });

  it("grants Quant to an admin UID with no settings doc", async () => {
    vi.stubEnv("ADMIN_UIDS", "admin-1, admin-2");
    const { resolvePlan } = await import("./entitlements");
    const ent = await resolvePlan("admin-2");
    expect(ent.plan).toBe("Quant");
    expect(ent.source).toBe("admin");
  });

  it("puts an allowlisted tester on the plan an admin assigned them", async () => {
    vi.stubEnv("ADMIN_UIDS", "tester-1");
    fs.store.set("userSettings/tester-1", { betaPlan: "Analyst" });
    const { resolvePlan } = await import("./entitlements");
    const ent = await resolvePlan("tester-1");
    // Not "admin": the whole point is that they now live inside a real plan's
    // allowances and per-run caps, which the admin source bypasses.
    expect(ent.plan).toBe("Analyst");
    expect(ent.source).toBe("beta_plan");
    expect(ent.config.monthly).toBe(PLANS.Analyst.monthly);
  });

  it("ignores a junk betaPlan value and keeps full admin access", async () => {
    vi.stubEnv("ADMIN_UIDS", "tester-1");
    fs.store.set("userSettings/tester-1", { betaPlan: "Platinum" });
    const { resolvePlan } = await import("./entitlements");
    expect((await resolvePlan("tester-1")).source).toBe("admin");
  });

  it("hands an admin their access back when the assignment is cleared", async () => {
    vi.stubEnv("ADMIN_UIDS", "tester-1");
    fs.store.set("userSettings/tester-1", { betaPlan: "Pro" });
    const { resolvePlan, forgetTesterPlan } = await import("./entitlements");
    expect((await resolvePlan("tester-1")).plan).toBe("Pro");

    fs.store.set("userSettings/tester-1", { betaPlan: null });
    forgetTesterPlan("tester-1");
    expect((await resolvePlan("tester-1")).source).toBe("admin");
  });

  it("keeps an admin's access when their settings can't be read", async () => {
    vi.stubEnv("ADMIN_UIDS", "tester-1");
    const boom = vi.spyOn(fs.db, "collection").mockImplementation(() => {
      throw new Error("firestore down");
    });
    const { resolvePlan } = await import("./entitlements");
    const ent = await resolvePlan("tester-1");
    boom.mockRestore();
    expect(ent.source).toBe("admin");
    expect(ent.degraded).toBe(false);
  });

  it("grants Quant to the dev-bypass user outside production", async () => {
    const { resolvePlan } = await import("./entitlements");
    const ent = await resolvePlan("dev-user");
    expect(ent.plan).toBe("Quant");
    expect(ent.source).toBe("dev");
  });

  it("honors an active paid subscription", async () => {
    fs.store.set("userSettings/u1", { plan: "Pro", subscriptionStatus: "active" });
    const { resolvePlan } = await import("./entitlements");
    const ent = await resolvePlan("u1");
    expect(ent.plan).toBe("Pro");
    expect(ent.source).toBe("subscription");
  });

  it("treats past_due as a grace-period paid plan", async () => {
    fs.store.set("userSettings/u1", { plan: "Quant", subscriptionStatus: "past_due" });
    const { resolvePlan } = await import("./entitlements");
    expect((await resolvePlan("u1")).source).toBe("subscription");
  });

  it("keeps a past_due subscription within the grace window", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    fs.store.set("userSettings/u1", {
      plan: "Quant",
      subscriptionStatus: "past_due",
      pastDueSince: twoDaysAgo,
    });
    const { resolvePlan } = await import("./entitlements");
    expect((await resolvePlan("u1")).source).toBe("subscription");
  });

  it("drops a past_due subscription to Free after the grace window elapses", async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
    fs.store.set("userSettings/u1", {
      plan: "Quant",
      subscriptionStatus: "past_due",
      pastDueSince: eightDaysAgo,
    });
    const { resolvePlan } = await import("./entitlements");
    const ent = await resolvePlan("u1");
    expect(ent.plan).toBe("Free");
    expect(ent.source).toBe("free");
  });

  it("resolves a running trial to the Pro trial plan", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    fs.store.set("userSettings/u1", { trialEndsAt: future });
    const { resolvePlan } = await import("./entitlements");
    const ent = await resolvePlan("u1");
    expect(ent.plan).toBe("Pro");
    expect(ent.source).toBe("trial");
  });

  it("falls back to Free when the trial has expired", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    fs.store.set("userSettings/u1", { trialEndsAt: past });
    const { resolvePlan } = await import("./entitlements");
    expect((await resolvePlan("u1")).plan).toBe("Free");
  });

  it("returns a degraded Free entitlement when the read throws", async () => {
    const spy = vi.spyOn(fs.db, "collection").mockImplementationOnce(() => {
      throw new Error("firestore down");
    });
    const { resolvePlan } = await import("./entitlements");
    const ent = await resolvePlan("u1");
    expect(ent.plan).toBe("Free");
    expect(ent.degraded).toBe(true);
    spy.mockRestore();
  });
});

describe("requireEntitlement", () => {
  it("returns null when the plan grants the capability", async () => {
    fs.store.set("userSettings/u1", { plan: "Quant", subscriptionStatus: "active" });
    const { requireEntitlement } = await import("./entitlements");
    expect(await requireEntitlement("u1", "plaidLinking")).toBeNull();
  });

  it("returns a 403 when the plan lacks the capability", async () => {
    const { requireEntitlement } = await import("./entitlements");
    const res = await requireEntitlement("free-user", "plaidLinking");
    expect(res!.status).toBe(403);
    expect((await res!.json()).error).toBe("entitlement_required");
  });

  it("fails CLOSED with a 503 on a degraded read", async () => {
    const spy = vi.spyOn(fs.db, "collection").mockImplementationOnce(() => {
      throw new Error("down");
    });
    const { requireEntitlement } = await import("./entitlements");
    const res = await requireEntitlement("u1", "plaidLinking");
    expect(res!.status).toBe(503);
    spy.mockRestore();
  });
});

describe("capabilitiesFor", () => {
  it("locks plaidLinking on Free and unlocks it on Quant", async () => {
    const { capabilitiesFor } = await import("./entitlements");
    expect(capabilitiesFor("Free").plaidLinking).toBe(false);
    expect(capabilitiesFor("Quant").plaidLinking).toBe(true);
  });
});

describe("watchlist quota", () => {
  it("reports the per-plan watchlist limit", async () => {
    fs.store.set("userSettings/u1", { plan: "Pro", subscriptionStatus: "active" });
    const { getWatchlistLimit } = await import("./entitlements");
    expect(await getWatchlistLimit("free-user")).toBe(1);
    expect(await getWatchlistLimit("u1")).toBe(Infinity);
  });

  it("allows under the limit and rejects at it", async () => {
    const { assertWatchlistQuota } = await import("./entitlements");
    expect(await assertWatchlistQuota("free-user", 0)).toBeNull(); // Free limit is 1
    const res = await assertWatchlistQuota("free-user", 1);
    expect(res!.status).toBe(403);
    expect((await res!.json()).error).toBe("watchlist_limit");
  });
});
