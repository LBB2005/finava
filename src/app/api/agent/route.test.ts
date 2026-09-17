import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => ({
  withAuthRaw: vi.fn(),
  runCeoAgent: vi.fn(),
  runDiscoveryWave: vi.fn(),
  runDiscoverySynthesis: vi.fn(),
  userRateLimit: vi.fn(),
  checkUsageLimit: vi.fn(),
  checkDeepResearchAllowed: vi.fn(),
  recordDeepResearchRun: vi.fn(),
  usageRun: vi.fn((_store: { userId: string }, fn: () => unknown) => fn()),
  loadDnaSummary: vi.fn(),
}));

vi.mock("@/lib/investorDnaStore", () => ({ loadDnaSummary: deps.loadDnaSummary }));

vi.mock("@/lib/withRoute", () => ({
  withAuthRaw: deps.withAuthRaw,
}));

vi.mock("@/agents/ceo", () => ({
  runCeoAgent: deps.runCeoAgent,
}));

vi.mock("@/agents/discovery", () => ({
  runDiscoveryWave: deps.runDiscoveryWave,
  runDiscoverySynthesis: deps.runDiscoverySynthesis,
}));

vi.mock("@/lib/rateLimit", () => ({
  userRateLimit: deps.userRateLimit,
}));

vi.mock("@/lib/usage", () => ({
  checkUsageLimit: deps.checkUsageLimit,
  checkDeepResearchAllowed: deps.checkDeepResearchAllowed,
  recordDeepResearchRun: deps.recordDeepResearchRun,
  makeRunContext: (u: string) => ({ userId: u }),
  usageStore: { run: deps.usageRun },
}));

import { POST } from "./route";

async function readSse(res: Response) {
  return res.text();
}

function agentRequest(body: Record<string, unknown>) {
  return new Request("http://test.local/api/agent", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.withAuthRaw.mockReturnValue(async () => ({
    userId: "user_123",
    body: { userPrompt: "Research AAPL", ...{} },
  }));
  deps.userRateLimit.mockReturnValue(null);
  deps.checkUsageLimit.mockResolvedValue(null);
  deps.checkDeepResearchAllowed.mockResolvedValue(null);
  deps.recordDeepResearchRun.mockResolvedValue(undefined);
  deps.loadDnaSummary.mockResolvedValue(null);
  deps.runCeoAgent.mockImplementation(async (_prompt, _portfolio, emit) => {
    emit({ type: "message", message: "done" });
  });
  deps.runDiscoveryWave.mockImplementation(async (_wave, emit) => {
    emit({ type: "wave", wave: 1 });
  });
  deps.runDiscoverySynthesis.mockImplementation(async (_wave, emit) => {
    emit({ type: "synthesis", message: "summary" });
  });
});

describe("POST /api/agent", () => {
  it("hands the crew the user's inferred Investor DNA after the portfolio", async () => {
    deps.withAuthRaw.mockReturnValueOnce(async () => ({
      userId: "user_123",
      body: { userPrompt: "Review my portfolio", portfolioContext: "NVDA: 5 shares" },
    }));
    deps.loadDnaSummary.mockResolvedValueOnce("## Investor DNA (inferred from your holdings; the user did not state any of this)");

    await readSse(await POST(agentRequest({ userPrompt: "Review my portfolio" })));

    expect(deps.loadDnaSummary).toHaveBeenCalledWith("user_123");
    expect(deps.runCeoAgent.mock.calls[0][1]).toBe(
      "NVDA: 5 shares\n\n## Investor DNA (inferred from your holdings; the user did not state any of this)"
    );
  });

  it("keeps the crew context unchanged when there is no DNA", async () => {
    deps.withAuthRaw.mockReturnValueOnce(async () => ({
      userId: "user_123",
      body: { userPrompt: "Review my portfolio", portfolioContext: "NVDA: 5 shares" },
    }));
    await readSse(await POST(agentRequest({ userPrompt: "Review my portfolio" })));
    expect(deps.runCeoAgent.mock.calls[0][1]).toBe("NVDA: 5 shares");
  });

  it("returns auth/validation responses from withAuthRaw before any spend", async () => {
    deps.withAuthRaw.mockReturnValueOnce(async () =>
      NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    );

    const res = await POST(agentRequest({ userPrompt: "x" }));

    expect(res.status).toBe(401);
    expect(deps.userRateLimit).not.toHaveBeenCalled();
    expect(deps.checkUsageLimit).not.toHaveBeenCalled();
    expect(deps.runCeoAgent).not.toHaveBeenCalled();
  });

  it("applies agent burst throttling before usage checks", async () => {
    const throttled = NextResponse.json({ error: "Too many" }, { status: 429 });
    deps.userRateLimit.mockReturnValueOnce(throttled);

    const res = await POST(agentRequest({ userPrompt: "x" }));

    expect(res.status).toBe(429);
    expect(deps.userRateLimit).toHaveBeenCalledWith("user_123", "agent", {
      capacity: 4,
      refillPerSec: 0.1,
    });
    expect(deps.checkUsageLimit).not.toHaveBeenCalled();
    expect(deps.runCeoAgent).not.toHaveBeenCalled();
  });

  it("blocks over-quota users before creating the stream", async () => {
    deps.checkUsageLimit.mockResolvedValueOnce(
      NextResponse.json({ error: "quota" }, { status: 429 })
    );

    const res = await POST(agentRequest({ userPrompt: "x" }));

    expect(res.status).toBe(429);
    expect(deps.usageRun).not.toHaveBeenCalled();
    expect(deps.runCeoAgent).not.toHaveBeenCalled();
  });

  it("checks and records deep-research initiation before streaming", async () => {
    deps.withAuthRaw.mockReturnValueOnce(async () => ({
      userId: "user_123",
      body: { userPrompt: "Deep dive", deepResearch: true },
    }));

    const res = await POST(agentRequest({ userPrompt: "Deep dive", deepResearch: true }));
    await readSse(res);

    expect(deps.checkDeepResearchAllowed).toHaveBeenCalledWith("user_123");
    expect(deps.recordDeepResearchRun).toHaveBeenCalledWith("user_123");
    expect(deps.usageRun).toHaveBeenCalledWith({ userId: "user_123" }, expect.any(Function));
    expect(deps.runCeoAgent).toHaveBeenCalledWith(
      "Deep dive",
      "",
      expect.any(Function),
      expect.objectContaining({ deepResearch: true, userId: "user_123", tier: "quick" })
    );
  });

  it("streams CEO events on the normal happy path", async () => {
    deps.withAuthRaw.mockReturnValueOnce(async () => ({
      userId: "user_123",
      body: {
        userPrompt: "Research AAPL",
        portfolioContext: "long AAPL",
        conversationHistory: [{ role: "user", content: "hi" }],
        holdings: [{ ticker: "AAPL", shares: 2 }],
        discover: true,
        tier: "deep",
        templateId: "tpl_1",
      },
    }));

    const res = await POST(agentRequest({ userPrompt: "Research AAPL" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    await expect(readSse(res)).resolves.toContain('"type":"message"');
    expect(deps.runCeoAgent).toHaveBeenCalledWith(
      "Research AAPL",
      "long AAPL",
      expect.any(Function),
      expect.objectContaining({
        deepResearch: false,
        discover: true,
        tier: "deep",
        templateId: "tpl_1",
      })
    );
  });

  it("dispatches deterministic discovery waves without charging a new deep run", async () => {
    const wave = { names: ["AAPL"] };
    deps.withAuthRaw.mockReturnValueOnce(async () => ({
      userId: "user_123",
      body: { wave },
    }));

    const res = await POST(agentRequest({ wave }));
    await expect(readSse(res)).resolves.toContain('"type":"wave"');

    expect(deps.runDiscoveryWave).toHaveBeenCalledWith(wave, expect.any(Function));
    expect(deps.checkDeepResearchAllowed).not.toHaveBeenCalled();
    expect(deps.runCeoAgent).not.toHaveBeenCalled();
  });

  it("dispatches discovery synthesis waves", async () => {
    const wave = { synthesize: true, candidates: ["AAPL"] };
    deps.withAuthRaw.mockReturnValueOnce(async () => ({
      userId: "user_123",
      body: { wave },
    }));

    const res = await POST(agentRequest({ wave }));
    await expect(readSse(res)).resolves.toContain('"type":"synthesis"');

    expect(deps.runDiscoverySynthesis).toHaveBeenCalledWith(wave, expect.any(Function));
    expect(deps.runDiscoveryWave).not.toHaveBeenCalled();
  });

  it("emits stream errors instead of throwing after the stream starts", async () => {
    deps.runCeoAgent.mockRejectedValueOnce(new Error("crew failed"));

    const res = await POST(agentRequest({ userPrompt: "x" }));

    await expect(readSse(res)).resolves.toContain('"message":"crew failed"');
  });
});
