import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const generate = vi.fn(async (_o?: unknown) => "RISK ANALYSIS");
vi.mock("@/lib/llm", () => ({ generate: (o: unknown) => generate(o) }));
vi.mock("@/agents/skills", () => ({ getSkillsPrompt: () => "skill prompt" }));

const getCandles = vi.fn();
const getSnapshots = vi.fn();
vi.mock("@/lib/finnhub", () => ({
  getCandles: (...a: unknown[]) => getCandles(...a),
  getSnapshots: (...a: unknown[]) => getSnapshots(...a),
}));

const lastPrompt = () => generate.mock.calls.at(-1)![0] as { prompt: string; agent: string };

// A rising 60-day close series → finite returns/variance for beta math.
const closes = Array.from({ length: 60 }, (_, i) => 100 + i);

beforeEach(() => {
  generate.mockClear().mockResolvedValue("RISK ANALYSIS");
  getCandles.mockReset().mockResolvedValue({ c: closes });
  getSnapshots.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("runRiskAgent", () => {
  it("skips market data and notes missing position sizes when no Finnhub key is set", async () => {
    vi.stubEnv("FINNHUB_API_KEY", "");
    const { runRiskAgent } = await import("./risk-agent");
    const out = await runRiskAgent({ tickers: ["AAPL"] });
    expect(out).toBe("RISK ANALYSIS");
    expect(lastPrompt().agent).toBe("risk");
    const p = lastPrompt().prompt;
    expect(p).toContain("AAPL");
    expect(p).toContain("Per-position weights were not available");
    expect(getCandles).not.toHaveBeenCalled();
  });

  it("computes vol/beta metrics and a weighted portfolio block from holdings", async () => {
    vi.stubEnv("FINNHUB_API_KEY", "key");
    getSnapshots.mockResolvedValue([{ ticker: "AAPL", price: 180, changePct: 1.5 }]);
    const { runRiskAgent } = await import("./risk-agent");
    const out = await runRiskAgent(
      { tickers: ["AAPL"], focus: "drawdown" },
      [{ ticker: "AAPL", shares: 10 }]
    );
    expect(out).toBe("RISK ANALYSIS");
    const p = lastPrompt().prompt;
    expect(p).toContain("AAPL");
    expect(p).toContain("annualizedVolatility");
    expect(p).toContain("Focus on: drawdown");
    expect(p).toContain("COMPUTED, AUTHORITATIVE");
    expect(p).toContain("% of portfolio");
  });

  it("states each position's dollar change at −10/−20/−30%, so the model never works it out", async () => {
    vi.stubEnv("FINNHUB_API_KEY", "key");
    getSnapshots.mockResolvedValue([{ ticker: "AAPL", price: 180, changePct: 1.5 }]);
    const { runRiskAgent } = await import("./risk-agent");
    await runRiskAgent({ tickers: ["AAPL"] }, [{ ticker: "AAPL", shares: 10 }]);
    const p = lastPrompt().prompt;
    // 10 × $180 = $1,800.
    expect(p).toContain("AAPL $1,800 → −10%: -$180 · −20%: -$360 · −30%: -$540");
  });

  it("reports 'Could not fetch market data' when the data fetch throws", async () => {
    vi.stubEnv("FINNHUB_API_KEY", "key");
    getSnapshots.mockRejectedValue(new Error("rate limited"));
    getCandles.mockRejectedValue(new Error("rate limited"));
    const { runRiskAgent } = await import("./risk-agent");
    const out = await runRiskAgent({ tickers: ["AAPL"] });
    expect(out).toBe("RISK ANALYSIS");
    expect(lastPrompt().prompt).toContain("Could not fetch market data");
  });

  it("returns a safe fallback string when the model yields nothing", async () => {
    vi.stubEnv("FINNHUB_API_KEY", "");
    generate.mockResolvedValue("");
    const { runRiskAgent } = await import("./risk-agent");
    expect(await runRiskAgent({ tickers: ["AAPL"] })).toBe("Risk analysis unavailable.");
  });
});
