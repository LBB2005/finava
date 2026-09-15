import { describe, expect, it } from "vitest";
import { PROVIDER_UNAVAILABLE, toUserFacingError } from "./userFacingError";

describe("toUserFacingError", () => {
  it.each([
    "[llm:dcf] openai/gpt-5.5 request failed (status 402): 402 Insufficient credits. Add more using https://openrouter.ai/settings/credits",
    "429 Too Many Requests",
    "Perplexity 401: invalid api key",
    "upstream 503 Service Unavailable",
    "Request timed out.",
    "Connection error.",
    "OPENROUTER_API_KEY is not set. Add it to .env.local and restart the dev server.",
    "[llm:news] anthropic/claude-sonnet-4.6 returned empty content (finish_reason: length).",
    "rate limit exceeded",
  ])("maps vendor error %j to the generic line", (raw) => {
    expect(toUserFacingError(new Error(raw))).toBe(PROVIDER_UNAVAILABLE);
    expect(toUserFacingError(raw)).toBe(PROVIDER_UNAVAILABLE);
  });

  it("uses the exact copy the plan specifies", () => {
    expect(PROVIDER_UNAVAILABLE).toBe("An AI provider was unavailable for this step.");
  });

  it("keeps our own timeout copy, which contains no vendor detail", () => {
    expect(toUserFacingError(new Error("run_news_agent timed out after 60s"))).toBe(
      "This step took too long and was skipped.",
    );
  });

  it("never leaks a raw status code or vendor name for unknown errors", () => {
    const out = toUserFacingError(new Error("something weird happened at openrouter.ai"));
    expect(out).toBe(PROVIDER_UNAVAILABLE);
  });

  it("handles non-Error values", () => {
    expect(toUserFacingError(undefined)).toBe(PROVIDER_UNAVAILABLE);
    expect(toUserFacingError({ status: 402 })).toBe(PROVIDER_UNAVAILABLE);
  });

  it("is idempotent on already user-facing copy", () => {
    expect(toUserFacingError(PROVIDER_UNAVAILABLE)).toBe(PROVIDER_UNAVAILABLE);
  });
});
