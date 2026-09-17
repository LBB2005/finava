// The facts layer's shared vocabulary. Client-safe: type-only imports, no I/O.
//
// Every number Finava displays is a Fact: a value plus where it came from and
// when it was true. A value we could not get is `value: null` with a note that
// says why. There is no other way to build one (see fact / missing).

import type { PillarScore } from "@/lib/finavaScore";
import type { DcfInputs } from "@/lib/dcf";

export interface Fact<T> {
  value: T | null;
  unit?: string;
  source: string;
  asOf: string;
  period?: string;
  note?: string;
  /** A primary source a reader can open (a filing index, an article). */
  url?: string;
}

export interface FactMeta {
  source: string;
  asOf: string;
  unit?: string;
  period?: string;
  /** Kept on the fact whether or not it has a value (e.g. "Mean of 38 analysts"). */
  note?: string;
  /** Used only when the value turns out to be missing. */
  missingNote?: string;
  url?: string;
}

/** Bump when the score engine changes: cached docs of another version are misses. */
export const SCORE_VERSION = "finava-score-v2";
/** Bump when the DCF inputs or model change. */
export const DCF_VERSION = "dcf-v1";
/** Perpetual growth used by `computeDcf`'s default. */
export const TERMINAL_GROWTH = 0.025;

function isAbsent(v: unknown): boolean {
  return v == null || (typeof v === "number" && !Number.isFinite(v));
}

/** A fact. A null or non-finite value becomes a missing fact that keeps the source. */
export function fact<T>(value: T | null, meta: FactMeta): Fact<T> {
  if (isAbsent(value)) {
    const m = missing<T>(meta.source, meta.missingNote ?? meta.note ?? "No value returned by the source", meta.asOf);
    if (meta.url) m.url = meta.url;
    return m;
  }
  const out: Fact<T> = { value, source: meta.source, asOf: meta.asOf };
  if (meta.url) out.url = meta.url;
  if (meta.unit) out.unit = meta.unit;
  if (meta.period) out.period = meta.period;
  if (meta.note) out.note = meta.note;
  return out;
}

/** The only way to say "we don't have this": the note is required. */
export function missing<T>(source: string, note: string, asOf: string = new Date().toISOString()): Fact<T> {
  return { value: null, source, asOf, note };
}

export function hasValue<T>(f: Fact<T> | null | undefined): f is Fact<T> & { value: T } {
  return !!f && f.value != null;
}

export interface ScoreFact {
  total: number;
  grade: string;
  pillars: PillarScore[];
  confidence: "Low" | "Moderate" | "High";
  coverage: number;
  /** Average P/E & P/S premium vs the peer median, in percent. */
  peerPremiumPct: number | null;
  version: string;
}

export interface DcfFact {
  fairValue: number;
  wacc: number;
  growth: number;
  terminal: number;
  inputs: DcfInputs;
  version: string;
}

export type SlimScore = Pick<ScoreFact, "total" | "grade" | "version">;

export interface TickerFacts {
  ticker: string;
  price: Fact<number>;
  change1d: Fact<number>;
  marketCap: Fact<number>;
  sharesOut: Fact<number>;
  pe: Fact<number>;
  evEbitda: Fact<number>;
  epsTTM: Fact<number>;
  range52w: Fact<{ low: number; high: number }>;
  revenueTTM: Fact<number>;
  netIncomeTTM: Fact<number>;
  fcfTTM: Fact<number>;
  cashAndSTI: Fact<number>;
  debt: Fact<number>;
  beta: Fact<number>;
  dividendYield: Fact<number>;
  nextEarnings: Fact<{ date: string; estimated: boolean; epsEst?: number }>;
  streetTarget: Fact<number>;
  score: Fact<ScoreFact>;
  dcf: Fact<DcfFact>;
  /** Sources that failed or missed the deadline this read. */
  dropped: string[];
}

export interface TickerFactsSlim {
  ticker: string;
  score: Fact<SlimScore>;
}

export function toSlim(f: Pick<TickerFacts, "ticker" | "score">): TickerFactsSlim {
  const s = f.score;
  if (!hasValue(s)) return { ticker: f.ticker, score: s as Fact<SlimScore> };
  const { value, ...meta } = s;
  return { ticker: f.ticker, score: { ...meta, value: { total: value.total, grade: value.grade, version: value.version } } };
}

export interface HoldingFact {
  ticker: string;
  shares: number;
  price: Fact<number>;
  marketValue: Fact<number>;
  /** Fraction of totalValue (0.153 = 15.3%). */
  weight: Fact<number>;
  /** Average cost per share. */
  costBasis: Fact<number>;
  score: Fact<SlimScore>;
}

export interface PortfolioFacts {
  holdings: HoldingFact[];
  totalValue: Fact<number>;
  cash: Fact<number>;
  /** Sum of holding weights + cash weight; 1 whenever totalValue > 0. */
  weightsSum: number;
}
