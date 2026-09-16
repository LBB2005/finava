import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FactorScores, Stock } from "@/lib/research";

const deps = vi.hoisted(() => ({
  holdingsGet: vi.fn(),
  convGet: vi.fn(),
  dnaGet: vi.fn(),
  dnaSet: vi.fn(),
  universe: vi.fn(),
  candles: vi.fn(),
  settingsGet: vi.fn(),
}));

vi.mock("@/lib/finnhub", () => ({ getCandles: deps.candles }));

vi.mock("@/lib/factorUniverse", () => ({ getFactorUniverse: deps.universe }));

vi.mock("@/lib/firebase-admin", () => ({
  db: {
    collection: vi.fn((name: string) => {
      if (name === "userSettings") return { doc: vi.fn(() => ({ get: deps.settingsGet })) };
      if (name !== "users") throw new Error(`unexpected collection ${name}`);
      return {
        doc: vi.fn(() => ({
          collection: vi.fn((sub: string) => {
            if (sub === "holdings") return { get: deps.holdingsGet };
            if (sub === "convictions") return { select: vi.fn(() => ({ get: deps.convGet })) };
            if (sub === "investorDNA") return { doc: vi.fn(() => ({ get: deps.dnaGet, set: deps.dnaSet })) };
            throw new Error(`unexpected subcollection ${sub}`);
          }),
        })),
      };
    }),
  },
}));

import { deriveAndCacheDna, loadDnaSummary, readCachedDna } from "./investorDnaStore";
import { DNA_VERSION } from "./investorDna";

function stock(ticker: string, price: number, f: Partial<FactorScores> = {}): Stock {
  return {
    ticker, name: ticker, sector: "Technology", price, chg: 0,
    f: { mom: 60, growth: 60, quality: 60, analyst: 60, value: 60, health: 60, ...f },
    mv: { week: 0, month: 0, year: 0 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.dnaSet.mockResolvedValue(undefined);
  deps.candles.mockResolvedValue({ s: "no_data", c: [], t: [] });
  deps.settingsGet.mockResolvedValue({ data: () => ({}) });
});

describe("deriveAndCacheDna", () => {
  it("derives from holdings + universe and writes the cache snapshot", async () => {
    deps.holdingsGet.mockResolvedValue({ empty: false, docs: [{ data: () => ({ ticker: "AAA", shares: 2, avgCost: 50 }) }] });
    deps.convGet.mockResolvedValue({ size: 3 });
    deps.universe.mockResolvedValue({ stocks: [stock("AAA", 100, { mom: 90 })] });

    const dna = await deriveAndCacheDna("user_123");

    expect(dna).not.toBeNull();
    expect(dna!.holdingsCount).toBe(1);
    expect(deps.dnaSet).toHaveBeenCalledTimes(1);
    expect(deps.dnaSet.mock.calls[0][0]).toMatchObject({ archetype: expect.any(String), version: DNA_VERSION });
  });

  it("benchmarks positions from daily closes over their holding window", async () => {
    deps.holdingsGet.mockResolvedValue({
      empty: false,
      docs: [{ data: () => ({ ticker: "AAA", shares: 2, avgCost: 50, acquiredAt: "2026-01-02T00:00:00Z" }) }],
    });
    deps.universe.mockResolvedValue({ stocks: [stock("AAA", 100, { mom: 90 })] });
    const t = [Date.parse("2026-01-02T00:00:00Z") / 1000, Date.parse("2026-09-15T00:00:00Z") / 1000];
    deps.candles.mockImplementation(async (sym: string) =>
      sym === "SPY" ? { s: "ok", t, c: [100, 110] } : { s: "ok", t, c: [50, 60] }
    );

    const dna = await deriveAndCacheDna("user_123");

    expect(deps.candles).toHaveBeenCalledWith("SPY", "D", expect.any(Number), expect.any(Number));
    expect(dna!.benchmark).toMatchObject({ benchmarked: 1, excessVsSpyPct: 10, basis: "purchase" }); // +20% vs +10%
  });

  it("returns null and skips the cache write when nothing joins the universe", async () => {
    deps.holdingsGet.mockResolvedValue({ empty: false, docs: [{ data: () => ({ ticker: "ZZZ", shares: 2, avgCost: 50 }) }] });
    deps.convGet.mockResolvedValue({ size: 0 });
    deps.universe.mockResolvedValue({ stocks: [stock("AAA", 100)] });

    const dna = await deriveAndCacheDna("user_123");

    expect(dna).toBeNull();
    expect(deps.dnaSet).not.toHaveBeenCalled();
  });

  it("short-circuits with no holdings — skips the costly universe compute", async () => {
    deps.holdingsGet.mockResolvedValue({ empty: true, docs: [] });

    const dna = await deriveAndCacheDna("user_123");

    expect(dna).toBeNull();
    expect(deps.universe).not.toHaveBeenCalled();
    expect(deps.dnaSet).not.toHaveBeenCalled();
  });
});

describe("readCachedDna", () => {
  it("returns the cached snapshot when present", async () => {
    deps.dnaGet.mockResolvedValue({ exists: true, data: () => ({ archetype: "Quality compounder", version: DNA_VERSION }) });
    expect(await readCachedDna("user_123")).toMatchObject({ archetype: "Quality compounder" });
  });

  it("treats a snapshot from an older shape as missing (it overclaimed an edge)", async () => {
    deps.dnaGet.mockResolvedValue({ exists: true, data: () => ({ archetype: "Quality compounder" }) });
    expect(await readCachedDna("user_123")).toBeNull();
  });

  it("returns null when no snapshot exists", async () => {
    deps.dnaGet.mockResolvedValue({ exists: false });
    expect(await readCachedDna("user_123")).toBeNull();
  });

  it("returns null if the read throws", async () => {
    deps.dnaGet.mockRejectedValue(new Error("firestore down"));
    expect(await readCachedDna("user_123")).toBeNull();
  });
});

describe("loadDnaSummary", () => {
  it("returns the inferred-profile block from the cached snapshot", async () => {
    deps.holdingsGet.mockResolvedValue({ empty: false, docs: [{ data: () => ({ ticker: "AAA", shares: 2, avgCost: 50 }) }] });
    deps.universe.mockResolvedValue({ stocks: [stock("AAA", 100, { mom: 90 })] });
    const dna = await deriveAndCacheDna("user_123");
    deps.dnaGet.mockResolvedValue({ exists: true, data: () => dna });

    const summary = await loadDnaSummary("user_123");

    expect(summary).toContain("inferred from your holdings");
    expect(deps.universe).toHaveBeenCalledTimes(1); // never recomputes on the chat path
  });

  it("returns null when the user turned Investor DNA off", async () => {
    deps.settingsGet.mockResolvedValue({ data: () => ({ allowInvestorDNA: false }) });
    deps.dnaGet.mockResolvedValue({ exists: true, data: () => ({ version: DNA_VERSION }) });
    expect(await loadDnaSummary("user_123")).toBeNull();
    expect(deps.dnaGet).not.toHaveBeenCalled();
  });

  it("returns null with no snapshot, and never throws", async () => {
    deps.dnaGet.mockResolvedValue({ exists: false });
    expect(await loadDnaSummary("user_123")).toBeNull();
    deps.settingsGet.mockRejectedValue(new Error("down"));
    expect(await loadDnaSummary("user_123")).toBeNull();
  });
});
