import { describe, expect, it } from "vitest";
import {
  buildDnaSummary,
  computeInvestorDna,
  EDGE_GATE,
  gateTrait,
  lensLineFor,
  normalizeTicker,
  type DnaHolding,
  type PositionHistory,
} from "./investorDna";
import type { FactorScores, Stock } from "./research";

function stock(ticker: string, price: number, f: Partial<FactorScores>, sector = "Technology"): Stock {
  return {
    ticker,
    name: ticker,
    sector,
    price,
    chg: 0,
    f: { mom: 50, growth: 50, quality: 50, analyst: 50, value: 50, health: 50, ...f },
    mv: { week: 0, month: 0, year: 0 },
  };
}

describe("computeInvestorDna", () => {
  it("returns null when there are no holdings", () => {
    expect(computeInvestorDna([], [stock("AAA", 100, {})])).toBeNull();
  });

  it("returns null when no holding matches the universe", () => {
    const holdings: DnaHolding[] = [{ ticker: "ZZZ", shares: 5, avgCost: 10 }];
    expect(computeInvestorDna(holdings, [stock("AAA", 100, {})])).toBeNull();
  });

  it("computes a market-value-weighted dna vector", () => {
    const univ = [stock("AAA", 100, { mom: 100 }), stock("BBB", 100, { mom: 0 })];
    const holdings: DnaHolding[] = [
      { ticker: "AAA", shares: 1, avgCost: 100 }, // value 100
      { ticker: "BBB", shares: 3, avgCost: 100 }, // value 300
    ];
    const dna = computeInvestorDna(holdings, univ)!;
    expect(dna.dnaVector.mom).toBe(25); // (100*100 + 300*0) / 400
    expect(dna.dnaVector.growth).toBe(50); // both 50
    expect(dna.holdingsCount).toBe(2);
  });

  it("computes a real value-weighted track record per factor", () => {
    const univ = [
      stock("M1", 100, { mom: 80 }),
      stock("M2", 100, { mom: 80 }),
      stock("M3", 100, { mom: 80 }),
    ];
    const holdings: DnaHolding[] = [
      { ticker: "M1", shares: 1, avgCost: 50 }, // +100%, value 100
      { ticker: "M2", shares: 1, avgCost: 100 }, // 0%,   value 100
      { ticker: "M3", shares: 2, avgCost: 200 }, // -50%, value 200
    ];
    const dna = computeInvestorDna(holdings, univ)!;
    const mom = dna.traitRecord.find((t) => t.factor === "mom")!;
    expect(mom.total).toBe(3);
    expect(mom.sample).toBe("real");
    expect(mom.hits).toBe(1);
    expect(mom.avgReturnPct).toBe(0); // (100*100 + 100*0 + 200*-50) / 400
    expect(mom.exposurePct).toBe(100);
  });

  it("flags thin samples and keeps knownness low for a single holding", () => {
    const univ = [stock("ONE", 100, { quality: 90, health: 90 })];
    const holdings: DnaHolding[] = [{ ticker: "ONE", shares: 1, avgCost: 80 }]; // +25%
    const dna = computeInvestorDna(holdings, univ)!;
    const q = dna.traitRecord.find((t) => t.factor === "quality")!;
    expect(q.sample).toBe("thin");
    expect(q.total).toBe(1);
    expect(dna.knownness).toBeLessThan(20);
  });

  it("names a quality compounder when quality + health dominate", () => {
    const univ = [stock("QC", 100, { quality: 95, health: 90, mom: 30 })];
    const dna = computeInvestorDna([{ ticker: "QC", shares: 10, avgCost: 90 }], univ)!;
    expect(dna.archetype).toBe("Quality compounder");
  });

  it("never claims an edge from raw P&L without a benchmark", () => {
    const univ = [stock("W1", 100, { mom: 80 }), stock("W2", 100, { mom: 80 })];
    const holdings: DnaHolding[] = [
      { ticker: "W1", shares: 1, avgCost: 50 }, // +100% raw
      { ticker: "W2", shares: 1, avgCost: 60 }, // +66% raw
    ];
    const dna = computeInvestorDna(holdings, univ)!;
    expect(dna.identityLine.toLowerCase()).not.toContain("edge in");
    expect(dna.traitRecord.find((t) => t.factor === "mom")!.verdict).toBe("unbenchmarked");
  });

  it("skips holdings absent from the universe but keeps matched ones", () => {
    const univ = [stock("AAA", 100, { mom: 100 })];
    const holdings: DnaHolding[] = [
      { ticker: "AAA", shares: 1, avgCost: 100 },
      { ticker: "ZZZ", shares: 5, avgCost: 10 }, // not in universe
    ];
    const dna = computeInvestorDna(holdings, univ)!;
    expect(dna.holdingsCount).toBe(1);
    expect(dna.dnaVector.mom).toBe(100);
  });

  it("raises knownness with more holdings and wider sector spread", () => {
    const univ = Array.from({ length: 12 }, (_, i) => stock(`T${i}`, 100, {}, `Sector${i % 6}`));
    const many: DnaHolding[] = univ.map((s) => ({ ticker: s.ticker, shares: 1, avgCost: 100 }));
    const low = computeInvestorDna(many.slice(0, 2), univ)!;
    const high = computeInvestorDna(many, univ)!;
    expect(high.knownness).toBeGreaterThan(low.knownness);
    expect(high.knownness).toBeLessThanOrEqual(100);
  });
});

describe("lensLineFor", () => {
  const NOW = new Date("2026-09-16T00:00:00Z");

  function fixture(excess: number, pointInTime: boolean) {
    const univ = Array.from({ length: 12 }, (_, i) => stock(`M${i}`, 100, { mom: 85 }));
    const holdings: DnaHolding[] = univ.map((s) => ({ ticker: s.ticker, shares: 1, avgCost: 80 }));
    const history = Object.fromEntries(univ.map((s) => [s.ticker, {
      windowStart: "2025-07-16T00:00:00Z", basis: "purchase" as const,
      returnPct: 10 + excess, spyReturnPct: 10, sectorEtf: "XLK", sectorReturnPct: 12,
      entryFactors: pointInTime ? s.f : null,
    }]));
    return { univ, dna: computeInvestorDna(holdings, univ, {}, { history, now: NOW })! };
  }

  it("calls a stock the user's sweet spot only when the trait passes the edge gate", () => {
    const { dna } = fixture(9, true);
    const res = lensLineFor(dna, stock("HOT", 100, { mom: 95 }));
    expect(res?.tone).toBe("edge");
    expect(res?.line).toContain("vs SPY");
  });

  it("warns only when the trait is a gated blind spot", () => {
    const { dna } = fixture(-9, true);
    const res = lensLineFor(dna, stock("HOT", 100, { mom: 95 }));
    expect(res?.tone).toBe("caution");
    expect(res?.line).toContain("vs SPY");
  });

  it("makes no edge claim when the trait is not point-in-time", () => {
    const { dna } = fixture(9, false);
    const res = lensLineFor(dna, stock("HOT", 100, { mom: 95 }));
    expect(res?.tone).not.toBe("edge");
    expect(res?.line ?? "").not.toMatch(/sweet spot|cost you/);
  });

  it("returns null when there is nothing personal to say", () => {
    expect(lensLineFor(null, null)).toBeNull();
  });
});

describe("normalizeTicker", () => {
  it("strips punctuation so class shares match", () => {
    expect(normalizeTicker("BRK.B")).toBe("BRKB");
    expect(normalizeTicker("BRK-B")).toBe("BRKB");
    expect(normalizeTicker("brkb")).toBe("BRKB");
  });
});

describe("computeInvestorDna — coverage + ETFs", () => {
  it("matches holdings to the universe across symbology variants", () => {
    const univ = [stock("BRK.B", 100, { value: 90 })];
    const dna = computeInvestorDna([{ ticker: "BRK-B", shares: 1, avgCost: 50 }], univ)!;
    expect(dna.holdingsCount).toBe(1);
    expect(dna.coverage.uncovered).toEqual([]);
  });

  it("uses ETF profiles for tilt but excludes them from the track record", () => {
    const univ = [stock("AAPL", 100, { quality: 90 })];
    const etf = {
      VOO: { sector: "Broad market ETF", f: { mom: 60, growth: 90, quality: 50, analyst: 50, value: 40, health: 50 } },
    };
    const holdings: DnaHolding[] = [
      { ticker: "AAPL", shares: 1, avgCost: 50 }, // real stock, +100%
      { ticker: "VOO", shares: 10, avgCost: 10 }, // ETF tilt only
    ];
    const dna = computeInvestorDna(holdings, univ, etf)!;
    expect(dna.coverage.analyzed).toBe(2);
    expect(dna.traitRecord.find((t) => t.factor === "growth")).toBeUndefined(); // ETF doesn't fabricate a bucket
    expect(dna.dnaVector.growth).toBeGreaterThan(50); // but it pulls the tilt vector up
  });

  it("lists uncovered tickers and still derives from what's covered", () => {
    const univ = [stock("AAPL", 100, { quality: 90 })];
    const holdings: DnaHolding[] = [
      { ticker: "AAPL", shares: 1, avgCost: 50 },
      { ticker: "BTC", shares: 1, avgCost: 1 },
      { ticker: "TLT", shares: 1, avgCost: 1 },
    ];
    const dna = computeInvestorDna(holdings, univ)!;
    expect(dna.coverage.analyzed).toBe(1);
    expect(dna.coverage.total).toBe(3);
    expect(dna.coverage.uncovered).toEqual(["BTC", "TLT"]);
  });

  it("returns null when nothing is covered", () => {
    const univ = [stock("AAPL", 100, {})];
    expect(computeInvestorDna([{ ticker: "BTC", shares: 1, avgCost: 1 }], univ)).toBeNull();
  });
});

describe("gateTrait — the significance gate", () => {
  const base = { positions: 12, months: 14, excessPct: 9, pointInTime: true };

  it("documents its thresholds", () => {
    expect(EDGE_GATE).toEqual({ minPositions: 8, minMonths: 6, minExcessPts: 5 });
  });

  it("calls an edge only past every threshold", () => {
    expect(gateTrait(base).verdict).toBe("edge");
    expect(gateTrait({ ...base, excessPct: -9 }).verdict).toBe("blind-spot");
    expect(gateTrait({ ...base, excessPct: 4 }).verdict).toBe("no-clear-edge");
    expect(gateTrait({ ...base, excessPct: -4.9 }).verdict).toBe("no-clear-edge");
  });

  it("says too early below 8 positions or 6 months, naming both", () => {
    expect(gateTrait({ ...base, positions: 7 })).toEqual({
      verdict: "too-early",
      line: "Too early to tell — 7 positions, 14 months.",
    });
    expect(gateTrait({ ...base, months: 5.6 }).verdict).toBe("too-early");
    expect(gateTrait({ ...base, positions: 1, months: 1 }).line).toBe("Too early to tell — 1 position, 1 month.");
    expect(gateTrait({ ...base, positions: 1, months: 0.2 }).line).toBe("Too early to tell — 1 position, under a month.");
  });

  it("refuses an edge claim on current (not point-in-time) factors", () => {
    const g = gateTrait({ ...base, pointInTime: false });
    expect(g.verdict).toBe("not-point-in-time");
    expect(g.line).toContain("based on current factors (not point-in-time)");
  });

  it("says unbenchmarked when no excess return could be measured", () => {
    expect(gateTrait({ ...base, excessPct: null }).verdict).toBe("unbenchmarked");
  });
});

describe("computeInvestorDna — benchmarked track record", () => {
  const NOW = new Date("2026-09-16T00:00:00Z");

  function history(p: Partial<PositionHistory> = {}): PositionHistory {
    return {
      windowStart: "2025-07-16T00:00:00Z", basis: "purchase",
      returnPct: 20, spyReturnPct: 12, sectorEtf: "XLK", sectorReturnPct: 15,
      entryFactors: null, ...p,
    };
  }

  it("3 positions: too early to tell, and no edge claim anywhere", () => {
    const univ = [0, 1, 2].map((i) => stock(`S${i}`, 100, { mom: 90 }));
    const holdings: DnaHolding[] = univ.map((s) => ({ ticker: s.ticker, shares: 1, avgCost: 50 }));
    const hist = Object.fromEntries(univ.map((s) => [s.ticker, history({ returnPct: 100, entryFactors: s.f })]));
    const dna = computeInvestorDna(holdings, univ, {}, { history: hist, now: NOW })!;
    const mom = dna.traitRecord.find((t) => t.factor === "mom")!;
    expect(mom.verdict).toBe("too-early");
    expect(mom.verdictLine).toBe("Too early to tell — 3 positions, 14 months.");
    expect(dna.identityLine.toLowerCase()).not.toContain("edge in");
    expect(dna.identityLine).toContain("too early");
  });

  it("12 positions over 14 months: shows value-weighted excess vs SPY and the sector ETF", () => {
    const univ = Array.from({ length: 12 }, (_, i) => stock(`T${i}`, 100, { quality: 88 }));
    const holdings: DnaHolding[] = univ.map((s) => ({ ticker: s.ticker, shares: 1, avgCost: 80 }));
    const hist = Object.fromEntries(univ.map((s, i) => [s.ticker, history({
      returnPct: i < 6 ? 30 : 10, // avg 20
      spyReturnPct: 12,
      sectorReturnPct: 15,
      entryFactors: s.f,
    })]));
    const dna = computeInvestorDna(holdings, univ, {}, { history: hist, now: NOW })!;
    const q = dna.traitRecord.find((t) => t.factor === "quality")!;
    expect(q.excessVsSpyPct).toBe(8);
    expect(q.excessVsSectorPct).toBe(5);
    expect(q.benchmarked).toBe(12);
    expect(q.beatBenchmark).toBe(6); // only the +30% half beat SPY's +12%
    expect(q.months).toBe(14);
    expect(q.pointInTime).toBe(true);
    expect(q.verdict).toBe("edge");
    expect(dna.identityLine.toLowerCase()).toContain("edge in quality");
    expect(dna.benchmark).toMatchObject({ excessVsSpyPct: 8, benchmarked: 12, total: 12, typicalHoldingMonths: 14, basis: "purchase" });
  });

  it("same fixture on current factors shows excess returns but no edge", () => {
    const univ = Array.from({ length: 12 }, (_, i) => stock(`T${i}`, 100, { quality: 88 }));
    const holdings: DnaHolding[] = univ.map((s) => ({ ticker: s.ticker, shares: 1, avgCost: 80 }));
    const hist = Object.fromEntries(univ.map((s) => [s.ticker, history()]));
    const dna = computeInvestorDna(holdings, univ, {}, { history: hist, now: NOW })!;
    const q = dna.traitRecord.find((t) => t.factor === "quality")!;
    expect(q.excessVsSpyPct).toBe(8);
    expect(q.verdict).toBe("not-point-in-time");
    expect(dna.identityLine.toLowerCase()).not.toContain("edge in");
  });

  it("buckets on factors as of the entry date when they exist", () => {
    // Today it scores high momentum, but at purchase it did not — no look-ahead.
    const univ = Array.from({ length: 8 }, (_, i) => stock(`P${i}`, 100, { mom: 90 }));
    const holdings: DnaHolding[] = univ.map((s) => ({ ticker: s.ticker, shares: 1, avgCost: 80 }));
    const hist = Object.fromEntries(univ.map((s) => [s.ticker, history({ entryFactors: { ...s.f, mom: 30 } })]));
    const dna = computeInvestorDna(holdings, univ, {}, { history: hist, now: NOW })!;
    expect(dna.traitRecord.find((t) => t.factor === "mom")).toBeUndefined();
  });

  it("marks a position unbenchmarked when its history is missing, and never invents one", () => {
    const univ = [stock("A", 100, { value: 90 }), stock("B", 100, { value: 90 })];
    const holdings: DnaHolding[] = univ.map((s) => ({ ticker: s.ticker, shares: 1, avgCost: 80 }));
    const dna = computeInvestorDna(holdings, univ, {}, {
      history: { A: history({ spyReturnPct: null }) }, now: NOW,
    })!;
    const v = dna.traitRecord.find((t) => t.factor === "value")!;
    expect(v.benchmarked).toBe(0);
    expect(v.excessVsSpyPct).toBeNull();
    expect(dna.benchmark.excessVsSpyPct).toBeNull();
  });
});

describe("buildDnaSummary", () => {
  const NOW = new Date("2026-09-16T00:00:00Z");

  it("labels the profile as inferred, carries traits, concentration, holding period and too-early flags", () => {
    const univ = [0, 1, 2].map((i) => stock(`S${i}`, 100, { mom: 90 }));
    const holdings: DnaHolding[] = univ.map((s) => ({ ticker: s.ticker, shares: 1, avgCost: 50 }));
    const hist = Object.fromEntries(univ.map((s) => [s.ticker, {
      windowStart: "2026-06-16T00:00:00Z", basis: "added" as const,
      returnPct: 5, spyReturnPct: 3, sectorEtf: "XLK", sectorReturnPct: null, entryFactors: null,
    }]));
    const dna = computeInvestorDna(holdings, univ, {}, { history: hist, now: NOW })!;
    const s = buildDnaSummary(dna);
    expect(s).toContain("inferred from your holdings");
    expect(s).not.toMatch(/your stated/i);
    expect(s).toContain(dna.archetype);
    expect(s).toContain("100% in Technology");
    expect(s).toContain("Typical holding period: 3 months (since added to Finava)");
    expect(s).toContain("+2 pts vs SPY");
    expect(s).toContain("Too early to tell — 3 positions, 3 months.");
    expect(s.length).toBeLessThan(2000);
  });

  it("says Unavailable when nothing was benchmarked", () => {
    const univ = [stock("A", 100, { mom: 90 })];
    const dna = computeInvestorDna([{ ticker: "A", shares: 1, avgCost: 50 }], univ)!;
    expect(buildDnaSummary(dna)).toContain("Benchmarked result: Unavailable");
  });
});
