/**
 * Smoke: saved answers parse into the answer contract, and a stopped answer is
 * kept (in the transcript, in storage, and after a reload).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { parseAnswer } from "@/lib/answerFormat";
import type { Fetcher } from "@/lib/chat/requests";
import { useChatStore } from "@/stores/chatStore";
import { Conversation } from "../lib/conversation";
import { contractShape } from "../lib/metrics";
import { fixtureResponse, loadFixture } from "../lib/replay";

beforeEach(() => {
  useChatStore.setState({ streamsByConv: {}, messagesByConv: {} });
});

const serve = (name: string): Fetcher => async (_url, init) => fixtureResponse(loadFixture(name), 5, init?.signal);

describe("contract-shaped answers parse", () => {
  it("a crew report parses into every contract section, verdict first", async () => {
    const c = new Conversation(serve("agent-crew-streamed-revision"));
    const t = await c.send("agent", "full analysis of NVDA");
    const parsed = parseAnswer(t.assistant!.content);
    expect(parsed.answer).toMatch(/^NVDA still screens as a high-quality business/);
    expect(parsed.keyNumbers?.map((r) => r.metric)).toEqual([
      "Price",
      "Forward P/E",
      "Data-centre revenue (FY2026)",
      "Options implied move",
    ]);
    expect(parsed.keyNumbers?.find((r) => r.metric === "Options implied move")?.unavailable).toBe(true);
    expect(parsed.bull).toContain("Data-centre revenue grew");
    expect(parsed.bear).toContain("guidance miss");
    expect(parsed.changeView).toContain("capex cut");
    expect(parsed.confidence).toMatch(/^Medium/);
    expect(parsed.details).toContain("Insider activity");
    expect(contractShape(t.assistant!.content)).toEqual({ kind: "full", missing: [] });
  });

  it("a fast answer parses, and so does every partial frame on the way", async () => {
    const frames: string[] = [];
    const fetcher = serve("chat-fast-nvda");
    const c = new Conversation(fetcher);
    const store = useChatStore.getState;
    const unsub = useChatStore.subscribe((s) => {
      const text = s.streamsByConv[c.id]?.streamingContent;
      if (text && frames.at(-1) !== text) frames.push(text);
    });
    const t = await c.send("simple", "is it too late to buy NVDA?");
    unsub();
    expect(frames.length).toBeGreaterThan(20);
    for (const f of frames) expect(() => parseAnswer(f)).not.toThrow();
    expect(parseAnswer(t.assistant!.content).answer).toMatch(/^At \$182\.40/);
    expect(t.assistant!.followups).toEqual(["Run full analysis", "What about AMD?"]);
    expect(store().slice(c.id).isStreaming).toBe(false);
  });

  it("a conceptual answer may use `## Answer` alone", async () => {
    const c = new Conversation(serve("chat-conceptual-etf"));
    const t = await c.send("simple", "what is an ETF");
    expect(contractShape(t.assistant!.content)).toEqual({ kind: "answer_only", missing: [] });
  });

  it("a reply with no contract headings is reported as such, not as parsed", () => {
    expect(contractShape("Sure — NVDA is up 2% today.").kind).toBe("none");
    expect(contractShape("## Answer\nx\n\n## Key numbers\n| Metric | Value | Source | As of |\n|---|---|---|---|\n| P | 1 | a | b |")).toEqual({
      kind: "partial",
      missing: ["bull", "bear", "changeView", "confidence"],
    });
  });
});

describe("the Stop state is kept", () => {
  const stopAtKeyNumbers = (rendered: string) => rendered.includes("## Key numbers");

  it("fast lane: partial text is committed as a stopped message and the conversation unlocks", async () => {
    const c = new Conversation(serve("chat-fast-nvda"));
    const t = await c.send("simple", "is it too late to buy NVDA?", { stopWhen: stopAtKeyNumbers });
    expect(t.stopped).toBe(true);
    expect(t.assistant).toMatchObject({ role: "assistant", stopped: true, mode: "simple" });
    expect(t.assistant!.content).toContain("## Key numbers");
    expect(loadFixture("chat-fast-nvda").expected.startsWith(t.assistant!.content)).toBe(true);
    const slice = useChatStore.getState().slice(c.id);
    expect(slice.isStreaming).toBe(false);
    expect(slice.streamingContent).toBe("");
    // Nothing from the aborted stream lands after Stop.
    expect(c.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("crew lane: stopped mid-report keeps the partial, marks it stopped, and survives a reload", async () => {
    const c = new Conversation(serve("agent-crew-streamed-revision"));
    const t = await c.send("agent", "full analysis of NVDA", { stopWhen: stopAtKeyNumbers });
    expect(t.stopped).toBe(true);
    expect(t.assistant).toMatchObject({ stopped: true, mode: "agent" });
    const partial = t.assistant!.content;
    expect(partial.length).toBeGreaterThan(100);

    c.reload();
    const reloaded = c.messages.at(-1)!;
    expect(reloaded.stopped).toBe(true);
    expect(reloaded.content).toBe(partial);
  });

  it("a new run after Stop is not disturbed by the stopped one", async () => {
    const c = new Conversation(serve("chat-fast-nvda"));
    await c.send("simple", "first", { stopWhen: stopAtKeyNumbers });
    const second = await c.send("simple", "second");
    expect(second.stopped).toBe(false);
    expect(second.assistant!.content).toBe(loadFixture("chat-fast-nvda").expected);
  });
});
