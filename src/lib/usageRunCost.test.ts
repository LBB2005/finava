import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PER_RUN_CAP } from "./plans";
import { makeRunContext, usageStore, MAX_TRACKED_CALLS } from "./runContext";

// Entitlements is the only Firestore-backed dependency; everything else is pure.
const resolvePlan = vi.fn();
vi.mock("@/lib/entitlements", () => ({ resolvePlan: (id: string) => resolvePlan(id) }));

const ent = (over: Record<string, unknown> = {}) => ({
  plan: "Analyst",
  source: "subscription",
  degraded: false,
  config: { perRunCap: { fast: 60, full: 900, deep: 2500, discover: 600 } },
  ...over,
});

beforeEach(() => {
  resolvePlan.mockReset();
  resolvePlan.mockResolvedValue(ent());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Run `fn` inside a run context, with `calls` already metered into it. */
function inRun<T>(
  lane: "fast" | "full" | "deep" | "discover",
  calls: { agent?: string; model: string; credits: number; inputTokens?: number; outputTokens?: number }[],
  fn: () => T
): T {
  const ctx = makeRunContext("u1", "run-abc", lane);
  for (const c of calls) {
    ctx.credits.total += c.credits;
    ctx.calls.push({
      agent: c.agent,
      model: c.model,
      credits: c.credits,
      inputTokens: c.inputTokens ?? 0,
      outputTokens: c.outputTokens ?? 0,
    });
  }
  return usageStore.run(ctx, fn);
}

describe("resolveRunCap", () => {
  it("gives each lane its own ceiling, not one number for every run", async () => {
    const { resolveRunCap } = await import("./usageRunCost");
    expect(await resolveRunCap("u1", "fast")).toBe(60);
    expect(await resolveRunCap("u1", "full")).toBe(900);
    expect(await resolveRunCap("u1", "deep")).toBe(2500);
    expect(await resolveRunCap("u1", "discover")).toBe(600);
  });

  it("leaves an internal/no-user run uncapped", async () => {
    const { resolveRunCap } = await import("./usageRunCost");
    expect(await resolveRunCap(undefined, "deep")).toBe(Infinity);
  });

  it("leaves admin and dev uncapped by default", async () => {
    const { resolveRunCap } = await import("./usageRunCost");
    resolvePlan.mockResolvedValue(ent({ source: "admin" }));
    expect(await resolveRunCap("u1", "full")).toBe(Infinity);
    resolvePlan.mockResolvedValue(ent({ source: "dev" }));
    expect(await resolveRunCap("u1", "full")).toBe(Infinity);
  });

  it("caps admins like paying users when ENFORCE_CAPS_FOR_ADMINS=1", async () => {
    vi.stubEnv("ENFORCE_CAPS_FOR_ADMINS", "1");
    const { resolveRunCap } = await import("./usageRunCost");
    resolvePlan.mockResolvedValue(ent({ source: "admin" }));
    expect(await resolveRunCap("u1", "full")).toBe(900);
  });

  it("bounds a degraded read instead of failing open", async () => {
    const { resolveRunCap } = await import("./usageRunCost");
    resolvePlan.mockResolvedValue(ent({ degraded: true, config: undefined }));
    expect(await resolveRunCap("u1", "fast")).toBe(PER_RUN_CAP.deep);
  });

  it("keeps the backstop when entitlement resolution throws", async () => {
    const { resolveRunCap } = await import("./usageRunCost");
    resolvePlan.mockRejectedValue(new Error("firestore down"));
    expect(await resolveRunCap("u1", "full")).toBe(PER_RUN_CAP.deep);
  });

  it("falls back to the shared table when a plan config predates per-lane caps", async () => {
    const { resolveRunCap } = await import("./usageRunCost");
    resolvePlan.mockResolvedValue(ent({ config: {} }));
    expect(await resolveRunCap("u1", "deep")).toBe(PER_RUN_CAP.deep);
  });
});

describe("runCostReport", () => {
  it("sums a run's sub-calls into one total and breaks it down", async () => {
    const { runCostReport } = await import("./usageRunCost");
    const report = inRun(
      "full",
      [
        { agent: "ceo", model: "claude-sonnet-4-6", credits: 120, inputTokens: 20_000, outputTokens: 3_000 },
        { agent: "dcf", model: "anthropic/claude-sonnet-4.6", credits: 30, inputTokens: 5_000, outputTokens: 900 },
        { agent: "news", model: "google/gemini-2.5-flash", credits: 8, inputTokens: 4_000, outputTokens: 600 },
        { agent: "ceo", model: "claude-sonnet-4-6", credits: 60, inputTokens: 12_000, outputTokens: 1_500 },
      ],
      () => runCostReport()
    );

    expect(report).not.toBeNull();
    expect(report!.runId).toBe("run-abc");
    expect(report!.lane).toBe("full");
    expect(report!.credits).toBe(218);
    expect(report!.usd).toBeCloseTo(0.218, 4);
    expect(report!.calls).toBe(4);
    expect(report!.inputTokens).toBe(41_000);
    expect(report!.outputTokens).toBe(6_000);
    // Both Sonnet spellings are distinct slugs; the CEO's two turns fold together.
    expect(report!.byAgent).toEqual({ ceo: 180, dcf: 30, news: 8 });
    expect(Object.keys(report!.byModel)[0]).toBe("claude-sonnet-4-6");
  });

  it("attributes a call with no agent rather than dropping it", async () => {
    const { runCostReport } = await import("./usageRunCost");
    const report = inRun("fast", [{ model: "claude-haiku-4-5", credits: 9 }], () => runCostReport());
    expect(report!.byAgent).toEqual({ unattributed: 9 });
  });

  it("returns null outside a run context", async () => {
    const { runCostReport } = await import("./usageRunCost");
    expect(runCostReport()).toBeNull();
  });

  it("reports the wall-clock duration of the run", async () => {
    const { runCostReport } = await import("./usageRunCost");
    const ctx = makeRunContext("u1", "run-dur", "fast");
    ctx.startedAt = 1_000;
    const report = usageStore.run(ctx, () => runCostReport(() => 4_500));
    expect(report!.durationMs).toBe(3_500);
  });
});

describe("attributeCall bounds", () => {
  it("keeps totalling credits after the per-call list is full", async () => {
    const { attributeCall } = await import("./runContext");
    const { runCostReport } = await import("./usageRunCost");
    const ctx = makeRunContext("u1", "run-many", "deep");
    const report = usageStore.run(ctx, () => {
      for (let i = 0; i < MAX_TRACKED_CALLS + 25; i++) {
        attributeCall({ model: "m", credits: 1, inputTokens: 0, outputTokens: 0 });
      }
      return runCostReport();
    });
    expect(report!.calls).toBe(MAX_TRACKED_CALLS);
    expect(report!.credits).toBe(MAX_TRACKED_CALLS + 25);
  });
});

describe("logRunCost", () => {
  it("emits one run_cost line with the run's totals", async () => {
    const { logRunCost } = await import("./usageRunCost");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    inRun("deep", [{ agent: "ceo", model: "claude-sonnet-4-6", credits: 42 }], () =>
      logRunCost({ costAborted: false })
    );
    const line = JSON.parse(spy.mock.calls.at(-1)![0] as string);
    spy.mockRestore();
    expect(line).toMatchObject({
      tag: "runcost",
      msg: "run_cost",
      requestId: "run-abc",
      lane: "deep",
      credits: 42,
      topAgent: "ceo=42",
      costAborted: false,
    });
  });

  it("is a no-op outside a run context", async () => {
    const { logRunCost } = await import("./usageRunCost");
    expect(logRunCost()).toBeNull();
  });
});
