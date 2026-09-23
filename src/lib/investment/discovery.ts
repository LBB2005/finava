// Discovery funnel planning — who gets looked at, in what order, and who did not.
//
// Discovery is a narrowing funnel: a universe is screened to an eligible pool, at
// most 40 of those are assessed, at most 10 of the assessed are deep-researched,
// and at most 5 of those are highlighted. This module owns the deterministic part
// of that narrowing. It does no I/O, spends no credits and calls no model; a
// qualitative prioritiser can be injected, and its absence is a labelled outcome
// rather than a hidden one.
//
// Three rules govern everything here, and each one is a rule about honesty:
//
//  1. CEILINGS ARE CEILINGS, NOT QUOTAS. Three names that fit is a better answer
//     than three names plus seven that do not. Nothing in this file pads a stage
//     to its limit, and the scout's established behaviour — zero survivors is a
//     real, informative answer — is preserved rather than re-litigated.
//
//  2. ELIGIBILITY IS NEVER COMPUTED WITH A TRUNCATING LIMIT. `applyScreen`'s
//     `limit` both ranks and truncates (default 40), so screening a 537-name
//     universe through it discards eligible names before eligibility is known.
//     Everything here screens against the FULL universe size and caps afterwards.
//
//  3. A NAME DROPPED SILENTLY IS INDISTINGUISHABLE FROM ONE NEVER CONSIDERED.
//     Every exclusion — a failed screen limit, a ceiling, a duplicate row —
//     carries a reason out of this module so the UI can answer "why not X?".
//
// And one rule about evidence: a factor sub-score with no usable input underneath
// it is a NEUTRAL 50 (see `scoreFactor` in lib/factors.ts), which is a placeholder,
// not a reading. Coverage here counts only observed factors, so a fully-outaged
// name can never present as a fully-covered one. This is the sector-relative
// factor engine, kept deliberately separate from the Finava Score in
// lib/finavaScore.ts — the two measure different things and are never averaged.

import { FACTORS, type FactorKey, type RankedStock, type Stock } from "@/lib/research";
import { applyScreen, coerceFilter, type ScreenFilter } from "@/lib/screen";
import type { ResearchMandate, SourceGap } from "./contracts";

// ── Ceilings ─────────────────────────────────────────────────────────────────

/** Bumped with any change to how a plan is derived. Persisted in the plan key. */
export const DISCOVERY_PLAN_VERSION = "discovery-plan-v1-2026-09-22";

/** At most this many eligible names are assessed by the crew. */
export const ASSESSMENT_CEILING = 40;
/** At most this many assessed names earn full valuation and deep research. */
export const DEEP_RESEARCH_CEILING = 10;
/** At most this many deep-researched names are highlighted to the user. */
export const HIGHLIGHT_CEILING = 5;

/**
 * Shown when the mandate's stated limits match nothing in the universe.
 *
 * Deliberately the same shape of statement as the scout's `SCOUT_NO_MATCHES_LABEL`
 * — the screen ran and nothing qualified — but declared here rather than imported,
 * so nothing under `src/lib` has to reach into `src/agents` (see the client-bundle
 * trap: an agent import pulled into a client component drags the whole graph).
 */
export const DISCOVERY_NO_MATCHES_LABEL =
  "No name in the universe matches those limits right now";

/** Shown when no qualitative prioritiser was wired in at all. */
export const DISCOVERY_DETERMINISTIC_ORDER_LABEL =
  "Ordered by screen rank — not model-prioritised";

/** Shown when a prioritiser was wired in and could not be reached. */
export const DISCOVERY_PRIORITISER_UNAVAILABLE_LABEL =
  "Qualitative prioritiser unavailable — ordered by screen rank, not by fit to your request";

// ── Evidence coverage ────────────────────────────────────────────────────────

const ALL_FACTOR_KEYS: readonly FactorKey[] = FACTORS.map((f) => f.key);

/**
 * Which factors the fundamentals feed is responsible for.
 *
 * Read off lib/factors.ts: growth, quality and health are built from `fund(i)`,
 * and value is built from `fund(i)` against market cap. When that feed reports
 * anything other than "ok" every one of these four collapses to the neutral 50.
 */
const FUNDAMENTAL_FACTORS: readonly FactorKey[] = ["growth", "quality", "value", "health"];

/**
 * What we can actually establish about one candidate's inputs.
 *
 * `observedFactors` and `placeholderFactors` are not complements: a factor may be
 * in neither, which means its provenance is unknown. Unknown is NOT coverage —
 * counting it would be the same mistake as counting a neutral 50.
 */
export interface CandidateEvidence {
  /** Factor sub-scores computed from real inputs. */
  observedFactors: readonly FactorKey[];
  /** Factor sub-scores standing at the neutral 50. Never evidence. */
  placeholderFactors: readonly FactorKey[];
  /** Sources asked for and not obtained, in the frozen contract's vocabulary. */
  sourceFailures: readonly SourceGap[];
}

/** The same thing, with the derived fractions the funnel and the UI read. */
export interface CandidateCoverage extends CandidateEvidence {
  /** Fraction of the six factors backed by observed evidence. */
  observedFraction: number;
  /** Factors whose provenance the probe could not establish either way. */
  unknownFactors: readonly FactorKey[];
  /** True when nothing about this name rests on an observed input. */
  placeholderOnly: boolean;
}

/**
 * Establishes provenance for one universe row.
 *
 * Injected because the row itself does not carry enough: `Stock` records a
 * `fundStatus` for the fundamentals feed and nothing at all for the analyst feed,
 * so the only component that can speak to analyst coverage is the one that made
 * the call. A caller that knows more should pass a better probe; the default
 * below is deliberately conservative rather than optimistic.
 */
export type EvidenceProbe = (stock: Stock) => CandidateEvidence;

/**
 * The conservative default probe.
 *
 * `fundStatus: "unavailable"` counts as a placeholder, not merely as an absence:
 * "this company has no filings on record" and "this source was unreachable" are
 * different facts, but they produce the SAME neutral 50 in the factor engine, and
 * a 50 is not a reading either way. The distinction is preserved in the emitted
 * `SourceGap.reason`, where it belongs, instead of being flattened into coverage.
 */
export function defaultEvidenceProbe(stock: Stock): CandidateEvidence {
  const observed: FactorKey[] = [];
  const placeholder: FactorKey[] = [];
  const gaps: SourceGap[] = [];

  if (stock.fundStatus === "ok") {
    observed.push(...FUNDAMENTAL_FACTORS);
  } else if (stock.fundStatus === "failed" || stock.fundStatus === "unavailable") {
    placeholder.push(...FUNDAMENTAL_FACTORS);
    gaps.push({
      source: "fundamentals",
      field: FUNDAMENTAL_FACTORS.join(","),
      reason: stock.fundStatus === "failed" ? "unavailable" : "not_covered",
      detail:
        stock.fundStatus === "failed"
          ? "fundamentals source unreachable — growth, quality, value and health are neutral placeholders"
          : "no filings on record — growth, quality, value and health are neutral placeholders",
    });
  }
  // fundStatus undefined: an overlay row that never fetched fundamentals. Neither
  // observed nor demonstrably placeholder, so it is left in neither list.

  // Momentum is computed from close history, which only exists for a priced row.
  // `factors.ts` writes `price: p ?? 0`, so a zero price means unpriced, not free.
  if (stock.price > 0) observed.push("mom");
  else {
    placeholder.push("mom");
    gaps.push({
      source: "price",
      field: "mom",
      reason: "unavailable",
      detail: "no price on record — momentum is a neutral placeholder",
    });
  }

  // `analyst` is intentionally absent from both lists. Nothing on a `Stock` says
  // whether the analyst feed answered for THIS ticker, and claiming coverage we
  // cannot establish is exactly the failure this module exists to prevent.

  return { observedFactors: observed, placeholderFactors: placeholder, sourceFailures: gaps };
}

function toCoverage(evidence: CandidateEvidence): CandidateCoverage {
  const observed = new Set(evidence.observedFactors);
  const placeholder = new Set(evidence.placeholderFactors);
  const unknown = ALL_FACTOR_KEYS.filter((k) => !observed.has(k) && !placeholder.has(k));
  return {
    observedFactors: [...evidence.observedFactors],
    placeholderFactors: [...evidence.placeholderFactors],
    sourceFailures: [...evidence.sourceFailures],
    unknownFactors: unknown,
    observedFraction: observed.size / ALL_FACTOR_KEYS.length,
    placeholderOnly: observed.size === 0,
  };
}

// ── Qualitative prioritisation (injected) ────────────────────────────────────

/** One name's qualitative priority. Comparable only within the same result. */
export interface QualitativeRank {
  ticker: string;
  /** Higher is a better fit. Scale is the provider's; only the order is used. */
  priority: number;
  /** A short, user-facing reason, when the provider gives one. */
  note: string | null;
}

export interface QualitativePriorityRequest {
  mandate: ResearchMandate;
  /** The assessed pool, already screened and in deterministic order. */
  candidates: readonly PlannedCandidate[];
}

/**
 * Deliberately not a bare array: an outage has to be expressible as something
 * other than an empty ranking, because "nothing fits" and "nobody answered" must
 * not render the same way.
 */
export type QualitativePriorityResult =
  | { status: "ok"; ranks: readonly QualitativeRank[] }
  | { status: "unavailable"; reason: string };

/**
 * The qualitative fit/priority step, as a dependency this module never constructs.
 *
 * Kept behind one interface so the provider (Jev today) is replaceable and so the
 * whole funnel is testable without a key. It may reject or throw; either is
 * handled as unavailability, never as a verdict.
 */
export interface QualitativePrioritizer {
  /** Stable provider id, surfaced in the ordering provenance. */
  readonly id: string;
  prioritize(
    request: QualitativePriorityRequest
  ): Promise<QualitativePriorityResult> | QualitativePriorityResult;
}

// ── Plan shapes ──────────────────────────────────────────────────────────────

export type DiscoveryStage = "eligibility" | "assessment" | "deep_research";

/**
 * Why a name is not in the stage it could have been in.
 *
 * `assessment_ceiling` and `deep_research_ceiling` are ordinary, expected
 * outcomes — a 200-name eligible pool has 160 of the first — but they are still
 * recorded, because "we stopped at 40" and "it failed your screen" are different
 * answers to "why isn't X here?".
 */
export type ExclusionReason =
  | "malformed_row"
  | "duplicate_ticker"
  | "hard_filter"
  | "unverified_factor_band"
  | "assessment_ceiling"
  | "deep_research_ceiling";

export interface RejectedCandidate {
  ticker: string;
  /** The stage the name did not make it out of. */
  stage: DiscoveryStage;
  reason: ExclusionReason;
  /** Human-readable, naming the specific limit or ceiling. Never empty. */
  detail: string;
}

export interface PlannedCandidate {
  ticker: string;
  name: string;
  sector: string;
  /** The screen's own composite, so the funnel and the Screen lens agree. */
  screenScore: number;
  /** 1-based position in the deterministic order. Invariant under input shuffle. */
  deterministicRank: number;
  /** Null when no prioritiser ranked this name. Never a stand-in value. */
  qualitativePriority: number | null;
  qualitativeNote: string | null;
  coverage: CandidateCoverage;
}

export type OrderingKind = "model_prioritised" | "deterministic" | "deterministic_fallback";

/**
 * How the order in `assess` came about.
 *
 * `deterministic` (no prioritiser was wired) and `deterministic_fallback` (one was,
 * and it failed) look identical on screen unless we keep them apart, and they mean
 * very different things: the first is a configuration, the second is an outage.
 */
export interface OrderingProvenance {
  kind: OrderingKind;
  /** The provider that ranked, or was asked and could not. Null when none was wired. */
  providerId: string | null;
  /** Non-null exactly when `kind` is `deterministic_fallback`. */
  fallbackReason: string | null;
  /** Ready to show. The UI must not have to reconstruct this sentence. */
  label: string;
}

/**
 * `no_matches` is a successful run that found nothing; `partial` is a run whose
 * inputs were incomplete. Conflating them would let an outage read as an absence
 * of opportunities.
 */
export type DiscoveryPlanStatus = "planned" | "partial" | "no_matches";

export interface DiscoveryPlan {
  planVersion: string;
  /** The reuse identity. Changing the horizon alone changes this. */
  planKey: string;
  mandate: ResearchMandate;
  status: DiscoveryPlanStatus;
  /** How many rows the screen was run against. */
  universeSize: number;
  /** How many satisfied the hard filters, computed WITHOUT any cap. */
  eligibleCount: number;
  /** At most `ASSESSMENT_CEILING`, in final order. May be shorter. */
  assess: readonly PlannedCandidate[];
  /** The leading slice of `assess`, at most `DEEP_RESEARCH_CEILING`. */
  deepResearch: readonly PlannedCandidate[];
  /** Presentation ceiling only. Ranking, not this module, picks the finalists. */
  highlightCeiling: number;
  ordering: OrderingProvenance;
  /** Every name excluded at every stage, with its reason. */
  rejected: readonly RejectedCandidate[];
  /** Run-level source failures plus every per-candidate gap, de-duplicated. */
  sourceFailures: readonly SourceGap[];
  /** Human-readable explanations. Always populated for a non-`planned` status. */
  notes: readonly string[];
}

export interface DiscoveryPlanOptions {
  /** Absent or null → deterministic order, explicitly labelled as such. */
  prioritizer?: QualitativePrioritizer | null;
  evidenceProbe?: EvidenceProbe;
  /** Outages the caller already knows about, e.g. a dead feed for this run. */
  sourceFailures?: readonly SourceGap[];
  /** Tightened for a cheaper run. Never widened past the module's ceilings. */
  assessmentCeiling?: number;
  deepResearchCeiling?: number;
  highlightCeiling?: number;
}

// ── Hard filters ─────────────────────────────────────────────────────────────

/**
 * The mandate's screen limits as a `ScreenFilter`, with `limit` removed.
 *
 * `hardFilter` is `Record<string, unknown>` on the contract so contracts.ts does
 * not have to import the screener, so it is sanitized through `coerceFilter` here
 * — the same path a model-produced filter takes. `limit` is dropped rather than
 * honoured: it is the truncating field, and a mandate that carried one would cap
 * eligibility at the screener's default 40 before eligibility was known.
 */
export function hardFilterFromMandate(mandate: ResearchMandate): ScreenFilter | null {
  if (mandate.hardFilter == null) return null;
  const filter = coerceFilter(mandate.hardFilter);
  delete filter.limit;
  // `coerceFilter` writes explicit `undefined` for absent numeric fields; strip
  // them so `Object.keys` reflects what the user actually stated.
  for (const key of Object.keys(filter) as (keyof ScreenFilter)[]) {
    if (filter[key] === undefined) delete filter[key];
  }
  return Object.keys(filter).length > 0 ? filter : null;
}

/**
 * Which stated limits a row fails, phrased for a person.
 *
 * This mirrors `applyScreen`'s predicates rather than replacing them: the screen
 * still decides eligibility below, and this exists only so a rejection can name
 * the binding limit. If the two ever disagree, the caller gets a generic detail
 * (see `GENERIC_SCREEN_FAILURE`) — vague, but never silent and never wrong.
 */
function failedLimits(stock: Stock, filter: ScreenFilter): string[] {
  const reasons: string[] = [];

  if (filter.factors) {
    for (const [key, band] of Object.entries(filter.factors)) {
      if (!band) continue;
      const value = stock.f[key as FactorKey];
      if (value == null) continue;
      if (band.min != null && value < band.min) reasons.push(`${key} ${value} < ${band.min}`);
      if (band.max != null && value > band.max) reasons.push(`${key} ${value} > ${band.max}`);
    }
  }
  if (filter.sectors?.length) {
    const sector = stock.sector.toLowerCase();
    const matched = filter.sectors.some((wanted) => {
      const w = wanted.toLowerCase().trim();
      return sector.includes(w) || w.includes(sector);
    });
    if (!matched) reasons.push(`sector ${stock.sector} not in ${filter.sectors.join("/")}`);
  }

  const pe = stock.pe;
  // A loss-maker has no P/E. The screen treats that as failing a P/E limit rather
  // than as passing it, and the detail says which of the two it was.
  if (filter.maxPe != null) {
    if (pe == null || pe <= 0) reasons.push(`no positive P/E to compare to max ${filter.maxPe}`);
    else if (pe > filter.maxPe) reasons.push(`P/E ${pe.toFixed(1)} > ${filter.maxPe}`);
  }
  if (filter.minPe != null) {
    if (pe == null) reasons.push(`no P/E to compare to min ${filter.minPe}`);
    else if (pe < filter.minPe) reasons.push(`P/E ${pe.toFixed(1)} < ${filter.minPe}`);
  }

  if (filter.maxPrice != null && !(stock.price > 0 && stock.price <= filter.maxPrice)) {
    reasons.push(`price ${stock.price} outside max $${filter.maxPrice}`);
  }
  if (filter.minPrice != null && !(stock.price >= filter.minPrice)) {
    reasons.push(`price ${stock.price} below min $${filter.minPrice}`);
  }

  const cap = stock.marketCap;
  if (filter.minMarketCap != null) {
    if (cap == null) reasons.push(`no market cap to compare to min ${filter.minMarketCap}`);
    else if (cap < filter.minMarketCap) reasons.push(`market cap ${cap} < ${filter.minMarketCap}`);
  }
  if (filter.maxMarketCap != null) {
    if (cap == null) reasons.push(`no market cap to compare to max ${filter.maxMarketCap}`);
    else if (cap > filter.maxMarketCap) reasons.push(`market cap ${cap} > ${filter.maxMarketCap}`);
  }

  if (filter.minChg != null && stock.chg < filter.minChg) {
    reasons.push(`move ${stock.chg}% < ${filter.minChg}%`);
  }
  if (filter.maxChg != null && stock.chg > filter.maxChg) {
    reasons.push(`move ${stock.chg}% > ${filter.maxChg}%`);
  }

  return reasons;
}

const GENERIC_SCREEN_FAILURE = "did not satisfy the stated screen limits";

/**
 * Factors a band is asserted against, restricted to those the row cannot support.
 *
 * A band of `{ min: 40 }` is satisfied by a neutral 50, so a name whose factor is
 * a placeholder would pass a screen it was never measured against — a data outage
 * silently manufacturing matches. Such a name is excluded and SAID to be excluded
 * for that reason, which is very different from claiming it failed the band.
 */
function unverifiableBands(
  filter: ScreenFilter | null,
  coverage: CandidateCoverage
): FactorKey[] {
  if (!filter?.factors) return [];
  const placeholders = new Set(coverage.placeholderFactors);
  return (Object.keys(filter.factors) as FactorKey[]).filter((k) => placeholders.has(k));
}

// ── Deterministic ordering ───────────────────────────────────────────────────

/**
 * The value the screen would sort on. Mirrors `applyScreen`'s own `val`.
 *
 * Duplicated (six lines) rather than imported because the screener does not export
 * it, and because the ordering below needs the raw value to apply an explicit
 * ticker tie-break. `Array.prototype.sort` is stable in input order, which means
 * the screener alone would order tied names by however the universe happened to
 * arrive — so the same universe in a different order would produce a different
 * shortlist, and a cached plan would stop matching a fresh one.
 */
function orderingValue(stock: RankedStock, sort: ScreenFilter["sort"]): number {
  const key = sort?.key ?? "score";
  if (key === "score") return stock.score;
  if (key === "chg") return stock.chg;
  if (key === "marketCap") return stock.marketCap ?? 0;
  return stock.f[key];
}

function compareDeterministic(
  a: RankedStock,
  b: RankedStock,
  sort: ScreenFilter["sort"]
): number {
  const dir = sort?.dir ?? "desc";
  const av = orderingValue(a, sort);
  const bv = orderingValue(b, sort);
  if (av !== bv) return dir === "asc" ? av - bv : bv - av;
  // Ticker, always ascending regardless of `dir`: the tie-break exists to make the
  // order reproducible, not to express a preference.
  return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
}

// ── Plan key ─────────────────────────────────────────────────────────────────

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/**
 * Everything that must match for a stored discovery plan to be reusable.
 *
 * The horizon's COUNT and UNIT are in here — and its `targetDate`, `yearFraction`
 * and `assumed` flag are deliberately not, mirroring `DecisionCacheKey`. A
 * three-month search and a three-year search over the same universe are different
 * questions with different answers, so changing only the horizon must invalidate;
 * but `targetDate` slides every day for a relative horizon, and including it would
 * expire every plan overnight for no informational reason.
 */
export function discoveryPlanKey(mandate: ResearchMandate): string {
  return canonical({
    planVersion: DISCOVERY_PLAN_VERSION,
    mode: mandate.mode,
    query: mandate.query,
    ticker: mandate.ticker,
    horizonCount: mandate.horizon.count,
    horizonUnit: mandate.horizon.unit,
    benchmark: mandate.benchmark,
    universeVersion: mandate.universeVersion,
    hardFilter: mandate.hardFilter,
    // Order is the user's own emphasis, so it is preserved rather than sorted.
    qualitativeCriteria: mandate.qualitativeCriteria,
  });
}

// ── The plan ─────────────────────────────────────────────────────────────────

function clampCeiling(requested: number | undefined, ceiling: number): number {
  if (requested == null || !Number.isFinite(requested)) return ceiling;
  // Tightening is a legitimate cost decision; widening would make the ceilings
  // this module advertises untrue, so it is clamped rather than honoured.
  return Math.max(0, Math.min(ceiling, Math.floor(requested)));
}

function dedupeGaps(gaps: readonly SourceGap[]): SourceGap[] {
  const seen = new Set<string>();
  const out: SourceGap[] = [];
  for (const gap of gaps) {
    const key = `${gap.source}|${gap.field}|${gap.reason}|${gap.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(gap);
  }
  return out;
}

/**
 * Plan a discovery run: screen, order, cap, and record everyone who fell out.
 *
 * Async only because the injected prioritiser may be a network call. With no
 * prioritiser the whole function is synchronous work and depends on nothing but
 * its arguments, so the same universe — in any order — yields the same plan.
 */
export async function planInvestmentDiscovery(
  mandate: ResearchMandate,
  universe: readonly Stock[],
  options: DiscoveryPlanOptions = {}
): Promise<DiscoveryPlan> {
  const probe = options.evidenceProbe ?? defaultEvidenceProbe;
  const assessmentCeiling = clampCeiling(options.assessmentCeiling, ASSESSMENT_CEILING);
  const deepCeiling = clampCeiling(options.deepResearchCeiling, DEEP_RESEARCH_CEILING);
  const highlightCeiling = clampCeiling(options.highlightCeiling, HIGHLIGHT_CEILING);

  const filter = hardFilterFromMandate(mandate);
  const rejected: RejectedCandidate[] = [];
  const notes: string[] = [];
  const gaps: SourceGap[] = [...(options.sourceFailures ?? [])];

  // ── 1. De-duplicate and reject malformed rows ─────────────────────────────
  // A duplicate ticker would be assessed twice and occupy two of the forty slots.
  const coverageByTicker = new Map<string, CandidateCoverage>();
  const rows: Stock[] = [];
  const seen = new Set<string>();
  for (const stock of universe) {
    const ticker = typeof stock?.ticker === "string" ? stock.ticker.trim().toUpperCase() : "";
    if (!ticker) {
      rejected.push({
        ticker: "",
        stage: "eligibility",
        reason: "malformed_row",
        detail: "universe row has no ticker",
      });
      continue;
    }
    if (seen.has(ticker)) {
      rejected.push({
        ticker,
        stage: "eligibility",
        reason: "duplicate_ticker",
        detail: "a row for this ticker was already accepted",
      });
      continue;
    }
    seen.add(ticker);
    const row: Stock = { ...stock, ticker };
    rows.push(row);
    const coverage = toCoverage(probe(row));
    coverageByTicker.set(ticker, coverage);
    gaps.push(...coverage.sourceFailures);
  }

  // ── 2. Withhold names a factor band cannot honestly be judged against ─────
  const screenable: Stock[] = [];
  for (const row of rows) {
    const coverage = coverageByTicker.get(row.ticker)!;
    const unverifiable = unverifiableBands(filter, coverage);
    if (unverifiable.length > 0) {
      rejected.push({
        ticker: row.ticker,
        stage: "eligibility",
        reason: "unverified_factor_band",
        detail: `${unverifiable.join(", ")} ${
          unverifiable.length === 1 ? "is" : "are"
        } a neutral placeholder, so the stated band cannot be verified for this name`,
      });
      continue;
    }
    screenable.push(row);
  }

  // ── 3. Eligibility, UNCAPPED ──────────────────────────────────────────────
  // `limit: screenable.length` is the whole point: the screener's default 40 both
  // ranks and truncates, so anything smaller silently discards eligible names.
  const eligible: RankedStock[] = filter
    ? applyScreen(screenable, { ...filter, limit: Math.max(1, screenable.length) })
    : applyScreen(screenable, { limit: Math.max(1, screenable.length) });

  const eligibleTickers = new Set(eligible.map((s) => s.ticker));
  for (const row of screenable) {
    if (eligibleTickers.has(row.ticker)) continue;
    const reasons = filter ? failedLimits(row, filter) : [];
    rejected.push({
      ticker: row.ticker,
      stage: "eligibility",
      reason: "hard_filter",
      detail: reasons.length > 0 ? reasons.join("; ") : GENERIC_SCREEN_FAILURE,
    });
  }

  // ── 4. Deterministic order, then the assessment cap ───────────────────────
  const ordered = [...eligible].sort((a, b) => compareDeterministic(a, b, filter?.sort));
  const deterministic: PlannedCandidate[] = ordered.map((stock, index) => ({
    ticker: stock.ticker,
    name: stock.name,
    sector: stock.sector,
    screenScore: stock.score,
    deterministicRank: index + 1,
    qualitativePriority: null,
    qualitativeNote: null,
    coverage: coverageByTicker.get(stock.ticker)!,
  }));

  const assessed = deterministic.slice(0, assessmentCeiling);
  for (const candidate of deterministic.slice(assessmentCeiling)) {
    rejected.push({
      ticker: candidate.ticker,
      stage: "assessment",
      reason: "assessment_ceiling",
      detail: `eligible, but ranked ${candidate.deterministicRank} of ${deterministic.length} and the assessment ceiling is ${assessmentCeiling}`,
    });
  }

  // ── 5. Optional qualitative prioritisation over the assessed pool ─────────
  // The prioritiser reorders the ≤40 that deterministic screening already chose,
  // so the eligible→assessed step stays fully reproducible and the provider is
  // never asked about 500 names. Which of the assessed go deep is its call.
  const { assess, ordering } = await applyPrioritizer({
    mandate,
    assessed,
    prioritizer: options.prioritizer ?? null,
  });

  const deepResearch = assess.slice(0, deepCeiling);
  for (const candidate of assess.slice(deepCeiling)) {
    rejected.push({
      ticker: candidate.ticker,
      stage: "deep_research",
      reason: "deep_research_ceiling",
      detail: `assessed, but outside the top ${deepCeiling} of ${assess.length} and so not deep-researched`,
    });
  }

  // ── 6. Status and notes ───────────────────────────────────────────────────
  const sourceFailures = dedupeGaps(gaps);
  let status: DiscoveryPlanStatus = "planned";

  if (eligible.length === 0) {
    status = "no_matches";
    notes.push(
      filter
        ? DISCOVERY_NO_MATCHES_LABEL
        : "The universe supplied to discovery held no usable rows"
    );
    if (filter) {
      notes.push(
        `The screen ran against all ${rows.length} rows and nothing qualified; relax the limit most likely to be binding rather than widening the search.`
      );
    }
  } else if (ordering.kind === "deterministic_fallback" || sourceFailures.length > 0) {
    // An incomplete input set produces a partial run. It never produces a shorter
    // list presented as a complete one, and never a fabricated stand-in.
    status = "partial";
  }

  if (ordering.kind === "deterministic_fallback" && ordering.fallbackReason) {
    notes.push(`${ordering.label} (${ordering.fallbackReason})`);
  } else if (ordering.kind === "deterministic") {
    notes.push(ordering.label);
  }
  for (const gap of sourceFailures) {
    notes.push(`${gap.source}/${gap.field}: ${gap.detail}`);
  }

  return {
    planVersion: DISCOVERY_PLAN_VERSION,
    planKey: discoveryPlanKey(mandate),
    mandate,
    status,
    universeSize: universe.length,
    eligibleCount: eligible.length,
    assess,
    deepResearch,
    highlightCeiling,
    ordering,
    rejected,
    sourceFailures,
    notes,
  };
}

/**
 * Apply the injected prioritiser, or say plainly that none did.
 *
 * Every failure path — no provider, a rejected result, a thrown error, a result
 * naming nothing we screened — lands on the deterministic order with a label. The
 * order is never partially applied and no name is ever assigned a priority the
 * provider did not give it.
 */
async function applyPrioritizer(args: {
  mandate: ResearchMandate;
  assessed: readonly PlannedCandidate[];
  prioritizer: QualitativePrioritizer | null;
}): Promise<{ assess: PlannedCandidate[]; ordering: OrderingProvenance }> {
  const { mandate, assessed, prioritizer } = args;
  const deterministicOrder = assessed.map((c) => ({ ...c }));

  if (!prioritizer) {
    return {
      assess: deterministicOrder,
      ordering: {
        kind: "deterministic",
        providerId: null,
        fallbackReason: null,
        label: DISCOVERY_DETERMINISTIC_ORDER_LABEL,
      },
    };
  }

  const fallback = (reason: string) => ({
    assess: deterministicOrder,
    ordering: {
      kind: "deterministic_fallback" as const,
      providerId: prioritizer.id,
      fallbackReason: reason,
      label: DISCOVERY_PRIORITISER_UNAVAILABLE_LABEL,
    },
  });

  if (assessed.length === 0) {
    // Nothing to prioritise is not an outage; there is simply no pool.
    return {
      assess: deterministicOrder,
      ordering: {
        kind: "deterministic",
        providerId: prioritizer.id,
        fallbackReason: null,
        label: DISCOVERY_DETERMINISTIC_ORDER_LABEL,
      },
    };
  }

  let result: QualitativePriorityResult;
  try {
    result = await prioritizer.prioritize({ mandate, candidates: assessed });
  } catch (err) {
    return fallback(err instanceof Error ? err.message : String(err));
  }
  if (result.status !== "ok") return fallback(result.reason);

  // Ranks are validated against the ASSESSED POOL, never the universe — the same
  // guard the scout applies to its picks. A provider cannot introduce a name the
  // screen excluded, and it cannot overrule a limit the user stated.
  const byTicker = new Map(assessed.map((c) => [c.ticker, c]));
  const applied = new Map<string, QualitativeRank>();
  for (const rank of result.ranks) {
    const ticker = typeof rank?.ticker === "string" ? rank.ticker.trim().toUpperCase() : "";
    if (!byTicker.has(ticker) || applied.has(ticker)) continue;
    if (typeof rank.priority !== "number" || !Number.isFinite(rank.priority)) continue;
    applied.set(ticker, rank);
  }
  if (applied.size === 0) {
    return fallback("returned no usable ranking for any assessed name");
  }

  const ranked = deterministicOrder.map((candidate) => {
    const rank = applied.get(candidate.ticker);
    if (!rank) return candidate;
    return {
      ...candidate,
      qualitativePriority: rank.priority,
      qualitativeNote: typeof rank.note === "string" && rank.note.trim() ? rank.note.trim() : null,
    };
  });

  // Unranked names keep their deterministic order and sit AFTER every ranked one.
  // Inventing a priority for them (a zero, a mean) would put a name the provider
  // never spoke about ahead of one it did.
  ranked.sort((a, b) => {
    const ap = a.qualitativePriority;
    const bp = b.qualitativePriority;
    if (ap != null && bp != null && ap !== bp) return bp - ap;
    if (ap != null && bp == null) return -1;
    if (ap == null && bp != null) return 1;
    return a.deterministicRank - b.deterministicRank;
  });

  return {
    assess: ranked,
    ordering: {
      kind: "model_prioritised",
      providerId: prioritizer.id,
      fallbackReason: null,
      label: `Ordered by fit to your request (${prioritizer.id})`,
    },
  };
}
