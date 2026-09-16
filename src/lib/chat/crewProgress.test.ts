import { describe, it, expect } from "vitest";
import { crewEtaSeconds, crewSummary, formatEta, plannedDepthLabel } from "./crewProgress";
import type { AgentStep } from "@/types/chat";

const step = (agent: string, status: AgentStep["status"]): AgentStep =>
  ({ agent, status } as AgentStep);

describe("crewSummary", () => {
  it("counts the crew by state", () => {
    const s = crewSummary([step("run_risk_agent", "complete"), step("run_news_agent", "running"), step("run_dcf_agent", "pending")]);
    expect(s).toEqual({ total: 3, complete: 1, running: 1, errored: 0, pending: 1, done: false });
  });

  it("counts an errored agent as finished, not stuck", () => {
    const s = crewSummary([step("run_risk_agent", "error"), step("run_news_agent", "complete")]);
    expect(s.errored).toBe(1);
    expect(s.done).toBe(true);
  });

  it("handles an empty crew", () => {
    expect(crewSummary([]).total).toBe(0);
    expect(crewSummary([]).done).toBe(false);
  });
});

describe("crewEtaSeconds", () => {
  it("uses the planned estimate before any agent finishes", () => {
    expect(crewEtaSeconds({ steps: [step("run_risk_agent", "running")], elapsedMs: 4_000, plannedSeconds: 120 })).toBe(116);
  });

  it("re-estimates from the pace once agents finish", () => {
    // 2 of 4 done in 60s → ~30s each → ~60s left.
    const steps = [
      step("run_risk_agent", "complete"),
      step("run_news_agent", "complete"),
      step("run_dcf_agent", "running"),
      step("run_macro_agent", "pending"),
    ];
    expect(crewEtaSeconds({ steps, elapsedMs: 60_000, plannedSeconds: 200 })).toBe(60);
  });

  it("never counts down past a few seconds while work is outstanding", () => {
    // The planned estimate has already been blown through and nothing has
    // reported yet — the countdown holds, it does not go to zero or negative.
    const steps = [step("run_risk_agent", "running"), step("run_news_agent", "pending")];
    expect(crewEtaSeconds({ steps, elapsedMs: 600_000, plannedSeconds: 60 })).toBe(5);
  });

  it("returns null when the crew is done", () => {
    expect(crewEtaSeconds({ steps: [step("run_risk_agent", "complete")], elapsedMs: 10_000 })).toBeNull();
  });

  it("returns null when there is nothing to estimate from", () => {
    expect(crewEtaSeconds({ steps: [], elapsedMs: 0 })).toBeNull();
    expect(crewEtaSeconds({ steps: [step("run_risk_agent", "pending")], elapsedMs: 0 })).toBeNull();
  });
});

describe("formatEta", () => {
  it("reads in seconds under a minute", () => {
    expect(formatEta(45)).toBe("~45s left");
  });

  it("rounds to minutes above one", () => {
    expect(formatEta(135)).toBe("~2 min left");
  });

  it("says nothing without an estimate", () => {
    expect(formatEta(null)).toBeNull();
  });
});

describe("plannedDepthLabel", () => {
  it("describes the planned run", () => {
    expect(plannedDepthLabel({ agents: 4, seconds: 120 })).toBe("~2 min · 4 analysts");
  });

  it("uses the singular for one analyst", () => {
    expect(plannedDepthLabel({ agents: 1, seconds: 40 })).toBe("~40s · 1 analyst");
  });

  it("drops the time when it is unknown", () => {
    expect(plannedDepthLabel({ agents: 5 })).toBe("5 analysts");
  });

  it("returns null with nothing to say", () => {
    expect(plannedDepthLabel({})).toBeNull();
    expect(plannedDepthLabel(undefined)).toBeNull();
  });
});
