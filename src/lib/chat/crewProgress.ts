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
