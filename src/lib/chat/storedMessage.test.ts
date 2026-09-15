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
