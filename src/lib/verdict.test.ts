import { describe, expect, it } from "vitest";
import { verdictFor } from "./verdict";
import type { Stock } from "./research";

const stock = (overrides: Partial<Stock>): Stock => ({
  ticker: "AAA",
  name: "Alpha Analytics",
  sector: "Technology",
  price: 100,
  chg: 0,
  f: { mom: 50, growth: 50, quality: 50, analyst: 50, value: 50, health: 50 },
  mv: { week: 0, month: 0, year: 0 },
  ...overrides,
});

describe("verdictFor", () => {
  it("classifies constructive high-confidence names and narrates leading factors", () => {
    const verdict = verdictFor(stock({
      f: { mom: 95, growth: 90, quality: 88, analyst: 86, value: 35, health: 82 },
    }), "week");

    expect(verdict).toMatchObject({
      stance: "Constructive",
      confidence: "High",
      score: 85,
    });
    expect(verdict.take).toContain("screens constructive");
    expect(verdict.take).toContain("momentum and growth");
  });

  it("classifies cautious names with limited headroom", () => {
    const verdict = verdictFor(stock({
      price: 80,
      f: { mom: 20, growth: 24, quality: 30, analyst: 38, value: 90, health: 34 },
    }), "year");

    expect(verdict.stance).toBe("Cautious");
    expect(verdict.confidence).toBe("Moderate");
    expect(verdict.score).toBe(40);
    expect(verdict.take).toContain("screens cautious");
  });

  it("uses balanced low-confidence language around the middle of the score range", () => {
    const verdict = verdictFor(stock({
      f: { mom: 52, growth: 51, quality: 50, analyst: 53, value: 48, health: 49 },
    }), "month");

    expect(verdict.stance).toBe("Balanced");
    expect(verdict.confidence).toBe("Low");
    expect(verdict.score).toBe(51);
    expect(verdict.take).toContain("screens balanced");
  });

  it("never states a price target or implied upside", () => {
    const verdict = verdictFor(stock({
      f: { mom: 95, growth: 90, quality: 88, analyst: 86, value: 35, health: 82 },
    }), "week");

    expect(verdict.take).not.toMatch(/\$|fair value|upside|headroom/i);
    expect(verdict).not.toHaveProperty("fairValue");
    expect(verdict).not.toHaveProperty("upsidePct");
  });
});
