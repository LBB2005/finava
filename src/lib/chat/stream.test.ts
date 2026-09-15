import { describe, expect, it } from "vitest";
import { applyFinalResponse, collectAgentStream, collectChatStream, readSseData } from "./stream";
import type { AgentEvent } from "@/types/chat";

/** A ReadableStream that emits each string as its own chunk (optionally split mid-line). */
function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

const line = (e: unknown) => `data: ${JSON.stringify(e)}\n`;

describe("applyFinalResponse", () => {
  it("appends deltas", () => {
    expect(applyFinalResponse("Hello", { content: " world" })).toBe("Hello world");
  });
  it("replaces when the event says so", () => {
    expect(applyFinalResponse("draft", { content: "full report", replace: true })).toBe("full report");
  });
});

describe("readSseData", () => {
  it("reassembles lines split across chunks and flushes a trailing line", async () => {
    const seen: string[] = [];
    await readSseData(sseBody(['data: {"a"', ':1}\ndata: {"b":2}']), (d) => seen.push(d));
    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("collectAgentStream", () => {
  it("saves the concatenation of N final_response deltas, not the last token", async () => {
    const deltas = ["## Summary", " & Recommendation\n", "NVDA looks ", "fairly valued.", " Not financial", " advice.*"];
    const chunks = [
      line({ type: "agent_start", agent: "run_dcf_agent" }),
      ...deltas.map((d) => line({ type: "final_response", content: d })),
      line({ type: "done" }),
    ];
    const events: AgentEvent[] = [];
    const final = await collectAgentStream(sseBody(chunks), (e) => events.push(e));
    expect(final).toBe(deltas.join(""));
    expect(events.filter((e) => e.type === "final_response")).toHaveLength(deltas.length);
  });

  it("a replace:true event resets the accumulated text", async () => {
    const chunks = [
      line({ type: "final_response", content: "partial rev" }),
      line({ type: "final_response", content: "Full report.", replace: true }),
      line({ type: "final_response", content: " Note." }),
    ];
    expect(await collectAgentStream(sseBody(chunks), () => {})).toBe("Full report. Note.");
  });

  it("ignores malformed lines", async () => {
    const chunks = ["data: not-json\n", line({ type: "final_response", content: "ok" })];
    expect(await collectAgentStream(sseBody(chunks), () => {})).toBe("ok");
  });
});

describe("collectChatStream", () => {
  it("concatenates text chunks and reports followups", async () => {
    const followups: string[][] = [];
    const text: string[] = [];
    const chunks = [
      line({ text: "An ETF " }),
      line({ text: "is a fund." }),
      line({ followups: ["What fees?"] }),
      "data: [DONE]\n",
    ];
    const full = await collectChatStream(sseBody(chunks), {
      onText: (t) => text.push(t),
      onFollowups: (f) => followups.push(f),
    });
    expect(full).toBe("An ETF is a fund.");
    expect(text).toEqual(["An ETF ", "is a fund."]);
    expect(followups).toEqual([["What fees?"]]);
  });
});
