import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  set: vi.fn(),
  get: vi.fn(),
}));

// Firestore stand-in: `users/{uid}/conversations/{id}` docs in a Map.
vi.mock("@/lib/firebase-admin", () => ({
  db: {
    collection: () => ({
      doc: (uid: string) => ({
        collection: () => ({
          doc: (convId: string) => {
            const key = `${uid}/${convId}`;
            return {
              set: async (data: Record<string, unknown>) => {
                store.set(key, data);
                store.docs.set(key, { ...(store.docs.get(key) ?? {}), ...data });
              },
              get: async () => {
                store.get(key);
                const data = store.docs.get(key);
                return { exists: data != null, data: () => data };
              },
            };
          },
        }),
      }),
    }),
  },
}));

import {
  REUSE_MAX_AGE_MS,
  TURN_TTL_MS,
  isReusable,
  loadTurnData,
  recordCrewOutputs,
  resetTurnDataCache,
  saveTurnData,
  type TurnData,
} from "./turnData";
import type { QuickContext } from "./quickContext";

function quickContext(fetchedAt: string): QuickContext {
  return {
    ticker: "NVDA",
    tickers: ["NVDA"],
    facts: {
      price: { value: "$182.50", source: "Finnhub quote", asOf: fetchedAt },
    } as unknown as QuickContext["facts"],
    headlines: [],
    fetchedAt,
    dropped: [],
  };
}

function turn(fetchedAt: string): TurnData {
  return { quickContext: quickContext(fetchedAt), storedAt: fetchedAt };
}

const NOW = Date.parse("2026-09-15T21:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  store.docs.clear();
  resetTurnDataCache();
  // The fixtures are stamped at NOW; without a pinned clock they expire a day
  // after NOW and the storage tests fail on the calendar, not on the code.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isReusable", () => {
  it("accepts data fetched moments ago", () => {
    expect(isReusable(turn(new Date(NOW - 30_000).toISOString()), NOW)).toBe(true);
  });

  it("accepts data right up to the freshness window", () => {
    expect(isReusable(turn(new Date(NOW - REUSE_MAX_AGE_MS + 1_000).toISOString()), NOW)).toBe(true);
  });

  it("rejects data older than the freshness window — prices move", () => {
    expect(isReusable(turn(new Date(NOW - REUSE_MAX_AGE_MS - 1_000).toISOString()), NOW)).toBe(false);
  });

  it("rejects an undatable turn rather than assuming it is fresh", () => {
    expect(isReusable({ quickContext: quickContext("not a date"), storedAt: "junk" }, NOW)).toBe(false);
  });

  it("rejects nothing at all", () => {
    expect(isReusable(null, NOW)).toBe(false);
  });

  it("keeps the freshness window well inside the storage TTL", () => {
    expect(REUSE_MAX_AGE_MS).toBeLessThan(TURN_TTL_MS);
  });
});

describe("saveTurnData / loadTurnData", () => {
  it("round-trips through memory without touching Firestore", async () => {
    await saveTurnData("u1", "c1", turn(new Date(NOW).toISOString()));
    store.get.mockClear();
    const got = await loadTurnData("u1", "c1");
    expect(got?.quickContext.ticker).toBe("NVDA");
    expect(store.get).not.toHaveBeenCalled();
  });

  it("falls back to Firestore after a cold start", async () => {
    await saveTurnData("u1", "c1", turn(new Date(NOW).toISOString()));
    resetTurnDataCache(); // simulate a new serverless instance
    const got = await loadTurnData("u1", "c1");
    expect(store.get).toHaveBeenCalled();
    expect(got?.quickContext.ticker).toBe("NVDA");
  });

  it("stamps an expiry 24 h out so the doc does not grow forever", async () => {
    vi.setSystemTime(NOW);
    await saveTurnData("u1", "c1", turn(new Date(NOW).toISOString()));
    const written = store.set.mock.calls.at(-1)![1] as { turnData: { expiresAt: string } };
    expect(Date.parse(written.turnData.expiresAt) - NOW).toBe(TURN_TTL_MS);
    vi.useRealTimers();
  });

  it("ignores data past its TTL", async () => {
    vi.setSystemTime(NOW - TURN_TTL_MS - 60_000);
    await saveTurnData("u1", "c1", turn(new Date(NOW - TURN_TTL_MS - 60_000).toISOString()));
    vi.setSystemTime(NOW);
    resetTurnDataCache();
    await expect(loadTurnData("u1", "c1")).resolves.toBeNull();
    vi.useRealTimers();
  });

  it("keeps one user's turn data out of another's conversation", async () => {
    await saveTurnData("u1", "c1", turn(new Date(NOW).toISOString()));
    await expect(loadTurnData("u2", "c1")).resolves.toBeNull();
  });

  it("returns null for a conversation that never stored anything", async () => {
    await expect(loadTurnData("u1", "nope")).resolves.toBeNull();
  });

  it("never throws when Firestore is unavailable — the answer still goes out", async () => {
    store.get.mockImplementation(() => {
      throw new Error("firestore down");
    });
    await expect(loadTurnData("u1", "c1")).resolves.toBeNull();
  });

  it("survives a Firestore write failure", async () => {
    store.set.mockImplementation(() => {
      throw new Error("firestore down");
    });
    await expect(saveTurnData("u1", "c1", turn(new Date(NOW).toISOString()))).resolves.toBeUndefined();
    // The in-memory copy is still usable for the immediate follow-up.
    await expect(loadTurnData("u1", "c1")).resolves.not.toBeNull();
  });
});

describe("recordCrewOutputs", () => {
  it("stores what the crew gathered without erasing the fast lane's data", async () => {
    resetTurnDataCache();
    const qc = quickContext("2026-09-15T20:55:00.000Z");
    await saveTurnData("u1", "c1", { quickContext: qc, storedAt: "2026-09-15T20:55:00.000Z" });
    await recordCrewOutputs("u1", "c1", { run_dcf_agent: "fair value $120" });

    const stored = await loadTurnData("u1", "c1");
    expect(stored?.crewOutputs).toEqual({ run_dcf_agent: "fair value $120" });
    expect(stored?.quickContext).toEqual(qc);
  });

  it("merges a second crew run's outputs into the first", async () => {
    resetTurnDataCache();
    await recordCrewOutputs("u1", "c2", { run_dcf_agent: "a" });
    await recordCrewOutputs("u1", "c2", { run_risk_agent: "b" });
    expect((await loadTurnData("u1", "c2"))?.crewOutputs).toEqual({ run_dcf_agent: "a", run_risk_agent: "b" });
  });

  it("is a no-op without a conversation (the live harness and debate route have none)", async () => {
    resetTurnDataCache();
    await recordCrewOutputs("u1", undefined, { run_dcf_agent: "a" });
    await recordCrewOutputs(undefined, "c3", { run_dcf_agent: "a" });
    expect(await loadTurnData("u1", "c3")).toBeNull();
  });
});
