// The question sets. Every word Jev is ever asked lives in this file.
//
// Four rules govern what may be asked, and each of them exists because breaking
// it produces a specific, plausible-looking wrong answer.
//
//  1. EVERY CLASSIFICATION RUBRIC HAS AN EXPLICIT UNKNOWN OPTION. Without one, a
//     model handed an empty evidence bundle has to pick some judgment, and the
//     only judgments on offer are about the company. "We could not obtain the
//     filings" would come back as "does not fit" or "contradicted", and the report
//     would read as a finding against a company we simply know nothing about.
//     Missing evidence must land on `insufficient_evidence` and nowhere else.
//
//  2. NUMERIC CONSTRAINTS ARE NEVER ASKED. Whether a margin exceeds 20%, whether
//     the bear case is below the base case, whether a probability triple sums to
//     one — all of that is arithmetic, it is checked in `assess.ts` and in
//     `scenarioBuckets.ts`, and a language model asked to do it will sometimes be
//     confidently wrong in a way no validator downstream can detect. The model is
//     asked to read evidence; code does the sums.
//
//  3. QUESTIONS IN ONE REQUEST NEVER CONDITION ON EACH OTHER'S ANSWERS. All the
//     questions in one call are answered against the same state, independently and
//     in no particular order, so "if the previous answer was X, then..." has no
//     meaning here — the wording would imply an ordering the API does not provide.
//     A question that depends on something we learn from an earlier answer belongs
//     in a LATER call, which is why the scenario distribution is its own request:
//     whether to ask it at all depends on the evidence answers and on bucket
//     boundaries computed after them.
//
//  4. RELATED QUESTIONS ARE BATCHED AGAINST ONE STATE. Sending the same evidence
//     bundle three times to ask three questions costs three times the input
//     tokens, and input tokens are the only thing Jev charges for. Each call below
//     carries the largest set of questions that honestly fits rule 3.
//
// `QUESTION_SET_VERSION` is persisted on every report (see
// `ReportVersionsSchema.questionSetVersion`) and is part of the decision cache
// key. Bump it in the same commit as ANY wording change, including one that looks
// cosmetic. Without the bump, a cached report is compared against, and re-read as
// an answer to, a question that was never asked in that form — the same failure
// `POLICY_VERSION` prevents for thresholds.

import type { JevQuestion } from "./schemas";

/** Bump on any wording, option-name or level change below. Persisted per report. */
export const QUESTION_SET_VERSION = "jevq-v1-2026-09-22";

// ── Shared vocabulary ────────────────────────────────────────────────────────

/**
 * The one unknown option name, spelled identically in every rubric, so callers
 * can test for "the model could not judge this" without knowing which question
 * they are looking at.
 */
export const INSUFFICIENT_EVIDENCE = "insufficient_evidence";

const NO_INFERENCE_FROM_ABSENCE =
  `Answer only from the evidence supplied in the state. The state's gap list records what ` +
  `could not be obtained; evidence that is absent is not evidence against the company, so when ` +
  `the supplied evidence does not settle the question, answer "${INSUFFICIENT_EVIDENCE}".`;

// ── First pass: triage, before any research is commissioned ───────────────────

export const FIRST_PASS_QUESTION_IDS = [
  "supplied_data_fit",
  "source_adequacy",
  "contradiction_flags",
] as const;
export type FirstPassQuestionId = (typeof FIRST_PASS_QUESTION_IDS)[number];

export const SUPPLIED_DATA_FIT_OPTIONS = ["fits", "does_not_fit", INSUFFICIENT_EVIDENCE] as const;
export type SuppliedDataFit = (typeof SUPPLIED_DATA_FIT_OPTIONS)[number];

/**
 * Ordered worst to best, and they describe OUR EVIDENCE rather than the company —
 * which is what makes an ordered scale safe here. The bottom level says outright
 * that quality cannot be judged either way, so the unknown state has somewhere to
 * go on this axis without being confused with a bad one.
 */
export const SOURCE_ADEQUACY_LEVELS = [
  "No usable sources: the supplied data contains no dated, sourced statement about this company, so its quality cannot be judged either way.",
  "One-sided or undated: sources exist, but they all originate with the company itself or carry no date, so they cannot be placed against the as-of cutoff.",
  "Adequate for a preliminary view: at least one dated, independent source covers the main claims, with the remaining gaps recorded.",
  "Adequate and corroborated: dated sources from more than one independent origin cover the main claims.",
] as const;

/** Level 0 means we have nothing to judge, so nothing further may be spent. */
export const NO_USABLE_SOURCES_LEVEL = 0;

// ── Second pass: after research, narrowly defined ─────────────────────────────

export const SECOND_PASS_QUESTION_IDS = ["thesis_support", "contradictory_evidence"] as const;
export type SecondPassQuestionId = (typeof SECOND_PASS_QUESTION_IDS)[number];

/**
 * Four options, not an ordered scale. "Not addressed" and "contradicted" are not
 * two ends of one axis — one is an absence of evidence and the other is evidence
 * pointing the other way — and a score would place them on the same axis, where
 * the difference between "we found nothing" and "we found the opposite" is exactly
 * one level of severity. That conflation is the failure rule 1 guards against, so
 * this stays a choice.
 */
export const THESIS_SUPPORT_OPTIONS = [
  "supported",
  "mixed",
  "contradicted",
  INSUFFICIENT_EVIDENCE,
] as const;
export type ThesisSupport = (typeof THESIS_SUPPORT_OPTIONS)[number];

export const CONTRADICTORY_EVIDENCE_OPTIONS = [
  "none_found",
  "immaterial",
  "material",
  INSUFFICIENT_EVIDENCE,
] as const;
export type ContradictoryEvidence = (typeof CONTRADICTORY_EVIDENCE_OPTIONS)[number];

// ── The scenario distribution: its own call, and its own rules ────────────────

export const SCENARIO_QUESTION_ID = "scenario_outcome";

/**
 * Exactly the three scenario ids, and deliberately NO unknown option.
 *
 * This is the one rubric without one, and the reason is arithmetic rather than
 * editorial: the answer is mapped onto a `ProbabilityTriple` that must sum to one
 * over bear, base and bull. A fourth "unknown" option would take probability mass
 * out of the distribution, and every way of putting it back — dropping it,
 * renormalising the rest, spreading it evenly — invents a forecast.
 *
 * The unknown case is handled by NOT ASKING. `assessScenarios` runs the evidence
 * gates first and only sends this question when they pass; when they do not, the
 * weights are null and the caller falls back to the labelled `fixed_prior`. An
 * absent distribution is representable; an "unknown" slice of a distribution is
 * not.
 *
 * The names must match the option keys exactly, because the answer is mapped by
 * name. Mapping by position would silently invert bear and bull the first time the
 * vendor changed its key order, and an inverted distribution is the single most
 * expensive bug this feature could ship.
 */
export const SCENARIO_OPTIONS = ["bear", "base", "bull"] as const;
export type ScenarioOption = (typeof SCENARIO_OPTIONS)[number];

/**
 * A boundary as the question states it. Fixed two decimal places on a percentage,
 * so the wording is stable for a given number and two reports of the same forecast
 * are byte-identical.
 */
export function formatBoundary(fraction: number): string {
  if (!Number.isFinite(fraction)) {
    throw new Error(`scenario boundary must be finite, got ${fraction}`);
  }
  return `${(fraction * 100).toFixed(2)}%`;
}

// ── Builders ─────────────────────────────────────────────────────────────────

export interface FirstPassInput {
  ticker: string;
  /** The mandate's qualitative criteria. May be empty. */
  criteria: readonly string[];
}

/**
 * The cheap triage pass, asked BEFORE any research is commissioned.
 *
 * All three are answered against the same supplied data, none of them needs
 * another's answer, so they travel in one request. The point of the pass is to
 * avoid paying for research on a candidate whose supplied data cannot support any
 * — and, just as importantly, to record WHY when that happens, because "we had
 * nothing to work with" and "this does not match what you asked for" lead to
 * different reports.
 */
export function buildFirstPassQuestions(input: FirstPassInput): Record<string, JevQuestion> {
  const criteriaText =
    input.criteria.length > 0
      ? input.criteria.map((c, i) => `(${i + 1}) ${c}`).join(" ")
      : "(none were stated, so judge only whether the supplied data identifies one company clearly enough to research)";

  return {
    supplied_data_fit: {
      type: "choice",
      instructions:
        `The state holds the supplied data for ${input.ticker} and the user's qualitative criteria: ` +
        `${criteriaText} Decide whether the supplied data shows this company matching those criteria. ` +
        `Judge the match only; do not judge whether the company is a good investment, and do not apply ` +
        `any numeric threshold — figures are checked in code, not here. ${NO_INFERENCE_FROM_ABSENCE}`,
      criteria: {
        fits: "The supplied data shows this company meeting the stated criteria.",
        does_not_fit:
          "The supplied data shows this company failing at least one stated criterion. This is a statement about the criteria, not about the company's quality.",
        [INSUFFICIENT_EVIDENCE]:
          "The supplied data does not say enough to decide either way. Choose this whenever the relevant evidence is missing, undated or unreadable, rather than guessing.",
      },
    },
    source_adequacy: {
      type: "score",
      instructions:
        `Rate the SOURCES in the state, not the company. Which level below describes the evidence ` +
        `supplied for ${input.ticker}? You are judging whether this material could support research, ` +
        `so a company with excellent prospects and no dated sources belongs at a low level, and a ` +
        `company in trouble whose trouble is thoroughly documented belongs at a high one.`,
      criteria: [...SOURCE_ADEQUACY_LEVELS],
    },
    contradiction_flags: {
      type: "noul",
      instructions:
        `Does the supplied data for ${input.ticker} contain statements that cannot all be true at ` +
        `once — for example the same period reported with two different figures, or a stated fact and ` +
        `its negation? Consider only whether the supplied statements conflict with each other.`,
      criteria: {
        true: "At least two supplied statements are mutually inconsistent.",
        false: "The supplied statements are mutually consistent, as far as they go.",
      },
    },
  };
}

export interface SecondPassInput {
  ticker: string;
  /** The thesis the research was commissioned to test, in one sentence. */
  thesis: string;
}

/**
 * The post-research evidence pass.
 *
 * Two questions against the finished research bundle, batched because neither
 * needs the other's answer: one asks which way the evidence points, the other how
 * much of it points the other way. The scenario distribution is NOT here — it is
 * asked in a later call, because whether it should be asked at all depends on
 * these two answers.
 */
export function buildSecondPassQuestions(input: SecondPassInput): Record<string, JevQuestion> {
  return {
    thesis_support: {
      type: "choice",
      instructions:
        `The state holds the research gathered for ${input.ticker} and the thesis it was gathered to ` +
        `test: "${input.thesis}". Decide what the gathered evidence does to that thesis. Weigh the ` +
        `evidence as recorded, treating a claim marked as an inference or an assumption as weaker than ` +
        `one marked as observed. ${NO_INFERENCE_FROM_ABSENCE}`,
      criteria: {
        supported: "The gathered evidence supports the thesis, with no material evidence against it.",
        mixed:
          "The gathered evidence both supports and undercuts the thesis, and neither side settles it.",
        contradicted:
          "The gathered evidence points against the thesis. Choose this only when evidence actually contradicts it, never merely because supporting evidence is missing.",
        [INSUFFICIENT_EVIDENCE]:
          "The gathered evidence does not address the thesis. Choose this when the research is silent on it, however much other material is present.",
      },
    },
    contradictory_evidence: {
      type: "choice",
      instructions:
        `Still against the research gathered for ${input.ticker} and the thesis "${input.thesis}": how ` +
        `much of the gathered evidence argues AGAINST the thesis, and how material is it? Materiality ` +
        `here means whether the item would change the conclusion, not how strongly it is worded. ` +
        `${NO_INFERENCE_FROM_ABSENCE}`,
      criteria: {
        none_found:
          "The gathered evidence contains nothing that argues against the thesis. Choose this only when there is enough evidence for that absence to mean something.",
        immaterial:
          "Some gathered evidence argues against the thesis, but none of it would change the conclusion.",
        material:
          "At least one piece of gathered evidence would change the conclusion if it holds, and it has not been resolved.",
        [INSUFFICIENT_EVIDENCE]:
          "There is not enough gathered evidence to tell whether anything argues against the thesis.",
      },
    },
  };
}

export interface ScenarioQuestionInput {
  ticker: string;
  /** The run's as-of cutoff — the date the return is measured FROM. */
  asOf: string;
  /** The horizon's end date — the date the return is measured TO. */
  targetDate: string;
  /** The two midpoints from `buildScenarioBuckets`, ascending. */
  boundaries: readonly [number, number];
}

/**
 * The scenario-outcome distribution. One question, one call, only after the gates.
 *
 * The buckets are stated as DEFINITIONS with the numbers already computed, in the
 * same half-open form `classifyRealisedReturn` will use at resolution time: bear
 * below the lower boundary, base from the lower boundary up to but not including
 * the upper, bull at or above the upper. Stating them this way is what makes the
 * answer a resolvable forecast rather than a mood — and restating them identically
 * at resolution is why `boundaries` is persisted with the report instead of being
 * recomputed later from re-derived scenarios.
 *
 * Throws on non-ascending boundaries. That input can only come from a caller that
 * skipped `buildScenarioBuckets`, which already refuses unordered scenarios, so it
 * is a programming error rather than a data condition — and the one thing we must
 * not do is ask a model to apportion probability across buckets that overlap.
 */
export function buildScenarioQuestion(input: ScenarioQuestionInput): Record<string, JevQuestion> {
  const [lower, upper] = input.boundaries;
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || !(lower < upper)) {
    throw new Error(
      `scenario bucket boundaries must be finite and ascending, got ${lower} / ${upper} — ` +
        `derive them with buildScenarioBuckets, which refuses unordered scenarios`
    );
  }
  const lo = formatBoundary(lower);
  const hi = formatBoundary(upper);

  return {
    [SCENARIO_QUESTION_ID]: {
      type: "choice",
      instructions:
        `Assign a probability to each of the three outcome buckets below for ${input.ticker}'s TOTAL ` +
        `RETURN over the period from ${input.asOf} to ${input.targetDate}. Total return means the ` +
        `change in share price plus any cash distributions per share, as a fraction of the share price ` +
        `on ${input.asOf}. The buckets are defined by fixed boundaries that are already computed for ` +
        `you: they do not overlap, and together they cover every possible outcome, so exactly one of ` +
        `them will contain the realised return. Do not re-derive the boundaries and do not calculate ` +
        `any return yourself — judge only how likely each bucket is. Do not treat the middle bucket as ` +
        `more likely because of its position or its name. Base the probabilities only on the evidence ` +
        `supplied in the state; the state's gap list records what could not be obtained, and evidence ` +
        `that is absent is not evidence for or against any bucket.`,
      criteria: {
        bear: `Total return below ${lo}.`,
        base: `Total return at or above ${lo} and below ${hi}.`,
        bull: `Total return at or above ${hi}.`,
      },
    },
  };
}
