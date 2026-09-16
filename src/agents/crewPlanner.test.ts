import { describe, it, expect, beforeEach } from "vitest";
import {
  planCrew,
  agentMedianMs,
  recordAgentLatency,
  resetAgentLatencies,
  SEED_AGENT_MEDIAN_MS,
  SEED_SYNTHESIS_MS,
  recordSynthesisLatency,
  synthesisMedianMs,
  FULL_CREW_MIN,
  FULL_CREW_MAX,
  DEEP_CREW_MIN,
  DEEP_CREW_MAX,
} from "./crewPlanner";

beforeEach(() => resetAgentLatencies());

describe("planCrew — rules table", () => {
  it("routes a valuation question to the valuation crew", () => {
    const plan = planCrew("Is NVDA overvalued at these levels?");
    expect(plan.rule).toBe("valuation");
    expect(plan.agents).toEqual([
      "run_fundamentals_agent",
      "run_dcf_agent",
      "run_comparables_agent",
      "run_analyst_agent",
    ]);
  });

  it("routes a worry/risk question to the risk crew", () => {
    const plan = planCrew("Should I worry about my AMD position?");
    expect(plan.rule).toBe("risk");
    expect(plan.agents).toEqual([
      "run_risk_agent",
      "run_news_agent",
      "run_insider_agent",
      "run_macro_agent",
    ]);
  });

  it("routes an earnings question to the earnings crew", () => {
    const plan = planCrew("How did TSLA's last earnings report land?");
    expect(plan.rule).toBe("earnings");
    expect(plan.agents).toEqual([
      "run_earnings_agent",
      "run_analyst_agent",
      "run_news_agent",
      "run_technical_agent",
    ]);
  });

  it("routes an income question to the income crew", () => {
    const plan = planCrew("Is KO a reliable dividend payer?");
    expect(plan.rule).toBe("income");
    expect(plan.agents).toEqual([
      "run_fundamentals_agent",
      "run_risk_agent",
      "run_macro_agent",
    ]);
  });

  it("falls back to a balanced crew for an unclassified question", () => {
    const plan = planCrew("Full analysis of AMD");
    expect(plan.rule).toBe("default");
    expect(plan.agents.length).toBeGreaterThanOrEqual(FULL_CREW_MIN);
  });

  it("is deterministic — the same question always plans the same crew", () => {
    const a = planCrew("Is NVDA overvalued?");
    const b = planCrew("is nvda OVERVALUED?");
    expect(b.agents).toEqual(a.agents);
    expect(b.rule).toBe(a.rule);
  });

  it("sizes every non-deep crew to 3–5 agents", () => {
    const questions = [
      "Is NVDA overvalued at these levels?",
      "Should I worry about my AMD position?",
      "How did TSLA's last earnings report land?",
      "Is KO a reliable dividend payer?",
      "Full analysis of AMD",
      "",
    ];
    for (const q of questions) {
      const { agents } = planCrew(q);
      expect(agents.length).toBeGreaterThanOrEqual(FULL_CREW_MIN);
      expect(agents.length).toBeLessThanOrEqual(FULL_CREW_MAX);
      expect(new Set(agents).size).toBe(agents.length); // no duplicates
    }
  });

  it("plans a larger, clearly-labelled crew for Deep Research", () => {
    const plan = planCrew("Is NVDA overvalued?", { deepResearch: true });
    expect(plan.deep).toBe(true);
    expect(plan.rule).toBe("deep_research");
    expect(plan.agents.length).toBeGreaterThanOrEqual(DEEP_CREW_MIN);
    expect(plan.agents.length).toBeLessThanOrEqual(DEEP_CREW_MAX);
    expect(new Set(plan.agents).size).toBe(plan.agents.length);
  });
});

describe("planCrew — ETA", () => {
  it("is the summed per-agent median plus synthesis, in whole seconds", () => {
    const plan = planCrew("Is NVDA overvalued?");
    const expected = Math.ceil(
      (plan.agents.reduce((sum, a) => sum + SEED_AGENT_MEDIAN_MS[a], 0) + SEED_SYNTHESIS_MS) / 1000
    );
    expect(plan.etaSeconds).toBe(expected);
  });

  it("grows with the crew — Deep Research quotes a longer ETA", () => {
    const quick = planCrew("Is NVDA overvalued?");
    const deep = planCrew("Is NVDA overvalued?", { deepResearch: true });
    expect(deep.etaSeconds).toBeGreaterThan(quick.etaSeconds);
  });

  it("uses observed latencies once they have been recorded", () => {
    recordAgentLatency("run_dcf_agent", 1_000);
    recordAgentLatency("run_dcf_agent", 3_000);
    const withObserved = planCrew("Is NVDA overvalued?").etaSeconds;
    resetAgentLatencies();
    const withSeed = planCrew("Is NVDA overvalued?").etaSeconds;
    expect(withObserved).toBeLessThan(withSeed);
  });
});

describe("agentMedianMs", () => {
  it("falls back to the seeded constant with no observations", () => {
    expect(agentMedianMs("run_news_agent")).toBe(SEED_AGENT_MEDIAN_MS.run_news_agent);
  });

  it("returns the median of the observed samples", () => {
    recordAgentLatency("run_news_agent", 1_000);
    recordAgentLatency("run_news_agent", 9_000);
    recordAgentLatency("run_news_agent", 5_000);
    expect(agentMedianMs("run_news_agent")).toBe(5_000);
  });

  it("averages the middle pair for an even number of samples", () => {
    recordAgentLatency("run_news_agent", 2_000);
    recordAgentLatency("run_news_agent", 4_000);
    expect(agentMedianMs("run_news_agent")).toBe(3_000);
  });

  it("rolls — only the most recent samples count", () => {
    for (let i = 0; i < 40; i++) recordAgentLatency("run_news_agent", 90_000);
    for (let i = 0; i < 40; i++) recordAgentLatency("run_news_agent", 2_000);
    expect(agentMedianMs("run_news_agent")).toBe(2_000);
  });

  it("ignores junk samples", () => {
    recordAgentLatency("run_news_agent", 0);
    recordAgentLatency("run_news_agent", -5);
    recordAgentLatency("run_news_agent", Number.NaN);
    expect(agentMedianMs("run_news_agent")).toBe(SEED_AGENT_MEDIAN_MS.run_news_agent);
  });
});

describe("synthesisMedianMs", () => {
  it("falls back to the seed before anything has been observed", () => {
    expect(synthesisMedianMs()).toBe(SEED_SYNTHESIS_MS);
  });

  it("tracks observed synthesis time — the dominant cost of a crew answer", () => {
    recordSynthesisLatency(100_000);
    recordSynthesisLatency(200_000);
    expect(synthesisMedianMs()).toBe(150_000);
  });

  it("moves the quoted ETA, since synthesis dominates the wait", () => {
    const seeded = planCrew("Is NVDA overvalued?").etaSeconds;
    recordSynthesisLatency(300_000);
    expect(planCrew("Is NVDA overvalued?").etaSeconds).toBeGreaterThan(seeded);
  });

  it("ignores junk samples", () => {
    recordSynthesisLatency(0);
    recordSynthesisLatency(-1);
    recordSynthesisLatency(Number.NaN);
    expect(synthesisMedianMs()).toBe(SEED_SYNTHESIS_MS);
  });
});
