import { describe, it, expect, vi, afterEach } from "vitest";
import { MemoryReservations, tournamentCap } from "../live/budgetReservation";
import {
  requestBound,
  tournamentFetch,
  withTournamentBudget,
} from "./modelTransport";
import { jevQuestions, jevForecasts, runJev } from "./models";
afterEach(() => vi.unstubAllGlobals());
describe("tournament models", () => {
  it("reserves before calls, keeps uncertain spend, and cannot overrun under concurrency", async () => {
    const store = new MemoryReservations();
    expect(
      await Promise.all([store.reserve("a", 5, 8), store.reserve("b", 5, 8)]),
    ).toEqual([true, false]);
    expect(await store.reserve("a", 1, 8)).toBe(false);
    await store.measure("a", null);
    expect(await store.reserve("c", 4, 8)).toBe(false);
    expect(tournamentCap(undefined)).toBe(8);
    expect(tournamentCap("0")).toBe(0);
    expect(() => tournamentCap("oops")).toThrow();
  });
  it("blocks the actual HTTP request, including retries, when admission fails", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    await expect(
      withTournamentBudget(new MemoryReservations(), 0, () =>
        tournamentFetch("https://openrouter.ai/api/v1/chat/completions", {
          body: JSON.stringify({
            model: "google/gemini-2.5-flash-lite",
            max_tokens: 10,
          }),
        }),
      ),
    ).rejects.toThrow(/skipped_budget/);
    expect(fn).not.toHaveBeenCalled();
  });
  it("records provider dollars and does not call token estimates measured cost", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ usage: { cost: 0.001 } })),
        ),
    );
    const store = new MemoryReservations();
    const r = await withTournamentBudget(store, 8, () =>
      tournamentFetch("https://openrouter.ai/api/v1/chat/completions", {
        body: JSON.stringify({
          model: "google/gemini-2.5-flash-lite",
          max_tokens: 100,
        }),
      }),
    );
    expect(r.costUsd).toBe(0.001);
    expect((await store.entries())[0].upperUsd).toBeGreaterThan(0.001);
    expect(() =>
      requestBound({ model: "unknown", max_tokens: 100 }, "openrouter.ai"),
    ).toThrow();
    expect(() =>
      requestBound(
        {
          model: "google/gemini-2.5-flash",
          max_tokens: 100,
          tools: [{ type: "web_search" }],
        },
        "openrouter.ai",
      ),
    ).toThrow();
  });
  it("asks explicitly defined separate events and never uses confidence", () => {
    const q = jevQuestions([
      {
        horizon: 1,
        entryAt: "2026-07-06T13:30:00Z",
        targetAt: "2026-07-06T20:00:00Z",
      },
    ]);
    expect(Object.keys(q)).toEqual(["positive_1", "beatSpy_1"]);
    expect(
      jevForecasts({ positive_1: { noul: 0.7 }, beatSpy_1: { noul: 0.6 } }, [
        1,
      ]),
    ).toMatchObject([
      { horizon: 1, positive: 0.7, beatSpy: 0.6, expectedReturn: null },
    ]);
    expect(() =>
      jevForecasts(
        {
          positive_1: {
            choice: "yes",
            probabilities: { yes: 1 },
            confidence: 1,
          },
          beatSpy_1: { noul: 0.6 },
        },
        [1],
      ),
    ).toThrow(/noul/);
  });
  it("requires the direct key instead of silently spending a gateway key", async () => {
    const r = await runJev("evidence", [], {
      NODE_ENV: "test",
      AI_GATEWAY_API_KEY: "unused",
    });
    expect(r.status).toBe("unavailable");
  });
});
