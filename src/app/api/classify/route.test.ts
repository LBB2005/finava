import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

// Exercises the real withAuthRaw wrapper (auth + zod validation) so a malformed
// body is rejected by the same code path production uses.
const deps = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  generate: vi.fn(),
  userRateLimit: vi.fn(),
  checkUsageLimit: vi.fn(),
  pageContextRouteHint: vi.fn(() => "HINT: viewing NVDA"),
}));

vi.mock("@/lib/requireAuth", () => ({ requireAuth: deps.requireAuth }));
vi.mock("@/lib/llm", () => ({ generate: deps.generate }));
vi.mock("@/lib/rateLimit", () => ({ userRateLimit: deps.userRateLimit }));
vi.mock("@/lib/pageContext", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  pageContextRouteHint: deps.pageContextRouteHint,
}));
// Replaced wholesale — the real module reaches firebase-admin at import time.
vi.mock("@/lib/usage", () => ({
  checkUsageLimit: deps.checkUsageLimit,
  recordUsage: vi.fn(),
  makeRunContext: (userId: string) => ({ userId }),
  usageStore: { run: (_ctx: unknown, fn: () => unknown) => fn() },
}));

import { POST } from "./route";

function post(body: unknown) {
  return new Request("http://test.local/api/classify", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** The prompt the router model was handed. */
function lastPrompt(): string {
  return deps.generate.mock.calls.at(-1)![0].prompt as string;
}

async function classify(body: unknown) {
  const res = await POST(post(body));
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.requireAuth.mockResolvedValue({ userId: "user_1" });
  deps.userRateLimit.mockResolvedValue(null);
  deps.checkUsageLimit.mockResolvedValue(null);
  deps.generate.mockResolvedValue('{"intent":"simple","needsClarify":false}');
});

describe("POST /api/classify — routing", () => {
  it("returns the model's intent", async () => {
    deps.generate.mockResolvedValueOnce('{"intent":"agent","needsClarify":false}');
    await expect(classify({ userPrompt: "is TSLA a buy?" })).resolves.toEqual({
      status: 200,
      json: { intent: "agent", needsClarify: false },
    });
  });

  it("tells the router today's date", async () => {
    await classify({ userPrompt: "what happened in markets today?" });
    expect(lastPrompt()).toMatch(/^Today is \w+day, \d{1,2} \w+ \d{4} \(US\/Eastern\)\. US market: /);
  });

  it("accepts the discover intent", async () => {
    deps.generate.mockResolvedValueOnce('{"intent":"discover","needsClarify":false}');
    expect((await classify({ userPrompt: "find cheap energy stocks" })).json.intent).toBe("discover");
  });

  it("falls back to simple for an unrecognised intent", async () => {
    deps.generate.mockResolvedValueOnce('{"intent":"deep_research","needsClarify":false}');
    expect((await classify({ userPrompt: "hi" })).json.intent).toBe("simple");
  });

  it("falls back to simple when the intent field is missing", async () => {
    deps.generate.mockResolvedValueOnce("{}");
    expect((await classify({ userPrompt: "hi" })).json).toEqual({
      intent: "simple",
      needsClarify: false,
    });
  });

  it("calls the cheap router model with a token cap", async () => {
    await classify({ userPrompt: "hi" });
    expect(deps.generate).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "chatRouter", maxTokens: 200 }),
    );
  });
});

describe("POST /api/classify — model output parsing", () => {
  it("unwraps a ```json fenced response", async () => {
    deps.generate.mockResolvedValueOnce('```json\n{"intent":"agent","needsClarify":false}\n```');
    expect((await classify({ userPrompt: "NVDA" })).json.intent).toBe("agent");
  });

  it("extracts the object from surrounding prose", async () => {
    deps.generate.mockResolvedValueOnce('Sure! {"intent":"agent","needsClarify":false} Hope that helps.');
    expect((await classify({ userPrompt: "NVDA" })).json.intent).toBe("agent");
  });

  it("degrades to simple when the response has no JSON object", async () => {
    deps.generate.mockResolvedValueOnce("I think you want agent mode.");
    expect((await classify({ userPrompt: "NVDA" })).json).toEqual({
      intent: "simple",
      needsClarify: false,
    });
  });

  it("degrades to simple on malformed JSON", async () => {
    deps.generate.mockResolvedValueOnce('{"intent":"agent",}');
    expect((await classify({ userPrompt: "NVDA" })).json.intent).toBe("simple");
  });

  it("never dead-ends when the model call throws", async () => {
    deps.generate.mockRejectedValueOnce(new Error("upstream 500"));
    await expect(classify({ userPrompt: "NVDA" })).resolves.toEqual({
      status: 200,
      json: { intent: "simple", needsClarify: false },
    });
  });
});

describe("POST /api/classify — clarify handling", () => {
  it("passes through a well-formed clarify", async () => {
    deps.generate.mockResolvedValueOnce(
      JSON.stringify({
        intent: "discover",
        needsClarify: true,
        clarifyQuestion: "  What are you after?  ",
        clarifyChips: ["Growth", "Value", "Quality"],
      }),
    );
    expect((await classify({ userPrompt: "what should I buy?" })).json).toEqual({
      intent: "discover",
      needsClarify: true,
      clarifyQuestion: "What are you after?",
      clarifyChips: ["Growth", "Value", "Quality"],
    });
  });

  it("caps the chips at four", async () => {
    deps.generate.mockResolvedValueOnce(
      JSON.stringify({
        intent: "discover",
        needsClarify: true,
        clarifyQuestion: "Which style?",
        clarifyChips: ["a", "b", "c", "d", "e", "f"],
      }),
    );
    expect((await classify({ userPrompt: "ideas?" })).json.clarifyChips).toEqual(["a", "b", "c", "d"]);
  });

  it("drops a clarify that has no question", async () => {
    deps.generate.mockResolvedValueOnce(
      JSON.stringify({ intent: "discover", needsClarify: true, clarifyChips: ["a"] }),
    );
    expect((await classify({ userPrompt: "ideas?" })).json).toEqual({
      intent: "discover",
      needsClarify: false,
    });
  });

  it("drops a clarify whose question is blank", async () => {
    deps.generate.mockResolvedValueOnce(
      JSON.stringify({ intent: "discover", needsClarify: true, clarifyQuestion: "   ", clarifyChips: ["a"] }),
    );
    expect((await classify({ userPrompt: "ideas?" })).json.needsClarify).toBe(false);
  });

  it("drops a clarify with no usable chips", async () => {
    deps.generate.mockResolvedValueOnce(
      JSON.stringify({ intent: "discover", needsClarify: true, clarifyQuestion: "Which?", clarifyChips: [] }),
    );
    expect((await classify({ userPrompt: "ideas?" })).json.needsClarify).toBe(false);
  });

  it("ignores a truthy-but-not-true needsClarify", async () => {
    deps.generate.mockResolvedValueOnce(
      JSON.stringify({ intent: "simple", needsClarify: "yes", clarifyQuestion: "Which?", clarifyChips: ["a"] }),
    );
    expect((await classify({ userPrompt: "hi" })).json).toEqual({
      intent: "simple",
      needsClarify: false,
    });
  });
});

describe("POST /api/classify — prompt assembly", () => {
  it("includes only the latest message when there is no context", async () => {
    await classify({ userPrompt: "hello" });
    // Only the always-present date line precedes it.
    expect(lastPrompt()).toMatch(/^Today is [^\n]+\nLatest message: hello$/);
  });

  it("includes at most the last six history turns, each truncated", async () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
      content: `m${i}`.padEnd(400, "x"),
    }));
    await classify({ userPrompt: "and now?", history });

    const prompt = lastPrompt();
    expect(prompt).toContain("Recent conversation:");
    expect(prompt).not.toContain("m3"); // dropped — outside the last six
    expect(prompt).toContain("m4");
    expect(prompt).not.toContain("x".repeat(400)); // each turn capped at 300 chars
  });

  it("flags that the user has a portfolio", async () => {
    await classify({ userPrompt: "how am I doing?", portfolioContext: "AAPL 10sh" });
    expect(lastPrompt()).toContain("The user HAS a portfolio with holdings.");
  });

  it("pins the subject from the viewed page so it never asks 'which stock?'", async () => {
    const pageContext = { kind: "stock", ticker: "NVDA", snapshot: "NVDA $180, +1.2%" };
    await classify({ userPrompt: "is this a buy?", pageContext });
    expect(deps.pageContextRouteHint).toHaveBeenCalledWith(pageContext);
    expect(lastPrompt()).toContain("HINT: viewing NVDA");
  });

  it("truncates a very long user prompt", async () => {
    await classify({ userPrompt: "z".repeat(3000) });
    expect(lastPrompt()).toContain("z".repeat(2000));
    expect(lastPrompt()).not.toContain("z".repeat(2001));
  });
});

describe("POST /api/classify — guards", () => {
  it("401s an unauthenticated request", async () => {
    deps.requireAuth.mockResolvedValueOnce({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    expect((await classify({ userPrompt: "hi" })).status).toBe(401);
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it("400s an invalid body", async () => {
    expect((await classify({ userPrompt: "" })).status).toBe(400);
    expect((await classify({})).status).toBe(400);
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it("returns the throttle response before spending a model call", async () => {
    deps.userRateLimit.mockResolvedValueOnce(
      NextResponse.json({ error: "Too many requests" }, { status: 429 }),
    );
    expect((await classify({ userPrompt: "hi" })).status).toBe(429);
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it("throttles per user, not per IP", async () => {
    await classify({ userPrompt: "hi" });
    expect(deps.userRateLimit).toHaveBeenCalledWith("user_1", "classify", {
      capacity: 15,
      refillPerSec: 1,
    });
  });

  it("returns the usage-limit response when the user is out of credits", async () => {
    deps.checkUsageLimit.mockResolvedValueOnce(
      NextResponse.json({ error: "Limit reached" }, { status: 429 }),
    );
    expect((await classify({ userPrompt: "hi" })).status).toBe(429);
    expect(deps.generate).not.toHaveBeenCalled();
  });
});
