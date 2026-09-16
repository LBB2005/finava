// src/lib/facts/format.test.ts
import { describe, expect, it } from "vitest";
import { asOfLabel, factTitle } from "./format";
import { fact, missing } from "./types";

const NOW = new Date("2026-09-15T19:00:00.000Z"); // 15:00 ET

describe("asOfLabel", () => {
  it("shows the Eastern time for an instant earlier the same day", () => {
    expect(asOfLabel("2026-09-15T18:32:00.000Z", NOW)).toBe("as of 14:32 ET");
  });
  it("shows the date for an older instant", () => {
    expect(asOfLabel("2026-09-12T20:00:00.000Z", NOW)).toBe("as of Sep 12");
  });
  it("shows the date for a bare YYYY-MM-DD", () => {
    expect(asOfLabel("2026-06-27", NOW)).toBe("as of Jun 27");
  });
  it("says so when the as-of is unreadable", () => {
    expect(asOfLabel("garbage", NOW)).toBe("as of unknown time");
  });
});

describe("factTitle", () => {
  it("joins source and as-of", () => {
    expect(factTitle(fact(1, { source: "Finnhub quote", asOf: "2026-09-15T18:32:00.000Z" }), NOW)).toBe("Finnhub quote · as of 14:32 ET");
  });
  it("adds the note for a missing value", () => {
    expect(factTitle(missing("SEC EDGAR", "No SEC filings", "2026-09-15T18:32:00.000Z"), NOW)).toBe("SEC EDGAR · as of 14:32 ET · No SEC filings");
  });
});
