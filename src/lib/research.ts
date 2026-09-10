/* ============================================================
   Finava · Research — scoring engine + seed universe
   ------------------------------------------------------------
   The Finava Score is a 0–100 composite of six factor sub-scores,
   re-weighted per holding horizon. Same engine, three weightings:
   a stock can grade A for the year but C for the week.

   This module is the engine only — it holds no rows of its own. The
   scored universe is computed from real market data in `factors.ts`
   and served by /api/research/factors; the ticker directory lives in
   `sp500.ts` + `extraUniverse.ts`. Nothing here fabricates a number.
   ============================================================ */

import type { SourceStatus } from "@/lib/fetchRetry";
import { assessMarketCapConsistency, type QuoteWarning } from "@/lib/quoteSanity";

export type FactorKey = "mom" | "growth" | "quality" | "analyst" | "value" | "health";

export interface Factor {
  key: FactorKey;
  label: string;
  short: string;
  full: string;
}

export type FactorScores = Record<FactorKey, number>;

export type HorizonKey = "week" | "month" | "year";

export interface Horizon {
  key: HorizonKey;
  label: string;
  sub: string;
  tag: string;
}

export interface Stock {
  ticker: string;
  name: string;
  sector: string;
  /** Last price. */
  price: number;
  /** Today's % move. */
  chg: number;
  /** Six factor sub-scores, each 0–100. */
  f: FactorScores;
  /** Actual realised price move (%) over each window — backward-looking. */
  mv: Record<HorizonKey, number>;
  // ── Live market data, overlaid by `overlayLive` from /api/leaderboard. ──
  //    Undefined before the feed loads; null when a source has no value for
  //    this ticker (render as "—", never as a fabricated number).
  /** Market capitalisation in USD (absolute, not millions). */
  marketCap?: number | null;
  /** Trailing-twelve-month price/earnings ratio. */
  pe?: number | null;
  /** 10-day average daily share volume (absolute shares, consolidated). */
  avgVol?: number | null;
  /** Relative volume: latest session volume ÷ 10-day average (1.4 = 140%). */
  rvol?: number | null;
  /** True once a live quote has been applied (so the UI can stop showing a loading state). */
  live?: boolean;
  /**
   * Provenance of the fundamentals behind `f`: "ok" = scored from real filings,
   * "unavailable" = no filings on record, "failed" = the data source couldn't be
   * reached so the factor scores are a neutral placeholder rather than a real
   * reading. Undefined on overlay rows that never fetched fundamentals.
   */
  fundStatus?: SourceStatus;
  /**
   * Data-integrity flags for the live quote (e.g. price inconsistent with market
   * cap, or a stale timestamp). Attached by `overlayLive`. Absent/empty when the
   * quote looks trustworthy. The UI shows a caution marker rather than hiding the
   * number, so a bad feed value is never silently displayed as fact.
   */
  warnings?: QuoteWarning[];
}

/** Live market-data overlay for one ticker, as returned by /api/leaderboard. */
export interface LiveRow {
  ticker: string;
  price: number | null;
  changePct: number | null;
  marketCap: number | null; // absolute USD
  pe: number | null;
  avgVol: number | null; // absolute shares
  rvol: number | null;
  /**
   * Shares outstanding (absolute), used only to sanity-check the price against the
   * reported market cap. Derived server-side; null when it can't be established, in
   * which case the consistency check is skipped rather than guessed.
   */
  sharesOutstanding?: number | null;
}

export interface RankedStock extends Stock {
  score: number;
  grade: string;
  rank: number;
}

// Six factor dimensions (each scored 0–100 per stock).
export const FACTORS: Factor[] = [
  { key: "mom", label: "Momentum", short: "MOM", full: "Momentum & Technicals" },
  { key: "growth", label: "Growth", short: "GRW", full: "Growth" },
  { key: "quality", label: "Quality", short: "QAL", full: "Profitability & Quality" },
  { key: "analyst", label: "Analyst", short: "ANL", full: "Analyst Sentiment" },
  { key: "value", label: "Valuation", short: "VAL", full: "Valuation" },
  { key: "health", label: "Health", short: "FIN", full: "Financial Health & Risk" },
];

// Horizon weightings (each sums to 1.0).
export const WEIGHTS: Record<HorizonKey, FactorScores> = {
  week: { mom: 0.4, analyst: 0.22, growth: 0.1, quality: 0.08, health: 0.1, value: 0.1 },
  month: { mom: 0.2, growth: 0.2, quality: 0.16, analyst: 0.18, value: 0.12, health: 0.14 },
  year: { mom: 0.08, growth: 0.24, quality: 0.22, analyst: 0.1, value: 0.18, health: 0.18 },
};

export const HORIZONS: Horizon[] = [
  { key: "week", label: "This Week", sub: "Short-term · momentum-led", tag: "1W" },
  { key: "month", label: "This Month", sub: "Medium-term · blended", tag: "1M" },
  { key: "year", label: "This Year", sub: "Long-term · fundamentals-led", tag: "1Y" },
];

// ── Scoring engine ──
export function composite(stock: Stock, horizon: HorizonKey): number {
  const w = WEIGHTS[horizon];
  let s = 0;
  for (const k in w) s += w[k as FactorKey] * stock.f[k as FactorKey];
  return Math.round(s);
}

export function grade(score: number): string {
  if (score >= 90) return "A+";
  if (score >= 85) return "A";
  if (score >= 80) return "A-";
  if (score >= 75) return "B+";
  if (score >= 70) return "B";
  if (score >= 65) return "B-";
  if (score >= 60) return "C+";
  if (score >= 55) return "C";
  if (score >= 50) return "C-";
  if (score >= 45) return "D+";
  if (score >= 40) return "D";
  return "F";
}

export function gradeClass(g: string): string {
  const c = g[0];
  return c === "A" ? "grade-a" : c === "B" ? "grade-b" : c === "C" ? "grade-c" : c === "D" ? "grade-d" : "grade-f";
}

// Factor strength buckets — green strong / amber neutral / red weak.
export function factorClass(v: number): string {
  return v >= 67 ? "f-strong" : v >= 40 ? "f-neutral" : "f-weak";
}

export function factorColor(v: number): string {
  return v >= 67 ? "var(--color-bull)" : v >= 40 ? "var(--color-warn)" : "var(--color-bear)";
}

// Full ranked list for a horizon (desc by composite). The universe is always
// passed in — there is no default, so a caller can never silently rank a
// stand-in list. Scores come from the factor sub-scores, which the live
// overlay never touches.
export function ranked(horizon: HorizonKey, universe: Stock[]): RankedStock[] {
  return universe.map((s) => {
    const score = composite(s, horizon);
    return { ...s, score, grade: grade(score) };
  })
    .sort((a, b) => b.score - a.score)
    .map((s, i) => ({ ...s, rank: i + 1 }));
}

// ── Live overlay ──
// Merge a map of live market data onto a scored universe. Returns a NEW array
// (never mutates the input) so React sees a fresh reference. Price/chg keep the
// scored row's own values until the live row arrives; the fundamental columns
// stay `null` (→ "—") until populated. `live` flips true once a real price
// applies.
export function overlayLive(
  universe: Stock[],
  live: Map<string, LiveRow> | null | undefined
): Stock[] {
  if (!live || live.size === 0) return universe;
  return universe.map((s) => {
    const l = live.get(s.ticker);
    if (!l) return s;
    // Sanity-check the *live* price only. A non-empty array makes the UI show a
    // caution marker.
    const warnings: QuoteWarning[] = [];
    const mismatch = assessMarketCapConsistency(l.price, l.marketCap, l.sharesOutstanding);
    if (mismatch) warnings.push(mismatch);
    return {
      ...s,
      price: l.price ?? s.price,
      chg: l.changePct ?? s.chg,
      marketCap: l.marketCap,
      pe: l.pe,
      avgVol: l.avgVol,
      rvol: l.rvol,
      live: l.price != null,
      warnings,
    };
  });
}

// ── Formatting helpers ──
export const fmtPrice = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtPct = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
export const fmtPct1 = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(1) + "%";

/** Compact market cap: $5.11T, $612.3B, $84.6M. Null → "—". */
export function fmtMktCap(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  return "$" + n.toLocaleString("en-US");
}

/** Compact share volume: 181.3M, 4.2M, 850.0K. Null → "—". */
export function fmtVol(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

/** P/E to one decimal. Negative (loss-making) or missing → "—". */
export function fmtPE(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  return n.toFixed(1);
}

/** Relative volume as a multiple: 1.4×, 0.8×. Null → "—". */
export function fmtRvol(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  return n.toFixed(2) + "×";
}
