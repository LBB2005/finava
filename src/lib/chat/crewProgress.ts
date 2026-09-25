import type { AgentName, AgentStep } from "@/types/chat";

/**
 * Crew progress maths for the answer UI. Testers waited a median 4.2 minutes
 * behind "Assembling your research crew" with no idea how long was left, so the
 * estimate here has to keep moving as agents actually finish.
 *
 * The shapes below mirror the events W2-2 emits (`crew_plan`, `agent_progress`,
 * `budget_warning`). Until that lands, the UI renders behind a null check.
 */

/** W2-2 `crew_plan`: the crew the CEO sized, before any of it runs. */
export interface CrewPlan {
  agents: AgentName[];
  /** The server's own estimate for the whole run, when it has one. */
  etaSeconds?: number;
}

/** W2-2 `budget_warning`: the run is approaching its cost or time cap. */
export interface BudgetWarning {
  message: string;
  /** "cost" | "time" — what is running out. */
  kind?: "cost" | "time";
}

export interface CrewSummary {
  total: number;
  complete: number;
  running: number;
  errored: number;
  pending: number;
  /** Every agent has either reported or failed. */
  done: boolean;
}

export function crewSummary(steps: AgentStep[]): CrewSummary {
  const count = (s: AgentStep["status"]) => steps.filter((x) => x.status === s).length;
  const complete = count("complete");
  const errored = count("error");
  return {
    total: steps.length,
    complete,
    running: count("running"),
    errored,
    pending: count("pending"),
    done: steps.length > 0 && complete + errored === steps.length,
  };
}

/** Never show a countdown that has hit zero while agents are still working. */
const FLOOR_SECONDS = 5;

/**
 * Seconds still to go: the observed pace once agents start finishing, the
 * server's planned estimate before that, and null when there is nothing to say.
 */
export function crewEtaSeconds(a: {
  steps: AgentStep[];
  elapsedMs: number;
  plannedSeconds?: number;
}): number | null {
  const { total, complete, errored, done } = crewSummary(a.steps);
  if (!total || done) return null;

  const finished = complete + errored;
  const remaining = total - finished;

  let estimate: number;
  if (finished > 0) {
    const perAgentMs = a.elapsedMs / finished;
    estimate = Math.round((perAgentMs * remaining) / 1000);
  } else if (a.plannedSeconds) {
    estimate = Math.round(a.plannedSeconds - a.elapsedMs / 1000);
  } else {
    return null;
  }

  return Math.max(FLOOR_SECONDS, estimate);
}

export function formatEta(seconds: number | null): string | null {
  if (seconds == null) return null;
  if (seconds < 60) return `~${seconds}s left`;
  return `~${Math.round(seconds / 60)} min left`;
}

/** "~2 min · 4 analysts" — what a full run will cost the reader in time. */
export function plannedDepthLabel(plan: { agents?: number; seconds?: number } | undefined): string | null {
  const agents = plan?.agents;
  if (!agents) return null;
  const people = `${agents} analyst${agents === 1 ? "" : "s"}`;
  const seconds = plan?.seconds;
  if (!seconds) return people;
  const time = seconds < 60 ? `~${seconds}s` : `~${Math.round(seconds / 60)} min`;
  return `${time} · ${people}`;
}

/** What the panel says once every analyst has reported and the CEO is writing. */
export const WRITING_REPORT = "Writing the report…";
/** Longer than this, or more than one line, is not a status: it's a draft. */
const STATUS_MAX_CHARS = 90;

/**
 * The one line the progress panel shows for the CEO's `ceo_thinking` text.
 *
 * The same event carries short statuses ("Compiling all reports…") and the
 * CEO's whole 7,000-character draft report, which used to render in the panel's
 * header and swell it by up to 640 px for six seconds (crew CLS 0.18 on a
 * phone). A status passes through; anything longer becomes "Writing the
 * report…" once the analysts are done, or nothing (the caller's default) while
 * they are still working.
 */
export function crewStatusNote(text: string | undefined, a: { done: boolean }): string | undefined {
  const t = text?.trim();
  if (!t) return undefined;
  if (t.length <= STATUS_MAX_CHARS && !t.includes("\n")) return t;
  return a.done ? WRITING_REPORT : undefined;
}
