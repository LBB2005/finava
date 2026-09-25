import { describe, expect, it } from "vitest";
import { fromStoredMessage, toStoredMessage } from "./storedMessage";
import type { ChatMessage } from "@/types/chat";

const base = { id: "m1", role: "assistant", createdAt: "2026-09-15T00:00:00.000Z" };

describe("fromStoredMessage", () => {
  it("restores followups, critique, trace and stopped state", () => {
    const m = fromStoredMessage({
      ...base,
      content: "Report",
      mode: "agent",
      agentTrace: JSON.stringify([{ agent: "run_dcf_agent", status: "complete" }]),
      followups: ["What about margins?"],
      critique: "**Skeptic Review:** thin data",
      stopped: true,
      durationMs: 1200,
    });
    expect(m.followups).toEqual(["What about margins?"]);
    expect(m.critique).toBe("**Skeptic Review:** thin data");
    expect(m.agentTrace?.[0].agent).toBe("run_dcf_agent");
    expect(m.stopped).toBe(true);
    expect(m.durationMs).toBe(1200);
  });

  it("converts legacy JSON discover content to text and keeps the JSON as the attachment", () => {
    const legacy = { kind: "final", report: "Top pick: XOM." };
    const m = fromStoredMessage({ ...base, content: JSON.stringify(legacy), mode: "discover" });
    expect(m.content).toBe("Top pick: XOM.");
    expect(m.attachment).toEqual(legacy);
  });

  it("parses a stored attachment string", () => {
    const att = { kind: "wave", totalWaves: 2, wave: { waveIndex: 0, tickers: ["XOM"], valuationTickers: [], batch: {}, valuation: {} } };
    const m = fromStoredMessage({ ...base, content: "Crew wave 1 of 2 analyzed: XOM.", mode: "discover", attachment: JSON.stringify(att) });
    expect(m.attachment).toEqual(att);
    expect(m.content).toBe("Crew wave 1 of 2 analyzed: XOM.");
  });

  it("tolerates malformed JSON and missing optional fields", () => {
    const m = fromStoredMessage({ ...base, content: "hi", mode: "", agentTrace: "{bad", attachment: "{bad", followups: null, critique: null });
    expect(m.agentTrace).toBeUndefined();
    expect(m.attachment).toBeUndefined();
    expect(m.followups).toBeUndefined();
    expect(m.critique).toBeUndefined();
    expect(m.mode).toBe("agent");
  });
});

describe("toStoredMessage", () => {
  it("builds the POST body with the persisted extras", () => {
    const msg: ChatMessage = {
      id: "x",
      role: "assistant",
      content: "1. **XOM**",
      mode: "discover",
      createdAt: base.createdAt,
      followups: ["Go deeper?"],
      attachment: { kind: "final", report: "1. **XOM**" },
      stopped: true,
    };
    expect(toStoredMessage(msg)).toEqual({
      role: "assistant",
      content: "1. **XOM**",
      mode: "discover",
      followups: ["Go deeper?"],
      attachment: JSON.stringify({ kind: "final", report: "1. **XOM**" }),
      stopped: true,
    });
  });
});

describe("clarify round-trip", () => {
  const clarify = [{ header: "Horizon", question: "What's your time horizon?", options: [{ label: "Long term", description: "3+ years" }, { label: "Swing" }] }];
  const clarifyReply = { skipped: false, answers: [{ header: "Horizon", question: "What's your time horizon?", answer: "Long term" }] };

  it("writes and restores the questions and the reply", () => {
    const ask: ChatMessage = { id: "a", role: "assistant", content: "What's your time horizon?", mode: "fast", createdAt: base.createdAt, clarify };
    const reply: ChatMessage = { id: "b", role: "user", content: "Horizon: Long term", mode: "auto", createdAt: base.createdAt, clarifyReply };
    expect(toStoredMessage(ask).clarify).toEqual(clarify);
    expect(toStoredMessage(reply).clarifyReply).toEqual(clarifyReply);
    // Through JSON, as the API returns it.
    const stored = (m: ChatMessage) => JSON.parse(JSON.stringify(toStoredMessage(m)));
    expect(fromStoredMessage({ ...base, content: ask.content, clarify: stored(ask).clarify }).clarify).toEqual(clarify);
    expect(fromStoredMessage({ ...base, role: "user", content: reply.content, clarifyReply: stored(reply).clarifyReply }).clarifyReply).toEqual(clarifyReply);
  });

  it("re-cleans stored questions and drops malformed ones", () => {
    expect(fromStoredMessage({ ...base, content: "?", clarify: [{ question: "Only one option", options: ["a"] }] }).clarify).toBeUndefined();
    expect(fromStoredMessage({ ...base, content: "?", clarify: "garbage" as never }).clarify).toBeUndefined();
  });

  it("drops a malformed reply", () => {
    expect(fromStoredMessage({ ...base, role: "user", content: "x", clarifyReply: { answers: "nope" } as never }).clarifyReply).toBeUndefined();
    expect(fromStoredMessage({ ...base, role: "user", content: "x", clarifyReply: { skipped: true, answers: [] } }).clarifyReply).toEqual({ skipped: true, answers: [] });
  });
});
