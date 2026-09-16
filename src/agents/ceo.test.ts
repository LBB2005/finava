import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "@/types/chat";
import { resetAgentLatencies } from "./crewPlanner";

// ── Scripted Anthropic stream ────────────────────────────────────────────────
// runCeoAgent calls anthropic.messages.stream(...).finalMessage() once per loop
// turn. We feed a queue of scripted final messages.
const finalMessages: unknown[] = [];
// Stand-in for the SDK MessageStream. runCeoAgent now consumes the stream via
// consumeWithIdleTimeout, which registers an `on("text")` handler and may call
// `abort()`. On finalMessage() we replay the scripted message's text through the
// handlers (so the streaming revision pass produces final_response deltas), then
// resolve with that message.
function makeStreamStub() {
  const handlers: ((d: string) => void)[] = [];
  const s = {
    on(event: string, cb: (d: string) => void) {
      if (event === "text") handlers.push(cb);
      return s;
    },
    abort() {},
    finalMessage() {
      const msg = finalMessages.shift() as
        | { content?: { type: string; text?: string }[] }
        | undefined;
      const t = (msg?.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      if (t) handlers.forEach((h) => h(t));
      return Promise.resolve(msg);
    },
  };
  return s;
}
const streamSpy = vi.fn(makeStreamStub);
vi.mock("@/lib/anthropic", () => ({
  anthropic: { messages: { stream: streamSpy } },
  MODEL: "test-model",
}));

// generate() backs both the skeptic critique and the follow-up questions. Each
// test sets these; by default both are empty, so the revision pass short-circuits
// (keeps the draft) and no follow-ups emit — matching the original behaviour.
let skepticCritique = "";
let followupsRaw = "";
const generate = vi.fn(async (opts: { agent?: string }) => {
  if (opts?.agent === "skeptic") return skepticCritique;
  if (opts?.agent === "chatFollowups") return followupsRaw;
  return "";
});
vi.mock("@/lib/llm", () => ({ generate: (o: unknown) => generate(o as { agent?: string }), AGENT_MODELS: {} }));
vi.mock("@/lib/models", () => ({ badgeBrands: () => [] }));
const currentRunCreditsMock = vi.fn(() => 0);
vi.mock("@/lib/usage", () => ({
  recordUsage: vi.fn(async () => {}),
  currentRunCredits: () => currentRunCreditsMock(),
}));
// Default: uncapped. Tests that exercise the cost kill-switch override the cap.
const resolvePlanMock = vi.fn(async (_id?: string) => ({
  source: "subscription",
  degraded: false,
  config: { deepResearchPerRunCap: Infinity },
}));
vi.mock("@/lib/entitlements", () => ({ resolvePlan: (id: string) => resolvePlanMock(id) }));

const checkCache = vi.fn(async () => null as string | null);
vi.mock("@/lib/agentMemory", () => ({
  checkCache: (...a: unknown[]) => checkCache(...(a as [])),
  saveCache: vi.fn(async () => {}),
  extractTickers: vi.fn(() => []),
  getTickerMemory: vi.fn(async () => ""),
  saveTickerMemory: vi.fn(async () => {}),
}));
vi.mock("@/lib/userPreference", () => ({
  getUserPreference: vi.fn(async () => undefined),
  buildStylePrompt: vi.fn(() => ""),
  updateStyleFromConversation: vi.fn(async () => {}),
}));
vi.mock("@/lib/templates.server", () => ({ getTemplateBlock: vi.fn(async () => "") }));
// The real registry shape: every crew tool, plus the scout. W2-2 filters this
// down to the planned crew before offering it to the model, so the mock has to
// carry real names for that filter to be observable.
const CREW_TOOL_NAMES = [
  "run_risk_agent", "run_news_agent", "run_macro_agent", "run_technical_agent",
  "run_dcf_agent", "run_earnings_agent", "run_insider_agent", "run_sentiment_agent",
  "run_competitor_agent", "run_options_agent", "run_comparables_agent",
  "run_graham_agent", "run_analyst_agent", "run_hype_agent", "run_fundamentals_agent",
];
vi.mock("./tools/index", () => ({
  agentTools: CREW_TOOL_NAMES.map((name) => ({ name })),
  allTools: [...CREW_TOOL_NAMES.map((name) => ({ name })), { name: "scout_universe" }],
  scoutTool: { name: "scout_universe" },
}));

// Sub-agents: risk succeeds, news throws (failure isolation). Rest are stubs.
const runRiskAgent = vi.fn(async () => "RISK: weighted beta 1.1");
const runNewsAgent = vi.fn(async () => {
  throw new Error("news upstream 500");
});
vi.mock("./sub-agents/risk-agent", () => ({ runRiskAgent: (...a: unknown[]) => runRiskAgent(...(a as [])) }));
vi.mock("./sub-agents/news-agent", () => ({ runNewsAgent: () => runNewsAgent() }));
const stub = (name: string) => ({ [name]: vi.fn(async () => `${name} ok`) });
vi.mock("./sub-agents/macro-agent", () => stub("runMacroAgent"));
vi.mock("./sub-agents/technical-agent", () => stub("runTechnicalAgent"));
vi.mock("./sub-agents/dcf-agent", () => stub("runDcfAgent"));
vi.mock("./sub-agents/earnings-agent", () => stub("runEarningsAgent"));
vi.mock("./sub-agents/insider-agent", () => stub("runInsiderAgent"));
vi.mock("./sub-agents/sentiment-agent", () => stub("runSentimentAgent"));
vi.mock("./sub-agents/competitor-agent", () => stub("runCompetitorAgent"));
vi.mock("./sub-agents/options-agent", () => stub("runOptionsAgent"));
vi.mock("./sub-agents/comparables-agent", () => stub("runComparablesAgent"));
vi.mock("./sub-agents/graham-agent", () => stub("runGrahamAgent"));
vi.mock("./sub-agents/analyst-agent", () => stub("runAnalystAgent"));
vi.mock("./sub-agents/hype-agent", () => stub("runHypeAgent"));
vi.mock("./sub-agents/fundamentals-agent", () => stub("runFundamentalsAgent"));
const runScoutAgent = vi.fn(async () => "scout picks");
vi.mock("./sub-agents/scout-agent", () => ({ runScoutAgent: (...a: unknown[]) => runScoutAgent(...(a as [])) }));

const toolUse = (id: string, name: string) => ({ type: "tool_use", id, name, input: {} });
const text = (t: string) => ({ type: "text", text: t });

beforeEach(() => {
  finalMessages.length = 0;
  skepticCritique = "";
  followupsRaw = "";
  streamSpy.mockReset().mockImplementation(makeStreamStub);
  generate.mockClear();
  checkCache.mockReset().mockResolvedValue(null);
  runRiskAgent.mockClear();
  runNewsAgent.mockClear();
  runScoutAgent.mockClear();
  currentRunCreditsMock.mockReset().mockReturnValue(0);
  resolvePlanMock.mockClear();
  runRiskAgent.mockImplementation(async () => "RISK: weighted beta 1.1");
  // The planner's rolling latency medians are module state and feed both the ETA
  // and the tool deadline — reset them so one test's timings can't move another's.
  resetAgentLatencies();
});

describe("agentTimeoutMs", () => {
  it("gives deep agents the long cap and standard agents the short cap", async () => {
    const { agentTimeoutMs } = await import("./ceo");
    expect(agentTimeoutMs("run_dcf_agent")).toBe(120_000); // deep
    expect(agentTimeoutMs("run_technical_agent")).toBe(60_000); // standard
    expect(agentTimeoutMs("run_macro_agent")).toBe(120_000); // explicit override
  });
});

describe("withTimeout", () => {
  it("resolves a fast promise", async () => {
    const { withTimeout } = await import("./ceo");
    await expect(withTimeout(Promise.resolve("ok"), 1000, "x")).resolves.toBe("ok");
  });
  it("rejects with a labeled timeout when the promise is too slow", async () => {
    const { withTimeout } = await import("./ceo");
    await expect(withTimeout(new Promise(() => {}), 5, "slowAgent")).rejects.toThrow(
      /slowAgent timed out/,
    );
  });
});

describe("agentDispatch", () => {
  it("maps every crew tool name to a handler function", async () => {
    const { agentDispatch } = await import("./ceo");
    for (const name of ["run_risk_agent", "run_news_agent", "run_dcf_agent", "run_fundamentals_agent"]) {
      expect(agentDispatch[name]).toBeTypeOf("function");
    }
  });
});

describe("runCeoAgent orchestration", () => {
  it("dispatches the requested crew, isolates a failing agent, and emits a final report", async () => {
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_risk_agent"), toolUse("t2", "run_news_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("Final report body")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("analyze AAPL", "", (e) => events.push(e));

    const types = events.map((e) => e.type);
    expect(types).toContain("crew_planned");
    // Risk succeeded → agent_complete; news threw → agent_error (the others kept running).
    expect(events).toContainEqual(expect.objectContaining({ type: "agent_complete", agent: "run_risk_agent" }));
    // …with user-facing copy, never the raw vendor error.
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "agent_error",
        agent: "run_news_agent",
        error: "An AI provider was unavailable for this step.",
      }),
    );
    expect(runRiskAgent).toHaveBeenCalled();
    // Final report reaches the user.
    expect(events).toContainEqual(expect.objectContaining({ type: "final_response", content: expect.stringContaining("Final report body") }));
    expect(types[types.length - 1]).toBe("done");
  });

  it("short-circuits to the cached result without invoking the handler", async () => {
    checkCache.mockResolvedValue("CACHED RISK RESULT");
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_risk_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("done report")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("analyze AAPL", "", (e) => events.push(e));

    expect(runRiskAgent).not.toHaveBeenCalled(); // served from cache
    expect(events).toContainEqual(
      expect.objectContaining({ type: "agent_complete", agent: "run_risk_agent", result: "CACHED RISK RESULT" }),
    );
  });

  it("scopes the run_risk_agent cache key by user + holdings, but not other agents", async () => {
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_risk_agent"), toolUse("t2", "run_news_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("report")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    await runCeoAgent("analyze AAPL", "", () => {}, {
      userId: "userA",
      holdings: [
        { ticker: "NVDA", shares: 5 },
        { ticker: "AAPL", shares: 10 },
      ],
    });

    // Risk output embeds the caller's private holdings, so its cache entry is
    // namespaced per user + a stable (sorted) holdings signature — User B asking
    // about the same tickers can never hit User A's cached portfolio figures.
    expect(checkCache).toHaveBeenCalledWith("run_risk_agent", {
      _userId: "userA",
      _holdings: "AAPL:10,NVDA:5",
    });
    // Impersonal agents keep the shared cross-user cache — bare input, no scoping.
    expect(checkCache).toHaveBeenCalledWith("run_news_agent", {});
  });

  it("runs the skeptic→revision pass and ships the REVISED report, not the draft", async () => {
    skepticCritique = "**Skeptic Review:** the beta claim is unsourced.";
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_risk_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("DRAFT report body")], usage: {} },
      // The revision pass makes a second stream() call — this is its output.
      { stop_reason: "end_turn", content: [text("REVISED report body")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("analyze AAPL", "", (e) => events.push(e));

    const types = events.map((e) => e.type);
    // Skeptic critique is surfaced for transparency…
    expect(types).toContain("skeptic_start");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "skeptic_complete", critique: expect.stringContaining("Skeptic Review") }),
    );
    // …but the user reads the corrected report, and the draft is gone.
    const final = events.find((e) => e.type === "final_response") as { content: string };
    expect(final.content).toContain("REVISED report body");
    expect(final.content).not.toContain("DRAFT report body");
  });

  it("keeps the draft when the skeptic finds nothing (revision short-circuits)", async () => {
    // Default: skepticCritique is empty → the revision stream() is never called,
    // so only the two scripted messages are consumed.
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_risk_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("DRAFT stands")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("analyze AAPL", "", (e) => events.push(e));

    const final = events.find((e) => e.type === "final_response") as { content: string };
    expect(final.content).toContain("DRAFT stands");
    // stream() called exactly twice (loop turn + draft turn), never a 3rd revision turn.
    expect(streamSpy).toHaveBeenCalledTimes(2);
  });

  it("caps crew rounds — after MAX_TOOL_ROUNDS tool turns it drops tools so the CEO must synthesize", async () => {
    // Standard (non-deep) mode allows at most 2 tool rounds. Script two tool turns
    // then a synthesis turn; the 3rd stream() call must be made WITHOUT tools so a
    // run can't keep spawning sequential ~60–120s agent rounds past the 300s cap.
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_risk_agent")], usage: {} },
      { stop_reason: "tool_use", content: [toolUse("t2", "run_dcf_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("Final report body")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("analyze AAPL", "", (e) => events.push(e));

    const calls = streamSpy.mock.calls as unknown as Array<Array<Record<string, unknown>>>;
    expect("tools" in calls[0][0]).toBe(true); // round 1 offers the crew
    expect("tools" in calls[1][0]).toBe(true); // round 2 offers the crew
    expect("tools" in calls[2][0]).toBe(false); // capped → must write the report
    // The run still ships a final report.
    expect(events).toContainEqual(
      expect.objectContaining({ type: "final_response", content: expect.stringContaining("Final report body") }),
    );
  });

  it("skips the expensive revision when the skeptic signs off with VERDICT: OK", async () => {
    // A sound report: the skeptic explicitly approves, so no second full synthesis.
    skepticCritique = "VERDICT: OK";
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_risk_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("SOUND report body")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("analyze AAPL", "", (e) => events.push(e));

    const final = events.find((e) => e.type === "final_response") as { content: string };
    expect(final.content).toContain("SOUND report body");
    // No revision stream() — the sign-off short-circuits the second synthesis.
    expect(streamSpy).toHaveBeenCalledTimes(2);
    // The bare verdict token is never surfaced as a critique.
    expect(events).toContainEqual(
      expect.objectContaining({ type: "skeptic_complete", critique: "" }),
    );
  });

  it("revises but strips the machine VERDICT line from the surfaced critique", async () => {
    skepticCritique = "VERDICT: REVISE\n**Skeptic Review:** the beta claim is unsourced.";
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_risk_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("DRAFT report body")], usage: {} },
      { stop_reason: "end_turn", content: [text("REVISED report body")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("analyze AAPL", "", (e) => events.push(e));

    // Revision fires (3rd stream call) and ships the revised report.
    expect(streamSpy).toHaveBeenCalledTimes(3);
    const final = events.find((e) => e.type === "final_response") as { content: string };
    expect(final.content).toContain("REVISED report body");
    // The surfaced critique keeps the human review text but not the machine verdict.
    const skepticEvent = events.find((e) => e.type === "skeptic_complete") as { critique: string };
    expect(skepticEvent.critique).toContain("Skeptic Review");
    expect(skepticEvent.critique).not.toContain("VERDICT");
  });

  it("aborts the crew when the per-run cost cap is exceeded", async () => {
    // Accumulated spend already over the cap → the loop breaks at its top before
    // the next (expensive) synthesis turn.
    currentRunCreditsMock.mockReturnValue(999);
    resolvePlanMock.mockResolvedValue({
      source: "subscription",
      degraded: false,
      config: { deepResearchPerRunCap: 300 },
    });
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_risk_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("body")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("analyze AAPL", "", (e) => events.push(e), { userId: "u1" });

    // Broke before any synthesis stream() call, and told the user why.
    expect(streamSpy).not.toHaveBeenCalled();
    const final = events.find((e) => e.type === "final_response") as { content: string };
    expect(final.content).toMatch(/usage limit/i);
  });

  it("in discover mode calls only the scout and never announces a crew", async () => {
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("s1", "scout_universe")], usage: {} },
      { stop_reason: "end_turn", content: [text("Here are 5 energy names…")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("find me cheap energy names", "PORTFOLIO", (e) => events.push(e), {
      discover: true,
      tier: "quick",
    });

    expect(runScoutAgent).toHaveBeenCalledTimes(1);
    // The scout is orchestration, not a crew member — no crew panel, no agent rows.
    const types = events.map((e) => e.type);
    expect(types).not.toContain("crew_planned");
    expect(types).not.toContain("agent_start");
    // Discovery bypasses agentOutputs, so the skeptic pass stays off (kept instant).
    expect(types).not.toContain("skeptic_start");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "final_response", content: expect.stringContaining("energy names") }),
    );
  });

  it("emits up to 3 follow-up questions parsed from the model's JSON", async () => {
    followupsRaw = 'Some preamble ["What are the risks?", "How does it compare?", "Q3", "Q4 extra"] trailing';
    finalMessages.push({ stop_reason: "end_turn", content: [text("report")], usage: {} });
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("analyze AAPL", "", (e) => events.push(e));

    const followups = events.find((e) => e.type === "followups") as { questions: string[] };
    expect(followups).toBeTruthy();
    expect(followups.questions).toEqual(["What are the risks?", "How does it compare?", "Q3"]); // capped at 3
  });

  it("does not emit follow-ups when the model returns unparseable text", async () => {
    followupsRaw = "sorry, I can't do that";
    finalMessages.push({ stop_reason: "end_turn", content: [text("report")], usage: {} });
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("analyze AAPL", "", (e) => events.push(e));

    expect(events.map((e) => e.type)).not.toContain("followups");
    expect(events.map((e) => e.type).at(-1)).toBe("done");
  });

  it("appends a length-limit warning when the draft is truncated at max_tokens", async () => {
    // A max_tokens draft with no tool calls → no revision → warning appended directly.
    finalMessages.push({ stop_reason: "max_tokens", content: [text("A very long report cut off")], usage: {} });
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("analyze AAPL", "", (e) => events.push(e));

    const final = events.find((e) => e.type === "final_response") as { content: string };
    expect(final.content).toContain("A very long report cut off");
    expect(final.content).toContain("reached the length limit");
  });

  it("emits a graceful fallback when the loop exhausts MAX_ITERATIONS still asking for tools", async () => {
    // The model never stops requesting tools — the loop caps at MAX_ITERATIONS (10)
    // and finalResponse stays empty, so the user must still get a real message.
    streamSpy.mockImplementation(() => {
      const s = {
        on: () => s,
        abort: () => {},
        finalMessage: async () => ({
          stop_reason: "tool_use",
          content: [toolUse("t", "run_risk_agent")],
          usage: {},
        }),
      };
      return s;
    });
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("analyze AAPL", "", (e) => events.push(e));

    expect(streamSpy).toHaveBeenCalledTimes(10); // MAX_ITERATIONS for non-deep
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "final_response",
        content: expect.stringContaining("ran out of analysis steps"),
      }),
    );
    expect(events.map((e) => e.type).at(-1)).toBe("done");
  });

  it("emits a graceful fallback (not an infinite hang) when the synthesis stream aborts", async () => {
    // Simulate the idle backstop firing: the synthesis stream never yields and its
    // finalMessage rejects (as consumeWithIdleTimeout's abort() causes). The run
    // must surface a clear message and still finish, never hang.
    streamSpy.mockImplementation(() => {
      const s = {
        on: () => s,
        abort: () => {},
        finalMessage: async () => {
          throw new Error("Request was aborted.");
        },
      };
      return s;
    });
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("analyze AAPL", "", (e) => events.push(e));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "final_response",
        content: expect.stringContaining("stalled"),
      }),
    );
    expect(events.map((e) => e.type).at(-1)).toBe("done");
  });
});

describe("crew ↔ dispatch consistency", () => {
  // Mirrors src/agents/tools/index.test.ts. The registry offers these tools to the
  // model; agentDispatch must have a handler for exactly the same set — no more
  // (a handler with no tool is dead code), no fewer (a tool with no handler throws
  // "Unknown agent" at runtime). run_risk_agent is special-cased in the loop (it
  // gets holdings) but is still present in the map.
  const EXPECTED_CREW = [
    "run_risk_agent", "run_news_agent", "run_macro_agent", "run_technical_agent",
    "run_dcf_agent", "run_earnings_agent", "run_insider_agent", "run_sentiment_agent",
    "run_competitor_agent", "run_options_agent", "run_comparables_agent",
    "run_graham_agent", "run_analyst_agent", "run_hype_agent", "run_fundamentals_agent",
  ];

  it("dispatches exactly the canonical crew, each to a function", async () => {
    const { agentDispatch } = await import("./ceo");
    expect(Object.keys(agentDispatch).sort()).toEqual([...EXPECTED_CREW].sort());
    for (const name of EXPECTED_CREW) {
      expect(agentDispatch[name]).toBeTypeOf("function");
    }
  });
});

// ── Prompt truth: the advice line + today's date ─────────────────────────────
// Everything the model is told on a crew run: every system prompt handed to
// stream() plus every string message (the revision instruction lands as one).
function assembledPromptText(): string {
  const calls = streamSpy.mock.calls as unknown as Array<Array<Record<string, unknown>>>;
  return calls
    .map(([params]) => {
      const system = (params.system as { text: string }[]).map((b) => b.text).join("\n");
      const msgs = (params.messages as { content: unknown }[])
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");
      return `${system}\n${msgs}`;
    })
    .join("\n");
}

describe("CEO prompt — advice line", () => {
  async function runWithRevision() {
    skepticCritique = "VERDICT: REVISE\n**Skeptic Review:** unsourced beta.";
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_risk_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("DRAFT")], usage: {} },
      { stop_reason: "end_turn", content: [text("REVISED")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    await runCeoAgent("analyze AAPL", "| AAPL | 10 |", () => {}, { deepResearch: true });
    return assembledPromptText();
  }

  it("never asks for stop-losses, trim levels, rebalance thresholds or actionable recommendations", async () => {
    const prompt = (await runWithRevision()).toLowerCase();
    expect(streamSpy).toHaveBeenCalledTimes(3); // draft turns + the revision pass were both inspected
    for (const banned of ["stop-loss", "trim level", "actionable recommendation", "rebalance threshold"]) {
      expect(prompt, banned).not.toContain(banned);
    }
  });

  it("keeps research framing: scenario levels about the stock, and 'based on your holdings' wording", async () => {
    const prompt = await runWithRevision();
    expect(prompt).toContain("What Would Change the View");
    expect(prompt).toMatch(/scenario levels about the stock/i);
    expect(prompt).toContain("based on your holdings");
    expect(prompt).toMatch(/never call .*"your stated profile"/i);
    expect(prompt).toMatch(/share counts/i);
    // Seen live: "13.1% is above the ~5–7% guideline for a moderate-risk investor".
    expect(prompt).toMatch(/position-size rules of thumb/i);
    expect(prompt).toMatch(/never label the user with a risk tolerance/i);
  });

  it("tells the model today's date and market status", async () => {
    finalMessages.push({ stop_reason: "end_turn", content: [text("report")], usage: {} });
    const { runCeoAgent } = await import("./ceo");
    await runCeoAgent("analyze AAPL", "", () => {});
    expect(assembledPromptText()).toMatch(/Today is \w+day, \d{1,2} \w+ \d{4} \(US\/Eastern\)\. US market: /);
  });
});

describe("final_response replace flag", () => {
  const finals = (events: AgentEvent[]) =>
    events.filter((e) => e.type === "final_response") as { content: string; replace?: boolean }[];

  it("marks a full (non-streamed) report as replace: true", async () => {
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_risk_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("Full draft report")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("analyze AAPL", "", (e) => events.push(e));
    expect(finals(events)).toEqual([{ type: "final_response", content: "Full draft report", replace: true }]);
  });

  it("keeps streamed revision deltas and appended notes as plain deltas", async () => {
    skepticCritique = "VERDICT: REVISE\n**Skeptic Review:** x";
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_risk_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("DRAFT")], usage: {} },
      { stop_reason: "max_tokens", content: [text("REVISED")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("analyze AAPL", "", (e) => events.push(e));
    const f = finals(events);
    expect(f.length).toBe(2); // the revision delta + the truncation note
    expect(f.every((e) => e.replace === undefined)).toBe(true);
  });

  it("marks the no-report fallback as replace: true", async () => {
    currentRunCreditsMock.mockReturnValue(999);
    resolvePlanMock.mockResolvedValue({ source: "subscription", degraded: false, config: { deepResearchPerRunCap: 300 } });
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("analyze AAPL", "", (e) => events.push(e), { userId: "u1" });
    expect(finals(events)[0].replace).toBe(true);
  });
});

// ── W2-2: crew on request (sized, visible, under the cap) ────────────────────

describe("crew planning", () => {
  it("announces the planned crew and an ETA before any agent runs", async () => {
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_dcf_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("report")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("Is NVDA overvalued?", "", (e) => events.push(e));

    const plan = events.find((e) => e.type === "crew_plan") as
      | { agents: string[]; etaSeconds: number; deep?: boolean }
      | undefined;
    expect(plan).toBeTruthy();
    // The valuation rule — 3–5 agents, never the old 12–15.
    expect(plan!.agents.length).toBeGreaterThanOrEqual(3);
    expect(plan!.agents.length).toBeLessThanOrEqual(5);
    expect(plan!.etaSeconds).toBeGreaterThan(0);
    expect(plan!.deep).toBe(false);

    // It lands before any agent lifecycle event, so the UI can pre-size the panel.
    const types = events.map((e) => e.type);
    expect(types.indexOf("crew_plan")).toBeLessThan(types.indexOf("agent_progress"));
    expect(types.indexOf("crew_plan")).toBeLessThan(types.indexOf("agent_start"));
  });

  it("offers the model only the planned agents' tools", async () => {
    finalMessages.push({ stop_reason: "end_turn", content: [text("report")], usage: {} });
    const { runCeoAgent } = await import("./ceo");
    const { planCrew } = await import("./crewPlanner");
    await runCeoAgent("Is NVDA overvalued?", "", () => {});

    const calls = streamSpy.mock.calls as unknown as Array<Array<Record<string, unknown>>>;
    const offered = (calls[0][0].tools as { name: string }[]).map((t) => t.name);
    const planned = planCrew("Is NVDA overvalued?").agents;
    // Exactly the planned crew — the other 11 agents are not on the table at all.
    expect(offered.filter((n) => n !== "scout_universe").sort()).toEqual([...planned].sort());
    // The scout stays available: it is orchestration, not a crew member.
    expect(offered).toContain("scout_universe");
  });

  it("plans a Deep Research crew of 8–10 with a longer ETA, and labels it", async () => {
    finalMessages.push({ stop_reason: "end_turn", content: [text("report")], usage: {} });
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("Is NVDA overvalued?", "", (e) => events.push(e), { deepResearch: true });

    const plan = events.find((e) => e.type === "crew_plan") as { agents: string[]; etaSeconds: number; deep?: boolean };
    expect(plan.agents.length).toBeGreaterThanOrEqual(8);
    expect(plan.agents.length).toBeLessThanOrEqual(10);
    expect(plan.deep).toBe(true);
  });

  it("plans no crew in discover mode", async () => {
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("s1", "scout_universe")], usage: {} },
      { stop_reason: "end_turn", content: [text("picks")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("cheap energy names", "", (e) => events.push(e), { discover: true, tier: "quick" });
    expect(events.map((e) => e.type)).not.toContain("crew_plan");
  });
});

describe("agent_progress events", () => {
  it("reports running → done with an elapsed time, and failed for a broken agent", async () => {
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_risk_agent"), toolUse("t2", "run_news_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("report")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("Should I worry about AMD?", "", (e) => events.push(e));

    const progress = events.filter((e) => e.type === "agent_progress") as {
      agent: string; status: string; ms?: number;
    }[];
    expect(progress).toContainEqual(expect.objectContaining({ agent: "run_risk_agent", status: "running" }));
    const done = progress.find((p) => p.agent === "run_risk_agent" && p.status === "done");
    expect(done).toBeTruthy();
    expect(typeof done!.ms).toBe("number");
    // The news agent throws in this suite — it is reported failed, never silently dropped.
    expect(progress).toContainEqual(expect.objectContaining({ agent: "run_news_agent", status: "failed" }));
  });

  it("marks every planned agent that never ran as skipped, so the panel never hangs on 'pending'", async () => {
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_risk_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("report")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const { planCrew } = await import("./crewPlanner");
    const events: AgentEvent[] = [];
    await runCeoAgent("Should I worry about AMD?", "", (e) => events.push(e));

    const skipped = (events.filter((e) => e.type === "agent_progress") as { agent: string; status: string }[])
      .filter((p) => p.status === "skipped")
      .map((p) => p.agent)
      .sort();
    const planned = planCrew("Should I worry about AMD?").agents;
    expect(skipped).toEqual(planned.filter((a) => a !== "run_risk_agent").sort());
  });
});

describe("wall-clock budget", () => {
  /** A clock the test drives, so the budget is exercised without real waiting. */
  function fakeClock(start = 0) {
    const state = { t: start };
    return { now: () => state.t, advance: (ms: number) => { state.t += ms; }, state };
  }

  it("warns, drops the crew tools and synthesizes once the deadline passes", async () => {
    const clock = fakeClock();
    // A slow agent burns most of the budget before the next round can start.
    runRiskAgent.mockImplementation(async () => { clock.advance(210_000); return "RISK: beta 1.1"; });
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_risk_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("partial report")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("Should I worry about AMD?", "", (e) => events.push(e), { now: clock.now });

    // The user is told the run is against its budget…
    const warn = events.find((e) => e.type === "budget_warning") as { remainingSeconds: number };
    expect(warn).toBeTruthy();
    expect(warn.remainingSeconds).toBeGreaterThanOrEqual(0);
    expect(warn.remainingSeconds).toBeLessThanOrEqual(240);

    // …the second turn is made WITHOUT tools, so no new agent round can start…
    const calls = streamSpy.mock.calls as unknown as Array<Array<Record<string, unknown>>>;
    expect("tools" in calls[0][0]).toBe(true);
    expect("tools" in calls[1][0]).toBe(false);

    // …and the report still ships.
    expect(events).toContainEqual(
      expect.objectContaining({ type: "final_response", content: expect.stringContaining("partial report") }),
    );
    expect(events.map((e) => e.type).at(-1)).toBe("done");
  });

  it("tells the model which agents are missing so the gap is listed, not hidden", async () => {
    const clock = fakeClock();
    runRiskAgent.mockImplementation(async () => { clock.advance(210_000); return "RISK: beta 1.1"; });
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_risk_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("partial report")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    await runCeoAgent("Should I worry about AMD?", "", () => {}, { now: clock.now });

    const prompt = assembledPromptText();
    expect(prompt).toContain("Confidence & gaps");
    // The planned-but-unrun agents are named for the model to report.
    expect(prompt).toContain("News Research");
    expect(prompt).toContain("Macro & Market");
  });

  it("gives an agent no more time than the budget has left", async () => {
    const { crewAgentTimeoutMs } = await import("./ceo");
    // Plenty of budget → the normal crew cap (30–45s).
    const roomy = crewAgentTimeoutMs("run_dcf_agent", 200_000);
    expect(roomy).toBeGreaterThanOrEqual(30_000);
    expect(roomy).toBeLessThanOrEqual(45_000);
    // Nearly out of budget → clamped down to what's left.
    expect(crewAgentTimeoutMs("run_dcf_agent", 12_000)).toBe(12_000);
    // Never zero or negative, however far over budget the run is.
    expect(crewAgentTimeoutMs("run_dcf_agent", -5_000)).toBeGreaterThan(0);
  });
});

describe("CEO prompt — answer contract", () => {
  it("asks for the shared contract headings, with crew detail under Details", async () => {
    finalMessages.push({ stop_reason: "end_turn", content: [text("report")], usage: {} });
    const { runCeoAgent } = await import("./ceo");
    await runCeoAgent("Is NVDA overvalued?", "", () => {});
    const prompt = assembledPromptText();
    for (const heading of [
      "## Answer",
      "## Key numbers",
      "## Bull case",
      "## Bear case",
      "## What would change the view",
      "## Confidence & gaps",
      "## Details",
    ]) {
      expect(prompt, heading).toContain(heading);
    }
  });
});

describe("crew event order", () => {
  it("announces, runs, then reports — in an order the UI can render incrementally", async () => {
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_dcf_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("report")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("Is NVDA overvalued?", "", (e) => events.push(e));

    const at = (t: string) => events.findIndex((e) => e.type === t);
    const progress = events.filter((e) => e.type === "agent_progress") as { agent: string; status: string }[];

    // Plan first, panel pre-size second, then the agent lifecycle.
    expect(at("crew_plan")).toBe(0);
    expect(at("crew_planned")).toBe(1);
    expect(at("crew_plan")).toBeLessThan(at("agent_start"));
    // running strictly precedes that agent's terminal status.
    const running = progress.findIndex((p) => p.agent === "run_dcf_agent" && p.status === "running");
    const done = progress.findIndex((p) => p.agent === "run_dcf_agent" && p.status === "done");
    expect(running).toBeGreaterThanOrEqual(0);
    expect(done).toBeGreaterThan(running);
    // The answer lands after the crew, and `done` closes the stream.
    expect(at("final_response")).toBeGreaterThan(at("agent_complete"));
    expect(events.map((e) => e.type).at(-1)).toBe("done");
    // Skipped agents are reported before the answer, so the gap is visible with it.
    expect(events.findIndex((e) => e.type === "agent_progress" && e.status === "skipped"))
      .toBeLessThan(at("final_response"));
  });
});

describe("adaptive tool deadline", () => {
  it("stops starting agents early enough that the report still fits the budget", async () => {
    const state = { t: 0 };
    const now = () => state.t;
    // Synthesis is the dominant cost of a crew answer. With a ~150s median, the
    // 240s budget leaves ~90s for tool rounds — NOT the static 200s, which was
    // measured overrunning the route's 300s cap by 55s.
    runRiskAgent.mockImplementation(async () => { state.t += 95_000; return "RISK ok"; });
    finalMessages.push(
      { stop_reason: "tool_use", content: [toolUse("t1", "run_risk_agent")], usage: {} },
      { stop_reason: "end_turn", content: [text("report")], usage: {} },
    );
    const { runCeoAgent } = await import("./ceo");
    const events: AgentEvent[] = [];
    await runCeoAgent("Should I worry about AMD?", "", (e) => events.push(e), { now });

    // 95s elapsed is already past the reserved deadline, so no second tool round.
    expect(events.some((e) => e.type === "budget_warning")).toBe(true);
    const calls = streamSpy.mock.calls as unknown as Array<Array<Record<string, unknown>>>;
    expect("tools" in calls[1][0]).toBe(false);
  });
});
