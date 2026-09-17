/**
 * Investor DNA — deterministic derivation.
 *
 * `computeInvestorDna` is PURE: it takes the user's holdings + the scored factor
 * universe (+ optional ETF tilt profiles) and returns the model-of-you, with no
 * Firestore and no LLM. The "it knows me" read is math — every trait number is
 * real P&L from the user's own positions (`avgCost` vs. live price) crossed with
 * the factor engine.
 *
 * Honesty rules (beta readout, W4-2):
 * - Returns are compared with SPY (and the sector ETF where mapped) over each
 *   position's own holding window. Excess, not raw, is what a trait shows.
 * - Traits are bucketed on factors as of the entry date when those exist.
 *   Today's factors applied to an old purchase are look-ahead, so a trait built
 *   on them is labelled and never claims an edge.
 * - "Edge" passes `EDGE_GATE` or it isn't said.
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
  BenchmarkSummary,
  InvestorDNA,
  TraitRecord,
  TraitVerdict,
  Tendency,
  CoverageInfo,
  LensLine,
} from "@/types/dna";

/** Bump when the snapshot shape changes; older cached snapshots are recomputed. */
export const DNA_VERSION = 2;

/**
 * The significance gate. A trait is only called an edge (or a blind spot) with
 * at least `minPositions` benchmarked positions, a median holding window of at
 * least `minMonths`, and a value-weighted excess return vs SPY of at least
 * `minExcessPts` percentage points either way. Deliberately simple: this is a
 * "don't say it on a handful of trades" floor, not a statistical test.
 */
export const EDGE_GATE = { minPositions: 8, minMonths: 6, minExcessPts: 5 } as const;

const DAY_MS = 86_400_000;
const MONTH_DAYS = 30.44;

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
  /** When the holding entered Finava. The fallback start of its holding window. */
  createdAt?: string;
  /** The real purchase date, when a source provides one. */
  acquiredAt?: string;
}

/**
 * One position's holding window, resolved by the store from price history.
 * Every number here is measured; `null` means it couldn't be.
 */
export interface PositionHistory {
  /** ISO start of the window. */
  windowStart: string;
  /** "purchase" = real purchase date; "added" = the day it was added to Finava. */
  basis: "purchase" | "added";
  /** The position's own return over the window. */
  returnPct: number | null;
  spyReturnPct: number | null;
  sectorEtf: string | null;
  sectorReturnPct: number | null;
  /** Factor scores as of `windowStart`; null when no point-in-time factors exist. */
  entryFactors: FactorScores | null;
}

export interface DnaOptions {
  /** Keyed by ticker (any symbology; normalized on lookup). */
  history?: Record<string, PositionHistory>;
  now?: Date;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Whole months, with "under a month" instead of "0 months". */
export const monthsLabel = (m: number) => (Math.round(m) < 1 ? "under a month" : plural(Math.round(m), "month"));
const pts = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n))} pts`;

/** The significance gate for one trait. Pure; see `EDGE_GATE`. */
export function gateTrait(input: {
  positions: number;
  months: number | null;
  excessPct: number | null;
  pointInTime: boolean;
}): { verdict: TraitVerdict; line: string } {
  const { positions, months, excessPct, pointInTime } = input;
  if (excessPct === null || positions === 0 || months === null) {
    return { verdict: "unbenchmarked", line: "Benchmark unavailable — no price history for these positions." };
  }
  if (positions < EDGE_GATE.minPositions || months < EDGE_GATE.minMonths) {
    return {
      verdict: "too-early",
      line: `Too early to tell — ${plural(positions, "position")}, ${monthsLabel(months)}.`,
    };
  }
  if (!pointInTime) {
    return {
      verdict: "not-point-in-time",
      line: `${pts(excessPct)} vs SPY, based on current factors (not point-in-time) — no edge claim.`,
    };
  }
  const span = `across ${plural(positions, "position")}, ${monthsLabel(months)}`;
  if (excessPct >= EDGE_GATE.minExcessPts) return { verdict: "edge", line: `Edge: ${pts(excessPct)} vs SPY ${span}.` };
  if (excessPct <= -EDGE_GATE.minExcessPts) return { verdict: "blind-spot", line: `Lagging: ${pts(excessPct)} vs SPY ${span}.` };
  return { verdict: "no-clear-edge", line: `No clear edge: ${pts(excessPct)} vs SPY, within ±${EDGE_GATE.minExcessPts}.` };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const a = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Value-weighted mean of `pick` over contributors where it's measured; null when none are. */
function weighted(cs: Contributor[], pick: (c: Contributor) => number | null): number | null {
  let w = 0, sum = 0;
  for (const c of cs) {
    const v = pick(c);
    if (v === null || !Number.isFinite(v)) continue;
    w += c.value;
    sum += c.value * v;
  }
  return w > 0 ? sum / w : null;
}

const excessSpy = (c: Contributor) =>
  c.hist && c.hist.returnPct !== null && c.hist.spyReturnPct !== null ? c.hist.returnPct - c.hist.spyReturnPct : null;
const excessSector = (c: Contributor) =>
  c.hist && c.hist.returnPct !== null && c.hist.sectorReturnPct !== null ? c.hist.returnPct - c.hist.sectorReturnPct : null;
const roundOrNull = (n: number | null) => (n === null ? null : Math.round(n));

/** Curated ETF tilt profile (no track record — ETFs shape archetype/tilt only). */
export interface EtfTilt {
  sector: string;
  f: FactorScores;
}

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
  hist?: PositionHistory;
  /** Months since the window start; null when there's no window. */
  months?: number | null;
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
  options: DnaOptions = {},
): InvestorDNA | null {
  const now = options.now ?? new Date();
  const historyByTicker = new Map(
    Object.entries(options.history ?? {}).map(([k, v]) => [normalizeTicker(k), v])
  );
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
      const hist = historyByTicker.get(norm);
      const startMs = hist ? Date.parse(hist.windowStart) : NaN;
      stockContribs.push({
        f: stock.f,
        sector: stock.sector || "Unknown",
        value: h.shares * stock.price,
        returnPct: h.avgCost > 0 ? ((stock.price - h.avgCost) / h.avgCost) * 100 : 0,
        hist,
        months: Number.isFinite(startMs) ? (now.getTime() - startMs) / DAY_MS / MONTH_DAYS : null,
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

  // 2 — traitRecord: each factor's bucket, benchmarked and gated. Bucket on
  // entry-date factors when a position has them; otherwise today's, flagged.
  const traitRecord: TraitRecord[] = [];
  for (const k of FACTOR_KEYS) {
    const bucket = stockContribs.filter((c) => (c.hist?.entryFactors ?? c.f)[k] >= HIGH_EXPOSURE);
    if (bucket.length === 0) continue;
    const bucketValue = bucket.reduce((sum, c) => sum + c.value, 0);
    const avgReturnPct = weighted(bucket, (c) => c.returnPct) ?? 0;
    const benched = bucket.filter((c) => excessSpy(c) !== null);
    const excessVsSpyPct = weighted(benched, excessSpy);
    const months = median(benched.map((c) => c.months).filter((m): m is number => m != null));
    const pointInTime = bucket.every((c) => !!c.hist?.entryFactors);
    const gate = gateTrait({ positions: benched.length, months, excessPct: excessVsSpyPct, pointInTime });
    traitRecord.push({
      factor: k,
      label: LABEL_BY_KEY[k],
      exposurePct: Math.round((bucketValue / totalValue) * 100),
      avgReturnPct: Math.round(avgReturnPct),
      hits: bucket.filter((c) => (c.returnPct ?? 0) > 0).length,
      total: bucket.length,
      sample: bucket.length < 3 ? "thin" : "real",
      excessVsSpyPct: roundOrNull(excessVsSpyPct),
      excessVsSectorPct: roundOrNull(weighted(benched, excessSector)),
      benchmarked: benched.length,
      beatBenchmark: benched.filter((c) => (excessSpy(c) ?? 0) > 0).length,
      months: roundOrNull(months),
      pointInTime,
      verdict: gate.verdict,
      verdictLine: gate.line,
    });
  }
  traitRecord.sort((a, b) =>
    (b.excessVsSpyPct ?? -Infinity) - (a.excessVsSpyPct ?? -Infinity) || b.exposurePct - a.exposurePct
  );

  const benchedAll = stockContribs.filter((c) => excessSpy(c) !== null);
  const bases = new Set(benchedAll.map((c) => c.hist!.basis));
  const benchmark: BenchmarkSummary = {
    excessVsSpyPct: roundOrNull(weighted(benchedAll, excessSpy)),
    excessVsSectorPct: roundOrNull(weighted(benchedAll, excessSector)),
    benchmarked: benchedAll.length,
    total: stockContribs.length,
    beatSpy: benchedAll.filter((c) => (excessSpy(c) ?? 0) > 0).length,
    typicalHoldingMonths: roundOrNull(median(benchedAll.map((c) => c.months).filter((m): m is number => m != null))),
    basis: bases.size === 0 ? null : bases.size > 1 ? "mixed" : [...bases][0],
  };

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
  const edge = traitRecord.find((t) => t.verdict === "edge") ?? null;
  const weak = [...traitRecord].reverse().find((t) => t.verdict === "blind-spot") ?? null;
  const archetype = archetypeFor(dnaVector);
  const identityLine = buildIdentityLine(archetype, concentrationPct, topSector, edge, weak, benchmark);

  // 5 — knownness + coverage.
  const distinctSectors = sectorValue.size;
  const knownness = Math.round(100 * (
    0.85 * Math.min(all.length / 12, 1) +
    0.15 * Math.min(distinctSectors / 6, 1)
  ));
  const coverage: CoverageInfo = { analyzed: all.length, total: holdings.length, uncovered };

  return {
    version: DNA_VERSION,
    dnaVector,
    archetype,
    matchedPreset: nearestPreset(dnaVector),
    identityLine,
    traitRecord,
    benchmark,
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
  benchmark: BenchmarkSummary,
): string {
  const concAdj = concentrationPct >= 55 ? "concentrated" : concentrationPct >= 38 ? "focused" : "diversified";
  let s = `Your holdings read like a ${concAdj} ${archetype.toLowerCase()}`;
  if (edge) {
    s += ` with an edge in ${edge.label.toLowerCase()} names (${pts(edge.excessVsSpyPct!)} vs SPY)`;
  } else if (benchmark.benchmarked === 0) {
    s += ` — returns aren't benchmarked yet, so no edge is claimed`;
  } else {
    const months = benchmark.typicalHoldingMonths ?? 0;
    s += ` — too early to call an edge (${plural(benchmark.benchmarked, "position")}, typically held ${monthsLabel(months)})`;
  }
  if (weak) {
    s += `, but your ${weak.label.toLowerCase()} names have lagged SPY (${pts(weak.excessVsSpyPct!)}).`;
  } else if (concAdj === "concentrated") {
    s += `, with little to cushion you if ${topSector} turns.`;
  } else {
    s += `.`;
  }
  return s;
}

/**
 * The compact DNA block chat and the crew receive. Plain text, labelled as
 * inferred, carrying the gate's own sentences so the model can't upgrade a
 * "too early" into an edge. Tolerates snapshots missing newer fields.
 */
export function buildDnaSummary(dna: InvestorDNA): string {
  const tilt = FACTOR_KEYS.map((k) => `${LABEL_BY_KEY[k]} ${dna.dnaVector[k]}`).join(", ");
  const concentration = dna.tendencies.find((t) => t.key === "concentration")?.detail
    .replace(/^(\d+)% of your holdings sit in (.+)\.$/, "$1% in $2") ?? "Unavailable";
  const b = dna.benchmark;
  const basisLabel = b?.basis === "purchase" ? "since purchase" : b?.basis === "added" ? "since added to Finava" : "mix of purchase dates and dates added to Finava";
  const holding = b?.typicalHoldingMonths != null
    ? `${monthsLabel(b.typicalHoldingMonths)} (${basisLabel})`
    : "Unavailable";
  const result = b && b.excessVsSpyPct !== null
    ? `${pts(b.excessVsSpyPct)} vs SPY over each position's own holding window (${b.benchmarked} of ${b.total} positions benchmarked, ${b.beatSpy} beat SPY)` +
      (b.excessVsSectorPct !== null ? `; ${pts(b.excessVsSectorPct)} vs sector ETFs` : "")
    : "Unavailable";
  const traits = dna.traitRecord.length
    ? dna.traitRecord.map((t) => `- ${t.label} (${t.exposurePct}% of book): ${t.verdictLine ?? "Unavailable"}`).join("\n")
    : "- None with enough exposure to read.";

  return [
    "## Investor DNA (inferred from your holdings; the user did not state any of this)",
    `Style: ${dna.archetype}. Factor tilt (0-100): ${tilt}.`,
    `Concentration: ${concentration}.`,
    `Typical holding period: ${holding}.`,
    `Benchmarked result: ${result}.`,
    "Traits:",
    traits,
    `Rules: refer to this as "based on your holdings". Only call something an edge where a trait line starts with "Edge:". Where it says too early, not point-in-time, or unavailable, say so plainly. Never present this as the user's stated goals or risk tolerance.`,
  ].join("\n");
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

  if (rec?.verdict === "edge" && rec.excessVsSpyPct !== null) {
    return { line: `This is ${article(label)} ${label} name — your ${label} names are ${pts(rec.excessVsSpyPct)} vs SPY.`, tone: "edge", href };
  }
  if (rec?.verdict === "blind-spot" && rec.excessVsSpyPct !== null) {
    return { line: `Heads up — ${article(label)} ${label} name; yours are ${pts(rec.excessVsSpyPct)} vs SPY.`, tone: "caution", href };
  }
  if (dna.dnaVector[domFactor] >= 60) {
    return { line: `This fits your tilt toward ${label}.`, tone: "neutral", href };
  }
  if (dna.dnaVector[domFactor] < 40) {
    return { line: `Outside your usual ${label} comfort zone.`, tone: "caution", href };
  }
  return null;
}
