import { describe, expect, it } from "vitest";
import { discoverToMarkdown, parseDiscoverContent } from "./discoverText";
import type { ScoutPick } from "@/lib/scoutTypes";

const pick = (ticker: string, fitRank: number, reason: string): ScoutPick => ({
  ticker,
  name: `${ticker} Corp`,
  sector: "Energy",
  score: 80,
  grade: "A",
  fitRank,
  f: {} as ScoutPick["f"],
  reason,
});

describe("discoverToMarkdown", () => {
  it("renders a shortlist as a ranked list with one-line reasons", () => {
    const md = discoverToMarkdown({
      kind: "shortlist",
      tier: "quick",
      query: "cheap energy names",
      framing: "Energy names screened on value.",
      picks: [pick("CVX", 2, "Strong FCF."), pick("XOM", 1, "Low P/E.")],
    });
    expect(md).toContain("cheap energy names");
    expect(md).toContain("Energy names screened on value.");
    expect(md.indexOf("XOM")).toBeLessThan(md.indexOf("CVX"));
    expect(md).toContain("1. **XOM** (XOM Corp) — Low P/E.");
    expect(md).toContain("2. **CVX** (CVX Corp) — Strong FCF.");
  });

  it("renders a wave as a one-line progress note", () => {
    const md = discoverToMarkdown({
      kind: "wave",
      totalWaves: 3,
      wave: { waveIndex: 0, tickers: ["XOM", "CVX"], valuationTickers: [], batch: {}, valuation: {} },
    });
    expect(md).toBe("Crew wave 1 of 3 analyzed: XOM, CVX.");
  });

  it("returns the final report unchanged", () => {
    expect(discoverToMarkdown({ kind: "final", report: "## Ranking\n1. XOM" })).toBe("## Ranking\n1. XOM");
  });
});

describe("parseDiscoverContent", () => {
  it("parses stored JSON with a known kind", () => {
    expect(parseDiscoverContent('{"kind":"final","report":"hi"}')).toEqual({ kind: "final", report: "hi" });
  });
  it("returns null for markdown or unknown shapes", () => {
    expect(parseDiscoverContent("1. **XOM**")).toBeNull();
    expect(parseDiscoverContent('{"foo":1}')).toBeNull();
    expect(parseDiscoverContent(undefined)).toBeNull();
  });
});
