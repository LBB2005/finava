import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  withAuthRaw: vi.fn(),
  stream: vi.fn(),
  generate: vi.fn(),
  getTemplateBlock: vi.fn(),
  checkUsageLimit: vi.fn(),
  recordUsage: vi.fn(),
  usageRun: vi.fn((_store: { userId: string }, fn: () => unknown) => fn()),
  userRateLimit: vi.fn(),
  getQuickContext: vi.fn(),
  loadTurnData: vi.fn(),
  saveTurnData: vi.fn(),
  loadDnaSummary: vi.fn(),
  loadChatFacts: vi.fn(),
  getExperienceLevel: vi.fn(),
}));

vi.mock("@/lib/facts/chatFacts", () => ({
  loadChatFacts: deps.loadChatFacts,
}));

vi.mock("@/lib/experienceLevel.server", () => ({
  getExperienceLevel: deps.getExperienceLevel,
}));

vi.mock("@/lib/investorDnaStore", () => ({ loadDnaSummary: deps.loadDnaSummary }));

vi.mock("@/lib/withRoute", () => ({
  withAuthRaw: deps.withAuthRaw,
}));

vi.mock("@/lib/anthropic", () => ({
  MODEL: "claude-test",
  HAIKU: "claude-test-haiku",
  anthropic: {
    messages: {
      stream: deps.stream,
    },
  },
}));

vi.mock("@/lib/llm", () => ({
  generate: deps.generate,
}));

vi.mock("@/lib/templates.server", () => ({
  getTemplateBlock: deps.getTemplateBlock,
}));

vi.mock("@/lib/usage", () => ({
  checkUsageLimit: deps.checkUsageLimit,
  recordUsage: deps.recordUsage,
  makeRunContext: (u: string) => ({ userId: u }),
  usageStore: { run: deps.usageRun },
}));

vi.mock("@/lib/rateLimit", () => ({
  userRateLimit: deps.userRateLimit,
}));

vi.mock("@/lib/quickContext", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getQuickContext: deps.getQuickContext,
}));

vi.mock("@/lib/turnData", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadTurnData: deps.loadTurnData,
  saveTurnData: deps.saveTurnData,
}));

import { POST } from "./route";
import { UNAVAILABLE, type QuickContext } from "@/lib/quickContext";
import { tickerFactsFixture } from "@/test/factsFixture";
import { insiderFacts } from "@/lib/facts/precomputed";

/** A QuickContext shaped like a real one, with every fact filled. */
function quickContext(over: Partial<QuickContext> = {}): QuickContext {
  const v = (value: string) => ({ value, source: "Finnhub quote", asOf: "2026-09-15T20:00:00.000Z" });
  return {
    ticker: "AAPL",
    tickers: ["AAPL"],
    facts: {
      price: v("$228.10"),
      change: v("+0.84%"),
      marketCap: v("$3.45T"),
      peTTM: v("34.2"),
      epsTTM: v("$6.67"),
      range52w: v("$164.08–$260.10"),
      dividendYield: v("0.44%"),
      nextEarnings: v("2026-10-29"),
      finavaScore: v("71 (B)"),
    },
    headlines: [{ headline: "Apple ships the thing", source: "Reuters", date: "2026-09-14" }],
    fetchedAt: "2026-09-15T20:00:00.000Z",
    dropped: [],
    ...over,
  };
}

/** The system prompt handed to the model on the most recent stream call. */
function systemPrompt(): string {
  return deps.stream.mock.calls.at(-1)![0].system[0].text as string;
}

function chatRequest(body: Record<string, unknown>) {
  return new Request("http://test.local/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function makeAnthropicStream(events: unknown[], finalUsage = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    finalMessage: vi.fn(async () => ({ usage: finalUsage })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.withAuthRaw.mockReturnValue(async () => ({
    userId: "user_123",
    body: {
      messages: [{ role: "user", content: "What about AAPL?" }],
      portfolioContext: "",
    },
  }));
  deps.stream.mockReturnValue(
    makeAnthropicStream(
      [
        { type: "content_block_delta", delta: { type: "text_delta", text: "AAPL " } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "looks rich." } },
      ],
      {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 5,
      }
    )
  );
  deps.generate.mockResolvedValue('["Compare MSFT","DCF AAPL","Risks?"]');
  deps.getTemplateBlock.mockResolvedValue("");
  deps.checkUsageLimit.mockResolvedValue(null);
  deps.recordUsage.mockResolvedValue(undefined);
  deps.userRateLimit.mockReturnValue(null);
  deps.getQuickContext.mockResolvedValue(quickContext());
  deps.loadTurnData.mockResolvedValue(null);
  deps.saveTurnData.mockResolvedValue(undefined);
  deps.loadDnaSummary.mockResolvedValue(null);
  deps.loadChatFacts.mockResolvedValue({ input: { tickers: [] }, dropped: [] });
  deps.getExperienceLevel.mockResolvedValue("intermediate");
});

describe("POST /api/chat", () => {
  it("returns auth/validation responses from withAuthRaw before spend", async () => {
    deps.withAuthRaw.mockReturnValueOnce(async () =>
      NextResponse.json({ error: { code: "validation_error" } }, { status: 400 })
    );

    const res = await POST(chatRequest({ messages: [] }));

    expect(res.status).toBe(400);
    expect(deps.userRateLimit).not.toHaveBeenCalled();
    expect(deps.stream).not.toHaveBeenCalled();
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it("rate-limits the user before usage checks or model spend", async () => {
    deps.userRateLimit.mockReturnValueOnce(
      NextResponse.json({ error: "rate limit" }, { status: 429 })
    );

    const res = await POST(chatRequest({ messages: [{ role: "user", content: "x" }] }));

    expect(res.status).toBe(429);
    expect(deps.userRateLimit).toHaveBeenCalledWith("user_123", "chat");
    expect(deps.checkUsageLimit).not.toHaveBeenCalled();
    expect(deps.stream).not.toHaveBeenCalled();
  });

  it("blocks over-quota users before starting either model call", async () => {
    deps.checkUsageLimit.mockResolvedValueOnce(
      NextResponse.json({ error: "quota" }, { status: 429 })
    );

    const res = await POST(chatRequest({ messages: [{ role: "user", content: "x" }] }));

    expect(res.status).toBe(429);
    expect(deps.stream).not.toHaveBeenCalled();
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.usageRun).not.toHaveBeenCalled();
  });

  it("injects portfolio and template context into the system prompt", async () => {
    deps.withAuthRaw.mockReturnValueOnce(async () => ({
      userId: "user_123",
      body: {
        messages: [{ role: "user", content: "Analyze NVDA" }],
        portfolioContext: "NVDA: 5 shares",
        templateId: "tpl_1",
      },
    }));
    deps.getTemplateBlock.mockResolvedValueOnce("Use bullet points.");

    const res = await POST(chatRequest({ messages: [{ role: "user", content: "Analyze NVDA" }] }));
    await res.text();

    expect(deps.getTemplateBlock).toHaveBeenCalledWith("user_123", "tpl_1");
    const streamArg = deps.stream.mock.calls[0][0];
    expect(streamArg.system[0].text).toContain("## User's Current Portfolio\nNVDA: 5 shares");
    expect(streamArg.system[0].text).toContain("Use bullet points.");
    expect(streamArg.messages).toEqual([{ role: "user", content: "Analyze NVDA" }]);
  });

  it("gives the model the user's Investor DNA, labelled as inferred", async () => {
    deps.loadDnaSummary.mockResolvedValueOnce("## Investor DNA (inferred from your holdings; the user did not state any of this)\nStyle: Momentum rider.");

    const res = await POST(chatRequest({ messages: [{ role: "user", content: "What about AAPL?" }] }));
    await res.text();

    expect(deps.loadDnaSummary).toHaveBeenCalledWith("user_123");
    expect(systemPrompt()).toContain("## Investor DNA (inferred from your holdings");
    expect(systemPrompt()).toContain("Style: Momentum rider.");
  });

  it("answers without a DNA block when the user has none", async () => {
    const res = await POST(chatRequest({ messages: [{ role: "user", content: "What about AAPL?" }] }));
    await res.text();
    expect(systemPrompt()).not.toContain("Investor DNA");
  });

  it("tells the model today's date, what Finava costs, and where the advice line is", async () => {
    const res = await POST(chatRequest({ messages: [{ role: "user", content: "does this app cost money?" }] }));
    await res.text();
    const system = deps.stream.mock.calls[0][0].system[0].text as string;
    expect(system).toMatch(/Today is \w+day, \d{1,2} \w+ \d{4} \(US\/Eastern\)\. US market: /);
    expect(system).toContain("## About Finava");
    expect(system).toContain("Analyst");
    expect(system).toContain("based on your holdings");
    for (const banned of ["stop-loss", "trim level", "actionable recommendation", "rebalance threshold"]) {
      expect(system.toLowerCase(), banned).not.toContain(banned);
    }
  });

  it("streams text deltas, records usage, emits followups, and ends with DONE", async () => {
    const res = await POST(chatRequest({ messages: [{ role: "user", content: "What about AAPL?" }] }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const body = await res.text();
    expect(body).toContain('data: {"text":"AAPL "}');
    expect(body).toContain('data: {"text":"looks rich."}');
    expect(body).toContain('"followups":["Compare MSFT","DCF AAPL","Risks?"]');
    expect(body).toContain("data: [DONE]");
    // The chips are drawn from the answer the user just read, not the question
    // alone — the prompt carries both.
    expect(deps.generate).toHaveBeenCalledWith({
      agent: "chatFollowups",
      maxTokens: 160,
      prompt: expect.stringContaining("AAPL looks rich."),
    });
    expect(deps.generate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining("The user asked: What about AAPL?") })
    );
    expect(deps.recordUsage).toHaveBeenCalledWith({
      agent: "chat",
      model: "claude-test-haiku",
      inputTokens: 100,
      outputTokens: 20,
      cacheRead: 5,
    });
  });

  it("keeps followups best-effort when JSON parsing fails", async () => {
    deps.generate.mockResolvedValueOnce("no json here");

    const res = await POST(chatRequest({ messages: [{ role: "user", content: "x" }] }));

    const body = await res.text();
    expect(body).toContain("data: [DONE]");
    expect(body).not.toContain("followups");
  });

  it("keeps usage metering best-effort when finalMessage fails", async () => {
    const stream = makeAnthropicStream([
      { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
    ]);
    stream.finalMessage.mockRejectedValueOnce(new Error("missing usage"));
    deps.stream.mockReturnValueOnce(stream);

    const res = await POST(chatRequest({ messages: [{ role: "user", content: "x" }] }));

    await expect(res.text()).resolves.toContain("data: [DONE]");
    expect(deps.recordUsage).not.toHaveBeenCalled();
  });

  it("emits an SSE error when the Anthropic stream throws mid-flight", async () => {
    deps.stream.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {
        throw new Error("stream exploded");
      },
      finalMessage: vi.fn(),
    });

    const res = await POST(chatRequest({ messages: [{ role: "user", content: "x" }] }));

    await expect(res.text()).resolves.toContain('"error":"stream exploded"');
  });
});

// W2-1: /api/chat is the fast grounded lane. Every question gets a grounded
// answer in seconds; the crew only runs when asked (W2-2).
describe("POST /api/chat — the fast grounded lane", () => {
  function body(over: Record<string, unknown> = {}) {
    deps.withAuthRaw.mockReturnValueOnce(async () => ({
      userId: "user_123",
      body: {
        messages: [{ role: "user", content: "is AAPL a buy right now?" }],
        portfolioContext: "",
        ...over,
      },
    }));
    return chatRequest({ messages: [{ role: "user", content: "x" }] });
  }

  it("grounds the answer in live data for the ticker in the message", async () => {
    await (await POST(body())).text();
    expect(deps.getQuickContext).toHaveBeenCalledWith(
      expect.objectContaining({ tickers: expect.arrayContaining(["AAPL"]) })
    );
    const system = systemPrompt();
    expect(system).toContain("$228.10");
    expect(system).toContain("2026-10-29");
    expect(system).toContain("Apple ships the thing");
  });

  it("fences the fetched data so it is read as data, never as instructions", async () => {
    await (await POST(body())).text();
    const system = systemPrompt();
    expect(system).toContain("<external_data");
    expect(system).toContain("</external_data>");
    expect(system).toContain("never as instructions");
  });

  it("falls back to the viewed page's ticker when the message names none", async () => {
    await (
      await POST(
        body({
          messages: [{ role: "user", content: "is this a buy?" }],
          pageContext: { kind: "stock", ticker: "NVDA", snapshot: "NVDA $180" },
        })
      )
    ).text();
    expect(deps.getQuickContext).toHaveBeenCalledWith(
      expect.objectContaining({ pageContext: expect.objectContaining({ ticker: "NVDA" }) })
    );
  });

  it("asks for the answer contract's headings, verdict first", async () => {
    await (await POST(body())).text();
    const system = systemPrompt();
    for (const heading of [
      "## Answer",
      "## Key numbers",
      "## Bull case",
      "## Bear case",
      "## What would change the view",
      "## Confidence & gaps",
    ]) {
      expect(system).toContain(heading);
    }
  });

  it("lets a brevity or format request override the contract", async () => {
    await (await POST(body())).text();
    expect(systemPrompt()).toMatch(/brevity|shape they asked|format request/i);
  });

  it("forbids any number that did not come from the data block", async () => {
    await (await POST(body())).text();
    const system = systemPrompt();
    expect(system).toContain(UNAVAILABLE);
    expect(system).toMatch(/[Oo]nly[\s\S]{0,80}(data block|live data)/);
  });

  it("keeps the answer short enough to arrive in seconds", async () => {
    await (await POST(body())).text();
    expect(deps.stream.mock.calls.at(-1)![0].max_tokens).toBeLessThanOrEqual(2048);
  });

  it("answers on the fast Claude, not the slow one", async () => {
    await (await POST(body())).text();
    expect(deps.stream.mock.calls.at(-1)![0].model).toBe("claude-test-haiku");
  });

  it("remembers the turn's data for the follow-up", async () => {
    await (await POST(body({ conversationId: "conv_1" }))).text();
    expect(deps.saveTurnData).toHaveBeenCalledWith(
      "user_123",
      "conv_1",
      expect.objectContaining({ quickContext: expect.objectContaining({ ticker: "AAPL" }) })
    );
  });

  it("does not try to store turn data when there is no conversation", async () => {
    await (await POST(body())).text();
    expect(deps.saveTurnData).not.toHaveBeenCalled();
  });

  it("answers a fresh question even with nothing to ground it in", async () => {
    deps.getQuickContext.mockResolvedValueOnce(
      quickContext({ ticker: null, tickers: [], headlines: [], dropped: ["quote"] })
    );
    const res = await POST(body({ messages: [{ role: "user", content: "what is an ETF?" }] }));
    await expect(res.text()).resolves.toContain("data: [DONE]");
  });

  it("still answers when the data fetch itself fails", async () => {
    deps.getQuickContext.mockRejectedValueOnce(new Error("finnhub down"));
    const res = await POST(body());
    await expect(res.text()).resolves.toContain("data: [DONE]");
    expect(deps.stream).toHaveBeenCalled();
  });

  it("reports the lane and the timings it took", async () => {
    const out = await (await POST(body())).text();
    expect(out).toMatch(/"lane":"fast"/);
    expect(out).toMatch(/"ttftMs":\d+/);
    expect(out).toMatch(/"totalMs":\d+/);
  });
});

// 13 testers asked for "yes or no" / "3 bullets" / "simpler" and each one
// started a brand-new run. A reformat must reuse what we already fetched.
describe("POST /api/chat — reformat follow-ups reuse the last turn's data", () => {
  function followUp(text: string, stored: unknown) {
    deps.loadTurnData.mockResolvedValueOnce(stored);
    deps.withAuthRaw.mockReturnValueOnce(async () => ({
      userId: "user_123",
      body: {
        messages: [
          { role: "user", content: "is AAPL a buy right now?" },
          { role: "assistant", content: "## Answer\nIt is expensive." },
          { role: "user", content: text },
        ],
        portfolioContext: "",
        conversationId: "conv_1",
      },
    }));
    return POST(chatRequest({ messages: [{ role: "user", content: "x" }] }));
  }

  const fresh = () => ({
    quickContext: quickContext(),
    storedAt: new Date(Date.now() - 30_000).toISOString(),
  });

  for (const text of ["so yes or no?", "simpler", "3 bullets", "what about the risks?"]) {
    it(`reuses the stored data for "${text}" instead of refetching`, async () => {
      const out = await (await followUp(text, fresh())).text();
      expect(deps.getQuickContext).not.toHaveBeenCalled();
      expect(systemPrompt()).toContain("$228.10");
      expect(out).toMatch(/"reusedData":true/);
    });
  }

  it("refetches when the stored data has gone stale", async () => {
    const stale = {
      quickContext: quickContext(),
      storedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    };
    const out = await (await followUp("so yes or no?", stale)).text();
    expect(deps.getQuickContext).toHaveBeenCalled();
    expect(out).toMatch(/"reusedData":false/);
  });

  it("refetches when nothing was stored", async () => {
    await (await followUp("simpler", null)).text();
    expect(deps.getQuickContext).toHaveBeenCalled();
  });

  it("refetches for a genuinely new question, however short", async () => {
    await (await followUp("is AMD a buy?", fresh())).text();
    expect(deps.getQuickContext).toHaveBeenCalled();
  });

  it("answers a reformat with fewer tokens than a first answer", async () => {
    await (await followUp("so yes or no?", fresh())).text();
    const reuseTokens = deps.stream.mock.calls.at(-1)![0].max_tokens as number;
    expect(reuseTokens).toBeLessThan(2048);
  });
});

// W4-1: the model never does arithmetic. It quotes facts by ID, and the route
// checks every cited number before the reader sees it.
describe("POST /api/chat — answers cite facts", () => {
  // A queued stored turn left unused by an earlier test must not leak in here.
  beforeEach(() => {
    deps.loadTurnData.mockReset().mockResolvedValue(null);
  });

  function ask(content: string, over: Record<string, unknown> = {}) {
    deps.withAuthRaw.mockReturnValueOnce(async () => ({
      userId: "user_123",
      body: { messages: [{ role: "user", content }], portfolioContext: "", ...over },
    }));
    return POST(chatRequest({ messages: [{ role: "user", content: "x" }] }));
  }

  function streams(...deltas: string[]) {
    deps.stream.mockReturnValueOnce(
      makeAnthropicStream(deltas.map((text) => ({ type: "content_block_delta", delta: { type: "text_delta", text } })))
    );
  }

  const withFacts = () =>
    deps.getQuickContext.mockResolvedValueOnce(quickContext({ factsInput: { tickers: [tickerFactsFixture("AAPL")] } }));

  it("hands the model a facts block with stable IDs and the citation rule", async () => {
    withFacts();
    await (await ask("is AAPL a buy right now?")).text();
    const system = systemPrompt();
    expect(system).toContain("[F:AAPL.price] AAPL price = $182.50");
    expect(system).toContain("[F:AAPL.pctFrom52wHigh]");
    expect(system).toMatch(/Never calculate/);
  });

  it("replaces a wrong cited number and strips the IDs before streaming it", async () => {
    withFacts();
    streams("## Answer\nThe P/E is 9", "9.9x [F:AAPL.pe] and the price $182.50 [F:AAPL.price].\n");
    const out = await (await ask("is AAPL expensive?")).text();
    const text = out
      .split("\n")
      .filter((l) => l.startsWith("data: {\"text\""))
      .map((l) => JSON.parse(l.slice(6)).text)
      .join("");
    expect(text).toBe("## Answer\nThe P/E is 51.3x and the price $182.50.\n");
    expect(out).not.toContain("[F:");
    // The follow-up chips are drawn from the corrected answer.
    expect(deps.generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining("The P/E is 51.3x") }));
  });

  it("still delivers the checked text it was holding when the model stream fails", async () => {
    withFacts();
    deps.stream.mockReturnValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "P/E is 51.3x [F:AAPL.pe]" } };
        throw new Error("stream exploded");
      },
      finalMessage: vi.fn(),
    });
    const out = await (await ask("is AAPL expensive?")).text();
    expect(out).toContain('"text":"P/E is 51.3x"');
    expect(out.indexOf('"text":"P/E is 51.3x"')).toBeLessThan(out.indexOf('"error":"stream exploded"'));
  });

  it("reports what the number check compared, so the eval can score it", async () => {
    withFacts();
    streams("The P/E is 99.9x [F:AAPL.pe] and the price $182.50 [F:AAPL.price].\n");
    const out = await (await ask("is AAPL expensive?")).text();
    expect(out).toContain('data: {"type":"number_check","checked":2,"mismatched":1}');
  });

  it("reports nothing to check when the turn had no facts", async () => {
    const out = await (await ask("what is an ETF?")).text();
    expect(out).not.toContain("number_check");
  });

  it("loads insider facts for an insider question, so a $1.0M buy is quoted as $1.0M", async () => {
    const pfe = insiderFacts("PFE", { data: [{ name: "Bourla Albert", change: 38_000, transactionPrice: 26.32, transactionDate: "2026-08-04", transactionCode: "P" }] }, "2026-09-15T20:00:00.000Z");
    deps.getQuickContext.mockResolvedValueOnce(quickContext({ ticker: "PFE", tickers: ["PFE"], factsInput: { tickers: [] } }));
    deps.loadChatFacts.mockResolvedValueOnce({ input: { insider: [pfe] }, dropped: [] });
    streams("Pfizer's CEO bought $10.3M [F:PFE.insider.largestBuy] of stock.");
    const out = await (await ask("did Pfizer's CEO buy PFE shares?")).text();
    expect(deps.loadChatFacts).toHaveBeenCalledWith(expect.objectContaining({ tickers: ["PFE"], insider: true }));
    expect(systemPrompt()).toContain("[F:PFE.insider.largestBuy] PFE largest insider buy: Bourla Albert, 38,000 shares @ $26.32 on 2026-08-04 = $1.0M");
    expect(out).toContain("bought $1.0M of stock");
    expect(out).not.toContain("$10.3M");
  });

  it("loads the user's portfolio facts only for a question about their book", async () => {
    await (await ask("what's my downside on GOOGL?", { portfolioContext: "GOOGL: 100 shares" })).text();
    expect(deps.loadChatFacts).toHaveBeenCalledWith(expect.objectContaining({ portfolioUserId: "user_123" }));

    deps.loadChatFacts.mockClear();
    await (await ask("is AMD a buy?", { portfolioContext: "GOOGL: 100 shares" })).text();
    expect(deps.loadChatFacts).not.toHaveBeenCalled();
  });

  it("leads with the data it can't get instead of estimating it", async () => {
    await (await ask("what's the implied volatility on AAPL?")).text();
    expect(systemPrompt()).toContain("I can't get options-chain and implied-volatility data for AAPL, so here's what I can tell you");
  });

  it("does not claim price targets are missing when the ticker has one", async () => {
    withFacts();
    await (await ask("what's the price target on AAPL?")).text();
    expect(systemPrompt()).not.toContain("I can't get analyst price targets");
  });

  it("answers an ETF question about funds, never with stock picks", async () => {
    await (await ask("which etf should a beginner look at with $100 a month?")).text();
    expect(systemPrompt()).toContain("Discover screens individual stocks");
    expect(systemPrompt()).toMatch(/never present individual stocks/);
  });

  it("writes for the reader's experience level", async () => {
    deps.getExperienceLevel.mockResolvedValueOnce("beginner");
    await (await ask("is AAPL a buy?")).text();
    expect(deps.getExperienceLevel).toHaveBeenCalledWith("user_123");
    expect(systemPrompt()).toMatch(/Skip technical-analysis indicators/);
  });

  it("keeps citing facts on a reformat that reuses the stored turn", async () => {
    deps.loadTurnData.mockResolvedValueOnce({
      quickContext: quickContext({ factsInput: { tickers: [tickerFactsFixture("AAPL")] } }),
      storedAt: new Date(Date.now() - 30_000).toISOString(),
    });
    deps.withAuthRaw.mockReturnValueOnce(async () => ({
      userId: "user_123",
      body: {
        messages: [
          { role: "user", content: "is AAPL a buy right now?" },
          { role: "assistant", content: "## Answer\nIt is expensive." },
          { role: "user", content: "so yes or no?" },
        ],
        portfolioContext: "",
        conversationId: "conv_1",
      },
    }));
    await (await POST(chatRequest({ messages: [] }))).text();
    expect(deps.getQuickContext).not.toHaveBeenCalled();
    expect(systemPrompt()).toContain("[F:AAPL.price]");
  });
});
