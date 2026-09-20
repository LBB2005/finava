import { describe, expect, it } from "vitest";
import {
  ChatRequestSchema,
  ClassifyRequestSchema,
  MAX_PORTFOLIO_CONTEXT_CHARS,
  MAX_TRANSCRIPT_CHARS,
} from "./chat";
import { AgentRequestSchema } from "./agent";

// These caps bound what one request can put in front of a model. Before them,
// portfolioContext (which lands in the CACHED system prompt) was unbounded and
// turns accepted raw content blocks, so a client could park ~190K tokens at
// cache-write prices or inject its own cache_control / image / document blocks.
const turn = (content: string, role: "user" | "assistant" = "user") => ({ role, content });

describe("chat request caps", () => {
  it("accepts a normal transcript", () => {
    const r = ChatRequestSchema.safeParse({ messages: [turn("hi"), turn("hello", "assistant"), turn("NVDA?")], portfolioContext: "AAPL 10" });
    expect(r.success).toBe(true);
  });

  it("rejects content-block arrays (cache_control / image / document smuggling)", () => {
    const blocks = [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }];
    expect(ChatRequestSchema.safeParse({ messages: [{ role: "user", content: blocks }] }).success).toBe(false);
    const image = [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }];
    expect(ChatRequestSchema.safeParse({ messages: [{ role: "user", content: image }] }).success).toBe(false);
  });

  it("caps portfolioContext", () => {
    const big = "x".repeat(MAX_PORTFOLIO_CONTEXT_CHARS + 1);
    expect(ChatRequestSchema.safeParse({ messages: [turn("q")], portfolioContext: big }).success).toBe(false);
    expect(ClassifyRequestSchema.safeParse({ userPrompt: "q", portfolioContext: big }).success).toBe(false);
  });

  it("caps the whole transcript, not just each turn", () => {
    const chunk = "x".repeat(90_000);
    const messages = Array.from({ length: Math.ceil(MAX_TRANSCRIPT_CHARS / 90_000) + 1 }, () => turn(chunk));
    expect(ChatRequestSchema.safeParse({ messages }).success).toBe(false);
    expect(AgentRequestSchema.safeParse({ conversationHistory: messages }).success).toBe(false);
  });

  it("types agent holdings instead of accepting arbitrary objects", () => {
    expect(AgentRequestSchema.safeParse({ holdings: [{ ticker: "AAPL", shares: 10, avgCost: 150 }] }).success).toBe(true);
    expect(AgentRequestSchema.safeParse({ holdings: [{ ticker: "x".repeat(500), shares: 1 }] }).success).toBe(false);
    expect(AgentRequestSchema.safeParse({ holdings: [{ blob: "x" }] }).success).toBe(false);
  });
});
