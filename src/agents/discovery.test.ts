import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "@/types/chat";

const h = vi.hoisted(() => {
  const names = [
    "run_risk_agent", "run_news_agent", "run_technical_agent", "run_analyst_agent",
    "run_earnings_agent", "run_insider_agent", "run_sentiment_agent", "run_options_agent",
    "run_macro_agent", "run_dcf_agent", "run_graham_agent", "run_fundamentals_agent",
    "run_comparables_agent", "run_hype_agent", "run_competitor_agent",
  ];
  const dispatch: Record<string, (i: unknown) => Promise<string>> = {};
  for (const n of names) dispatch[n] = async () => `${n}:ok`;
  return {
    dispatch,
    checkCache: vi.fn(async () => null as string | null),
    saveCache: vi.fn(async () => {}),
    critique: vi.fn(async (p: { draft: string }) => ({ finalResponse: `${p.draft} [revised]`, truncated: false })),
    streamFinal: { value: null as unknown },
    streamThrows: { value: false },
  };
});

vi.mock("@/agents/ceo", () => ({
  agentDispatch: h.dispatch,
  agentTimeoutMs: () => 1000,
  withTimeout: <T>(p: Promise<T>) => p, // passthrough, no real timers
  critiqueAndRevise: h.critique,
}));
vi.mock("@/lib/agentMemory", () => ({ checkCache: h.checkCache, saveCache: h.saveCache }));
vi.mock("@/lib/anthropic", () => ({
  MODEL: "test-model",
  anthropic: {
    messages: {
      stream: () => ({
        finalMessage: () => {
          if (h.streamThrows.value) return Promise.reject(new Error("synthesis upstream down"));
          return Promise.resolve(h.streamFinal.value);
        },
      }),
    },
  },
}));

beforeEach(() => {
  h.checkCache.mockReset().mockResolvedValue(null);
  h.critique.mockClear();
  h.streamThrows.value = false;
  // restore a healthy dispatch for the failing-agent test
  h.dispatch.run_dcf_agent = async () => "run_dcf_agent:ok";
});

describe("runDiscoveryWave", () => {
  it("fails loud when a wave exceeds 5 tickers", async () => {
    const { runDiscoveryWave } = await import("./discovery");
    await expect(
      runDiscoveryWave({ tickers: ["A", "B", "C", "D", "E", "F"], waveIndex: 0, totalWaves: 1 } as never, () => {}),
    ).rejects.toThrow(/max is 5/);
  });

  it("runs batch agents over all tickers + valuation agents on the top-3 picks", async () => {
    const { runDiscoveryWave } = await import("./discovery");
    const events: AgentEvent[] = [];
    await runDiscoveryWave(
      { tickers: ["AAA", "BBB", "CCC"], valuationTickers: ["AAA", "BBB"], sectors: ["Tech"], waveIndex: 0, totalWaves: 2 } as never,
      (e) => events.push(e),
    );

    expect(events[0].type).toBe("wave_start");
    const result = events.find((e) => e.type === "wave_result") as { wave: { batch: Record<string, string>; valuation: Record<string, unknown> } };
    expect(result).toBeDefined();
    // All 8 batch agents + macro produced batch evidence.
    expect(Object.keys(result.wave.batch)).toContain("run_risk_agent");
    expect(Object.keys(result.wave.batch)).toContain("run_macro_agent");
    // Valuation agents ran per valuation ticker.
    expect(Object.keys(result.wave.valuation).sort()).toEqual(["AAA", "BBB"]);
    expect(result.wave.valuation.AAA).toHaveProperty("run_dcf_agent");
  });

  it("caps valuation tickers to those in the wave and to 3 max", async () => {
    const { runDiscoveryWave } = await import("./discovery");
    const events: AgentEvent[] = [];
    await runDiscoveryWave(
      { tickers: ["AAA", "BBB"], valuationTickers: ["AAA", "BBB", "ZZZ", "AAA"], waveIndex: 0, totalWaves: 1 } as never,
      (e) => events.push(e),
    );
    const result = events.find((e) => e.type === "wave_result") as { wave: { valuation: Record<string, unknown> } };
    // ZZZ is not in the wave → dropped; only valid in-wave tickers remain.
    expect(Object.keys(result.wave.valuation).every((t) => ["AAA", "BBB"].includes(t))).toBe(true);
  });

  it("isolates a throwing agent into an Error string without sinking the wave", async () => {
    h.dispatch.run_dcf_agent = async () => {
      throw new Error("dcf boom");
    };
    const { runDiscoveryWave } = await import("./discovery");
    const events: AgentEvent[] = [];
    await runDiscoveryWave(
      { tickers: ["AAA"], valuationTickers: ["AAA"], waveIndex: 0, totalWaves: 1 } as never,
      (e) => events.push(e),
    );
    const result = events.find((e) => e.type === "wave_result") as { wave: { valuation: Record<string, Record<string, string>> } };
    expect(result.wave.valuation.AAA.run_dcf_agent).toMatch(/^Error: dcf boom/);
  });
});

describe("runDiscoverySynthesis", () => {
  const req = {
    query: "cheap profitable tech",
    picks: [
      { ticker: "AAA", name: "Alpha", sector: "Tech", score: 88, grade: "A", pe: 20, fitRank: 1, reason: "cheap + growing" },
    ],
    evidence: { valuation: { AAA: { run_dcf_agent: "fair value $120" } }, waves: [{ waveIndex: 0, tickers: ["AAA"], batch: { run_risk_agent: "beta 1.0" } }] },
  };

  it("emits a self-corrected final report when the model returns a draft", async () => {
    h.streamFinal.value = { content: [{ type: "text", text: "Ranked draft" }], stop_reason: "end_turn" };
    const { runDiscoverySynthesis } = await import("./discovery");
    const events: AgentEvent[] = [];
    await runDiscoverySynthesis(req as never, (e) => events.push(e));
    expect(h.critique).toHaveBeenCalled();
    expect(events).toContainEqual(
      // replace: the revision already streamed as deltas; this emit is the whole report.
      expect.objectContaining({ type: "final_response", content: expect.stringContaining("[revised]"), replace: true }),
    );
  });

  it("emits a fallback when the draft is empty", async () => {
    h.streamFinal.value = { content: [{ type: "text", text: "   " }], stop_reason: "end_turn" };
    const { runDiscoverySynthesis } = await import("./discovery");
    const events: AgentEvent[] = [];
    await runDiscoverySynthesis(req as never, (e) => events.push(e));
    expect(h.critique).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({ type: "final_response", content: expect.stringContaining("couldn't compile") }),
    );
  });

  it("emits an error event when the synthesis call throws", async () => {
    h.streamThrows.value = true;
    const { runDiscoverySynthesis } = await import("./discovery");
    const events: AgentEvent[] = [];
    await runDiscoverySynthesis(req as never, (e) => events.push(e));
    expect(events).toContainEqual(expect.objectContaining({ type: "error" }));
  });
});
