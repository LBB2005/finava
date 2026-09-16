// src/lib/facts/signals.ts
// Pillar → FinavaSignal, shared by the finava-analysis stream and the Finava
// tab's facts read so both render the same bars. Client-safe.
import type { PillarScore, ScoreInputs } from "@/lib/finavaScore";
import { stanceFromScore, SIGNAL_ORDER, type FinavaSignal, type SignalKey } from "@/lib/finava";

function topFactorHeadline(p: PillarScore): string {
  const present = p.factors.filter((f) => f.score != null);
  if (present.length === 0) return "Limited data";
  const top = present.reduce((a, b) => (Math.abs(b.score! - 50) > Math.abs(a.score! - 50) ? b : a));
  const dir = top.score! >= 60 ? "Strong" : top.score! <= 40 ? "Weak" : "Mixed";
  return `${dir} ${top.label.toLowerCase()}`;
}

export function pillarToSignal(p: PillarScore): FinavaSignal {
  const score = p.score == null ? 50 : Math.round(p.score);
  const present = p.factors.filter((f) => f.score != null);
  return {
    key: p.key as SignalKey,
    label: p.label,
    score,
    isNoData: p.score == null,
    stance: stanceFromScore(score),
    headline: p.score == null ? "No data yet" : topFactorHeadline(p),
    detail: present.map((f) => f.detail).slice(0, 2).join(" · ") || "Insufficient data for a confident signal.",
    factors: p.factors.map((f) => ({ key: f.key, label: f.label, score: f.score, detail: f.detail })),
  };
}

export function pillarsToSignals(pillars: PillarScore[]): FinavaSignal[] {
  const byKey = new Map(pillars.map((p) => [p.key as string, p]));
  return SIGNAL_ORDER.flatMap((k) => {
    const p = byKey.get(k);
    return p ? [pillarToSignal(p)] : [];
  });
}

/** Average premium of P/E and P/S over the peer median, in percent. */
export function peerPremiumPct(i: Pick<ScoreInputs, "peTTM" | "peerPe" | "psTTM" | "peerPs">): number | null {
  const pe = i.peTTM != null && i.peTTM > 0 && i.peerPe != null && i.peerPe > 0 ? i.peTTM / i.peerPe - 1 : null;
  const ps = i.psTTM != null && i.psTTM > 0 && i.peerPs != null && i.peerPs > 0 ? i.psTTM / i.peerPs - 1 : null;
  const xs = [pe, ps].filter((x): x is number => x != null);
  return xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length) * 100 : null;
}
