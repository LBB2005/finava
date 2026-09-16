import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeFirestoreMock } from "@/test/mocks/firestore";

const fs = makeFirestoreMock();
const getUserByEmail = vi.fn();
vi.mock("@/lib/firebase-admin", () => ({
  db: fs.db,
  adminAuth: { getUserByEmail: (e: string) => getUserByEmail(e) },
}));

const isAdminUid = vi.fn();
vi.mock("@/lib/adminAllowlist", () => ({ isAdminUid: (u: string) => isAdminUid(u) }));

const forgetTesterPlan = vi.fn();
vi.mock("@/lib/entitlements", () => ({ forgetTesterPlan: (u: string) => forgetTesterPlan(u) }));

beforeEach(() => {
  fs.store.clear();
  getUserByEmail.mockReset();
  isAdminUid.mockReset().mockResolvedValue(true);
  forgetTesterPlan.mockReset();
});

describe("assignTesterPlan", () => {
  it("puts an allowlisted tester on a real plan", async () => {
    const { assignTesterPlan } = await import("./testerPlan");
    const res = await assignTesterPlan({ uid: "tester1" }, "Analyst");

    expect(res).toEqual({ ok: true, uid: "tester1", plan: "Analyst" });
    expect(fs.store.get("userSettings/tester1")).toMatchObject({ betaPlan: "Analyst" });
    // The memoized resolution is dropped, so the change is visible immediately.
    expect(forgetTesterPlan).toHaveBeenCalledWith("tester1");
  });

  it("never writes Stripe's fields — a subscription can't be minted from here", async () => {
    const { assignTesterPlan } = await import("./testerPlan");
    await assignTesterPlan({ uid: "tester1" }, "Pro");
    const doc = fs.store.get("userSettings/tester1") as Record<string, unknown>;
    expect(doc).not.toHaveProperty("plan");
    expect(doc).not.toHaveProperty("subscriptionStatus");
  });

  it("clears the assignment with a null plan", async () => {
    const { assignTesterPlan } = await import("./testerPlan");
    await assignTesterPlan({ uid: "tester1" }, "Pro");
    const res = await assignTesterPlan({ uid: "tester1" }, null);
    expect(res).toEqual({ ok: true, uid: "tester1", plan: null });
    expect(fs.store.get("userSettings/tester1")).toMatchObject({ betaPlan: null });
  });

  it("resolves an email to its account", async () => {
    getUserByEmail.mockResolvedValue({ uid: "from-email" });
    const { assignTesterPlan } = await import("./testerPlan");
    const res = await assignTesterPlan({ email: "t@example.com" }, "Free");
    expect(res).toMatchObject({ ok: true, uid: "from-email" });
  });

  it("refuses an account that is not on the tester allowlist", async () => {
    isAdminUid.mockResolvedValue(false);
    const { assignTesterPlan } = await import("./testerPlan");
    const res = await assignTesterPlan({ uid: "stranger" }, "Pro");
    expect(res).toMatchObject({ ok: false, status: 403 });
    expect(fs.store.get("userSettings/stranger")).toBeUndefined();
  });

  it("says so when the email has no account yet", async () => {
    getUserByEmail.mockRejectedValue(new Error("auth/user-not-found"));
    const { assignTesterPlan } = await import("./testerPlan");
    const res = await assignTesterPlan({ email: "nobody@example.com" }, "Pro");
    expect(res).toMatchObject({ ok: false, status: 404 });
  });

  it("requires a target", async () => {
    const { assignTesterPlan } = await import("./testerPlan");
    expect(await assignTesterPlan({}, "Pro")).toMatchObject({ ok: false, status: 400 });
  });
});

describe("readTesterPlan", () => {
  it("reports the current assignment, or null when there is none", async () => {
    const { assignTesterPlan, readTesterPlan } = await import("./testerPlan");
    expect(await readTesterPlan({ uid: "tester1" })).toEqual({
      ok: true,
      uid: "tester1",
      plan: null,
    });
    await assignTesterPlan({ uid: "tester1" }, "Quant");
    expect(await readTesterPlan({ uid: "tester1" })).toEqual({
      ok: true,
      uid: "tester1",
      plan: "Quant",
    });
  });

  it("treats a junk stored value as no assignment", async () => {
    fs.store.set("userSettings/tester1", { betaPlan: "Platinum" });
    const { readTesterPlan } = await import("./testerPlan");
    expect(await readTesterPlan({ uid: "tester1" })).toMatchObject({ plan: null });
  });
});

describe("isPlanName", () => {
  it("accepts the real tiers and nothing else", async () => {
    const { isPlanName } = await import("./testerPlan");
    expect(isPlanName("Analyst")).toBe(true);
    expect(isPlanName("analyst")).toBe(false);
    expect(isPlanName(null)).toBe(false);
    expect(isPlanName(7)).toBe(false);
  });
});
