import { describe, it, expect } from "vitest";
import { addToPosition, replacePosition, type PositionInput } from "./holdings";

const existing: PositionInput = {
  shares: 10,
  avgCost: 100,
  companyName: "Apple Inc.",
  sector: "Technology",
};

describe("addToPosition", () => {
  it("sums the shares", () => {
    const merged = addToPosition(existing, { shares: 10, avgCost: 200 });
    expect(merged.shares).toBe(20);
  });

  it("weights the cost basis by share count", () => {
    // 10 @ $100 + 10 @ $200 → 20 @ $150
    expect(addToPosition(existing, { shares: 10, avgCost: 200 }).avgCost).toBe(150);
    // 10 @ $100 + 30 @ $200 → 40 @ $175
    expect(addToPosition(existing, { shares: 30, avgCost: 200 }).avgCost).toBe(175);
  });

  it("preserves the total cost basis", () => {
    const merged = addToPosition({ shares: 3, avgCost: 33.33 }, { shares: 7, avgCost: 71.11 });
    expect(merged.shares * merged.avgCost).toBeCloseTo(3 * 33.33 + 7 * 71.11, 4);
  });

  it("handles fractional shares", () => {
    const merged = addToPosition({ shares: 0.5, avgCost: 400 }, { shares: 1.5, avgCost: 200 });
    expect(merged.shares).toBe(2);
    expect(merged.avgCost).toBe(250);
  });

  it("treats a zero cost basis as a real price, not as missing data", () => {
    // A gifted/vested lot at $0 must drag the average down, not be ignored.
    const merged = addToPosition({ shares: 10, avgCost: 100 }, { shares: 10, avgCost: 0 });
    expect(merged.avgCost).toBe(50);
  });

  it("falls back to the incoming cost when the combined share count is not positive", () => {
    const merged = addToPosition({ shares: 0, avgCost: 100 }, { shares: 0, avgCost: 42 });
    expect(merged.avgCost).toBe(42);
    expect(merged.shares).toBe(0);
  });

  it("rounds away binary-float noise in the average", () => {
    const merged = addToPosition({ shares: 1, avgCost: 0.1 }, { shares: 2, avgCost: 0.2 });
    // (0.1 + 0.4) / 3 = 0.1666666…; must not carry a 17-digit tail.
    expect(String(merged.avgCost).length).toBeLessThanOrEqual(10);
    expect(merged.avgCost).toBeCloseTo(0.166667, 6);
  });

  it("keeps the existing company name and sector when the new lot omits them", () => {
    const merged = addToPosition(existing, { shares: 5, avgCost: 150 });
    expect(merged.companyName).toBe("Apple Inc.");
    expect(merged.sector).toBe("Technology");
  });

  it("prefers a supplied company name and sector over the existing ones", () => {
    const merged = addToPosition(existing, {
      shares: 5,
      avgCost: 150,
      companyName: "Apple Computer",
      sector: "Consumer Tech",
    });
    expect(merged.companyName).toBe("Apple Computer");
    expect(merged.sector).toBe("Consumer Tech");
  });

  it("ignores a blank company name or sector rather than erasing the existing one", () => {
    const merged = addToPosition(existing, { shares: 5, avgCost: 150, companyName: "  ", sector: "" });
    expect(merged.companyName).toBe("Apple Inc.");
    expect(merged.sector).toBe("Technology");
  });

  it("does not mutate either input", () => {
    const before = { ...existing };
    addToPosition(existing, { shares: 5, avgCost: 150 });
    expect(existing).toEqual(before);
  });
});

describe("replacePosition", () => {
  it("takes the incoming shares and cost verbatim", () => {
    const replaced = replacePosition(existing, { shares: 5, avgCost: 250 });
    expect(replaced.shares).toBe(5);
    expect(replaced.avgCost).toBe(250);
  });

  it("keeps the existing company name and sector when the replacement omits them", () => {
    const replaced = replacePosition(existing, { shares: 5, avgCost: 250 });
    expect(replaced.companyName).toBe("Apple Inc.");
    expect(replaced.sector).toBe("Technology");
  });

  it("overrides the company name and sector when the replacement supplies them", () => {
    const replaced = replacePosition(existing, {
      shares: 5,
      avgCost: 250,
      companyName: "Apple Computer",
      sector: "Consumer Tech",
    });
    expect(replaced.companyName).toBe("Apple Computer");
    expect(replaced.sector).toBe("Consumer Tech");
  });
});
