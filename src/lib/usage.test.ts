import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeFirestoreMock } from "@/test/mocks/firestore";

// ── Mocks at the boundary ────────────────────────────────────────────────────
// firebase-admin: only FieldValue sentinels are used by usage.ts.
vi.mock("firebase-admin", () => ({
  firestore: {
    FieldValue: {
      increment: (n: number) => ({ __inc: n }),
      delete: () => ({ __del: true }),
    },
  },
}));

const fs = makeFirestoreMock();
vi.mock("@/lib/firebase-admin", () => ({ db: fs.db }));

const resolvePlan = vi.fn();
vi.mock("@/lib/entitlements", () => ({ resolvePlan: (id: string) => resolvePlan(id) }));

// Helper: a plan-resolution result of the shape usage.ts consumes.
const plan = (over: Record<string, unknown> = {}) => ({
  plan: "free",
  source: "subscription",
  degraded: false,
  trialEndsAt: null,
  config: {
    daily: 100,
    weekly: 500,
    monthly: 1500,
    deepResearchPerMonth: 5,
  },
  ...over,
});

beforeEach(() => {
  fs.store.clear();
  resolvePlan.mockReset();
  resolvePlan.mockResolvedValue(plan());
});

const today = new Date().toISOString().slice(0, 10);

describe("creditsFor (pure cost-weighting)", () => {
  it("weights output tokens higher than input for a known model", async () => {
    const { creditsFor } = await import("./usage");
    // sonnet: in $3/M, out $15/M → (1000*3 + 1000*15)/1e6 = 0.018 USD → 18 credits.
    expect(creditsFor("anthropic/claude-sonnet-4.6", 1000, 1000)).toBe(18);
  });
  it("discounts cached input tokens to 10% of fresh input", async () => {
    const { creditsFor } = await import("./usage");
    // 1000 in (500 cached): (500*3 + 500*3*0.1 + 1000*15)/1e6 = 0.01665 → 16.65.
    expect(creditsFor("anthropic/claude-sonnet-4.6", 1000, 1000, 500)).toBeCloseTo(16.65, 6);
  });
  it("falls back to the most-expensive tier for an unknown model", async () => {
    const { creditsFor } = await import("./usage");
    // fallback price equals sonnet → same 18 credits, never under-charges.
    expect(creditsFor("totally-unknown-model", 1000, 1000)).toBe(18);
  });
  it("tolerates slug/id drift (anthropic/ prefix)", async () => {
    const { creditsFor } = await import("./usage");
    expect(creditsFor("claude-sonnet-4-6", 1000, 1000)).toBe(18);
    expect(creditsFor("anthropic/claude-sonnet-4-6", 1000, 1000)).toBe(18);
  });
});

describe("recordUsage", () => {
  it("no-ops when there is no userId in scope", async () => {
    const { recordUsage } = await import("./usage");
    await recordUsage({ model: "anthropic/claude-sonnet-4.6", inputTokens: 10, outputTokens: 10 });
    expect(fs.store.size).toBe(0);
  });
  it("no-ops when all token counts are zero", async () => {
    const { recordUsage } = await import("./usage");
    await recordUsage({ userId: "u1", model: "anthropic/claude-sonnet-4.6", inputTokens: 0, outputTokens: 0 });
    expect(fs.store.size).toBe(0);
  });
  it("writes a credit increment under today's bucket for the user", async () => {
    const { recordUsage } = await import("./usage");
    await recordUsage({ userId: "u1", model: "anthropic/claude-sonnet-4.6", inputTokens: 1000, outputTokens: 1000 });
    const doc = fs.store.get("userUsage/u1") as { days?: Record<string, unknown> };
    expect(doc?.days?.[today]).toBeDefined();
  });
  it("honors flatCredits, bypassing token math", async () => {
    const { recordUsage } = await import("./usage");
    await recordUsage({ userId: "u2", model: "sonar", flatCredits: 7 });
    expect(fs.store.get("userUsage/u2")).toBeDefined();
  });
});

describe("checkUsageLimit", () => {
  it("returns null (allow) on a degraded plan read — fail open", async () => {
    resolvePlan.mockResolvedValue(plan({ degraded: true }));
    const { checkUsageLimit } = await import("./usage");
    expect(await checkUsageLimit("u1")).toBeNull();
  });
  it("returns null (allow) for admin/dev source — uncapped", async () => {
    resolvePlan.mockResolvedValue(plan({ source: "admin" }));
    const { checkUsageLimit } = await import("./usage");
    expect(await checkUsageLimit("admin-uid")).toBeNull();
  });
  it("returns null when the user is under their daily cap", async () => {
    fs.store.set("userUsage/u1", { days: { [today]: 10 } });
    const { checkUsageLimit } = await import("./usage");
    expect(await checkUsageLimit("u1")).toBeNull();
  });
  it("returns a 429 when the user is at/over their daily cap", async () => {
    fs.store.set("userUsage/u1", { days: { [today]: 100 } }); // cap is 100
    const { checkUsageLimit } = await import("./usage");
    const res = await checkUsageLimit("u1");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    const body = await res!.json();
    expect(body.error).toBe("limit_reached");
    expect(body.scope).toBe("daily");
  });
  it("fails OPEN for a paid user when the Firestore read throws", async () => {
    // Default plan mock is a paid subscription — a Firestore blip must not lock
    // out a payer, so the read-error path allows the request.
    const { checkUsageLimit } = await import("./usage");
    const spy = vi.spyOn(fs.db, "collection").mockImplementationOnce(() => {
      throw new Error("boom");
    });
    expect(await checkUsageLimit("u1")).toBeNull();
    spy.mockRestore();
  });

  it("fails CLOSED (503) for a free/anon user when the Firestore read throws", async () => {
    // Bounds COGS: an unmetered free user is soft-blocked rather than allowed
    // unbounded spend during a read outage.
    resolvePlan.mockResolvedValue(plan({ source: "free", plan: "Free" }));
    const { checkUsageLimit } = await import("./usage");
    const spy = vi.spyOn(fs.db, "collection").mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const res = await checkUsageLimit("u1");
    expect(res!.status).toBe(503);
    expect((await res!.json()).error).toBe("usage_unavailable");
    spy.mockRestore();
  });
});

describe("getUsageSummary", () => {
  it("reports used vs limit and a 30-day series", async () => {
    fs.store.set("userUsage/u1", { days: { [today]: 25 } });
    const { getUsageSummary } = await import("./usage");
    const s = await getUsageSummary("u1");
    expect(s.plan).toBe("free");
    expect(s.daily.used).toBe(25);
    expect(s.daily.limit).toBe(100);
    expect(s.series).toHaveLength(30);
    expect(s.series[s.series.length - 1].date).toBe(today);
  });
  it("surfaces unlimited caps for admin/dev", async () => {
    resolvePlan.mockResolvedValue(plan({ source: "admin" }));
    fs.store.set("userUsage/u1", { days: { [today]: 25 } });
    const { getUsageSummary } = await import("./usage");
    const s = await getUsageSummary("u1");
    expect(s.daily.limit).toBeNull(); // jsonLimit(Infinity) → null
  });
});

// usage.ts keeps dayKey/monthKey private; mirror them here (both are UTC slices).
const dayKey = (d: Date = new Date()) => d.toISOString().slice(0, 10);
const monthKey = (d: Date = new Date()) => d.toISOString().slice(0, 7);

describe("withUsageContext", () => {
  it("puts the userId in scope for anything recordUsage sees", async () => {
    const { withUsageContext, usageStore } = await import("./usage");
    const seen = withUsageContext("u_ctx", () => usageStore.getStore()?.userId);
    expect(seen).toBe("u_ctx");
  });

  it("threads an explicit requestId through", async () => {
    const { withUsageContext, usageStore } = await import("./usage");
    const seen = withUsageContext("u_ctx", () => usageStore.getStore()?.requestId, "req_9");
    expect(seen).toBe("req_9");
  });

  it("labels the run's lane, defaulting to the cheapest one", async () => {
    const { withUsageContext, currentLane } = await import("./usage");
    expect(withUsageContext("u_ctx", () => currentLane(), "r1", "deep")).toBe("deep");
    expect(withUsageContext("u_ctx", () => currentLane())).toBe("fast");
  });
});

describe("recordUsage — the run-credit choke point", () => {
  it("accumulates into the ambient run total so a long crew can be aborted", async () => {
    const { recordUsage, withUsageContext, currentRunCredits } = await import("./usage");
    await withUsageContext("u_run", async () => {
      await recordUsage({ agent: "a", model: "perplexity/sonar", flatCredits: 40 });
      await recordUsage({ agent: "b", model: "perplexity/sonar", flatCredits: 60 });
      expect(currentRunCredits()).toBe(100);
    });
  });

  it("attributes each call to the run, so one run's cost can be broken down", async () => {
    const { recordUsage, withUsageContext, usageStore } = await import("./usage");
    const calls = await withUsageContext("u_run", async () => {
      // A crew turn (tokens) and a flat-priced paid-data call land in one ledger.
      await recordUsage({ agent: "ceo", model: "claude-sonnet-4-6", inputTokens: 1000, outputTokens: 1000 });
      await recordUsage({ agent: "news", model: "perplexity/sonar", flatCredits: 40 });
      return usageStore.getStore()!.calls;
    });
    expect(calls).toEqual([
      { agent: "ceo", model: "claude-sonnet-4-6", credits: 18, inputTokens: 1000, outputTokens: 1000 },
      { agent: "news", model: "perplexity/sonar", credits: 40, inputTokens: 0, outputTokens: 0 },
    ]);
  });

  it("infers the userId from the ambient context when the caller omits it", async () => {
    const { recordUsage, withUsageContext } = await import("./usage");
    await withUsageContext("u_amb", () =>
      recordUsage({ agent: "a", model: "perplexity/sonar", flatCredits: 5 }),
    );
    expect(fs.store.get("userUsage/u_amb")).toBeTruthy();
  });

  it("is a no-op with no userId anywhere", async () => {
    const { recordUsage } = await import("./usage");
    await recordUsage({ agent: "a", model: "perplexity/sonar", flatCredits: 5 });
    expect(fs.store.size).toBe(0);
  });
});

describe("checkDeepResearchAllowed", () => {
  it("allows a run under the monthly limit", async () => {
    const { checkDeepResearchAllowed } = await import("./usage");
    await expect(checkDeepResearchAllowed("u1")).resolves.toBeNull();
  });

  it("429s once the monthly allowance is spent, naming the upgrade", async () => {
    const { checkDeepResearchAllowed } = await import("./usage");
    fs.store.set("userUsage/u1", { deepRuns: { [monthKey()]: 5 } });
    const res = await checkDeepResearchAllowed("u1");
    expect(res!.status).toBe(429);
    await expect(res!.json()).resolves.toMatchObject({
      error: "deep_research_limit",
      scope: "monthly",
      used: 5,
      limit: 5,
    });
  });

  it("allows unlimited runs on a fair-use plan", async () => {
    resolvePlan.mockResolvedValue(
      plan({ config: { daily: 1, weekly: 1, monthly: 1, deepResearchPerMonth: Infinity } }),
    );
    const { checkDeepResearchAllowed } = await import("./usage");
    fs.store.set("userUsage/u1", { deepRuns: { [monthKey()]: 9999 } });
    await expect(checkDeepResearchAllowed("u1")).resolves.toBeNull();
  });

  it("caps a trial across its whole window, not per month", async () => {
    resolvePlan.mockResolvedValue(plan({ source: "trial" }));
    const { checkDeepResearchAllowed } = await import("./usage");

    fs.store.set("userUsage/u1", { trialDeepRuns: 4 });
    await expect(checkDeepResearchAllowed("u1")).resolves.toBeNull();

    fs.store.set("userUsage/u1", { trialDeepRuns: 5 });
    const res = await checkDeepResearchAllowed("u1");
    expect(res!.status).toBe(429);
    await expect(res!.json()).resolves.toMatchObject({ scope: "trial", used: 5, limit: 5 });
  });

  it("fails OPEN when the plan read is degraded", async () => {
    resolvePlan.mockResolvedValue(plan({ degraded: true }));
    const { checkDeepResearchAllowed } = await import("./usage");
    await expect(checkDeepResearchAllowed("u1")).resolves.toBeNull();
  });

  it("fails OPEN when the usage read throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { checkDeepResearchAllowed } = await import("./usage");
    const orig = fs.db.collection;
    fs.db.collection = () => ({ doc: () => ({ get: async () => { throw new Error("down"); } }) }) as never;
    await expect(checkDeepResearchAllowed("u1")).resolves.toBeNull();
    fs.db.collection = orig;
    spy.mockRestore();
  });
});

describe("recordDeepResearchRun", () => {
  it("increments the month bucket", async () => {
    const { recordDeepResearchRun } = await import("./usage");
    await recordDeepResearchRun("u1");
    expect(fs.store.get("userUsage/u1")).toMatchObject({
      deepRuns: { [monthKey()]: { __inc: 1 } },
    });
  });

  it("also increments the trial lifetime counter for a trial run", async () => {
    resolvePlan.mockResolvedValue(plan({ source: "trial" }));
    const { recordDeepResearchRun } = await import("./usage");
    await recordDeepResearchRun("u1");
    expect(fs.store.get("userUsage/u1")).toMatchObject({ trialDeepRuns: { __inc: 1 } });
  });

  it("counts only the month bucket when the plan cannot be resolved", async () => {
    resolvePlan.mockRejectedValue(new Error("firestore down"));
    const { recordDeepResearchRun } = await import("./usage");
    await recordDeepResearchRun("u1");
    expect(fs.store.get("userUsage/u1")).not.toHaveProperty("trialDeepRuns");
  });

  it("never throws when the write fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { recordDeepResearchRun } = await import("./usage");
    const orig = fs.db.collection;
    fs.db.collection = () => ({ doc: () => ({ set: async () => { throw new Error("quota"); } }) }) as never;
    await expect(recordDeepResearchRun("u1")).resolves.toBeUndefined();
    fs.db.collection = orig;
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("getUsageSummary — deep research and pruning", () => {
  it("reports the trial lifetime counter for a trial user", async () => {
    resolvePlan.mockResolvedValue(plan({ source: "trial" }));
    fs.store.set("userUsage/u1", { trialDeepRuns: 3 });
    const { getUsageSummary } = await import("./usage");
    expect((await getUsageSummary("u1")).deepResearch).toEqual({ used: 3, limit: 5 });
  });

  it("surfaces unlimited credit caps for admin and dev access", async () => {
    resolvePlan.mockResolvedValue(plan({ source: "admin" }));
    const { getUsageSummary } = await import("./usage");
    const s = await getUsageSummary("u1");
    expect(s.daily.limit).toBeNull();
    expect(s.weekly.limit).toBeNull();
    expect(s.monthly.limit).toBeNull();
  });

  it("prunes day buckets older than 35 days", async () => {
    const { getUsageSummary } = await import("./usage");
    const stale = dayKey(new Date(Date.now() - 60 * 86_400_000));
    fs.store.set("userUsage/u1", { days: { [stale]: 12, [dayKey()]: 3 } });

    await getUsageSummary("u1");
    // The prune is fire-and-forget; let its microtask land.
    await new Promise((r) => setTimeout(r, 0));

    expect(fs.store.get("userUsage/u1")).toMatchObject({ [`days.${stale}`]: { __del: true } });
  });

  it("skips the prune when nothing is stale", async () => {
    const { getUsageSummary } = await import("./usage");
    fs.store.set("userUsage/u1", { days: { [dayKey()]: 3 } });
    await getUsageSummary("u1");
    await new Promise((r) => setTimeout(r, 0));
    expect(Object.keys(fs.store.get("userUsage/u1") as object)).toEqual(["days"]);
  });

  it("returns a 30-day series ending today", async () => {
    const { getUsageSummary } = await import("./usage");
    const s = await getUsageSummary("u1");
    expect(s.series).toHaveLength(30);
    expect(s.series.at(-1)!.date).toBe(dayKey());
  });
});
