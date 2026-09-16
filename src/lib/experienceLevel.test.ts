import { describe, it, expect } from "vitest";
import {
  EXPERIENCE_LEVELS,
  DEFAULT_EXPERIENCE_LEVEL,
  EXPERIENCE_LABELS,
  sanitizeExperienceLevel,
  experiencePromptLine,
} from "./experienceLevel";

describe("sanitizeExperienceLevel", () => {
  it("passes a known level through", () => {
    for (const l of EXPERIENCE_LEVELS) expect(sanitizeExperienceLevel(l)).toBe(l);
  });

  it("falls back to the default for anything else", () => {
    for (const bad of [undefined, null, "expert", 3, {}]) {
      expect(sanitizeExperienceLevel(bad)).toBe(DEFAULT_EXPERIENCE_LEVEL);
    }
  });
});

describe("labels", () => {
  it("names every level", () => {
    for (const l of EXPERIENCE_LEVELS) expect(EXPERIENCE_LABELS[l]).toBeTruthy();
  });
});

describe("experiencePromptLine", () => {
  it("tells the model to define terms for a beginner", () => {
    expect(experiencePromptLine("beginner")).toMatch(/define/i);
  });

  it("tells the model to skip definitions for a professional", () => {
    expect(experiencePromptLine("professional")).toMatch(/without defining/i);
  });

  it("uses the intermediate line when the level is unknown", () => {
    expect(experiencePromptLine(undefined)).toBe(experiencePromptLine("intermediate"));
  });
});
