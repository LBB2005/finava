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
  recordProviderFailure: vi.fn(),
}));

vi.mock("@/lib/providerHealth", () => ({ recordProviderFailure: deps.recordProviderFailure }));

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
    deps.generate.mockResolvedValueOnce('{"intent":"fast"}');
    await expect(classify({ userPrompt: "is TSLA a buy?" })).resolves.toEqual({
      status: 200,
      json: { intent: "fast" },
    });
  });

  it("tells the router today's date", async () => {
    await classify({ userPrompt: "what happened in markets today?" });
    expect(lastPrompt()).toMatch(/^Today is \w+day, \d{1,2} \w+ \d{4} \(US\/Eastern\)\. US market: /);
  });

  it("accepts the discover intent", async () => {
    deps.generate.mockResolvedValueOnce('{"intent":"discover"}');
    expect((await classify({ userPrompt: "find cheap energy stocks" })).json.intent).toBe("discover");
  });

  it("falls back to fast for an unrecognised intent", async () => {
    deps.generate.mockResolvedValueOnce('{"intent":"deep_research"}');
    expect((await classify({ userPrompt: "hi" })).json.intent).toBe("fast");
  });

  it("falls back to fast when the intent field is missing", async () => {
    deps.generate.mockResolvedValueOnce("{}");
    expect((await classify({ userPrompt: "hi" })).json).toEqual({ intent: "fast" });
  });

  it("no longer emits the retired simple/agent intents", async () => {
    deps.generate.mockResolvedValueOnce('{"intent":"agent"}');
    expect((await classify({ userPrompt: "is NVDA a buy?" })).json.intent).toBe("fast");
    deps.generate.mockResolvedValueOnce('{"intent":"simple"}');
    expect((await classify({ userPrompt: "what is a P/E ratio?" })).json.intent).toBe("fast");
  });

  it("calls the cheap router model with a token cap", async () => {
    await classify({ userPrompt: "hi" });
    expect(deps.generate).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "chatRouter", maxTokens: 200 }),
    );
  });
});

// The heart of W2-1: the crew is opt-in. On 13-14 Sep, Auto sent 80 of 138
// turns to it unasked — median 253 s, one run 382 s, past the 300 s cap.
describe("POST /api/classify — the crew is opt-in", () => {
  const explicit = [
    "full analysis of NVDA",
    "deep dive on AMD",
    "run the crew on TSLA",
    "research report on SOFI",
  ];
  for (const userPrompt of explicit) {
    it(`routes "${userPrompt}" to full_analysis`, async () => {
      deps.generate.mockResolvedValueOnce('{"intent":"full_analysis"}');
      expect((await classify({ userPrompt })).json.intent).toBe("full_analysis");
    });
  }

  const fastFamily = [
    "is it too late to buy NVDA?",
    "is AMD a buy right now?",
    "should I worry about TSLA's margins?",
    "thoughts on PLTR at this price",
    "how risky is my portfolio?",
  ];
  for (const userPrompt of fastFamily) {
    it(`keeps "${userPrompt}" in the fast lane even if the router says crew`, async () => {
      deps.generate.mockResolvedValueOnce('{"intent":"full_analysis"}');
      expect((await classify({ userPrompt })).json.intent).toBe("fast");
    });
  }

  it("honours an explicit crew request the router under-called", async () => {
    deps.generate.mockResolvedValueOnce('{"intent":"fast"}');
    expect((await classify({ userPrompt: "give me a full analysis of NVDA" })).json.intent).toBe(
      "full_analysis",
    );
  });

  it("never sends a brevity follow-up to the crew", async () => {
    deps.generate.mockResolvedValueOnce('{"intent":"full_analysis"}');
    expect((await classify({ userPrompt: "so yes or no?" })).json.intent).toBe("fast");
  });
});

describe("POST /api/classify — model output parsing", () => {
  it("unwraps a ```json fenced response", async () => {
    deps.generate.mockResolvedValueOnce('```json\n{"intent":"discover"}\n```');
    expect((await classify({ userPrompt: "cheap energy names" })).json.intent).toBe("discover");
  });

  it("extracts the object from surrounding prose", async () => {
    deps.generate.mockResolvedValueOnce('Sure! {"intent":"discover"} Hope that helps.');
    expect((await classify({ userPrompt: "cheap energy names" })).json.intent).toBe("discover");
  });

  it("degrades to fast when the response has no JSON object", async () => {
    deps.generate.mockResolvedValueOnce("I think you want the crew.");
    expect((await classify({ userPrompt: "NVDA" })).json).toEqual({ intent: "fast" });
  });

  it("degrades to fast on malformed JSON", async () => {
    deps.generate.mockResolvedValueOnce('{"intent":"discover",}');
    expect((await classify({ userPrompt: "NVDA" })).json.intent).toBe("fast");
  });

  it("never dead-ends when the model call throws, and says the route is degraded", async () => {
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    deps.generate.mockRejectedValueOnce(new Error("upstream 500"));
    await expect(classify({ userPrompt: "NVDA" })).resolves.toEqual({
      status: 200,
      json: { intent: "fast", degraded: true },
    });
  });

  it("still honours an explicit crew request when the router is down", async () => {
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    deps.generate.mockRejectedValueOnce(new Error("upstream 500"));
    const { json } = await classify({ userPrompt: "full analysis of NVDA" });
    expect(json).toEqual({ intent: "full_analysis", degraded: true });
  });

  it("logs the failure and marks router health degraded (no silent fallback)", async () => {
    const log = vi.spyOn(console, "error").mockImplementationOnce(() => {});
    const err = new Error("[llm:chatRouter] 402 Insufficient credits");
    deps.generate.mockRejectedValueOnce(err);
    await classify({ userPrompt: "full analysis of NVDA" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[classify]"), err);
    expect(deps.recordProviderFailure).toHaveBeenCalledWith("router");
  });

  it("does not flag a parse failure as degraded (the model answered)", async () => {
    deps.generate.mockResolvedValueOnce("I think you want agent mode.");
    expect((await classify({ userPrompt: "NVDA" })).json.degraded).toBeUndefined();
    expect(deps.recordProviderFailure).not.toHaveBeenCalled();
  });
});

describe("POST /api/classify — clarify handling", () => {
  const clarify = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      intent: "clarify",
      clarifyQuestion: "  What are you after?  ",
      clarifyChips: ["Growth", "Value", "Quality"],
      ...over,
    });

  it("passes through a well-formed clarify", async () => {
    deps.generate.mockResolvedValueOnce(clarify());
    expect((await classify({ userPrompt: "what should I buy?" })).json).toEqual({
      intent: "clarify",
      clarifyQuestion: "What are you after?",
      clarifyChips: ["Growth", "Value", "Quality"],
    });
  });

  it("caps the chips at four", async () => {
    deps.generate.mockResolvedValueOnce(clarify({ clarifyChips: ["a", "b", "c", "d", "e", "f"] }));
    expect((await classify({ userPrompt: "ideas?" })).json.clarifyChips).toEqual(["a", "b", "c", "d"]);
  });

  it("drops a clarify that has no question", async () => {
    deps.generate.mockResolvedValueOnce(clarify({ clarifyQuestion: undefined }));
    expect((await classify({ userPrompt: "ideas?" })).json).toEqual({ intent: "discover" });
  });

  it("drops a clarify whose question is blank", async () => {
    deps.generate.mockResolvedValueOnce(clarify({ clarifyQuestion: "   " }));
    expect((await classify({ userPrompt: "ideas?" })).json.intent).toBe("discover");
  });

  it("drops a clarify with no usable chips", async () => {
    deps.generate.mockResolvedValueOnce(clarify({ clarifyChips: [] }));
    expect((await classify({ userPrompt: "ideas?" })).json.intent).toBe("discover");
  });

  it("never asks which stock when the page already pins one", async () => {
    deps.generate.mockResolvedValueOnce(clarify({ clarifyQuestion: "Which stock?" }));
    const { json } = await classify({
      userPrompt: "is this a buy?",
      pageContext: { kind: "stock", ticker: "NVDA", snapshot: "NVDA $180" },
    });
    expect(json).toEqual({ intent: "fast" });
  });

  it("never asks which stock when the message names one", async () => {
    deps.generate.mockResolvedValueOnce(clarify());
    expect((await classify({ userPrompt: "is NVDA a buy?" })).json.intent).toBe("fast");
  });

  it("does not clarify when amount, level and goal are already given", async () => {
    // The readout's Priya case: she said everything needed and was asked anyway.
    deps.generate.mockResolvedValueOnce(clarify({ clarifyQuestion: "What's your risk tolerance?" }));
    const { json } = await classify({
      userPrompt:
        "I have $5,000 to invest, I'm a complete beginner, and I want long-term growth over 10 years. Where do I start?",
    });
    expect(json).toEqual({ intent: "discover" });
  });

  it("does not clarify twice in a row", async () => {
    deps.generate.mockResolvedValueOnce(clarify());
    const { json } = await classify({ userPrompt: "what should I buy?", allowClarify: false });
    expect(json).toEqual({ intent: "discover" });
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
