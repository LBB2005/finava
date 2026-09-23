// Wiring the five run stages to their real implementations. Server-only.
//
// The runner deliberately knows nothing about valuation, Jev or the agents: it
// owns leases, budgets, persistence and replay, and takes the stages as injected
// functions. This module is where those functions are supplied, so the runner
// stays testable against fakes and the stages stay testable in isolation.
//
// Two properties this file is responsible for, because they are only visible
// where the stages meet:
//
//  1. THE PRICE TRAVELS WITH THE VALUATION. Scenario returns, the rating and the
//     eventual outcome resolution must all measure from the SAME price the
//     scenarios were computed against. `EvidenceItem` records a source and a
//     standing but not a value, so re-reading the price in a later stage would
//     quietly substitute a newer one and change every return in the report.
//     `ValuationOutcome.priceAtAsOf` carries it forward instead.
//
//  2. A MISSING DISTRIBUTION FALLS BACK TO A LABELLED PRIOR, NEVER A GUESS. When
//     Jev is unconfigured or fails, the scenario stage returns
//     POLICY_V1.defaultScenarioWeights with `basis: "fixed_prior"` and records
//     why. The report then says "fixed assumption, not a forecast" — which is
//     true — instead of presenting an invented distribution as an estimate.
//
// Every stage reports MEASURED credits. A stage that cannot measure its spend
// reports 0 and says so in `gaps`; it never reports a plausible estimate, because
// an estimated cost is indistinguishable from a real one once it reaches
// `costUsd`.

import { AGENT_VERSION } from "@/lib/live/version";
import { POLICY_VERSION, POLICY_V1 } from "./policyConfig";
import { decideInvestment, type DecisionInput } from "./decision";
import { computeReturns } from "./returns";
import { buildScenarioBuckets } from "./scenarioBuckets";
import { computeValuation, VALUATION_VERSION, type ValuationRequest } from "./valuation";
import { buildResearchSnapshot, type SnapshotDeps } from "./snapshot";
import { collectResearchClaims, type AgentOutput } from "./claims";
import { assessScenarios, type AssessDeps, type ResearchInput } from "./jev/assess";
import { QUESTION_SET_VERSION } from "./jev/questions";
import { resolveJevTransport } from "./jev/client";
import type {
  DecisionStage,
  ReportVersions,
  ResearchStage,
  RunnerStages,
  ScenarioStage,
  SnapshotStage,
  StageEnvelope,
  ValuationStage,
} from "./runner";
import type { ResearchSnapshot, ValuationOutcome } from "./contracts";
import type { ScenarioWeights } from "./schemas";

// ── The collectors this module needs supplied ───────────────────────────────
//
// Evidence collection and claim extraction are the two places that talk to
// providers and models. They are injected rather than imported so this module can
// be exercised end-to-end without a network, and so a route can choose a cheaper
// collector without the runner knowing.

export interface StageCollectors {
  /** Gathers dated evidence for a ticker at the run's as-of. */
  collect: SnapshotDeps["collect"];
  /** Firestore handle for chunked source text, or null to skip persisting it. */
  db: SnapshotDeps["db"];
  transcripts?: SnapshotDeps["transcripts"];
  callPeriods?: readonly string[];
  /**
   * Runs the specialists against the frozen snapshot and returns their RAW
   * output. Parsing, validation and repair are `claims.ts`'s job, not the
   * caller's — a collector that pre-parsed could smuggle in a claim that cites
   * evidence the snapshot does not contain.
   */
  research: (snapshot: ResearchSnapshot, signal: AbortSignal) => Promise<{
    outputs: AgentOutput[];
    /** Measured spend. 0 with a gap when the provider would not report it. */
    credits: number;
    gaps?: readonly string[];
  }>;
  /**
   * Assembles the valuation request from the frozen snapshot. Returns null when
   * the company cannot be valued from what the snapshot holds — which is a named
   * gap, not an error.
   */
  valuationRequest: (
    snapshot: ResearchSnapshot
  ) => Promise<{ request: ValuationRequest; priceAtAsOf: number | null } | null>;
  /** Jev dependencies. Omitted or unconfigured ⇒ the fixed prior. */
  assess?: AssessDeps;
}

// ── Stage 1 · snapshot ───────────────────────────────────────────────────────

export function makeSnapshotStage(c: StageCollectors): SnapshotStage {
  return async (ctx) => {
    const ticker = ctx.mandate.ticker;
    if (!ticker) {
      // Analyze requires a resolved ticker. Discover resolves one per candidate
      // before creating a run, so reaching here means the mandate is malformed.
      throw new Error("snapshot stage requires a ticker on the mandate");
    }

    const snapshot = await buildResearchSnapshot(ctx.mandate, ticker, {
      ownerUid: ctx.uid,
      collect: c.collect,
      db: c.db,
      transcripts: c.transcripts,
      callPeriods: c.callPeriods,
    });

    // The runner mints id/ownerUid/createdAt; a stage that could set ownerUid
    // could write a snapshot attributed to someone else, so they are stripped
    // here rather than passed through.
    const draft = {
      ticker: snapshot.ticker,
      asOf: snapshot.asOf,
      mandate: snapshot.mandate,
      evidence: snapshot.evidence,
      gaps: snapshot.gaps,
      coverage: snapshot.coverage,
      contentHash: snapshot.contentHash,
    };

    return {
      result: draft,
      // Evidence collection spend is measured by the collector and charged there;
      // this stage adds none of its own.
      credits: 0,
      gaps: snapshot.gaps.map((g) => `${g.field} from ${g.source}: ${g.detail}`),
    };
  };
}

// ── Stage 2 · research ───────────────────────────────────────────────────────

export function makeResearchStage(c: StageCollectors): ResearchStage {
  return async (ctx, snapshot) => {
    const raw = await c.research(snapshot, ctx.signal);
    const set = await collectResearchClaims({ snapshot, outputs: raw.outputs });

    const gaps = [...(raw.gaps ?? [])];
    for (const a of set.unavailableAgents) {
      gaps.push(`${a.agent} produced no usable findings: ${a.errors.join("; ")}`);
    }
    // A rejected claim is not noise — it is a claim that cited evidence the
    // snapshot does not support, which is exactly what the reader should know.
    for (const r of set.rejected) {
      gaps.push(`a ${r.agent} finding was rejected: ${r.reason}`);
    }

    return {
      result: { claims: set.claims, dissent: set.dissent },
      credits: raw.credits,
      gaps,
    };
  };
}

// ── Stage 3 · valuation ──────────────────────────────────────────────────────

export function makeValuationStage(c: StageCollectors): ValuationStage {
  return async (_ctx, snapshot) => {
    const assembled = await c.valuationRequest(snapshot);

    if (!assembled) {
      const outcome: ValuationOutcome = {
        method: "forward_multiple",
        gaps: [
          {
            field: "inputs",
            detail:
              "the snapshot does not contain the inputs any supported valuation method needs",
          },
        ],
        scenarios: null,
        proxies: [],
        criticalCoverage: 0,
        valuationVersion: VALUATION_VERSION,
        priceAtAsOf: null,
      };
      return { result: outcome, credits: 0, gaps: ["no valuation could be attempted"] };
    }

    const outcome = computeValuation(assembled.request);

    return {
      // Attach the price the valuation measured from, so later stages and the
      // outcome resolver use it rather than a fresher one.
      result: { ...outcome, priceAtAsOf: assembled.priceAtAsOf },
      // Valuation is arithmetic on already-collected inputs: no provider spend.
      credits: 0,
      gaps: outcome.gaps.map((g) => `valuation missing ${g.field}: ${g.detail}`),
    };
  };
}

// ── Stage 4 · scenarios ──────────────────────────────────────────────────────

/** The labelled prior, used whenever a real distribution is unavailable. */
function fixedPriorWeights(): ScenarioWeights {
  return {
    values: { ...POLICY_V1.defaultScenarioWeights },
    basis: "fixed_prior",
    model: null,
    calibrationVersion: null,
  };
}

export function makeScenarioStage(c: StageCollectors): ScenarioStage {
  return async (ctx, snapshot, valuation) => {
    const price = valuation.priceAtAsOf ?? null;
    const scenarios = valuation.scenarios;

    // With no scenarios there is nothing to weight. Returning the prior anyway
    // would attach probabilities to outcomes that were never priced.
    if (!scenarios || scenarios.length === 0 || price == null || price <= 0) {
      return {
        result: {
          scenarios: null,
          weights: null,
          buckets: null,
          probabilityBasis: "fixed_prior",
          questionSetVersion: null,
        },
        credits: 0,
        gaps: ["no scenario valuation to weight"],
      };
    }

    // Per-scenario returns need no probabilities, so they are computed here and
    // define the buckets a distribution is asked against.
    const byId = new Map(scenarios.map((s) => [s.id, s]));
    const ret = (id: "bear" | "base" | "bull"): number | null => {
      const s = byId.get(id);
      if (!s) return null;
      return (s.priceAtHorizon + s.distributionsPerShare - price) / price;
    };
    const triple = { bear: ret("bear"), base: ret("base"), bull: ret("bull") };

    if (triple.bear == null || triple.base == null || triple.bull == null) {
      return {
        result: {
          scenarios,
          weights: null,
          buckets: null,
          probabilityBasis: "fixed_prior",
          questionSetVersion: null,
        },
        credits: 0,
        gaps: ["an incomplete scenario set cannot be weighted"],
      };
    }

    const scenarioReturns = {
      bear: triple.bear,
      base: triple.base,
      bull: triple.bull,
    };
    const bucketResult = buildScenarioBuckets(scenarioReturns);

    // Unordered scenarios mean the valuation disagrees with its own labels. No
    // distribution is asked for, and the prior is not applied to a set we cannot
    // partition.
    if (bucketResult.status !== "ok") {
      return {
        result: {
          scenarios,
          weights: null,
          buckets: null,
          probabilityBasis: "fixed_prior",
          questionSetVersion: null,
        },
        credits: 0,
        gaps: [bucketResult.reason],
      };
    }

    const prior = (reason: string | null, credits = 0): StageEnvelope<{
      scenarios: typeof scenarios;
      weights: ScenarioWeights;
      buckets: { boundaries: [number, number] };
      probabilityBasis: "fixed_prior";
      questionSetVersion: null;
    }> => ({
      result: {
        scenarios,
        weights: fixedPriorWeights(),
        buckets: bucketResult.buckets,
        probabilityBasis: "fixed_prior",
        questionSetVersion: null,
      },
      credits,
      gaps: reason
        ? [`scenario probabilities are a fixed assumption, not a forecast: ${reason}`]
        : ["scenario probabilities are a fixed assumption, not a forecast"],
    });

    // No credential ⇒ no call, and the prior is the honest answer.
    if (!c.assess || resolveJevTransport(c.assess.jev?.env ?? process.env) == null) {
      return prior("no scenario-probability provider is configured");
    }

    const research: ResearchInput = {
      thesis: ctx.mandate.query,
      claims: [],
    };

    const assessment = await assessScenarios(snapshot, research, scenarioReturns, {
      ...c.assess,
      signal: ctx.signal,
      targetDate: ctx.mandate.horizon.targetDate,
    });

    const credits = assessment.calls.reduce((sum, call) => {
      // An unpriced call contributes nothing rather than a guess; the gap below
      // records that the cost is unknown.
      const cost = (call as { costUsd?: number | null }).costUsd;
      return sum + (typeof cost === "number" && Number.isFinite(cost) ? cost : 0);
    }, 0);

    if (!assessment.weights) return prior(assessment.reason, credits);

    return {
      result: {
        scenarios,
        weights: assessment.weights,
        buckets: assessment.buckets ?? bucketResult.buckets,
        probabilityBasis: assessment.weights.basis,
        questionSetVersion: c.assess.questionSetVersion ?? QUESTION_SET_VERSION,
      },
      credits,
      gaps: assessment.calls.some(
        (call) => (call as { costUsd?: number | null }).costUsd == null
      )
        ? ["the cost of at least one scenario call is unknown"]
        : [],
    };
  };
}

// ── Stage 5 · decision ───────────────────────────────────────────────────────

/**
 * The rating. Pure, deterministic, and no model call — the narrative written
 * afterwards explains this result and cannot move it.
 */
export const runDecisionStage: DecisionStage = async (ctx, input) => {
  const { valuation, scenarios, snapshot } = input;
  const price = valuation.priceAtAsOf ?? null;
  const yearFraction = ctx.mandate.horizon.yearFraction;

  const returnsResult = computeReturns(
    price,
    scenarios.scenarios ?? [],
    scenarios.weights,
    yearFraction
  );
  const returns = returnsResult.status === "ok" ? returnsResult.estimate : null;

  // An outage gap is a statement about our data, never evidence against the
  // company, so it does not become an exclusion violation here.
  const decisionInput: DecisionInput = {
    criticalCoverage: valuation.criticalCoverage,
    hasFreshPrice: price != null && price > 0,
    returns,
    weights: scenarios.weights,
    scenarioConfidence: null,
    yearFraction,
    exclusionViolations: [],
    unresolvedContradictions: input.research.dissent,
  };

  const decision = decideInvestment(decisionInput);

  const gaps: string[] = [];
  if (returnsResult.status !== "ok") gaps.push(`no expected return: ${returnsResult.reason}`);
  if (snapshot.gaps.length > 0) {
    gaps.push(`${snapshot.gaps.length} source gap(s) were recorded for this snapshot`);
  }

  return {
    result: {
      rating: decision.rating,
      status: decision.status,
      reasonCodes: decision.reasonCodes,
      hurdle: decision.hurdle,
      experimental: decision.experimental,
      returns,
    },
    credits: 0,
    gaps,
  };
};

// ── Assembly ─────────────────────────────────────────────────────────────────

export function reportVersions(): ReportVersions {
  return {
    policyVersion: POLICY_VERSION,
    valuationVersion: VALUATION_VERSION,
    questionSetVersion: QUESTION_SET_VERSION,
    agentVersion: AGENT_VERSION,
  };
}

/** Build the full stage set from a collector bundle. */
export function buildStages(c: StageCollectors): RunnerStages {
  return {
    snapshot: makeSnapshotStage(c),
    research: makeResearchStage(c),
    valuation: makeValuationStage(c),
    scenarios: makeScenarioStage(c),
    decision: runDecisionStage,
    versions: reportVersions,
  };
}
