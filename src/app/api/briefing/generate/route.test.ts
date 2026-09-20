import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const deps = vi.hoisted(() => {
  const holdings = new Map<string, Record<string, unknown>[]>();
  const added: { uid: string; data: Record<string, unknown> }[] = [];
  return {
    holdings,
    added,
    requireAuth: vi.fn(),
    requireEntitlement: vi.fn(),
    userRateLimit: vi.fn(),
    checkUsageLimit: vi.fn(),
    generate: vi.fn(),
    checkCache: vi.fn(),
    saveCache: vi.fn(),
    secretMatches: vi.fn(),
    collectionGroupGet: vi.fn(),
    agents: {
      risk: vi.fn(),
      news: vi.fn(),
      macro: vi.fn(),
      technical: vi.fn(),
      earnings: vi.fn(),
      insider: vi.fn(),
      sentiment: vi.fn(),
      analyst: vi.fn(),
    },
  };
});

vi.mock("@/lib/requireAuth", () => ({ requireAuth: deps.requireAuth }));
vi.mock("@/lib/entitlements", () => ({ requireEntitlement: deps.requireEntitlement }));
vi.mock("@/lib/rateLimit", () => ({ userRateLimit: deps.userRateLimit }));
vi.mock("@/lib/llm", () => ({ generate: deps.generate }));
vi.mock("@/lib/agentMemory", () => ({ checkCache: deps.checkCache, saveCache: deps.saveCache }));
vi.mock("@/lib/secretMatches", () => ({ secretMatches: deps.secretMatches }));
vi.mock("@/lib/dataAccuracy", () => ({ DATA_ACCURACY_RULE: "ACCURACY_RULE" }));
vi.mock("@/lib/usage", () => ({
  checkUsageLimit: deps.checkUsageLimit,
  recordUsage: vi.fn(),
  makeRunContext: (userId: string) => ({ userId }),
  usageStore: { enterWith: vi.fn(), run: (_c: unknown, fn: () => unknown) => fn() },
}));

vi.mock("@/agents/sub-agents/risk-agent", () => ({ runRiskAgent: deps.agents.risk }));
vi.mock("@/agents/sub-agents/news-agent", () => ({ runNewsAgent: deps.agents.news }));
vi.mock("@/agents/sub-agents/macro-agent", () => ({ runMacroAgent: deps.agents.macro }));
vi.mock("@/agents/sub-agents/technical-agent", () => ({ runTechnicalAgent: deps.agents.technical }));
vi.mock("@/agents/sub-agents/earnings-agent", () => ({ runEarningsAgent: deps.agents.earnings }));
vi.mock("@/agents/sub-agents/insider-agent", () => ({ runInsiderAgent: deps.agents.insider }));
vi.mock("@/agents/sub-agents/sentiment-agent", () => ({ runSentimentAgent: deps.agents.sentiment }));
vi.mock("@/agents/sub-agents/analyst-agent", () => ({ runAnalystAgent: deps.agents.analyst }));

vi.mock("@/lib/firebase-admin", () => ({
  db: {
    collection: () => ({
      doc: (uid: string) => ({
        collection: (name: string) =>
          name === "holdings"
            ? {
                orderBy: () => ({
                  get: async () => ({
                    docs: (deps.holdings.get(uid) ?? []).map((h) => ({ data: () => h })),
                  }),
                }),
              }
            : {
                add: async (data: Record<string, unknown>) => {
                  deps.added.push({ uid, data });
                  return { id: `brief_${deps.added.length}` };
                },
              },
      }),
    }),
    collectionGroup: () => ({ get: deps.collectionGroupGet }),
  },
}));

import { POST } from "./route";

function post(headers: Record<string, string> = {}) {
  return new Request("http://test.local/api/briefing/generate", { method: "POST", headers });
}

/** The prompt handed to the synthesis model. */
const synthPrompt = () => deps.generate.mock.calls.at(-1)![0].prompt as string;

beforeEach(() => {
  vi.clearAllMocks();
  deps.holdings.clear();
  deps.added.length = 0;
  deps.requireAuth.mockResolvedValue({ userId: "user_1" });
  deps.requireEntitlement.mockResolvedValue(null);
  deps.userRateLimit.mockResolvedValue(null);
  deps.checkUsageLimit.mockResolvedValue(null);
  deps.secretMatches.mockReturnValue(false);
  deps.checkCache.mockResolvedValue(null);
  deps.saveCache.mockResolvedValue(undefined);
  deps.generate.mockResolvedValue("# Weekly Briefing — synthesised");
  for (const [name, fn] of Object.entries(deps.agents)) fn.mockResolvedValue(`${name} report`);
  deps.holdings.set("user_1", [
    { ticker: "AAPL", companyName: "Apple Inc.", shares: 10, avgCost: 150 },
    { ticker: "MSFT", shares: 5, avgCost: 300 },
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/briefing/generate — interactive path", () => {
  it("generates and persists a briefing", async () => {
    const res = await POST(post());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      id: "brief_1",
      content: "# Weekly Briefing — synthesised",
      tickers: ["AAPL", "MSFT"],
    });
    expect(typeof json.createdAt).toBe("string");
  });

  it("stores tickers JSON-encoded and unread", async () => {
    await POST(post());
    expect(deps.added[0]).toMatchObject({
      uid: "user_1",
      data: { userId: "user_1", tickers: '["AAPL","MSFT"]', readAt: null },
    });
  });

  it("runs all eight agents in parallel", async () => {
    await POST(post());
    for (const fn of Object.values(deps.agents)) expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes the holdings as a portfolio string to the risk agent and tickers to the rest", async () => {
    await POST(post());
    expect(deps.agents.risk).toHaveBeenCalledWith({
      portfolio: "- AAPL (Apple Inc.): 10 shares @ avg $150\n- MSFT: 5 shares @ avg $300",
    });
    expect(deps.agents.news).toHaveBeenCalledWith({ tickers: ["AAPL", "MSFT"] });
  });

  it("includes every agent section and the accuracy rule in the synthesis prompt", async () => {
    await POST(post());
    const prompt = synthPrompt();
    for (const label of ["Risk", "News", "Macro", "Technical", "Earnings", "Insider", "Sentiment", "Analyst"]) {
      expect(prompt).toContain(`### ${label}`);
    }
    expect(prompt).toContain("ACCURACY_RULE");
    expect(prompt).toContain("Weekly Portfolio Briefing");
  });

  it("truncates a long agent report in the prompt", async () => {
    deps.agents.risk.mockResolvedValueOnce("r".repeat(5000));
    await POST(post());
    expect(synthPrompt()).not.toContain("r".repeat(1201));
  });

  it("drops a failed agent's section but still briefs", async () => {
    deps.agents.macro.mockRejectedValueOnce(new Error("finnhub 500"));
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(synthPrompt()).not.toContain("### Macro");
    expect(synthPrompt()).toContain("### Risk");
  });

  it("serves a cached agent report instead of re-running it", async () => {
    deps.checkCache.mockImplementation(async (name: string) =>
      name === "run_news_agent" ? "cached news" : null,
    );
    await POST(post());
    expect(deps.agents.news).not.toHaveBeenCalled();
    expect(synthPrompt()).toContain("cached news");
  });

  it("caches a fresh agent report", async () => {
    await POST(post());
    expect(deps.saveCache).toHaveBeenCalledWith(
      "run_news_agent",
      { tickers: ["AAPL", "MSFT"] },
      "news report",
    );
  });

  it("survives a cache-save failure", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    deps.saveCache.mockRejectedValue(new Error("firestore down"));
    expect((await POST(post())).status).toBe(200);
    spy.mockRestore();
  });

  it("400s when the user has no holdings", async () => {
    deps.holdings.set("user_1", []);
    const res = await POST(post());
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "No holdings to brief" });
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it("500s (without leaking the cause) when synthesis fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    deps.generate.mockRejectedValueOnce(new Error("anthropic 529"));
    const res = await POST(post());
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to generate briefing" });
    spy.mockRestore();
  });
});

describe("POST /api/briefing/generate — guards", () => {
  it("401s an unauthenticated request", async () => {
    deps.requireAuth.mockResolvedValueOnce({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    expect((await POST(post())).status).toBe(401);
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it("403s a plan without the weeklyBriefings capability", async () => {
    deps.requireEntitlement.mockResolvedValueOnce(
      NextResponse.json({ error: "Upgrade required" }, { status: 403 }),
    );
    expect((await POST(post())).status).toBe(403);
    expect(deps.requireEntitlement).toHaveBeenCalledWith("user_1", "weeklyBriefings");
    expect(deps.generate).not.toHaveBeenCalled();
  });

  it("returns the throttle response before running agents", async () => {
    deps.userRateLimit.mockResolvedValueOnce(
      NextResponse.json({ error: "Too many requests" }, { status: 429 }),
    );
    expect((await POST(post())).status).toBe(429);
    expect(deps.agents.risk).not.toHaveBeenCalled();
  });

  it("returns the usage-limit response when out of credits", async () => {
    deps.checkUsageLimit.mockResolvedValueOnce(
      NextResponse.json({ error: "Limit reached" }, { status: 429 }),
    );
    expect((await POST(post())).status).toBe(429);
    expect(deps.generate).not.toHaveBeenCalled();
  });
});

describe("POST /api/briefing/generate — cron path", () => {
  beforeEach(() => {
    deps.secretMatches.mockReturnValue(true);
    vi.stubEnv("CRON_SECRET", "s3cret");
  });

  it("fans out to every user who holds something", async () => {
    deps.holdings.set("user_2", [{ ticker: "NVDA", shares: 1, avgCost: 900 }]);
    deps.collectionGroupGet.mockResolvedValueOnce({
      docs: [
        { ref: { parent: { parent: { id: "user_1", parent: { id: "users", parent: null } } } } },
        { ref: { parent: { parent: { id: "user_2", parent: { id: "users", parent: null } } } } },
        { ref: { parent: { parent: { id: "user_1", parent: { id: "users", parent: null } } } } }, // duplicate user
      ],
    });

    const res = await POST(post({ "x-cron-secret": "s3cret" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ generated: 2, total: 2 });
    expect(deps.added.map((a) => a.uid).sort()).toEqual(["user_1", "user_2"]);
  });

  // Regression: collectionGroup("holdings") also matched a "holdings" collection a
  // user planted deeper in their own tree, whose parent doc then looked like a user.
  it("only fans out to real users/{uid}/holdings parents", async () => {
    deps.collectionGroupGet.mockResolvedValueOnce({
      docs: [
        { ref: { parent: { parent: { id: "user_1", parent: { id: "users", parent: null } } } } },
        // users/user_1/conversations/planted/holdings/x → parent doc "planted"
        { ref: { parent: { parent: { id: "planted", parent: { id: "conversations", parent: { id: "user_1" } } } } } },
      ],
    });

    const res = await POST(post({ "x-cron-secret": "s3cret" }));
    await expect(res.json()).resolves.toEqual({ generated: 1, total: 1 });
    expect(deps.added.map((a) => a.uid)).toEqual(["user_1"]);
  });

  it("skips auth entirely when the cron secret matches", async () => {
    deps.collectionGroupGet.mockResolvedValueOnce({ docs: [] });
    await POST(post({ "x-cron-secret": "s3cret" }));
    expect(deps.requireAuth).not.toHaveBeenCalled();
  });

  it("compares the secret in constant time", async () => {
    deps.collectionGroupGet.mockResolvedValueOnce({ docs: [] });
    await POST(post({ "x-cron-secret": "s3cret" }));
    expect(deps.secretMatches).toHaveBeenCalledWith("s3cret", "s3cret");
  });

  it("reports zero when nobody holds anything", async () => {
    deps.collectionGroupGet.mockResolvedValueOnce({ docs: [] });
    await expect((await POST(post({ "x-cron-secret": "s3cret" }))).json()).resolves.toEqual({
      generated: 0,
      total: 0,
    });
  });

  it("still counts a user whose briefing 400s (no holdings) as settled", async () => {
    // generateForUser resolves with a 400 response rather than throwing, so the
    // fan-out counts it as fulfilled — the endpoint reports attempts, not successes.
    deps.holdings.set("user_3", []);
    deps.collectionGroupGet.mockResolvedValueOnce({
      docs: [{ ref: { parent: { parent: { id: "user_3", parent: { id: "users", parent: null } } } } }],
    });
    await expect((await POST(post({ "x-cron-secret": "s3cret" }))).json()).resolves.toEqual({
      generated: 1,
      total: 1,
    });
  });
});
