// src/lib/facts/signals.test.ts
import { describe, expect, it } from "vitest";
import { pillarToSignal, pillarsToSignals, peerPremiumPct } from "./signals";
import type { PillarScore } from "@/lib/finavaScore";

const pillar = (over: Partial<PillarScore> = {}): PillarScore => ({
  key: "valuation", label: "Valuation", weight: 22, score: 71.6,
  factors: [
    { key: "relativeVal", label: "Relative valuation", pillar: "valuation", weight: 0.7, score: 80, detail: "P/E 30.0 vs peers 26.0" },
    { key: "absoluteVal", label: "Absolute (DCF)", pillar: "valuation", weight: 0.3, score: null, detail: "No DCF" },
  ],
  ...over,
});

describe("pillarToSignal", () => {
  it("rounds the score and headlines the most extreme present factor", () => {
    const s = pillarToSignal(pillar());
    expect(s.score).toBe(72);
    expect(s.isNoData).toBe(false);
    expect(s.headline).toBe("Strong relative valuation");
    expect(s.detail).toBe("P/E 30.0 vs peers 26.0");
    expect(s.factors).toHaveLength(2);
  });

  it("marks a pillar with no data instead of scoring it 50 silently", () => {
    const s = pillarToSignal(pillar({ score: null, factors: [] }));
    expect(s.isNoData).toBe(true);
    expect(s.headline).toBe("No data yet");
  });
});

describe("pillarsToSignals", () => {
  it("returns signals in the canonical display order", () => {
    const keys = ["insider", "fundamentals", "valuation"] as const;
    const out = pillarsToSignals(keys.map((k) => pillar({ key: k, label: k })));
    expect(out.map((s) => s.key)).toEqual(["fundamentals", "valuation", "insider"]);
  });
});

describe("peerPremiumPct", () => {
  it("averages P/E and P/S premiums in percent", () => {
    expect(peerPremiumPct({ peTTM: 30, peerPe: 25, psTTM: 6, peerPs: 5 })).toBeCloseTo(20);
  });
  it("ignores a non-positive multiple and is null with nothing usable", () => {
    expect(peerPremiumPct({ peTTM: -4, peerPe: 25, psTTM: 6, peerPs: 5 })).toBeCloseTo(20);
    expect(peerPremiumPct({ peTTM: null, peerPe: null, psTTM: null, peerPs: null })).toBeNull();
  });
});
