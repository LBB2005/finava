import { describe, it, expect } from "vitest";
import { GLOSSARY, GlossaryMarks, lookupTerm, findGlossaryHits, shouldShowGlossary } from "./glossary";

describe("GLOSSARY", () => {
  it("covers the jargon beta testers tripped over", () => {
    for (const t of ["P/E", "EV/EBITDA", "DCF", "RSI", "MACD", "SMA", "beta", "13F", "Form 4", "ETF", "expense ratio", "APY", "401(k)", "IRA", "CFP"]) {
      expect(lookupTerm(t), `missing: ${t}`).toBeTruthy();
    }
  });

  it("has at least 60 terms", () => {
    expect(Object.keys(GLOSSARY).length).toBeGreaterThanOrEqual(60);
  });

  it("defines every term in one plain sentence", () => {
    for (const [term, def] of Object.entries(GLOSSARY)) {
      expect(def.length, term).toBeGreaterThan(20);
      expect(def.length, term).toBeLessThanOrEqual(200);
      expect(def.trim().endsWith("."), term).toBe(true);
    }
  });
});

describe("lookupTerm", () => {
  it("is case-insensitive", () => {
    expect(lookupTerm("dcf")).toBe(lookupTerm("DCF"));
  });

  it("matches a plural form", () => {
    expect(lookupTerm("ETFs")).toBe(lookupTerm("ETF"));
  });

  it("returns undefined for an unknown word", () => {
    expect(lookupTerm("moonshot")).toBeUndefined();
  });
});

describe("findGlossaryHits", () => {
  it("marks only the first occurrence of a term", () => {
    const hits = findGlossaryHits("The P/E is high. A high P/E means optimism.");
    expect(hits).toHaveLength(1);
    expect(hits[0].term).toBe("P/E");
    expect(hits[0].start).toBe(4);
  });

  it("does not match inside a longer word", () => {
    expect(findGlossaryHits("betamax ETFsomething")).toHaveLength(0);
  });

  it("prefers the longest term when two overlap", () => {
    const hits = findGlossaryHits("Its EV/EBITDA is 14.");
    expect(hits.map((h) => h.term)).toEqual(["EV/EBITDA"]);
  });

  it("respects an already-seen set across calls, so a message marks once", () => {
    const seen = new Set<string>();
    expect(findGlossaryHits("The DCF says $120.", seen)).toHaveLength(1);
    expect(findGlossaryHits("The DCF again.", seen)).toHaveLength(0);
  });

  it("returns hits in the order they appear", () => {
    const hits = findGlossaryHits("Beta is 1.2 and the RSI is 61.");
    expect(hits.map((h) => h.term)).toEqual(["beta", "RSI"]);
  });

  it("handles empty text", () => {
    expect(findGlossaryHits("")).toEqual([]);
  });
});

describe("GlossaryMarks", () => {
  it("marks a term once across the runs of one message", () => {
    const marks = new GlossaryMarks();
    expect(marks.hits("The DCF says $120.").map((h) => h.term)).toEqual(["DCF"]);
    expect(marks.hits("The DCF again, plus the RSI.").map((h) => h.term)).toEqual(["RSI"]);
  });

  it("gives the same answer when the same run is rendered again", () => {
    const marks = new GlossaryMarks();
    const first = marks.hits("The DCF says $120.");
    const second = marks.hits("The DCF says $120.");
    expect(second).toEqual(first);
  });

  it("keeps marking new terms after a repeat render", () => {
    const marks = new GlossaryMarks();
    marks.hits("Beta is 1.2.");
    marks.hits("Beta is 1.2.");
    expect(marks.hits("The RSI is 61.").map((h) => h.term)).toEqual(["RSI"]);
  });
});

describe("shouldShowGlossary", () => {
  it("is on for beginners and the intermediate default", () => {
    expect(shouldShowGlossary("beginner")).toBe(true);
    expect(shouldShowGlossary("intermediate")).toBe(true);
    expect(shouldShowGlossary(undefined)).toBe(true);
  });

  it("is off for professionals", () => {
    expect(shouldShowGlossary("professional")).toBe(false);
  });
});
