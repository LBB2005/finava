import { describe, expect, it } from "vitest";
import { buildHistory, HISTORY_TOKEN_BUDGET } from "./history";
import type { ChatMessage, ChatMode } from "@/types/chat";

let n = 0;
function msg(role: "user" | "assistant", content: string, mode: ChatMode = "simple", extra: Partial<ChatMessage> = {}): ChatMessage {
  n += 1;
  return { id: `m${n}`, role, content, mode, createdAt: new Date(2026, 8, 15, 0, n).toISOString(), ...extra };
}

describe("buildHistory", () => {
  it("keeps every lane in one ordered transcript", () => {
    const messages = [
      msg("user", "Full analysis of NVDA", "agent"),
      msg("assistant", "NVDA crew report", "agent"),
      msg("user", "summarize that", "simple"),
      msg("assistant", "Short summary", "simple"),
      msg("user", "find energy names", "discover"),
      msg("assistant", "1. **XOM** — Exxon", "discover"),
    ];
    expect(buildHistory(messages)).toEqual([
      { role: "user", content: "Full analysis of NVDA" },
      { role: "assistant", content: "NVDA crew report" },
      { role: "user", content: "summarize that" },
      { role: "assistant", content: "Short summary" },
      { role: "user", content: "find energy names" },
      { role: "assistant", content: "1. **XOM** — Exxon" },
    ]);
  });

  it("keeps the newest turns when over budget and never starts on an assistant turn", () => {
    const big = "x".repeat(400); // ~100 tokens
    const messages = [
      msg("user", "old question"),
      msg("assistant", big),
      msg("user", "newer question"),
      msg("assistant", big),
    ];
    const out = buildHistory(messages, 120);
    expect(out[0].role).toBe("user");
    expect(out.at(-1)).toEqual({ role: "assistant", content: big });
    expect(out.some((m) => m.content === "old question")).toBe(false);
  });

  it("truncates a single newest message that alone exceeds the budget instead of dropping it", () => {
    const huge = "y".repeat(10_000);
    const out = buildHistory([msg("user", "q"), msg("assistant", huge)], 500);
    expect(out).toHaveLength(2);
    expect(out[1].content.length).toBeLessThan(huge.length);
    expect(out[1].content.startsWith("yyyy")).toBe(true);
  });

  it("merges consecutive same-role turns and skips empty ones", () => {
    const out = buildHistory([
      msg("user", "first try"),
      msg("user", "second try"),
      msg("assistant", ""),
      msg("assistant", "answer"),
    ]);
    expect(out).toEqual([
      { role: "user", content: "first try\n\nsecond try" },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("turns legacy JSON discover content into readable text", () => {
    const legacy = JSON.stringify({ kind: "final", report: "Top pick: XOM." });
    const out = buildHistory([msg("user", "find energy", "discover"), msg("assistant", legacy, "discover")]);
    expect(out[1].content).toBe("Top pick: XOM.");
  });

  it("has a sane default budget", () => {
    expect(HISTORY_TOKEN_BUDGET).toBeGreaterThan(4000);
  });
});
