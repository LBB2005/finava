import type { FactorKey } from "@/lib/research";

/**
 * Investor DNA — the derived, persistent model of who a user is as an investor.
 *
 * It is computed deterministically from the user's holdings (their real money)
 * crossed with the factor engine (`@/lib/research` + `@/lib/factorUniverse`).
 * No LLM is on the critical path: the "it knows me" read is math, not a guess.
 * See `@/lib/investorDna` for the derivation and `docs`/the design plan for the
 * product rationale.
 */

/** A user's real track record on holdings heavily exposed to one factor. */
export interface TraitRecord {
  factor: FactorKey;
  /** Human label from `FACTORS` (e.g. "Momentum"). */
  label: string;
  /** Share of portfolio value (%) sitting in holdings with high exposure to this factor. */
  exposurePct: number;
  /** Value-weighted return (%) of those holdings — real P&L from `avgCost` vs. live price. */
  avgReturnPct: number;
  /** How many of those holdings are in the green. */
  hits: number;
  /** How many holdings are in the bucket. */
  total: number;
  /** "thin" when `total < 3` — render muted, never as a confident edge. */
  sample: "real" | "thin";
  /** Value-weighted return minus SPY over each position's own holding window; null = unbenchmarked. */
  excessVsSpyPct: number | null;
  /** Same, against the position's sector ETF where one is mapped; null when none. */
  excessVsSectorPct: number | null;
  /** Positions in the bucket with a measured SPY comparison. */
  benchmarked: number;
  /** Of those, how many beat SPY over their window. */
  beatBenchmark: number;
  /** Median holding window (months) of the benchmarked positions; null when none. */
  months: number | null;
  /** True only when every position was bucketed on factors as of its entry date. */
  pointInTime: boolean;
  /** Outcome of the significance gate (see `EDGE_GATE` in `@/lib/investorDna`). */
  verdict: TraitVerdict;
  /** The one honest sentence for this verdict, e.g. "Too early to tell — 3 positions, 2 months." */
  verdictLine: string;
}

export type TraitVerdict =
  | "edge"
  | "blind-spot"
  | "no-clear-edge"
  | "too-early"
  | "not-point-in-time"
  | "unbenchmarked";

/** Whole-book result against the benchmark, over each position's own window. */
export interface BenchmarkSummary {
  excessVsSpyPct: number | null;
  excessVsSectorPct: number | null;
  benchmarked: number;
  total: number;
  beatSpy: number;
  typicalHoldingMonths: number | null;
  /** Where the windows start: the real purchase date, the day the holding was added to Finava, or both. */
  basis: "purchase" | "added" | "mixed" | null;
}

/** A behavioural read derived from the portfolio (concentration, factor tilt). */
export interface Tendency {
  key: string;
  label: string;
  detail: string;
}

/** How much of the portfolio the DNA could actually read. */
export interface CoverageInfo {
  /** Positions matched to the universe or an ETF profile. */
  analyzed: number;
  /** Total holdings considered. */
  total: number;
  /** Tickers we couldn't cover yet (non-S&P, crypto, bonds, etc.). */
  uncovered: string[];
}

/** The full derived model, cached at `users/{uid}/investorDNA/current`. */
export interface InvestorDNA {
  /** Shape version; cached snapshots from an older shape are recomputed. */
  version: number;
  /** Each factor 0–100: market-value-weighted average of holdings' factor scores. */
  dnaVector: Record<FactorKey, number>;
  /** Named identity from the top factors, e.g. "Quality compounder". */
  archetype: string;
  /** Nearest archetype label, e.g. "Quality Compounder". */
  matchedPreset: string;
  /** The balanced-read editorial sentence (deterministic template). */
  identityLine: string;
  /** Per-factor track record, sorted by excess return vs SPY (unbenchmarked last). */
  traitRecord: TraitRecord[];
  /** The whole book against SPY. */
  benchmark: BenchmarkSummary;
  /** Concentration + factor tilt reads. */
  tendencies: Tendency[];
  /** 0–100 "how well I know you" — scales with holdings + sector spread. */
  knownness: number;
  holdingsCount: number;
  /** What fraction of the portfolio the DNA could read, and what it couldn't. */
  coverage: CoverageInfo;
  updatedAt: string;
}

/** The personalized one-liner the Lens renders on a stock page. */
export type LensTone = "edge" | "caution" | "neutral";
export interface LensLine {
  line: string;
  tone: LensTone;
  href: string;
}
