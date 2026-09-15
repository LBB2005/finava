import { describe, it, expect } from "vitest";
import { getSkillsPrompt } from "./index";
import { DATA_ACCURACY_RULE } from "@/lib/dataAccuracy";

const KNOWN_KEYS = [
  "risk", "news", "macro", "technical", "dcf", "earnings", "insider",
  "sentiment", "competitor", "options", "comparables", "graham", "analyst",
  "hype", "fundamentals",
] as const;

describe("getSkillsPrompt", () => {
  it("returns a composed, non-empty prompt for every known skill", () => {
    for (const key of KNOWN_KEYS) {
      const prompt = getSkillsPrompt(key);
      expect(prompt.length, key).toBeGreaterThan(0);
      // All four sections present.
      expect(prompt, key).toContain("## Your Identity");
      expect(prompt, key).toContain("## Your Strengths");
      expect(prompt, key).toContain("## Analytical Guidelines");
      expect(prompt, key).toContain("## Domain Patterns");
      // Bullet lists are rendered with "- " prefixes.
      expect(prompt, key).toContain("\n- ");
      // The shared data-accuracy rule is appended to every skill prompt.
      expect(prompt, key).toContain(DATA_ACCURACY_RULE);
    }
  });

  it("renders the persona text verbatim for the dcf skill", () => {
    const prompt = getSkillsPrompt("dcf");
    expect(prompt).toContain("DCF modeling experience");
    // Identity section comes before strengths in the composed order.
    expect(prompt.indexOf("## Your Identity")).toBeLessThan(prompt.indexOf("## Your Strengths"));
  });

  it("produces distinct prompts for distinct skills", () => {
    expect(getSkillsPrompt("dcf")).not.toBe(getSkillsPrompt("fundamentals"));
  });

  it("dates the prompts whose analysis depends on today (earnings, news, macro) and only those", () => {
    const clock = /Today is \w+day, \d{1,2} \w+ \d{4} \(US\/Eastern\)\. US market: /;
    for (const key of ["earnings", "news", "macro"]) {
      expect(getSkillsPrompt(key), key).toMatch(clock);
    }
    // Static prompts stay byte-identical across calls (prompt-cache friendly).
    expect(getSkillsPrompt("graham")).not.toMatch(clock);
  });

  it("returns an empty string for an unknown key", () => {
    expect(getSkillsPrompt("nonexistent")).toBe("");
  });

  it("returns an empty string for an empty key", () => {
    expect(getSkillsPrompt("")).toBe("");
  });
});
