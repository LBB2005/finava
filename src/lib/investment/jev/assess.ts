// The two assessment passes, and the validation between Jev and the arithmetic.
//
// Everything here exists to keep one property true: A MODEL ANSWER BECOMES A
// PROBABILITY ONLY WHEN IT WAS A PROBABILITY OVER EXACTLY THESE BUCKETS. Nothing
// is converted into one. A rubric level is not a probability. A confidence number
// is not a probability. A noul about whether the evidence contradicts itself is not
// a probability. An agreement percentage across agents is not a probability. Each
// of those is a number between zero and one that would render identically to a real
// forecast, carry a rating, and be indistinguishable from knowledge — so the only
// path to `ScenarioWeights` in this file is one `choice` answer whose option names
// match the three scenario ids exactly and whose values sum to one.
//
// The second property is the failure mode, inherited from `client.ts`: when Jev is
// unavailable, refuses, or answers something we cannot map, the weights are NULL.
// The caller then uses POLICY_V1.defaultScenarioWeights labelled `fixed_prior`, the
// UI says it is a fixed assumption, and the reader can tell. Substituting an
// equal-probability triple here instead would produce the same arithmetic wearing
// the label `model_unvalidated`, which is a claim that a model was consulted.
//
// The third is arithmetic hygiene: correlated probabilities are never multiplied.
// Thesis support, contradictory evidence and the scenario distribution are three
// readings of one evidence bundle, so they are correlated by construction;
// combining them multiplicatively would manufacture a confident tail out of three
// mild opinions. They are used as GATES — each can stop the next step — and never
// as factors.
//
// Server-only, because `client.ts` is.

import { createHash } from "node:crypto";
import {
  buildScenarioBuckets,
  type ScenarioBuckets,
  type ScenarioReturnTriple,
} from "../scenarioBuckets";
import {
  ProbabilityTripleSchema,
  type ProbabilityTriple,
  type ResearchClaim,
  type ScenarioWeights,
} from "../schemas";
import type { ResearchSnapshot } from "../contracts";
import { callJev, requireAnswers, type JevDeps, type JevFailureKind } from "./client";
import {
  DEFAULT_JEV_MODEL,
  isChoiceAnswer,
  isNoulAnswer,
  isScoreAnswer,
  type JevChoiceAnswer,
  type JevQuestion,
  type JevResponse,
} from "./schemas";
import {
  buildFirstPassQuestions,
  buildScenarioQuestion,
  buildSecondPassQuestions,
  CONTRADICTORY_EVIDENCE_OPTIONS,
  INSUFFICIENT_EVIDENCE,
  NO_USABLE_SOURCES_LEVEL,
  QUESTION_SET_VERSION,
  SCENARIO_OPTIONS,
  SCENARIO_QUESTION_ID,
  SOURCE_ADEQUACY_LEVELS,
  SUPPLIED_DATA_FIT_OPTIONS,
  THESIS_SUPPORT_OPTIONS,
  type ContradictoryEvidence,
  type SuppliedDataFit,
  type ThesisSupport,
} from "./questions";
import {
  createJevBudget,
  jevCallCostUsd,
  JEV_PRICE_TABLE,
  type JevBudget,
  type JevPriceTable,
  type JevUsage,
} from "./cost";

/**
 * Candidates are assessed concurrently, and never more than four at once.
 *
 * Jev's rate limits are not documented anywhere we have verified, and a discover
 * run screens a universe rather than a name — fanning out over it unthrottled
 * would earn 429s, and `client.ts` spends its single retry on each of them, so the
 * run would pay twice per candidate to go slower. Four is a deliberately
 * conservative guess, and it is a CEILING: a caller may ask for fewer and cannot
 * ask for more.
 */
export const MAX_CANDIDATE_CONCURRENCY = 4;

/** Evidence excerpts are trimmed, not dropped — see `buildCandidateState`. */
const MAX_EXCERPT_CHARS = 600;
const MAX_EVIDENCE_ITEMS = 60;
const MAX_CLAIMS = 80;

// ── Telemetry ────────────────────────────────────────────────────────────────

/**
 * What one Jev call did, recorded whether it succeeded or not.
 *
 * `requestedModel` and `resolvedModel` are both kept because they differ: we ask
 * for `jev-latest` and the vendor answers as a dated build. Only the resolved one
 * identifies what actually produced the answer, and only the requested one explains
 * what we asked for — a report that recorded a single "model" would be unable to
 * say whether an answer changed because we changed something or because the vendor
 * did. `inputHash` covers the exact questions and state that were sent, so two
 * reports can be compared without trusting either's prose.
 */
export interface JevCallRecord {
  purpose: "candidate_fit" | "research_evidence" | "scenario_distribution";
  requestedModel: string;
  /** Null when the call never produced a validated response. */
  resolvedModel: string | null;
  questionSetVersion: string;
  /** sha256 over the question set and the state, canonically serialised. */
  inputHash: string;
  /** Measured from the injected clock, so a failed call has a latency too. */
  latencyMs: number;
  usage: JevUsage | null;
  /** Null when the model has no verified rate. NEVER zero for an unknown rate. */
  costUsd: number | null;
  attempts: number;
  outcome: "ok" | "failed";
  failureKind: JevFailureKind | null;
  reason: string | null;
}

export interface AssessDeps {
  /** Forwarded to `callJev`. Tests pass a mocked `fetch` and an empty env here. */
  jev?: JevDeps;
  /** The model to request. The vendor resolves aliases; we record both. */
  model?: string;
  now?: () => number;
  signal?: AbortSignal;
  deadlineMs?: number;
  /** Shared across a batch so one screen cannot exceed the run's caps. */
  budget?: JevBudget;
  priceTable?: JevPriceTable;
  /** Clamped to [1, MAX_CANDIDATE_CONCURRENCY]. */
  concurrency?: number;
  /** Overridden only by a migration that must reproduce an older report. */
  questionSetVersion?: string;
}

// ── Canonical hashing ────────────────────────────────────────────────────────

/**
 * JSON with object keys sorted, so the hash covers the content and not the order a
 * literal happened to be written in. Two runs that ask the same thing must produce
 * the same hash, or the hash cannot be used as cache identity.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

function inputHash(
  questionSetVersion: string,
  model: string,
  questions: Record<string, JevQuestion>,
  state: unknown
): string {
  return createHash("sha256")
    .update(canonical({ questionSetVersion, model, questions, state }))
    .digest("hex");
}

// ── State construction ───────────────────────────────────────────────────────

/**
 * The evidence bundle as Jev sees it.
 *
 * Three things are deliberate. Gaps are included, because a model that cannot see
 * what is missing has no way to distinguish "nothing to report" from "nothing was
 * retrievable", and the whole unknown-versus-bad distinction depends on it.
 * Excerpts are truncated rather than items dropped, so a contradicting source is
 * still visible even when it is long. And when the item cap does bite,
 * `evidence_omitted` states the count in the state itself: the model is told its
 * view is partial rather than being handed a silently pruned bundle it would read
 * as complete.
 */
function buildCandidateState(
  snapshot: ResearchSnapshot,
  criteria: readonly string[]
): Record<string, unknown> {
  const kept = snapshot.evidence.slice(0, MAX_EVIDENCE_ITEMS);
  return {
    ticker: snapshot.ticker,
    as_of: snapshot.asOf,
    qualitative_criteria: [...criteria],
    coverage: snapshot.coverage,
    evidence: kept.map((e) => ({
      id: e.id,
      kind: e.kind,
      source: e.source,
      published_at: e.publishedAt,
      period: e.period,
      standing: e.standing,
      excerpt: e.excerpt.slice(0, MAX_EXCERPT_CHARS),
      excerpt_truncated: e.excerpt.length > MAX_EXCERPT_CHARS,
    })),
    evidence_omitted: Math.max(0, snapshot.evidence.length - kept.length),
    gaps: snapshot.gaps.map((g) => ({
      source: g.source,
      field: g.field,
      reason: g.reason,
      detail: g.detail,
    })),
  };
}

/** The research a thesis was tested with. Kept local so no stage imports another. */
export interface ResearchInput {
  /** The thesis the research was commissioned to test, in one sentence. */
  thesis: string;
  claims: readonly ResearchClaim[];
}

function buildResearchState(
  snapshot: ResearchSnapshot,
  research: ResearchInput
): Record<string, unknown> {
  const claims = research.claims.slice(0, MAX_CLAIMS);
  return {
    ticker: snapshot.ticker,
    as_of: snapshot.asOf,
    thesis: research.thesis,
    // `kind` travels with every claim: an inference must not read with the
    // authority of an observation, and the question's wording relies on the
    // distinction being present in the data.
    claims: claims.map((c) => ({
      id: c.id,
      agent: c.agent,
      text: c.text,
      kind: c.kind,
      direction: c.direction,
      evidence_ids: c.evidenceIds,
    })),
    claims_omitted: Math.max(0, research.claims.length - claims.length),
    evidence: snapshot.evidence.slice(0, MAX_EVIDENCE_ITEMS).map((e) => ({
      id: e.id,
      source: e.source,
      published_at: e.publishedAt,
      standing: e.standing,
      excerpt: e.excerpt.slice(0, MAX_EXCERPT_CHARS),
    })),
    gaps: snapshot.gaps.map((g) => ({ source: g.source, field: g.field, reason: g.reason })),
  };
}

// ── One call, measured and bounded ───────────────────────────────────────────

type CallOutcome =
  | { ok: true; record: JevCallRecord; answers: JevResponse["answers"] }
  | { ok: false; record: JevCallRecord; reason: string };

/**
 * Send one question set, validate that the answers are the ones we asked for, and
 * record what it cost.
 *
 * The budget slot is reserved before the request rather than counted after it, and
 * a refusal is returned as a failed call — a run that has hit its ceiling is
 * indistinguishable, from here, from a provider that will not answer, and both must
 * leave the weights null rather than a default.
 */
async function runJevCall(
  purpose: JevCallRecord["purpose"],
  questions: Record<string, JevQuestion>,
  state: Record<string, unknown>,
  deps: AssessDeps,
  budget: JevBudget
): Promise<CallOutcome> {
  const now = deps.now ?? (() => Date.now());
  const requestedModel = deps.model ?? DEFAULT_JEV_MODEL;
  const version = deps.questionSetVersion ?? QUESTION_SET_VERSION;
  const table = deps.priceTable ?? JEV_PRICE_TABLE;
  const hash = inputHash(version, requestedModel, questions, state);
  const started = now();

  const base = {
    purpose,
    requestedModel,
    resolvedModel: null,
    questionSetVersion: version,
    inputHash: hash,
    usage: null,
    costUsd: null,
    attempts: 0,
  } as const;

  const reserved = budget.reserve();
  if (!reserved.ok) {
    return {
      ok: false,
      reason: reserved.reason,
      record: {
        ...base,
        latencyMs: 0,
        outcome: "failed",
        failureKind: "not_configured",
        reason: reserved.reason,
      },
    };
  }

  const result = await callJev(
    {
      state,
      questions,
      model: requestedModel,
      signal: deps.signal,
      deadlineMs: deps.deadlineMs,
    },
    deps.jev
  );

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      record: {
        ...base,
        latencyMs: now() - started,
        attempts: result.attempts,
        outcome: "failed",
        failureKind: result.kind,
        reason: result.reason,
      },
    };
  }

  budget.record(result.model, result.usage);
  const record: JevCallRecord = {
    ...base,
    resolvedModel: result.model,
    usage: result.usage,
    // Priced against the RESOLVED model: that is what ran, and pricing the alias we
    // asked for would keep reporting yesterday's rate after a version rolled.
    costUsd: jevCallCostUsd(result.model, result.usage, table),
    latencyMs: now() - started,
    attempts: result.attempts,
    outcome: "ok",
    failureKind: null,
    reason: null,
  };

  // An answer set that is not exactly the question set means the request and the
  // response are not about the same thing, so nothing in it can be read
  // positionally — including the parts that look fine.
  const expected = Object.keys(questions);
  const shape = requireAnswers(result.answers, expected);
  if (!shape.ok) {
    return { ok: false, reason: shape.reason, record: { ...record, outcome: "failed", reason: shape.reason } };
  }

  return { ok: true, record, answers: result.answers };
}

// ── First pass ───────────────────────────────────────────────────────────────

export interface SourceAdequacy {
  /** The vendor's probability-weighted value. Its scale is NOT specified — see below. */
  score: number;
  confidence: number;
  /**
   * The most likely level's index, or null when the answer's probability keys do
   * not identify a level we sent.
   *
   * The vendor documentation we verified does not state what scale `score` is on,
   * so thresholding it would be an assumption wearing the clothes of a rule. The
   * index is instead recovered from the probability keys, which either name one of
   * our level strings or are its position — both unambiguous. Anything else leaves
   * this null, and a null never gates.
   */
  topLevelIndex: number | null;
}

export interface CandidateFitAssessment {
  ticker: string;
  fit: SuppliedDataFit;
  sourceAdequacy: SourceAdequacy;
  /**
   * The raw noul: how far the supplied statements contradict each other.
   *
   * A noul carries no confidence and has no way to say "unknown", so it is a
   * REVIEW FLAG and never a gate. An empty evidence bundle contains no
   * contradictions and would score near zero — reading that as a clean bill of
   * health is precisely the absence-as-evidence error, so the unknown-capable
   * answers above are what decide anything.
   */
  contradictionFlag: number;
  /**
   * True when the supplied data cannot support a judgment. NOT a negative finding:
   * `fit === "does_not_fit"` is a statement about the mandate's criteria, and this
   * is a statement about our evidence. A caller that collapses them turns every
   * data outage into a rejected candidate.
   */
  unknown: boolean;
  /** Whether it is worth commissioning research. False for unknown AND for misfit. */
  proceed: boolean;
}

export type CandidateFitResult =
  | { status: "ok"; assessment: CandidateFitAssessment; call: JevCallRecord }
  | { status: "unavailable"; ticker: string; reason: string; call: JevCallRecord };

/** Recover a level index from a score answer's probability keys. Null when unclear. */
function topLevelIndex(probabilities: Record<string, number>): number | null {
  let bestKey: string | null = null;
  let best = -Infinity;
  for (const [k, v] of Object.entries(probabilities)) {
    if (v > best) {
      best = v;
      bestKey = k;
    }
  }
  if (bestKey == null) return null;

  const byText = SOURCE_ADEQUACY_LEVELS.indexOf(bestKey as (typeof SOURCE_ADEQUACY_LEVELS)[number]);
  if (byText >= 0) return byText;

  const asIndex = Number(bestKey);
  if (Number.isInteger(asIndex) && asIndex >= 0 && asIndex < SOURCE_ADEQUACY_LEVELS.length) {
    return asIndex;
  }
  return null;
}

/**
 * The cheap triage pass for one candidate, before any research is commissioned.
 *
 * Returns `unavailable` — never a judgment — when Jev fails or answers something
 * unmappable. A provider outage is not a finding about a company, and the caller
 * must be able to tell the difference to keep `decision.ts`'s rule that not knowing
 * is not a verdict.
 */
export async function assessCandidateFit(
  snapshot: ResearchSnapshot,
  criteria: readonly string[],
  deps: AssessDeps = {}
): Promise<CandidateFitResult> {
  const budget = deps.budget ?? createJevBudget();
  const questions = buildFirstPassQuestions({ ticker: snapshot.ticker, criteria });
  const state = buildCandidateState(snapshot, criteria);

  const outcome = await runJevCall("candidate_fit", questions, state, deps, budget);
  if (!outcome.ok) {
    return { status: "unavailable", ticker: snapshot.ticker, reason: outcome.reason, call: outcome.record };
  }

  const fitAnswer = outcome.answers.supplied_data_fit;
  const adequacyAnswer = outcome.answers.source_adequacy;
  const contradictionAnswer = outcome.answers.contradiction_flags;

  // Each primitive is checked by shape, because the response carries no type field.
  // A choice where we expected a score is a question-set mismatch, not an answer.
  if (!fitAnswer || !isChoiceAnswer(fitAnswer)) {
    return unavailableFit(snapshot.ticker, "supplied_data_fit was not a choice answer", outcome.record);
  }
  if (!adequacyAnswer || !isScoreAnswer(adequacyAnswer)) {
    return unavailableFit(snapshot.ticker, "source_adequacy was not a score answer", outcome.record);
  }
  if (!contradictionAnswer || !isNoulAnswer(contradictionAnswer)) {
    return unavailableFit(snapshot.ticker, "contradiction_flags was not a noul answer", outcome.record);
  }
  if (!(SUPPLIED_DATA_FIT_OPTIONS as readonly string[]).includes(fitAnswer.choice)) {
    return unavailableFit(
      snapshot.ticker,
      `supplied_data_fit chose "${fitAnswer.choice}", which is not one of the options we sent`,
      outcome.record
    );
  }

  const fit = fitAnswer.choice as SuppliedDataFit;
  const index = topLevelIndex(adequacyAnswer.probabilities);
  const noSources = index === NO_USABLE_SOURCES_LEVEL;
  const unknown = fit === INSUFFICIENT_EVIDENCE || noSources;

  return {
    status: "ok",
    call: outcome.record,
    assessment: {
      ticker: snapshot.ticker,
      fit,
      sourceAdequacy: {
        score: adequacyAnswer.score,
        confidence: adequacyAnswer.confidence,
        topLevelIndex: index,
      },
      contradictionFlag: contradictionAnswer.noul,
      unknown,
      proceed: fit === "fits" && !noSources,
    },
  };
}

function unavailableFit(ticker: string, reason: string, call: JevCallRecord): CandidateFitResult {
  return { status: "unavailable", ticker, reason, call: { ...call, outcome: "failed", reason } };
}

/**
 * The triage pass over many candidates, bounded at `MAX_CANDIDATE_CONCURRENCY`.
 *
 * One budget is shared across the whole batch, so the run's caps apply to the run
 * and not to each candidate. Results come back in input order regardless of the
 * order they finished in: a screen is later zipped against its candidate list, and
 * completion order would scramble the pairing.
 */
export async function assessCandidateFits(
  snapshots: readonly ResearchSnapshot[],
  criteria: readonly string[],
  deps: AssessDeps = {}
): Promise<CandidateFitResult[]> {
  const budget = deps.budget ?? createJevBudget();
  const limit = Math.max(1, Math.min(deps.concurrency ?? MAX_CANDIDATE_CONCURRENCY, MAX_CANDIDATE_CONCURRENCY));
  const results = new Array<CandidateFitResult>(snapshots.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= snapshots.length) return;
      results[i] = await assessCandidateFit(snapshots[i], criteria, { ...deps, budget });
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, snapshots.length) }, worker));
  return results;
}

// ── Second pass ──────────────────────────────────────────────────────────────

export interface ScenarioAssessment {
  /**
   * The distribution, or NULL when anything at all went wrong.
   *
   * Null is the signal for the caller to use POLICY_V1.defaultScenarioWeights with
   * `basis: "fixed_prior"`. The one thing this field may never hold is a triple
   * this module invented.
   */
  weights: ScenarioWeights | null;
  /** The boundaries the distribution was asked against. Persist them with it. */
  buckets: ScenarioBuckets | null;
  /**
   * The vendor's confidence in the distribution, or null when there is none.
   *
   * Deliberately NOT gated here. `decision.ts` owns `minScenarioConfidence`, and
   * dropping the weights for low confidence in this module would report the
   * condition as `no_scenario_weights` — "we could not get a distribution" —
   * when the truth is `low_scenario_confidence`, "we got one and it was too
   * diffuse to rate on". Those lead to different reports.
   */
  confidence: number | null;
  thesisSupport: ThesisSupport | null;
  contradictoryEvidence: ContradictoryEvidence | null;
  /** Why the distribution is absent, when it is. */
  reason: string | null;
  calls: JevCallRecord[];
}

function withoutWeights(
  reason: string,
  buckets: ScenarioBuckets | null,
  calls: JevCallRecord[],
  partial: Partial<ScenarioAssessment> = {}
): ScenarioAssessment {
  return {
    weights: null,
    buckets,
    confidence: null,
    thesisSupport: null,
    contradictoryEvidence: null,
    ...partial,
    reason,
    calls,
  };
}

type MappedTriple = { ok: true; triple: ProbabilityTriple } | { ok: false; reason: string };

/**
 * Map a choice answer onto the bear/base/bull triple BY NAME, and check the sum.
 *
 * The option set must match exactly. A renamed option ("downside" for "bear") or a
 * partial one (two of three) is rejected rather than patched: the missing mass has
 * to come from somewhere, and every way of supplying it — dropping the stranger,
 * renormalising the remainder, spreading the difference — is this module inventing
 * part of a forecast it then labels as a model's.
 *
 * The sum is re-checked even though `schemas.ts` already validated it, because the
 * two tolerances differ on purpose: the vendor contract allows 1e-4 of drift, and
 * `ProbabilityTripleSchema` allows 1e-6. An answer in that gap is refused rather
 * than renormalised. The correction would be immaterial to any decision, which is
 * exactly why it is not worth making silently — a distribution that does not add up
 * is a vendor defect, and quietly fixing it is how we would stop hearing about it.
 */
function mapScenarioProbabilities(answer: JevChoiceAnswer): MappedTriple {
  const keys = Object.keys(answer.probabilities);
  const expected = new Set<string>(SCENARIO_OPTIONS);
  const missing = SCENARIO_OPTIONS.filter((o) => !(o in answer.probabilities));
  const extra = keys.filter((k) => !expected.has(k));

  if (missing.length > 0) {
    return { ok: false, reason: `scenario probabilities omitted: ${missing.join(", ")}` };
  }
  if (extra.length > 0) {
    return { ok: false, reason: `scenario probabilities named options we did not send: ${extra.join(", ")}` };
  }
  if (!(SCENARIO_OPTIONS as readonly string[]).includes(answer.choice)) {
    return { ok: false, reason: `scenario answer chose "${answer.choice}", which is not a scenario` };
  }

  const triple = {
    bear: answer.probabilities.bear,
    base: answer.probabilities.base,
    bull: answer.probabilities.bull,
  };
  const parsed = ProbabilityTripleSchema.safeParse(triple);
  if (!parsed.success) {
    const sum = triple.bear + triple.base + triple.bull;
    return {
      ok: false,
      reason: `scenario probabilities are not a valid distribution (sum ${sum}): ${parsed.error.issues
        .map((i) => i.message)
        .join("; ")}`,
    };
  }
  return { ok: true, triple: parsed.data };
}

/**
 * The post-research pass: read the evidence, then — only if it holds up — ask for
 * the scenario distribution.
 *
 * The order is load-bearing and is why this is two calls rather than one batched
 * request. The scenario question is expensive in the only currency Jev charges for,
 * and more importantly it is meaningless when the evidence did not address the
 * thesis: a distribution over outcome buckets, produced from research that is
 * silent on the question, would be a number with a confidence attached and nothing
 * behind it. So the gates run first, and each of them ends the pass with null
 * weights rather than weakening them.
 *
 * Scenario ordering is validated before anything is sent. Unordered scenario
 * returns mean the valuation disagrees with its own labels, which is a bug in the
 * valuation stage; asking a model to apportion probability across overlapping
 * buckets would spend tokens decorating that bug, and `computeReturns` cannot use
 * the result either way.
 */
export async function assessScenarios(
  snapshot: ResearchSnapshot,
  research: ResearchInput,
  scenarioReturns: ScenarioReturnTriple,
  deps: AssessDeps & { targetDate: string }
): Promise<ScenarioAssessment> {
  const budget = deps.budget ?? createJevBudget();
  const calls: JevCallRecord[] = [];

  const bucketResult = buildScenarioBuckets(scenarioReturns);
  if (bucketResult.status !== "ok") {
    return withoutWeights(bucketResult.reason, null, calls);
  }
  const buckets = bucketResult.buckets;

  const evidenceQuestions = buildSecondPassQuestions({
    ticker: snapshot.ticker,
    thesis: research.thesis,
  });
  const researchState = buildResearchState(snapshot, research);
  const evidence = await runJevCall("research_evidence", evidenceQuestions, researchState, deps, budget);
  calls.push(evidence.record);
  if (!evidence.ok) {
    return withoutWeights(evidence.reason, buckets, calls);
  }

  const supportAnswer = evidence.answers.thesis_support;
  const contraAnswer = evidence.answers.contradictory_evidence;
  if (!supportAnswer || !isChoiceAnswer(supportAnswer)) {
    return withoutWeights("thesis_support was not a choice answer", buckets, calls);
  }
  if (!contraAnswer || !isChoiceAnswer(contraAnswer)) {
    return withoutWeights("contradictory_evidence was not a choice answer", buckets, calls);
  }
  if (!(THESIS_SUPPORT_OPTIONS as readonly string[]).includes(supportAnswer.choice)) {
    return withoutWeights(
      `thesis_support chose "${supportAnswer.choice}", which is not one of the options we sent`,
      buckets,
      calls
    );
  }
  if (!(CONTRADICTORY_EVIDENCE_OPTIONS as readonly string[]).includes(contraAnswer.choice)) {
    return withoutWeights(
      `contradictory_evidence chose "${contraAnswer.choice}", which is not one of the options we sent`,
      buckets,
      calls
    );
  }

  const thesisSupport = supportAnswer.choice as ThesisSupport;
  const contradictoryEvidence = contraAnswer.choice as ContradictoryEvidence;
  const evidenceRead = { thesisSupport, contradictoryEvidence };

  // Gate 1: the research never addressed the thesis. Unknown, not negative — and
  // nothing to build a distribution on.
  if (thesisSupport === INSUFFICIENT_EVIDENCE || contradictoryEvidence === INSUFFICIENT_EVIDENCE) {
    return withoutWeights(
      "the gathered research does not address the thesis, so no scenario distribution was requested",
      buckets,
      calls,
      evidenceRead
    );
  }
  // Gate 2: material, unresolved evidence against the thesis. The scenarios were
  // valued on a thesis we now know is contested, so a distribution over them would
  // be precise about the wrong question. `decision.ts` handles the contradiction.
  if (contradictoryEvidence === "material") {
    return withoutWeights(
      "material unresolved evidence against the thesis, so no scenario distribution was requested",
      buckets,
      calls,
      evidenceRead
    );
  }

  const scenarioQuestion = buildScenarioQuestion({
    ticker: snapshot.ticker,
    asOf: snapshot.asOf,
    targetDate: deps.targetDate,
    boundaries: buckets.boundaries,
  });
  // The state carries the research, NOT the three scenario valuations. Handing over
  // the valuation's own middle point invites anchoring on it, which is the bias the
  // question explicitly warns against, and the bucket definitions already contain
  // every number the question needs.
  const scenario = await runJevCall(
    "scenario_distribution",
    scenarioQuestion,
    researchState,
    deps,
    budget
  );
  calls.push(scenario.record);
  if (!scenario.ok) {
    return withoutWeights(scenario.reason, buckets, calls, evidenceRead);
  }

  const answer = scenario.answers[SCENARIO_QUESTION_ID];
  if (!answer || !isChoiceAnswer(answer)) {
    return withoutWeights(`${SCENARIO_QUESTION_ID} was not a choice answer`, buckets, calls, evidenceRead);
  }

  const mapped = mapScenarioProbabilities(answer);
  if (!mapped.ok) {
    return withoutWeights(mapped.reason, buckets, calls, evidenceRead);
  }

  return {
    weights: {
      values: mapped.triple,
      // ALWAYS model_unvalidated. Nothing in this repository has measured a Jev
      // distribution against resolved outcomes, so there is no calibration
      // artifact to reference — and `ScenarioWeightsSchema` refuses
      // `empirically_calibrated` without one, which is the schema agreeing.
      basis: "model_unvalidated",
      model: scenario.record.resolvedModel,
      calibrationVersion: null,
    },
    buckets,
    confidence: answer.confidence,
    ...evidenceRead,
    reason: null,
    calls,
  };
}
