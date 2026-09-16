import type { AgentName } from "@/types/chat";

/**
 * Deterministic crew sizing.
 *
 * Before this module the CEO model chose its own crew, and on a full analysis it
 * routinely deployed 12–15 sub-agents. The Sep-2026 beta readout traced most of
 * the wait (crew median 4.2 min, p90 385 s against a 300 s function cap), most of
 * the cost and most of the failures back to that. `planCrew` replaces the model's
 * discretion with a rules table: a normal full analysis gets 3–5 agents chosen for
 * the question type, Deep Research gets 8–10 and says so. The model still fills in
 * each agent's arguments — it just no longer decides how many run.
 */

/** Every crew member. The skeptic is a review pass, not a crew agent. */
export type CrewAgent = Exclude<AgentName, "skeptic_review">;

export const FULL_CREW_MIN = 3;
export const FULL_CREW_MAX = 5;
export const DEEP_CREW_MIN = 8;
export const DEEP_CREW_MAX = 10;

/**
 * Seeded per-agent median wall-clock (ms), from the beta readout's run timings.
 * These are only the starting point — `recordAgentLatency` rolls real observations
 * over them as runs complete, so the quoted ETA tracks the live backend.
 */
export const SEED_AGENT_MEDIAN_MS: Record<CrewAgent, number> = {
  run_risk_agent: 22_000,
  run_news_agent: 14_000,
  run_macro_agent: 24_000,
  run_technical_agent: 9_000,
  run_dcf_agent: 31_000,
  run_earnings_agent: 26_000,
  run_insider_agent: 28_000,
  run_sentiment_agent: 12_000,
  run_competitor_agent: 30_000,
  run_options_agent: 13_000,
  run_comparables_agent: 21_000,
  run_graham_agent: 27_000,
  run_analyst_agent: 11_000,
  run_hype_agent: 34_000,
  run_fundamentals_agent: 29_000,
};

/** How many recent samples feed a rolling median. */
const ROLLING_WINDOW = 25;

/** Median of a sample list; the middle pair is averaged when the count is even. */
function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Draft turn + skeptic critique + streamed revision, on top of the crew.
 *
 * Measured, not assumed: on a healthy backend the sub-agents finish in ~15 s and
 * the CEO's own writing is what the user actually waits for (117 s and 216 s on
 * two live "full analysis of AMD" runs, each with ~13 s of crew). An ETA built on
 * the crew alone would quote 80 s for a three-minute wait — the exact complaint
 * this plan exists to fix — so this is seeded from those runs and then tracks the
 * live backend the same way the per-agent medians do.
 */
export const SEED_SYNTHESIS_MS = 150_000;

const synthesisSamples: number[] = [];

/** Record one run's synthesis wall-clock (total run time minus time in the crew). */
export function recordSynthesisLatency(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  synthesisSamples.push(ms);
  if (synthesisSamples.length > ROLLING_WINDOW) {
    synthesisSamples.splice(0, synthesisSamples.length - ROLLING_WINDOW);
  }
}

/** The rolling median synthesis time, or the seed when nothing is observed yet. */
export function synthesisMedianMs(): number {
  return synthesisSamples.length ? median(synthesisSamples) : SEED_SYNTHESIS_MS;
}

const observed = new Map<CrewAgent, number[]>();

/**
 * Record one agent's completed wall-clock. Called from the CEO loop; kept in
 * process memory only (a serverless instance warms up from the seeds again),
 * which is enough to keep the ETA honest within a session.
 */
export function recordAgentLatency(agent: CrewAgent, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const samples = observed.get(agent) ?? [];
  samples.push(ms);
  if (samples.length > ROLLING_WINDOW) samples.splice(0, samples.length - ROLLING_WINDOW);
  observed.set(agent, samples);
}

/** Drop every observation — test hook, and a way to fall back to the seeds. */
export function resetAgentLatencies(): void {
  observed.clear();
  synthesisSamples.length = 0;
}

/** The rolling median for an agent, or its seeded constant when unobserved. */
export function agentMedianMs(agent: CrewAgent): number {
  const samples = observed.get(agent);
  return samples?.length ? median(samples) : SEED_AGENT_MEDIAN_MS[agent];
}

export interface CrewPlanContext {
  /** Deep Research — a deliberately larger crew on a longer budget. */
  deepResearch?: boolean;
}

export interface CrewPlan {
  agents: CrewAgent[];
  /** Quoted wall-clock for the whole run, shown to the user as an ETA. */
  etaSeconds: number;
  /** Which rule matched — logged, and shown in the PR/acceptance evidence. */
  rule: string;
  deep: boolean;
}

interface CrewRule {
  id: string;
  match: RegExp;
  agents: CrewAgent[];
}

/**
 * First match wins, so the order here is the precedence order. Every crew is
 * 3–5 agents; widening one means dropping another, not appending.
 */
const RULES: CrewRule[] = [
  {
    id: "valuation",
    match: /\b(valuation|valued?|overvalued|undervalued|fair value|intrinsic|expensive|cheap|price target|worth|multiple|p\/?e\b|dcf)\b/i,
    agents: ["run_fundamentals_agent", "run_dcf_agent", "run_comparables_agent", "run_analyst_agent"],
  },
  {
    id: "risk",
    match: /\b(risk|risky|worry|worried|concerned?|safe|danger|downside|crash|blow ?up|exposure|hedge|drawdown|volatil\w*)\b/i,
    agents: ["run_risk_agent", "run_news_agent", "run_insider_agent", "run_macro_agent"],
  },
  {
    id: "earnings",
    match: /\b(earnings|eps|quarter\w*|guidance|beat|miss(?:ed)?|report(?:ed|ing)?|results)\b/i,
    agents: ["run_earnings_agent", "run_analyst_agent", "run_news_agent", "run_technical_agent"],
  },
  {
    id: "income",
    match: /\b(income|dividends?|yield|payout|distribution|coupon|reit)\b/i,
    agents: ["run_fundamentals_agent", "run_risk_agent", "run_macro_agent"],
  },
];

/** Used when nothing matches — a broad but still small read on the name. */
const DEFAULT_CREW: CrewAgent[] = [
  "run_fundamentals_agent",
  "run_news_agent",
  "run_technical_agent",
  "run_analyst_agent",
];

/**
 * Deep Research: breadth is the whole point, so this is the wide crew — but it is
 * still a fixed list, not "every agent the model fancies".
 */
const DEEP_CREW: CrewAgent[] = [
  "run_fundamentals_agent",
  "run_dcf_agent",
  "run_comparables_agent",
  "run_analyst_agent",
  "run_earnings_agent",
  "run_news_agent",
  "run_macro_agent",
  "run_technical_agent",
  "run_risk_agent",
  "run_hype_agent",
];

/**
 * ETA for a planned crew. Deliberately the SUM of the per-agent medians rather
 * than the max: the agents themselves run concurrently, but the CEO's tool rounds,
 * draft and revision are sequential around them, and an ETA that finishes early is
 * far better than one that runs out while the user is still waiting.
 */
function etaSecondsFor(agents: CrewAgent[]): number {
  const crewMs = agents.reduce((sum, a) => sum + agentMedianMs(a), 0);
  return Math.ceil((crewMs + synthesisMedianMs()) / 1000);
}

/**
 * Pick the crew for a question. Pure and deterministic apart from the rolling
 * latency medians, which only move the ETA — never the agent list.
 */
export function planCrew(question: string, context: CrewPlanContext = {}): CrewPlan {
  if (context.deepResearch) {
    return {
      agents: DEEP_CREW,
      etaSeconds: etaSecondsFor(DEEP_CREW),
      rule: "deep_research",
      deep: true,
    };
  }

  const rule = RULES.find((r) => r.match.test(question));
  const agents = rule?.agents ?? DEFAULT_CREW;
  return {
    agents,
    etaSeconds: etaSecondsFor(agents),
    rule: rule?.id ?? "default",
    deep: false,
  };
}
