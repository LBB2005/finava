import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  ctor: vi.fn(),
  observeAnthropic: vi.fn((c: unknown) => c),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: vi.fn(async () => ({ id: "msg" })) };
    apiKey: string;
    constructor(opts: { apiKey: string }) {
      this.apiKey = opts.apiKey;
      deps.ctor(opts);
    }
  },
}));

vi.mock("@/lib/observability", () => ({ observeAnthropic: deps.observeAnthropic }));

type Global = typeof globalThis & { __anthropicClient?: unknown };

async function loadAnthropic(key: string | null = "sk-ant-test") {
  vi.resetModules();
  delete (globalThis as Global).__anthropicClient;
  // `null` means "unset" — passing `undefined` would re-trigger the default.
  vi.stubEnv("ANTHROPIC_API_KEY", key ?? undefined);
  return import("./anthropic");
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.observeAnthropic.mockImplementation((c: unknown) => c);
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as Global).__anthropicClient;
});

describe("model constants", () => {
  it("names the routed Sonnet and Haiku models", async () => {
    const { MODEL, HAIKU } = await loadAnthropic();
    expect(MODEL).toBe("claude-sonnet-4-6");
    expect(HAIKU).toBe("claude-haiku-4-5");
  });
});

describe("the lazy client proxy", () => {
  it("does not construct a client until a property is read", async () => {
    await loadAnthropic();
    expect(deps.ctor).not.toHaveBeenCalled();
  });

  it("constructs with the env key on first property access", async () => {
    const { anthropic } = await loadAnthropic();
    void anthropic.messages;
    expect(deps.ctor).toHaveBeenCalledWith({ apiKey: "sk-ant-test", fetch: expect.any(Function) });
  });

  it("wraps the client for tracing at construction", async () => {
    const { anthropic } = await loadAnthropic();
    void anthropic.messages;
    expect(deps.observeAnthropic).toHaveBeenCalledTimes(1);
  });

  it("throws an actionable error when the key is missing", async () => {
    const { anthropic } = await loadAnthropic(null);
    expect(() => anthropic.messages).toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(() => anthropic.messages).toThrow(/\.env\.local/);
  });

  it("constructs only once across many accesses", async () => {
    const { anthropic } = await loadAnthropic();
    void anthropic.messages;
    void anthropic.messages;
    void anthropic.messages;
    expect(deps.ctor).toHaveBeenCalledTimes(1);
  });

  it("caches on globalThis so an HMR module re-eval reuses the client", async () => {
    const a = await loadAnthropic();
    void a.anthropic.messages;
    expect(deps.ctor).toHaveBeenCalledTimes(1);

    // Re-evaluate the module WITHOUT clearing the global (what Turbopack HMR does),
    // and with the key gone — the cached client must still be served.
    vi.resetModules();
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    const b = await import("./anthropic");
    expect(() => b.anthropic.messages).not.toThrow();
    expect(deps.ctor).toHaveBeenCalledTimes(1);
  });

  it("binds methods to the client so destructured calls keep their `this`", async () => {
    const { anthropic } = await loadAnthropic();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const create = (anthropic.messages as any).create;
    await expect(create({})).resolves.toEqual({ id: "msg" });
  });

  it("forwards non-function properties untouched", async () => {
    const { anthropic } = await loadAnthropic();
    expect((anthropic as unknown as { apiKey: string }).apiKey).toBe("sk-ant-test");
  });
});
