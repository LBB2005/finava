/**
 * The readout: panel + live results compared with the Sep-14 baseline, and the
 * launch gate scored. Pure (no I/O), so every figure in the published readout
 * comes from a tested function.
 */
import type { Rating, Shown } from "../panel/persona";
import type { Persona } from "../panel/persona";
import type { TurnMetrics } from "../lib/measure";
import { mean, median, nps, percentile } from "../lib/metrics";
import type { LiveSummary } from "./live";
import type { PanelAnalysis } from "./analyze";

/** What the report needs from a persona run; browser results use the same shape. */
export interface PanelRow {
  persona: Pick<Persona, "id" | "ai" | "stock" | "channel" | "mobile">;
  shown: Pick<Shown, "lane" | "waitSec" | "stopped">[];
  metrics: Pick<TurnMetrics, "lane" | "totalMs" | "collapse">[];
  rating: Pick<Rating, "scores" | "nps" | "pay" | "price" | "quit"> | null;
  quitMidSession: boolean;
  error: string | null;
}

export interface Baseline {
  label: string;
  date: string;
  personas: number;
  nps: number;
  npsRatingMean: number;
  wouldPay: { yes: number; maybe: number; no: number };
  medianMaxPriceUsd: number;
  wouldReturnMean: number;
  scoreMeans: Record<string, number>;
  quit: number;
  lostAnswerToCollapse: number;
  turns: number;
  collapsedTurns: number;
  lanes: { lane: string; turns: number; collapsed: number; medianSec: number; p90Sec: number | null }[];
  switchTests: { total: number; passed: number };
  factCheck: Record<string, number>;
}

export interface PanelSummary {
  personas: number;
  rated: number;
  failed: number;
  nps: number | null;
  npsRatingMean: number | null;
  wouldPay: { yes: number; maybe: number; no: number };
  medianMaxPriceUsd: number | null;
  wouldReturnMean: number | null;
  scoreMeans: Record<string, number | null>;
  quit: number;
  lostAnswerToCollapse: number;
  turns: number;
  collapsedTurns: number;
  stoppedTurns: number;
  lanes: { lane: string; turns: number; collapsed: number; medianSec: number | null; p90Sec: number | null }[];
}

const round = (v: number | null, dp = 2) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);

export function summarizePanel(rows: PanelRow[]): PanelSummary {
  const rated = rows.filter((r) => r.rating);
  const ratings = rated.map((r) => r.rating!);
  const turns = rows.flatMap((r) => r.metrics);
  const keys = ratings.length ? Object.keys(ratings[0].scores) : [];
  const lanes = [...new Set(turns.map((t) => t.lane).filter((l): l is NonNullable<typeof l> => l != null))];
  return {
    personas: rows.length,
    rated: rated.length,
    failed: rows.length - rated.length,
    nps: nps(ratings.map((r) => r.nps)),
    npsRatingMean: round(mean(ratings.map((r) => r.nps))),
    wouldPay: {
      yes: ratings.filter((r) => r.pay === "yes").length,
      maybe: ratings.filter((r) => r.pay === "maybe").length,
      no: ratings.filter((r) => r.pay === "no").length,
    },
    medianMaxPriceUsd: median(ratings.map((r) => r.price)),
    wouldReturnMean: round(mean(ratings.map((r) => r.scores.wouldReturn))),
    scoreMeans: Object.fromEntries(keys.map((k) => [k, round(mean(ratings.map((r) => (r.scores as Record<string, number>)[k])))])),
    quit: rated.filter((r) => r.quitMidSession || r.rating!.quit).length,
    lostAnswerToCollapse: rows.filter((r) => r.metrics.some((m) => m.collapse?.collapsed)).length,
    turns: turns.length,
    collapsedTurns: turns.filter((t) => t.collapse?.collapsed).length,
    stoppedTurns: rows.flatMap((r) => r.shown).filter((s) => s.stopped).length,
    lanes: lanes.map((lane) => {
      const xs = turns.filter((t) => t.lane === lane);
      return {
        lane,
        turns: xs.length,
        collapsed: xs.filter((t) => t.collapse?.collapsed).length,
        medianSec: round(median(xs.map((t) => t.totalMs / 1000)), 1),
        p90Sec: round(percentile(xs.map((t) => t.totalMs / 1000), 90), 1),
      };
    }),
  };
}

// ── comparison ───────────────────────────────────────────────────────────────

export interface ComparisonRow {
  metric: string;
  baseline: number | string | null;
  now: number | string | null;
  /** Did it move the right way? null when either side is unavailable. */
  better: boolean | null;
}

function row(metric: string, baseline: number | null, now: number | null, higherIsBetter: boolean): ComparisonRow {
  return {
    metric,
    baseline,
    now,
    better: baseline == null || now == null ? null : now === baseline ? false : higherIsBetter ? now > baseline : now < baseline,
  };
}

/** Old lane keys → new: the "simple" lane is the fast lane, "agent" is a full analysis, "deep" is deep research. */
const LANE_ALIAS: Record<string, string> = { simple: "fast", agent: "full_analysis", deep: "deep_research" };

export function compare(base: Baseline, now: PanelSummary): ComparisonRow[] {
  const per = (n: number, of: number) => (of ? n / of : null);
  const rows = [
    row("NPS", base.nps, now.nps, true),
    row("Mean recommend rating (0–10)", base.npsRatingMean, now.npsRatingMean, true),
    row("Would pay: yes (share)", per(base.wouldPay.yes, base.personas), per(now.wouldPay.yes, now.rated), true),
    row("Would pay: maybe (share)", per(base.wouldPay.maybe, base.personas), per(now.wouldPay.maybe, now.rated), true),
    row("Median max price ($/mo)", base.medianMaxPriceUsd, now.medianMaxPriceUsd, true),
    row("Would return (mean, 1–10)", base.wouldReturnMean, now.wouldReturnMean, true),
    row("Quit early (share)", per(base.quit, base.personas), per(now.quit, now.rated), false),
    row("Lost a finished answer to collapse (share)", per(base.lostAnswerToCollapse, base.personas), per(now.lostAnswerToCollapse, now.personas), false),
    row("Collapsed turns", base.collapsedTurns, now.collapsedTurns, false),
    ...Object.keys(base.scoreMeans).map((k) => row(`Score: ${k}`, base.scoreMeans[k], now.scoreMeans[k] ?? null, true)),
  ];
  for (const b of base.lanes) {
    const key = LANE_ALIAS[b.lane] ?? b.lane;
    const n = now.lanes.find((l) => l.lane === key);
    rows.push(row(`Wait p50 (s): ${key}`, b.medianSec, n?.medianSec ?? null, false));
  }
  return rows;
}

// ── launch gate ──────────────────────────────────────────────────────────────

export type GateStatus = "pass" | "fail" | "unavailable" | "manual";

export interface GateResult {
  criterion: string;
  status: GateStatus;
  evidence: string;
}

export interface GateInputs {
  smoke: { collapsePassed: boolean; switchesPassed: number; switchesTotal: number } | null;
  live: LiveSummary | null;
  panel: PanelSummary | null;
  /** From docs/launch/launch-gate.md checkboxes Liam ticks by hand. */
  manual: { lawyerReviewed: boolean; capsMeasured: boolean; privacyTodosClosed: boolean };
}

const secOf = (ms: number | null) => (ms == null ? null : ms / 1000);

export function launchGate(g: GateInputs): GateResult[] {
  const fast = g.live?.lanes.find((l) => l.lane === "fast");
  const full = g.live?.lanes.find((l) => l.lane === "full_analysis");
  const out: GateResult[] = [];

  const collapseEvidence = [
    g.smoke ? `smoke ${g.smoke.collapsePassed ? "clean" : "FAILED"}` : "smoke not run",
    g.live ? `live ${g.live.collapsed} of ${g.live.turns} turns` : "live not run",
  ].join(" · ");
  out.push({
    criterion: "Zero collapse in smoke and live",
    status: !g.smoke || !g.live ? "unavailable" : g.smoke.collapsePassed && g.live.collapsed === 0 ? "pass" : "fail",
    evidence: collapseEvidence,
  });

  const fastP50 = secOf(fast?.totalP50Ms ?? null);
  out.push({
    criterion: "Fast-lane p50 < 10 s",
    status: fastP50 == null ? "unavailable" : fastP50 < 10 ? "pass" : "fail",
    evidence: fastP50 == null ? "no live fast-lane turns" : `p50 ${fastP50.toFixed(1)} s over ${fast!.turns} turns`,
  });

  const fullP90 = secOf(full?.totalP90Ms ?? null);
  out.push({
    criterion: "Full-analysis p90 < 180 s",
    status: fullP90 == null ? "unavailable" : fullP90 < 180 ? "pass" : "fail",
    evidence: fullP90 == null ? "no live full-analysis turns" : `p90 ${fullP90.toFixed(0)} s over ${full!.turns} turns (a small sample)`,
  });

  out.push({
    criterion: "13/13 switch tests pass",
    status: !g.smoke ? "unavailable" : g.smoke.switchesPassed === g.smoke.switchesTotal && g.smoke.switchesTotal === 13 ? "pass" : "fail",
    evidence: g.smoke ? `${g.smoke.switchesPassed}/${g.smoke.switchesTotal}` : "smoke not run",
  });

  const rate = g.live?.numberMismatchRate ?? null;
  out.push({
    criterion: "Number-check mismatch rate < 2% of cited numbers",
    status: rate == null ? "unavailable" : rate < 0.02 ? "pass" : "fail",
    evidence: rate == null ? "no number_check events (W4-1 not emitting)" : `${(rate * 100).toFixed(1)}%`,
  });

  out.push({ criterion: "Legal packet reviewed by a lawyer", status: g.manual.lawyerReviewed ? "pass" : "manual", evidence: "ticked by hand in docs/launch/launch-gate.md" });
  out.push({ criterion: "Per-lane caps measured (W3-4)", status: g.manual.capsMeasured ? "pass" : "manual", evidence: "docs/pricing/run-cost-2026-09.md" });

  const ret = g.panel?.wouldReturnMean ?? null;
  const payYes = g.panel?.wouldPay.yes ?? 0;
  out.push({
    criterion: "Panel would-return ≥ 6 and at least some \"would pay\"",
    status: !g.panel || ret == null ? "unavailable" : ret >= 6 && payYes > 0 ? "pass" : "fail",
    evidence: g.panel ? `would-return ${ret ?? "—"} · would pay yes ${payYes}/${g.panel.rated}` : "panel not run",
  });

  out.push({ criterion: "/privacy entity and postal address TODOs closed", status: g.manual.privacyTodosClosed ? "pass" : "manual", evidence: "src/app/privacy" });
  return out;
}

export interface Readout {
  generatedAt: string;
  baseline: Baseline;
  panel: PanelSummary | null;
  comparison: ComparisonRow[];
  live: LiveSummary | null;
  analysis: Pick<PanelAnalysis, "factChecks" | "themes"> | null;
  factCheckCounts: Record<string, number> | null;
  gate: GateResult[];
  caveats: string[];
}

export function factCheckCounts(a: Pick<PanelAnalysis, "factChecks"> | null): Record<string, number> | null {
  if (!a) return null;
  const c: Record<string, number> = { correct: 0, minor: 0, stale: 0, wrong: 0, fabricated: 0, unverifiable: 0 };
  for (const f of a.factChecks) c[f.verdict] = (c[f.verdict] ?? 0) + 1;
  return c;
}

/** Always shipped with the readout. Edit the wording only to make it more honest. */
export const CAVEATS = [
  "These are simulated personas: model-written reactions to real Finava output, not real users. Scores, quit decisions and quotes are model-authored.",
  "Same 50 identities, grid cells and opening questions as Sep-14, but a different persona model may rate differently. Compare direction and size of change, not decimals.",
  "API personas ran through the eval harness, which uses the real client request builders and stream readers. Browser personas used the real UI and are fewer, so their numbers are noisy.",
  "Waits include contention from personas running concurrently against one dev server; a production deployment has different latency.",
  "Two personas per cell and ten per segment: segment differences under about one point are noise.",
  "The fact-check sample is a deterministic spread of claims, not the problem-seeking sample used on Sep-14, so accuracy rates are not directly comparable.",
  "Sessions are 2–4 turns, so this says nothing about retention or habitual use.",
];
