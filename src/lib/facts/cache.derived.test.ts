// src/lib/facts/cache.derived.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeFirestore } from "@/test/fakeFirestore";

const fs = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeFirestore> | null }));
vi.mock("@/lib/firebase-admin", () => ({
  get db() {
    return fs.current!.db;
  },
}));

import { readDerived, writeDerived, clearFactsMemo } from "./cache";
import { fact, missing, SCORE_VERSION, DCF_VERSION, type ScoreFact, type DcfFact } from "./types";

const NOW = new Date("2026-09-15T18:00:00.000Z");
const score = fact<ScoreFact>(
  { total: 58, grade: "C", pillars: [], confidence: "Moderate", coverage: 0.8, peerPremiumPct: null, version: SCORE_VERSION },
  { source: "Finava Score v2 (15 factors)", asOf: NOW.toISOString() }
);
const dcf = fact<DcfFact>(
  {
    fairValue: 171.2, wacc: 0.1, growth: 0.08, terminal: 0.025, version: DCF_VERSION,
    inputs: { baseFcf: 1, fcfIsProxy: false, sharesOutstanding: 1, netDebt: 0, historicalGrowth: 0.08, suggestedWacc: 0.1, currentPrice: 200, currency: "USD" },
  },
  { source: "Finava DCF on SEC EDGAR filings", asOf: NOW.toISOString(), unit: "USD" }
);

beforeEach(() => {
  fs.current = createFakeFirestore();
  clearFactsMemo();
});

describe("derived tier", () => {
  it("round-trips score and dcf through factsCache/{TICKER}", async () => {
    await writeDerived("aapl", { score, dcf }, NOW);
    expect(fs.current!.docs.has("factsCache/AAPL")).toBe(true);
    clearFactsMemo(); // force a Firestore read, not the in-process mirror
    const got = await readDerived("AAPL", { now: () => NOW });
    expect(got.score).toEqual(score);
    expect(got.dcf).toEqual(dcf);
  });

  it("does not write missing facts", async () => {
    await writeDerived("SPY", { score: missing("Finava Score v2", "No factor data"), dcf: missing("SEC EDGAR", "No SEC filings") }, NOW);
    expect(fs.current!.docs.has("factsCache/SPY")).toBe(false);
  });

  it("treats a doc older than 24 h as a miss", async () => {
    await writeDerived("AAPL", { score, dcf }, NOW);
    clearFactsMemo();
    const later = new Date(NOW.getTime() + 86_401_000);
    expect(await readDerived("AAPL", { now: () => later })).toEqual({ score: null, dcf: null });
  });

  it("treats another engine version as a miss", async () => {
    await writeDerived("AAPL", { score: { ...score, value: { ...score.value!, version: "finava-score-v1" } }, dcf }, NOW);
    clearFactsMemo();
    const got = await readDerived("AAPL", { now: () => NOW });
    expect(got.score).toBeNull();
    expect(got.dcf).toEqual(dcf);
  });

  it("reads as a miss when Firestore throws", async () => {
    fs.current = { db: { collection: () => { throw new Error("offline"); } } } as never;
    expect(await readDerived("AAPL", { now: () => NOW })).toEqual({ score: null, dcf: null });
  });
});
