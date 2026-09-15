/**
 * Locks the calibrated multi-LLM routing + the badge display registry so a future
 * edit can't silently re-tier an agent (e.g. drop GPT off DCF) without a failing
 * test. Assumes LLM_ROUTING defaults to "on" (the production default).
 */
import { describe, it, expect, vi } from "vitest";

// llm.ts → usage.ts → firebase-admin pulls server creds at import. We only need
// the static routing table here, so stub the one symbol llm.ts imports.
vi.mock("@/lib/usage", () => ({ recordUsage: () => {} }));

import { AGENT_MODELS, LLM_ROUTING_ON } from "@/lib/llm";
import { slugToBrand, badgeBrands, rosterFromBrands, brandRole, BRAND_META } from "@/lib/models";

describe("calibrated routing (AGENT_MODELS)", () => {
  it("routes the numeric agents to GPT-5.5", () => {
    expect(LLM_ROUTING_ON).toBe(true);
    for (const a of ["dcf", "comparables", "graham", "analyst"] as const) {
      expect(AGENT_MODELS[a]).toBe("openai/gpt-5.5");
    }
  });

  it("routes sentiment to Grok", () => {
    expect(AGENT_MODELS.sentiment).toBe("x-ai/grok-4.3");
  });

  it("keeps news + macro on Gemini Flash (long-context summarization)", () => {
    expect(slugToBrand(AGENT_MODELS.news)).toBe("gemini");
    expect(slugToBrand(AGENT_MODELS.macro)).toBe("gemini");
  });

  it("keeps synthesis & qualitative judgment on Claude", () => {
    for (const a of ["finavaSynthesis", "risk", "competitor", "ceo"] as const) {
      expect(slugToBrand(AGENT_MODELS[a])).toBe("claude");
    }
  });
});

describe("badge display registry", () => {
  it("shows news as a Perplexity → Gemini pipeline", () => {
    expect(badgeBrands("news", AGENT_MODELS.news)).toEqual(["perplexity", "gemini"]);
  });

  it("shows the hype agent as Perplexity (not routed through generate)", () => {
    expect(badgeBrands("hype")).toEqual(["perplexity"]);
  });

  it("maps single-model agents to one brand", () => {
    expect(badgeBrands("dcf", AGENT_MODELS.dcf)).toEqual(["openai"]);
    expect(badgeBrands("sentiment", AGENT_MODELS.sentiment)).toEqual(["grok"]);
  });

  it("maps slugs to the right brands", () => {
    expect(slugToBrand("openai/gpt-5.5")).toBe("openai");
    expect(slugToBrand("x-ai/grok-4.3")).toBe("grok");
    expect(slugToBrand("google/gemini-2.5-flash-lite")).toBe("gemini");
    expect(slugToBrand("anthropic/claude-sonnet-4.6")).toBe("claude");
    expect(slugToBrand("perplexity/sonar")).toBe("perplexity");
  });

  it("de-dupes and display-orders a roster", () => {
    expect(rosterFromBrands(["gemini", "claude", "openai", "gemini", "grok"])).toEqual([
      "claude",
      "openai",
      "gemini",
      "grok",
    ]);
  });
});

describe("brandRole — describes what actually ran", () => {
  it("keeps the static map for presentation only (no role claims)", () => {
    expect(BRAND_META.grok).not.toHaveProperty("role");
    expect(BRAND_META.grok.accent).toBeTruthy();
  });

  it("claims X search for Grok only when the X tool returned posts", () => {
    expect(brandRole("grok", { xSearchPosts: 12 })).toBe("X search");
    expect(brandRole("grok", { xSearchPosts: 0 })).toBeNull();
    expect(brandRole("grok")).toBeNull();
  });

  it("never makes a live/social claim without run metadata", () => {
    for (const b of ["claude", "openai", "gemini", "grok", "perplexity"] as const) {
      expect(brandRole(b) ?? "").not.toMatch(/live|social|x search/i);
    }
  });

  it("claims live web for Perplexity only when sources came back", () => {
    expect(brandRole("perplexity", { webSources: 3 })).toBe("Live web");
    expect(brandRole("perplexity", { webSources: 0 })).toBeNull();
  });
});
