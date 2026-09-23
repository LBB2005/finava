import { describe, it, expect, vi } from "vitest";
import { POLICY_V1 } from "../policyConfig";
import { computeReturns } from "../returns";
import { ScenarioWeightsSchema, type ScenarioValue, type ScenarioWeights } from "../schemas";
import type { ResearchSnapshot } from "../contracts";
import type { EvidenceItem, ResearchClaim } from "../schemas";
import {
  assessCandidateFit,
  assessCandidateFits,
  assessScenarios,
  MAX_CANDIDATE_CONCURRENCY,
  type AssessDeps,
  type ResearchInput,
} from "./assess";
import { createJevBudget } from "./cost";
import { QUESTION_SET_VERSION, SOURCE_ADEQUACY_LEVELS } from "./questions";
import type { JevDeps } from "./client";

const KEY = "test-key-not-a-real-credential";

function res(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

/** An empty env, so a real key in a developer's .env cannot reach these tests. */
function jevDeps(fetchImpl: unknown): JevDeps {
  return {
    fetch: fetchImpl as typeof globalThis.fetch,
    apiKey: KEY,
    env: {} as NodeJS.ProcessEnv,
    sleep: async () => {},
  };
}

/** A clock that advances 50ms per read, so every latency is predictable. */
function clock(start = 1_000) {
  let t = start;
  return () => (t += 50);
}

function deps(fetchImpl: unknown, over: Partial<AssessDeps> = {}): AssessDeps {
  return { jev: jevDeps(fetchImpl), now: clock(), ...over };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const EVIDENCE: EvidenceItem[] = [
  {
    id: "ev-1",
    ticker: "NVDA",
    kind: "filing",
    source: "sec",
    url: null,
    publishedAt: "2026-08-28",
    observedAt: "2026-09-19T20:00:00.000Z",
    period: "Q2 2027",
    contentHash: "a".repeat(8),
    excerpt: "Datacentre revenue of $41.1bn, up 56% year over year.",
    standing: "clean",
  },
];

const SNAPSHOT: ResearchSnapshot = {
  id: "snap-1",
  ownerUid: "uid-1",
  ticker: "NVDA",
  asOf: "2026-09-19T20:00:00.000Z",
  mandate: {
    mode: "analyze",
    query: "Is NVDA a buy over a year?",
    ticker: "NVDA",
    horizon: {
      count: 12,
      unit: "calendar_months",
      assumed: false,
      targetDate: "2027-09-19",
      yearFraction: 1,
      note: null,
    },
    benchmark: "SPY",
    universeVersion: "universe-2026-09",
    hardFilter: null,
    qualitativeCriteria: ["durable pricing power"],
  },
  evidence: EVIDENCE,
  gaps: [
    { source: "sec", field: "freeCashFlow", reason: "rate_limited", detail: "429 from companyfacts" },
  ],
  coverage: { fcff_dcf: 0.9 },
  contentHash: "h".repeat(8),
  createdAt: "2026-09-19T20:00:05.000Z",
};

const CLAIMS: ResearchClaim[] = [
  {
    id: "cl-1",
    agent: "fundamentals",
    ticker: "NVDA",
    text: "Datacentre demand is contracted into FY27.",
    evidenceIds: ["ev-1"],
    kind: "observed",
    direction: "bull",
  },
];

const RESEARCH: ResearchInput = {
  thesis: "Datacentre demand holds through FY27.",
  claims: CLAIMS,
};

// Chosen so the midpoints are exactly representable: this file asserts the
// boundaries, and a float-noise failure here would say nothing about the mapping.
const ORDERED_RETURNS = { bear: -0.25, base: 0.25, bull: 0.75 };

function firstPassBody(answersOver: Record<string, unknown> = {}) {
  return {
    model: "jev-1.13.0",
    answers: {
      supplied_data_fit: {
        choice: "fits",
        probabilities: { fits: 0.7, does_not_fit: 0.2, insufficient_evidence: 0.1 },
        confidence: 0.81,
      },
      source_adequacy: {
        score: 2.4,
        legend: { "2": SOURCE_ADEQUACY_LEVELS[2] },
        probabilities: { "0": 0.05, "1": 0.15, "2": 0.5, "3": 0.3 },
        confidence: 0.7,
      },
      contradiction_flags: { noul: 0.12 },
      ...answersOver,
    },
    usage: { input_tokens: 1000, output_tokens: 40 },
  };
}

const EVIDENCE_BODY = {
  model: "jev-1.13.0",
  answers: {
    thesis_support: {
      choice: "supported",
      probabilities: { supported: 0.6, mixed: 0.25, contradicted: 0.1, insufficient_evidence: 0.05 },
      confidence: 0.72,
    },
    contradictory_evidence: {
      choice: "immaterial",
      probabilities: { none_found: 0.3, immaterial: 0.5, material: 0.15, insufficient_evidence: 0.05 },
      confidence: 0.66,
    },
  },
  usage: { input_tokens: 2000, output_tokens: 60 },
};

function evidenceBody(support: string, contra: string) {
  const b = structuredClone(EVIDENCE_BODY);
  b.answers.thesis_support.choice = support;
  b.answers.contradictory_evidence.choice = contra;
  return b;
}

function scenarioBody(probabilities: Record<string, number>, confidence = 0.71, model = "jev-1.13.0") {
  return {
    model,
    answers: { scenario_outcome: { choice: "base", probabilities, confidence } },
    usage: { input_tokens: 2100, output_tokens: 20 },
  };
}

const GOOD_PROBS = { bear: 0.2, base: 0.55, bull: 0.25 };

// ── First pass ───────────────────────────────────────────────────────────────

describe("assessCandidateFit", () => {
  it("reads a choice, a score and a noul out of one batched request", async () => {
    const f = vi.fn().mockResolvedValue(res(firstPassBody()));
    const r = await assessCandidateFit(SNAPSHOT, ["durable pricing power"], deps(f));

    expect(f).toHaveBeenCalledTimes(1);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.assessment.fit).toBe("fits");
    expect(r.assessment.sourceAdequacy).toEqual({ score: 2.4, confidence: 0.7, topLevelIndex: 2 });
    expect(r.assessment.contradictionFlag).toBe(0.12);
    expect(r.assessment.unknown).toBe(false);
    expect(r.assessment.proceed).toBe(true);
  });

  it("records the requested model, the RESOLVED model, the version, latency, usage and cost", async () => {
    const f = vi.fn().mockResolvedValue(res(firstPassBody()));
    const r = await assessCandidateFit(SNAPSHOT, [], deps(f));
    if (r.status !== "ok") throw new Error(r.reason);

    expect(r.call.requestedModel).toBe("jev-latest");
    expect(r.call.resolvedModel).toBe("jev-1.13.0");
    expect(r.call.questionSetVersion).toBe(QUESTION_SET_VERSION);
    expect(r.call.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.call.latencyMs).toBe(50);
    expect(r.call.usage).toEqual({ input_tokens: 1000, output_tokens: 40 });
    expect(r.call.costUsd).toBeCloseTo(1000 * 0.000000042, 15);
    expect(r.call.attempts).toBe(1);
    expect(r.call.outcome).toBe("ok");
  });

  it("hashes the exact question set and state, so the same ask hashes the same", async () => {
    const f = vi.fn().mockResolvedValue(res(firstPassBody()));
    const a = await assessCandidateFit(SNAPSHOT, ["x"], deps(f));
    const b = await assessCandidateFit(SNAPSHOT, ["x"], deps(f));
    const c = await assessCandidateFit({ ...SNAPSHOT, ticker: "AMD" }, ["x"], deps(f));
    if (a.status !== "ok" || b.status !== "ok" || c.status !== "ok") throw new Error("expected ok");

    expect(b.call.inputHash).toBe(a.call.inputHash);
    expect(c.call.inputHash).not.toBe(a.call.inputHash);
  });

  it("records a NULL cost for a model with no verified rate — never zero", async () => {
    const f = vi.fn().mockResolvedValue(res({ ...firstPassBody(), model: "jev-2.0.0" }));
    const r = await assessCandidateFit(SNAPSHOT, [], deps(f));
    if (r.status !== "ok") throw new Error(r.reason);
    expect(r.call.costUsd).toBeNull();
    expect(r.call.resolvedModel).toBe("jev-2.0.0");
  });

  it("calls absent evidence UNKNOWN, and never a judgment against the company", async () => {
    const body = firstPassBody({
      supplied_data_fit: {
        choice: "insufficient_evidence",
        probabilities: { fits: 0.1, does_not_fit: 0.1, insufficient_evidence: 0.8 },
        confidence: 0.77,
      },
    });
    const r = await assessCandidateFit(SNAPSHOT, ["durable pricing power"], deps(vi.fn().mockResolvedValue(res(body))));
    if (r.status !== "ok") throw new Error(r.reason);

    expect(r.assessment.fit).toBe("insufficient_evidence");
    expect(r.assessment.fit).not.toBe("does_not_fit");
    expect(r.assessment.unknown).toBe(true);
    expect(r.assessment.proceed).toBe(false);
  });

  it("treats a misfit as a statement about the criteria, not as missing data", async () => {
    const body = firstPassBody({
      supplied_data_fit: {
        choice: "does_not_fit",
        probabilities: { fits: 0.1, does_not_fit: 0.8, insufficient_evidence: 0.1 },
        confidence: 0.8,
      },
    });
    const r = await assessCandidateFit(SNAPSHOT, ["pays a dividend"], deps(vi.fn().mockResolvedValue(res(body))));
    if (r.status !== "ok") throw new Error(r.reason);
    expect(r.assessment.unknown).toBe(false);
    expect(r.assessment.proceed).toBe(false);
  });

  it("stops the run when the sources are unusable, whatever the fit answer said", async () => {
    const body = firstPassBody({
      source_adequacy: {
        score: 0.3,
        legend: {},
        probabilities: { "0": 0.8, "1": 0.1, "2": 0.05, "3": 0.05 },
        confidence: 0.6,
      },
    });
    const r = await assessCandidateFit(SNAPSHOT, [], deps(vi.fn().mockResolvedValue(res(body))));
    if (r.status !== "ok") throw new Error(r.reason);
    expect(r.assessment.sourceAdequacy.topLevelIndex).toBe(0);
    expect(r.assessment.unknown).toBe(true);
    expect(r.assessment.proceed).toBe(false);
  });

  it("recovers the level from the level TEXT as well as from an index key", async () => {
    const body = firstPassBody({
      source_adequacy: {
        score: 3,
        legend: {},
        probabilities: { [SOURCE_ADEQUACY_LEVELS[3]]: 0.9, [SOURCE_ADEQUACY_LEVELS[0]]: 0.1 },
        confidence: 0.8,
      },
    });
    const r = await assessCandidateFit(SNAPSHOT, [], deps(vi.fn().mockResolvedValue(res(body))));
    if (r.status !== "ok") throw new Error(r.reason);
    expect(r.assessment.sourceAdequacy.topLevelIndex).toBe(3);
  });

  it("does not gate on a level it cannot identify — an unknown scale never decides", async () => {
    const body = firstPassBody({
      source_adequacy: {
        score: 1.5,
        legend: {},
        probabilities: { low: 0.4, high: 0.6 },
        confidence: 0.5,
      },
    });
    const r = await assessCandidateFit(SNAPSHOT, [], deps(vi.fn().mockResolvedValue(res(body))));
    if (r.status !== "ok") throw new Error(r.reason);
    expect(r.assessment.sourceAdequacy.topLevelIndex).toBeNull();
    expect(r.assessment.proceed).toBe(true);
  });

  it("is unavailable — not a verdict — when an answer is missing", async () => {
    const body = firstPassBody();
    delete (body.answers as Record<string, unknown>).contradiction_flags;
    const r = await assessCandidateFit(SNAPSHOT, [], deps(vi.fn().mockResolvedValue(res(body))));
    expect(r.status).toBe("unavailable");
    if (r.status !== "unavailable") return;
    expect(r.reason).toContain("contradiction_flags");
    expect(r.call.outcome).toBe("failed");
    // The call still happened, so its cost is still recorded.
    expect(r.call.costUsd).toBeCloseTo(1000 * 0.000000042, 15);
  });

  it("is unavailable when a primitive comes back as the wrong shape", async () => {
    const body = firstPassBody({ supplied_data_fit: { noul: 0.4 } });
    const r = await assessCandidateFit(SNAPSHOT, [], deps(vi.fn().mockResolvedValue(res(body))));
    expect(r.status).toBe("unavailable");
    if (r.status !== "unavailable") return;
    expect(r.reason).toMatch(/not a choice answer/);
  });

  it("is unavailable when the model chooses an option we never sent", async () => {
    const body = firstPassBody({
      supplied_data_fit: { choice: "maybe", probabilities: { maybe: 1 }, confidence: 0.9 },
    });
    const r = await assessCandidateFit(SNAPSHOT, [], deps(vi.fn().mockResolvedValue(res(body))));
    expect(r.status).toBe("unavailable");
    if (r.status !== "unavailable") return;
    expect(r.reason).toContain('"maybe"');
  });

  it("is unavailable, with the failure kind recorded, when the provider fails", async () => {
    const f = vi.fn().mockResolvedValue(res({}, 500));
    const r = await assessCandidateFit(SNAPSHOT, [], deps(f));
    expect(r.status).toBe("unavailable");
    if (r.status !== "unavailable") return;
    expect(r.call.failureKind).toBe("server_error");
    expect(r.call.resolvedModel).toBeNull();
    expect(r.call.usage).toBeNull();
    // No usage means no cost — and an unknown cost is null, not a free call.
    expect(r.call.costUsd).toBeNull();
    expect(r.call.attempts).toBe(2);
  });
});

describe("assessCandidateFits", () => {
  it("never runs more than four candidates at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const f = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return res(firstPassBody());
    });
    const snapshots = Array.from({ length: 12 }, (_, i) => ({ ...SNAPSHOT, ticker: `T${i}` }));

    const results = await assessCandidateFits(snapshots, [], {
      ...deps(f),
      budget: createJevBudget({ maxCalls: 50, maxInputTokens: 1e9, maxUsd: null }),
    });

    expect(results).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(MAX_CANDIDATE_CONCURRENCY);
    expect(peak).toBe(MAX_CANDIDATE_CONCURRENCY);
  });

  it("cannot be asked to exceed the ceiling", async () => {
    let inFlight = 0;
    let peak = 0;
    const f = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return res(firstPassBody());
    });
    const snapshots = Array.from({ length: 10 }, (_, i) => ({ ...SNAPSHOT, ticker: `T${i}` }));
    await assessCandidateFits(snapshots, [], {
      ...deps(f),
      concurrency: 50,
      budget: createJevBudget({ maxCalls: 50, maxInputTokens: 1e9, maxUsd: null }),
    });
    expect(peak).toBeLessThanOrEqual(MAX_CANDIDATE_CONCURRENCY);
  });

  it("keeps results in INPUT order, however they finished", async () => {
    const f = vi.fn(async (_url: unknown, init: { body?: string }) => {
      // Later tickers answer first.
      const ticker = JSON.parse(String(init.body)).state.ticker as string;
      await new Promise((r) => setTimeout(r, ticker === "T0" ? 5 : 0));
      return res(firstPassBody());
    });
    const snapshots = [0, 1, 2].map((i) => ({ ...SNAPSHOT, ticker: `T${i}` }));
    const results = await assessCandidateFits(snapshots, [], deps(f));
    expect(results.map((r) => (r.status === "ok" ? r.assessment.ticker : r.ticker))).toEqual([
      "T0",
      "T1",
      "T2",
    ]);
  });

  it("shares one budget across the batch, so the run's cap bounds the run", async () => {
    const f = vi.fn().mockResolvedValue(res(firstPassBody()));
    const snapshots = Array.from({ length: 5 }, (_, i) => ({ ...SNAPSHOT, ticker: `T${i}` }));
    const results = await assessCandidateFits(snapshots, [], {
      ...deps(f),
      concurrency: 1,
      budget: createJevBudget({ maxCalls: 2, maxInputTokens: 1e9, maxUsd: null }),
    });

    expect(f).toHaveBeenCalledTimes(2);
    expect(results.filter((r) => r.status === "ok")).toHaveLength(2);
    const blocked = results.filter((r) => r.status === "unavailable");
    expect(blocked).toHaveLength(3);
    if (blocked[0].status !== "unavailable") return;
    expect(blocked[0].reason).toContain("request cap");
  });
});

// ── Second pass ──────────────────────────────────────────────────────────────

const SCENARIO_DEPS = { targetDate: "2027-09-19" };

async function runScenarios(
  fetchImpl: unknown,
  over: Partial<AssessDeps> = {},
  returns = ORDERED_RETURNS
) {
  return assessScenarios(SNAPSHOT, RESEARCH, returns, {
    ...deps(fetchImpl, over),
    ...SCENARIO_DEPS,
  });
}

describe("assessScenarios", () => {
  it("maps the distribution by name and labels it model_unvalidated", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(EVIDENCE_BODY))
      .mockResolvedValueOnce(res(scenarioBody(GOOD_PROBS)));

    const r = await runScenarios(f);

    expect(f).toHaveBeenCalledTimes(2);
    expect(r.weights).not.toBeNull();
    expect(r.weights?.values).toEqual({ bear: 0.2, base: 0.55, bull: 0.25 });
    expect(r.weights?.basis).toBe("model_unvalidated");
    expect(r.weights?.model).toBe("jev-1.13.0");
    expect(r.weights?.calibrationVersion).toBeNull();
    expect(ScenarioWeightsSchema.safeParse(r.weights).success).toBe(true);
    // Buckets are the midpoints, and they travel with the forecast.
    expect(r.buckets?.boundaries).toEqual([0, 0.5]);
    expect(r.confidence).toBe(0.71);
    expect(r.thesisSupport).toBe("supported");
    expect(r.contradictoryEvidence).toBe("immaterial");
    expect(r.calls).toHaveLength(2);
    expect(r.calls.map((c) => c.purpose)).toEqual(["research_evidence", "scenario_distribution"]);
  });

  it("never claims empirical calibration", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(EVIDENCE_BODY))
      .mockResolvedValueOnce(res(scenarioBody(GOOD_PROBS)));
    const r = await runScenarios(f);
    expect(r.weights?.basis).not.toBe("empirically_calibrated");
  });

  it("returns the weights even when confidence is below the policy gate", async () => {
    // decision.ts owns minScenarioConfidence: dropping the weights here would
    // report "no distribution" when the truth is "a distribution, too diffuse".
    const low = 0.2;
    expect(low).toBeLessThan(POLICY_V1.minScenarioConfidence);
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(EVIDENCE_BODY))
      .mockResolvedValueOnce(res(scenarioBody(GOOD_PROBS, low)));
    const r = await runScenarios(f);
    expect(r.weights).not.toBeNull();
    expect(r.confidence).toBe(low);
  });

  it("refuses unordered scenario returns WITHOUT spending a request", async () => {
    const f = vi.fn();
    const r = await runScenarios(f, {}, { bear: 0.1, base: 0.1, bull: 0.3 });
    expect(f).not.toHaveBeenCalled();
    expect(r.weights).toBeNull();
    expect(r.buckets).toBeNull();
    expect(r.reason).toMatch(/strictly ordered/);
  });

  it("refuses an inverted valuation too", async () => {
    const r = await runScenarios(vi.fn(), {}, { bear: 0.5, base: 0.2, bull: 0.1 });
    expect(r.weights).toBeNull();
  });

  it("rejects a RENAMED option rather than patching the missing mass", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(EVIDENCE_BODY))
      .mockResolvedValueOnce(res(scenarioBody({ downside: 0.2, base: 0.55, bull: 0.25 })));
    const r = await runScenarios(f);
    expect(r.weights).toBeNull();
    expect(r.reason).toContain("bear");
    // The evidence read survives, so the report can still say what was found.
    expect(r.thesisSupport).toBe("supported");
  });

  it("rejects an option set with an extra option, even when it sums to 1", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(EVIDENCE_BODY))
      .mockResolvedValueOnce(res(scenarioBody({ bear: 0.2, base: 0.5, bull: 0.2, unknown: 0.1 })));
    const r = await runScenarios(f);
    expect(r.weights).toBeNull();
    expect(r.reason).toContain("unknown");
  });

  it("rejects a partial option set", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(EVIDENCE_BODY))
      .mockResolvedValueOnce(res(scenarioBody({ bear: 0.45, base: 0.55 })));
    const r = await runScenarios(f);
    expect(r.weights).toBeNull();
    expect(r.reason).toContain("bull");
  });

  it("rejects a sum that drifts past OUR tolerance, even inside the vendor's", async () => {
    // 1e-5 of drift: the transport's 1e-4 lets it through, ProbabilityTripleSchema
    // does not, and renormalising a distribution we did not compute is not our job.
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(EVIDENCE_BODY))
      .mockResolvedValueOnce(res(scenarioBody({ bear: 0.2, base: 0.55, bull: 0.25001 })));
    const r = await runScenarios(f);
    expect(r.weights).toBeNull();
    expect(r.reason).toMatch(/not a valid distribution/);
  });

  it("rejects a NaN probability at the transport boundary", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(EVIDENCE_BODY))
      .mockResolvedValueOnce(res(scenarioBody({ bear: Number.NaN, base: 0.55, bull: 0.25 })));
    const r = await runScenarios(f);
    expect(r.weights).toBeNull();
    expect(r.calls[1].failureKind).toBe("malformed_response");
  });

  it("rejects a scenario answer that is not a choice", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(EVIDENCE_BODY))
      .mockResolvedValueOnce(
        res({
          model: "jev-1.13.0",
          answers: { scenario_outcome: { noul: 0.6 } },
          usage: { input_tokens: 10, output_tokens: 1 },
        })
      );
    const r = await runScenarios(f);
    expect(r.weights).toBeNull();
    expect(r.reason).toMatch(/not a choice answer/);
  });

  it("does not ask for a distribution when the research never addressed the thesis", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(evidenceBody("insufficient_evidence", "immaterial")));
    const r = await runScenarios(f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(r.weights).toBeNull();
    expect(r.thesisSupport).toBe("insufficient_evidence");
    expect(r.reason).toMatch(/does not address the thesis/);
  });

  it("does not ask for a distribution over a thesis with material evidence against it", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(evidenceBody("mixed", "material")));
    const r = await runScenarios(f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(r.weights).toBeNull();
    expect(r.contradictoryEvidence).toBe("material");
    expect(r.reason).toMatch(/material unresolved evidence/);
  });

  it("rejects an evidence answer that chose an option we never sent", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(evidenceBody("looks_fine", "immaterial")));
    const r = await runScenarios(f);
    expect(f).toHaveBeenCalledTimes(1);
    expect(r.weights).toBeNull();
    expect(r.reason).toContain('"looks_fine"');
  });

  it("returns null weights on a provider failure, and the caller falls back to the fixed prior", async () => {
    const f = vi.fn().mockResolvedValue(res({}, 503));
    const r = await runScenarios(f);

    expect(r.weights).toBeNull();
    expect(r.calls[0].failureKind).toBe("server_error");

    // What the caller then does. The fallback is LABELLED, so the report can say it
    // is an assumption — which is the whole reason this module returns null instead
    // of an equal-probability triple of its own.
    const fallback: ScenarioWeights = {
      values: { ...POLICY_V1.defaultScenarioWeights },
      basis: "fixed_prior",
      model: null,
      calibrationVersion: null,
    };
    expect(ScenarioWeightsSchema.safeParse(fallback).success).toBe(true);

    const scenarios: ScenarioValue[] = (
      [
        ["bear", 80],
        ["base", 110],
        ["bull", 170],
      ] as const
    ).map(([id, priceAtHorizon]) => ({
      id,
      priceAtHorizon,
      distributionsPerShare: 0,
      assumptionsRef: `${id}-assumptions`,
      method: "fcff_dcf" as const,
      evidenceIds: ["ev-1"],
    }));

    const returns = computeReturns(100, scenarios, fallback, 1);
    expect(returns.status).toBe("ok");
    if (returns.status !== "ok") return;
    expect(returns.estimate.cumulative).toBeCloseTo(0.175, 12);
  });

  it("returns null weights when the run has already hit its request cap", async () => {
    const f = vi.fn();
    const budget = createJevBudget({ maxCalls: 0, maxInputTokens: 1e9, maxUsd: null });
    const r = await runScenarios(f, { budget });
    expect(f).not.toHaveBeenCalled();
    expect(r.weights).toBeNull();
    expect(r.reason).toContain("request cap");
  });

  it("prices both calls against the resolved model and records each separately", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(EVIDENCE_BODY))
      .mockResolvedValueOnce(res(scenarioBody(GOOD_PROBS)));
    const budget = createJevBudget();
    const r = await runScenarios(f, { budget });

    expect(r.calls[0].costUsd).toBeCloseTo(2000 * 0.000000042, 15);
    expect(r.calls[1].costUsd).toBeCloseTo(2100 * 0.000000042, 15);
    const ledger = budget.ledger();
    expect(ledger.calls).toBe(2);
    expect(ledger.inputTokens).toBe(4100);
    expect(ledger.usd).toBeCloseTo(4100 * 0.000000042, 15);
    expect(ledger.unpricedModels).toEqual([]);
  });

  it("leaves the ledger's total UNKNOWN when the resolved model is unpriced", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res({ ...EVIDENCE_BODY, model: "jev-9.0.0" }))
      .mockResolvedValueOnce(res(scenarioBody(GOOD_PROBS, 0.7, "jev-9.0.0")));
    const budget = createJevBudget();
    const r = await runScenarios(f, { budget });

    expect(r.weights).not.toBeNull();
    expect(r.calls.every((c) => c.costUsd === null)).toBe(true);
    expect(budget.ledger().usd).toBeNull();
    expect(budget.ledger().inputTokens).toBe(4100);
  });

  it("sends the gaps and the as-of cutoff, so absence is visible as absence", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(res(EVIDENCE_BODY))
      .mockResolvedValueOnce(res(scenarioBody(GOOD_PROBS)));
    await runScenarios(f);

    const sent = JSON.parse(String(f.mock.calls[0][1].body));
    expect(sent.state.gaps).toEqual([
      { source: "sec", field: "freeCashFlow", reason: "rate_limited" },
    ]);
    expect(sent.state.as_of).toBe(SNAPSHOT.asOf);
    expect(sent.state.thesis).toBe(RESEARCH.thesis);
    expect(sent.state.claims[0].kind).toBe("observed");
    // The valuation's own three points are deliberately NOT handed over: the
    // question carries the bucket definitions, and handing over the labelled base
    // case invites anchoring on it.
    expect(sent.state.scenario_returns).toBeUndefined();
    expect(JSON.stringify(sent.state)).not.toContain("0.75");
  });
});
