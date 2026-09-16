/**
 * The second opinion's report, and how it reads on screen.
 *
 * Split out of `@/agents/skeptic` so the chat UI can import it: that module
 * reaches the Anthropic client and the usage meter (AsyncLocalStorage), which
 * must never land in the browser bundle. Everything here is pure.
 */

import type { SkepticIssue, SkepticProblem, SkepticReport } from "@/types/chat";

export const PROBLEM_LABELS: Record<SkepticProblem, string> = {
  unsourced: "Unsourced figure",
  contradicts_evidence: "Contradicts the analysts' evidence",
  stale: "May be out of date",
  overclaim: "Overstated",
  advice_line: "Reads as personal advice",
};

/** One unresolved issue, as the line the reader sees under Confidence & gaps. */
export function caveatLine(issue: SkepticIssue): string {
  const quote = issue.quote.trim().replace(/\s+/g, " ");
  const short = quote.length > 120 ? `${quote.slice(0, 117)}…` : quote;
  const why = issue.evidence?.trim();
  return `- ${PROBLEM_LABELS[issue.problem]}: "${short}"${why ? ` — ${why}` : ""}`;
}


/* ── What the Second Opinion box says ───────────────────────────────────── */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function summarizeSkeptic(report: SkepticReport): string {
  if (report.status !== "reviewed") {
    const base = "Second opinion didn't run for this answer";
    return report.reason ? `${base} — ${report.reason}` : base;
  }
  const parts = [`Reviewed against ${plural(report.agentsReviewed, "analyst's", "analysts'")} evidence`];
  if (report.revisionFailed) {
    parts.push("the rewrite didn't finish");
    if (report.caveats.length) parts.push(plural(report.caveats.length, "caveat", "caveats"));
  } else if (report.corrections.length === 0 && report.caveats.length === 0) {
    parts.push("no corrections needed");
  } else {
    if (report.corrections.length) parts.push(`${plural(report.corrections.length, "correction", "corrections")} applied`);
    if (report.caveats.length) parts.push(plural(report.caveats.length, "caveat", "caveats"));
  }
  return parts.join(" · ");
}

// The report travels to the UI inside the existing `critique` string field, the
// same way `agentTrace` and `attachment` travel as JSON — so it survives the
// store, the run-control snapshot and Firestore without a schema migration. The
// sentinel keeps a legacy markdown critique from ever being mistaken for one.
const REPORT_PREFIX = "finava-skeptic-v1:";

export function serializeSkepticReport(report: SkepticReport): string {
  return REPORT_PREFIX + JSON.stringify(report);
}

export function parseSkepticReport(raw: string | undefined | null): SkepticReport | null {
  if (!raw || !raw.startsWith(REPORT_PREFIX)) return null;
  try {
    const parsed = JSON.parse(raw.slice(REPORT_PREFIX.length)) as SkepticReport;
    if (!parsed || typeof parsed !== "object") return null;
    if (!["reviewed", "skipped", "failed"].includes(parsed.status)) return null;
    return {
      status: parsed.status,
      reason: parsed.reason,
      agentsReviewed: Number(parsed.agentsReviewed) || 0,
      corrections: Array.isArray(parsed.corrections) ? parsed.corrections : [],
      caveats: Array.isArray(parsed.caveats) ? parsed.caveats : [],
    };
  } catch {
    return null;
  }
}

/** The markdown fallback shown where structure isn't available (agent detail modal). */
export function critiqueMarkdown(report: SkepticReport): string {
  const head = `**Second Opinion:** ${summarizeSkeptic(report)}`;
  const all = [...report.corrections, ...report.caveats];
  if (all.length === 0) return head;
  return `${head}\n\n${all.map(caveatLine).join("\n")}`;
}
