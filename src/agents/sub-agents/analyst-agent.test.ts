import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const generate = vi.fn(async (_o?: unknown) => "ANALYST ANALYSIS");
vi.mock("@/lib/llm", () => ({ generate: (o: unknown) => generate(o) }));
vi.mock("@/agents/skills", () => ({ getSkillsPrompt: () => "skill prompt" }));

const getRecommendationTrends = vi.fn();
const getPriceTarget = vi.fn();
const getQuote = vi.fn();
vi.mock("@/lib/finnhub", () => ({
  getRecommendationTrends: (...a: unknown[]) => getRecommendationTrends(...a),
  getPriceTarget: (...a: unknown[]) => getPriceTarget(...a),
  getQuote: (...a: unknown[]) => getQuote(...a),
}));

const perplexitySearch = vi.fn();
vi.mock("@/lib/perplexity", () => ({ perplexitySearch: (...a: unknown[]) => perplexitySearch(...a) }));

vi.mock("@/lib/externalContent", () => ({
  fenceExternal: (_label: string, s: string) => s,
  EXTERNAL_DATA_RULE: "rule",
}));

const lastPrompt = () => generate.mock.calls.at(-1)![0] as { prompt: string; agent: string; system: string };

beforeEach(() => {
  generate.mockClear().mockResolvedValue("ANALYST ANALYSIS");
  getRecommendationTrends.mockReset().mockResolvedValue([]);
  getPriceTarget.mockReset().mockResolvedValue(null);
  getQuote.mockReset().mockResolvedValue({ price: 100 });
  perplexitySearch.mockReset().mockResolvedValue("");
});
afterEach(() => vi.unstubAllEnvs());

describe("runAnalystAgent", () => {
  it("falls back to a web consensus search when no structured price targets exist", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "key");
    getRecommendationTrends.mockResolvedValue([{ strongBuy: 10, buy: 5, hold: 2, sell: 0, strongSell: 0, period: "2026-05-01" }]);
    perplexitySearch.mockResolvedValue("AAPL: avg $200, range $180-$220, 30 analysts");
    const { runAnalystAgent } = await import("./analyst-agent");
    const out = await runAnalystAgent({ tickers: ["AAPL"] });
    expect(out).toBe("ANALYST ANALYSIS");
    expect(perplexitySearch).toHaveBeenCalled();
    const p = lastPrompt();
    expect(p.agent).toBe("analyst");
    expect(p.prompt).toContain("AAPL");
    expect(p.prompt).toContain("web-sourced consensus");
    expect(p.system).toContain("rule"); // EXTERNAL_DATA_RULE included when webTargets present
  });

  it("uses structured targets and skips the web search when targetMean is present", async () => {
    vi.stubEnv("PERPLEXITY_API_KEY", "key");
    getRecommendationTrends.mockResolvedValue([{ strongBuy: 3, buy: 1, hold: 4, sell: 1, strongSell: 0 }]);
    getPriceTarget.mockResolvedValue({ targetMean: 175, targetHigh: 200, targetLow: 150, numberOfAnalysts: 20 });
    const { runAnalystAgent } = await import("./analyst-agent");
    const out = await runAnalystAgent({ tickers: ["AAPL"] });
    expect(out).toBe("ANALYST ANALYSIS");
    expect(perplexitySearch).not.toHaveBeenCalled();
    const p = lastPrompt();
    expect(p.prompt).toContain("175");
    expect(p.prompt).not.toContain("web-sourced consensus");
  });

  it("hands the model the upside and consensus score instead of a formula", async () => {
    getRecommendationTrends.mockResolvedValue([{ strongBuy: 3, buy: 1, hold: 4, sell: 1, strongSell: 0 }]);
    getPriceTarget.mockResolvedValue({ targetMean: 175, targetHigh: 200, targetLow: 150, numberOfAnalysts: 20 });
    const { runAnalystAgent } = await import("./analyst-agent");
    await runAnalystAgent({ tickers: ["AAPL"] });
    const p = lastPrompt().prompt;
    // (175 / 100 − 1) × 100, and (3×2 + 1 − 1) / 9 analysts.
    expect(p).toContain('"upsidePct": 75');
    expect(p).toContain('"consensusScore": 0.67');
    expect(p).toContain('"totalAnalysts": 9');
    expect(p).not.toMatch(/Formula:/);
    expect(p).not.toMatch(/\(avg target − currentPrice\)/);
  });

  it("still synthesizes when the Finnhub data sources throw", async () => {
    getRecommendationTrends.mockRejectedValue(new Error("rate limited"));
    getPriceTarget.mockRejectedValue(new Error("403"));
    getQuote.mockRejectedValue(new Error("down"));
    const { runAnalystAgent } = await import("./analyst-agent");
    const out = await runAnalystAgent({ tickers: ["AAPL"] });
    expect(out).toBe("ANALYST ANALYSIS");
    expect(generate).toHaveBeenCalled();
    expect(lastPrompt().prompt).toContain("AAPL");
  });

  it("returns a safe fallback string when the model yields nothing", async () => {
    generate.mockResolvedValue("");
    const { runAnalystAgent } = await import("./analyst-agent");
    expect(await runAnalystAgent({ tickers: ["AAPL"] })).toBe("Analyst consensus data unavailable.");
  });
});
