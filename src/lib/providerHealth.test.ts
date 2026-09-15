import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAILURE_WINDOW_MS,
  getHealthSnapshot,
  llmStatus,
  recordProviderFailure,
  recordProviderSuccess,
  resetProviderHealthForTest,
  setSharedHealthStoreForTest,
  type SharedHealthStore,
} from "./providerHealth";

beforeEach(() => {
  resetProviderHealthForTest();
  setSharedHealthStoreForTest(null);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("llmStatus (in-memory)", () => {
  it("is ok with no recorded failures", () => {
    expect(llmStatus()).toBe("ok");
  });

  it("is degraded when OpenRouter is failing but the direct fallback is not", () => {
    recordProviderFailure("openrouter");
    expect(llmStatus()).toBe("degraded");
  });

  it("is down when OpenRouter AND direct Anthropic are both failing", () => {
    recordProviderFailure("openrouter");
    recordProviderFailure("anthropic");
    expect(llmStatus()).toBe("down");
  });

  it("is degraded when the router fell back, even if OpenRouter itself is fine", () => {
    recordProviderFailure("router");
    expect(llmStatus()).toBe("degraded");
  });

  it("recovers once the provider succeeds after its last failure", () => {
    const t = 1_000_000;
    recordProviderFailure("openrouter", t);
    recordProviderSuccess("openrouter", t + 10);
    expect(llmStatus(t + 20)).toBe("ok");
  });

  it("forgets a failure older than the window", () => {
    const t = 1_000_000;
    recordProviderFailure("openrouter", t);
    expect(llmStatus(t + FAILURE_WINDOW_MS - 1)).toBe("degraded");
    expect(llmStatus(t + FAILURE_WINDOW_MS + 1)).toBe("ok");
  });

  it("ignores data-provider failures for the llm status", () => {
    recordProviderFailure("perplexity");
    expect(llmStatus()).toBe("ok");
  });
});

describe("getHealthSnapshot", () => {
  it("reports llm and per-data-provider state", async () => {
    recordProviderFailure("finnhub");
    const snap = await getHealthSnapshot();
    expect(snap).toEqual({ llm: "ok", data: { perplexity: "ok", finnhub: "degraded" } });
  });

  it("merges failures another serverless instance wrote to the shared store", async () => {
    const store: SharedHealthStore = {
      markFailure: vi.fn(async () => {}),
      clearFailure: vi.fn(async () => {}),
      failing: vi.fn(async () => new Set(["openrouter" as const])),
    };
    setSharedHealthStoreForTest(store);
    const snap = await getHealthSnapshot();
    expect(snap.llm).toBe("degraded");
  });

  it("falls back to local state when the shared store errors", async () => {
    const store: SharedHealthStore = {
      markFailure: vi.fn(async () => {}),
      clearFailure: vi.fn(async () => {}),
      failing: vi.fn(async () => {
        throw new Error("redis down");
      }),
    };
    setSharedHealthStoreForTest(store);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(getHealthSnapshot()).resolves.toMatchObject({ llm: "ok" });
  });

  it("writes failures to the shared store, and clears them only on recovery", async () => {
    const store: SharedHealthStore = {
      markFailure: vi.fn(async () => {}),
      clearFailure: vi.fn(async () => {}),
      failing: vi.fn(async () => new Set<never>()),
    };
    setSharedHealthStoreForTest(store);
    recordProviderSuccess("openrouter"); // healthy → no write on the hot path
    expect(store.clearFailure).not.toHaveBeenCalled();
    recordProviderFailure("openrouter");
    expect(store.markFailure).toHaveBeenCalledWith("openrouter");
    recordProviderSuccess("openrouter");
    expect(store.clearFailure).toHaveBeenCalledWith("openrouter");
  });
});
