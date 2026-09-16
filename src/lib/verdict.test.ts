import { describe, expect, it } from "vitest";
import {
  verdictFor,
  hasEnoughData,
  boardRanking,
  heroTag,
  priceMoveLabel,
  boardStatusLabel,
  SIGNAL_STRENGTH_HELP,
} from "./verdict";
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
      signalStrength: "Strong",
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
    expect(verdict.signalStrength).toBe("Moderate");
    expect(verdict.score).toBe(40);
    expect(verdict.take).toContain("screens cautious");
  });

  it("uses balanced low-confidence language around the middle of the score range", () => {
    const verdict = verdictFor(stock({
      f: { mom: 52, growth: 51, quality: 50, analyst: 53, value: 48, health: 49 },
    }), "month");

    expect(verdict.stance).toBe("Balanced");
    expect(verdict.signalStrength).toBe("Weak");
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

describe("verdict labels read as research, not recommendations", () => {
  it("never exposes a 'confidence' field — it is distance from neutral", () => {
    const verdict = verdictFor(stock({ f: { mom: 95, growth: 90, quality: 88, analyst: 86, value: 35, health: 82 } }));
    expect(verdict).not.toHaveProperty("confidence");
    expect(SIGNAL_STRENGTH_HELP).toMatch(/distance from neutral/i);
    expect(SIGNAL_STRENGTH_HELP).toMatch(/not a probability/i);
  });

  it("tags the hero as the top factor rank, not a pick or a score", () => {
    // The board's #1 is the top factor rank; "score" means the facts-layer Finava Score only.
    expect(heroTag("1W")).toBe("1W · TOP FACTOR RANK");
    expect(heroTag("1W")).not.toMatch(/score/i);
    expect(heroTag("1W")).not.toMatch(/pick/i);
  });
});

describe("hasEnoughData", () => {
  it("accepts names scored from real fundamentals", () => {
    expect(hasEnoughData(stock({ fundStatus: "ok", f: { mom: 70, growth: 50, quality: 60, analyst: 50, value: 40, health: 55 } }))).toBe(true);
  });

  it("rejects placeholder fundamentals (source failed or no filings)", () => {
    const f = { mom: 80, growth: 50, quality: 50, analyst: 70, value: 50, health: 50 };
    expect(hasEnoughData(stock({ fundStatus: "failed", f }))).toBe(false);
    expect(hasEnoughData(stock({ fundStatus: "unavailable", f }))).toBe(false);
  });

  it("rejects an all-neutral profile — every factor fell back to 50", () => {
    expect(hasEnoughData(stock({}))).toBe(false);
  });
});

describe("boardRanking", () => {
  const strong = stock({ ticker: "STR", fundStatus: "ok", f: { mom: 90, growth: 80, quality: 80, analyst: 80, value: 60, health: 70 } });
  const weak = stock({ ticker: "WEK", fundStatus: "ok", f: { mom: 30, growth: 40, quality: 40, analyst: 35, value: 50, health: 45 } });
  // A placeholder that would outrank `weak` on its neutral 50s alone.
  const placeholder = stock({ ticker: "PLH", fundStatus: "failed" });

  it("ranks only names with enough data and lists the rest separately", () => {
    const { ranked, notEnoughData } = boardRanking("month", [placeholder, weak, strong]);
    expect(ranked.map((s) => [s.ticker, s.rank])).toEqual([["STR", 1], ["WEK", 2]]);
    expect(notEnoughData.map((s) => s.ticker)).toEqual(["PLH"]);
  });

  it("never features a placeholder as the highest score", () => {
    const { ranked } = boardRanking("week", [placeholder]);
    expect(ranked).toEqual([]);
  });
});

describe("market-session labels", () => {
  const openNow = new Date("2026-09-15T14:00:00Z"); // Tue 10:00 ET
  const weekend = new Date("2026-09-19T15:00:00Z"); // Sat 11:00 ET

  it("says 'today' / LIVE only while the market is open", () => {
    expect(priceMoveLabel(openNow)).toBe("today");
    expect(boardStatusLabel(false, openNow)).toBe("LIVE");
  });

  it("says 'As of <last close>' when the market is closed", () => {
    expect(priceMoveLabel(weekend)).toBe("As of Fri Sep 18 close");
    expect(boardStatusLabel(false, weekend)).toBe("As of Fri Sep 18 close");
  });

  it("shows SYNCING while loading regardless of session", () => {
    expect(boardStatusLabel(true, openNow)).toBe("SYNCING");
    expect(boardStatusLabel(true, weekend)).toBe("SYNCING");
  });
});
