/**
 * Server-side sanitising for the Discover continuation payloads that arrive on
 * POST /api/agent as `wave`.
 *
 * Both shapes are built by the client from earlier responses, so the server
 * must treat every field as attacker-controlled. They used to be cast straight
 * through, which let a signed-in user:
 *   - send a synthesis request with unbounded query / pick / evidence strings,
 *     turning the 24K-output Sonnet pass into a free, huge-prompt completion API;
 *   - crash synthesis mid-way with a malformed evidence map (null valuation);
 *   - pick (and repeat) the crew members a wave runs via `agents`.
 * These functions clamp every field to what the real funnel produces and return
 * null for anything that isn't a usable request.
 */

import { isValidTicker } from "@/lib/tickers";
import {
  VALUATION_PER_WAVE,
  WAVE_SIZE,
  type ConvictionTier,
  type DiscoverEvidence,
  type ScoutPick,
  type SynthesizeRequest,
  type WaveEvidence,
  type WaveRequest,
} from "@/lib/scoutTypes";
import type { FactorScores } from "@/lib/research";

export const SYNTH_LIMITS = {
  query: 1_000,
  picks: 30,
  name: 120,
  sector: 60,
  reason: 300,
  grade: 4,
  waves: 10,
  agentsPerBlock: 12,
  valuationTickers: 30,
  agentName: 40,
  /** One sub-agent output. Synthesis shows ≤600 chars; the skeptic reads more. */
  output: 12_000,
  /** All evidence text combined — a real deep run is well under half of this. */
  evidenceTotal: 400_000,
} as const;

const CONVICTIONS: ReadonlySet<string> = new Set(["high", "look", "wildcard"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function int(v: unknown, min: number, max: number): number | null {
  const n = finite(v);
  if (n === null || !Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function ticker(v: unknown): string | null {
  const t = typeof v === "string" ? v.trim().toUpperCase() : "";
  return isValidTicker(t) ? t : null;
}

function tickers(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const t = ticker(item);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * One agent-name → output map, bounded in entries and characters. `budget` is
 * the shared evidence allowance, debited as text is kept.
 */
function outputs(v: unknown, budget: { left: number }): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(v)) return out;
  for (const [k, text] of Object.entries(v).slice(0, SYNTH_LIMITS.agentsPerBlock)) {
    if (typeof text !== "string" || budget.left <= 0) continue;
    const kept = text.slice(0, Math.min(SYNTH_LIMITS.output, budget.left));
    budget.left -= kept.length;
    out[k.slice(0, SYNTH_LIMITS.agentName)] = kept;
  }
  return out;
}

function valuationMap(v: unknown, budget: { left: number }): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (!isRecord(v)) return out;
  for (const [k, byAgent] of Object.entries(v).slice(0, SYNTH_LIMITS.valuationTickers)) {
    const t = ticker(k);
    if (t) out[t] = outputs(byAgent, budget);
  }
  return out;
}

function pick(v: unknown): ScoutPick | null {
  if (!isRecord(v)) return null;
  const t = ticker(v.ticker);
  if (!t) return null;
  const f: Record<string, number> = {};
  if (isRecord(v.f)) {
    for (const [k, n] of Object.entries(v.f).slice(0, 12)) {
      const num = finite(n);
      if (num !== null) f[k.slice(0, 20)] = num;
    }
  }
  const conviction = typeof v.conviction === "string" && CONVICTIONS.has(v.conviction)
    ? (v.conviction as ConvictionTier)
    : undefined;
  const marketCap = finite(v.marketCap);
  const pe = finite(v.pe);
  const price = finite(v.price);
  return {
    ticker: t,
    name: str(v.name, SYNTH_LIMITS.name),
    sector: str(v.sector, SYNTH_LIMITS.sector),
    score: finite(v.score) ?? 0,
    grade: str(v.grade, SYNTH_LIMITS.grade),
    fitRank: int(v.fitRank, 1, 1_000) ?? 1,
    f: f as FactorScores,
    reason: str(v.reason, SYNTH_LIMITS.reason),
    ...(conviction ? { conviction } : {}),
    ...(marketCap !== null ? { marketCap } : {}),
    ...(pe !== null ? { pe } : {}),
    ...(price !== null ? { price } : {}),
  };
}

function waveEvidence(v: unknown, budget: { left: number }): WaveEvidence | null {
  if (!isRecord(v)) return null;
  const waveIndex = int(v.waveIndex, 0, 100);
  if (waveIndex === null) return null;
  return {
    waveIndex,
    tickers: tickers(v.tickers, WAVE_SIZE),
    valuationTickers: tickers(v.valuationTickers, VALUATION_PER_WAVE),
    batch: outputs(v.batch, budget),
    valuation: valuationMap(v.valuation, budget),
  };
}

/** A usable synthesis request, clamped; null when there's nothing to rank. */
export function sanitizeSynthesizeRequest(raw: unknown): SynthesizeRequest | null {
  if (!isRecord(raw) || raw.synthesize !== true) return null;
  const query = str(raw.query, SYNTH_LIMITS.query).trim();
  const picks = (Array.isArray(raw.picks) ? raw.picks : [])
    .slice(0, SYNTH_LIMITS.picks)
    .map(pick)
    .filter((p): p is ScoutPick => p !== null);
  if (!query || picks.length === 0) return null;

  const budget = { left: SYNTH_LIMITS.evidenceTotal };
  const ev = isRecord(raw.evidence) ? raw.evidence : {};
  const evidence: DiscoverEvidence = {
    waves: (Array.isArray(ev.waves) ? ev.waves : [])
      .slice(0, SYNTH_LIMITS.waves)
      .map((w) => waveEvidence(w, budget))
      .filter((w): w is WaveEvidence => w !== null),
    valuation: valuationMap(ev.valuation, budget),
  };
  return { synthesize: true, query, picks, evidence };
}

/**
 * A usable crew-wave request; null when invalid. The crew is never taken from
 * the client (the default full crew runs), and a wave over WAVE_SIZE names is
 * rejected rather than truncated, matching runDiscoveryWave's fail-loud guard.
 */
export function sanitizeWaveRequest(raw: unknown): WaveRequest | null {
  if (!isRecord(raw) || raw.synthesize !== undefined) return null;
  if (!Array.isArray(raw.tickers) || raw.tickers.length > WAVE_SIZE) return null;
  const waveTickers = tickers(raw.tickers, WAVE_SIZE);
  const waveIndex = int(raw.waveIndex, 0, 100);
  const totalWaves = int(raw.totalWaves, 1, 100);
  if (waveTickers.length === 0 || waveIndex === null || totalWaves === null) return null;
  return {
    tickers: waveTickers,
    sectors: (Array.isArray(raw.sectors) ? raw.sectors : [])
      .map((s) => str(s, SYNTH_LIMITS.sector))
      .filter(Boolean)
      .slice(0, 12),
    waveIndex,
    totalWaves,
    valuationTickers: tickers(raw.valuationTickers, VALUATION_PER_WAVE),
  };
}
