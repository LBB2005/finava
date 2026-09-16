/**
 * Smoke: the 13 cross-lane switches from the Sep-14 readout.
 *
 * The functional audit ran 13 scripted switches across 8 conversations, and all
 * 13 lost or mangled context. The readout grouped the failures as: "lost the
 * referent" (6), "answered about the wrong turn" (4), and "worked only with outside
 * help" (3). These are the same lane pairs, driven through `Conversation` (the
 * real request builders and stream readers) against replayed fixtures. Each
 * switch asserts that the follow-up's payload carries the previous answer in
 * full, not a fragment of it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Fetcher } from "@/lib/chat/requests";
import { useChatStore } from "@/stores/chatStore";
import { Conversation } from "../lib/conversation";
import { fixtureResponse, loadFixture } from "../lib/replay";

const CREW = loadFixture("agent-crew-streamed-revision").expected;
const CREW_REPLACE = loadFixture("agent-crew-replace").expected;
const DEEP = loadFixture("agent-deep-replace-then-delta").expected;
const FAST = loadFixture("chat-fast-nvda").expected;
const DISCOVER_FRAMING = loadFixture("agent-discover-scout").expected;

interface Call { url: string; body: Record<string, unknown> }

/** Serves fixtures by route; `/api/classify` answers from a scripted queue. */
function server(intents: object[] = []) {
  const calls: Call[] = [];
  let seed = 1;
  const fetcher: Fetcher = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, body });
    seed = (seed * 31) % 997;
    if (url === "/api/classify") return Response.json(intents.shift() ?? { intent: "fast" });
    if (url === "/api/chat") return fixtureResponse(loadFixture("chat-fast-nvda"), seed, init?.signal);
    if (body.discover) return fixtureResponse(loadFixture("agent-discover-scout"), seed, init?.signal);
    if (body.deepResearch) return fixtureResponse(loadFixture("agent-deep-replace-then-delta"), seed, init?.signal);
    if (String(body.userPrompt ?? "").includes("[The user read a short answer"))
      return fixtureResponse(loadFixture("agent-crew-replace"), seed, init?.signal);
    return fixtureResponse(loadFixture("agent-crew-streamed-revision"), seed, init?.signal);
  };
  /** Every history turn the last lane request (not the router) sent, joined. */
  const lastHistory = () => {
    const call = [...calls].reverse().find((c) => c.url !== "/api/classify")!;
    const turns = (call.body.messages ?? call.body.conversationHistory ?? []) as { role: string; content: string }[];
    return turns.map((t) => t.content).join("\n\n");
  };
  const lastCall = () => [...calls].reverse().find((c) => c.url !== "/api/classify")!;
  const routerHistory = () => {
    const call = [...calls].reverse().find((c) => c.url === "/api/classify")!;
    return (call.body.history as { content: string }[]).map((t) => t.content).join("\n\n");
  };
  return { fetcher, calls, lastHistory, lastCall, routerHistory };
}

beforeEach(() => {
  useChatStore.setState({ streamsByConv: {}, messagesByConv: {} });
});

const SWITCHES: string[] = [];
function sw(name: string, fn: () => Promise<void>) {
  SWITCHES.push(name);
  it(name, fn);
}

describe("conversation 1: fast → full analysis → fast", () => {
  sw("#1 fast → full analysis (button) sees the fast answer", async () => {
    const srv = server([{ intent: "fast" }]);
    const c = new Conversation(srv.fetcher);
    const first = await c.send("auto", "is it too late to buy NVDA?");
    expect(first.lane).toBe("fast");
    await c.send("full_analysis_button", "");
    expect(srv.lastCall().body.userPrompt).toContain("is it too late to buy NVDA?");
    expect(srv.lastHistory()).toContain(FAST);
  });

  sw("#2 full analysis → fast (\"so yes or no?\") sees the whole report", async () => {
    const srv = server([{ intent: "fast" }, { intent: "fast" }]);
    const c = new Conversation(srv.fetcher);
    await c.send("auto", "is it too late to buy NVDA?");
    await c.send("full_analysis_button", "");
    await c.send("auto", "so yes or no?");
    expect(srv.lastHistory()).toContain(CREW_REPLACE);
    expect(srv.routerHistory()).toContain(CREW_REPLACE);
  });
});

describe("conversation 2: discover → fast → full analysis", () => {
  sw("#3 discover → fast (\"why the top pick?\") sees the shortlist as text", async () => {
    const srv = server([{ intent: "discover" }, { intent: "fast" }]);
    const c = new Conversation(srv.fetcher);
    const d = await c.send("auto", "find cheap energy stocks");
    expect(d.lane).toBe("discover");
    await c.send("auto", "why the top pick?");
    const h = srv.lastHistory();
    expect(h).toContain(DISCOVER_FRAMING);
    expect(h).toContain("**XOM** (Exxon Mobil)");
    expect(h).toContain("Cheapest FCF yield in the group");
    expect(h).not.toContain('"kind"');
  });

  sw("#4 fast → full analysis (Auto) keeps both earlier answers", async () => {
    const srv = server([{ intent: "discover" }, { intent: "fast" }, { intent: "full_analysis" }]);
    const c = new Conversation(srv.fetcher);
    await c.send("auto", "find cheap energy stocks");
    await c.send("auto", "why the top pick?");
    const t = await c.send("auto", "full analysis of that one");
    expect(t.lane).toBe("full_analysis");
    const h = srv.lastHistory();
    expect(h).toContain("**XOM** (Exxon Mobil)");
    expect(h).toContain(FAST);
  });
});

describe("conversation 3: full analysis → discover → full analysis", () => {
  sw("#5 full analysis → discover (\"find names like that\") sends the report", async () => {
    const srv = server([{ intent: "full_analysis" }, { intent: "discover" }]);
    const c = new Conversation(srv.fetcher);
    await c.send("auto", "full analysis of NVDA");
    await c.send("auto", "find names like that");
    expect(srv.lastCall().body.discover).toBe(true);
    expect(srv.lastHistory()).toContain(CREW);
  });

  sw("#6 discover → full analysis of a pick sees the report and the shortlist", async () => {
    const srv = server([{ intent: "full_analysis" }, { intent: "discover" }, { intent: "full_analysis" }]);
    const c = new Conversation(srv.fetcher);
    await c.send("auto", "full analysis of NVDA");
    await c.send("auto", "find names like that");
    await c.send("auto", "full analysis of the second one");
    const h = srv.lastHistory();
    expect(h).toContain(CREW);
    expect(h).toContain("**EOG** (EOG Resources)");
  });
});

describe("conversation 4: deep research → simple → deep research", () => {
  sw("#7 deep → simple (\"summarize what you just told me\") sees the revised report, not the draft", async () => {
    const srv = server();
    const c = new Conversation(srv.fetcher);
    await c.send("deep_research", "deep research on AAPL's valuation");
    await c.send("simple", "summarize what you just told me");
    const h = srv.lastHistory();
    expect(h).toContain(DEEP);
    expect(h).not.toContain("AAPL looks expensive versus peers on ");
  });

  sw("#8 simple → deep research sees the simple answer and the first report", async () => {
    const srv = server();
    const c = new Conversation(srv.fetcher);
    await c.send("deep_research", "deep research on AAPL's valuation");
    await c.send("simple", "summarize what you just told me");
    await c.send("deep_research", "go deeper on the risks");
    const h = srv.lastHistory();
    expect(h).toContain(DEEP);
    expect(h).toContain(FAST);
  });
});

describe("conversation 5: clarify → chip → full analysis", () => {
  sw("#9 clarify → chip reply answers the original question with the clarification", async () => {
    const srv = server([
      { intent: "clarify", clarifyQuestion: "Long-term or short-term?", clarifyChips: ["Long-term", "Short-term"] },
      { intent: "clarify", clarifyQuestion: "again?", clarifyChips: ["x"] },
    ]);
    const c = new Conversation(srv.fetcher);
    const q = await c.send("auto", "what should I buy?");
    expect(q.lane).toBe("clarify");
    expect(q.assistant?.followups).toEqual(["Long-term", "Short-term"]);
    const a = await c.send("auto", "Long-term");
    // A second clarify in a row is refused client-side.
    expect(a.lane).toBe("fast");
    const body = srv.lastCall().body as { messages: { role: string; content: string }[] };
    expect(body.messages.at(-1)!.content).toContain("what should I buy?\n\n[User clarification]: Long-term");
    expect(srv.lastHistory()).toContain("Long-term or short-term?");
  });

  sw("#10 fast → full analysis after a clarify keeps the clarified answer", async () => {
    const srv = server([
      { intent: "clarify", clarifyQuestion: "Long-term or short-term?", clarifyChips: ["Long-term", "Short-term"] },
      { intent: "fast" },
      { intent: "full_analysis" },
    ]);
    const c = new Conversation(srv.fetcher);
    await c.send("auto", "what should I buy?");
    await c.send("auto", "Long-term");
    await c.send("auto", "full analysis of your first idea");
    const h = srv.lastHistory();
    expect(h).toContain("Long-term or short-term?");
    expect(h).toContain(FAST);
  });
});

describe("conversation 6: a stopped crew run → fast", () => {
  sw("#11 stopped full analysis → fast (\"finish that thought\") sees the partial text", async () => {
    const srv = server([{ intent: "full_analysis" }, { intent: "fast" }]);
    const c = new Conversation(srv.fetcher);
    const stopped = await c.send("auto", "full analysis of NVDA", {
      stopWhen: (rendered) => rendered.includes("## Key numbers"),
    });
    expect(stopped.stopped).toBe(true);
    const partial = stopped.assistant!.content;
    expect(partial).toContain("## Answer");
    expect(partial.length).toBeLessThan(CREW.length);
    await c.send("auto", "finish that thought");
    expect(srv.lastHistory()).toContain(partial);
  });
});

describe("conversation 7: reload between lanes", () => {
  sw("#12 full analysis → reload → fast still sees the whole report", async () => {
    const srv = server([{ intent: "full_analysis" }, { intent: "fast" }]);
    const c = new Conversation(srv.fetcher);
    await c.send("auto", "full analysis of NVDA");
    c.reload();
    await c.send("auto", "what was the bear case again?");
    expect(srv.lastHistory()).toContain(CREW);
  });
});

describe("conversation 8: a legacy stored Discover result", () => {
  sw("#13 legacy JSON discover → full analysis reads it as text", async () => {
    const srv = server([{ intent: "full_analysis" }]);
    const c = new Conversation(srv.fetcher);
    c.seed([
      { id: "u1", role: "user", content: "best AI plays", mode: "discover", createdAt: "2026-09-13T10:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        mode: "discover",
        createdAt: "2026-09-13T10:00:30Z",
        content: JSON.stringify({ kind: "final", report: "Top pick: AVGO — custom accelerators with 2 hyperscaler wins." }),
      },
    ]);
    await c.send("auto", "full analysis of the top pick");
    const h = srv.lastHistory();
    expect(h).toContain("Top pick: AVGO — custom accelerators with 2 hyperscaler wins.");
    expect(h).not.toContain('"kind"');
  });
});

describe("the suite", () => {
  it("covers all 13 switches from the readout", () => {
    expect(SWITCHES).toHaveLength(13);
  });
});
