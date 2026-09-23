import { describe, it, expect } from "vitest";
import {
  suggestedWaccFromBeta,
  computeDcf,
  defaultFairValue,
  type DcfInputs,
} from "./dcf";

const baseInputs = (over: Partial<DcfInputs> = {}): DcfInputs => ({
  baseFcf: 1_000_000,
  fcfIsProxy: false,
  sharesOutstanding: 1_000_000,
  netDebt: 0,
  historicalGrowth: 0.08,
  suggestedWacc: 0.09,
  currentPrice: 10,
  currency: "USD",
  ...over,
});

describe("suggestedWaccFromBeta", () => {
  it("uses 4% risk-free + beta*5% premium for a normal beta", () => {
    expect(suggestedWaccFromBeta(1)).toBeCloseTo(0.09, 10); // 0.04 + 1*0.05
  });
  it("clamps a low/negative beta up to the 7% floor", () => {
    expect(suggestedWaccFromBeta(0)).toBe(0.07); // raw 0.04 -> floor
    expect(suggestedWaccFromBeta(-2)).toBe(0.07);
  });
  it("clamps a high beta down to the 13% ceiling", () => {
    expect(suggestedWaccFromBeta(3)).toBe(0.13); // raw 0.19 -> ceiling
  });
  it("treats null/non-finite beta as beta=1", () => {
    expect(suggestedWaccFromBeta(null)).toBeCloseTo(0.09, 10);
    expect(suggestedWaccFromBeta(NaN)).toBeCloseTo(0.09, 10);
    expect(suggestedWaccFromBeta(Infinity)).toBeCloseTo(0.09, 10);
  });
});

describe("computeDcf", () => {
  it("returns all-null fair value when baseFcf is missing or non-positive", () => {
    const r = computeDcf(baseInputs({ baseFcf: null }), { wacc: 0.09, growth: 0.08 });
    expect(r.fairValue).toBeNull();
    expect(r.equityValue).toBeNull();
    expect(r.pvExplicit).toBe(0);
    expect(r.pvTerminal).toBe(0);
    expect(r.upsidePct).toBeNull();

    const neg = computeDcf(baseInputs({ baseFcf: -5 }), { wacc: 0.09, growth: 0.08 });
    expect(neg.fairValue).toBeNull();
  });

  it("returns all-null when wacc is non-positive or non-finite", () => {
    expect(computeDcf(baseInputs(), { wacc: 0, growth: 0.08 }).fairValue).toBeNull();
    expect(computeDcf(baseInputs(), { wacc: NaN, growth: 0.08 }).fairValue).toBeNull();
  });

  it("returns null fair value when shares outstanding is missing, but equity is still computable", () => {
    const r = computeDcf(baseInputs({ sharesOutstanding: null }), { wacc: 0.09, growth: 0.08 });
    expect(r.fairValue).toBeNull();
    expect(r.equityValue).not.toBeNull();
    expect(r.equityValue!).toBeGreaterThan(0);
  });

  it("produces a positive fair value and PV components for healthy inputs", () => {
    const r = computeDcf(baseInputs(), { wacc: 0.09, growth: 0.08 });
    expect(r.fairValue!).toBeGreaterThan(0);
    expect(r.pvExplicit).toBeGreaterThan(0);
    expect(r.pvTerminal).toBeGreaterThan(0);
    expect(r.equityValue!).toBeCloseTo(r.pvExplicit + r.pvTerminal, 6); // netDebt 0
  });

  it("is monotonic: a higher WACC lowers fair value", () => {
    const low = computeDcf(baseInputs(), { wacc: 0.08, growth: 0.08 }).fairValue!;
    const high = computeDcf(baseInputs(), { wacc: 0.12, growth: 0.08 }).fairValue!;
    expect(high).toBeLessThan(low);
  });

  it("net cash (negative netDebt) raises equity value vs net debt", () => {
    const cash = computeDcf(baseInputs({ netDebt: -500_000 }), { wacc: 0.09, growth: 0.08 }).equityValue!;
    const debt = computeDcf(baseInputs({ netDebt: 500_000 }), { wacc: 0.09, growth: 0.08 }).equityValue!;
    expect(cash - debt).toBeCloseTo(1_000_000, 6);
  });

  it("refuses a terminal growth at or above WACC instead of clamping it", () => {
    // This used to clamp to `wacc - 0.005`, which produced an enormous terminal
    // value that looked precise and was entirely arbitrary.
    for (const terminalGrowth of [0.09, 0.2]) {
      const r = computeDcf(baseInputs(), { wacc: 0.09, growth: 0.05, terminalGrowth });
      expect(r.fairValue).toBeNull();
      expect(r.gaps).toContain("terminal_growth_exceeds_wacc");
    }
  });

  it("still values a terminal growth legitimately below WACC", () => {
    const r = computeDcf(baseInputs(), { wacc: 0.09, growth: 0.05, terminalGrowth: 0.025 });
    expect(r.pvTerminal).toBeGreaterThan(0);
    expect(r.gaps).toEqual([]);
  });

  describe("unknown net debt is not zero", () => {
    it("returns no fair value when net debt is unknown", () => {
      const r = computeDcf(baseInputs({ netDebt: null }), { wacc: 0.09, growth: 0.08 });
      expect(r.fairValue).toBeNull();
      expect(r.equityValue).toBeNull();
      expect(r.gaps).toContain("net_debt_unknown");
    });

    it("still reports the enterprise value it could compute", () => {
      // The equity bridge is what is unknown, not the cash flows.
      const r = computeDcf(baseInputs({ netDebt: null }), { wacc: 0.09, growth: 0.08 });
      expect(r.pvExplicit).toBeGreaterThan(0);
      expect(r.pvTerminal).toBeGreaterThan(0);
    });

    it("treats an explicit zero as a real zero, not a gap", () => {
      const r = computeDcf(baseInputs({ netDebt: 0 }), { wacc: 0.09, growth: 0.08 });
      expect(r.fairValue).not.toBeNull();
      expect(r.gaps).toEqual([]);
    });

    it("flags unknown shares separately from unknown net debt", () => {
      const r = computeDcf(baseInputs({ sharesOutstanding: null }), { wacc: 0.09, growth: 0.08 });
      expect(r.fairValue).toBeNull();
      expect(r.gaps).toContain("shares_unknown");
      expect(r.gaps).not.toContain("net_debt_unknown");
    });

    it("names both gaps when both inputs are missing", () => {
      const r = computeDcf(baseInputs({ netDebt: null, sharesOutstanding: null }), { wacc: 0.09, growth: 0.08 });
      expect(r.gaps).toEqual(expect.arrayContaining(["net_debt_unknown", "shares_unknown"]));
    });
  });

  it("computes upside sign correctly vs current price", () => {
    const cheap = computeDcf(baseInputs({ currentPrice: 1 }), { wacc: 0.09, growth: 0.08 });
    const rich = computeDcf(baseInputs({ currentPrice: 1_000_000 }), { wacc: 0.09, growth: 0.08 });
    expect(cheap.upsidePct!).toBeGreaterThan(0);
    expect(rich.upsidePct!).toBeLessThan(0);
  });

  it("returns null upside when current price is missing", () => {
    const r = computeDcf(baseInputs({ currentPrice: null }), { wacc: 0.09, growth: 0.08 });
    expect(r.upsidePct).toBeNull();
    expect(r.fairValue!).toBeGreaterThan(0);
  });

  it("respects a custom explicit horizon", () => {
    const short = computeDcf(baseInputs(), { wacc: 0.09, growth: 0.08, years: 2 });
    const long = computeDcf(baseInputs(), { wacc: 0.09, growth: 0.08, years: 10 });
    expect(short.fairValue!).not.toBeCloseTo(long.fairValue!, 2);
  });
});

describe("defaultFairValue", () => {
  it("clamps historical growth into [0, 0.25] and returns a value", () => {
    expect(defaultFairValue(baseInputs({ historicalGrowth: 5 }))!).toBeGreaterThan(0); // clamp 25%
    expect(defaultFairValue(baseInputs({ historicalGrowth: -1 }))!).toBeGreaterThan(0); // clamp 0%
  });
  it("falls back to 8% growth when historicalGrowth is null", () => {
    expect(defaultFairValue(baseInputs({ historicalGrowth: null }))!).toBeGreaterThan(0);
  });
  it("returns null when the underlying DCF cannot compute", () => {
    expect(defaultFairValue(baseInputs({ baseFcf: null }))).toBeNull();
  });
});
