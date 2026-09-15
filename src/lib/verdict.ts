import { composite, FACTORS, grade, type HorizonKey, type RankedStock, type Stock } from "./research";
import { isMarketOpen, asOfLastCloseLabel } from "./marketSession";

export interface Verdict {
  /** Headline stance — Constructive · Balanced · Cautious. */
  stance: "Constructive" | "Balanced" | "Cautious";
  /** The blended composite the stance is read from (0–100). */
  score: number;
  /**
   * How far the composite sits from neutral (50). Deliberately NOT called
   * "confidence": it is not a probability that the read is right.
   */
  signalStrength: "Strong" | "Moderate" | "Weak";
  /** One-line natural-language take. */
  take: string;
}

/** Tooltip copy for the signal-strength indicator. */
export const SIGNAL_STRENGTH_HELP =
  "Signal strength is the blended factor score's distance from neutral (50). It is not a probability or a forecast.";

/**
 * Rule-based factor read: a stance, the blended composite it comes from, and a
 * one-line summary of which sub-scores drive it. This is arithmetic over the
 * six factor sub-scores, not a model output and not a valuation — so it never
 * states a price target. Intrinsic value belongs to the DCF on the stock page,
 * which is computed from filings.
 */
export function verdictFor(stock: Stock, horizon: HorizonKey = "month"): Verdict {
  const f = stock.f;

  const comp = composite(stock, horizon);
  const stance: Verdict["stance"] = comp >= 62 ? "Constructive" : comp <= 44 ? "Cautious" : "Balanced";
  const signalStrength: Verdict["signalStrength"] =
    comp >= 72 || comp <= 38 ? "Strong" : comp >= 58 || comp <= 46 ? "Moderate" : "Weak";

  // Top / bottom factor by raw sub-score, used to narrate the case.
  const sorted = [...FACTORS].sort((a, b) => f[b.key] - f[a.key]);
  const lead1 = sorted[0].label.toLowerCase();
  const lead2 = sorted[1].label.toLowerCase();
  const drag = sorted[sorted.length - 1].label.toLowerCase();

  const take =
    `${stock.name} screens ${stance.toLowerCase()} on a blended weighting. The case leans on ` +
    `${lead1} and ${lead2}; the main drag is ${drag}.`;

  return { stance, score: comp, signalStrength, take };
}

/**
 * Whether a name's factor profile is a real reading. The factor engine falls
 * back to a neutral 50 when inputs are missing, so a failed/absent filing leaves
 * four of six factors as placeholders, and an all-50 profile means nothing was
 * measured at all. Neither may be ranked as if it were data.
 */
export function hasEnoughData(stock: Stock): boolean {
  if (stock.fundStatus === "failed" || stock.fundStatus === "unavailable") return false;
  return FACTORS.some((fx) => stock.f[fx.key] !== 50);
}

/** The board ranking with insufficient-data names held out (never ranked). */
export function boardRanking(
  horizon: HorizonKey,
  universe: Stock[]
): { ranked: RankedStock[]; notEnoughData: Stock[] } {
  const scored: Array<Stock & { score: number; grade: string }> = [];
  const notEnoughData: Stock[] = [];
  for (const s of universe) {
    if (!hasEnoughData(s)) {
      notEnoughData.push(s);
      continue;
    }
    const score = composite(s, horizon);
    scored.push({ ...s, score, grade: grade(score) });
  }
  const ranked = scored
    .sort((a, b) => b.score - a.score)
    .map((s, i) => ({ ...s, rank: i + 1 }));
  return { ranked, notEnoughData };
}

/** Hero eyebrow — the highest score on the board, not a recommendation. */
export function heroTag(horizonTag: string): string {
  return `${horizonTag} · HIGHEST SCORE`;
}

/** Suffix for the day's price move: "today" only while the session is open. */
export function priceMoveLabel(now: Date = new Date()): string {
  return isMarketOpen(now) ? "today" : asOfLastCloseLabel(now);
}

/** Leaderboard status pill: SYNCING → LIVE (open) or "As of <last close>". */
export function boardStatusLabel(loading: boolean, now: Date = new Date()): string {
  if (loading) return "SYNCING";
  return isMarketOpen(now) ? "LIVE" : asOfLastCloseLabel(now);
}
