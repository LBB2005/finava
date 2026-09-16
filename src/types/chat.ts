import type { ScoutPick, DiscoverTier, DiscoverLayout, WaveEvidence, DiscoverMessageContent } from "@/lib/scoutTypes";
import type { Brand } from "@/lib/models";
import type { ChatContext } from "@/lib/chatContext";

/**
 * Which lane produced a message. "fast" is W2-1's grounded default lane —
 * live data + one model call, seconds not minutes. "simple" is retained for
 * the manual Quick mode and for messages written before the fast lane existed.
 */
export type ChatMode = "auto" | "fast" | "simple" | "agent" | "deep_research" | "discover";

export { AGENT_COUNT } from "@/agents/tools/index";

/**
 * A user-authored response Template (stored as a Playbook doc). `instructions`
 * and `formats` shape how Finava responds and are injected into the agent prompt;
 * `steps` is a legacy/optional starter prompt kept for backward compatibility.
 */
export interface Template {
  id: string;
  title: string;
  instructions?: string;
  formats?: string[];
  steps?: string[];
}

export const PROMPT_TEMPLATES = [
  { label: "Full analysis", template: "Give me a full analysis of [TICKER] — valuation, technicals, insider activity, and whether I should add to my position." },
  { label: "Portfolio risk review", template: "Run a full risk analysis on my portfolio. How concentrated am I, what's my beta, and what should I trim or hedge?" },
  { label: "Earnings check", template: "What earnings are coming up this week that are relevant to my portfolio or the broader market?" },
  { label: "Sector macro view", template: "What's the current macro environment doing to [SECTOR] stocks? Any tailwinds or headwinds I should know about?" },
  { label: "Buy/sell decision", template: "Should I buy, hold, or sell [TICKER] right now? Give me a verdict with supporting data." },
  { label: "Hype vs fundamentals", template: "Is [TICKER] trading on hype or fundamentals? How does the narrative match the numbers?" },
];

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  mode: ChatMode;
  createdAt: string;
  agentTrace?: AgentStep[];
  critique?: string;
  followups?: string[];
  /** How long the response took to generate, in ms — shown as the "Analyzed in
   *  Ns" receipt. Only set on completed assistant messages. */
  durationMs?: number;
  /** Discovery: the scout's picks, kept so the "Go deeper" button can re-seed a deep run. */
  scoutPicks?: ScoutPick[];
  /** Discovery: which tier produced this message. */
  tier?: DiscoverTier;
  /** Which page this message was asked from (`stock:AAPL`, `portfolio`, …), or
   *  absent when typed in the main /chat area. Drives the citation pill. */
  context?: ChatContext;
  /** Discovery: the structured result the card renders. `content` holds the
   *  readable text version the model sees in history. */
  attachment?: DiscoverMessageContent;
  /** The user pressed Stop; `content` is the partial answer. Not an error. */
  stopped?: boolean;
}

/* ── Skeptic review (W3-2) ──────────────────────────────────────────────── */

/** Why the reviewer flagged a line of the draft. */
export type SkepticProblem =
  | "unsourced"
  | "contradicts_evidence"
  | "stale"
  | "overclaim"
  | "advice_line";

/**
 * One reviewer finding. `quote` must appear verbatim in the draft — a finding
 * whose quote doesn't is dropped before the user ever sees it, which is what
 * stops the reviewer critiquing a report that isn't on screen.
 */
export interface SkepticIssue {
  quote: string;
  problem: SkepticProblem;
  /** The evidence that contradicts the quote, when the reviewer named it. */
  evidence?: string;
  fix: string;
}

/**
 * What the second opinion actually did. `status` is never "reviewed" unless the
 * review ran and was read — a skipped or failed review says so.
 */
export interface SkepticReport {
  status: "reviewed" | "skipped" | "failed";
  /** Why it didn't run. Only set for "skipped"/"failed". */
  reason?: string;
  /** How many analysts' outputs the reviewer was given. */
  agentsReviewed: number;
  /** The rewrite was cut off, so nothing can be claimed as corrected. */
  revisionFailed?: boolean;
  /** Issues the revision pass rewrote away. */
  corrections: SkepticIssue[];
  /** Issues the revision did not resolve — folded into "Confidence & gaps". */
  caveats: SkepticIssue[];
}

export type AgentName =
  | "run_risk_agent"
  | "run_news_agent"
  | "run_macro_agent"
  | "run_technical_agent"
  | "run_dcf_agent"
  | "run_earnings_agent"
  | "run_insider_agent"
  | "run_sentiment_agent"
  | "run_competitor_agent"
  | "run_options_agent"
  | "run_comparables_agent"
  | "run_graham_agent"
  | "run_analyst_agent"
  | "run_hype_agent"
  | "run_fundamentals_agent"
  | "skeptic_review";

export const AGENT_LABELS: Record<AgentName, string> = {
  run_risk_agent: "Risk Analysis",
  run_news_agent: "News Research",
  run_macro_agent: "Macro & Market",
  run_technical_agent: "Technical Analysis",
  run_dcf_agent: "DCF Valuation",
  run_earnings_agent: "Earnings & Catalysts",
  run_insider_agent: "Insider & Institutional",
  run_sentiment_agent: "Social Sentiment",
  run_competitor_agent: "Competitor Analysis",
  run_options_agent: "Options Flow",
  run_comparables_agent: "Comparables",
  run_graham_agent: "Graham Screen",
  run_analyst_agent: "Analyst Consensus",
  run_hype_agent: "Hype Score",
  run_fundamentals_agent: "Multi-Year Fundamentals",
  skeptic_review: "Skeptic Review",
};

export type AgentStatus = "pending" | "running" | "complete" | "error" | "skipped";

export interface AgentStep {
  agent: AgentName;
  status: AgentStatus;
  result?: string;
  error?: string;
  /** Display brands for this agent's model(s) — single, or a pipeline like Perplexity → Gemini. */
  models?: Brand[];
}

export type AgentEvent =
  // Emitted once, right after the CEO decides the crew — lets the UI pop the
  // panel up pre-sized with every agent shown as "queued" before any runs.
  | { type: "crew_planned"; agents: AgentName[] }
  // The deterministic crew plan (W2-2), emitted before any agent runs so the UI
  // can show who is on the job and how long it should take. `crew_planned` above
  // is the older model-chosen announcement and still fires alongside it.
  | { type: "crew_plan"; agents: string[]; etaSeconds: number; deep?: boolean }
  // Per-agent lifecycle for the progress row. Carries the elapsed ms on a
  // terminal status so the ETA countdown can re-base itself.
  | { type: "agent_progress"; agent: string; status: "running" | "done" | "failed" | "skipped"; ms?: number }
  // The run is close enough to its wall-clock budget that it will synthesize from
  // whatever has finished. `remainingSeconds` is what's left of the budget.
  | { type: "budget_warning"; remainingSeconds: number }
  | { type: "agent_start"; agent: AgentName; models?: Brand[] }
  | { type: "agent_complete"; agent: AgentName; result: string; models?: Brand[] }
  | { type: "agent_error"; agent: AgentName; error: string }
  | { type: "ceo_thinking"; content: string }
  | { type: "ceo_compiling" }
  // Streamed as deltas: the client appends each one. `replace: true` marks an
  // emit that carries the whole report, which resets the text so far.
  | { type: "final_response"; content: string; replace?: boolean }
  | { type: "skeptic_start" }
  // The review ran. `critique` is the human-readable fallback (agent-detail
  // modal, older clients); `report` is what the Second Opinion box renders.
  | { type: "skeptic_complete"; critique: string; report?: SkepticReport }
  // The review did NOT run. Emitted instead of `skeptic_complete` so the step is
  // never left showing "complete" for work that never happened.
  | { type: "skeptic_status"; status: "skipped" | "failed"; reason: string }
  | { type: "followups"; questions: string[] }
  | { type: "text_delta"; content: string }
  // ── Discovery funnel ──
  | { type: "discover_clarify"; question: string; chips: string[] }
  | { type: "scout_complete"; tier: DiscoverTier; query: string; interpretation: string; picks: ScoutPick[]; layout?: DiscoverLayout }
  | { type: "deep_shortlist"; query: string; interpretation: string; picks: ScoutPick[]; layout?: DiscoverLayout }
  | { type: "wave_start"; waveIndex: number; totalWaves: number; tickers: string[] }
  | { type: "wave_result"; wave: WaveEvidence; totalWaves: number }
  | { type: "discover_done" }
  | { type: "done" }
  | { type: "error"; message: string };
