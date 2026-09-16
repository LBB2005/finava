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
}));

vi.mock("@/lib/withRoute", () => ({
  withAuthRaw: deps.withAuthRaw,
}));

vi.mock("@/lib/anthropic", () => ({
  MODEL: "claude-test",
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

import { POST } from "./route";

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
      model: "claude-test",
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
