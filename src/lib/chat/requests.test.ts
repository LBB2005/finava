import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentBody,
  classifyBody,
  discoverScoutBody,
  simpleChatBody,
  streamAgent,
  streamSimple,
  type Fetcher,
} from "./requests";
import { discoverToMarkdown } from "./discoverText";
import type { ChatMessage, ChatMode } from "@/types/chat";

// ── Fake SSE server ───────────────────────────────────────────────────────────
const enc = new TextEncoder();
function sse(lines: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(typeof l === "string" ? l : `data: ${JSON.stringify(l)}\n`));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

const AGENT_REPORT = ["## Summary & Recommendation\n", "NVDA screens as fairly valued; ", "growth is priced in.", "\n\n*Not financial", " advice.*"];
const DEEP_REPORT = ["## Answer\n", "AAPL looks ", "expensive vs peers."];
const SIMPLE_ANSWER = ["An ETF ", "is a basket of securities."];

let calls: { url: string; body: Record<string, unknown> }[] = [];
const fetcher: Fetcher = vi.fn(async (url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}"));
  calls.push({ url, body });
  if (url === "/api/chat") return sse([...SIMPLE_ANSWER.map((text) => ({ text })), "data: [DONE]\n"]);
  const report = body.deepResearch ? DEEP_REPORT : AGENT_REPORT;
  return sse([
    { type: "agent_start", agent: "run_dcf_agent" },
    ...report.map((content) => ({ type: "final_response", content })),
    { type: "done" },
  ]);
});

// ── A tiny transcript driver: the same builders + stream readers ChatEngine uses ──
let transcript: ChatMessage[] = [];
let id = 0;
function push(role: "user" | "assistant", content: string, mode: ChatMode) {
  id += 1;
  transcript.push({ id: `m${id}`, role, content, mode, createdAt: new Date(2026, 8, 15, 0, id).toISOString() });
}

async function turn(mode: ChatMode, text: string) {
  const prior = [...transcript];
  push("user", text, mode);
  if (mode === "simple") {
    const answer = await streamSimple(fetcher, simpleChatBody({ prior, text, portfolioContext: "" }), {
      onText: () => {},
      onFollowups: () => {},
    });
    push("assistant", answer!, "simple");
  } else if (mode === "agent" || mode === "deep_research") {
    const report = await streamAgent(
      fetcher,
      agentBody({ prior, text, portfolioContext: "", deepResearch: mode === "deep_research", holdings: [] }),
      { onEvent: () => {} }
    );
    push("assistant", report!, mode);
  } else if (mode === "discover") {
    calls.push({ url: "/api/agent#scout", body: discoverScoutBody({ prior, text, portfolioContext: "", tier: "quick" }) });
    push(
      "assistant",
      discoverToMarkdown({
        kind: "shortlist",
        tier: "quick",
        query: text,
        picks: [{ ticker: "XOM", name: "Exxon Mobil", sector: "Energy", score: 81, grade: "A", fitRank: 1, f: {} as never, reason: "Cheapest FCF yield in the group." }],
      }),
      "discover"
    );
  }
}

/** Every piece of text the last request sent as history. */
function lastPayloadHistory(): string {
  const { body } = calls.at(-1)!;
  const turns = (body.messages ?? body.conversationHistory ?? []) as { content: string }[];
  return turns.map((t) => t.content).join("\n");
}

beforeEach(() => {
  calls = [];
  transcript = [];
});

describe("mode-switch suite: every follow-up carries the previous assistant answer", () => {
  it("agent → simple", async () => {
    await turn("agent", "Full analysis of NVDA");
    await turn("simple", "summarize what you just told me");
    expect(transcript[1].content).toBe(AGENT_REPORT.join(""));
    expect(lastPayloadHistory()).toContain(AGENT_REPORT.join(""));
  });

  it("simple → agent", async () => {
    await turn("simple", "what is an ETF");
    await turn("agent", "now run the crew on SPY");
    expect(lastPayloadHistory()).toContain(SIMPLE_ANSWER.join(""));
  });

  it("discover → simple", async () => {
    await turn("discover", "cheap energy names");
    await turn("simple", "why XOM?");
    const history = lastPayloadHistory();
    expect(history).toContain("XOM");
    expect(history).toContain("Cheapest FCF yield in the group.");
    expect(history).not.toContain('"kind"');
  });

  it("discover → agent", async () => {
    await turn("discover", "cheap energy names");
    await turn("agent", "full analysis of the top pick");
    expect(lastPayloadHistory()).toContain("Cheapest FCF yield in the group.");
  });

  it("deep → simple", async () => {
    await turn("deep_research", "deep dive AAPL");
    await turn("simple", "summarize what you just told me");
    expect(lastPayloadHistory()).toContain(DEEP_REPORT.join(""));
  });

  it("agent → discover sends history too", async () => {
    await turn("agent", "Full analysis of NVDA");
    await turn("discover", "find names like that");
    expect(lastPayloadHistory()).toContain(AGENT_REPORT.join(""));
  });
});

describe("builders", () => {
  const prior: ChatMessage[] = [
    { id: "1", role: "user", content: "q1", mode: "agent", createdAt: "a" },
    { id: "2", role: "assistant", content: "a1", mode: "agent", createdAt: "b" },
    { id: "3", role: "user", content: "unanswered", mode: "simple", createdAt: "c" },
  ];

  it("simple body ends with the new user turn", () => {
    const b = simpleChatBody({ prior, text: "q2", portfolioContext: "p", templateId: "t" });
    expect(b.messages.at(-1)).toEqual({ role: "user", content: "unanswered\n\nq2" });
    expect(b.messages[0]).toEqual({ role: "user", content: "q1" });
    expect(b.templateId).toBe("t");
  });

  it("agent history never ends on a user turn (the server appends the prompt)", () => {
    const b = agentBody({ prior, text: "q2", portfolioContext: "", deepResearch: false, holdings: [] });
    expect(b.conversationHistory.at(-1)).toEqual({ role: "assistant", content: "a1" });
    expect(b.userPrompt).toBe("q2");
  });

  it("classify gets a short trailing slice", () => {
    const many: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
      id: String(i), role: i % 2 ? "assistant" : "user", content: `t${i}`, mode: "simple", createdAt: String(i),
    }));
    expect(classifyBody({ prior: many, userPrompt: "x", portfolioContext: "" }).history.length).toBeLessThanOrEqual(6);
  });
});

describe("stream runners", () => {
  it("return null when the response is blocked (e.g. usage cap)", async () => {
    const blocked: Fetcher = async () => new Response("{}", { status: 429 });
    const out = await streamAgent(blocked, agentBody({ prior: [], text: "x", portfolioContext: "", deepResearch: false, holdings: [] }), {
      onEvent: () => {},
      onResponse: async (res) => res.status === 429,
    });
    expect(out).toBeNull();
  });

  it("throw on a failed response", async () => {
    const failing: Fetcher = async () => new Response("nope", { status: 500 });
    await expect(streamSimple(failing, simpleChatBody({ prior: [], text: "x", portfolioContext: "" }), { onText: () => {}, onFollowups: () => {} })).rejects.toThrow();
  });
});
