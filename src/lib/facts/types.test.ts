import { describe, expect, it } from "vitest";
import { fact, missing, hasValue, toSlim, SCORE_VERSION, type TickerFacts } from "./types";

describe("fact / missing", () => {
  it("keeps a real value with its source and as-of", () => {
    const f = fact(182.5, { source: "Finnhub quote", asOf: "2026-09-15T20:00:00.000Z", unit: "USD" });
    expect(f).toEqual({ value: 182.5, source: "Finnhub quote", asOf: "2026-09-15T20:00:00.000Z", unit: "USD" });
    expect(hasValue(f)).toBe(true);
  });

  it("turns null, NaN and Infinity into a missing fact with a note", () => {
    for (const v of [null, NaN, Infinity]) {
      const f = fact(v as number | null, { source: "Finnhub quote", asOf: "2026-09-15" });
      expect(f.value).toBeNull();
      expect(f.source).toBe("Finnhub quote");
      expect(f.asOf).toBe("2026-09-15");
      expect(f.note).toBeTruthy();
      expect(hasValue(f)).toBe(false);
    }
  });

  it("uses the caller's note when a value is missing", () => {
    const f = fact(null, { source: "SEC EDGAR", asOf: "2026-09-15", note: "No SEC filings" });
    expect(f.note).toBe("No SEC filings");
  });

  it("applies missingNote only to a missing value", () => {
    const meta = { source: "Finnhub basic financials", asOf: "2026-09-15", missingNote: "Not reported by the source" };
    expect(fact(null, meta).note).toBe("Not reported by the source");
    expect(fact(1.2, meta).note).toBeUndefined();
  });

  it("missing() always carries source, as-of and note", () => {
    const f = missing<number>("SEC EDGAR", "No SEC filings", "2026-09-15T00:00:00.000Z");
    expect(f).toEqual({ value: null, source: "SEC EDGAR", asOf: "2026-09-15T00:00:00.000Z", note: "No SEC filings" });
  });

  it("missing() defaults as-of to now", () => {
    const f = missing<number>("x", "y");
    expect(new Date(f.asOf).toString()).not.toBe("Invalid Date");
  });
});

describe("toSlim", () => {
  it("keeps only ticker and the score headline", () => {
    const score = fact(
      { total: 58, grade: "C", pillars: [], confidence: "Moderate" as const, coverage: 0.8, peerPremiumPct: 12, version: SCORE_VERSION },
      { source: "Finava Score v2 (15 factors)", asOf: "2026-09-15T00:00:00.000Z" }
    );
    const slim = toSlim({ ticker: "AAPL", score } as unknown as TickerFacts);
    expect(slim).toEqual({
      ticker: "AAPL",
      score: { value: { total: 58, grade: "C", version: SCORE_VERSION }, source: "Finava Score v2 (15 factors)", asOf: "2026-09-15T00:00:00.000Z" },
    });
  });

  it("passes a missing score through with its note", () => {
    const slim = toSlim({ ticker: "SPY", score: missing("Finava Score v2", "Not scored yet", "2026-09-15") } as unknown as TickerFacts);
    expect(slim.score).toEqual({ value: null, source: "Finava Score v2", asOf: "2026-09-15", note: "Not scored yet" });
  });
});
