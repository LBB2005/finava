import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { llmStatus, resetProviderHealthForTest, setSharedHealthStoreForTest } from "./providerHealth";

// ── Mocks at the boundary ────────────────────────────────────────────────────
// One `create` spy for every OpenAI-compatible client. The second argument is the
// client's baseURL, so a test can tell OpenRouter from a direct provider.
const create = vi.fn();
vi.mock("openai", () => {
  class APIError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
    }
  }
  class OpenAI {
    baseURL?: string;
    constructor(opts?: { baseURL?: string }) {
      this.baseURL = opts?.baseURL;
    }
    chat = { completions: { create: (body: unknown) => create(body, this.baseURL) } };
    static APIError = APIError;
  }
  return { default: OpenAI };
});

const anthropicCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = { create: (body: unknown) => anthropicCreate(body) };
  }
  return { default: Anthropic };
});

// Don't drag firebase-admin in via usage.ts — metering is fire-and-forget.
const recordUsage = vi.fn();
vi.mock("@/lib/usage", () => ({ recordUsage: (u: unknown) => recordUsage(u) }));

beforeEach(() => {
  create.mockReset();
  anthropicCreate.mockReset();
  recordUsage.mockReset();
  resetProviderHealthForTest();
  setSharedHealthStoreForTest(null);
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  // Direct providers are opt-in per test so the OpenRouter-only tests stay exact
  // even when a developer's shell exports a real ANTHROPIC_API_KEY.
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("XAI_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function apiError(message: string, status?: number) {
  const OpenAI = (await import("openai")).default as unknown as {
    APIError: new (m: string, s?: number) => Error;
  };
  return new OpenAI.APIError(message, status);
}

const OPENROUTER = "https://openrouter.ai/api/v1";
const ok = (text: string) => ({
  choices: [{ message: { content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const anthropicOk = (text: string) => ({
  content: [{ type: "text", text }],
  usage: { input_tokens: 12, output_tokens: 6 },
});

describe("AGENT_MODELS routing table", () => {
  it("maps every agent key to a non-empty model slug when routing is on", async () => {
    const { AGENT_MODELS, LLM_ROUTING_ON } = await import("./llm");
    expect(LLM_ROUTING_ON).toBe(true); // unset env defaults to on
    for (const [agent, model] of Object.entries(AGENT_MODELS)) {
      expect(model, agent).toBeTruthy();
      expect(typeof model).toBe("string");
    }
  });

  it("routes the numeric dcf agent to GPT-5.5 and narration to Gemini when on", async () => {
    const { AGENT_MODELS } = await import("./llm");
    expect(AGENT_MODELS.dcf).toBe("openai/gpt-5.5");
    expect(AGENT_MODELS.sentiment).toBe("x-ai/grok-4.3");
    expect(AGENT_MODELS.titleConversation).toBe("google/gemini-2.5-flash-lite");
  });

  it("collapses to the Sonnet/Haiku fallback when LLM_ROUTING=off", async () => {
    vi.resetModules();
    vi.stubEnv("LLM_ROUTING", "off");
    const { AGENT_MODELS, LLM_ROUTING_ON } = await import("./llm");
    expect(LLM_ROUTING_ON).toBe(false);
    // dcf was GPT-5.5 when routed; off → back to Sonnet.
    expect(AGENT_MODELS.dcf).toBe("anthropic/claude-sonnet-4.6");
    expect(AGENT_MODELS.ceo).toBe("anthropic/claude-sonnet-4.6");
    // Haiku call-sites stay on Haiku.
    expect(AGENT_MODELS.skeptic).toBe("anthropic/claude-haiku-4.5");
    expect(AGENT_MODELS.chatRouter).toBe("anthropic/claude-haiku-4.5");
    vi.resetModules();
  });
});

describe("generate()", () => {
  it("returns the assistant text on a successful completion", async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: "hello world" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const { generate } = await import("./llm");
    const out = await generate({ agent: "dcf", prompt: "value AAPL", maxTokens: 500 });
    expect(out).toBe("hello world");
    expect(create).toHaveBeenCalledOnce();
    // The resolved model for dcf (routing on) is GPT-5.5.
    expect(create.mock.calls[0][0].model).toBe("openai/gpt-5.5");
  });

  it("throws (does not silently return '') on an empty completion", async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: "   " }, finish_reason: "length" }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    });
    const { generate } = await import("./llm");
    await expect(generate({ agent: "dcf", prompt: "x", maxTokens: 100 })).rejects.toThrow(
      /empty content/,
    );
  });

  it("wraps an upstream API error with the agent name and model", async () => {
    create.mockRejectedValue(new Error("upstream 503"));
    const { generate } = await import("./llm");
    await expect(generate({ agent: "dcf", prompt: "x", maxTokens: 100 })).rejects.toThrow(
      /\[llm:dcf\].*request failed/,
    );
  });

  it("falls back to the Anthropic model when the primary model errors", async () => {
    create
      .mockRejectedValueOnce(new Error("gpt upstream 503"))
      .mockResolvedValueOnce({
        choices: [{ message: { content: "fallback answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 4 },
      });
    const { generate } = await import("./llm");
    const out = await generate({ agent: "dcf", prompt: "x", maxTokens: 100 });
    expect(out).toBe("fallback answer");
    expect(create).toHaveBeenCalledTimes(2);
    // First attempt = primary (gpt-5.5), second = the Sonnet fallback.
    expect(create.mock.calls[0][0].model).toBe("openai/gpt-5.5");
    expect(create.mock.calls[1][0].model).toBe("anthropic/claude-sonnet-4.6");
  });

  it("rejects PDF/file input routed to a non-Anthropic model", async () => {
    const { generate } = await import("./llm");
    // dcf routes to GPT-5.5 (non-Anthropic) → file part must be refused.
    await expect(
      generate({
        agent: "dcf",
        content: [{ type: "file", file: { filename: "a.pdf", file_data: "..." } }],
        maxTokens: 100,
      }),
    ).rejects.toThrow(/requires an Anthropic model/);
    expect(create).not.toHaveBeenCalled();
  });

  it("passes a reasoning budget for the dcf agent", async () => {
    create.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const { generate } = await import("./llm");
    await generate({ agent: "dcf", prompt: "x", maxTokens: 9999 });
    const body = create.mock.calls[0][0];
    expect(body.reasoning).toEqual({ max_tokens: 1500 }); // DCF_REASONING_MAX_TOKENS
    // 2500 content + 1500 reasoning. This assertion previously read 2500, which
    // encoded the bug: OpenRouter counts reasoning against max_tokens, so the
    // model could spend the whole budget thinking and return nothing at all.
    expect(body.max_tokens).toBe(4000); // overrides the caller's 9999
  });
});

describe("reasoning token budget", () => {
  // Regression for a silent, expensive production failure: OpenRouter counts
  // reasoning tokens against max_tokens, so a reasoning model given a budget it
  // can spend entirely on thinking returns an EMPTY completion with
  // finish_reason "length". Observed on gpt-5.5 at max_tokens 2500 / reasoning
  // 1500: 2500 completion tokens, 0 characters of content, $0.075 a call, and
  // then the fallback burns too. It looks like a model outage, not a config bug.
  beforeEach(() => {
    create.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  });

  async function paramsFor(agent: string, maxTokens: number, reasoning?: number) {
    const { generate } = await import("./llm");
    await generate({ agent: agent as never, prompt: "x", maxTokens, reasoning });
    return create.mock.calls.at(-1)![0];
  }

  it("leaves the dcf agent real headroom for its answer", async () => {
    const p = await paramsFor("dcf", 500);
    expect(p.max_tokens - p.reasoning.max_tokens).toBeGreaterThanOrEqual(1000);
  });

  it("raises max_tokens rather than shrinking the reasoning budget", async () => {
    // Shrinking reasoning would silently degrade the analysis instead of the
    // caller finding out the budget was wrong.
    const p = await paramsFor("dcf", 500);
    expect(p.reasoning.max_tokens).toBe(1500);
  });

  it("protects any agent that is given a reasoning budget, not just dcf", async () => {
    // The failure is a property of reasoning models and token accounting, so an
    // agent that later gains a reasoning budget must inherit the guard.
    const p = await paramsFor("competitor", 1200, 1100);
    expect(p.max_tokens - p.reasoning.max_tokens).toBeGreaterThanOrEqual(1000);
  });

  it("leaves a call with no reasoning budget untouched", async () => {
    const p = await paramsFor("finavaSynthesis", 1500);
    expect(p.max_tokens).toBe(1500);
    expect(p.reasoning).toBeUndefined();
  });

  it("does not inflate an already-generous budget", async () => {
    const p = await paramsFor("competitor", 9000, 1000);
    expect(p.max_tokens).toBe(9000);
  });
});

describe("cross-provider fallback (OpenRouter outage)", () => {
  it("OpenRouter 402 → calls Anthropic directly and attributes the answer to it", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    create.mockRejectedValue(await apiError("402 Insufficient credits", 402));
    anthropicCreate.mockResolvedValue(anthropicOk("direct answer"));

    const { generateWithMeta } = await import("./llm");
    const out = await generateWithMeta({ agent: "dcf", prompt: "value AAPL", maxTokens: 500 });

    expect(out).toEqual({
      text: "direct answer",
      model: "anthropic/claude-sonnet-4.6",
      via: "direct",
    });
    // A 402 is account-level: retrying another model on the same gateway is pointless.
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1]).toBe(OPENROUTER);
    expect(anthropicCreate).toHaveBeenCalledOnce();
    expect(anthropicCreate.mock.calls[0][0].model).toBe("claude-sonnet-4-6");
    // Metering and health both see the model that actually answered.
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ model: "anthropic/claude-sonnet-4.6", inputTokens: 12, outputTokens: 6 }),
    );
    expect(llmStatus()).toBe("degraded");
  });

  it("keeps a Haiku agent on Haiku when it goes direct", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    create.mockRejectedValue(await apiError("402 Insufficient credits", 402));
    anthropicCreate.mockResolvedValue(anthropicOk('{"intent":"agent"}'));

    const { generateWithMeta } = await import("./llm");
    const out = await generateWithMeta({ agent: "chatRouter", prompt: "x", maxTokens: 200 });

    expect(anthropicCreate.mock.calls[0][0].model).toBe("claude-haiku-4-5");
    expect(out.model).toBe("anthropic/claude-haiku-4.5");
  });

  it("OpenRouter 5xx on both gateway attempts → falls through to the direct provider", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    create.mockRejectedValue(await apiError("503 upstream", 503));
    anthropicCreate.mockResolvedValue(anthropicOk("ok"));

    const { generate } = await import("./llm");
    await expect(generate({ agent: "dcf", prompt: "x", maxTokens: 100 })).resolves.toBe("ok");
    expect(create).toHaveBeenCalledTimes(2); // primary + gateway Sonnet
    expect(anthropicCreate).toHaveBeenCalledOnce();
  });

  it("a timeout (no HTTP status) counts as an outage", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    create.mockRejectedValue(new Error("Request timed out."));
    anthropicCreate.mockResolvedValue(anthropicOk("ok"));

    const { generate } = await import("./llm");
    await expect(generate({ agent: "technical", prompt: "x", maxTokens: 100 })).resolves.toBe("ok");
  });

  it("a missing OpenRouter key goes straight to the direct provider", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const g = globalThis as { __openrouterClient?: unknown };
    const saved = g.__openrouterClient;
    g.__openrouterClient = undefined;
    anthropicCreate.mockResolvedValue(anthropicOk("ok"));
    try {
      const { generate } = await import("./llm");
      await expect(generate({ agent: "news", prompt: "x", maxTokens: 100 })).resolves.toBe("ok");
    } finally {
      g.__openrouterClient = saved;
    }
  });

  it("prefers the agent's own vendor direct when that key exists (Grok stays Grok)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("XAI_API_KEY", "xai-test");
    create.mockImplementation(async (_body: unknown, baseURL: string) => {
      if (baseURL === OPENROUTER) throw await apiError("402 Insufficient credits", 402);
      return ok("grok direct");
    });

    const { generateWithMeta } = await import("./llm");
    const out = await generateWithMeta({ agent: "sentiment", prompt: "x", maxTokens: 100 });

    expect(out).toEqual({ text: "grok direct", model: "x-ai/grok-4.3", via: "direct" });
    const direct = create.mock.calls.find((c) => c[1] !== OPENROUTER)!;
    expect(direct[1]).toBe("https://api.x.ai/v1");
    expect(direct[0].model).toBe("grok-4.3");
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it("uses max_completion_tokens for OpenAI direct (GPT-5 rejects max_tokens)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-test");
    create.mockImplementation(async (_body: unknown, baseURL: string) => {
      if (baseURL === OPENROUTER) throw await apiError("402", 402);
      return ok("gpt direct");
    });

    const { generateWithMeta } = await import("./llm");
    const out = await generateWithMeta({ agent: "dcf", prompt: "x", maxTokens: 100 });

    const direct = create.mock.calls.find((c) => c[1] !== OPENROUTER)!;
    expect(direct[1]).toBe("https://api.openai.com/v1");
    expect(direct[0].model).toBe("gpt-5.5");
    expect(direct[0].max_completion_tokens).toBeGreaterThan(0);
    expect(direct[0].max_tokens).toBeUndefined();
    expect(out.model).toBe("openai/gpt-5.5");
  });

  it("does not go direct for a model-level 400 (not an outage)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    create.mockRejectedValue(await apiError("400 bad request", 400));

    const { generate } = await import("./llm");
    await expect(generate({ agent: "dcf", prompt: "x", maxTokens: 100 })).rejects.toThrow(/\[llm:dcf\]/);
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(llmStatus()).toBe("ok");
  });

  it("reports down and throws when the direct provider fails too", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    create.mockRejectedValue(await apiError("402", 402));
    anthropicCreate.mockRejectedValue(new Error("anthropic overloaded"));

    const { generate } = await import("./llm");
    await expect(generate({ agent: "dcf", prompt: "x", maxTokens: 100 })).rejects.toThrow(/\[llm:dcf\]/);
    expect(llmStatus()).toBe("down");
  });

  it("sends PDF input to Anthropic direct as a native document block", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    create.mockRejectedValue(await apiError("402", 402));
    anthropicCreate.mockResolvedValue(anthropicOk("parsed"));

    const { generate } = await import("./llm");
    await generate({
      agent: "portfolioStatement",
      system: "extract",
      cache: true,
      content: [
        { type: "text", text: "Read this" },
        { type: "file", file: { filename: "s.pdf", file_data: "data:application/pdf;base64,QUJD" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,SU1H" } },
      ],
      maxTokens: 1000,
    });

    const body = anthropicCreate.mock.calls[0][0];
    expect(body.system).toEqual([
      { type: "text", text: "extract", cache_control: { type: "ephemeral" } },
    ]);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "Read this" },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "QUJD" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "SU1H" } },
    ]);
  });

  it("marks OpenRouter healthy again after a successful gateway call", async () => {
    create.mockRejectedValueOnce(new Error("Connection error.")).mockResolvedValue(ok("fine"));
    const { generateWithMeta } = await import("./llm");
    const out = await generateWithMeta({ agent: "dcf", prompt: "x", maxTokens: 100 });
    // Primary failed with an outage-shaped error, gateway Sonnet answered.
    expect(out).toEqual({ text: "fine", model: "anthropic/claude-sonnet-4.6", via: "openrouter" });
    expect(llmStatus()).toBe("ok");
  });
});
