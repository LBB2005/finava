import { composite, FACTORS, type HorizonKey, type Stock } from "./research";

export interface Verdict {
  /** Headline stance — Constructive · Balanced · Cautious. */
  stance: "Constructive" | "Balanced" | "Cautious";
  /** The blended composite the stance is read from (0–100). */
  score: number;
  /** Confidence in the read. */
  confidence: "High" | "Moderate" | "Low";
  /** One-line natural-language take. */
  take: string;
}

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
  const confidence: Verdict["confidence"] =
    comp >= 72 || comp <= 38 ? "High" : comp >= 58 || comp <= 46 ? "Moderate" : "Low";

  // Top / bottom factor by raw sub-score, used to narrate the case.
  const sorted = [...FACTORS].sort((a, b) => f[b.key] - f[a.key]);
  const lead1 = sorted[0].label.toLowerCase();
  const lead2 = sorted[1].label.toLowerCase();
  const drag = sorted[sorted.length - 1].label.toLowerCase();

  const take =
    `${stock.name} screens ${stance.toLowerCase()} on a blended weighting. The case leans on ` +
    `${lead1} and ${lead2}; the main drag is ${drag}.`;

  return { stance, score: comp, confidence, take };
}
