/**
 * Investor DNA — deterministic derivation.
 *
 * `computeInvestorDna` is PURE: it takes the user's holdings + the scored factor
 * universe (+ optional ETF tilt profiles) and returns the model-of-you, with no
 * Firestore and no LLM. The "it knows me" read is math — every trait number is
 * real P&L from the user's own positions (`avgCost` vs. live price) crossed with
 * the factor engine.
 *
 * The thin Firestore wrappers (`deriveAndCacheDna` / `readCachedDna`) live in
 * `@/lib/investorDnaStore` so this engine stays free of infra imports and is
 * trivially unit-testable. See `@/types/dna` and the design plan for the story.
 */

import {
  FACTORS,
  type FactorKey,
  type FactorScores,
  type Stock,
} from "@/lib/research";
import type {
  InvestorDNA,
  TraitRecord,
  Tendency,
  CoverageInfo,
  LensLine,
} from "@/types/dna";

const FACTOR_KEYS = FACTORS.map((f) => f.key);
const LABEL_BY_KEY: Record<FactorKey, string> = Object.fromEntries(
  FACTORS.map((f) => [f.key, f.label])
) as Record<FactorKey, string>;

/** Matches the existing `factorClass()` "f-strong" threshold in research.ts. */
const HIGH_EXPOSURE = 67;

/** Minimal holding shape the engine needs — `Holding` satisfies it structurally. */
export interface DnaHolding {
  ticker: string;
  shares: number;
  avgCost: number;
  sector?: string | null;
}

/** Curated ETF tilt profile (no track record — ETFs shape archetype/tilt only). */
export interface EtfTilt {
  sector: string;
  f: FactorScores;
}

const signed = (n: number) => (n >= 0 ? "+" : "") + Math.round(n) + "%";
const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

/** Punctuation-insensitive ticker key so BRK.B / BRK-B / BRKB all match. */
export function normalizeTicker(t: string): string {
  return String(t).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** One position joined to a factor profile. Real stocks carry a return; ETFs don't. */
interface Contributor {
  f: FactorScores;
  sector: string;
  value: number;
  returnPct: number | null; // null = ETF tilt (excluded from the track record)
}

/** Named investor identity from the dominant factor(s). */
function archetypeFor(vector: Record<FactorKey, number>): string {
  const order = [...FACTOR_KEYS].sort((a, b) => vector[b] - vector[a]);
  const [top, second] = order;
  if ((top === "quality" && vector.health >= 60) || (top === "health" && vector.quality >= 60)) {
    return "Quality compounder";
  }
  const NAMES: Record<FactorKey, string> = {
    mom: "Momentum rider",
    growth: "Growth seeker",
    quality: "Quality compounder",
    analyst: "Consensus follower",
    value: "Bargain hunter",
    health: "Balance-sheet hawk",
  };
  if (vector[top] - vector[second] <= 8 && top !== second) {
    return `${LABEL_BY_KEY[top]}-${LABEL_BY_KEY[second]} investor`
      .toLowerCase()
      .replace(/^./, (c) => c.toUpperCase());
  }
  return NAMES[top];
}

/** Cosine similarity between two 6-factor vectors (scale-invariant). */
function cosine(a: Record<FactorKey, number>, b: FactorScores): number {
  let dot = 0, na = 0, nb = 0;
  for (const k of FACTOR_KEYS) {
    dot += a[k] * b[k];
    na += a[k] * a[k];
    nb += b[k] * b[k];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Recognisable investing styles, as factor-weight vectors. These name an
 * archetype by finding the closest style to a holder's own factor tilt — they
 * are labels for a shape, never a claim about any stock or any return.
 * Deliberately characterful so the styles stay genuinely distinct.
 */
const ARCHETYPE_PRESETS: { key: string; label: string; weights: FactorScores }[] = [
  { key: "momentum", label: "Momentum Trader", weights: { mom: 100, growth: 70, quality: 18, analyst: 80, value: 10, health: 22 } },
  { key: "value", label: "Value Investor", weights: { mom: 14, growth: 22, quality: 20, analyst: 26, value: 100, health: 30 } },
  { key: "quality", label: "Quality Compounder", weights: { mom: 42, growth: 64, quality: 100, analyst: 58, value: 24, health: 92 } },
];

function nearestPreset(vector: Record<FactorKey, number>): string {
  let best = ARCHETYPE_PRESETS[0];
  let bestSim = -Infinity;
  for (const p of ARCHETYPE_PRESETS) {
    const sim = cosine(vector, p.weights);
    if (sim > bestSim) { bestSim = sim; best = p; }
  }
  return best.label;
}

/**
 * Derive the Investor DNA from holdings + a scored universe. Real stocks drive
 * both the tilt vector and the track record; ETFs (matched via `etfProfiles`)
 * shape the tilt only. Returns `null` only when nothing at all is covered.
 */
export function computeInvestorDna(
  holdings: DnaHolding[],
  universe: Stock[],
  etfProfiles: Record<string, EtfTilt> = {},
): InvestorDNA | null {
  const byTicker = new Map(universe.map((s) => [normalizeTicker(s.ticker), s]));
  const etfByTicker = new Map(
    Object.entries(etfProfiles).map(([k, v]) => [normalizeTicker(k), v])
  );

  const stockContribs: Contributor[] = []; // real picks — have returns → track record
  const tiltContribs: Contributor[] = [];  // ETFs — tilt/archetype only
  const uncovered: string[] = [];

  for (const h of holdings) {
    if (!(h.shares > 0)) continue;
    const norm = normalizeTicker(h.ticker);

    const stock = byTicker.get(norm);
    if (stock) {
      stockContribs.push({
        f: stock.f,
        sector: stock.sector || "Unknown",
        value: h.shares * stock.price,
        returnPct: h.avgCost > 0 ? ((stock.price - h.avgCost) / h.avgCost) * 100 : 0,
      });
      continue;
    }

    const etf = etfByTicker.get(norm);
    if (etf) {
      // No live price for ETFs here, so weight by cost basis as a position-size proxy.
      tiltContribs.push({
        f: etf.f,
        sector: etf.sector,
        value: h.shares * (h.avgCost > 0 ? h.avgCost : 1),
        returnPct: null,
      });
      continue;
    }

    uncovered.push(String(h.ticker).toUpperCase());
  }

  const all = [...stockContribs, ...tiltContribs];
  const totalValue = all.reduce((sum, c) => sum + c.value, 0);
  if (all.length === 0 || totalValue <= 0) return null;

  // 1 — dnaVector: value-weighted average over every covered position (incl. ETFs).
  const dnaVector = {} as Record<FactorKey, number>;
  for (const k of FACTOR_KEYS) {
    const w = all.reduce((sum, c) => sum + c.value * c.f[k], 0);
    dnaVector[k] = Math.round(w / totalValue);
  }

  // 2 — traitRecord: real P&L on stock picks heavily exposed to each factor.
  const traitRecord: TraitRecord[] = [];
  for (const k of FACTOR_KEYS) {
    const bucket = stockContribs.filter((c) => c.f[k] >= HIGH_EXPOSURE);
    if (bucket.length === 0) continue;
    const bucketValue = bucket.reduce((sum, c) => sum + c.value, 0);
    const avgReturnPct = bucketValue > 0
      ? bucket.reduce((sum, c) => sum + c.value * (c.returnPct ?? 0), 0) / bucketValue
      : 0;
    traitRecord.push({
      factor: k,
      label: LABEL_BY_KEY[k],
      exposurePct: Math.round((bucketValue / totalValue) * 100),
      avgReturnPct: Math.round(avgReturnPct),
      hits: bucket.filter((c) => (c.returnPct ?? 0) > 0).length,
      total: bucket.length,
      sample: bucket.length < 3 ? "thin" : "real",
    });
  }
  traitRecord.sort((a, b) => b.avgReturnPct - a.avgReturnPct);

  // 3 — tendencies: sector concentration + factor tilt.
  const sectorValue = new Map<string, number>();
  for (const c of all) sectorValue.set(c.sector, (sectorValue.get(c.sector) ?? 0) + c.value);
  const [topSector, topSectorValue] = [...sectorValue.entries()].sort((a, b) => b[1] - a[1])[0];
  const concentrationPct = Math.round((topSectorValue / totalValue) * 100);

  const factorOrder = [...FACTOR_KEYS].sort((a, b) => dnaVector[b] - dnaVector[a]);
  const tiltHigh = factorOrder[0];
  const tiltLow = factorOrder[factorOrder.length - 1];

  const tendencies: Tendency[] = [
    {
      key: "concentration",
      label: "You concentrate",
      detail: `${concentrationPct}% of your holdings sit in ${topSector}.`,
    },
    {
      key: "tilt-high",
      label: "Your tilt",
      detail: `You lean heavily toward ${LABEL_BY_KEY[tiltHigh].toLowerCase()} (${dnaVector[tiltHigh]}/100).`,
    },
    {
      key: "tilt-low",
      label: "You avoid",
      detail: `You barely touch ${LABEL_BY_KEY[tiltLow].toLowerCase()} (${dnaVector[tiltLow]}/100).`,
    },
  ];

  // 4 — identity line (deterministic balanced read).
  const edge = traitRecord.find((t) => t.avgReturnPct > 0 && t.total >= 2) ?? null;
  const weak = [...traitRecord].reverse()
    .find((t) => t.avgReturnPct < 0 && t.total >= 2 && t.factor !== edge?.factor) ?? null;
  const archetype = archetypeFor(dnaVector);
  const identityLine = buildIdentityLine(archetype, concentrationPct, topSector, edge, weak);

  // 5 — knownness + coverage.
  const distinctSectors = sectorValue.size;
  const knownness = Math.round(100 * (
    0.85 * Math.min(all.length / 12, 1) +
    0.15 * Math.min(distinctSectors / 6, 1)
  ));
  const coverage: CoverageInfo = { analyzed: all.length, total: holdings.length, uncovered };

  return {
    dnaVector,
    archetype,
    matchedPreset: nearestPreset(dnaVector),
    identityLine,
    traitRecord,
    tendencies,
    knownness,
    holdingsCount: all.length,
    coverage,
    updatedAt: new Date().toISOString(),
  };
}

function buildIdentityLine(
  archetype: string,
  concentrationPct: number,
  topSector: string,
  edge: TraitRecord | null,
  weak: TraitRecord | null,
): string {
  const concAdj = concentrationPct >= 55 ? "concentrated" : concentrationPct >= 38 ? "focused" : "diversified";
  let s = `You're a ${concAdj} ${archetype.toLowerCase()}`;
  s += edge
    ? ` with a real edge in ${edge.label.toLowerCase()} names (${signed(edge.avgReturnPct)})`
    : ` — still learning where your edge is`;
  if (weak) {
    s += `, but your ${weak.label.toLowerCase()} bets have cost you (${signed(weak.avgReturnPct)}).`;
  } else if (concAdj === "concentrated") {
    s += `, with little to cushion you if ${topSector} turns.`;
  } else {
    s += `.`;
  }
  return s;
}

// ── The Lens — one personalized line for a given stock ──

/**
 * Build the Lens whisper for one stock, given the user's DNA: it compares the
 * stock's dominant factor to the user's track record. Returns `null` when
 * there's nothing personal worth saying.
 */
export function lensLineFor(
  dna: InvestorDNA | null,
  stock: Stock | null,
): LensLine | null {
  const href = "/dna";

  if (!dna || !stock) return null;

  const domFactor = [...FACTOR_KEYS].sort((a, b) => stock.f[b] - stock.f[a])[0];
  const label = LABEL_BY_KEY[domFactor].toLowerCase();
  const rec = dna.traitRecord.find((t) => t.factor === domFactor);

  if (rec && rec.avgReturnPct > 0 && rec.total >= 2) {
    return { line: `This is ${article(label)} ${label} name — your sweet spot (${signed(rec.avgReturnPct)} on these).`, tone: "edge", href };
  }
  if (rec && rec.avgReturnPct < 0 && rec.total >= 2) {
    return { line: `Heads up — ${article(label)} ${label} name, the kind that's cost you (${signed(rec.avgReturnPct)}).`, tone: "caution", href };
  }
  if (dna.dnaVector[domFactor] >= 60) {
    return { line: `This fits your tilt toward ${label}.`, tone: "neutral", href };
  }
  if (dna.dnaVector[domFactor] < 40) {
    return { line: `Outside your usual ${label} comfort zone.`, tone: "caution", href };
  }
  return null;
}
